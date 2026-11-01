import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Controller } from '../electron/controller.mjs';
import { defaults } from '../electron/store.mjs';

function fixture({ failFirst = false, tun = false, proxyFailure = false, elevated = false } = {}) {
  const calls = [], engines = [];
  const data = defaults();
  data.profiles = [{ id: 'primary', name: 'Primary', transport: 'xhttp' }, { id: 'backup', name: 'Backup', transport: 'raw', fragment: true }];
  const store = { data, save: async () => {} };
  const proxy = { recover: async () => null, suspend: async () => calls.push('proxy-suspend'), enable: async () => { calls.push('proxy-enable'); if (proxyFailure) throw new Error('registry failure'); }, restore: async () => calls.push('proxy-restore') };
  const engineFactory = () => {
    const engine = new EventEmitter();
    const number = engines.length;
    Object.assign(engine, { ports: { http: 12345, socks: 12346 }, child: { pid: 123 },
      start: async (p, networkInterface) => { calls.push(`start:${p.id}`); engine.boundTo = networkInterface; },
      probe: async () => { calls.push('probe'); if (failFirst && number === 0) throw new Error('timeout'); return 42; },
      exitIP: async () => '192.0.2.10', stop: async () => calls.push(`stop:${number}`),
    }); engines.push(engine); return engine;
  };
  const controller = new Controller({ store, binaryDir: '/unused', runtimeDir: '/unused', proxy, engineFactory, environmentReader: async () => ({ interface: 'Ethernet', interfaces: ['Ethernet'], tunActive: tun, elevated, windows: true }) });
  controller.env = { interfaces: ['Ethernet'], elevated };
  controller.core = { ready: true, tunReady: true, version: 'test', error: null };
  return { controller, calls, engines, data };
}
test('automatic mode falls back, and system proxy is enabled only after HTTPS verification', async () => {
  const { controller, calls } = fixture({ failFirst: true });
  await controller.connect();
  assert.equal(controller.connection.profileId, 'backup');
  assert.equal(controller.connection.phase, 'connected');
  assert.deepEqual(calls, ['start:primary', 'probe', 'proxy-restore', 'stop:0', 'start:backup', 'probe', 'proxy-enable']);
  await controller.disconnect();
  assert.equal(controller.connection.phase, 'idle');
  assert.deepEqual(calls.slice(-2), ['proxy-restore', 'stop:1']);
});

test('TUN requires elevation and preserves pending recovery across environment refreshes', async () => {
  const { controller, data, calls } = fixture(); data.settings.mode = 'tun';
  await assert.rejects(controller.connect(), /прав.*администратор/);
  assert.deepEqual(calls, []);
  controller.env.recoveryRequired = true;
  await controller.refreshEnvironment();
  await assert.rejects(controller.connect(), /восстановления предыдущей TUN/);
  assert.deepEqual(calls, []);
});

test('verified TUN suspends the old system proxy and reports the actual connection mode', async () => {
  const { controller, data, calls } = fixture({ elevated: true }); data.settings.mode = 'tun';
  await controller.connect();
  assert.deepEqual(calls, ['start:primary', 'probe', 'proxy-suspend']);
  assert.equal(controller.connection.mode, 'tun'); assert.equal(controller.connection.systemProxy, false);
  await controller.close();
});

test('application settings apply without disconnecting; network settings reconnect and roll back on failure', async () => {
  const { controller, data, calls } = fixture();
  await controller.connect();
  await controller.updateSettings({ closeToTray: false });
  assert.equal(data.settings.closeToTray, false); assert.equal(calls.filter((c) => c === 'probe').length, 1);
  await controller.updateSettings({ bypassLan: false });
  assert.equal(data.settings.bypassLan, false); assert.equal(calls.filter((c) => c === 'probe').length, 2);
  const connect = controller.connect.bind(controller); let attempts = 0;
  controller.connect = async () => { if (++attempts === 1) throw new Error('new configuration failed'); return connect(); };
  await assert.rejects(controller.updateSettings({ dnsProvider: 'google' }), /Предыдущие настройки восстановлены/);
  assert.equal(data.settings.dnsProvider, 'cloudflare'); assert.equal(controller.connection.phase, 'connected');
  await assert.rejects(controller.updateSettings({ mode: 'tun' }), /правами администратора/);
  assert.equal(controller.connection.phase, 'connected'); assert.equal(data.settings.mode, 'system');
  await controller.close();
});
test('another active TUN blocks system-proxy changes', async () => {
  const { controller, calls } = fixture({ tun: true });
  await assert.rejects(controller.connect(), /TUN другого VPN/);
  assert.deepEqual(calls, []);
});

test('refresh clears only a resolved VPN conflict and shares concurrent environment reads', async () => {
  const { controller } = fixture({ tun: true });
  await assert.rejects(controller.connect(), /TUN другого VPN/);
  assert.equal(controller.connection.errorCode, 'vpn-conflict');
  controller.environmentReader = async () => ({ tunActive: false, detectionFailed: true });
  await controller.refreshEnvironment();
  assert.equal(controller.connection.phase, 'error', 'A failed detection is not proof that the conflict ended');
  let reads = 0;
  controller.environmentReader = async () => { reads++; await new Promise((r) => setTimeout(r, 10)); return { interfaces: ['Ethernet'], tunActive: false }; };
  await Promise.all([controller.refreshEnvironment(), controller.refreshEnvironment()]);
  assert.equal(reads, 1); assert.equal(controller.connection.phase, 'idle');
  controller.connection = { phase: 'error', error: 'other error' };
  await controller.refreshEnvironment();
  assert.equal(controller.connection.error, 'other error');
});
test('proxy activation failure stops engines and does not show a connected state', async () => {
  const { controller, calls } = fixture({ proxyFailure: true });
  await assert.rejects(controller.connect(), /registry failure/);
  assert.equal(controller.connection.phase, 'error'); assert.equal(controller.connection.systemProxy, false);
  assert.equal(calls.filter((c) => c.startsWith('stop')).length, 2);
});
test('health failover retries the same profile, then a backup, preserving the user selection', async () => {
  const { controller, calls, engines, data } = fixture();
  await controller.connect();
  const factory = controller.engineFactory;
  // The primary server is down for good: every new primary engine fails too.
  controller.engineFactory = () => { const e = factory(); const start = e.start; e.start = async (p) => { await start(p); if (p.id === 'primary') e.probe = async () => { throw new Error('down'); }; }; return e; };
  engines[0].probe = async () => { throw new Error('lost connection'); };
  await controller.health(); assert.equal(controller.connection.profileId, 'primary');
  await controller.health(); assert.equal(controller.connection.profileId, 'backup');
  assert.equal(data.selectedId, 'auto');
  const retry = calls.indexOf('start:primary', 1), replacement = calls.indexOf('start:backup');
  assert.ok(retry > 0 && retry < replacement, 'The failed profile is retried before switching');
  assert.ok(calls.lastIndexOf('proxy-restore', retry) < retry);
  await controller.close();
});
test('a single profile reconnects instead of silently staying disconnected', async () => {
  const { controller, engines, data } = fixture();
  data.profiles = data.profiles.slice(0, 1);
  await controller.connect();
  engines[0].probe = async () => { throw new Error('lost connection'); };
  await controller.health(); await controller.health();
  assert.equal(controller.connection.phase, 'connected'); assert.equal(engines.length, 2);
  await controller.close();
});
test('without auto fallback the failed profile is still retried, but never replaced', async () => {
  const { controller, engines, data } = fixture();
  data.settings.autoFallback = false;
  await controller.connect();
  const factory = controller.engineFactory;
  controller.engineFactory = () => { const e = factory(); e.probe = async () => { throw new Error('down'); }; return e; };
  engines[0].probe = async () => { throw new Error('lost connection'); };
  await controller.health(); await controller.health();
  assert.equal(controller.connection.phase, 'error');
  assert.equal(engines.length, 2, 'Only one reconnection attempt, to the same profile');
  assert.ok(!controller.logs.some((l) => /3\/2/.test(l.message)), 'No endless 3/2, 4/2 checks');
  await controller.close();
});
test('a failed recovery keeps retrying until the network returns, and stops after a manual disconnect', async () => {
  const { controller, engines, data } = fixture();
  data.profiles = data.profiles.slice(0, 1);
  await controller.connect();
  let online = false;
  const factory = controller.engineFactory;
  controller.engineFactory = () => { const e = factory(); e.probe = async () => { if (!online) throw new Error('offline'); return 30; }; return e; };
  engines[0].probe = async () => { throw new Error('offline'); };
  await controller.health(); await controller.health();
  assert.equal(controller.connection.phase, 'error'); assert.equal(controller.pendingRecovery, 'primary');
  await controller.health(); assert.equal(controller.connection.phase, 'error');
  online = true; await controller.health();
  assert.equal(controller.connection.phase, 'connected'); assert.equal(controller.pendingRecovery, null);
  engines.at(-1).probe = async () => { throw new Error('offline'); }; online = false;
  await controller.health(); await controller.health();
  assert.equal(controller.pendingRecovery, 'primary');
  await controller.disconnect(); const count = engines.length;
  await controller.health(); assert.equal(engines.length, count, 'Manual disconnect cancels retries');
  await controller.close();
});
test('a changed default interface rebuilds the session on the first failed probe', async () => {
  const { controller, engines, calls } = fixture();
  await controller.connect();
  assert.equal(controller.connection.interface, 'Ethernet');
  controller.environmentReader = async () => ({ interface: 'Wi-Fi', interfaces: ['Wi-Fi'], tunActive: false, windows: true });
  engines[0].probe = async () => { throw new Error('network unreachable'); };
  await controller.health();
  assert.equal(controller.connection.phase, 'connected'); assert.equal(controller.connection.interface, 'Wi-Fi');
  assert.equal(calls.filter((c) => c === 'start:primary').length, 2);
  await controller.close();
});
test('after sleep one failed probe is enough to reconnect', async () => {
  const { controller, engines } = fixture();
  await controller.connect();
  engines[0].probe = async () => { throw new Error('stale socket'); };
  controller.afterResume(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(controller.connection.phase, 'connected'); assert.equal(engines.length, 2);
  await controller.close();
});
test('stale session configs with secrets are removed on start, other files are kept', async () => {
  const { mkdtemp, writeFile, readdir, rm } = await import('node:fs/promises');
  const os = await import('node:os'), path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'joxy-runtime-'));
  try {
    await writeFile(path.join(dir, 'session-1b4e28ba-2fa1-11d2-883f-0016d3cca427.json'), '{}');
    await writeFile(path.join(dir, 'keep.txt'), '');
    const { controller } = fixture(); controller.runtimeDir = dir;
    await controller.removeStaleConfigs();
    assert.deepEqual(await readdir(dir), ['keep.txt']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('automatic interface leaves the binding to Xray; a chosen one is pinned', async () => {
  const { controller, engines, data } = fixture();
  await controller.connect();
  assert.equal(engines[0].boundTo, '', 'auto must not freeze the interface of the moment');
  await controller.disconnect();
  data.settings.interface = 'Ethernet';
  await controller.connect();
  assert.equal(engines[1].boundTo, 'Ethernet');
  await controller.close();
});
test('server checks beside our own TUN are bound to the physical interface', () => {
  const { controller } = fixture();
  controller.env.interface = 'Wi-Fi';
  assert.equal(controller.testInterface(), '');
  controller.connection = { phase: 'connected', mode: 'tun' };
  assert.equal(controller.testInterface(), 'Wi-Fi');
});

function killSwitchFixture(options = {}) {
  const f = fixture({ elevated: true, ...options });
  f.data.settings.mode = 'tun'; f.data.settings.killSwitch = true;
  const ks = new EventEmitter();
  ks.armed = false; ks.configs = [];
  ks.arm = async (config) => { f.calls.push('ks-arm'); if (options.armFailure) throw new Error('Kill switch: refused'); ks.armed = true; ks.configs.push(config); };
  ks.disarm = async () => { if (ks.armed) f.calls.push('ks-disarm'); ks.armed = false; };
  f.controller.killSwitch = ks; f.ks = ks;
  return f;
}
test('kill switch arms before the core starts and a manual disconnect lifts it', async () => {
  const { controller, calls, ks } = killSwitchFixture();
  await controller.connect();
  assert.deepEqual(calls.slice(0, 2), ['ks-arm', 'start:primary']);
  assert.deepEqual(ks.configs[0], { apps: [controller.binary], tun: 'JOXY', allowLan: true });
  assert.equal(controller.snapshot().killSwitch.armed, true);
  await controller.disconnect();
  assert.equal(ks.armed, false); assert.equal(calls.at(-1), 'ks-disarm');
});
test('kill switch stays off unless it is enabled in TUN mode', async () => {
  for (const settings of [{ killSwitch: false }, { mode: 'system' }]) {
    const { controller, calls, data } = killSwitchFixture();
    Object.assign(data.settings, settings);
    await controller.connect(); await controller.disconnect();
    assert.ok(!calls.includes('ks-arm'), JSON.stringify(settings));
  }
});
test('a failed first connection does not leave the user offline', async () => {
  const { controller, ks } = killSwitchFixture();
  const factory = controller.engineFactory;
  controller.engineFactory = () => { const e = factory(); e.probe = async () => { throw new Error('down'); }; return e; };
  await assert.rejects(controller.connect(), /down/);
  assert.equal(ks.armed, false);
});
test('if the kill switch cannot arm, JOXY does not connect unprotected', async () => {
  const { controller, calls } = killSwitchFixture({ armFailure: true });
  await assert.rejects(controller.connect(), /Kill switch/);
  assert.ok(!calls.some((c) => c.startsWith('start:')));
});
test('a lost session keeps traffic blocked while recovery retries, until the user disconnects', async () => {
  const { controller, engines, ks } = killSwitchFixture();
  await controller.connect();
  const factory = controller.engineFactory;
  controller.engineFactory = () => { const e = factory(); e.probe = async () => { throw new Error('offline'); }; return e; };
  engines[0].probe = async () => { throw new Error('offline'); };
  await controller.health(); await controller.health();
  assert.equal(controller.connection.phase, 'error'); assert.ok(controller.pendingRecovery);
  assert.equal(ks.armed, true, 'Still blocked between attempts');
  assert.ok(controller.logs.some((l) => /держит блокировку/.test(l.message)));
  await controller.disconnect();
  assert.equal(ks.armed, false);
});
test('a crashed core is restarted, under the kill switch when it is on', async () => {
  const { controller, engines, ks } = killSwitchFixture();
  await controller.connect();
  await controller.handleCrash();
  assert.equal(controller.connection.phase, 'error'); assert.equal(ks.armed, true);
  await controller.health();
  assert.equal(controller.connection.phase, 'connected'); assert.equal(engines.length, 2);
  await controller.close();
  assert.equal(ks.armed, false);
});
test('kill switch follows the setting while connected, without a reconnect', async () => {
  const { controller, calls, ks } = killSwitchFixture();
  await controller.connect();
  await controller.updateSettings({ killSwitch: false });
  assert.equal(ks.armed, false);
  await controller.updateSettings({ killSwitch: true });
  assert.equal(ks.armed, true);
  assert.equal(calls.filter((c) => c.startsWith('start:')).length, 1);
  await controller.close();
});
test('server addresses are resolved before arming and reused while the resolver is blocked', async () => {
  const { controller, data, ks } = killSwitchFixture();
  data.profiles[0].address = 'vpn.example.com'; data.profiles[1].address = '192.0.2.45';
  let lookups = 0;
  controller.hostResolver = async () => { lookups++; if (ks.armed) throw new Error('blocked'); return '192.0.2.44'; };
  await controller.connect();
  assert.equal(lookups, 1);
  assert.equal(await controller.resolveServer('vpn.example.com'), '192.0.2.44');
  assert.equal(lookups, 1, 'No lookup while armed when a cached address exists');
  await controller.close();
});
