// Screenshots for README.md from a fixture state: invented servers on documentation addresses, never real data, and
// a fixed time zone (Berlin) for the blue "you are here" dot. Usage: node scripts/readme-shots.mjs [output directory]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';

const out = process.argv[2] || 'docs/screenshots';
await mkdir(out, { recursive: true });
const vite = await createServer({ server: { host: '127.0.0.1', port: 5181 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });

const fixture = () => {
  const subs = [];
  const names = ['Amsterdam', 'Amsterdam XHTTP', 'New York', 'Frankfurt', 'Helsinki', 'Istanbul', 'Tokyo', 'Smart location', 'Smart location gRPC'];
  const state = {
    version: '0.6.27', selectedId: 'auto', checking: false,
    profiles: names.map((name, i) => ({ id: String(i), name, countryCode: ['NL', 'NL', 'US', 'DE', 'FI', 'TR', 'JP', null, null][i], address: `192.0.2.${10 + i}`, port: 443,
      transport: ['raw', 'xhttp', 'grpc', 'xhttp', 'raw', 'xhttp', 'xhttp', 'raw', 'grpc'][i], security: 'reality', flow: i === 0 || i === 4 || i === 7 ? 'xtls-rprx-vision' : '', fragment: false,
      sourceId: i >= 7 ? 'local' : 'sub', lastTest: { status: i === 2 ? 'error' : 'ok', latency: [61, 42, 0, 55, 70, 88, 210, 87, 140][i], message: 'timeout' } })),
    sources: [
      { id: 'local', label: 'Мои серверы', host: 'Из буфера обмена', updatedAt: new Date().toISOString(), count: 2, remote: false },
      { id: 'sub', label: 'My VPN', host: 'example.com', updatedAt: new Date().toISOString(), count: 7, remote: true, usage: { upload: 1073741824, download: 4294967296, total: 107374182400, expire: Math.floor(Date.now() / 1000) + 86400 * 23 } },
    ],
    settings: { mode: 'tun', systemProxy: false, autoFallback: true, timeout: 8000, interface: 'auto', closeToTray: true, dnsProvider: 'cloudflare', bypassLan: false, bypassRu: false, directRules: [], tunMtu: 1400, tunIpv6: 'block', tunDnsProtection: true, killSwitch: true, autoConnect: true, theme: 'system' },
    connection: { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false },
    stats: { down: 0, up: 0, downRate: 0, upRate: 0, history: [] }, logs: [],
    environment: { interface: 'Ethernet', interfaces: ['Ethernet'], tunActive: false, windows: true, elevated: true },
    core: { ready: true, tunReady: true, version: '26.10.31', error: null }, killSwitch: { available: true, armed: false }, update: null,
  };
  const emit = () => subs.forEach((s) => s(structuredClone(state)));
  window.__set = (patch) => { Object.assign(state, patch); emit(); };
  const noop = async () => {};
  window.joxy = { state: async () => structuredClone(state), onState: (s) => { subs.push(s); return () => {}; }, select: async (id) => { state.selectedId = id; emit(); },
    connect: noop, disconnect: noop, test: noop, testProfile: noop, settings: async (p) => { Object.assign(state.settings, p); emit(); }, elevate: noop, import: async () => ({ count: 0, rejected: [] }),
    refresh: noop, openProvider: noop, importFile: async () => null, exportDiagnostics: async () => true, minimize: noop, close: noop, environment: async () => state.environment,
    share: noop, shareSource: noop, removeProfile: noop, removeSource: noop, checkUpdate: noop, installUpdate: noop, showMain: noop, hideTray: noop, quit: noop };
};
const history = Array.from({ length: 45 }, (_, i) => ({ down: 2.2e6 + Math.sin(i / 3) * 1.4e6 + (i % 7) * 3e5 + (i > 30 ? 2.6e6 : 0), up: 4e5 + Math.cos(i / 4) * 2e5 }));
const connected = (id) => ({ selectedId: id, connection: { phase: 'connected', profileId: id, since: new Date(Date.now() - 1002000).toISOString(), exitIP: '192.0.2.10', latency: 42, systemProxy: false, mode: 'tun' },
  stats: { down: 26004480, up: 6501171, downRate: 5.4e6, upRate: 6.1e5, history }, killSwitch: { available: true, armed: true } });

async function page(scheme, size = { width: 900, height: 660 }, hash = '') {
  const p = await browser.newPage({ viewport: size, deviceScaleFactor: 2, colorScheme: scheme, timezoneId: 'Europe/Berlin' });
  await p.addInitScript(fixture);
  await p.goto(`http://127.0.0.1:5181/${hash}`);
  await p.locator(hash ? '.tray-head' : '.world-map').waitFor();
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(700);
  return p;
}

try {
  let p = await page('light');
  await p.screenshot({ path: `${out}/home-light.png` });
  await p.evaluate(() => window.__set({ selectedId: '6', connection: { phase: 'connecting', profileId: '6', since: null, exitIP: null, latency: null, systemProxy: false } }));
  await p.waitForTimeout(2200);
  await p.screenshot({ path: `${out}/connecting-light.png` });
  await p.evaluate((patch) => window.__set(patch), connected('1'));
  await p.waitForTimeout(2600);
  await p.locator('.picker-button').click();
  await p.waitForTimeout(600);
  await p.screenshot({ path: `${out}/locations-light.png` });
  await p.keyboard.press('Escape');
  await p.mouse.click(450, 380);
  await p.getByRole('button', { name: 'Настройки' }).click();
  await p.getByRole('button', { name: 'Серверы', exact: true }).click();
  await p.waitForTimeout(500);
  await p.screenshot({ path: `${out}/servers-light.png` });
  await p.close();

  p = await page('dark');
  await p.evaluate((patch) => window.__set(patch), connected('1'));
  await p.waitForTimeout(2600);
  await p.screenshot({ path: `${out}/connected-dark.png` });
  await p.close();

  for (const scheme of ['light', 'dark']) {
    p = await page(scheme, { width: 320, height: 392 }, '#tray');
    await p.evaluate((patch) => window.__set(patch), connected('1'));
    await p.waitForTimeout(600);
    await p.screenshot({ path: `${out}/tray-${scheme}.png`, omitBackground: true });
    await p.close();
  }
} finally { await browser.close(); await vite.close(); }
