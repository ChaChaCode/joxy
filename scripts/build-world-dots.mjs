// Builds src/assets/world-dots.json: a dot grid over land with the country of every dot.
// Input: Natural Earth 1:50m Admin 0 countries GeoJSON (public domain), e.g.
// https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_admin_0_countries.geojson
// Usage: node scripts/build-world-dots.mjs <countries.geojson>
import { readFile, writeFile } from 'node:fs/promises';

const STEP = 1.8, NORTH = 83, SOUTH = -56; // degrees; Antarctica left out, as on most world maps
const source = JSON.parse(await readFile(process.argv[2], 'utf8'));

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (lon, lat, rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((hole) => inRing(lon, lat, hole));

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

const cols = Math.round(360 / STEP), rows = Math.round((NORTH - SOUTH) / STEP);
const dots = [];
for (let row = 0; row < rows; row++) {
  const lat = NORTH - (row + 0.5) * STEP;
  for (let col = 0; col < cols; col++) {
    const lon = -180 + (col + 0.5) * STEP;
    const index = countries.findIndex((c) => lon >= c.bbox[0] && lon <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3] && c.polygons.some((rings) => inPolygon(lon, lat, rings)));
    if (index >= 0) dots.push(col, row, index);
  }
}
const toGrid = ([lon, lat]) => [+((lon + 180) / STEP - 0.5).toFixed(2), +((NORTH - lat) / STEP - 0.5).toFixed(2)];
const out = {
  source: 'Natural Earth 1:50m Admin 0 countries v5.1.2 (public domain)', step: STEP, cols, rows,
  countries: countries.map((c) => ({ iso: c.iso, center: toGrid(c.center), box: [...toGrid([c.bbox[0], c.bbox[3]]), ...toGrid([c.bbox[2], c.bbox[1]])] })),
  dots,
};
await writeFile(new URL('../src/assets/world-dots.json', import.meta.url), JSON.stringify(out));
console.log(`${dots.length / 3} land dots, ${countries.length} countries, grid ${cols}x${rows}`);
