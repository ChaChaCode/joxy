import { useEffect, useState } from 'react';
import { AutoTile, CountryFlag, countryName } from './CountryFlag';
import { ArrowDown, ArrowUp, LoaderCircle, Power } from './icons';
import { bytes, elapsed, security, transport } from './format';
import type { State } from './types';

// Download as a filled green area and upload as a thin line, on one scale, over the last samples (every two seconds).
function Sparkline({ history }: { history: State['stats']['history'] }) {
  const w = 268, h = 64, points = history.length ? history : [{ down: 0, up: 0 }];
  const max = Math.max(1, ...points.map((p) => Math.max(p.down, p.up)));
  const at = (i: number) => (points.length === 1 ? w : (i / (points.length - 1)) * w);
  const y = (v: number) => h - 4 - (v / max) * (h - 10);
  const line = (key: 'down' | 'up') => points.map((p, i) => `${i ? 'L' : 'M'}${at(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  return <svg className="tray-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="tray-down" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--green)" stopOpacity="0.28" /><stop offset="1" stopColor="var(--green)" stopOpacity="0" /></linearGradient></defs>
    <path d={`${line('down')} L${w},${h} L0,${h} Z`} fill="url(#tray-down)" />
    <path d={line('down')} fill="none" stroke="var(--green)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    <path d={line('up')} fill="none" stroke="var(--secondary)" strokeWidth="1.2" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
  </svg>;
}

// The tray panel: where the traffic goes, the switch, how long and how fast, and a way into the app.
export function TrayView() {
  const bridge = window.joxy;
  const [state, setState] = useState<State | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!bridge) return;
    bridge.state().then(setState).catch(() => {});
    const off = bridge.onState(setState);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') bridge.hideTray(); };
    window.addEventListener('keydown', escape);
    return () => { off(); clearInterval(timer); window.removeEventListener('keydown', escape); };
  }, [bridge]);
  if (!state) return <div className="tray" />;

  const c = state.connection, connected = c.phase === 'connected', connecting = c.phase === 'connecting';
  const profile = state.profiles.find((p) => p.id === (connected || connecting ? c.profileId : state.selectedId));
  const code = profile?.countryCode || (connected ? c.exitCountry : null);
  const place = profile ? [countryName(code), profile.name].filter(Boolean).join(' · ') : state.profiles.length ? 'Автовыбор' : 'Нет серверов';
  const title = connected ? 'Подключено' : connecting ? 'Подключение…' : c.phase === 'error' ? 'Не удалось подключиться' : 'Не подключено';
  const toggle = async () => {
    if (!bridge || busy) return;
    setBusy(true); setError('');
    try { await (connected ? bridge.disconnect() : bridge.connect()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return <div className={`tray ${connected ? 'is-connected' : ''}`}>
    <header className="tray-head">
      <span className="tray-brand">JOXY</span>
      <span className={`tray-state ${c.phase}`}>{title}</span>
    </header>
    <div className="tray-server">
      {profile ? <CountryFlag code={code} /> : <AutoTile />}
      <span><strong>{place}</strong><small>{profile ? `VLESS · ${security(profile)} · ${transport(profile)}` : 'Лучший доступный сервер'}</small></span>
    </div>
    <div className="tray-main">
      <button className={`power ${connected ? 'on' : ''}`} aria-label={connected ? 'Отключиться' : connecting ? 'Подключение…' : 'Подключиться'} aria-pressed={connected}
        disabled={connecting || busy || !state.core.ready || !state.profiles.length} onClick={toggle}>
        {connecting || busy ? <LoaderCircle className="spin" size={24} /> : <Power size={24} />}
      </button>
      <div className="tray-time"><span className="timer mono">{connected ? elapsed(c.since, now) : '00:00:00'}</span><small>{connected && c.latency != null ? `Задержка ${c.latency} мс` : connected ? 'Задержка —' : 'VPN выключен'}</small></div>
    </div>
    <div className="tray-chart">
      {connected ? <Sparkline history={state.stats.history} /> : <div className="tray-spark tray-spark-empty">Скорость появится после подключения</div>}
      <div className="tray-rates">
        <span className="down"><ArrowDown size={13} />{bytes(connected ? state.stats.downRate : 0)}/с</span>
        <span className="up"><ArrowUp size={13} />{bytes(connected ? state.stats.upRate : 0)}/с</span>
      </div>
    </div>
    {error && <p className="tray-error" role="alert">{error}</p>}
    <div className="tray-foot">
      <button className="tray-open" onClick={() => bridge?.showMain()}>Открыть JOXY</button>
      <button className="tray-quit" aria-label="Выйти из JOXY" title="Выйти из JOXY" onClick={() => bridge?.quit()}><Power size={16} /></button>
    </div>
  </div>;
}
