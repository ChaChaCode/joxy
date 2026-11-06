import { isIP } from 'node:net';

export const defaultSettings = () => ({
  mode: 'system', systemProxy: true, autoFallback: true, timeout: 8000, interface: 'auto', closeToTray: true,
  dnsProvider: 'cloudflare', bypassLan: true, bypassRu: false, directRules: [], tunMtu: 1400, tunIpv6: 'block', tunDnsProtection: true, killSwitch: false, autoConnect: false, theme: 'system',
});
export const networkKeys = ['mode', 'interface', 'dnsProvider', 'bypassLan', 'bypassRu', 'directRules', 'tunMtu', 'tunIpv6', 'tunDnsProtection'];
// Russian national domains, .рф and .москва in punycode: with bypassRu their sites open without the VPN. Russian
// services on .com or .net are not caught; they go in the direct rules by hand.
export const russianDomains = ['domain:ru', 'domain:su', 'domain:xn--p1ai', 'domain:xn--80adxhks'];
export function normalizeSettings(value = {}) {
  const mode = ['system', 'tun', 'local'].includes(value.mode) ? value.mode : value.systemProxy === false ? 'local' : 'system';
  return { ...defaultSettings(), ...value, mode, systemProxy: mode === 'system' };
}
export function parseDirectRules(value) {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Не более 128 исключений маршрутизации.');
  const domains = [], ips = [], normalized = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.length > 253) throw new Error('Некорректное исключение маршрутизации.');
    const line = raw.trim().toLowerCase().replace(/^\*\./, '');
    if (!line) continue;
    const parts = line.split('/'), family = isIP(parts[0]);
    if (family) {
      const prefix = parts.length === 1 ? family === 4 ? 32 : 128 : Number(parts[1]);
      if (parts.length > 2 || parts.length === 2 && !/^\d+$/.test(parts[1]) || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) throw new Error('Неверная маска IP-подсети.');
      const cidr = `${parts[0]}/${prefix}`; ips.push(cidr); normalized.push(cidr);
    } else {
      if (parts.length !== 1 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(line)) throw new Error('Укажите домен без https:// или IP-подсеть, по одному на строку.');
      domains.push(`domain:${line}`); normalized.push(line);
    }
  }
  return { domains: [...new Set(domains)], ips: [...new Set(ips)], normalized: [...new Set(normalized)] };
}
export function settingsPatch(current, patch, interfaces = []) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Некорректные настройки.');
  const next = normalizeSettings(current);
  if (patch.mode != null) { if (!['system', 'tun', 'local'].includes(patch.mode)) throw new Error('Неизвестный режим подключения.'); next.mode = patch.mode; }
  else if (typeof patch.systemProxy === 'boolean') next.mode = patch.systemProxy ? 'system' : 'local';
  for (const key of ['autoFallback', 'closeToTray', 'bypassLan', 'bypassRu', 'tunDnsProtection', 'killSwitch', 'autoConnect']) {
    if (key in patch) { if (typeof patch[key] !== 'boolean') throw new Error('Некорректный переключатель.'); next[key] = patch[key]; }
  }
  if (patch.timeout != null) { if (![5000, 8000, 12000].includes(patch.timeout)) throw new Error('Некорректный тайм-аут.'); next.timeout = patch.timeout; }
  if (patch.interface != null) { if (patch.interface !== 'auto' && !interfaces.includes(patch.interface)) throw new Error('Сетевой интерфейс не найден.'); next.interface = patch.interface; }
  if (patch.dnsProvider != null) { if (!['cloudflare', 'google'].includes(patch.dnsProvider)) throw new Error('Неизвестный DNS-провайдер.'); next.dnsProvider = patch.dnsProvider; }
  if (patch.tunMtu != null) { if (!Number.isInteger(patch.tunMtu) || patch.tunMtu < 1280 || patch.tunMtu > 9000) throw new Error('MTU должен быть от 1280 до 9000.'); next.tunMtu = patch.tunMtu; }
  if (patch.tunIpv6 != null) { if (!['block', 'tunnel'].includes(patch.tunIpv6)) throw new Error('Неверный режим IPv6.'); next.tunIpv6 = patch.tunIpv6; }
  if (patch.theme != null) { if (!['system', 'light', 'dark'].includes(patch.theme)) throw new Error('Неизвестная тема.'); next.theme = patch.theme; }
  if (patch.directRules != null) next.directRules = parseDirectRules(patch.directRules).normalized;
  next.systemProxy = next.mode === 'system';
  return next;
}
