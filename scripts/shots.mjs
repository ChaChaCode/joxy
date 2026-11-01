// Screenshots of the main states and settings in both themes, from a fixture state (no real data).
// Usage: node scripts/shots.mjs [output directory]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
const out = process.argv[2] || 'artifacts/design';
await mkdir(out, { recursive: true });
const vite = await createServer({ server: { host: '127.0.0.1', port: 5179 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 900, height: 660 }, deviceScaleFactor: 1, colorScheme: scheme });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      const subs = [];
      const state = {
        version: '0.6.0', selectedId: 'auto', checking: false,
        profiles: ['Amsterdam', 'Amsterdam XHTTP', 'New York gRPC'].map((name, i) => ({ id: String(i), name, countryCode: ['NL', 'NL', 'US'][i], address: '192.0.2.10', port: 443 + i, transport: ['raw', 'xhttp', 'grpc'][i], security: 'reality', flow: i === 0 ? 'xtls-rprx-vision' : '', fragment: i === 0, sourceId: 'test', lastTest: [{ status: 'ok', latency: 61 }, { status: 'ok', latency: 42 }, { status: 'error', message: 'timeout' }][i] })),
        sources: [{ id: 'test', label: 'My VPN', host: 'example.com', updatedAt: new Date().toISOString(), count: 3, remote: true, usage: { upload: 1, download: 1, total: 0, expire: Math.floor(Date.now() / 1000) + 86400 * 28 } }],
        settings: { mode: 'tun', systemProxy: false, autoFallback: true, timeout: 8000, interface: 'auto', closeToTray: true, dnsProvider: 'cloudflare', bypassLan: false, directRules: [], tunMtu: 1400, tunIpv6: 'block', tunDnsProtection: true, killSwitch: true, autoConnect: true, theme: 'system' },
        connection: { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false },
        stats: { down: 0, up: 0, downRate: 0, upRate: 0, history: [] }, logs: [{ id: '1', time: new Date().toISOString(), level: 'info', message: 'Xray 26.10.31 проверен по SHA256. Приложение готово.' }],
        environment: { interface: 'Ethernet', interfaces: ['Ethernet'], tunActive: false, windows: true, elevated: true },
        core: { ready: true, tunReady: true, version: '26.10.31', error: null }, killSwitch: { available: true, armed: false },
      };
      const emit = () => subs.forEach((s) => s(structuredClone(state)));
      window.__set = (patch) => { Object.assign(state, patch); emit(); };
      window.joxy = { state: async () => structuredClone(state), onState: (s) => { subs.push(s); return () => {}; }, select: async (id) => { state.selectedId = id; emit(); }, connect: async () => {}, disconnect: async () => {}, test: async () => {}, settings: async (p) => { Object.assign(state.settings, p); emit(); }, elevate: async () => {}, import: async () => ({ count: 0, rejected: [] }), refresh: async () => {}, openProvider: async () => {}, importFile: async () => null, exportDiagnostics: async () => true, minimize: async () => {}, close: async () => {}, environment: async () => state.environment };
    });
    await page.goto('http://127.0.0.1:5179');
    await page.locator('.world-map').waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600); // let first-paint colour transitions settle
    await page.screenshot({ path: `${out}/${scheme}-1-auto.png` });
    await page.evaluate(() => window.__set({ selectedId: '2' }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${scheme}-2-selected.png` });
    await page.evaluate(() => window.__set({ connection: { phase: 'connecting', profileId: '2', since: null, exitIP: null, latency: null, systemProxy: false } }));
    await page.waitForTimeout(220);
    await page.screenshot({ path: `${out}/${scheme}-2b-mid-zoom.png` });
    await page.evaluate(() => window.__set({ connection: { phase: 'connected', profileId: '2', since: new Date(Date.now() - 1002000).toISOString(), exitIP: '192.0.2.10', latency: 42, systemProxy: false, mode: 'tun' }, stats: { down: 26004480, up: 6501171, downRate: 0, upRate: 0, history: [] }, killSwitch: { available: true, armed: true } }));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${scheme}-3-connected.png` });
    await page.evaluate(() => window.__set({ selectedId: '1', connection: { phase: 'connected', profileId: '1', since: new Date(Date.now() - 62000).toISOString(), exitIP: '192.0.2.10', latency: 42, systemProxy: false, mode: 'tun' } }));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/${scheme}-4-connected-small-country.png` });
    await page.getByRole('button', { name: 'Ваш выбор' }).count();
    await page.locator('.picker-button').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${scheme}-5-picker.png` });
    await page.keyboard.press('Escape');
    await page.mouse.click(450, 400);
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/${scheme}-6-settings.png` });
    if (errors.length) throw new Error(errors.join('\n'));
    await page.close();
  }
} finally { await browser.close(); await vite.close(); }
