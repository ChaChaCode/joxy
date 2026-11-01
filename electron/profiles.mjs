import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { countryCode, namedCountry } from './country.mjs';
import { normalizeSettings, parseDirectRules } from './settings.mjs';

const transports = new Set(['raw', 'xhttp', 'grpc', 'ws', 'httpupgrade']);
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v, max = 512) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f]/.test(v);
const fail = (message) => { throw new Error(message); };

// Every uTLS fingerprint name Xray 26.10.31 accepts (transport/internet/tls: Preset, Modern and Other fingerprints).
const fingerprints = new Set(('chrome firefox safari ios android edge 360 qq random randomized randomizednoalpn unsafe '
  + 'hellofirefox_120 hellofirefox_148 hellochrome_120 hellochrome_131 hellochrome_133 helloios_13 helloios_14 helloedge_106 hellosafari_26_3 hello360_11_0 helloqq_11_1 '
  + 'hellogolang hellorandomized hellorandomizedalpn hellorandomizednoalpn hellofirefox_auto hellofirefox_55 hellofirefox_56 hellofirefox_63 hellofirefox_65 hellofirefox_99 '
  + 'hellofirefox_102 hellofirefox_105 hellochrome_auto hellochrome_58 hellochrome_62 hellochrome_70 hellochrome_72 hellochrome_83 hellochrome_87 hellochrome_96 '
  + 'hellochrome_100 hellochrome_102 hellochrome_106_shuffle helloios_auto helloios_11_1 helloios_12_1 helloandroid_11_okhttp helloedge_85 helloedge_auto hellosafari_16_0 '
  + 'hellosafari_auto hello360_auto hello360_7_5 helloqq_auto hellochrome_100_psk hellochrome_112_psk_shuf hellochrome_114_padding_psk_shuf hellochrome_115_pq '
  + 'hellochrome_115_pq_psk hellochrome_120_pq').split(' '));

export function sanitizeFragment(value) {
  if (value == null || (obj(value) && !Object.keys(value).length)) return undefined;
  if (!obj(value) || !Array.isArray(value.tcp) || value.tcp.length !== 1 || value.tcp[0].type !== 'fragment') {
    return fail('Этот вариант FinalMask пока не поддерживается. Настройка не была удалена молча.');
  }
  const s = value.tcp[0].settings;
  if (!obj(s) || s.packets !== 'tlshello') return fail('Поддерживается фрагментация TLS ClientHello.');
  const range = (v, min, max) => {
    if (typeof v !== 'string' || !/^\d{1,4}(-\d{1,4})?$/.test(v)) return false;
    const [a, b = a] = v.split('-').map(Number);
    return a >= min && b >= a && b <= max;
  };
  const delay = s.delay ?? s.interval ?? '0';
  if (!range(s.length, 1, 1460) || !range(delay, 0, 30)) return fail('Неверные параметры фрагментации TLS.');
  return { tcp: [{ type: 'fragment', settings: { packets: 'tlshello', length: s.length, delay } }] };
}

export function normalizeOutbound(raw, name = '') {
  if (!obj(raw) || raw.protocol !== 'vless') return fail('Первая версия JOXY поддерживает профили VLESS.');
  const s = raw.settings;
  const v = s?.vnext?.[0];
  const user = v?.users?.[0] ?? s;
  const address = v?.address ?? s?.address;
  const port = Number(v?.port ?? s?.port);
  const uuid = user?.id;
  if (!text(address, 253) || (!isIP(address) && !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(address))) return fail('Некорректный адрес сервера.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fail('Порт должен быть от 1 до 65535.');
  if (!text(uuid, 64) || !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(uuid)) return fail('Не найден корректный UUID VLESS.');
  const input = raw.streamSettings ?? {};
  const network = input.network === 'tcp' || !input.network ? 'raw' : input.network;
  const security = input.security;
  if (!transports.has(network)) return fail(`Транспорт ${network} пока не поддерживается.`);
  if (!['reality', 'tls'].includes(security)) return fail('Для подключения требуется REALITY или TLS.');
  const flow = user.flow ?? '';
  if (!['', 'none', 'xtls-rprx-vision', 'xtls-rprx-vision-udp443'].includes(flow)) return fail('Неизвестный flow VLESS.');
  if (flow.startsWith('xtls-') && network !== 'raw') return fail('Vision нельзя использовать вместе с XHTTP, gRPC или WebSocket.');
  const stream = { network, security };
  if (security === 'reality') {
    const r = input.realitySettings;
    const password = r?.password ?? r?.publicKey;
    if (!obj(r) || !text(password, 64) || !/^[A-Za-z0-9_-]{43}$/.test(password)) return fail('Не найден корректный ключ REALITY.');
    // Without an SNI Xray presents the server address, as other clients do with such links.
    if (r.serverName != null && !text(r.serverName, 253)) return fail('Некорректный SNI REALITY.');
    const shortId = r.shortId ?? '';
    if (!/^(?:[a-fA-F0-9]{2}){0,8}$/.test(shortId)) return fail('Некорректный short ID REALITY.');
    const fingerprint = String(r.fingerprint || 'chrome').toLowerCase();
    if (!fingerprints.has(fingerprint)) return fail(`TLS fingerprint «${String(r.fingerprint).slice(0, 40)}» не поддерживается ядром Xray.`);
    stream.realitySettings = { ...(r.serverName ? { serverName: r.serverName } : {}), password, shortId, fingerprint };
    if (r.mldsa65Verify) {
      if (!text(r.mldsa65Verify, 4096)) return fail('Некорректная подпись REALITY.');
      stream.realitySettings.mldsa65Verify = r.mldsa65Verify;
    }
    if (text(r.spiderX) && r.spiderX) stream.realitySettings.spiderX = r.spiderX;
  } else {
    const t = input.tlsSettings ?? {};
    if (t.allowInsecure) return fail('Профиль отключает проверку сертификата. Исправьте его на сервере.');
    stream.tlsSettings = { serverName: text(t.serverName, 253) ? t.serverName : address, fingerprint: 'chrome' };
    if (Array.isArray(t.alpn) && t.alpn.every((a) => ['h2', 'http/1.1'].includes(a))) stream.tlsSettings.alpn = t.alpn;
  }
  if (network === 'xhttp') {
    const x = input.xhttpSettings ?? {};
    if (x.mode && !['auto', 'stream-up', 'stream-one', 'packet-up'].includes(x.mode)) return fail('Неизвестный режим XHTTP.');
    if (x.path && (!text(x.path, 1024) || !x.path.startsWith('/'))) return fail('Некорректный путь XHTTP.');
    stream.xhttpSettings = { path: x.path || '/', mode: x.mode || 'auto' };
    if (x.host && text(x.host, 253)) stream.xhttpSettings.host = x.host;
  }
  if (network === 'grpc') {
    const g = input.grpcSettings ?? {};
    if (g.serviceName && !text(g.serviceName)) return fail('Некорректный serviceName gRPC.');
    stream.grpcSettings = { serviceName: g.serviceName || '', multiMode: !!g.multiMode };
    if (g.authority && text(g.authority, 253)) stream.grpcSettings.authority = g.authority;
  }
  if (network === 'ws' || network === 'httpupgrade') {
    const key = network === 'ws' ? 'wsSettings' : 'httpupgradeSettings';
    const w = input[key] ?? {};
    if (w.path && (!text(w.path, 1024) || !w.path.startsWith('/'))) return fail('Некорректный путь транспорта.');
    stream[key] = { path: w.path || '/' };
    const host = w.host ?? w.headers?.Host;
    if (host && text(host, 253)) stream[key][network === 'ws' ? 'headers' : 'host'] = network === 'ws' ? { Host: host } : host;
  }
  const fragment = sanitizeFragment(input.finalmask);
  if (fragment) stream.finalmask = fragment;
  const outbound = { protocol: 'vless', tag: 'proxy', settings: { vnext: [{ address, port, users: [{ id: uuid, encryption: user.encryption || 'none', flow: flow === 'none' ? '' : flow }] }] }, streamSettings: stream };
  if (user.encryption && user.encryption !== 'none') return fail('VLESS Encryption пока не поддерживается.');
  const id = createHash('sha256').update(JSON.stringify(outbound)).digest('hex').slice(0, 20);
  const label = (text(name, 160) && name) || (text(raw.tag, 160) && raw.tag !== 'proxy' ? raw.tag : `VLESS · ${network.toUpperCase()}`);
  return { id, name: label, countryCode: countryCode(raw.countryCode) || namedCountry(label), address, port, transport: network, security, flow: flow || '', fragment: !!fragment, outbound };
}

export function parseVless(link) {
  let u;
  try { u = new URL(link); } catch { return fail('Не удалось прочитать ссылку VLESS.'); }
  if (u.protocol !== 'vless:') return fail('Ожидается ссылка vless://.');
  const q = u.searchParams;
  const input = {
    protocol: 'vless', settings: { address: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port || 443), id: decodeURIComponent(u.username), encryption: q.get('encryption') || 'none', flow: q.get('flow') || '' },
    streamSettings: { network: q.get('type') || 'raw', security: q.get('security') || 'none' },
  };
  const s = input.streamSettings;
  if (s.security === 'reality') s.realitySettings = { serverName: q.get('sni') || '', password: q.get('pbk') || '', shortId: q.get('sid') || '', fingerprint: q.get('fp') || 'chrome', ...(q.get('pqv') ? { mldsa65Verify: q.get('pqv') } : {}), ...(q.get('spx') ? { spiderX: q.get('spx') } : {}) };
  if (s.security === 'tls') s.tlsSettings = { serverName: q.get('sni') || u.hostname, allowInsecure: q.get('allowInsecure') === '1' };
  if (s.network === 'xhttp') s.xhttpSettings = { path: q.get('path') || '/', mode: q.get('mode') || 'auto', host: q.get('host') || '' };
  if (s.network === 'grpc') s.grpcSettings = { serviceName: q.get('serviceName') || '', multiMode: q.get('mode') === 'multi', authority: q.get('authority') || '' };
  if (s.network === 'ws') s.wsSettings = { path: q.get('path') || '/', headers: { Host: q.get('host') || '' } };
  if (s.network === 'httpupgrade') s.httpupgradeSettings = { path: q.get('path') || '/', host: q.get('host') || '' };
  if (q.has('fm') || q.has('finalmask')) {
    try { s.finalmask = JSON.parse(q.get('fm') || q.get('finalmask')); } catch { return fail('Повреждена настройка FinalMask.'); }
  }
  return normalizeOutbound(input, decodeURIComponent(u.hash.slice(1)));
}

export function parseSubscription(input) {
  if (typeof input !== 'string' || input.length > 2_000_000) return fail('Подписка слишком большая. Максимум — 2 МБ.');
  let body = input.replace(/^\uFEFF/, '').trim();
  if (!body) return fail('Подписка пуста.');
  if (!body.startsWith('{') && !body.startsWith('[') && !body.includes('://') && /^[A-Za-z0-9+/=_\s-]+$/.test(body)) body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8').trim();
  const profiles = [], rejected = [];
  const add = (fn) => { try { const p = fn(); if (!profiles.some((x) => x.id === p.id)) profiles.push(p); } catch (e) { rejected.push(e.message); } };
  if (body.startsWith('{') || body.startsWith('[')) {
    let json; try { json = JSON.parse(body); } catch { return fail('Повреждён JSON подписки.'); }
    for (const c of (Array.isArray(json) ? json : [json])) {
      if (c?.protocol === 'vless') add(() => normalizeOutbound(c));
      else if (Array.isArray(c?.outbounds)) {
        for (const o of c.outbounds.filter((x) => x.protocol === 'vless')) add(() => normalizeOutbound(o, c.remarks));
      } else rejected.push('Этот формат JSON пока не поддерживается.');
    }
  } else {
    const lines = body.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
    if (lines.length > 100) return fail('В одной подписке поддерживается до 100 профилей.');
    for (const line of lines) {
      if (line.trim().startsWith('vless://')) add(() => parseVless(line.trim()));
      else if (line.trim().startsWith('json://')) add(() => normalizeOutbound(JSON.parse(Buffer.from(new URL(line.trim()).hash.slice(1), 'base64url').toString('utf8'))));
      else rejected.push('Поддерживаются ссылки VLESS и Xray JSON.');
    }
  }
  if (!profiles.length) return fail(rejected[0] || 'Поддерживаемых профилей не найдено.');
  if (profiles.length > 100) return fail('В одной подписке поддерживается до 100 профилей.');
  return { profiles, rejected };
}

export function publicProfile(profile) {
  const { outbound, ...safe } = profile;
  return safe;
}

export function buildConfig(profile, ports, networkInterface = '', options = {}) {
  const settings = normalizeSettings(options);
  const outbound = structuredClone(profile.outbound);
  if (networkInterface) outbound.streamSettings.sockopt = { interface: networkInterface };
  if (options.resolvedServer) outbound.settings.vnext[0].address = options.resolvedServer;
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'http-in', listen: '127.0.0.1', port: ports.http, protocol: 'http' },
      { tag: 'socks-in', listen: '127.0.0.1', port: ports.socks, protocol: 'socks', settings: { udp: true } },
    ],
    outbounds: [outbound],
    stats: {},
    policy: { system: { statsOutboundUplink: true, statsOutboundDownlink: true } },
    ...(ports.metrics ? { metrics: { tag: 'metrics', listen: `127.0.0.1:${ports.metrics}` } } : {}),
  };
  const rules = [];
  const direct = parseDirectRules(settings.directRules);
  if (settings.mode === 'tun') {
    const ipv6 = settings.tunIpv6 === 'tunnel';
    config.inbounds.push({ tag: 'tun-in', protocol: 'tun', settings: {
      name: 'JOXY', desc: 'JOXY', mtu: settings.tunMtu,
      gateway: ['172.31.255.1/30', ...(ipv6 ? ['fdfe:dcba:9876::1/126'] : [])],
      dns: ['172.31.255.2'],
      autoSystemRoutingTable: ['0.0.0.0/1', '128.0.0.0/1', ...(ipv6 ? ['::/1', '8000::/1'] : [])],
      autoOutboundsInterface: networkInterface || 'auto',
      autoSystemWfpBlockLeak: [...(settings.tunDnsProtection ? ['dns'] : []), 'misconfigtun'],
    }, sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: true } });
    config.dns = { servers: [settings.dnsProvider === 'google' ? 'https://8.8.8.8/dns-query' : 'https://1.1.1.1/dns-query'], queryStrategy: ipv6 ? 'UseIP' : 'UseIPv4' };
    config.outbounds.push({ tag: 'dns-out', protocol: 'dns', settings: {} });
    rules.push({ type: 'field', inboundTag: ['tun-in'], port: '53', outboundTag: 'dns-out' });
  }
  if (settings.bypassLan) rules.push({ type: 'field', ip: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '224.0.0.0/4', '::1/128', 'fc00::/7', 'fe80::/10', 'ff00::/8'], outboundTag: 'direct' });
  if (direct.domains.length) rules.push({ type: 'field', domain: direct.domains, outboundTag: 'direct' });
  if (direct.ips.length) rules.push({ type: 'field', ip: direct.ips, outboundTag: 'direct' });
  if (rules.some((rule) => rule.outboundTag === 'direct')) config.outbounds.push({ tag: 'direct', protocol: 'freedom', settings: {}, ...(networkInterface ? { streamSettings: { sockopt: { interface: networkInterface } } } : {}) });
  if (rules.length) config.routing = { domainStrategy: 'AsIs', rules };
  return config;
}
