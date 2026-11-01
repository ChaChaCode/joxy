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
