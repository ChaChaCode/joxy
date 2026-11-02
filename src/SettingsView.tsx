import { useEffect, useState, type ReactNode } from 'react';
import { Activity, ArrowDown, Check, CircleAlert, CircleCheck, Clock3, Download, Eye, Globe2, LoaderCircle, Network, Plus, RefreshCw, Servers, Settings2 } from './icons';
import type { Bridge, Settings, State } from './types';
import { Select } from './Select';
import { ServerGroup } from './ServerGroup';
import { CountryFlag } from './CountryFlag';
import { countProfiles, transport } from './format';

type Section = 'general' | 'connection' | 'routing' | 'privacy' | 'subscriptions' | 'diagnostics';
const sections: { id: Section; label: string; icon: typeof Settings2 }[] = [
  { id: 'general', label: 'Основные', icon: Settings2 },
  { id: 'connection', label: 'Подключение', icon: Network },
  { id: 'routing', label: 'Маршрутизация', icon: Globe2 },
  { id: 'privacy', label: 'Приватность', icon: Eye },
  { id: 'subscriptions', label: 'Подписки', icon: Servers },
  { id: 'diagnostics', label: 'Диагностика', icon: Activity },
];

function Row({ title, description, note, children, disabled }: { title: string; description?: string; note?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return <div className={`row ${disabled ? 'is-disabled' : ''}`}><div className="row-text"><h3>{title}</h3>{description && <p>{description}</p>}{note}</div><div className="row-control">{children}</div></div>;
}
function Toggle({ label, value, disabled, change }: { label: string; value: boolean; disabled?: boolean; change: (v: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={value} className={`toggle ${value ? 'on' : ''}`} disabled={disabled} onClick={() => change(!value)}><span /></button>;
}
function Segmented<T extends string>({ label, value, options, disabled, change }: { label: string; value: T; options: [T, string][]; disabled?: boolean; change: (v: T) => void }) {
  return <div className="segmented" role="radiogroup" aria-label={label}>{options.map(([id, text]) => <button key={id} role="radio" aria-checked={value === id} className={value === id ? 'on' : ''} disabled={disabled} onClick={() => change(id)}>{text}</button>)}</div>;
}

export function SettingsView({ state, bridge, busy, run, back, privateText, addressesVisible, setAddressesVisible, openImport, now }: {
  state: State; bridge?: Bridge; busy: string; run: (label: string, action: () => Promise<unknown>, success?: string) => Promise<void>;
  back: () => void; privateText: (s?: string | null) => string; addressesVisible: boolean; setAddressesVisible: (v: boolean) => void; openImport: () => void; now: number;
}) {
  const [section, setSection] = useState<Section>('general');
  const s = state.settings;
  const [rules, setRules] = useState(s.directRules.join('\n'));
  useEffect(() => { setRules(s.directRules.join('\n')); }, [s.directRules.join('\n')]);
  const locked = !!busy || state.checking || state.connection.phase === 'connecting';
  const apply = (patch: Partial<Settings>) => run('settings', () => bridge ? bridge.settings(patch) : Promise.reject(new Error('Desktop application required.')));
  const tun = s.mode === 'tun';
  const needsAdmin = tun && !state.environment.elevated || state.environment.recoveryRequired;
  const rulesDirty = rules.split(/\r?\n/).map((r) => r.trim()).filter(Boolean).join('\n') !== s.directRules.join('\n');
  const good = state.profiles.filter((p) => p.lastTest?.status === 'ok').length;

  return <div className="settings">
    <div className="settings-head"><button className="back" aria-label="Назад" onClick={back}><ArrowDown size={18} /></button><h1>Настройки</h1></div>
    <div className="settings-body">
      <nav className="settings-nav" aria-label="Разделы настроек">{sections.map((x) => <button key={x.id} aria-current={section === x.id ? 'page' : undefined} className={section === x.id ? 'on' : ''} onClick={() => setSection(x.id)}><x.icon size={18} weight={section === x.id ? 'fill' : 'regular'} /><span>{x.label}</span></button>)}</nav>
      <div className="settings-panel">

        {section === 'general' && <>
          <Row title="Режим" description={tun ? 'Весь трафик приложений через виртуальный адаптер.' : s.mode === 'system' ? 'Браузеры и приложения, которые используют прокси Windows.' : 'HTTP и SOCKS для ручной настройки отдельных приложений.'} note={needsAdmin ? <span className="row-note">{state.environment.recoveryRequired ? 'Нужно восстановить прошлую TUN-сессию.' : 'Права администратора не получены.'} <button className="inline-link" disabled={locked} onClick={() => run('elevate', () => bridge ? bridge.elevate({ mode: 'tun' }) : Promise.reject(new Error('Desktop application required.')))}>Запросить права</button></span> : undefined}>
            <Select label="Режим подключения" disabled={locked} value={s.mode} options={[{ value: 'tun', label: 'TUN', disabled: !state.core.tunReady }, { value: 'system', label: 'Системный прокси' }, { value: 'local', label: 'Локальный прокси' }]}
              change={(mode) => { if (mode === 'tun' && !state.environment.elevated) run('elevate', () => bridge ? bridge.elevate({ mode }) : Promise.reject(new Error('Desktop application required.'))); else apply({ mode }); }} />
          </Row>
          <Row title="Автоподключение" description="Подключаться при запуске приложения."><Toggle label="Автоподключение" value={!!s.autoConnect} disabled={locked} change={(v) => apply({ autoConnect: v })} /></Row>
          <Row title="Kill Switch" description={tun ? 'Блокировать интернет при разрыве VPN-соединения.' : 'Доступен в режиме TUN.'} disabled={!tun}><Toggle label="Kill switch" value={s.killSwitch} disabled={locked || !tun} change={(v) => apply({ killSwitch: v })} /></Row>
          <Row title="Защита DNS" description={tun ? 'Запросы DNS только через VPN, по DNS over HTTPS.' : 'Доступна в режиме TUN.'} disabled={!tun}><Toggle label="Защита DNS" value={s.tunDnsProtection} disabled={locked || !tun} change={(v) => apply({ tunDnsProtection: v })} /></Row>
          <Row title="Локальная сеть" description="Разрешить доступ к устройствам в локальной сети."><Toggle label="Локальная сеть" value={s.bypassLan} disabled={locked} change={(v) => apply({ bypassLan: v })} /></Row>
          <Row title="Сворачивать в трей" description="При закрытии окна подключение продолжит работать."><Toggle label="Сворачивать в трей" value={s.closeToTray} disabled={locked} change={(v) => apply({ closeToTray: v })} /></Row>
          <Row title="Тема" description="Внешний вид приложения."><Segmented label="Тема" value={s.theme || 'system'} disabled={locked} options={[['light', 'Светлая'], ['dark', 'Тёмная'], ['system', 'Система']]} change={(v) => apply({ theme: v })} /></Row>
          <p className="about">JOXY {state.version} · Xray {state.core.version || '—'}</p>
        </>}

        {section === 'connection' && <>
          <Row title="Сетевой интерфейс" description="Подключение, через которое JOXY выходит к серверу."><Select label="Сетевой интерфейс" disabled={locked} value={s.interface} options={[{ value: 'auto', label: 'Автоматически' }, ...state.environment.interfaces.map((i) => ({ value: i, label: i }))]} change={(v) => apply({ interface: v })} /></Row>
          <Row title="Резервный маршрут" description="При потере связи пробовать другие серверы."><Toggle label="Резервный маршрут" value={s.autoFallback} disabled={locked} change={(v) => apply({ autoFallback: v })} /></Row>
          <Row title="Тайм-аут проверки" description="Сколько ждать ответа сервера."><Select label="Тайм-аут проверки" disabled={locked} value={s.timeout} options={[{ value: 5000, label: '5 секунд' }, { value: 8000, label: '8 секунд' }, { value: 12000, label: '12 секунд' }]} change={(v) => apply({ timeout: v })} /></Row>
          <Row title="DNS-провайдер" description="DNS over HTTPS через VPN в режиме TUN." disabled={!tun}><Select label="DNS-провайдер" disabled={locked || !tun} value={s.dnsProvider} options={[{ value: 'cloudflare', label: 'Cloudflare' }, { value: 'google', label: 'Google' }]} change={(v) => apply({ dnsProvider: v })} /></Row>
          <Row title="IPv6" description="Блокировать IPv6 или передавать его через туннель." disabled={!tun}><Select label="Режим IPv6" disabled={locked || !tun} value={s.tunIpv6} options={[{ value: 'block', label: 'Блокировать' }, { value: 'tunnel', label: 'Через TUN' }]} change={(v) => apply({ tunIpv6: v })} /></Row>
          <Row title="MTU" description="Размер пакета в TUN. 1400 подходит большинству сетей." disabled={!tun}><Select label="MTU" disabled={locked || !tun} value={s.tunMtu} options={[1280, 1400, 1500].map((n) => ({ value: n, label: String(n) }))} change={(v) => apply({ tunMtu: v })} /></Row>
          {state.connection.phase === 'connected' && <p className="hint">Сетевые изменения переподключат VPN. При ошибке вернутся прежние настройки.</p>}
        </>}

        {section === 'routing' && <>
          <div className="rules">
            <h3>Раздельное туннелирование</h3>
            <p>Сайты и подсети, которые открываются напрямую, без VPN. По одному на строку; домены включают поддомены.</p>
            <textarea aria-label="Адреса без VPN" spellCheck={false} disabled={locked} value={rules} placeholder={'example.com\n192.168.10.0/24'} onChange={(e) => setRules(e.target.value)} />
            <div className="rules-actions"><span>{s.directRules.length ? `Сейчас без VPN: ${s.directRules.length}` : 'Весь трафик идёт через VPN.'}</span><button className="button primary" disabled={locked || !rulesDirty} onClick={() => run('rules', () => bridge!.settings({ directRules: rules.split(/\r?\n/).map((r) => r.trim()).filter(Boolean) }), 'Маршрутизация сохранена')}>Сохранить</button></div>
          </div>
        </>}

        {section === 'privacy' && <>
          <Row title="Показывать адреса" description="IP-адреса и домены серверов скрыты всегда. Показ действует 30 секунд и выключается при смене экрана."><Toggle label="Показывать адреса" value={addressesVisible} change={setAddressesVisible} /></Row>
          <Row title="Хранение профилей" description="Подписки и ключи зашифрованы Windows DPAPI и доступны только вашей учётной записи."><span className="row-value"><CircleCheck size={16} />Зашифровано</span></Row>
          <Row title="Внешние сервисы" description="JOXY не обращается к GeoIP и аналитике. Страна сервера берётся из подписки."><span className="row-value"><CircleCheck size={16} />Не используются</span></Row>
          <Row title="Отчёт для поддержки" description="Без адресов, ключей и названий серверов."><button className="button secondary" disabled={!!busy} onClick={() => run('export', () => bridge!.exportDiagnostics(), 'Отчёт сохранён')}><Download size={15} />Сохранить</button></Row>
        </>}

        {section === 'subscriptions' && <>
          <div className="section-actions"><span>{countProfiles(state.profiles.length)}</span><button className="button text" disabled={state.checking || !state.profiles.length || !!busy} onClick={() => run('test', () => bridge!.test())}>{state.checking ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}Проверить все</button><button className="button text" disabled={!!busy || !state.sources.some((x) => x.remote)} onClick={() => run('refresh', () => bridge!.refresh(), 'Подписки обновлены')}><RefreshCw size={14} className={busy === 'refresh' ? 'spin' : ''} />Обновить</button><button className="button primary" onClick={openImport}><Plus size={15} />Добавить</button></div>
          <div className="subscription-groups">{state.sources.map((source) => {
            const profiles = state.profiles.filter((p) => p.sourceId === source.id);
            return <ServerGroup key={source.id} source={{ ...source, label: privateText(source.label), announcement: privateText(source.announcement) }} count={profiles.length} current={state.connection.phase === 'connected' && profiles.some((p) => p.id === state.connection.profileId)} now={now} busy={!!busy} checking={state.checking} refresh={() => run('refresh', () => bridge!.refresh(source.id), 'Подписка обновлена')} test={() => run('test', () => bridge!.test(source.id))} open={(kind) => run('provider', () => bridge!.openProvider(source.id, kind))}>
              {profiles.map((p) => <div className="sub-server" key={p.id}><CountryFlag code={p.countryCode} /><span><strong>{privateText(p.name)}</strong><small>VLESS · {transport(p)} · {p.security.toUpperCase()}{addressesVisible ? ` · ${p.address}:${p.port}` : ''}</small></span><em className={p.lastTest?.status || ''}>{p.lastTest?.status === 'ok' ? `${p.lastTest.latency} мс` : p.lastTest?.status === 'error' ? 'Недоступен' : p.lastTest?.status === 'checking' ? 'Проверка…' : 'Не проверен'}</em></div>)}
            </ServerGroup>;
          })}</div>
          {!state.profiles.length && <p className="hint">Подписок пока нет.</p>}
        </>}

        {section === 'diagnostics' && <>
          <div className="diag-grid">
            <div><span>Ядро</span><strong>{state.core.ready ? `Xray ${state.core.version}` : 'Недоступно'}</strong></div>
            <div><span>Сеть</span><strong>{state.environment.interface || 'Автоматически'}</strong></div>
            <div><span>Доступно серверов</span><strong>{good} из {state.profiles.length}</strong></div>
          </div>
          <div className="section-actions"><span>Журнал</span><button className="button text" onClick={() => run('export', () => bridge!.exportDiagnostics(), 'Отчёт сохранён')}><Download size={14} />Сохранить отчёт</button></div>
          <div className="log">{[...state.logs].reverse().slice(0, 80).map((l) => <div className={`log-line ${l.level}`} key={l.id}>{l.level === 'error' ? <CircleAlert size={13} /> : l.level === 'warning' ? <Clock3 size={13} /> : <Check size={13} />}<time>{new Date(l.time).toLocaleTimeString('ru-RU')}</time><span>{privateText(l.message)}</span></div>)}{!state.logs.length && <p className="hint">Событий пока нет.</p>}</div>
        </>}
      </div>
    </div>
  </div>;
}
