import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { parseSubscription, publicProfile, shareLink } from './profiles.mjs';
import { XrayEngine, testProfile } from './engine.mjs';
import { environment, fetchSubscription } from './network.mjs';
import { settingsPatch, networkKeys, normalizeSettings } from './settings.mjs';
import { version as appVersion } from './version.mjs';

const rank = (p) => p.transport === 'xhttp' ? 0 : p.transport === 'raw' && p.fragment ? 1 : p.transport === 'raw' ? 2 : 3;
export function redact(text) {
  return String(text).replace(/\b[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\b/gi, '[uuid]')
    .replace(/\b[A-Za-z\d_-]{43}\b/g, '[key]').replace(/\b[a-f\d]{32}\b/gi, '[token]')
    .replace(/(?:vless|json):\/\/\S+/gi, '[profile]').replace(/https?:\/\/[^\s"']+/gi, '[url]');
}

export class Controller extends EventEmitter {
  constructor({ store, binaryDir, runtimeDir, proxy, tunGuard = null, killSwitch = null, leakGuard = null, updater = null, engineFactory, environmentReader, subscriptionFetcher = fetchSubscription, hostResolver = (host) => lookup(host, { family: 4 }).then((r) => r.address), version = appVersion }) {
    super(); this.store = store; this.binaryDir = binaryDir; this.binary = path.join(binaryDir, 'xray.exe'); this.runtimeDir = runtimeDir; this.proxy = proxy;
    this.connection = { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false };
    this.stats = { down: 0, up: 0, downRate: 0, upRate: 0, history: [] };
    this.logs = []; this.env = { interface: '', interfaces: [], tunActive: false, windows: process.platform === 'win32' };
    this.core = { ready: false, version: '', error: null };
    this.checking = false; this.busy = false; this.lastSample = null; this.healthFails = 0; this.healthBusy = false; this.metricsBusy = false; this.closed = false;
    this.tunGuard = tunGuard; this.killSwitch = killSwitch; this.hostResolver = hostResolver; this.resolvedHosts = new Map(); this.recovering = false;
    killSwitch?.on('failed', (e) => this.log('error', e.message));
    killSwitch?.on('warning', (message) => this.log('warning', `Kill switch: ${message}`));
    // The leak protection: the same guard, blocking only DNS (the DNS protection) and, for a TUN without IPv6, IPv6
    // outside the TUN. The kill switch already blocks all of that, so only one of them runs at a time.
    this.leakGuard = leakGuard;
    this.updater = updater; updater?.on('change', () => this.publish());
    leakGuard?.on('failed', (e) => this.log('error', e.message));
    leakGuard?.on('warning', (message) => this.log('warning', `Защита от утечек: ${message}`));
    this.engineFactory = engineFactory || (() => new XrayEngine(this.binary, this.runtimeDir, this.tunGuard));
    this.environmentReader = environmentReader || environment;
    this.subscriptionFetcher = subscriptionFetcher;
    this.testsDone = Promise.resolve(); this.operationDone = Promise.resolve(); this.refreshDone = Promise.resolve(); this.refreshing = false; this.version = version;
  }
  async initialize() {
    await this.removeStaleConfigs();
    if (this.tidySources()) await this.store.save();
    await this.readEnvironment();
    try {
      const m = JSON.parse(await readFile(path.join(this.binaryDir, 'manifest.json'), 'utf8'));
      const sha = createHash('sha256').update(await readFile(this.binary)).digest('hex');
      if (sha !== m.binarySha256) throw new Error('Контрольная сумма Xray не совпадает. Переустановите приложение из проверенной сборки.');
      this.core = { ready: true, version: m.version, error: null };
      try {
        const dllHash = createHash('sha256').update(await readFile(path.join(this.binaryDir, 'wintun.dll'))).digest('hex');
        if (!m.wintunSha256 || dllHash !== m.wintunSha256) throw new Error('Контрольная сумма Wintun не совпадает.');
        this.core.tunReady = true;
      } catch { this.core.tunReady = false; this.core.tunError = 'Wintun отсутствует или не прошёл проверку. Переустановите JOXY из полной сборки.'; }
    } catch (e) { this.core.error = e.code === 'ENOENT' ? 'Ядро Xray отсутствует. Для сборки выполните npm run fetch:core.' : e.message; }
    const recovered = await this.proxy.recover();
    if (recovered?.restored) this.log('info', 'Восстановлены настройки Windows после незавершённой сессии.');
    const tunRecovered = await this.tunGuard?.recover();
    if (tunRecovered?.requiresElevation) this.env.recoveryRequired = true;
    if (tunRecovered?.restored) this.log('info', 'Восстановлены маршруты и DNS после незавершённой TUN-сессии.');
    this.log('info', this.core.ready ? `Xray ${this.core.version} проверен по SHA256. Приложение готово.` : this.core.error);
    this.sampleTimer = setInterval(() => this.sample(), 2000);
    this.healthTimer = setInterval(() => this.health().catch((e) => this.log('error', e.message)), 20000);
    return this.snapshot();
  }
  // Session configs hold profile secrets in plain text; a crash or kill leaves them behind.
  async removeStaleConfigs() {
    const names = await readdir(this.runtimeDir).catch(() => []);
    await Promise.all(names.filter((n) => /^session-[\w-]+\.json$/.test(n)).map((n) => rm(path.join(this.runtimeDir, n), { force: true }).catch(() => {})));
  }
  afterResume() {
    if (this.connection.phase !== 'connected') return;
    this.healthFails = 0;
    this.health({ urgent: true }).catch((e) => this.log('error', e.message));
  }
  log(level, message) {
    this.logs.push({ id: randomUUID(), level, message: redact(message).slice(0, 700), time: new Date().toISOString() });
    if (this.logs.length > 150) this.logs.shift();
    this.publish();
  }
  publish() { if (!this.closed) this.emit('state', this.snapshot()); }
  snapshot() {
    const d = this.store.data;
    return { version: this.version, profiles: d.profiles.map(publicProfile), sources: d.sources.map(({ url, removed, ...safe }) => ({ ...safe, remote: !!url, count: d.profiles.filter((p) => p.sourceId === safe.id).length })), selectedId: d.selectedId, settings: d.settings, connection: this.connection, stats: this.stats, logs: this.logs, environment: this.env, core: this.core, checking: this.checking, killSwitch: { available: !!this.killSwitch, armed: !!this.killSwitch?.armed }, update: this.updater?.state || null };
  }
  networkInterface() { return this.store.data.settings.interface === 'auto' ? this.env.interface || '' : this.store.data.settings.interface; }
  // Pinned only when the user picked an interface: with none, Xray follows the default route itself (TUN) or needs no binding (proxy).
  outboundInterface() { return this.store.data.settings.interface === 'auto' ? '' : this.store.data.settings.interface; }
  // Checks running beside our own TUN must leave through the physical interface, not into the tunnel.
  testInterface() { return this.connection.phase === 'connected' && this.connection.mode === 'tun' ? this.networkInterface() : this.outboundInterface(); }
  async importValue(value, refreshId = null) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Вставьте ссылку подписки, VLESS или JSON.');
    let body = value.trim(), host = '', url = null, metadata = {};
    if (/^https?:\/\//i.test(body)) { url = body; const fetched = await this.subscriptionFetcher(url); body = fetched.body; host = fetched.host; metadata = fetched.metadata || {}; }
    if (this.closed) throw new Error('Приложение закрывается.');
    const { profiles, rejected } = parseSubscription(body);
    const d = this.store.data;
    // Servers pasted by hand all go to the one local list, added to it; a subscription replaces its own servers.
    const old = refreshId ? d.sources.find((s) => s.id === refreshId) : url ? d.sources.find((s) => s.url === url) : d.sources.find((s) => !s.url);
    const replacing = !!url;
    const id = old?.id || randomUUID();
    const previous = new Map(d.profiles.map((p) => [p.id, p]));
    // Servers the user deleted from a subscription stay deleted when it refreshes, as long as the provider still lists them.
    const removed = profiles.filter((p) => old?.removed?.includes(p.id)).map((p) => p.id);
    const kept = profiles.filter((p) => !removed.includes(p.id));
    const source = { id, label: metadata.title || old?.label || (host || 'Мои серверы'), host: host || 'Из буфера обмена', url, updatedAt: new Date().toISOString(), count: kept.length, usage: metadata.usage || null, announcement: metadata.announcement || null, supportUrl: metadata.supportUrl || null, websiteUrl: metadata.websiteUrl || null, ...(url && removed.length ? { removed } : {}) };
    const incoming = kept.map((p) => ({ ...p, countryCode: p.countryCode || metadata.countryCode || null, sourceId: id, lastTest: previous.get(p.id)?.lastTest || null }));
    // A profile may be shared by two subscriptions: do not create duplicate identities.
    const incomingIds = new Set(incoming.map((p) => p.id));
    const next = [...d.profiles.filter((p) => (!replacing || p.sourceId !== id) && !incomingIds.has(p.id)), ...incoming];
    if (next.length > 1000) throw new Error('Достигнут лимит в 1000 профилей.');
    if (replacing && this.connection.phase === 'connected' && d.profiles.some((p) => p.sourceId === id && p.id === this.connection.profileId) && !incomingIds.has(this.connection.profileId)) await this.disconnect();
    d.profiles = next; d.sources = [...d.sources.filter((s) => s.id !== id), source];
    this.tidySources();
    if (d.selectedId !== 'auto' && !next.some((p) => p.id === d.selectedId)) d.selectedId = 'auto';
    await this.store.save();
    this.log('info', `Импортировано ${profiles.length} профиля. Все подключения используют Xray.`);
    if (rejected.length) this.log('warning', `Пропущено ${rejected.length}: ${rejected[0]}`);
    return { count: profiles.length, rejected };
  }
  async refreshSources(id = null) {
    if (this.refreshing) return this.refreshDone;
    if (id !== null && (typeof id !== 'string' || !this.store.data.sources.some((s) => s.id === id && s.url))) throw new Error('Подписка с адресом обновления не найдена.');
    const sources = this.store.data.sources.filter((s) => s.url && (id === null || s.id === id));
    if (!sources.length) throw new Error('Нет подписок с адресом обновления.');
    this.refreshing = true;
    this.refreshDone = (async () => {
      const errors = [];
      for (const source of sources) {
        if (this.closed) break;
        try { await this.importValue(source.url, source.id); } catch (e) { errors.push(`${source.label}: ${e.message}`); }
      }
      if (errors.length) throw new Error(errors.join('\n'));
    })();
    try { await this.refreshDone; } finally { this.refreshing = false; }
  }
  // One list for hand-added servers, and none left empty: earlier versions made a list per paste, and a server pasted
  // again into another list left the first one empty.
  tidySources() {
    const d = this.store.data, local = d.sources.filter((s) => !s.url), before = d.sources.length;
    if (local.length > 1) {
      const [keep, ...rest] = local, merged = new Set(rest.map((s) => s.id));
      for (const p of d.profiles) if (merged.has(p.sourceId)) p.sourceId = keep.id;
    }
    d.sources = d.sources.filter((s) => s.url || d.profiles.some((p) => p.sourceId === s.id));
    return d.sources.length !== before || local.length > 1;
  }
  // Deleting is refused for the server in use, and while a connection or check runs.
  assertIdle(ids) {
    if (this.busy || this.checking) throw new Error('Дождитесь завершения подключения или проверки.');
    if (this.connection.phase !== 'idle' && this.connection.phase !== 'error' && ids.includes(this.connection.profileId)) throw new Error('Сначала отключитесь от этого сервера.');
  }
  async removeProfile(id) {
    const d = this.store.data;
    const profile = typeof id === 'string' && d.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Сервер не найден.');
    this.assertIdle([id]);
    d.profiles = d.profiles.filter((p) => p.id !== id);
    const source = d.sources.find((s) => s.id === profile.sourceId);
    const left = d.profiles.filter((p) => p.sourceId === profile.sourceId).length;
    if (source?.url) Object.assign(source, { removed: [...new Set([...(source.removed || []), id])], count: left });
    else if (source && !left) d.sources = d.sources.filter((s) => s !== source);
    else if (source) source.count = left;
    if (d.selectedId === id) d.selectedId = 'auto';
    await this.store.save(); this.log('info', `Сервер удалён: ${profile.name}.`); this.publish();
  }
  async removeSource(id) {
    const d = this.store.data;
    const source = typeof id === 'string' && d.sources.find((s) => s.id === id);
    if (!source) throw new Error('Подписка не найдена.');
    const ids = d.profiles.filter((p) => p.sourceId === id).map((p) => p.id);
    this.assertIdle(ids);
    d.profiles = d.profiles.filter((p) => p.sourceId !== id); d.sources = d.sources.filter((s) => s.id !== id);
    if (ids.includes(d.selectedId)) d.selectedId = 'auto';
    await this.store.save(); this.log('info', `Подписка удалена: ${source.label}.`); this.publish();
  }
  async select(id) {
    if (id !== 'auto' && !this.store.data.profiles.some((p) => p.id === id)) throw new Error('Профиль не найден.');
    this.store.data.selectedId = id; await this.store.save(); this.publish();
  }
  async updateSettings(patch) {
    if (this.busy || this.checking) throw new Error('Дождитесь завершения подключения или проверки.');
    const previous = normalizeSettings(this.store.data.settings);
    const next = settingsPatch(previous, patch, this.env.interfaces);
    const reconnect = this.connection.phase === 'connected' && networkKeys.some((key) => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
    if (reconnect && next.mode === 'tun' && !this.env.elevated) throw new Error('Для TUN перезапустите JOXY с правами администратора.');
    if (reconnect) await this.disconnect({ keepKillSwitch: true });
    this.store.data.settings = next; await this.store.save(); this.publish();
    if (reconnect) {
      try { await this.connect(); }
      catch (e) {
        this.store.data.settings = previous; await this.store.save();
        this.log('warning', 'Новые сетевые настройки не прошли проверку. Возвращаем предыдущие.');
        await this.connect().catch(() => {});
        throw new Error(`Не удалось применить настройки: ${redact(e.message)} Предыдущие настройки восстановлены.`);
      }
    }
    await this.syncKillSwitch();
  }
  // The link carries the server's keys, so it goes to the clipboard from here and never to the window or the log.
  shareLink(id) {
    const profile = typeof id === 'string' && this.store.data.profiles.find((p) => p.id === id);
    if (!profile) throw new Error('Сервер не найден.');
    return shareLink(profile);
  }
  // A subscription's address carries its access token, so like a server link it only ever reaches the clipboard.
  sourceLink(id) {
    const source = typeof id === 'string' && this.store.data.sources.find((s) => s.id === id);
    if (!source?.url) throw new Error('У этой подписки нет адреса: её серверы добавлены вручную.');
    return source.url;
  }
  wantsKillSwitch() { return !!this.killSwitch && normalizeSettings(this.store.data.settings).mode === 'tun' && this.store.data.settings.killSwitch === true; }
  async armKillSwitch() {
    if (!this.wantsKillSwitch() || this.killSwitch.armed) return;
    const allowLan = this.store.data.settings.bypassLan !== false;
    await this.killSwitch.arm({ apps: [this.binary], tun: 'JOXY', allowLan });
    this.killSwitchLan = allowLan;
    this.log('info', 'Kill switch включён: трафик мимо VPN заблокирован.'); this.publish();
  }
  leaks() { const s = this.store.data.settings; return { blockDns: s.tunDnsProtection !== false, blockIpv6: s.tunIpv6 !== 'tunnel' }; }
  wantsLeakGuard() { const l = this.leaks(); return !!this.leakGuard && normalizeSettings(this.store.data.settings).mode === 'tun' && (l.blockDns || l.blockIpv6) && !this.wantsKillSwitch(); }
  async armLeakGuard() {
    if (!this.wantsLeakGuard() || this.leakGuard.armed) return;
    const leaks = this.leaks();
    try { await this.leakGuard.arm({ apps: [this.binary], tun: 'JOXY', allowLan: false, leaksOnly: true, ...leaks }); }
    catch (e) { throw Object.assign(new Error(`${leaks.blockDns ? 'Защита DNS' : 'Блокировка IPv6'} не включилась: Windows не приняла правила фильтрации (${e.message.replace(/^Защита от утечек:\s*/, '')}).`), { code: 'WFP_BLOCKED' }); }
    this.log('info', `Защита от утечек включена: мимо VPN заблокированы ${[leaks.blockDns && 'запросы DNS', leaks.blockIpv6 && 'IPv6'].filter(Boolean).join(' и ')}.`);
  }
  async disarmKillSwitch() {
    if (!this.killSwitch?.armed) return;
    await this.killSwitch.disarm();
    this.log('info', 'Kill switch выключен: обычный доступ в интернет восстановлен.'); this.publish();
  }
  // Brings the guard in line with settings changed while connected: it needs no reconnect of its own.
  async syncKillSwitch() {
    const tun = this.connection.phase === 'connected' && this.connection.mode === 'tun';
    if (this.killSwitch) {
      if (!this.wantsKillSwitch()) await this.disarmKillSwitch();
      else {
        if (this.killSwitch.armed && this.killSwitchLan !== (this.store.data.settings.bypassLan !== false)) await this.disarmKillSwitch();
        if (tun) await this.armKillSwitch();
      }
    }
    if (this.wantsLeakGuard() && tun) await this.armLeakGuard().catch((e) => this.log('error', e.message));
    else if (!this.wantsLeakGuard()) await this.leakGuard?.disarm();
  }
  // While the kill switch blocks the system resolver, a reconnect reuses the address the server last had.
  async resolveServer(host) {
    const cached = this.resolvedHosts.get(host);
    if (cached && this.killSwitch?.armed) return cached;
    try { const address = await this.hostResolver(host); this.resolvedHosts.set(host, address); return address; }
    catch (e) { if (cached) return cached; throw e; }
  }
  // sourceId: only that subscription's servers; profileId: only that one server.
  async checkAll(sourceId = null, profileId = null) {
    if (this.refreshing) await this.refreshDone.catch(() => {});
    if (this.checking) return;
    if (!this.core.ready) throw new Error(this.core.error);
    if (!this.store.data.profiles.length) throw new Error('Сначала добавьте подписку.');
    if (sourceId !== null && (typeof sourceId !== 'string' || !this.store.data.sources.some((s) => s.id === sourceId))) throw new Error('Подписка не найдена.');
    if (profileId !== null && (typeof profileId !== 'string' || !this.store.data.profiles.some((p) => p.id === profileId))) throw new Error('Сервер не найден.');
    this.checking = true; this.publish();
    this.testAbort = new AbortController();
    let finishTests;
    this.testsDone = new Promise((resolve) => { finishTests = resolve; });
    const queue = this.store.data.profiles.filter((p) => (sourceId === null || p.sourceId === sourceId) && (profileId === null || p.id === profileId));
    try {
      await this.readEnvironment();
      const worker = async () => {
        while (queue.length && !this.closed) {
          const p = queue.shift();
          p.lastTest = { status: 'checking' }; this.publish();
          // The server in use is measured through the live tunnel: a fresh connection to it may be refused by the
          // network for a while (DPI cuts new handshakes to VPN servers) while the open one works fine.
          p.lastTest = this.connection.phase === 'connected' && p.id === this.connection.profileId && this.engine
            ? await this.engine.probe(this.store.data.settings.timeout).then((latency) => ({ status: 'ok', latency, checkedAt: new Date().toISOString() }), (e) => ({ status: 'error', message: e.message, checkedAt: new Date().toISOString() }))
            : await testProfile(this.binary, this.runtimeDir, p, this.testInterface(), this.store.data.settings.timeout, this.testAbort.signal);
          if (p.lastTest.message) p.lastTest.message = redact(p.lastTest.message);
          this.log(p.lastTest.status === 'ok' ? 'info' : 'warning', `${p.name}: ${p.lastTest.status === 'ok' ? `HTTPS доступен, ${p.lastTest.latency} мс` : p.lastTest.message}`);
        }
      };
      await Promise.all([worker(), worker()]); await this.store.save();
    } finally { this.checking = false; finishTests(); this.publish(); }
  }
  async connect() {
    if (this.refreshing) await this.refreshDone.catch(() => {});
    if (this.busy || this.connection.phase === 'connected') return;
    if (!this.core.ready) throw new Error(this.core.error);
    const d = this.store.data;
    if (!d.profiles.length) throw new Error('Сначала добавьте подписку или профиль.');
    this.busy = true;
    let finishOperation;
    this.operationDone = new Promise((resolve) => { finishOperation = resolve; });
    try {
      await this.readEnvironment();
      const mode = normalizeSettings(d.settings).mode;
      if (this.env.recoveryRequired) throw new Error('Перезапустите JOXY с правами администратора для восстановления предыдущей TUN-сессии.');
      if (this.env.detectionFailed && mode !== 'local') throw new Error('Не удалось проверить сетевые интерфейсы Windows. Запустите диагностику перед подключением.');
      if (mode !== 'local' && this.env.tunActive) {
        const names = this.env.foreignTunnels?.map((t) => t.name).join(', ');
        throw Object.assign(new Error(`Обнаружены маршруты TUN другого VPN${names ? ` (${names})` : ''}. Отключите его и повторите подключение.`), { code: 'VPN_CONFLICT' });
      }
      if (mode === 'tun' && !this.env.elevated) throw new Error('Для TUN нужны права администратора. Откройте настройки и перезапустите JOXY соответствующей кнопкой.');
      if (mode === 'tun' && !this.core.tunReady) throw new Error(this.core.tunError || 'TUN не прошёл проверку.');
      const candidates = d.selectedId === 'auto' ? [...d.profiles].sort((a, b) => rank(a) - rank(b)) : d.profiles.filter((p) => p.id === d.selectedId);
      this.connection = { phase: 'connecting', profileId: candidates[0]?.id, since: null, exitIP: null, latency: null, systemProxy: false };
      this.publish();
      if (this.wantsKillSwitch() && !this.killSwitch.armed) {
        // Resolved before arming: once armed, the system resolver is outside the allowed paths.
        for (const p of candidates) if (!isIP(p.address)) await this.resolveServer(p.address).catch(() => {});
        await this.armKillSwitch();
      }
      let lastError;
      for (const p of candidates) {
        if (this.closed) break;
        this.connection.profileId = p.id; this.publish();
        const engine = this.engineFactory();
        this.engine = engine;
        engine.on('log', (line) => { if (/warning|error|failed/i.test(line)) this.log('warning', line); });
        try {
          await engine.start(p, this.outboundInterface(), { ...d.settings, weakHostSend: this.env.weakHostSend || [], resolve: (host) => this.resolveServer(host) });
          if (mode === 'tun') await this.armLeakGuard();
          const latency = await engine.probe(d.settings.timeout);
          p.lastTest = { status: 'ok', latency, checkedAt: new Date().toISOString() };
          const exitIP = await engine.exitIP().catch(() => null);
          if (this.closed) throw new Error('Приложение закрывается.');
          if (mode === 'system') await this.proxy.enable(engine.ports.http, engine.child.pid);
          if (mode === 'tun') await this.proxy.suspend(engine.child.pid);
          if (this.closed) throw new Error('Приложение закрывается.');
          this.connection = { phase: 'connected', profileId: p.id, since: new Date().toISOString(), exitIP, latency, mode, systemProxy: mode === 'system', ports: engine.ports, interface: this.env.interface || '' };
          this.stats = { down: 0, up: 0, downRate: 0, upRate: 0, history: [] }; this.lastSample = null; this.healthFails = 0; this.pendingRecovery = null;
          engine.once('crash', () => this.handleCrash());
          await this.store.save(); this.log('info', `Подключено: ${p.name}. ${mode === 'tun' ? 'TUN: системные маршруты и DNS включены.' : mode === 'system' ? 'Системный прокси Windows включён.' : 'Локальный HTTP/SOCKS-прокси запущен.'}`);
          return;
        } catch (e) {
          lastError = e;
          await this.proxy.restore().catch(() => {}); await engine.stop(); await this.leakGuard?.disarm();
          // Another VPN may have raised its TUN between our check and the start: it takes the routes, and our TUN
          // check times out or the filters fail. Neither is the server's fault, so the network is read again.
          if (mode === 'tun' || e.code === 'WFP_BLOCKED') {
            await this.readEnvironment().catch(() => {});
            if (this.env.tunActive) {
              const names = this.env.foreignTunnels?.map((t) => t.name).join(', ');
              throw Object.assign(new Error(`Обнаружены маршруты TUN другого VPN${names ? ` (${names})` : ''}. Отключите его и повторите подключение.`), { code: 'VPN_CONFLICT' });
            }
          }
          // The filters are Windows-wide: another server would fail the same way.
          if (e.code === 'WFP_BLOCKED') throw e;
          p.lastTest = { status: 'error', message: redact(e.message), checkedAt: new Date().toISOString() };
          this.log('warning', `${p.name}: ${e.message}`);
        }
      }
      throw lastError || new Error('Подходящих профилей не найдено.');
    } catch (e) {
      this.engine = null; this.connection = { phase: 'error', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false, error: redact(e.message), errorCode: e.code === 'VPN_CONFLICT' ? 'vpn-conflict' : e.code === 'WFP_BLOCKED' ? 'wfp-blocked' : undefined };
      this.log('error', e.message);
      // A first attempt that fails must not leave the user offline; only an established session keeps the block.
      if (!this.recovering) await this.disarmKillSwitch().catch((err) => this.log('error', err.message));
      throw e;
    } finally { this.busy = false; finishOperation(); this.publish(); }
  }
  // keepKillSwitch: an automatic reconnect or settings change keeps traffic blocked in between.
  async disconnect({ keepKillSwitch = false } = {}) {
    if (this.busy) throw new Error('Дождитесь завершения текущего подключения.');
    this.busy = true; this.pendingRecovery = null;
    try {
      await this.proxy.restore();
      if (this.engine) await this.engine.stop(); this.engine = null;
      await this.leakGuard?.disarm();
      this.connection = { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false };
      this.stats.downRate = 0; this.stats.upRate = 0;
      this.log('info', 'Отключено. Предыдущие настройки прокси восстановлены.');
      if (!keepKillSwitch) await this.disarmKillSwitch();
    } finally { this.busy = false; this.publish(); }
  }
  async handleCrash() {
    const crashed = this.connection.profileId;
    await this.proxy.restore().catch((e) => this.log('error', e.message));
    await this.tunGuard?.restore().catch((e) => this.log('error', e.message));
    // Without the TUN the protection would only cut DNS off; the reconnect arms it again.
    await this.leakGuard?.disarm();
    this.engine = null; this.connection = { ...this.connection, phase: 'error', systemProxy: false, error: 'Ядро Xray неожиданно завершилось. Перезапускаем.' };
    this.log('error', this.connection.error);
    if (crashed && !this.closed) { this.pendingRecovery = crashed; setTimeout(() => this.health().catch((e) => this.log('error', e.message)), 1500); }
  }
  async sample() {
    if (!this.engine || this.connection.phase !== 'connected' || this.metricsBusy) return;
    this.metricsBusy = true;
    try {
      const metrics = await this.engine.metrics(); const now = Date.now();
      const seconds = this.lastSample ? (now - this.lastSample.time) / 1000 : 1;
      const downRate = this.lastSample ? Math.max(0, (metrics.down - this.lastSample.down) / seconds) : 0;
      const upRate = this.lastSample ? Math.max(0, (metrics.up - this.lastSample.up) / seconds) : 0;
      this.stats = { ...metrics, downRate, upRate, history: [...this.stats.history, { down: downRate, up: upRate }].slice(-45) };
      this.lastSample = { ...metrics, time: now }; this.publish();
    } catch {} finally { this.metricsBusy = false; }
  }
  // urgent: after sleep a single failed probe is enough to rebuild the session.
  async health({ urgent = false } = {}) {
    // A recovery that failed (e.g. no network yet) keeps retrying until the user connects or disconnects.
    if (this.pendingRecovery && this.connection.phase === 'error' && !this.healthBusy && !this.busy) {
      this.healthBusy = true;
      try { await this.recover(this.pendingRecovery); } finally { this.healthBusy = false; }
      return;
    }
    if (!this.engine || this.connection.phase !== 'connected' || this.healthBusy || this.busy) return;
    this.healthBusy = true;
    try {
      this.connection.latency = await this.engine.probe(this.store.data.settings.timeout); this.healthFails = 0; this.publish();
    } catch (e) {
      this.healthFails++; this.log('warning', `Проверка связи ${Math.min(this.healthFails, 2)}/2: ${e.message}`);
      // Xray is bound to the interface chosen at connect time; a new default route makes that session useless.
      const moved = this.store.data.settings.interface === 'auto' && await this.readEnvironment().then(() => !this.env.detectionFailed && this.env.interface !== this.connection.interface, () => false);
      if (moved) this.log('info', `Сетевой интерфейс изменился: ${this.env.interface || 'нет подключения'}.`);
      if (urgent || moved || this.healthFails >= 2) await this.recover();
    } finally { this.healthBusy = false; }
  }
  async recover(failed = this.connection.profileId) {
    const d = this.store.data, selection = d.selectedId;
    // The same profile is retried first: lost connectivity is usually the network, not the server.
    const order = [failed, ...(d.settings.autoFallback ? d.profiles.filter((p) => p.id !== failed).sort((a, b) => rank(a) - rank(b)).map((p) => p.id) : [])]
      .filter((id) => d.profiles.some((p) => p.id === id));
    if (this.connection.phase === 'connected') { await this.disconnect({ keepKillSwitch: true }); this.log('info', 'Связь потеряна. Переподключаемся.'); }
    this.recovering = true;
    try {
      for (const id of order) {
        if (this.closed) return;
        d.selectedId = id;
        try { await this.connect(); return; } catch {}
      }
      if (order.length) { this.pendingRecovery = failed; this.log('info', `Переподключиться не удалось. Повторим через 20 секунд.${this.killSwitch?.armed ? ' Kill switch держит блокировку до восстановления VPN.' : ''}`); }
    } finally { this.recovering = false; d.selectedId = selection; await this.store.save(); this.publish(); }
  }
  async readEnvironment() {
    if (!this.environmentReading) this.environmentReading = (async () => {
      const current = await this.environmentReader();
      this.env = { ...current, recoveryRequired: this.env.recoveryRequired };
      return this.env;
    })().finally(() => { this.environmentReading = null; });
    return this.environmentReading;
  }
  async refreshEnvironment() {
    await this.readEnvironment();
    if (!this.busy && !this.env.detectionFailed && !this.env.tunActive && this.connection.phase === 'error' && this.connection.errorCode === 'vpn-conflict') {
      this.connection = { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false };
    }
    this.publish(); return this.env;
  }
  async close() {
    this.closed = true; clearInterval(this.sampleTimer); clearInterval(this.healthTimer);
    this.testAbort?.abort();
    if (this.engine) await this.engine.stop();
    await this.operationDone; await this.testsDone; await this.refreshDone.catch(() => {});
    await this.proxy.restore(); if (this.engine) await this.engine.stop(); await this.killSwitch?.disarm(); await this.leakGuard?.disarm(); await this.store.save();
  }
}
