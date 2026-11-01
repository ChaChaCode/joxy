import { isIP } from 'node:net';

// Built-in transition adapters are part of Windows, not another VPN client.
const windowsTransition = /teredo|6to4|isatap|ip-https/i;
const tunnelDescription = /wintun|sing-tun|wireguard|tap-windows|amnezia|openvpn/i;
const tunnelName = /(?:^|[-_\s])(?:tun\d*|utun\d*|tap\d*|throne|wireguard|amnezia|clash|mihomo|hiddify)(?:$|[-_\s])/i;
const v4 = (text) => text.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const privateRanges = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 3],
].map(([ip, bits]) => [v4(ip), v4(ip) + 2 ** (32 - bits) - 1]);

export function carriesInternet(prefix) {
  if (typeof prefix !== 'string') return false;
  const [ip, mask, extra] = prefix.split('/');
  const family = isIP(ip), bits = Number(mask);
  if (!family || extra !== undefined || !/^\d+$/.test(mask || '') || bits < 0 || bits > (family === 4 ? 32 : 128)) return false;
  if (family === 4) {
    const size = 2 ** (32 - bits), start = Math.floor(v4(ip) / size) * size, end = start + size - 1;
    return !privateRanges.some(([lo, hi]) => start >= lo && end <= hi);
  }
  // The currently allocated IPv6 global unicast range is 2000::/3.
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return bits <= 3 ? (first >> (16 - bits)) === (0x2000 >> (16 - bits)) : (first & 0xe000) === 0x2000;
}

export function detectForeignTunnels(adapters = [], routes = []) {
  return adapters.filter((a) => a.status === 'Up' && a.name !== 'JOXY' && !a.physical &&
    !windowsTransition.test(`${a.name} ${a.description}`) &&
    (tunnelDescription.test(a.description || '') || tunnelName.test(a.name || '')))
    .map((a) => ({ name: a.name, routeCount: routes.filter((r) => r.index === a.index && carriesInternet(r.prefix)).length }))
    .filter((a) => a.routeCount > 0);
}
