import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriptionMetadata, providerUrl } from '../electron/subscription.mjs';
import { Controller } from '../electron/controller.mjs';
import { defaults } from '../electron/store.mjs';

test('subscription headers decode UTF-8 titles, usage and expiry independently', () => {
  const result = subscriptionMetadata(new Headers({
    'profile-title': `base64:${Buffer.from('Мой VPN').toString('base64')}`,
    'subscription-userinfo': 'upload=1024; download=4096; total=10000; expire=1800000000',
    'support-url': 'https://t.me/example', 'profile-web-page-url': 'https://example.com/account',
    announce: 'Service notice',
  }));
  assert.equal(result.title, 'Мой VPN');
  assert.deepEqual(result.usage, { upload: 1024, download: 4096, total: 10000, expire: 1800000000 });
  assert.equal(result.supportUrl, 'https://t.me/example');
  assert.equal(result.announcement, 'Service notice');
});
test('missing, partial and explicit zero subscription values remain distinguishable', () => {
  assert.equal(subscriptionMetadata(new Headers()).usage, null);
  assert.deepEqual(subscriptionMetadata(new Headers({ 'subscription-userinfo': 'expire=1800000000' })).usage, { expire: 1800000000 });
  assert.deepEqual(subscriptionMetadata(new Headers({ 'subscription-userinfo': 'upload=0; download=0; total=0; expire=0' })).usage, { upload: 0, download: 0, total: 0, expire: 0 });
  const partial = subscriptionMetadata(new Headers({ 'subscription-userinfo': 'download=1024', 'support-url': 'https://example.com/help' }));
  assert.deepEqual(partial.usage, { download: 1024 }); assert.ok(partial.supportUrl);
});
test('malformed values are ignored and unsafe provider links cannot be opened', () => {
  const bad = subscriptionMetadata(new Headers({ 'subscription-userinfo': 'upload=-1; download=NaN; expire=999999999999; total=9007199254740992', 'support-url': 'javascript:alert(1)' }));
  assert.equal(bad.usage, null); assert.equal(bad.supportUrl, null);
  for (const url of ['file:///C:/secret', 'https://user:password@example.com', 'http://example.com', 'tg://test', undefined]) assert.equal(providerUrl(url), null);
});
test('comment metadata works in plain and base64 subscriptions; HTTP headers take priority', () => {
  const body = '# profile-title: Local title\n# subscription-userinfo: download=10\nvless://example';
  assert.equal(subscriptionMetadata(new Headers(), Buffer.from(body).toString('base64')).title, 'Local title');
  assert.deepEqual(subscriptionMetadata(new Headers(), body).usage, { download: 10 });
  assert.equal(subscriptionMetadata(new Headers({ 'profile-title': 'HTTP title' }), body).title, 'HTTP title');
});
test('metadata survives encrypted-store serialization and scoped refresh replaces stale quota', async () => {
  const data = defaults();
  let metadata = { title: 'Provider', usage: { upload: 0, download: 100, total: 200, expire: 1800000000 } };
  const url = 'https://example.com/private-token';
  const controller = new Controller({ store: { data, save: async () => {} }, binaryDir: '/unused', runtimeDir: '/unused', proxy: {}, subscriptionFetcher: async () => ({ host: 'example.com', metadata, body: 'vless://aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa@example.com:443?security=tls&type=tcp#Test' }) });
  await controller.importValue(url);
  const id = data.sources[0].id;
  assert.equal(data.sources[0].label, 'Provider');
  assert.equal(JSON.parse(JSON.stringify(data)).sources[0].usage.download, 100);
  assert.equal(controller.snapshot().sources[0].remote, true);
  assert.ok(!JSON.stringify(controller.snapshot()).includes('private-token'));
  metadata = { title: 'Renamed', usage: null };
  await controller.refreshSources(id);
  assert.equal(data.sources[0].id, id); assert.equal(data.sources[0].label, 'Renamed');
  assert.equal(data.sources[0].usage, null);
  await assert.rejects(controller.refreshSources('unknown'), /не найдена/);
});

test('network failures explain themselves instead of "fetch failed"', async () => {
  const { subscriptionNetworkError: explain } = await import('../electron/network.mjs');
  const failed = (code) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
  assert.match(explain(failed('ENOTFOUND'), 'sub.example.com'), /sub\.example\.com не найден: такого домена нет в DNS/);
  assert.match(explain(failed('ECONNRESET'), 'h'), /сброшено.*блокировку/);
  assert.match(explain(failed('UND_ERR_CONNECT_TIMEOUT'), 'h'), /не ответил за 12 секунд/);
  assert.match(explain(Object.assign(new Error('aborted'), { name: 'TimeoutError' }), 'h'), /не ответил/);
  assert.match(explain(failed('CERT_HAS_EXPIRED'), 'h'), /Сертификат/);
  assert.match(explain(failed('EWHATEVER'), 'h'), /Не удалось загрузить подписку с h \(EWHATEVER\)/);
});
test('a domain that does not exist is reported as such by the real fetch', async () => {
  const { fetchSubscription } = await import('../electron/network.mjs');
  await assert.rejects(fetchSubscription('https://joxy-test.invalid/sub'), /joxy-test\.invalid не найден|DNS не ответил/);
});
