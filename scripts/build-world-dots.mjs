// Builds src/assets/world-dots.json: a dot grid over land with the country of every dot, in the Equal Earth projection
// (Šavrič, Patterson, Jenny 2018): every country at its true relative area. Antarctica is left out, as on most world
// maps, and the grid ends just below the southernmost land, so the map does not scroll into an empty band.
// The grid is even in the projected plane, so dots are spaced alike everywhere; a dot is land when the point its centre
// projects back to lies in a country.
// It also places every time zone at its principal city, from the IANA tz database (public domain): the map shows the
// user where they are from Windows' time zone alone, with no location service and nothing sent anywhere.
// Input: Natural Earth 1:50m Admin 0 countries GeoJSON (public domain), e.g.
// https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson
// and a folder with zone1970.tab, zone.tab and backward from https://data.iana.org/time-zones/data/
// Usage: node scripts/build-world-dots.mjs <countries.geojson> <tz folder>
import { readFile, writeFile } from 'node:fs/promises';

const COLS = 260;
const A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796, M = Math.sqrt(3) / 2;
const poly = (t) => A1 + A2 * t * t + t ** 6 * (A3 + A4 * t * t);
const slope = (t) => A1 + 3 * A2 * t * t + t ** 6 * (7 * A3 + 9 * A4 * t * t);
export function project(lon, lat) {
  const t = Math.asin(M * Math.sin(lat * Math.PI / 180));
  return [(lon * Math.PI / 180) * Math.cos(t) / (M * slope(t)), t * poly(t)];
}
// Newton's method on y = t·poly(t), then λ from x; null outside the projection's outline.
function unproject(x, y) {
  let t = y / A1;
  for (let i = 0; i < 12; i++) { const d = (t * poly(t) - y) / slope(t); t -= d; if (Math.abs(d) < 1e-12) break; }
  if (Math.abs(t) > Math.PI / 3) return null;
  const lon = M * x * slope(t) / Math.cos(t) * 180 / Math.PI;
  if (Math.abs(lon) > 180) return null;
  return [lon, Math.asin(Math.sin(t) / M) * 180 / Math.PI];
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (lon, lat, rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((hole) => inRing(lon, lat, hole));

if (process.argv[2]) {
  const source = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const countries = [];
  for (const f of source.features) {
    const p = f.properties;
    const iso = [p.ISO_A2_EH, p.ISO_A2, p.WB_A2].find((c) => /^[A-Z]{2}$/.test(c || ''));
    if (!iso || iso === 'AQ') continue;
    const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    let minX = 180, minY = 90, maxX = -180, maxY = -90, area = 0, cx = 0, cy = 0;
    for (const rings of polygons) {
      for (const [x, y] of rings[0]) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      // The label point: area-weighted centroid of the outer rings, so islands do not drag a country's centre away.
      let a = 0, sx = 0, sy = 0; const r = rings[0];
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const k = r[j][0] * r[i][1] - r[i][0] * r[j][1]; a += k; sx += (r[j][0] + r[i][0]) * k; sy += (r[j][1] + r[i][1]) * k; }
      if (Math.abs(a) > 1e-9) { area += Math.abs(a); cx += sx / (3 * a) * Math.abs(a); cy += sy / (3 * a) * Math.abs(a); }
    }
    countries.push({ iso, polygons, bbox: [minX, minY, maxX, maxY], center: area ? [cx / area, cy / area] : [(minX + maxX) / 2, (minY + maxY) / 2] });
  }

  const [xMax] = project(180, 0), [, yMax] = project(0, 90);
  const step = 2 * xMax / COLS, fullRows = Math.ceil(2 * yMax / step);
  const dots = [];
  for (let row = 0; row < fullRows; row++) {
    for (let col = 0; col < COLS; col++) {
      const point = unproject(-xMax + (col + 0.5) * step, yMax - (row + 0.5) * step);
      if (!point) continue;
      const [lon, lat] = point;
      const index = countries.findIndex((c) => lon >= c.bbox[0] && lon <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3] && c.polygons.some((rings) => inPolygon(lon, lat, rings)));
      if (index >= 0) dots.push(col, row, index);
    }
  }
  let rows = 0;
  for (let i = 1; i < dots.length; i += 3) rows = Math.max(rows, dots[i] + 2);
  const toGrid = ([lon, lat]) => { const [x, y] = project(lon, lat); return [+((x + xMax) / step - 0.5).toFixed(2), +((yMax - y) / step - 0.5).toFixed(2)]; };
  // ISO 6709 in zone.tab: ±DDMM[SS]±DDDMM[SS].
  const degrees = (text, width) => {
    const sign = text[0] === '-' ? -1 : 1, d = text.slice(1);
    const [deg, min, sec = '0'] = [d.slice(0, width), d.slice(width, width + 2), d.slice(width + 2) || '0'];
    return sign * (Number(deg) + Number(min) / 60 + Number(sec) / 3600);
  };
  const places = {};
  const tz = process.argv[3];
  if (tz) {
    for (const file of ['zone.tab', 'zone1970.tab']) {
      for (const line of (await readFile(`${tz}/${file}`, 'utf8')).split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const [, coords, zone] = line.split('\t');
        const m = /^([+-]\d+)([+-]\d+)$/.exec(coords);
        if (m) places[zone] = toGrid([degrees(m[2], 3), degrees(m[1], 2)]);
      }
    }
    // Old names Windows may still report, such as Europe/Kiev: "Link <target> <alias>".
    for (const line of (await readFile(`${tz}/backward`, 'utf8')).split('\n')) {
      const [kind, target, alias] = line.split('#')[0].trim().split(/\s+/);
      if (kind === 'Link' && places[target] && alias && !places[alias]) places[alias] = places[target];
    }
  }
  const out = {
    source: 'Natural Earth 1:50m Admin 0 countries v5.1.2, IANA tz database (public domain)', projection: 'Equal Earth', cols: COLS, rows,
    countries: countries.map((c) => ({ iso: c.iso, center: toGrid(c.center) })),
    places,
    dots,
  };
  await writeFile(new URL('../src/assets/world-dots.json', import.meta.url), JSON.stringify(out));
  console.log(`${dots.length / 3} land dots, ${countries.length} countries, ${Object.keys(places).length} time zones, grid ${COLS}x${rows}`);
}
