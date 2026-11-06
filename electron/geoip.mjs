import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';

// The country of an IPv4 address from the bundled DB-IP Lite table (see scripts/build-ip-country.mjs), looked up on
// this computer: the address goes nowhere. The table loads on first use.
export class IpCountry {
  constructor(file) { this.file = file; this.table = null; }
  async load() {
    if (this.table) return this.table;
    const b = await readFile(this.file);
    if (b.toString('ascii', 0, 4) !== 'JXIP' || b.readUInt8(4) !== 1) throw new Error('Неизвестный формат базы стран.');
    const count = b.readUInt32LE(5), codeCount = b.readUInt8(9) + 1;
    const codes = Array.from({ length: codeCount }, (_, i) => b.toString('ascii', 10 + i * 2, 12 + i * 2));
    const startsAt = 10 + codeCount * 2, indexesAt = startsAt + count * 4;
    if (b.length !== indexesAt + count) throw new Error('База стран повреждена.');
    const starts = new Uint32Array(count);
    for (let i = 0; i < count; i++) starts[i] = b.readUInt32LE(startsAt + i * 4);
    this.table = { codes, starts, indexes: b.subarray(indexesAt) };
    return this.table;
  }
  async lookup(ip) {
    if (isIP(ip) !== 4) return null;
    const { codes, starts, indexes } = await this.load();
    const n = ip.split('.').reduce((v, part) => v * 256 + Number(part), 0);
    let lo = 0, hi = starts.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (starts[mid] <= n) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    const code = found >= 0 ? codes[indexes[found]] : '--';
    return code === '--' ? null : code;
  }
}
