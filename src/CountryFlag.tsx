import { useId } from 'react';

const flags = import.meta.glob<string>('./assets/flags/*.svg', { eager: true, query: '?url', import: 'default' });
const regions = new Intl.DisplayNames(['ru'], { type: 'region' });
export function countryName(code?: string | null): string | null {
  if (!code || !/^[A-Z]{2}$/.test(code)) return null;
  try { const name = regions.of(code); return name && name !== code ? name : null; } catch { return null; }
}

// Tiles share the flag's size, corner and hairline, so a list of flags, auto and unknown servers lines up.
// No country known: a small Earth in colour. Ocean with light from the top left, two stylised land masses clipped to
// the disc, a highlight and a darker rim; it takes a flag's place, without a tile behind it, so rows stay even.
export function GlobeTile({ label = 'Страна не указана' }: { label?: string }) {
  const id = useId().replace(/:/g, '');
  return <span className="country-flag tile tile-globe" role="img" aria-label={label}><svg viewBox="0 0 24 17" aria-hidden="true">
    <defs>
      <radialGradient id={`${id}o`} cx="0.36" cy="0.32" r="0.8"><stop offset="0" stopColor="#5fb4ff" /><stop offset="0.6" stopColor="#2f7ff0" /><stop offset="1" stopColor="#1b4fc4" /></radialGradient>
      <radialGradient id={`${id}l`} cx="0.36" cy="0.32" r="0.85"><stop offset="0" stopColor="#7ee08f" /><stop offset="1" stopColor="#259b4a" /></radialGradient>
      <clipPath id={`${id}c`}><circle cx="12" cy="8.5" r="6.6" /></clipPath>
    </defs>
    {/* Drawn at r 6.6 and scaled past the flag's height: a disc reads smaller than a rectangle of the same height. */}
    <g transform="translate(12 8.5) scale(1.5) translate(-12 -8.5)">
    <circle cx="12" cy="8.5" r="6.6" fill={`url(#${id}o)`} />
    <g clipPath={`url(#${id}c)`} fill={`url(#${id}l)`}>
      <path d="M5.3 3.6c1.4-1 3.4-.9 4.2.4.5.8-.2 1.6.4 2.4.5.7 1.5.9 1.4 1.9-.1.9-1.2 1.2-1.6 2-.4.8.1 1.9-.6 2.5-.9.7-1.7-.4-2-1.4-.4-1.2-1.6-1.6-1.9-2.9-.3-1.3-.9-3.9.1-4.9Z" />
      <path d="M13.7 2.4c1.2-.5 2.8-.3 3.6.6.6.6.2 1.4.9 1.9.8.5 2 .3 2.3 1.3.3.9-.6 1.5-1.1 2.2-.5.8-.2 2-.9 2.7-.8.8-1.9.3-2.5 1.2-.5.7-.4 2-1.3 2.2-1 .2-1.2-1-1.3-2-.1-1.2.7-2.1.2-3.2-.4-1-1.6-1.3-1.5-2.4.1-1 1.1-1.7 1.6-2.5Z" />
    </g>
    <ellipse cx="9.6" cy="5.6" rx="2.6" ry="1.6" fill="#fff" opacity="0.28" transform="rotate(-28 9.6 5.6)" />
    <circle cx="12" cy="8.5" r="6.35" fill="none" stroke="#0b2f7a" strokeOpacity="0.35" strokeWidth="0.5" />
    </g>
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
