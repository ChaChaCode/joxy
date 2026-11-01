import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { EncryptedStore } from '../electron/store.mjs';

const key = randomBytes(32);
const crypto = {
  encrypt: async (value) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); const encrypted = Buffer.concat([c.update(value), c.final()]); return Buffer.concat([iv, c.getAuthTag(), encrypted]); },
  decrypt: async (buffer) => { const c = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12)); c.setAuthTag(buffer.subarray(12, 28)); return Buffer.concat([c.update(buffer.subarray(28)), c.final()]).toString(); },
};
test('credentials stay encrypted and concurrent saves retain the last complete state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zagran-store-test-'));
  try {
    const s = new EncryptedStore(dir, crypto); await s.load();
    s.data.sources.push({ id: '1', url: 'https://example.com/secret-subscription' });
    const writes = [];
    for (let i = 0; i < 5; i++) { s.data.selectedId = String(i); writes.push(s.save()); }
    await Promise.all(writes);
    assert.ok(!(await readFile(s.file)).includes(Buffer.from('secret-subscription')));
    const reloaded = new EncryptedStore(dir, crypto); await reloaded.load();
    assert.equal(reloaded.data.selectedId, '4'); assert.equal(reloaded.data.sources[0].url, s.data.sources[0].url);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('damaged encrypted settings are not silently reset or overwritten', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zagran-store-test-'));
  try {
    const s = new EncryptedStore(dir, crypto); const damaged = Buffer.from('damaged-secret');
    await writeFile(s.file, damaged);
    await assert.rejects(() => s.load(), /Исходный файл сохранён/);
    assert.deepEqual(await readFile(s.file), damaged);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
