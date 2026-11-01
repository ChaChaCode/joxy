import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carriesInternet, detectForeignTunnels } from '../electron/tunnels.mjs';

const adapter = (name, description, index = 21) => ({ name, description, index, status: 'Up', physical: false });
const routes = (...prefixes) => prefixes.map((prefix) => ({ index: 21, prefix }));

test('Windows Teredo, idle adapters and JOXY itself never become a foreign VPN conflict', () => {
  assert.deepEqual(detectForeignTunnels([adapter('Teredo Tunneling Pseudo-Interface', '')], routes('2001::/32', '::/0')), []);
  assert.deepEqual(detectForeignTunnels([adapter('JOXY', 'Wintun')], routes('0.0.0.0/1', '128.0.0.0/1')), []);
  assert.deepEqual(detectForeignTunnels([adapter('throne-tun', 'sing-tun Tunnel')], routes('172.19.0.0/24', '172.19.0.1/32', '224.0.0.0/4', 'fe80::/64', 'ff00::/8')), []);
  assert.deepEqual(detectForeignTunnels([{ ...adapter('tun0', 'Wintun'), status: 'Disconnected' }], routes('0.0.0.0/0')), []);
  assert.deepEqual(detectForeignTunnels([{ ...adapter('tun-office', 'Ethernet'), physical: true }], routes('0.0.0.0/0')), []);
});

test('Throne split routes, ordinary default routes and IPv6-only VPN routes remain conflicts', () => {
  const found = detectForeignTunnels([adapter('throne-tun', 'sing-tun Tunnel')], routes('0.0.0.0/5', '8.0.0.0/7', '128.0.0.0/3', '172.19.0.0/24'));
  assert.deepEqual(found, [{ name: 'throne-tun', routeCount: 3 }]);
  assert.equal(detectForeignTunnels([adapter('wg-office', 'WireGuard Tunnel')], routes('0.0.0.0/0')).length, 1);
  assert.equal(detectForeignTunnels([adapter('utun10', 'Wintun')], routes('2000::/3')).length, 1);
  assert.equal(detectForeignTunnels([adapter('utun10', 'Wintun')], routes('::/1', '8000::/1')).length, 1);
});

test('only routes carrying public traffic count as internet capture', () => {
  for (const prefix of ['0.0.0.0/0', '0.0.0.0/5', '8.8.8.8/32', '::/0', '2001:4860::/32']) assert.equal(carriesInternet(prefix), true, prefix);
  for (const prefix of ['0.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '198.18.0.0/15', '224.0.0.0/4', '::1/128', 'fe80::/64', 'fd00::/8', 'ff00::/8', 'garbage', '8.8.8.8/33']) assert.equal(carriesInternet(prefix), false, prefix);
});
