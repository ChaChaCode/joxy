import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isIP } from 'node:net';
import { Resolver } from 'node:dns/promises';
import path from 'node:path';
import { access, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { subscriptionMetadata } from './subscription.mjs';
import { detectForeignTunnels } from './tunnels.mjs';
import { version } from './version.mjs';

const exec = promisify(execFile);
const encoded = (s) => Buffer.from(s, 'utf16le').toString('base64');

// PowerShell failures carry the full command line and a CategoryInfo trailer; keep only the thrown message.
export function scriptError(error, prefix) {
  const text = String(error?.stderr || '').replace(/\r/g, '');
  const message = text.split(/\n\s*\+ /)[0].replace(/^.*?\.ps1\s*:\s*/s, '').replace(/\s+/g, ' ').trim();
  return new Error(`${prefix}: ${message || (error?.killed ? 'скрипт Windows не ответил вовремя.' : 'скрипт Windows завершился с ошибкой.')}`);
}

export async function environment() {
  if (process.platform !== 'win32') return { interface: '', interfaces: [], tunActive: false, windows: false };
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; $adapters=@(Get-NetAdapter -IncludeHidden); $physical=@($adapters | Where-Object {$_.HardwareInterface -and $_.Status -eq 'Up'}); $routes=@(Get-NetRoute -PolicyStore ActiveStore); $selected=$routes | Where-Object {$_.DestinationPrefix -eq '0.0.0.0/0' -and $_.InterfaceIndex -in $physical.ifIndex} | Sort-Object @{Expression={$_.RouteMetric+(Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4).InterfaceMetric}} | Select-Object -First 1; @{interface=$selected.InterfaceAlias; interfaces=@($physical | ForEach-Object Name); adapters=@($adapters | ForEach-Object {@{name=$_.Name;description=$_.InterfaceDescription;status=$_.Status.ToString();index=$_.ifIndex;physical=[bool]$_.HardwareInterface}}); routes=@($routes | ForEach-Object {@{index=$_.InterfaceIndex;prefix=$_.DestinationPrefix}}); weakHostSend=@(foreach($a in $physical){ Get-NetIPInterface -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue | Where-Object {$_.WeakHostSend -eq 'Enabled'} | ForEach-Object {@{index=$a.ifIndex;guid=$a.InterfaceGuid.ToString();family=$_.AddressFamily.ToString()}} }); windows=$true; elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json -Depth 4 -Compress`;
  try {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { windowsHide: true, timeout: 12000, maxBuffer: 2_000_000 });
    const { adapters, routes, ...state } = JSON.parse(stdout.replace(/^\uFEFF/, ''));
    const foreignTunnels = detectForeignTunnels(adapters, routes);
    return { ...state, tunActive: foreignTunnels.length > 0, foreignTunnels };
  } catch { return { interface: '', interfaces: [], tunActive: false, windows: true, detectionFailed: true }; }
}

export class SystemProxy {
  constructor(script, dataDir) { this.script = script; this.journal = path.join(dataDir, 'proxy-recovery.json'); this.watcher = null; }
  async run(action, values = {}) {
    if (process.platform !== 'win32') throw new Error('Системный прокси этой версии доступен только в Windows.');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Action', action, '-Journal', this.journal];
    for (const [key, value] of Object.entries(values)) args.push(`-${key}`, String(value));
    const { stdout } = await exec('powershell.exe', args, { windowsHide: true, timeout: 12000, maxBuffer: 100_000 }).catch((e) => { throw scriptError(e, 'Не удалось изменить прокси Windows'); });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '{}');
  }
  async recover() { try { await access(this.journal); return await this.run('restore'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async enable(port, xrayPid) {
    await this.run('enable', { Port: port, XrayPid: xrayPid });
    this.watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Action', 'watch', '-Journal', this.journal, '-ParentPid', String(process.pid)], { windowsHide: true, detached: true, stdio: 'ignore' });
    this.watcher.on('error', () => {}); this.watcher.unref();
  }
  async suspend(xrayPid) {
    await this.run('suspend', { XrayPid: xrayPid });
    this.watcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Action', 'watch', '-Journal', this.journal, '-ParentPid', String(process.pid)], { windowsHide: true, detached: true, stdio: 'ignore' });
    this.watcher.on('error', () => {}); this.watcher.unref();
  }
  async restore() { return this.recover(); }
}

// Windows removes the Wintun adapter, its routes and DNS, and Xray's dynamic WFP filters with the core process, and
// libuv's job object kills the core together with JOXY (both checked on Windows 11 by hard kills). The journal only
// covers what outlives that: weak host send Xray turned off on a physical interface, and a core JOXY failed to stop.
export class TunGuard {
  constructor(script, dataDir, runner = null) {
    this.script = script; this.journal = path.join(dataDir, 'tun-session.json'); this.legacyJournal = path.join(dataDir, 'tun-recovery.json');
    this.runner = runner || ((args) => exec('powershell.exe', args, { windowsHide: true, timeout: 20000, maxBuffer: 100000 }));
  }
  args(action, values = {}) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Action', action, '-Journal', this.journal];
    for (const [key, value] of Object.entries(values)) args.push(`-${key}`, String(value));
    return args;
  }
  async run(action, values = {}) {
    const { stdout } = await this.runner(this.args(action, values)).catch((e) => { throw scriptError(e, 'Не удалось восстановить TUN'); });
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '{}');
  }
  async read(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async write(record) {
    const temporary = `${this.journal}.next`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 }); await rename(temporary, this.journal);
  }
  async recover() {
    // 0.3.x journals: routes and DNS went away with the adapter, so only their weak host send record is still worth keeping.
    const legacy = await this.read(this.legacyJournal).catch(() => ({}));
    if (legacy) {
      const weakHostSend = (Array.isArray(legacy.physical) ? legacy.physical : []).filter((p) => p.weakHostSend === 'Enabled').map(({ index, guid, family }) => ({ index, guid, family }));
      if (!await this.read(this.journal).catch(() => null)) await this.write({ version: 2, corePid: Number(legacy.corePid) || 0, binary: legacy.binary || '', weakHostSend });
      await rm(this.legacyJournal, { force: true });
    }
    const record = await this.read(this.journal).catch(() => ({ version: 2, corePid: 0, weakHostSend: [] }));
    if (!record) return null;
    if (!record.weakHostSend?.length && !alive(record.corePid)) { await rm(this.journal, { force: true }); return { restored: true }; }
    return this.run('restore');
  }
  async prepare(weakHostSend = []) {
    if (await this.read(this.journal).catch(() => true) || await this.read(this.legacyJournal).catch(() => true)) {
      const recovered = await this.recover();
      if (recovered?.requiresElevation) throw new Error('Для восстановления предыдущей TUN-сессии нужны права администратора.');
    }
    await this.write({ version: 2, corePid: 0, binary: '', weakHostSend });
  }
  async track(pid, binary) {
    await this.write({ ...await this.read(this.journal), corePid: pid, binary });
  }
  async restore() { return this.recover(); }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const certificateErrors = /^(CERT_|ERR_TLS_CERT|UNABLE_TO_VERIFY|DEPTH_ZERO_SELF_SIGNED|SELF_SIGNED_CERT)/;
// fetch reports every network failure as "fetch failed"; the reason is in its cause, and it decides what to tell the user.
export function subscriptionNetworkError(error, host) {
  const code = error?.cause?.code || error?.code || '';
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError' || /TIMEDOUT|TIMEOUT/.test(code)) return `Сервер подписки ${host} не ответил за 12 секунд. Возможно, он недоступен или блокируется: попробуйте после подключения VPN.`;
  if (code === 'ENOTFOUND') return `Сервер подписки ${host} не найден: такого домена нет в DNS. Проверьте ссылку или уточните её у провайдера.`;
  if (code === 'EAI_AGAIN') return `Не удалось узнать адрес ${host}: DNS не ответил. Проверьте подключение к интернету.`;
  if (code === 'ECONNREFUSED') return `Сервер подписки ${host} отклонил соединение.`;
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'EPIPE') return `Соединение с ${host} было сброшено. Похоже на блокировку: попробуйте после подключения VPN.`;
  if (certificateErrors.test(code)) return `Сертификат сервера подписки ${host} не прошёл проверку. JOXY не загружает подписки по непроверенному HTTPS.`;
  return `Не удалось загрузить подписку с ${host}${code ? ` (${code})` : ''}.`;
}

// Windows asks every adapter's DNS after a "no such domain", and DNS protection blocks the physical ones, so fetch
// times out before it learns the domain does not exist. One direct question settles what to report.
async function withDnsAnswer(error, host) {
  const code = error?.cause?.code || error?.code || '';
  if (code === 'ENOTFOUND' || isIP(host)) return error;
  try { await new Resolver({ timeout: 3000, tries: 1 }).resolve4(host); return error; }
  catch (e) { return e.code === 'ENOTFOUND' || e.code === 'ENODATA' ? Object.assign(new Error('not found'), { code: 'ENOTFOUND' }) : error; }
}

export async function fetchSubscription(url) {
  let current;
  try { current = new URL(url); } catch { throw new Error('Не удалось прочитать адрес подписки.'); }
  for (let redirect = 0; redirect < 5; redirect++) {
    if (current.protocol !== 'https:' || current.username || current.password) throw new Error('Подписка должна использовать HTTPS без логина и пароля в адресе.');
    // A definite "no such domain" is known in a tenth of a second; fetch would only report it after its timeout.
    if (!isIP(current.hostname)) await new Resolver({ timeout: 3000, tries: 1 }).resolve4(current.hostname).catch((e) => { if (e.code === 'ENOTFOUND') throw new Error(subscriptionNetworkError(e, current.hostname)); });
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { 'User-Agent': `JOXY/${version}` } })
      .catch(async (e) => { throw new Error(subscriptionNetworkError(await withDnsAnswer(e, current.hostname), current.hostname)); });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.get('location')) throw new Error('Подписка вернула пустое перенаправление.');
      current = new URL(response.headers.get('location'), current); await response.body?.cancel(); continue;
    }
    if (!response.ok) throw new Error(`Подписка вернула HTTP ${response.status}.`);
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 2_000_000) throw new Error('Подписка превышает 2 МБ.');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const body = Buffer.concat(chunks).toString('utf8');
    return { body, host: current.hostname, metadata: subscriptionMetadata(response.headers, body) };
  }
  throw new Error('Слишком много перенаправлений подписки.');
}
