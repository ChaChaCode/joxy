// Builds resources/geo/ip-country.bin from DB-IP's IP to Country Lite (CC BY 4.0, https://db-ip.com), so JOXY can tell
// the country of the exit IP on the user's own computer. Only IPv4: the exit IP JOXY sees is IPv4.
// File: "JXIP" 1, count (u32), country count (u8), the codes (2 bytes each), then count range starts (u32, ascending)
// and count country indexes (u8); index 0 means unknown. Neighbouring ranges of one country are merged.
// Usage: node scripts/build-ip-country.mjs <dbip-country-lite-YYYY-MM.csv.gz>
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const ipv4 = (text) => text.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const lines = gunzipSync(await readFile(process.argv[2])).toString('utf8').split('\n');
const codes = ['--'], index = new Map([['--', 0]]);
const starts = [], countries = [];
let end = -1;
for (const line of lines) {
  const [from, to, code] = line.split(',');
  if (!code || from.includes(':')) continue;
  const a = ipv4(from), b = ipv4(to), c = /^[A-Z]{2}$/.test(code) && code !== 'ZZ' ? code : '--';
  if (!index.has(c)) { index.set(c, codes.length); codes.push(c); }
  const i = index.get(c);
  // A gap between ranges is unknown space.
  if (a > end + 1 && countries.at(-1) !== 0) { starts.push(end + 1); countries.push(0); }
  if (countries.at(-1) !== i) { starts.push(a); countries.push(i); }
  end = b;
}
if (codes.length > 256) throw new Error('More than 256 country codes.');
const out = Buffer.alloc(4 + 1 + 4 + 1 + codes.length * 2 + starts.length * 5);
let o = out.write('JXIP', 0, 'ascii'); o = out.writeUInt8(1, o); o = out.writeUInt32LE(starts.length, o); o = out.writeUInt8(codes.length - 1, o);
for (const c of codes) o += out.write(c, o, 'ascii');
for (const s of starts) o = out.writeUInt32LE(s, o);
for (const c of countries) o = out.writeUInt8(c, o);
await mkdir(new URL('../resources/geo/', import.meta.url), { recursive: true });
await writeFile(new URL('../resources/geo/ip-country.bin', import.meta.url), out);
console.log(`${starts.length} ranges, ${codes.length - 1} countries, ${(out.length / 1024).toFixed(0)} KB`);
