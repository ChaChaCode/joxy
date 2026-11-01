import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskAddresses } from '../src/privacy.ts';
import { countryCode, namedCountry } from '../electron/country.mjs';
import { subscriptionMetadata } from '../electron/subscription.mjs';

test('privacy masks IPv4, IPv6, domains and ports in names and diagnostic text', () => {
  const known = ['192.0.2.96', '2001:db8::5', 'vpn.example.com'];
  const input = '192.0.2.96:443 [2001:db8::5]:444 VPN.EXAMPLE.COM:8443 DNS 8.8.8.8';
  const result = maskAddresses(input, known);
  for (const secret of ['192.0.2.96', '2001:db8::5', 'example.com', ':443', ':444', ':8443', '8.8.8.8']) assert.ok(!result.toLowerCase().includes(secret));
  assert.equal(maskAddresses(input, known, true), input);
  assert.equal(maskAddresses('Xray 26.10.31 · 29 дней', known), 'Xray 26.10.31 · 29 дней');
});

test('country comes from validated metadata or an existing flag, never from guessed IP geography', () => {
  assert.equal(countryCode('nl'), 'NL');
  assert.equal(countryCode('ZZ'), null);
  assert.equal(countryCode('https://example.com'), null);
  assert.equal(namedCountry('🇳🇱 ZAGRAN'), 'NL');
  assert.equal(namedCountry('ZAGRAN'), null);
  assert.equal(subscriptionMetadata(new Headers({ 'profile-country': 'nl' })).countryCode, 'NL');
});
