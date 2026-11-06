import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { buildConfig } from './profiles.mjs';
import { version } from './version.mjs';

export async function freePorts(count = 3) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      servers.push(server);
    }
    return servers.map((s) => s.address().port);
  } finally { await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))); }
}

function waitForPort(port, child, timeout = 6000) {
  const until = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error('Xray завершился при запуске. Проверьте журнал.'));
      if (Date.now() > until) return reject(new Error('Xray не успел открыть локальный порт.'));
      let connected = false;
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.setTimeout(300);
      socket.once('connect', () => { connected = true; socket.destroy(); resolve(); });
      socket.once('timeout', () => socket.destroy());
      socket.once('error', () => {});
      socket.once('close', () => { if (!connected) setTimeout(check, 60); });
    };
    check();
  });
}

function waitFor(condition, child, timeout, message) {
  const until = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) return resolve();
      if (child.exitCode !== null || child.signalCode !== null) return reject(new Error('Xray завершился при запуске. Проверьте журнал.'));
      if (Date.now() > until) return reject(new Error(message));
      setTimeout(check, 50);
    };
    check();
  });
}

// shared: a keep-alive agent the caller owns and closes, for several requests over one connection.
export function proxyRequest(port, url, timeout = 8000, signal, shared) {
  return new Promise((resolve, reject) => {
    const agent = shared || new HttpsProxyAgent(`http://127.0.0.1:${port}`, { timeout });
    const done = () => { if (!shared) agent.destroy(); };
    const start = performance.now();
    const req = httpsRequest(url, { agent, timeout, signal, headers: { 'User-Agent': `JOXY/${version}` } }, (res) => {
      let body = '', size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 64 * 1024) req.destroy(new Error('Слишком большой ответ проверки.'));
        else body += chunk.toString();
      });
      res.on('end', () => { clearTimeout(timer); done(); resolve({ status: res.statusCode, body, latency: Math.round(performance.now() - start) }); });
      res.on('error', (err) => req.destroy(err));
    });
    const timer = setTimeout(() => req.destroy(new Error(`Тайм-аут HTTPS-проверки. Соединение не завершилось за ${Math.round(timeout / 1000)} с.`)), timeout);
    req.once('timeout', () => req.destroy(new Error('Тайм-аут соединения.')));
    req.once('error', (err) => { clearTimeout(timer); done(); reject(err); });
    req.end();
  });
}

export function nativeRequest(url, timeout = 8000, signal, agent = false) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = httpsRequest(url, { timeout, signal, family: 4, agent }, (res) => {
      let body = '', size = 0;
      res.on('data', (chunk) => { size += chunk.length; if (size > 65536) req.destroy(new Error('Слишком большой ответ проверки.')); else body += chunk.toString(); });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body, latency: Math.round(performance.now() - start) }); });
      res.on('error', (e) => req.destroy(e));
    });
    const timer = setTimeout(() => req.destroy(new Error('Тайм-аут проверки TUN.')), timeout);
    req.on('timeout', () => req.destroy(new Error('Тайм-аут проверки TUN.')));
    req.on('error', (e) => { clearTimeout(timer); reject(e); }); req.end();
  });
}

export class XrayEngine extends EventEmitter {
  constructor(binary, runtimeDir, tunGuard = null) { super(); this.binary = binary; this.runtimeDir = runtimeDir; this.tunGuard = tunGuard; this.child = null; this.ports = null; this.configPath = null; this.abort = new AbortController(); }
  async start(profile, networkInterface = '', options = {}) {
    if (this.child) throw new Error('Это ядро Xray уже запущено.');
    const [http, socks, metrics] = await freePorts();
    this.ports = { http, socks, metrics };
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    this.configPath = path.join(this.runtimeDir, `session-${randomUUID()}.json`);
    this.tun = options.mode === 'tun';
    const resolvedServer = this.tun && !isIP(profile.address) ? await (options.resolve ? options.resolve(profile.address) : lookup(profile.address, { family: 4 }).then((r) => r.address)) : undefined;
    await writeFile(this.configPath, JSON.stringify(buildConfig(profile, this.ports, networkInterface, { ...options, resolvedServer })), { mode: 0o600 });
    if (this.tun) { if (!this.tunGuard) throw new Error('Не настроено восстановление TUN.'); await this.tunGuard.prepare(options.weakHostSend || []); }
    const child = spawn(this.binary, ['run', '-config', this.configPath], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GODEBUG: 'multipathtcp=0' },
    });
    this.child = child;
    let errorText = '', started = false;
    const onData = (chunk) => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      errorText = (errorText + chunk.toString()).slice(-6000);
      for (const line of lines) { if (/core: Xray \S+ started/.test(line)) started = true; this.emit('log', line); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.once('error', (error) => { this.emit('log', error.message); });
    child.once('exit', (code) => {
      if (this.child === child) { this.child = null; this.emit('crash', { code, detail: errorText }); }
    });
    try {
      if (this.tun) await this.tunGuard.track(child.pid, this.binary);
      await waitForPort(http, child, this.tun ? 15000 : 6000);
      // Xray reports started only once every inbound is up, the TUN with its routes and DNS included.
      if (this.tun) await waitFor(() => started, child, 15000, 'TUN не запустился: Xray не сообщил о готовности.');
    } catch (e) {
      await this.stop();
      throw new Error(errorText.includes('Failed to start') ? `Ошибка конфигурации Xray: ${errorText.split('Failed to start:').pop().trim().slice(0, 500)}` : e.message);
    }
    return this.ports;
  }
  // The first request proves that an HTTPS site opens through the server, handshakes and all. The latency shown is
  // the second one, over the connection the first left open: one round trip through the tunnel, as other clients
  // measure it. A second request that fails does not fail a server the first one reached.
  async probe(timeout = 8000) {
    if (!this.child || !this.ports) throw new Error('Ядро не запущено.');
    const url = 'https://www.gstatic.com/generate_204';
    const agent = this.tun ? new HttpsAgent({ keepAlive: true, maxSockets: 1 }) : new HttpsProxyAgent(`http://127.0.0.1:${this.ports.http}`, { keepAlive: true, maxSockets: 1, timeout });
    const get = () => this.tun ? nativeRequest(url, timeout, this.abort.signal, agent) : proxyRequest(this.ports.http, url, timeout, this.abort.signal, agent);
    try {
      const first = await get();
      if (first.status !== 204) throw new Error(`HTTPS-проверка вернула HTTP ${first.status}, ожидался 204.`);
      const second = await get().catch(() => null);
      return second?.status === 204 ? second.latency : first.latency;
    } finally { agent.destroy(); }
  }
  async exitIP() {
    if (!this.ports) return null;
    const r = this.tun ? await nativeRequest('https://api.ipify.org?format=json', 7000, this.abort.signal) : await proxyRequest(this.ports.http, 'https://api.ipify.org?format=json', 7000, this.abort.signal);
    if (r.status !== 200) return null;
    try { const ip = JSON.parse(r.body).ip; return typeof ip === 'string' && /^[a-fA-F0-9.:]{3,45}$/.test(ip) ? ip : null; } catch { return null; }
  }
  async metrics() {
    if (!this.ports || !this.child) return { down: 0, up: 0 };
    const data = await new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port: this.ports.metrics, path: '/debug/vars', timeout: 1200 }, (r) => {
        let text = '';
        r.on('data', (c) => { text += c; if (text.length > 2_000_000) req.destroy(); });
        r.on('end', () => { try { resolve(JSON.parse(text)); } catch (e) { reject(e); } });
      });
      req.on('timeout', () => req.destroy(new Error('metrics timeout'))); req.on('error', reject); req.end();
    });
    const stats = data.stats?.outbound?.proxy;
    return { down: Number(stats?.downlink || 0), up: Number(stats?.uplink || 0) };
  }
  async stop() {
    this.abort.abort();
    const child = this.child; this.child = null;
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    if (this.configPath) await rm(this.configPath, { force: true }).catch(() => {});
    this.configPath = null;
    if (this.tun) await this.tunGuard?.restore();
  }
}

export async function testProfile(binary, runtimeDir, profile, networkInterface = '', timeout = 8000, signal) {
  const engine = new XrayEngine(binary, runtimeDir);
  let detail = '';
  engine.on('log', (line) => { detail = (detail + '\n' + line).slice(-8000); });
  const cancel = () => engine.stop().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    if (signal?.aborted) throw new Error('Проверка отменена.');
    await engine.start(profile, networkInterface);
    const latency = await engine.probe(timeout);
    return { status: 'ok', latency, checkedAt: new Date().toISOString() };
  } catch (e) {
    const message = /reality verification failed/i.test(detail) ? 'Сервер отклонил проверку REALITY. Проверьте ключ, SNI и совместимость ядра.' : e.message;
    return { status: 'error', message, checkedAt: new Date().toISOString() };
  } finally { signal?.removeEventListener('abort', cancel); await engine.stop(); }
}
