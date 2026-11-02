import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import world from './assets/world-dots.json';

type Tone = 'idle' | 'selected' | 'connected';
type Camera = { x: number; y: number; z: number };
const { cols, rows, dots, countries, levels: finer } = world as unknown as { cols: number; rows: number; dots: number[]; countries: { iso: string; center: [number, number] }[]; levels: { scale: number; data: string }[] };

// Three levels of detail on one origin: 1x, 2x and 4x dots per side. Coordinates are in base-grid units throughout.
type Level = { scale: number; byCountry: Map<string, [number, number][]> };
function level(scale: number, triplets: ArrayLike<number>): Level {
  const byCountry = new Map<string, [number, number][]>();
  for (let i = 0; i < triplets.length; i += 3) {
    const iso = countries[triplets[i + 2]].iso, point: [number, number] = [(triplets[i] + 0.5) / scale, (triplets[i + 1] + 0.5) / scale];
    const list = byCountry.get(iso);
    if (list) list.push(point); else byCountry.set(iso, [point]);
  }
  return { scale, byCountry };
}
const decode = (b64: string) => { const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); return new Uint16Array(bytes.buffer); };
const levels: Level[] = [level(1, dots), ...finer.map((l) => level(l.scale, decode(l.data)))];
const byCountry = levels[0].byCountry;
// How much of each level shows at a zoom: each step of detail takes over around a doubling of the zoom, with a short
// cross-fade, so the dots on screen keep about the same spacing and the outlines sharpen instead of the dots swelling.
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
function weights(z: number) {
  const f = Math.log2(z), up1 = smooth(0.85, 1.15, f), up2 = smooth(1.85, 2.15, f);
  return [1 - up1, up1 - up2, up2];
}

const MIN_Z = 1, MAX_Z = 8, BLEED = 1.14; // at z = 1 the world is 14% wider than the view, so its edges leave the frame
const ANCHOR_Y = 0.42; // the camera centre sits a little above the middle: the status and the button live below
const home = (): Camera => ({ x: cols / 2, y: rows / 2, z: 1 });

// Framing for a connection: the dots near the country's centre, so overseas territories do not stretch the zoom.
function frame(iso: string): Camera | null {
  const country = countries.find((c) => c.iso === iso);
  if (!country) return null;
  const [cx, cy] = [country.center[0] + 0.5, country.center[1] + 0.5];
  const near = (byCountry.get(iso) || []).filter(([x, y]) => Math.hypot(x - cx, y - cy) < 28);
  const xs = near.map(([x]) => x), ys = near.map(([, y]) => y);
  const span = near.length ? Math.max(Math.max(...xs) - Math.min(...xs) + 1, (Math.max(...ys) - Math.min(...ys) + 1) * 2.2) : 0;
  return { x: cx, y: cy, z: Math.min(2.6, Math.max(1.7, cols / Math.max(span * 2.4, 1))) };
}

// Past the edge the map follows less and less, so the boundary reads as soft, not frozen.
const rubber = (over: number, size: number) => (over * size * 0.55) / (size + 0.55 * Math.abs(over));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// servers: countries the user has servers in; they stay marked whatever is selected, so the map shows where one can go.
export function WorldMap({ iso, tone, focus, servers = [] }: { iso: string | null; tone: Tone; focus: boolean; servers?: string[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>(home());
  const vel = useRef<Camera>({ x: 0, y: 0, z: 0 });
  const target = useRef<Camera | null>(null);
  const glide = useRef(false); // momentum after a flick
  const drag = useRef<{ id: number; x: number; y: number; history: { x: number; y: number; t: number }[] } | null>(null);
  const frameId = useRef(0);
  const [moved, setMoved] = useState(false);
  const props = useRef({ iso, tone, servers: new Set(servers) });
  props.current = { iso, tone, servers: new Set(servers) };

  const scale = (w: number) => (w * BLEED / cols) * cam.current.z;
  const draw = useCallback(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1, w = el.clientWidth, h = el.clientHeight;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
    const ctx = el.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const style = getComputedStyle(el), k = scale(w), c = cam.current;
    const ax = w / 2, ay = h * ANCHOR_Y;
    const { iso: chosen, tone: t, servers: available } = props.current;
    const land = style.getPropertyValue('--dot'), server = style.getPropertyValue('--map-server');
    const highlight = t === 'connected' ? style.getPropertyValue('--green') : t === 'selected' ? style.getPropertyValue('--text') : '';
    const share = weights(c.z);
    levels.forEach(({ scale: s, byCountry: countriesAt }, i) => {
      if (share[i] < 0.01) return;
      // Dot size follows the spacing of its own level, so finer levels bring smaller, denser dots.
      const r = Math.min(Math.max((k / s) * 0.29, 0.7), 7);
      ctx.globalAlpha = share[i];
      // Every frame is drawn at the real scale, so dots stay crisp while the camera moves; off-screen dots are skipped.
      const paint = (points: [number, number][], color: string) => {
        ctx.fillStyle = color; ctx.beginPath();
        for (const [x, y] of points) {
          const sx = ax + (x - c.x) * k, sy = ay + (y - c.y) * k;
          if (sx < -r || sx > w + r || sy < -r || sy > h + r) continue;
          ctx.moveTo(sx + r, sy); ctx.arc(sx, sy, r, 0, Math.PI * 2);
        }
        ctx.fill();
      };
      for (const [code, points] of countriesAt) if (code !== chosen) paint(points, available.has(code) ? server : land);
      if (chosen) paint(countriesAt.get(chosen) || [], highlight || (available.has(chosen) ? server : land));
    });
    ctx.globalAlpha = 1;
  }, []);

  // One loop drives springs and momentum; it stops itself when everything is at rest.
  const tick = useCallback(() => {
    cancelAnimationFrame(frameId.current);
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30); last = now;
      const c = cam.current, v = vel.current;
      let busy = false;
      if (target.current) {
        // Critically damped spring (damping 1.0, response 0.55 s): no overshoot, interruptible at any frame.
        const w = (2 * Math.PI) / 0.55, t = target.current;
        for (const key of ['x', 'y', 'z'] as const) {
          v[key] += (w * w * (t[key] - c[key]) - 2 * w * v[key]) * dt;
          c[key] += v[key] * dt;
        }
        busy = Math.abs(t.x - c.x) + Math.abs(t.y - c.y) + Math.abs(t.z - c.z) * 10 > 0.002 || Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z) > 0.002;
        if (!busy) { Object.assign(c, t); target.current = null; v.x = v.y = v.z = 0; }
      } else if (glide.current) {
        // Momentum decays like scrolling (0.998 per millisecond); out of bounds it hands over to a spring back.
        const decay = Math.pow(0.998, dt * 1000);
        v.x *= decay; v.y *= decay; c.x += v.x * dt; c.y += v.y * dt;
        const outside = c.x < 0 || c.x > cols || c.y < 0 || c.y > rows;
        if (outside) { glide.current = false; target.current = { x: Math.min(cols, Math.max(0, c.x)), y: Math.min(rows, Math.max(0, c.y)), z: c.z }; busy = true; }
        else busy = Math.hypot(v.x, v.y) > 0.05;
        if (!busy) glide.current = false;
      }
      draw();
      if (busy) frameId.current = requestAnimationFrame(step);
    };
    frameId.current = requestAnimationFrame(step);
  }, [draw]);

  const goTo = useCallback((next: Camera) => {
    glide.current = false;
    if (reduced()) { cam.current = { ...next }; target.current = null; draw(); return; }
    target.current = next; tick();
  }, [draw, tick]);

  // Connecting flies to the country; disconnecting returns to the whole world.
  const destination = () => (focus && iso ? frame(iso) : null) || home();
  useEffect(() => { goTo(destination()); setMoved(false); }, [focus, iso]);
  useEffect(() => { draw(); }, [tone, iso, servers.join(), draw]);
  useEffect(() => {
    const el = canvas.current!;
    const resize = new ResizeObserver(() => draw());
    resize.observe(el);
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', draw);
    return () => { resize.disconnect(); scheme.removeEventListener('change', draw); cancelAnimationFrame(frameId.current); };
  }, [draw]);

  const zoomAt = (factor: number, sx: number, sy: number, animate = false) => {
    const el = canvas.current!, w = el.clientWidth, h = el.clientHeight, c = cam.current;
    const z = Math.min(MAX_Z, Math.max(MIN_Z, c.z * factor));
    const k0 = scale(w), k1 = (w * BLEED / cols) * z;
    // The point under the cursor stays under the cursor.
    const gx = c.x + (sx - w / 2) / k0, gy = c.y + (sy - h * ANCHOR_Y) / k0;
    const next = { x: gx - (sx - w / 2) / k1, y: gy - (sy - h * ANCHOR_Y) / k1, z };
    next.x = Math.min(cols, Math.max(0, next.x)); next.y = Math.min(rows, Math.max(0, next.y));
    setMoved(true);
    if (animate) goTo(next); else { target.current = null; glide.current = false; cam.current = next; draw(); }
  };
  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - box.left, e.clientY - box.top);
  };
  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // Grabbing stops any flight or glide where it is, and continues from that very frame.
    target.current = null; glide.current = false; vel.current = { x: 0, y: 0, z: 0 };
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, history: [{ x: e.clientX, y: e.clientY, t: performance.now() }] };
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const k = scale(e.currentTarget.clientWidth), c = cam.current;
    const free = { x: c.x - (e.clientX - d.x) / k, y: c.y - (e.clientY - d.y) / k };
    // Tracks 1:1 inside the world, with growing resistance past its edge.
    const soft = (value: number, max: number) => value < 0 ? rubber(value, max) : value > max ? max + rubber(value - max, max) : value;
    c.x = soft(free.x, cols); c.y = soft(free.y, rows);
    d.x = e.clientX; d.y = e.clientY;
    d.history.push({ x: e.clientX, y: e.clientY, t: performance.now() });
    if (d.history.length > 6) d.history.shift();
    setMoved(true); draw();
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const first = d.history[0], lastPoint = d.history.at(-1)!, span = (lastPoint.t - first.t) / 1000;
    const k = scale(e.currentTarget.clientWidth), c = cam.current;
    const outside = c.x < 0 || c.x > cols || c.y < 0 || c.y > rows;
    if (outside) { goTo({ x: Math.min(cols, Math.max(0, c.x)), y: Math.min(rows, Math.max(0, c.y)), z: c.z }); return; }
    // The release velocity carries on as momentum: a flick throws the map.
    if (span > 0 && performance.now() - lastPoint.t < 80) {
      vel.current = { x: -(lastPoint.x - first.x) / span / k, y: -(lastPoint.y - first.y) / span / k, z: 0 };
      glide.current = true; tick();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget, step = 40 / scale(el.clientWidth), c = cam.current;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => goTo({ ...c, x: Math.max(0, c.x - step) }), ArrowRight: () => goTo({ ...c, x: Math.min(cols, c.x + step) }),
      ArrowUp: () => goTo({ ...c, y: Math.max(0, c.y - step) }), ArrowDown: () => goTo({ ...c, y: Math.min(rows, c.y + step) }),
      '+': () => zoomAt(1.5, el.clientWidth / 2, el.clientHeight * ANCHOR_Y, true), '=': () => zoomAt(1.5, el.clientWidth / 2, el.clientHeight * ANCHOR_Y, true),
      '-': () => zoomAt(1 / 1.5, el.clientWidth / 2, el.clientHeight * ANCHOR_Y, true), '0': () => { goTo(destination()); setMoved(false); },
    };
    if (moves[e.key]) { e.preventDefault(); moves[e.key](); if (e.key !== '0') setMoved(true); }
  };

  return <>
    <canvas ref={canvas} className="world-map" tabIndex={0} role="img" data-country={iso || ''} data-tone={tone} data-servers={servers.join(' ')}
      aria-label={`Карта мира${iso ? ', выбранная страна выделена' : ''}. Перетаскивание и стрелки перемещают, колесо и плюс-минус приближают, ноль возвращает.`}
      onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
      onDoubleClick={(e) => { const box = e.currentTarget.getBoundingClientRect(); zoomAt(2, e.clientX - box.left, e.clientY - box.top, true); }}
      onKeyDown={onKeyDown} />
    {moved && <button className="map-recenter" onClick={() => { goTo(destination()); setMoved(false); }}>Центрировать</button>}
  </>;
}
