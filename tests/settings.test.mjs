import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, normalizeSettings, settingsPatch, parseDirectRules } from '../electron/settings.mjs';
import { buildConfig, parseVless } from '../electron/profiles.mjs';

test('legacy settings migrate while mode stays authoritative over the old proxy switch', () => {
  assert.equal(normalizeSettings({ systemProxy: false }).mode, 'local');
  assert.equal(normalizeSettings({ systemProxy: true }).mode, 'system');
  assert.equal(normalizeSettings({ mode: 'tun', systemProxy: true }).systemProxy, false);
  assert.equal(settingsPatch(defaultSettings(), { systemProxy: false }).mode, 'local');
  for (const patch of [{ mode: 'bad' }, { tunMtu: 1 }, { tunMtu: 1400.1 }, { tunIpv6: 'ignore' }, { dnsProvider: 'plain' }, { bypassLan: 1 }, { interface: 'missing' }, { directRules: ['https://example.com'] }]) assert.throws(() => settingsPatch(defaultSettings(), patch, ['Ethernet']));
  assert.equal(settingsPatch(defaultSettings(), { interface: 'Ethernet' }, ['Ethernet']).interface, 'Ethernet');
});

test('routing rules accept domains and IPv4/IPv6 CIDRs without accepting URLs or malformed masks', () => {
  assert.deepEqual(parseDirectRules(['*.Example.COM', 'example.com', '192.0.2.10', '2001:db8::/32']).normalized, ['example.com', '192.0.2.10/32', '2001:db8::/32']);
  for (const value of [['192.0.2.0/33'], ['2001:db8::/129'], ['192.0.2.0/'], ['192.0.2.0/0x10'], ['192.0.2.0/1/2'], ['example.com:443'], ['all'], Array(129).fill('example.com')]) assert.throws(() => parseDirectRules(value));
});

test('TUN config routes DNS first and binds core sockets', () => {
  const profile = parseVless('vless://00000000-0000-4000-8000-000000000000@192.0.2.10:443?security=tls&sni=example.com&type=tcp#test');
  const config = buildConfig(profile, { http: 31001, socks: 31002, metrics: 31003 }, 'Ethernet', { mode: 'tun', directRules: ['example.com', '203.0.113.0/24'] });
  const tun = config.inbounds.find((i) => i.protocol === 'tun');
  assert.deepEqual(tun.settings.autoSystemRoutingTable, ['0.0.0.0/1', '128.0.0.0/1']);
  assert.equal(tun.settings.autoOutboundsInterface, 'Ethernet');
  assert.ok(config.inbounds.filter((i) => i.protocol !== 'tun').every((i) => i.listen === '127.0.0.1'));
  assert.equal(config.routing.rules[0].outboundTag, 'dns-out');
  assert.equal(config.routing.rules[0].port, '53');
  assert.equal(config.dns.servers[0], 'https://1.1.1.1/dns-query');
  assert.ok(config.routing.rules.some((r) => r.domain?.includes('domain:example.com')));
  assert.ok(config.routing.rules.some((r) => r.ip?.includes('203.0.113.0/24')));
  assert.ok(config.outbounds.filter((o) => o.protocol !== 'dns').every((o) => o.streamSettings.sockopt.interface === 'Ethernet'));
  const dual = buildConfig(profile, { http: 31001, socks: 31002 }, 'Ethernet', { mode: 'tun', tunIpv6: 'tunnel', dnsProvider: 'google', tunDnsProtection: false });
  assert.equal(dual.inbounds.at(-1).settings.autoSystemRoutingTable.length, 4);
  assert.equal(dual.dns.servers[0], 'https://8.8.8.8/dns-query');
  assert.equal(dual.dns.queryStrategy, 'UseIP');
  assert.equal(profile.outbound.streamSettings.sockopt, undefined);
});

test('theme and auto-connect are validated application settings', async () => {
  const { settingsPatch, defaultSettings, networkKeys } = await import('../electron/settings.mjs');
  const next = settingsPatch(defaultSettings(), { theme: 'dark', autoConnect: true });
  assert.equal(next.theme, 'dark'); assert.equal(next.autoConnect, true);
  assert.throws(() => settingsPatch(defaultSettings(), { theme: 'neon' }), /тема/);
  assert.throws(() => settingsPatch(defaultSettings(), { autoConnect: 'yes' }), /переключатель/);
  assert.ok(!networkKeys.includes('theme') && !networkKeys.includes('autoConnect'), 'Neither needs a reconnect');
});

test('elevation is read from the integrity level of the token', async () => {
  const { elevatedFromGroups } = await import('../electron/elevation.mjs');
  assert.equal(elevatedFromGroups('Mandatory Label\High Mandatory Level   Label   S-1-16-12288'), true);
  assert.equal(elevatedFromGroups('Mandatory Label\Medium Mandatory Level Label   S-1-16-8192'), false);
  assert.equal(elevatedFromGroups(''), false);
});

test('Russian domains go direct only with the switch on, ahead of the user rules', () => {
  const profile = parseVless('vless://00000000-0000-4000-8000-000000000000@192.0.2.10:443?security=tls&sni=example.com&type=tcp#test');
  const rules = (settings) => buildConfig(profile, { http: 31001, socks: 31002 }, '', settings).routing?.rules || [];
  const ru = (r) => r.domain?.includes('domain:ru');
  for (const mode of ['tun', 'system']) {
    assert.ok(!rules({ mode }).some(ru), `${mode}: off by default`);
    const on = rules({ mode, bypassRu: true, directRules: ['example.org'] });
    const rule = on.find(ru);
    assert.deepEqual(rule.domain, ['domain:ru', 'domain:su', 'domain:xn--p1ai', 'domain:xn--80adxhks']);
    assert.equal(rule.outboundTag, 'direct');
  }
  assert.equal(settingsPatch({}, { bypassRu: true }).bypassRu, true);
  assert.throws(() => settingsPatch({}, { bypassRu: 'yes' }), /переключатель/);
});
