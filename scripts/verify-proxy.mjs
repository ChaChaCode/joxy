import { readFile, mkdtemp, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { parseSubscription } from '../electron/profiles.mjs';
import { fetchSubscription, environment, SystemProxy } from '../electron/network.mjs';
import { XrayEngine } from '../electron/engine.mjs';

if (process.platform !== 'win32') throw new Error('Windows integration test');
const { subscriptionUrl } = JSON.parse(await readFile(process.env.JOXY_SUBSCRIPTION_FILE, 'utf8'));
const { profiles } = parseSubscription((await fetchSubscription(subscriptionUrl)).body);
const env = await environment();
if (env.tunActive) throw new Error('Stop the existing TUN before the system proxy integration test.');
const dir = await mkdtemp(path.join(os.tmpdir(), 'zagran-proxy-test-'));
const script = path.resolve('resources/windows-proxy.ps1');
const proxy = new SystemProxy(script, dir);
const engine = new XrayEngine(path.resolve('resources/xray/xray.exe'), dir);
const before = await proxy.run('status');
let parent, watcher;
try {
  await engine.start(profiles.find((p) => p.transport === 'xhttp') || profiles[0], env.interface);
  await engine.probe();
  await proxy.enable(engine.ports.http, engine.child.pid);
  const enabled = await proxy.run('status');
  assert.equal(enabled.ProxyEnable.value, 1);
  assert.equal(enabled.ProxyServer.value, `127.0.0.1:${engine.ports.http}`);
  await proxy.restore();
  assert.deepEqual(await proxy.run('status'), before);
  console.log('System proxy: enabled and exactly restored all original registry values.');

  // The watchdog observes an expendable parent, not the user's VPN or shell.
  parent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await proxy.run('enable', { Port: engine.ports.http, XrayPid: engine.child.pid });
  watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'watch', '-Journal', proxy.journal, '-ParentPid', String(parent.pid)], { windowsHide: true, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1200));
  parent.kill();
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try { await access(proxy.journal); } catch { break; }
    await new Promise((r) => setTimeout(r, 300));
  }
  await assert.rejects(access(proxy.journal), { code: 'ENOENT' });
  assert.deepEqual(await proxy.run('status'), before);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(engine.child, null);
  console.log('Crash recovery: watchdog restored Windows proxy and terminated only the owned Xray process.');
} finally {
  parent?.kill(); watcher?.kill();
  await proxy.restore(); await engine.stop();
  assert.deepEqual(await proxy.run('status'), before);
  await rm(dir, { recursive: true, force: true });
}
