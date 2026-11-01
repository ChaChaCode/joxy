const names = new Intl.DisplayNames(['en'], { type: 'region' });
export function countryCode(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{2}$/.test(code) || code === 'ZZ') return null;
  try { return names.of(code) !== code ? code : null; } catch { return null; }
}
export function namedCountry(name) {
  const flag = String(name || '').match(/\p{Regional_Indicator}{2}/u)?.[0];
  return flag ? countryCode([...flag].map((letter) => String.fromCharCode(letter.codePointAt(0) - 0x1f1e6 + 65)).join('')) : null;
}
