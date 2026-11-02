import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Updater, expectedSum, newer, parseRelease } from '../electron/updates.mjs';

const download = 'https://github.com/ChaChaCode/joxy/releases/download/v0.7.0/';
const body = Buffer.from('new portable build');
const sha = createHash('sha256').update(body).digest('hex');
const release = (overrides = {}) => ({ tag_name: 'v0.7.0', assets: [
  { name: 'JOXY-0.7.0-Windows-x64.exe', size: body.length, browser_download_url: `${download}JOXY-0.7.0-Windows-x64.exe` },
  { name: 'SHA256SUMS.txt', size: 100, browser_download_url: `${download}SHA256SUMS.txt` },
], ...overrides });

function fakeGitHub({ latest = release(), sums = `${sha}  JOXY-0.7.0-Windows-x64.exe\n`, exe = body, status = 200 } = {}) {
  const requests = [];
  const fetcher = async (url) => {
    requests.push(url);
    const ok = status === 200;
    const reply = (value) => ({ ok, status, url, json: async () => value, text: async () => value, body: (async function* () { yield value.subarray(0, 5); yield value.subarray(5); })() });
    if (url.endsWith('/releases/latest')) return reply(latest);
    if (url.endsWith('SHA256SUMS.txt')) return reply(sums);
    return reply(exe);
  };
  return { fetcher, requests };
}

test('versions compare by number, not by text', () => {
  assert.equal(newer('0.6.10', '0.6.9'), true);
  assert.equal(newer('0.6.9', '0.6.10'), false);
  assert.equal(newer('1.0.0', '0.99.99'), true);
  assert.equal(newer('0.6.23', '0.6.23'), false);
});

test('a release is taken only with its own portable build and sums from this repository', () => {
  const r = parseRelease(release());
  assert.equal(r.version, '0.7.0'); assert.equal(r.exe.name, 'JOXY-0.7.0-Windows-x64.exe'); assert.ok(r.sums);
  assert.equal(r.page, 'https://github.com/ChaChaCode/joxy/releases/tag/v0.7.0');
  const foreign = parseRelease(release({ assets: release().assets.map((a) => ({ ...a, browser_download_url: a.browser_download_url.replace('ChaChaCode/joxy', 'someone/else') })) }));
  assert.equal(foreign.exe, null); assert.equal(foreign.sums, null);
  assert.equal(parseRelease(release({ assets: [{ ...release().assets[0], name: 'JOXY-0.6.0-Windows-x64.exe' }] })).exe, null, 'The build must be of the tagged version');
  assert.throws(() => parseRelease({ tag_name: 'latest' }), /без номера версии/);
});

test('the expected sum is read for the exact file name', () => {
  assert.equal(expectedSum(`${sha}  JOXY-0.7.0-Windows-x64.exe\n`, 'JOXY-0.7.0-Windows-x64.exe'), sha);
  assert.equal(expectedSum(`${sha} *JOXY-0.7.0-Windows-x64.exe`, 'JOXY-0.7.0-Windows-x64.exe'), sha);
  assert.equal(expectedSum(`${sha}  JOXY-0.7.0-Windows-x64.exe.bak`, 'JOXY-0.7.0-Windows-x64.exe'), null);
});

test('a check reports a newer release, the latest one, and only shows failures it was asked for', async () => {
  const updater = new Updater({ version: '0.6.23', fetcher: fakeGitHub().fetcher });
  assert.equal((await updater.check()).status, 'available'); assert.equal(updater.state.version, '0.7.0');
  const current = new Updater({ version: '0.7.0', fetcher: fakeGitHub().fetcher });
  assert.equal((await current.check()).status, 'latest');
  const offline = new Updater({ version: '0.6.23', fetcher: fakeGitHub({ status: 503 }).fetcher });
  assert.equal((await offline.check()).status, 'idle', 'An automatic check fails quietly');
  const manual = await offline.check({ manual: true });
  assert.equal(manual.status, 'error'); assert.match(manual.error, /GitHub ответил 503/);
});

test('the download is kept only when its SHA256 matches the published sum', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'joxy-update-'));
  try {
    const good = new Updater({ version: '0.6.23', fetcher: fakeGitHub().fetcher });
    await good.check();
    const file = await good.download(dir);
    assert.equal(path.basename(file), 'JOXY-0.7.0-Windows-x64.exe');
    assert.deepEqual(await readFile(file), body); assert.equal(good.state.status, 'ready');

    const bad = new Updater({ version: '0.6.23', fetcher: fakeGitHub({ exe: Buffer.from('tampered build!!!!') }).fetcher });
    await bad.check();
    await rm(file);
    await assert.rejects(bad.download(dir), /Контрольная сумма обновления не совпала/);
    assert.deepEqual(await readdir(dir), [], 'Nothing is left behind, not even the .part file');
    assert.equal(bad.state.status, 'available'); assert.match(bad.state.error, /не совпала/);

    const unsummed = new Updater({ version: '0.6.23', fetcher: fakeGitHub({ sums: 'nothing here' }).fetcher });
    await unsummed.check();
    await assert.rejects(unsummed.download(dir), /нет контрольной суммы/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
