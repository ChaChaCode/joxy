const flags = import.meta.glob<string>('./assets/flags/*.svg', { eager: true, query: '?url', import: 'default' });
const regions = new Intl.DisplayNames(['ru'], { type: 'region' });
export function countryName(code?: string | null): string | null {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  try { const name = regions.of(code); return name && name !== code ? name : null; } catch { return null; }
}

// Tiles share the flag's size, corner and hairline, so a list of flags, auto and unknown servers lines up.
// No country known: a plain line globe, legible at flag size where a dotted one reads as a grille.
export function GlobeTile({ label = 'Страна не указана' }: { label?: string }) {
  return <span className="country-flag tile tile-globe" role="img" aria-label={label}><svg viewBox="0 0 24 17" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="0.95">
    <circle cx="12" cy="8.5" r="5.6" />
    <ellipse cx="12" cy="8.5" rx="2.4" ry="5.6" />
    <path d="M6.4 8.5h11.2M7.3 5.6h9.4M7.3 11.4h9.4" />
  </svg></span>;
}
// Auto selection: two sparkles on ink, "the best one is picked for you".
export function AutoTile() {
  return <span className="country-flag tile tile-auto" role="img" aria-label="Автовыбор"><svg viewBox="0 0 24 17" aria-hidden="true">
    <path d="M10.5 3.2c.35 2.45 1.55 3.7 4 4.05-2.45.35-3.65 1.6-4 4.05-.35-2.45-1.55-3.7-4-4.05 2.45-.35 3.65-1.6 4-4.05Z" />
    <path d="M16.2 9.6c.18 1.2.78 1.8 1.95 1.98-1.17.18-1.77.78-1.95 1.97-.18-1.2-.78-1.8-1.95-1.97 1.17-.18 1.77-.78 1.95-1.98Z" />
  </svg></span>;
}
export function CountryFlag({ code }: { code?: string | null }) {
  const name = countryName(code);
  const source = code && /^[A-Z]{2}$/.test(code) ? flags[`./assets/flags/${code.toLowerCase()}.svg`] : undefined;
  return source && name ? <img className="country-flag" src={source} alt={`Флаг: ${name}`} draggable={false} /> : <GlobeTile />;
}
