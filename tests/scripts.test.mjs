import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scriptError, TunGuard } from '../electron/network.mjs';

const exec = promisify(execFile);
const windows = process.platform === 'win32';

const script = new URL('../resources/windows-tun.ps1', import.meta.url);
async function guardFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'joxy-tun-guard-'));
  const runs = [];
  // Like the real script, a restore consumes the journal.
  const seen = [];
  const guard = new TunGuard('windows-tun.ps1', dir, async (args) => {
    runs.push(args[args.indexOf('-Action') + 1]); seen.push(JSON.parse(await readFile(path.join(dir, 'tun-session.json'), 'utf8')));
    await rm(path.join(dir, 'tun-session.json'), { force: true }); return { stdout: '{"restored":true}' };
  });
  const journal = async () => JSON.parse(await readFile(path.join(dir, 'tun-session.json'), 'utf8'));
  return { dir, guard, runs, seen, journal, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('a TUN session is journaled by JOXY, and a clean one is closed without PowerShell', async () => {
  const f = await guardFixture();
  try {
    await f.guard.prepare([]);
    await f.guard.track(2147483000, 'C:\\joxy\\xray.exe');
    assert.deepEqual(await f.journal(), { version: 2, corePid: 2147483000, binary: 'C:\\joxy\\xray.exe', weakHostSend: [] });
    assert.deepEqual(f.runs, [], 'No PowerShell runs for the whole session');
    await f.guard.restore();
    assert.deepEqual(f.runs, [], 'Windows already removed the adapter, routes, DNS and WFP filters');
    assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.cleanup(); }
});

test('weak host send that Xray may have turned off, or a live core, goes through the script', async () => {
  const f = await guardFixture();
  try {
    await f.guard.prepare([{ index: 7, guid: 'g', family: 'IPv4' }]);
    await f.guard.restore();
    assert.deepEqual(f.runs, ['restore']);
    await f.guard.prepare([]); await f.guard.track(process.pid, 'xray.exe');
    await f.guard.restore();
    assert.deepEqual(f.runs, ['restore', 'restore'], 'A core that is still alive must be stopped');
  } finally { await f.cleanup(); }
});

test('a 0.3.x recovery journal keeps only what still matters', async () => {
  const f = await guardFixture();
  try {
    await writeFile(path.join(f.dir, 'tun-recovery.json'), JSON.stringify({ version: 1, adapter: 'JOXY', corePid: 0, physical: [{ index: 3, guid: 'a', family: 'IPv4', weakHostSend: 'Disabled' }] }));
    assert.deepEqual(await f.guard.recover(), { restored: true });
    assert.deepEqual(f.runs, []); assert.deepEqual(await readdir(f.dir), []);
    await writeFile(path.join(f.dir, 'tun-recovery.json'), JSON.stringify({ version: 1, adapter: 'JOXY', corePid: 0, physical: [{ index: 3, guid: 'a', family: 'IPv4', weakHostSend: 'Enabled' }] }));
    await f.guard.recover();
    assert.deepEqual(f.runs, ['restore']);
    assert.deepEqual(f.seen[0].weakHostSend, [{ index: 3, guid: 'a', family: 'IPv4' }]);
    assert.deepEqual(await readdir(f.dir), []);
  } finally { await f.cleanup(); }
});

test('the TUN script runs in Windows PowerShell 5.1', { skip: !windows }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'joxy-tun-script-'));
  const journal = path.join(dir, 'tun-session.json');
  const run = (...args) => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.normalize(decodeURIComponent(script.pathname.replace(/^\/(\w:)/, '$1'))), '-Journal', journal, ...args], { windowsHide: true, timeout: 20000 });
  try {
    assert.equal((await run('-Action', 'restore')).stdout.trim(), '{"restored":false}');
    await writeFile(journal, JSON.stringify({ version: 2, corePid: 0, binary: '', weakHostSend: [] }));
    const { stdout } = await run('-Action', 'restore');
    const elevated = JSON.parse(stdout).restored === true;
    assert.deepEqual(JSON.parse(stdout), elevated ? { restored: true } : { restored: false, requiresElevation: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('script errors show the thrown message, not the command line and paths', () => {
  const stderr = 'C:\\Users\\Someone\\app\\resources\\windows-tun.ps1 : TUN owner changed\r\nстрока:1 знак:1\r\n+ CategoryInfo          : NotSpecified: (:) [windows-tun.ps1], RuntimeException\r\n+ FullyQualifiedErrorId : TUN owner changed';
  const error = scriptError(Object.assign(new Error('Command failed: powershell.exe -File C:\\Users\\Someone\\x.ps1'), { stderr }), 'Не удалось настроить TUN');
  assert.match(error.message, /^Не удалось настроить TUN: TUN owner changed/);
  assert.doesNotMatch(error.message, /Users|CategoryInfo|powershell/);
  assert.match(scriptError({ killed: true, stderr: '' }, 'X').message, /не ответил вовремя/);
});
