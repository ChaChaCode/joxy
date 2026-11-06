import { useState, type MouseEvent, type ReactNode } from 'react';
import { ArrowsDownUp, CellSignal, Calendar, Check, ChevronDown, DotsThree, ExternalLink, InfinityIcon, LifeBuoy, RefreshCw, Stack } from './icons';
import { CountryFlag } from './CountryFlag';
import { transport } from './format';
import type { Profile, Source } from './types';

const formatBytes = (n: number) => {
  const unit = n >= 1024 ** 4 ? 4 : n >= 1024 ** 3 ? 3 : n >= 1024 ** 2 ? 2 : n >= 1024 ? 1 : 0;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: unit ? 1 : 0 }).format(n / 1024 ** unit)} ${['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'][unit]}`;
};
const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const plural = (n: number, one: string, few: string, many: string) => n % 10 === 1 && n % 100 !== 11 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many;

// The subscription's term, traffic and limit, each in its own column with an icon.
function SubscriptionInfo({ source, now }: { source: Source; now: number }) {
  const u = source.usage;
  if (!u) return source.remote ? <p className="subscription-missing">{source.usage === undefined ? 'Обновите подписку, чтобы получить срок действия и данные о трафике.' : 'Провайдер не передал срок действия и данные о трафике.'}</p> : null;
  const complete = u.upload != null && u.download != null;
  const used = complete ? u.upload! + u.download! : null;
  const limited = u.total != null && u.total > 0;
  const expired = !!u.expire && u.expire * 1000 <= now;
  const exhausted = limited && used != null && used >= u.total!;
  const days = u.expire ? Math.ceil((u.expire * 1000 - now) / 86400000) : null;
  return <div className="subscription-info">
    <div className={`info-cell ${expired ? 'expired' : days != null && days <= 3 ? 'soon' : ''}`}>
      <Calendar size={20} />
      <div><span>Осталось</span><strong>{expired ? 'Срок истёк' : days != null ? `${days} ${plural(days, 'день', 'дня', 'дней')}` : u.expire === 0 ? 'Без срока' : 'Не указано'}</strong>
        {u.expire != null && u.expire > 0 && <small>{expired ? 'истекла' : 'до'} {date(u.expire)}</small>}</div>
    </div>
    <div className={`info-cell ${exhausted ? 'expired' : ''}`}>
      <ArrowsDownUp size={20} />
      <div><span>{exhausted ? 'Лимит исчерпан' : 'Трафик подписки'}</span><strong>{used != null ? formatBytes(used) : u.download != null ? `↓ ${formatBytes(u.download)}` : u.upload != null ? `↑ ${formatBytes(u.upload)}` : 'Нет данных'}</strong>
        {limited && used != null && <progress aria-label="Использовано трафика подписки" value={Math.min(used, u.total!)} max={u.total!} />}
        {!complete && (u.upload != null || u.download != null) && <small>Неполная статистика провайдера</small>}</div>
    </div>
    <div className="info-cell">
      <InfinityIcon size={20} />
      <div><span>Лимит</span><strong>{u.total === 0 ? 'Без лимита' : u.total == null ? 'Не указан' : formatBytes(u.total)}</strong>
        {limited && used != null && <small>Доступно {formatBytes(Math.max(0, u.total! - used))}</small>}</div>
    </div>
  </div>;
}

// Four bars for how quick a server answered: under 100 ms all four, then fewer; none for an unreachable one.
function Signal({ profile }: { profile: Profile }) {
  const t = profile.lastTest, ms = t?.status === 'ok' ? t.latency ?? 0 : null;
  const level = ms == null ? 0 : ms < 100 ? 4 : ms < 200 ? 3 : ms < 400 ? 2 : 1;
  return <span className={`signal ${t?.status || ''}`} data-level={level} aria-hidden="true"><i /><i /><i /><i /></span>;
}

// One server as its own card: flag, name and protocol, signal, latency, the in-use mark and its menu.
export function ServerCard({ profile: p, active, name, addressesVisible, onMenu }: { profile: Profile; active: boolean; name: string; addressesVisible: boolean; onMenu: (e: MouseEvent) => void }) {
  const t = p.lastTest;
  return <div className={`sub-server ${active ? 'active' : ''}`} onContextMenu={onMenu}>
    <span className="server-tile"><CountryFlag code={p.countryCode} /></span>
    <span className="server-text"><strong>{name}</strong><small>VLESS · {transport(p)} · {p.security.toUpperCase()}{addressesVisible ? ` · ${p.address}:${p.port}` : ''}</small></span>
    <Signal profile={p} />
    <em className={`latency-pill ${t?.status || ''}`}>{t?.status === 'ok' ? `${t.latency} мс` : t?.status === 'error' ? 'Недоступен' : t?.status === 'checking' ? 'Проверка…' : 'Не проверен'}</em>
    {active && <span className="active-chip"><Check size={13} />Активен</span>}
    <button className="icon-button more" aria-label={`Действия: ${name}`} onClick={onMenu}><DotsThree size={20} /></button>
  </div>;
}

export function ServerGroup({ source, count, current, now, busy, checking, refresh, test, open, onMenu, children }: {
  source: Source; count: number; current: boolean; now: number; busy: boolean; checking: boolean;
  refresh: () => void; test: () => void; open: (kind: 'supportUrl' | 'websiteUrl') => void; onMenu?: (e: MouseEvent) => void; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const contentId = `source-${source.id}`;
  return <section className={`subscription-card ${current ? 'current-subscription' : ''}`} aria-label={`Подписка ${source.label}`}>
    <div className="subscription-header" onContextMenu={onMenu}>
      <button className="subscription-disclosure" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-controls={contentId}>
        <ChevronDown size={17} className={collapsed ? 'collapsed' : ''} />
        <span className="group-tile"><Stack size={22} /></span>
        <span><strong>{source.label}</strong><small>{count} {plural(count, 'сервер', 'сервера', 'серверов')}{current && <span className="provider-current">Подключено</span>}</small></span>
      </button>
      <div className="subscription-actions">
        <button className="icon-button" aria-label={`Проверить ${source.label}`} title="Проверить задержку серверов подписки" disabled={busy || checking || !count} onClick={test}><CellSignal size={16} /></button>
        {source.remote && <button className="icon-button" aria-label={`Обновить ${source.label}`} title="Обновить подписку" disabled={busy} onClick={refresh}><RefreshCw size={16} /></button>}
        {onMenu && <button className="icon-button more" aria-label={`Действия: ${source.label}`} onClick={onMenu}><DotsThree size={20} /></button>}
      </div>
    </div>
    <div id={contentId} hidden={collapsed}>
      <SubscriptionInfo source={source} now={now} />
      {source.announcement && <p className="provider-announcement">{source.announcement}</p>}
      {(source.supportUrl || source.websiteUrl) && <div className="provider-links">{source.supportUrl && <button className="button text" onClick={() => open('supportUrl')}><LifeBuoy size={14} />Поддержка</button>}{source.websiteUrl && <button className="button text" onClick={() => open('websiteUrl')}><ExternalLink size={13} />Личный кабинет</button>}</div>}
      <div className="server-list">{children}</div>
      <div className="subscription-footer"><span>{source.remote ? 'Обновлено' : 'Добавлено'} {new Date(source.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span>{source.remote ? 'Подписка' : 'Локальные профили'}</span></div>
    </div>
  </section>;
}
