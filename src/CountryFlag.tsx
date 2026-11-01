import { Globe2 } from './icons';

const flags = import.meta.glob<string>('./assets/flags/*.svg', { eager: true, query: '?url', import: 'default' });
const regions = new Intl.DisplayNames(['ru'], { type: 'region' });
export function countryName(code?: string | null): string | null {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  try { const name = regions.of(code); return name && name !== code ? name : null; } catch { return null; }
}
export function CountryFlag({ code }: { code?: string | null }) {
  const name = countryName(code);
  const source = code && /^[A-Z]{2}$/.test(code) ? flags[`./assets/flags/${code.toLowerCase()}.svg`] : undefined;
  return source && name ? <img className="country-flag" src={source} alt={`Флаг: ${name}`} draggable={false} /> : <Globe2 size={19} />;
}
