import { countryCode } from './country.mjs';
// Common subscription response headers. Provider data is plain text, never markup.
const text = (value, max = 160) => {
  let result = String(value || '').trim().replace(/^"(.*)"$/, '$1');
  if (result.toLowerCase().startsWith('base64:')) {
    const encoded = result.slice(7);
    if (!/^[A-Za-z0-9+/_=-]+$/.test(encoded)) return '';
    result = Buffer.from(encoded, 'base64').toString('utf8');
  }
  return result.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, max);
};
export function providerUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}
export function subscriptionMetadata(headers, body = '') {
  // Some providers put these fields in # comments, including in base64 subscriptions.
  let decoded = body.trim();
  if (/^[A-Za-z0-9+/_=\s-]+$/.test(decoded)) decoded = Buffer.from(decoded.replace(/\s/g, ''), 'base64').toString('utf8');
  const comments = new Map();
  for (const line of decoded.split(/\r?\n/)) {
    const match = line.match(/^\s*#\s*([a-z-]+)\s*:\s*(.*)$/i);
    if (match) comments.set(match[1].toLowerCase(), match[2]);
  }
  const get = (name) => headers?.get(name) ?? comments.get(name) ?? '';
  const usage = {};
  const raw = get('subscription-userinfo').replace(/^"(.*)"$/, '$1');
  for (const field of raw.split(';')) {
    const match = field.trim().match(/^(upload|download|total|expire)\s*=\s*(\d+(?:\.\d+)?)$/i);
    if (!match) continue;
    const number = Number(match[2]);
    if (!Number.isFinite(number) || number < 0 || number > Number.MAX_SAFE_INTEGER) continue;
    const key = match[1].toLowerCase();
    if (key === 'expire' && number > 253402300799) continue;
    usage[key] = Math.floor(number);
  }
  return {
    title: text(get('profile-title')) || null,
    countryCode: countryCode(get('profile-country')),
    usage: Object.keys(usage).length ? usage : null,
    announcement: text(get('announce'), 600) || null,
    supportUrl: providerUrl(get('support-url')),
    websiteUrl: providerUrl(get('profile-web-page-url')),
  };
}
