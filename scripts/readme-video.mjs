// Records the connection for README.md as an animated GIF: the map, the train of lights from the user's dot (Berlin,
// a fixed time zone) to Tokyo, then the zoom to the country. Invented servers only. Needs ffmpeg on PATH.
// Usage: node scripts/readme-video.mjs [output gif]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const out = process.argv[2] || 'docs/screenshots/connecting.gif';
const dir = await mkdtemp(path.join(tmpdir(), 'joxy-video-'));
const vite = await createServer({ server: { host: '127.0.0.1', port: 5182 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const size = { width: 900, height: 660 };
let started = 0;
try {
  const context = await browser.newContext({ viewport: size, colorScheme: 'dark', timezoneId: 'Europe/Berlin', recordVideo: { dir, size } });
  const opened = Date.now();
  const page = await context.newPage();
  await page.addInitScript(() => {
    const subs = [];
    const names = ['Amsterdam', 'Frankfurt', 'Helsinki', 'Istanbul', 'Tokyo'];
    const state = {
      version: '0.6.27', selectedId: '4', checking: false,
      profiles: names.map((name, i) => ({ id: String(i), name, countryCode: ['NL', 'DE', 'FI', 'TR', 'JP'][i], address: `192.0.2.${10 + i}`, port: 443, transport: 'xhttp', security: 'reality', flow: '', fragment: false, sourceId: 'sub', lastTest: { status: 'ok', latency: [61, 55, 70, 88, 140][i] } })),
      sources: [{ id: 'sub', label: 'My VPN', host: 'example.com', updatedAt: new Date().toISOString(), count: 5, remote: true }],
      settings: { mode: 'tun', systemProxy: false, autoFallback: true, timeout: 8000, interface: 'auto', closeToTray: true, dnsProvider: 'cloudflare', bypassLan: false, bypassRu: false, directRules: [], tunMtu: 1400, tunIpv6: 'block', tunDnsProtection: true, killSwitch: false, autoConnect: false, theme: 'system' },
      connection: { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false },
      stats: { down: 0, up: 0, downRate: 0, upRate: 0, history: [] }, logs: [],
      environment: { interface: 'Ethernet', interfaces: ['Ethernet'], tunActive: false, windows: true, elevated: true },
      core: { ready: true, tunReady: true, version: '26.10.31', error: null }, killSwitch: { available: false, armed: false }, update: null,
    };
    const emit = () => subs.forEach((s) => s(structuredClone(state)));
    window.__set = (patch) => { Object.assign(state, patch); emit(); };
    const noop = async () => {};
    window.joxy = new Proxy({ state: async () => structuredClone(state), onState: (s) => { subs.push(s); return () => {}; } }, { get: (t, k) => t[k] || noop });
  });
  await page.goto('http://127.0.0.1:5182/');
  await page.locator('.world-map').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  started = (Date.now() - opened) / 1000;
  await page.waitForTimeout(1000);
  await page.locator('.power').hover();
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__set({ connection: { phase: 'connecting', profileId: '4', since: null, exitIP: null, latency: null, systemProxy: false } }));
  await page.waitForTimeout(3600);
  await page.evaluate(() => window.__set({ connection: { phase: 'connected', profileId: '4', since: new Date().toISOString(), exitIP: '192.0.2.14', latency: 140, systemProxy: false, mode: 'tun' } }));
  await page.waitForTimeout(3400);
  await context.close();
  const [video] = (await readdir(dir)).filter((f) => f.endsWith('.webm'));
  // A palette of the clip's own colours keeps the dots crisp; 20 frames a second is plenty for the train.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(started), '-i', path.join(dir, video),
    '-vf', 'fps=20,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', '-loop', '0', out]);
  console.log(`wrote ${out}`);
} finally { await browser.close(); await vite.close(); await rm(dir, { recursive: true, force: true }); }
