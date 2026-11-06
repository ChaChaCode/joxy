import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { ContextMenu } from './ContextMenu';
import { ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, FileInput, LoaderCircle, Plus, Power, RefreshCw, Share, ShieldCheck, Trash, X } from './icons';
import type { Profile, State } from './types';
import { AutoTile, CountryFlag, countryName } from './CountryFlag';
import { maskAddresses } from './privacy';
import { SettingsView } from './SettingsView';
import { WorldMap } from './WorldMap';
import { bytes, countProfiles, elapsed, security, settingsDefaults, transport } from './format';


const initial: State = {
  version: '', profiles: [], sources: [], selectedId: 'auto', checking: false,
  settings: { ...settingsDefaults },
  connection: { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false },
  stats: { down: 0, up: 0, downRate: 0, upRate: 0, history: [] }, logs: [],
  environment: { interface: '', interfaces: [], tunActive: false, windows: true }, core: { ready: false, version: '', error: null },
};
export default function App() {
  const [state, setState] = useState<State>(initial);
  const [view, setView] = useState<'home' | 'settings'>('home');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const [busy, setBusy] = useState('');
  const [adminPrompt, setAdminPrompt] = useState(false);
  const [hiddenConflict, setHiddenConflict] = useState('');
  const [hiddenUpdate, setHiddenUpdate] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; kind: 'profile' | 'source' } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [addressesVisible, setAddressesVisible] = useState(false);
  const [now, setNow] = useState(Date.now());
  const importRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  // A click closes the sheet only if it began on the backdrop: selecting text and releasing outside must not.
  const backdropPress = useRef(false);
  const bridge = window.joxy;
  useEffect(() => {
    let alive = true;
    bridge?.state().then((s) => { if (alive) { setState(s); if (!s.profiles.length) setImportOpen(true); } }).catch((e) => setToast({ message: e.message, error: true }));
    const off = bridge?.onState((s) => { if (alive) setState(s); });
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; off?.(); clearInterval(tick); };
  }, []);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 7000); return () => clearTimeout(t); } }, [toast]);
  useEffect(() => { if (importOpen) importRef.current?.focus(); }, [importOpen]);
  useEffect(() => {
    if (!bridge) return;
    let pending = false;
    const refresh = () => {
      if (pending || document.hidden) return;
      pending = true;
      bridge.environment().catch(() => {}).finally(() => { pending = false; });
    };
    window.addEventListener('focus', refresh);
    // Poll only while a conflict is visible, so exiting another client clears it.
    const timer = state.environment.tunActive ? window.setInterval(refresh, 5000) : undefined;
    return () => { window.removeEventListener('focus', refresh); window.clearInterval(timer); };
  }, [bridge, state.environment.tunActive]);
  useEffect(() => { setAddressesVisible(false); }, [view, importOpen]);
  useEffect(() => {
    const hide = () => setAddressesVisible(false);
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', hide);
    const timer = addressesVisible ? window.setTimeout(hide, 30000) : undefined;
    return () => { window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', hide); window.clearTimeout(timer); };
  }, [addressesVisible]);
  useEffect(() => {
    if (!pickerOpen) return;
    // A server's right-click menu floats over the list: pressing in it keeps the list open.
    const close = (e: PointerEvent) => { const t = e.target as Element; if (!pickerRef.current?.contains(t) && !t.closest?.('.context-menu')) setPickerOpen(false); };
    // Escape closes the menu wherever focus is, and hands focus back to the button that opened it.
    const escape = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') { setPickerOpen(false); pickerRef.current?.querySelector<HTMLElement>('.picker-button')?.focus(); } };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [pickerOpen]);
  const knownAddresses = [...state.profiles.map((p) => p.address), ...state.sources.map((s) => s.host), state.connection.exitIP || ''];
  const privateText = (value?: string | null) => maskAddresses(value, knownAddresses, addressesVisible);
  const run = async (label: string, action: () => Promise<unknown>, success?: string) => {
    if (!bridge) { setToast({ message: 'Подключение доступно в настольном приложении JOXY.', error: true }); return; }
    setBusy(label);
    try { await action(); if (success) setToast({ message: success }); }
    catch (e) { if (label !== 'connection' || state.connection.phase === 'connected') setToast({ message: e instanceof Error ? e.message : String(e), error: true }); }
    finally { setBusy(''); }
  };
  const connected = state.connection.phase === 'connected';
  const connecting = state.connection.phase === 'connecting';
  const update = state.update;
  const failed = state.connection.phase === 'error';
  const active = state.profiles.find((p) => p.id === state.connection.profileId);
  const selected = state.profiles.find((p) => p.id === state.selectedId);
  const shown = (connected || connecting) && active ? active : selected;
  // Auto mode still has a destination worth naming in the footer: the profile it tries first.
  const destination = shown || [...state.profiles].sort((a, b) => (a.transport === 'xhttp' ? 0 : 1) - (b.transport === 'xhttp' ? 0 : 1))[0];
  const iso = shown?.countryCode && /^[A-Z]{2}$/.test(shown.countryCode) ? shown.countryCode : null;
  const mode = state.connection.mode || state.settings.mode;
  // A dismissed conflict card stays hidden for that VPN until it goes away; if it comes back, so does the card.
  const foreignNames = state.environment.foreignTunnels?.map((t) => t.name) || [];
  const conflictKey = foreignNames.join(',') || 'vpn';
  const conflictShown = state.environment.tunActive && hiddenConflict !== conflictKey;
  useEffect(() => { if (!state.environment.tunActive) setHiddenConflict(''); }, [state.environment.tunActive]);
  const serverCountries = [...new Set(state.profiles.map((p) => p.countryCode).filter((c): c is string => !!c && /^[A-Z]{2}$/.test(c)))].sort();
  const openImport = () => { setPickerOpen(false); setImportText(''); setImportError(''); setImportOpen(true); };
  const importSubmit = () => run('import', async () => {
    try {
      const r = await bridge!.import(importText); setImportOpen(false); setImportText('');
      setToast({ message: `Добавлено: ${countProfiles(r.count)}` });
    } catch (e) { setImportError(e instanceof Error ? e.message : String(e)); importRef.current?.focus(); }
  });
  const modalKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !busy) { event.stopPropagation(); setImportOpen(false); }
    if (event.key === 'Tab') {
      const fields = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input, select'));
      const first = fields[0], last = fields.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  // TUN needs administrator rights: the press asks Windows for them, and the restarted JOXY connects by itself.
  const elevateAndConnect = async () => {
    if (!bridge) return;
    setBusy('elevate'); setAdminPrompt(false);
    try { await bridge.elevate({}, { connect: true }); } catch { setAdminPrompt(true); } finally { setBusy(''); }
  };
  const choose = (id: string) => { setPickerOpen(false); run('select', () => bridge!.select(id)); };
  const serverMenu = (e: MouseEvent, id: string, kind: 'profile' | 'source' = 'profile') => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, id, kind }); };
  const menuServer = menu?.kind === 'profile' ? state.profiles.find((p) => p.id === menu.id) : undefined;
  const menuSource = menu?.kind === 'source' ? state.sources.find((s) => s.id === menu.id) : undefined;
  const inUse = (ids: string[]) => (connected || connecting) && ids.includes(state.connection.profileId || '');
  const title = !state.profiles.length ? 'Нет серверов' : connected ? 'Подключено' : connecting ? 'Подключение…' : failed ? 'Не удалось подключиться' : shown || state.selectedId === 'auto' ? 'Готово к подключению' : 'Не подключено';
  const place = (p: Profile) => countryName(p.countryCode) ? `${countryName(p.countryCode)} · ${privateText(p.name)}` : privateText(p.name);
  const locationLabel = shown ? place(shown) : state.profiles.length ? 'Автовыбор' : 'Выберите локацию';
  const latency = (p: Profile) => p.lastTest?.status === 'ok' ? `${p.lastTest.latency} мс` : p.lastTest?.status === 'checking' ? 'проверка…' : p.lastTest?.status === 'error' ? 'недоступен' : '';

  return <div className="app">
    {menuServer && <ContextMenu at={menu!} title={privateText(menuServer.name)} close={closeMenu} items={[
      { label: 'Проверить задержку', icon: <RefreshCw size={15} />, disabled: !bridge || state.checking || !!busy, action: () => run('test', () => bridge!.testProfile(menuServer.id)) },
      { label: 'Поделиться', icon: <Share size={15} />, disabled: !bridge, action: () => run('share', () => bridge!.share(menuServer.id), 'Ссылка на сервер скопирована') },
      { label: inUse([menuServer.id]) ? 'Удалить (сначала отключитесь)' : 'Удалить сервер', icon: <Trash size={15} />, disabled: !bridge || !!busy || inUse([menuServer.id]), confirm: 'Нажмите ещё раз, чтобы удалить', action: () => run('remove', () => bridge!.removeProfile(menuServer.id), 'Сервер удалён') },
    ]} />}
    {menuSource && <ContextMenu at={menu!} title={privateText(menuSource.label)} close={closeMenu} items={[
      ...(menuSource.remote ? [{ label: 'Скопировать ссылку подписки', icon: <Share size={15} />, disabled: !bridge, action: () => run('share', () => bridge!.shareSource(menuSource.id), 'Ссылка на подписку скопирована') }] : []),
      { label: inUse(state.profiles.filter((p) => p.sourceId === menuSource.id).map((p) => p.id)) ? 'Удалить (сначала отключитесь)' : 'Удалить подписку', icon: <Trash size={15} />,
        disabled: !bridge || !!busy || inUse(state.profiles.filter((p) => p.sourceId === menuSource.id).map((p) => p.id)), confirm: 'Удалить вместе с серверами?', action: () => run('remove', () => bridge!.removeSource(menuSource.id), 'Подписка удалена') },
    ]} />}
    <header className="topbar">
      {view === 'home' ? <div className="picker" ref={pickerRef}>
        <button className="picker-button" aria-haspopup="listbox" aria-expanded={pickerOpen} onContextMenu={(e) => shown ? serverMenu(e, shown.id) : e.preventDefault()} onClick={() => state.profiles.length ? setPickerOpen(!pickerOpen) : openImport()}>
          {shown ? <CountryFlag code={shown.countryCode} /> : state.profiles.length > 0 && <AutoTile />}<span>{locationLabel}</span><ChevronDown size={14} className={pickerOpen ? 'flipped' : ''} />
        </button>
        {pickerOpen && <div className="picker-menu">
          {/* The list scrolls; the actions stay pinned to the bottom of the menu however many servers there are. */}
          <div className="picker-list" role="listbox" aria-label="Локация">
          <button role="option" aria-selected={state.selectedId === 'auto'} className="picker-option" onClick={() => choose('auto')}><AutoTile /><span className="picker-text"><strong>Автовыбор</strong><small>Лучший доступный сервер</small></span>{state.selectedId === 'auto' && <Check size={15} />}</button>
          {state.profiles.map((p) => <button key={p.id} role="option" aria-selected={state.selectedId === p.id} aria-label={`Выбрать ${privateText(p.name)}`} className="picker-option" onClick={() => choose(p.id)} onContextMenu={(e) => serverMenu(e, p.id)}>
            <CountryFlag code={p.countryCode} />
            <span className="picker-text"><strong>{place(p)}</strong><small>VLESS · {security(p)} · {transport(p)}{addressesVisible ? ` · ${p.address}:${p.port}` : ''}</small></span>
            <span className={`picker-latency ${p.lastTest?.status || ''}`}>{latency(p)}</span>{state.selectedId === p.id && <Check size={15} />}
          </button>)}
          </div>
          <div className="picker-actions">
            <button className="button text" disabled={state.checking || !!busy} onClick={() => run('test', () => bridge!.test())}>{state.checking ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}{state.checking ? 'Проверяем…' : 'Проверить задержку'}</button>
            <button className="button text" onClick={openImport}><Plus size={14} />Добавить подписку</button>
          </div>
        </div>}
      </div> : <span />}
      <div className="topbar-right">
        {view === 'home' && <button className="link-button" onClick={() => { setPickerOpen(false); setView('settings'); }}>Настройки</button>}
        <div className="window-controls"><button aria-label="Свернуть" title="Свернуть" className="window-min" onClick={() => bridge?.minimize()} /><button aria-label="Закрыть" title="Закрыть" className="window-close" onClick={() => bridge?.close()} /></div>
      </div>
    </header>

    {/* Quiet cards in the bottom-right corner instead of banners across the window. */}
    <div className="notices" aria-live="polite">
      {!bridge && <Card title="Предпросмотр">Для подключения откройте настольное приложение.</Card>}
      {update && update.version && ['available', 'downloading', 'ready'].includes(update.status) && hiddenUpdate !== update.version && <Card title={`Вышла версия ${update.version}`}
        onClose={update.status === 'available' ? () => setHiddenUpdate(update.version!) : undefined}
        action={<button className="card-action" disabled={update.status !== 'available' || !!busy || connecting} onClick={() => run('update', () => bridge!.installUpdate())}>
          {update.status === 'downloading' ? <><LoaderCircle size={13} className="spin" />Скачиваем… {Math.round(update.progress * 100)}%</> : update.status === 'ready' ? <><LoaderCircle size={13} className="spin" />Перезапускаем…</> : 'Обновить'}
        </button>}>
        {update.error || `У вас ${state.version}. JOXY скачает новую версию с GitHub, сверит контрольную сумму и перезапустится${connected ? ', VPN подключится снова' : ''}.`}
      </Card>}
      {conflictShown && <Card tone="warning" title="Включён другой VPN" onClose={() => setHiddenConflict(conflictKey)}
        action={<button className="card-action" disabled={busy === 'environment'} onClick={() => run('environment', () => bridge!.environment())}><RefreshCw size={13} className={busy === 'environment' ? 'spin' : ''} />{busy === 'environment' ? 'Проверяем…' : 'Проверить снова'}</button>}>
        Отключите {foreignNames.length ? foreignNames.map((name, i) => <span key={name}>{i > 0 && ', '}<span className="chip">{privateText(name)}</span></span>) : 'его'}, пожалуйста. Пока он работает, JOXY не сможет подключиться.
      </Card>}
      {failed && state.connection.errorCode === 'wfp-blocked' && state.settings.tunDnsProtection !== false && <Card tone="warning" title="Защита DNS не включилась"
        action={<button className="card-action" disabled={!!busy} onClick={() => run('connection', async () => { await bridge!.settings({ tunDnsProtection: false }); await bridge!.connect(); })}>Подключиться без защиты DNS</button>}>
        Windows не приняла правила фильтрации, которые не пускают запросы DNS мимо VPN. Можно подключиться без защиты, а вернуть её — в настройках.
      </Card>}
      {state.core.error && <Card tone="danger" title="Ядро недоступно">{privateText(state.core.error)}</Card>}
      {adminPrompt && mode === 'tun' && !state.environment.elevated && <Card tone="warning" title="Права администратора не получены" onClose={() => setAdminPrompt(false)}
        action={<button className="card-action" disabled={!!busy} onClick={elevateAndConnect}><ShieldCheck size={13} />Запросить снова</button>}>
        Без них Windows не даст создать адаптер TUN. Можно повторить запрос или выбрать системный прокси в настройках.
      </Card>}
      {state.killSwitch?.armed && !connected && <Card tone="warning" title="Интернет заблокирован"
        action={<button className="card-action" disabled={!!busy || connecting} onClick={() => run('disconnect', () => bridge!.disconnect(), 'Блокировка снята')}>Снять блокировку</button>}>
        Kill switch держит блокировку, пока VPN не восстановится.
      </Card>}
    </div>

    {view === 'home' ? <>
      <main className={`stage is-${state.connection.phase}`}>
        <WorldMap iso={iso} tone={connected ? 'connected' : shown ? 'selected' : 'idle'} focus={connected || connecting} servers={serverCountries} />
        <div className="status" aria-live="polite">
          <h1>{connected && <span className="live-dot" />}{title}</h1>
          <div className="timer mono">{connected ? elapsed(state.connection.since, now) : '--:--:--'}</div>
          {failed && !(state.connection.errorCode === 'vpn-conflict' && state.environment.tunActive) && !(state.connection.errorCode === 'wfp-blocked' && state.settings.tunDnsProtection !== false) && <p className="connection-error" role="alert">{privateText(state.connection.error)}</p>}
          {state.profiles.length
            ? <button className={`power ${connected ? 'on' : ''}`} aria-label={connected ? 'Отключиться' : connecting ? 'Подключение…' : 'Подключиться'} aria-pressed={connected} disabled={connecting || !state.core.ready || !!busy} onClick={() => { if (!connected && mode === 'tun' && !state.environment.elevated) { elevateAndConnect(); return; } run('connection', () => connected ? bridge!.disconnect() : bridge!.connect()); }}>{connecting ? <LoaderCircle className="spin" size={28} /> : <Power size={28} />}</button>
            : <button className="button primary add-first" onClick={openImport}><Plus size={16} />Добавить подписку</button>}
        </div>
      </main>
      <footer className="statsbar">
        <span>{destination ? `VLESS · ${security(destination)} · ${transport(destination)}` : 'VLESS · Reality'}{connected && state.connection.latency != null ? ` · ${state.connection.latency} мс` : ''}</span>
        <span><ArrowDown size={14} />{bytes(connected ? state.stats.down : 0)}</span>
        <span><ArrowUp size={14} />{bytes(connected ? state.stats.up : 0)}</span>
      </footer>
    </> : <SettingsView state={state} bridge={bridge} busy={busy} run={run} back={() => setView('home')} privateText={privateText} addressesVisible={addressesVisible} setAddressesVisible={setAddressesVisible} openImport={openImport} now={now} serverMenu={serverMenu} />}

    {toast && <div role="status" className={`toast ${toast.error ? 'error' : ''}`}>{toast.error ? <CircleAlert size={17} /> : <Check size={17} />}<span>{privateText(toast.message)}</span><button aria-label="Закрыть уведомление" onClick={() => setToast(null)}><X size={14} /></button></div>}
    {importOpen && <div className="modal-backdrop" onPointerDown={(e) => { backdropPress.current = e.target === e.currentTarget; }} onClick={(e) => { if (backdropPress.current && e.target === e.currentTarget && !busy) setImportOpen(false); backdropPress.current = false; }}><section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title" onKeyDown={modalKeys} onClick={(e) => e.stopPropagation()}><button className="modal-close icon-button" aria-label="Закрыть импорт" disabled={!!busy} onClick={() => setImportOpen(false)}><X size={18} /></button><h2 id="import-title">Добавить подключение</h2><p>Вставьте ссылку подписки, VLESS или Xray JSON.</p><label className="field-label" htmlFor="import-value">Ссылка или конфигурация</label><textarea ref={importRef} id="import-value" value={importText} onChange={(e) => { setImportText(e.target.value); setImportError(''); }} placeholder="https://example.com/subscription" spellCheck={false} aria-invalid={!!importError} aria-describedby={importError ? 'import-error' : 'import-help'} />{importError ? <p id="import-error" className="field-error" role="alert">{privateText(importError)}</p> : <p id="import-help" className="field-hint">Профили сохраняются на этом устройстве в зашифрованном виде.</p>}<div className="modal-actions"><button className="button secondary" disabled={!!busy} onClick={() => run('file', async () => { const r = await bridge!.importFile(); if (r) { setImportOpen(false); setToast({ message: `Добавлено: ${countProfiles(r.count)}` }); } })}><FileInput size={15} />Из файла</button><button className="button primary" disabled={!importText.trim() || !!busy} onClick={importSubmit}>{busy === 'import' && <LoaderCircle size={15} className="spin" />}{busy === 'import' ? 'Добавляем…' : 'Добавить'}</button></div></section></div>}
  </div>;
}

function Card({ tone = '', title, children, action, onClose }: { tone?: '' | 'warning' | 'danger'; title: string; children: ReactNode; action?: ReactNode; onClose?: () => void }) {
  return <div className={`card ${tone}`} role="status">
    <div className="card-body"><strong>{title}</strong><p>{children}</p>{action}</div>
    {onClose && <button className="card-close" aria-label="Скрыть" onClick={onClose}><X size={13} /></button>}
  </div>;
}
