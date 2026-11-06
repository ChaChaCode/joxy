import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscription, parseVless, normalizeOutbound, buildConfig, publicProfile } from '../electron/profiles.mjs';
import { redact } from '../electron/controller.mjs';

const uuid = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
const key = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const fm = { tcp: [{ type: 'fragment', settings: { packets: 'tlshello', length: '10-20', delay: '1-3' } }] };
const link = (extra = '') => `vless://${uuid}@192.0.2.10:443?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision&sni=example.com&pbk=${key}&sid=abcdef12&fp=chrome${extra}#Test%20Vision`;

test('subscription refresh preserves Vision flow, REALITY credentials and finalmask', () => {
  const text = Buffer.from(link('&fm=' + encodeURIComponent(JSON.stringify(fm)))).toString('base64');
  const { profiles, rejected } = parseSubscription(text);
  assert.deepEqual(rejected, []);
  const p = profiles[0];
  assert.equal(p.name, 'Test Vision'); assert.equal(p.transport, 'raw');
  assert.equal(p.outbound.settings.vnext[0].users[0].id, uuid);
  assert.equal(p.outbound.streamSettings.realitySettings.password, key);
  assert.deepEqual(p.outbound.streamSettings.finalmask, fm);
  assert.equal(p.fragment, true);
});
test('legacy fragment interval is migrated to current delay field', () => {
  const old = structuredClone(fm); old.tcp[0].settings.interval = '1-3'; delete old.tcp[0].settings.delay;
  assert.deepEqual(parseVless(link('&fm=' + encodeURIComponent(JSON.stringify(old)))).outbound.streamSettings.finalmask, fm);
});
test('bad profiles report errors while valid profiles survive; duplicates merge', () => {
  const r = parseSubscription([link(), link(), 'vless://bad@host:443?security=none#Broken'].join('\n'));
  assert.equal(r.profiles.length, 1); assert.equal(r.rejected.length, 1);
});
test('gRPC retains serviceName and does not silently accept Vision flow', () => {
  const good = link().replace('type=tcp&flow=xtls-rprx-vision', 'type=grpc&serviceName=events');
  assert.equal(parseVless(good).outbound.streamSettings.grpcSettings.serviceName, 'events');
  assert.throws(() => parseVless(good.replace('type=grpc', 'type=grpc&flow=xtls-rprx-vision')), /Vision/);
});
test('native json links and full Xray configs import the same outbound', () => {
  const p = parseVless(link());
  const full = JSON.stringify({ remarks: 'Full', inbounds: [{ listen: '0.0.0.0', port: 1000 }], outbounds: [p.outbound] });
  assert.equal(parseSubscription(full).profiles[0].id, p.id);
  const native = { protocol: 'vless', settings: { address: p.address, port: p.port, id: uuid, flow: p.flow }, streamSettings: p.outbound.streamSettings };
  const json = 'json://#' + Buffer.from(JSON.stringify(native)).toString('base64url');
  assert.equal(parseSubscription(json).profiles[0].id, p.id);
});
test('reject malformed finalmask, invalid server, unsupported transport and invalid key', () => {
  const zero = structuredClone(fm); zero.tcp[0].settings.length = '0';
  assert.throws(() => parseVless(link('&fm=' + encodeURIComponent(JSON.stringify(zero)))), /фрагментации/);
  assert.throws(() => parseVless(link().replace('192.0.2.10', 'evil%20host')), /адрес/);
  assert.throws(() => parseVless(link().replace('type=tcp', 'type=quic')), /Транспорт/);
  assert.throws(() => parseVless(link().replace(key, 'short')), /ключ/);
});
test('only application-owned loopback listeners and metrics enter runtime config', () => {
  const p = parseVless(link());
  const config = buildConfig(p, { http: 31001, socks: 31002, metrics: 31003 }, 'Ethernet');
  assert.ok(config.inbounds.every((i) => i.listen === '127.0.0.1'));
  assert.equal(config.metrics.listen, '127.0.0.1:31003');
  assert.equal(config.outbounds[0].streamSettings.sockopt.interface, 'Ethernet');
  assert.equal(p.outbound.streamSettings.sockopt, undefined);
  assert.deepEqual(config.outbounds.map((o) => o.protocol), ['vless', 'freedom']);
  assert.equal(config.outbounds[1].streamSettings.sockopt.interface, 'Ethernet');
});
test('secrets are not exposed in renderer profiles or diagnostic logs', () => {
  const p = parseVless(link());
  assert.ok(!JSON.stringify(publicProfile(p)).includes(uuid));
  assert.ok(!JSON.stringify(publicProfile(p)).includes(key));
  const safe = redact(`${uuid} ${key} https://example.com/private/token ${link()}`);
  assert.ok(!safe.includes(uuid)); assert.ok(!safe.includes(key)); assert.ok(!safe.includes('/private/token'));
});
test('reject disabled TLS verification and excessive input before execution', () => {
  assert.throws(() => parseVless(link().replace('security=reality', 'security=tls&allowInsecure=1')), /сертификата/);
  assert.throws(() => parseSubscription('x'.repeat(2_000_001)), /большая/);
});

test('REALITY links without an SNI, with spiderX or with any Xray fingerprint are accepted', () => {
  const base = 'vless://1b4e28ba-2fa1-41d2-883f-0016d3cca427@192.0.2.20:443?type=tcp&security=reality&pbk=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&sid=ab12&flow=xtls-rprx-vision';
  const [noSni] = parseSubscription(`${base}&fp=chrome&spx=%2F#no-sni`).profiles;
  assert.ok(noSni, 'A link without sni is valid: Xray presents the address');
  const reality = buildConfig(noSni, { http: 1, socks: 2 }).outbounds[0].streamSettings.realitySettings;
  assert.equal(reality.serverName, undefined); assert.equal(reality.spiderX, '/');
  for (const fp of ['qq', '360', 'randomizednoalpn', 'HelloChrome_131']) assert.equal(parseSubscription(`${base}&fp=${fp}#x`).profiles.length, 1, fp);
  assert.throws(() => parseSubscription(`${base}&fp=nonsense#x`), /fingerprint «nonsense» не поддерживается/);
});

test('a TUN config leaves leak filters to joxy-guard: Xray commits its own in one oversized WFP transaction', () => {
  const [p] = parseSubscription('vless://1b4e28ba-2fa1-41d2-883f-0016d3cca427@192.0.2.20:443?type=xhttp&security=reality&sni=example.com&pbk=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&sid=ab12#x').profiles;
  const tun = (on) => buildConfig(p, { http: 1, socks: 2 }, '', { mode: 'tun', tunDnsProtection: on, tunIpv6: 'block', tunMtu: 1400 }).inbounds.find((i) => i.protocol === 'tun').settings;
  for (const on of [true, false]) assert.equal('autoSystemWfpBlockLeak' in tun(on), false);
});

test('a shared link reads back to the same server, for every transport', async () => {
  const { shareLink } = await import('../electron/profiles.mjs');
  const uuid = '1b4e28ba-2fa1-41d2-883f-0016d3cca427', pbk = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  const links = [
    `vless://${uuid}@192.0.2.20:443?type=tcp&security=reality&sni=example.com&pbk=${pbk}&sid=ab12&fp=chrome&flow=xtls-rprx-vision#Amsterdam%20Vision`,
    `vless://${uuid}@example.com:8443?type=xhttp&security=reality&pbk=${pbk}&path=%2Fx&mode=packet-up&host=cdn.example.com#%D0%A4%D1%80%D0%B0%D0%BD%D0%BA%D1%84%D1%83%D1%80%D1%82`,
    `vless://${uuid}@[2001:db8::1]:443?type=grpc&security=tls&sni=example.com&alpn=h2&serviceName=svc&mode=multi#gRPC`,
    `vless://${uuid}@192.0.2.21:443?type=ws&security=tls&sni=example.com&path=%2Fws&host=example.com#WS`,
    `vless://${uuid}@192.0.2.22:443?type=httpupgrade&security=tls&sni=example.com&path=%2Fup&host=example.com#HTTPUpgrade`,
  ];
  for (const link of links) {
    const [p] = parseSubscription(link).profiles;
    assert.ok(p, link);
    const shared = shareLink(p);
    assert.match(shared, /^vless:\/\//);
    const [back] = parseSubscription(shared).profiles;
    assert.equal(back.id, p.id, shared); assert.equal(back.name, p.name);
  }
});

test('XHTTP keeps XMUX from a link or a config, shares it, and rejects what it cannot check', async () => {
  const { shareLink, sanitizeXmux } = await import('../electron/profiles.mjs');
  const xmux = { maxConnections: 3, cMaxReuseTimes: 0, hMaxRequestTimes: '600-900', hMaxReusableSecs: '1800-3000' };
  const link = `vless://1b4e28ba-2fa1-41d2-883f-0016d3cca427@192.0.2.20:443?type=xhttp&security=reality&sni=example.com&pbk=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG&fp=firefox&mode=stream-one&extra=${encodeURIComponent(JSON.stringify({ xmux, noSSEHeader: true }))}#x`;
  const [p] = parseSubscription(link).profiles;
  assert.deepEqual(p.outbound.streamSettings.xhttpSettings.extra, { xmux }, 'Only XMUX is kept from extra');
  assert.equal(p.outbound.streamSettings.realitySettings.fingerprint, 'firefox');
  assert.equal(parseSubscription(shareLink(p)).profiles[0].id, p.id, 'Sharing keeps XMUX');
  const config = { protocol: 'vless', settings: { vnext: [{ address: '192.0.2.20', port: 443, users: [{ id: '1b4e28ba-2fa1-41d2-883f-0016d3cca427' }] }] }, streamSettings: { network: 'xhttp', security: 'reality', realitySettings: { password: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' }, xhttpSettings: { xmux: { maxConcurrency: '16-32' } } } };
  assert.deepEqual(parseSubscription(JSON.stringify(config)).profiles[0].outbound.streamSettings.xhttpSettings.extra, { xmux: { maxConcurrency: '16-32' } });
  for (const bad of [{ evil: 1 }, { maxConnections: -1 }, { maxConnections: '9-2' }, { maxConnections: 'x' }, { maxConnections: 2, maxConcurrency: 4 }]) assert.throws(() => sanitizeXmux(bad), /XMUX/, JSON.stringify(bad));
  assert.throws(() => parseSubscription(link.replace(/extra=[^#]+/, 'extra=%7Bbroken')), /XHTTP extra/);
});
