import type { Profile, Settings } from './types';

export const bytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} ГБ` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : n >= 1024 ? `${(n / 1024).toFixed(1)} КБ` : `${Math.round(n)} Б`;
export const elapsed = (since: string | null, now: number) => {
  const s = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
  return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, '0')).join(':');
};
export const transport = (p: Profile) => p.transport === 'raw' ? (p.flow ? 'Vision' : 'TCP') : p.transport === 'grpc' ? 'gRPC' : p.transport.toUpperCase();
export const security = (p: Profile) => p.security === 'reality' ? 'Reality' : p.security === 'tls' ? 'TLS' : p.security.toUpperCase();
export const countProfiles = (n: number) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'профиль' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'профиля' : 'профилей'}`;

export const settingsDefaults: Settings = { mode: 'system', systemProxy: true, autoFallback: true, timeout: 8000, interface: 'auto', closeToTray: true, dnsProvider: 'cloudflare', bypassLan: true, directRules: [], tunMtu: 1400, tunIpv6: 'block', tunDnsProtection: true, killSwitch: false, autoConnect: false, theme: 'system' };
