import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);
const ps = (text) => `'${String(text).replaceAll("'", "''")}'`;
const winArg = (text) => '"' + String(text).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
// The High Mandatory Level SID is present exactly when the process token is elevated.
export const elevatedFromGroups = (text) => /S-1-16-12288|S-1-16-16384/.test(String(text));
export async function isElevated() {
  if (process.platform !== 'win32') return false;
  try { return elevatedFromGroups((await exec('whoami.exe', ['/groups'], { windowsHide: true, timeout: 5000 })).stdout); } catch { return false; }
}
export async function elevate(app, reconnect = false) {
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  const args = [...(!app.isPackaged ? [app.getAppPath()] : []), '--wait-for-parent', String(process.pid), ...(reconnect ? ['--reconnect'] : [])];
  const script = `$ErrorActionPreference='Stop'; Start-Process -FilePath ${ps(exe)} -ArgumentList ${ps(args.map(winArg).join(' '))} -WorkingDirectory ${ps(path.dirname(exe))} -Verb RunAs -WindowStyle Normal | Out-Null`;
  try { await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 120000 }); }
  catch { throw new Error('Windows не подтвердила запуск с правами администратора. Текущее подключение сохранено.'); }
}
export async function waitForPreviousProcess() {
  const index = process.argv.indexOf('--wait-for-parent');
  if (index < 0) return;
  const pid = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Неверный процесс перезапуска.');
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Предыдущий JOXY не завершился.');
}
