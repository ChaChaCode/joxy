import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IpCountry } from '../electron/geoip.mjs';

// A table in the bundled format: 0.0.0.0 unknown, 192.0.2.0 NL, 192.0.3.0 unknown, 198.51.100.0 US.
function table() {
  const codes = ['--', 'NL', 'US'], starts = [0, 0xc0000200, 0xc0000300, 0xc6336400], idx = [0, 1, 0, 2];
  const b = Buffer.alloc(10 + codes.length * 2 + starts.length * 5);
  let o = b.write('JXIP', 0, 'ascii'); o = b.writeUInt8(1, o); o = b.writeUInt32LE(starts.length, o); o = b.writeUInt8(codes.length - 1, o);
  for (const c of codes) o += b.write(c, o, 'ascii');
  for (const s of starts) o = b.writeUInt32LE(s, o);
  for (const i of idx) o = b.writeUInt8(i, o);
  return b;
}

test('the country of an IPv4 address is found in the table, unknown space and other input give none', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'joxy-geo-'));
  try {
    const file = path.join(dir, 'ip-country.bin');
    await writeFile(file, table());
    const g = new IpCountry(file);
    assert.equal(await g.lookup('192.0.2.77'), 'NL');
    assert.equal(await g.lookup('192.0.3.1'), null);
    assert.equal(await g.lookup('203.0.113.5'), 'US');
    for (const none of ['10.0.0.1', '2001:db8::1', 'example.com', '']) assert.equal(await g.lookup(none), null, none);
    await writeFile(file, Buffer.from('nope'));
    await assert.rejects(new IpCountry(file).lookup('192.0.2.1'), /формат/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
