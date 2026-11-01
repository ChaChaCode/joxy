import { readFile, writeFile, mkdtemp, mkdir, rm, access } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Controller, redact } from '../electron/controller.mjs';
import { defaults } from '../electron/store.mjs';
import { parseSubscription, buildConfig } from '../electron/profiles.mjs';
import { environment, fetchSubscription, SystemProxy, TunGuard } from '../electron/network.mjs';
import { nativeRequest } from '../electron/engine.mjs';
import { version } from '../electron/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exec = promisify(execFile);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const output = process.env.JOXY_TUN_REPORT;
const report = { version, started: new Date().toISOString(), checks: [], ok: false };
async function ps(script) {
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; ${script}`, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000 });
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
}
async function snapshot() {
  return ps(`$physical=@(Get-NetAdapter -Physical | Where-Object Status -eq 'Up'); @{routes=@(Get-NetRoute | Where-Object {$_.DestinationPrefix -in @('0.0.0.0/0','0.0.0.0/1','128.0.0.0/1','::/0','::/1','8000::/1')} | Sort-Object InterfaceIndex,DestinationPrefix | Select-Object InterfaceIndex,DestinationPrefix,NextHop,RouteMetric); dns=@(Get-DnsClientServerAddress | Where-Object InterfaceIndex -in $physical.ifIndex | Sort-Object InterfaceIndex,AddressFamily | Select-Object InterfaceIndex,AddressFamily,ServerAddresses); host=@(Get-NetIPInterface | Where-Object InterfaceIndex -in $physical.ifIndex | Sort-Object InterfaceIndex,AddressFamily | Select-Object InterfaceIndex,AddressFamily,WeakHostSend,Forwarding)} | ConvertTo-Json -Depth 6 -Compress`);
}
async function until(fn, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await pause(400); }
  throw new Error('Recovery deadline exceeded');
}
async function exists(file) { try { await access(file); return true; } catch { return false; } }
async function udpRoundtrip(host, port, payload, validate) {
  const socket = createSocket('udp4');
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UDP response timeout')), 12000);
      socket.on('error', (e) => { clearTimeout(timer); reject(e); });
      socket.on('message', (data) => { try { validate(data); clearTimeout(timer); resolve(); } catch (e) { clearTimeout(timer); reject(e); } });
      socket.send(payload, port, host, (e) => { if (e) { clearTimeout(timer); reject(e); } });
    });
  } finally { socket.close(); }
}
async function makeController(directory, profiles, selected, env) {
  await mkdir(directory, { recursive: true });
  const data = defaults(); data.profiles = structuredClone(profiles); data.selectedId = selected;
  data.settings = { ...data.settings, mode: 'tun', systemProxy: false, timeout: 12000 };
  const proxy = new SystemProxy(path.join(root, 'resources/windows-proxy.ps1'), directory);
  const guard = new TunGuard(path.join(root, 'resources/windows-tun.ps1'), directory);
  const controller = new Controller({ store: { data, save: async () => {} }, binaryDir: path.join(root, 'resources/xray'), runtimeDir: path.join(directory, 'runtime'), proxy, tunGuard: guard, environmentReader: async () => env });
  await controller.initialize(); return { controller, proxy, guard };
}

let controller, temporary, echo, child;
try {
  const env = await environment();
  if (!env.elevated) throw new Error('Run this TUN integration test as Administrator using Windows UAC.');
  if (env.tunActive || env.detectionFailed) throw new Error('Close the other VPN before the isolated TUN test.');
  const { subscriptionUrl } = JSON.parse(await readFile(process.env.JOXY_SUBSCRIPTION_FILE, 'utf8'));
  const { profiles } = parseSubscription((await fetchSubscription(subscriptionUrl)).body);
  const selected = profiles.find((p) => p.transport === 'xhttp') || profiles[0];
  if (process.argv.includes('--watchdog-child')) {
    const instance = await makeController(process.env.JOXY_TUN_CHILD_DATA, profiles, selected.id, env);
    controller = instance.controller;
    await controller.connect();
    await writeFile(process.env.JOXY_TUN_CHILD_READY, JSON.stringify({ pid: process.pid, core: controller.engine.child.pid }));
    await pause(45000); await controller.close(); process.exit(0);
  }
  temporary = await mkdtemp(path.join(os.tmpdir(), 'joxy-tun-test-'));
  const before = await snapshot();
  const instance = await makeController(path.join(temporary, 'regular'), profiles, selected.id, env);
  controller = instance.controller;
  const proxyBefore = await instance.proxy.run('status');
  for (const mode of ['system', 'local', 'tun']) for (const ipv6 of ['block', 'tunnel']) {
    const config = path.join(temporary, 'config-check.json');
    await writeFile(config, JSON.stringify(buildConfig(selected, { http: 31001, socks: 31002, metrics: 31003 }, env.interface, { mode, tunIpv6: ipv6 })));
    await exec(path.join(root, 'resources/xray/xray.exe'), ['run', '-test', '-config', config], { windowsHide: true, timeout: 10000 });
  }
  report.checks.push('six runtime configurations accepted by bundled Xray');
  // Optional proof of arbitrary UDP, with a bounded echo listener on the user's own VPS.
  if (process.env.JOXY_TUN_SSH_KEY && process.env.JOXY_TUN_KNOWN_HOSTS) {
    const nonce = randomBytes(24).toString('hex'); const port = 58347;
    echo = spawn('ssh.exe', ['-i', process.env.JOXY_TUN_SSH_KEY, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${process.env.JOXY_TUN_KNOWN_HOSTS}`, `root@${selected.address}`, 'python3', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('UDP echo setup timed out')), 15000);
      echo.once('error', (e) => { clearTimeout(timer); reject(e); });
      echo.once('exit', () => { clearTimeout(timer); reject(new Error('UDP echo setup failed')); });
      echo.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    });
    echo.stdin.end(`import socket,time\ns=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)\ns.bind(('${selected.address}',${port}))\ns.settimeout(180)\nprint('ready',flush=True)\ntry:\n data,addr=s.recvfrom(256)\n if data==b'${nonce}': s.sendto(data,addr)\nfinally: s.close()\n`);
    await ready;
    report.udp = { host: selected.address, port, nonce }; // removed before the report is written
  }
  await controller.connect();
  assert.equal(controller.connection.mode, 'tun'); assert.equal(controller.connection.systemProxy, false);
  const https = await nativeRequest('https://www.gstatic.com/generate_204', 12000);
  assert.equal(https.status, 204);
  const exit = JSON.parse((await nativeRequest('https://api.ipify.org?format=json', 12000)).body).ip;
  assert.equal(exit, selected.address);
  report.checks.push('native HTTPS without proxy agent exits through the configured VPS');
  const question = Buffer.concat([Buffer.from('123401000001000000000000','hex'), Buffer.from([7]), Buffer.from('example'), Buffer.from([3]), Buffer.from('com'), Buffer.from('0000010001','hex')]);
  await udpRoundtrip('172.31.255.2', 53, question, (data) => { assert.equal(data.readUInt16BE(0), 0x1234); assert.equal(data[3] & 15, 0); assert.ok(data.readUInt16BE(6) > 0); });
  await ps(`$result=@(Resolve-DnsName example.com -Type A -DnsOnly -ErrorAction Stop | Where-Object IPAddress); @{resolved=($result.Count -gt 0)} | ConvertTo-Json -Compress`).then((r) => assert.equal(r.resolved, true));
  report.checks.push('virtual UDP DNS and Windows system resolver work through TUN');
  if (report.udp) { const { host, port, nonce } = report.udp; await udpRoundtrip(host, port, Buffer.from(nonce), (data) => assert.equal(data.toString(), nonce)); report.checks.push('arbitrary UDP nonce echo through VLESS to the VPS'); }
  assert.equal((await instance.proxy.run('status')).ProxyEnable.value, 0);
  await controller.updateSettings({ dnsProvider: 'google', tunMtu: 1280 });
  assert.equal(controller.connection.phase, 'connected');
  report.checks.push('connected settings change reconnects with Google DoH and MTU 1280');
  await controller.disconnect();
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await instance.proxy.run('status'), proxyBefore);
  report.checks.push('normal disconnect leaves routes, physical DNS, WeakHostSend and proxy exactly as before');
  await controller.close(); controller = null;
  const childDir = path.join(temporary, 'watchdog'); const readyFile = path.join(temporary, 'child-ready.json');
  child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--watchdog-child'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, JOXY_TUN_CHILD_DATA: childDir, JOXY_TUN_CHILD_READY: readyFile } });
  await until(async () => { if (child.exitCode !== null) throw new Error('Watchdog child exited before connecting'); return exists(readyFile); });
  const { core } = JSON.parse(await readFile(readyFile, 'utf8'));
  child.kill('SIGKILL'); await until(async () => { try { process.kill(core, 0); return false; } catch { return true; } });
  await until(async () => !(await exists(path.join(childDir, 'proxy-recovery.json'))));
  // The journal stays for the next start, which clears it without PowerShell when weak host send was untouched.
  assert.equal((await new TunGuard(path.join(root, 'resources/windows-tun.ps1'), childDir).recover())?.restored, true);
  assert.equal(await exists(path.join(childDir, 'tun-session.json')), false);
  assert.deepEqual(await snapshot(), before); assert.deepEqual(await instance.proxy.run('status'), proxyBefore);
  report.checks.push('abrupt parent termination: the watcher stops the orphaned core; routes, DNS and proxy return');
  report.ok = true;
} catch (e) {
  report.error = redact(e.message);
  if (controller) report.logs = controller.logs.map((l) => ({ level: l.level, message: l.message }));
  process.exitCode = 1;
} finally {
  if (controller) await controller.close().catch((e) => { report.cleanupError = redact(e.message); report.ok = false; });
  if (child && child.exitCode === null) child.kill();
  echo?.kill(); delete report.udp;
  if (temporary) await rm(path.join(temporary, 'config-check.json'), { force: true });
  if (temporary && report.ok) await rm(temporary, { recursive: true, force: true });
  report.finished = new Date().toISOString();
  if (output && !process.argv.includes('--watchdog-child')) await writeFile(output, JSON.stringify(report, null, 2));
  if (!process.argv.includes('--watchdog-child')) console.log(JSON.stringify(report));
}
