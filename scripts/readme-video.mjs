// Records a short session for README.md: JOXY opens, the server list is opened and Tokyo picked, the connection is
// made from Moscow (a fixed time zone for the user's dot), the train of lights runs all the way to Japan, and JOXY
// disconnects. Invented servers only; a drawn cursor shows the clicks.
//
// Frames are rendered, not filmed: the page's clock is paused and moved on exactly one frame at a time, so the result
// has an even frame rate however slow the machine; CSS animations are slowed to the same pace through the DevTools
// protocol. The frames become an animated WebP (GitHub shows it like a GIF, which cannot go past 50 fps) and an MP4.
// Needs ffmpeg on PATH. Usage: node scripts/readme-video.mjs [output .webp] [fps]
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const out = process.argv[2] || 'docs/screenshots/connecting-session.webp';
const FPS = Number(process.argv[3] || 60), STEP = 1000 / FPS;
const dir = await mkdtemp(path.join(tmpdir(), 'joxy-frames-'));
const vite = await createServer({ server: { host: '127.0.0.1', port: 5182 }, logLevel: 'error' });
await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const size = { width: 900, height: 660 };

// The bridge answers like the app: connecting takes a few seconds, then the session is up.
const fixture = () => {
  const subs = [];
  const names = ['Amsterdam', 'Frankfurt', 'Helsinki', 'Istanbul', 'New York', 'Tokyo'];
  const state = {
    version: '0.6.27', selectedId: 'auto', checking: false,
    profiles: names.map((name, i) => ({ id: String(i), name, countryCode: ['NL', 'DE', 'FI', 'TR', 'US', 'JP'][i], address: `192.0.2.${10 + i}`, port: 443, transport: i % 2 ? 'raw' : 'xhttp', security: 'reality', flow: i % 2 ? 'xtls-rprx-vision' : '', fragment: false, sourceId: 'sub', lastTest: { status: 'ok', latency: [61, 55, 70, 88, 120, 140][i] } })),
    sources: [{ id: 'sub', label: 'My VPN', host: 'example.com', updatedAt: new Date().toISOString(), count: 6, remote: true }],
    settings: { mode: 'tun', systemProxy: false, autoFallback: true, timeout: 8000, interface: 'auto', closeToTray: true, dnsProvider: 'cloudflare', bypassLan: false, bypassRu: false, directRules: [], tunMtu: 1400, tunIpv6: 'block', tunDnsProtection: true, killSwitch: false, autoConnect: false, theme: 'system' },
    connection: { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false },
    stats: { down: 0, up: 0, downRate: 0, upRate: 0, history: [] }, logs: [],
    environment: { interface: 'Ethernet', interfaces: ['Ethernet'], tunActive: false, windows: true, elevated: true },
    core: { ready: true, tunReady: true, version: '26.10.31', error: null }, killSwitch: { available: false, armed: false }, update: null,
  };
  const emit = () => subs.forEach((s) => s(structuredClone(state)));
  const idle = { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false };
  let traffic = 0;
  const api = {
    state: async () => structuredClone(state), onState: (s) => { subs.push(s); return () => {}; },
    select: async (id) => { state.selectedId = id; emit(); },
    connect: async () => {
      state.connection = { ...idle, phase: 'connecting', profileId: state.selectedId }; emit();
      await new Promise((r) => setTimeout(r, 3400));
      state.connection = { phase: 'connected', profileId: state.selectedId, since: new Date().toISOString(), exitIP: '192.0.2.15', latency: 140, systemProxy: false, mode: 'tun' }; emit();
      // Traffic like a video playing: the counters at the bottom climb while connected.
      let tick = 0;
      traffic = setInterval(() => {
        tick++;
        const down = 1.6e6 + 1.1e6 * Math.abs(Math.sin(tick * 1.7)), up = 1.4e5 + 9e4 * Math.abs(Math.cos(tick * 1.3));
        state.stats = { down: state.stats.down + down, up: state.stats.up + up, downRate: down * 2, upRate: up * 2, history: [...state.stats.history, { down: down * 2, up: up * 2 }].slice(-45) };
        emit();
      }, 500);
    },
    disconnect: async () => { clearInterval(traffic); state.connection = idle; state.stats = { down: 0, up: 0, downRate: 0, upRate: 0, history: [] }; emit(); },
  };
  window.joxy = new Proxy(api, { get: (t, k) => t[k] || (async () => {}) });
  // A cursor drawn into the page, so the recording shows where it clicks.
  addEventListener('DOMContentLoaded', () => {
    const c = document.createElement('div');
    // The standard Windows arrow, pixel for pixel: tip at the top left, the tail down to the right.
    c.innerHTML = '<svg width="13" height="21" viewBox="0 0 13 21" shape-rendering="crispEdges"><path d="M0.5 0.5V17.5L4.5 13.5L7.5 20.5L9.5 19.5L6.5 12.5H12.5Z" fill="#fff" stroke="#000" stroke-width="1" stroke-linejoin="miter"/></svg>';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;line-height:0;transform:translate(640px,420px);filter:drop-shadow(1px 1px 1px #0006)';
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.transform = `translate(${Math.round(e.clientX)}px, ${Math.round(e.clientY)}px)`; }, true);
  });
};

try {
  const page = await browser.newPage({ viewport: size, colorScheme: 'dark', timezoneId: 'Europe/Moscow' });
  await page.clock.install();
  await page.addInitScript(fixture);
  await page.goto('http://127.0.0.1:5182/');
  await page.clock.runFor(1500);
  await page.locator('.world-map').waitFor();
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');

  let n = 0, pointer = { x: 640, y: 420 };
  const shot = () => page.screenshot({ path: path.join(dir, `f${String(n++).padStart(5, '0')}.png`) });
  // Measure how long a frame takes for real, and slow CSS animations so they keep pace with the paused clock.
  const t0 = Date.now(); for (let i = 0; i < 6; i++) await shot(); n = 0;
  await cdp.send('Animation.setPlaybackRate', { playbackRate: Math.min(1, STEP / ((Date.now() - t0) / 6)) });
  const frame = async () => { await page.clock.runFor(STEP); await shot(); };
  const hold = async (ms) => { for (let t = 0; t < ms; t += STEP) await frame(); };
  const ease = (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
  const glide = async (x, y, ms = 650) => {
    const from = { ...pointer };
    for (let t = STEP; t <= ms; t += STEP) {
      const k = ease(Math.min(1, t / ms));
      await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
      await frame();
    }
    pointer = { x, y };
  };
  const clickOn = async (locator) => {
    const box = await locator.boundingBox();
    await glide(box.x + box.width / 2, box.y + box.height / 2);
    await hold(180);
    await page.mouse.down(); await hold(90); await page.mouse.up();
  };

  await page.mouse.move(pointer.x, pointer.y);
  await hold(900);
  await clickOn(page.locator('.picker-button'));
  await hold(700);
  await clickOn(page.getByRole('option', { name: /Tokyo/ }));
  await hold(1200);
  await clickOn(page.locator('.power'));
  await hold(3600);  // connecting: the train leaves Moscow
  await glide(700, 520, 900);
  await hold(5200);  // connected: the last cars arrive in Japan
  await clickOn(page.locator('.power'));
  await hold(2200);
  console.log(`${n} frames at ${FPS} fps, ${(n / FPS).toFixed(1)} s`);

  // The MP4 first, then the WebP from it: libwebp_anim stores what changes between frames (and merges frames that do
  // not change), which keeps 60 fps at a few megabytes.
  const mp4 = out.replace(/\.webp$/, '.mp4');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.png'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', mp4, '-c:v', 'libwebp_anim', '-quality', '92', '-compression_level', '6', '-loop', '0', '-an', out]);
  console.log(`wrote ${out} and ${mp4}`);
} finally { await browser.close(); await vite.close(); await rm(dir, { recursive: true, force: true }); }
