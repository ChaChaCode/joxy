import { useState, type MouseEvent, type ReactNode } from 'react';
import { Activity, ChevronDown, ExternalLink, LifeBuoy, RefreshCw } from './icons';
import type { Source } from './types';

const formatBytes = (n: number) => {
  const unit = n >= 1024 ** 4 ? 4 : n >= 1024 ** 3 ? 3 : n >= 1024 ** 2 ? 2 : n >= 1024 ? 1 : 0;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: unit ? 1 : 0 }).format(n / 1024 ** unit)} ${['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'][unit]}`;
};
const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
function SubscriptionInfo({ source, now }: { source: Source; now: number }) {
  const u = source.usage;
  const complete = u?.upload != null && u.download != null;
  const used = complete ? u.upload! + u.download! : null;
  const limited = u?.total != null && u.total > 0;
  const expired = !!u?.expire && u.expire * 1000 <= now;
  const exhausted = limited && used != null && used >= u.total!;
  const days = u?.expire ? Math.ceil((u.expire * 1000 - now) / 86400000) : null;
  const dayWord = days == null ? '' : days % 10 === 1 && days % 100 !== 11 ? 'день' : [2, 3, 4].includes(days % 10) && ![12, 13, 14].includes(days % 100) ? 'дня' : 'дней';
  if (!u) return source.remote ? <p className="subscription-missing">{source.usage === undefined ? 'Обновите подписку, чтобы получить срок действия и данные о трафике.' : 'Провайдер не передал срок действия и данные о трафике.'}</p> : null;
  return <div className="subscription-info">
    <div className={`subscription-expiry ${expired ? 'expired' : days != null && days <= 3 ? 'soon' : ''}`}>
      <strong>{expired ? 'Срок истёк' : days != null ? `Осталось ${days} ${dayWord}` : u.expire === 0 ? 'Без срока действия' : 'Срок не указан'}</strong>
      {u.expire != null && u.expire > 0 && <span>{expired ? 'Истекла' : 'Активна до'} {date(u.expire)}</span>}
    </div>
    <div className={`subscription-traffic ${exhausted ? 'expired' : ''}`}>
      <div><span>{exhausted ? 'Лимит исчерпан' : 'Трафик подписки'}</span><strong>{used != null ? formatBytes(used) : u.download != null ? `↓ ${formatBytes(u.download)}` : u.upload != null ? `↑ ${formatBytes(u.upload)}` : 'Нет данных'}{u.total != null && <span className="traffic-limit"> / {u.total === 0 ? '∞' : formatBytes(u.total)}</span>}</strong></div>
      {limited && used != null && <progress aria-label="Использовано трафика подписки" value={Math.min(used, u.total!)} max={u.total!} />}
      <small>{limited && used != null ? `Доступно ${formatBytes(Math.max(0, u.total! - used))}` : u.total === 0 ? 'Без лимита трафика' : u.total == null ? 'Лимит не указан' : `Лимит ${formatBytes(u.total!)}`}{!complete && (u.upload != null || u.download != null) && ' · Неполная статистика провайдера'}</small>
    </div>
  </div>;
}
export function ServerGroup({ source, count, current, now, busy, checking, refresh, test, open, onMenu, children }: {
  source: Source; count: number; current: boolean; now: number; busy: boolean; checking: boolean;
  refresh: () => void; test: () => void; open: (kind: 'supportUrl' | 'websiteUrl') => void; onMenu?: (e: MouseEvent) => void; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const contentId = `source-${source.id}`;
  return <section className={`subscription-card panel ${current ? 'current-subscription' : ''}`} aria-label={`Подписка ${source.label}`}>
    <div className="subscription-header" onContextMenu={onMenu}>
      <button className="subscription-disclosure" onClick={() => setCollapsed(!collapsed)} aria-expanded={!collapsed} aria-controls={contentId}>
        <ChevronDown size={17} className={collapsed ? 'collapsed' : ''} /><span><strong>{source.label}</strong><small>{count} {count % 10 === 1 && count % 100 !== 11 ? 'сервер' : [2, 3, 4].includes(count % 10) && ![12, 13, 14].includes(count % 100) ? 'сервера' : 'серверов'}{current && <span className="provider-current">Подключено</span>}</small></span>
      </button>
      <div className="subscription-actions">
        {source.remote && <button className="icon-button" aria-label={`Обновить ${source.label}`} title="Обновить подписку" disabled={busy} onClick={refresh}><RefreshCw size={16} /></button>}
        <button className="icon-button" aria-label={`Проверить ${source.label}`} title="Проверить серверы подписки" disabled={busy || checking || !count} onClick={test}><Activity size={17} /></button>
      </div>
    </div>
    <div id={contentId} hidden={collapsed}>
      <SubscriptionInfo source={source} now={now} />
      {source.announcement && <p className="provider-announcement">{source.announcement}</p>}
      {(source.supportUrl || source.websiteUrl) && <div className="provider-links">{source.supportUrl && <button className="button text" onClick={() => open('supportUrl')}><LifeBuoy size={14} />Поддержка</button>}{source.websiteUrl && <button className="button text" onClick={() => open('websiteUrl')}><ExternalLink size={13} />Личный кабинет</button>}</div>}
      <div className="server-table">{children}</div>
      <div className="subscription-footer"><span>{source.remote ? 'Обновлено' : 'Добавлено'} {new Date(source.updatedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span><span>{source.remote ? 'Подписка' : 'Локальные профили'}</span></div>
    </div>
  </section>;
}
