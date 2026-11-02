import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';

const vite = await createServer({ server: { host: '127.0.0.1', port: 5178 } });
await vite.listen();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 660 }, deviceScaleFactor: 1, colorScheme: 'light' });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const subscribers = [];
    const state = {
      version: '0.6.0', profiles: ['ZAGRAN', 'ZAGRAN XHTTP', 'ZAGRAN GRPC'].map((name, i) => ({ id: String(i), name, countryCode: 'NL', address: '192.0.2.10', port: [443, 444, 6437][i], transport: ['raw', 'xhttp', 'grpc'][i], security: 'reality', flow: i === 0 ? 'xtls-rprx-vision' : '', fragment: i === 0, sourceId: 'test', lastTest: null })),
      sources: [{ id: 'test', label: 'Test subscription', host: 'example.com', updatedAt: new Date().toISOString(), count: 3, remote: true, usage: { upload: 1073741824, download: 4294967296, total: 107374182400, expire: Math.floor(Date.now() / 1000) + 86400 * 26 }, announcement: 'Информация провайдера о подписке.', supportUrl: 'https://example.com/help', websiteUrl: 'https://example.com/account' }], selectedId: 'auto', checking: false,
      settings: { mode: 'system', systemProxy: true, autoFallback: true, timeout: 8000, interface: 'auto', closeToTray: true, dnsProvider: 'cloudflare', bypassLan: true, directRules: [], tunMtu: 1400, tunIpv6: 'block', tunDnsProtection: true, killSwitch: false, autoConnect: false, theme: 'system' },
      connection: { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false },
      stats: { down: 0, up: 0, downRate: 0, upRate: 0, history: [] },
      logs: [{ id: 'test', time: new Date().toISOString(), level: 'info', message: 'UI fixture: 192.0.2.10:443, not production data.' }],
      environment: { interface: 'Ethernet', interfaces: ['Ethernet'], tunActive: false, windows: true, elevated: false }, core: { ready: true, tunReady: true, version: '26.10.31', error: null },
    };
    const emit = () => subscribers.forEach((s) => s(structuredClone(state)));
    window.__joxyFixture = { usage: (usage) => { state.sources[0].usage = usage; emit(); }, vpn: (active, notify = true) => { state.environment.tunActive = active; state.environment.foreignTunnels = active ? [{ name: 'throne-tun', routeCount: 44 }] : []; if (notify) emit(); } };
    window.joxy = {
      state: async () => structuredClone(state), onState: (s) => { subscribers.push(s); return () => {}; },
      select: async (id) => { state.selectedId = id; emit(); },
      connect: async () => { if (state.environment.tunActive) { const error = 'Обнаружены маршруты TUN другого VPN (throne-tun).'; state.connection = { ...state.connection, phase: 'error', error, errorCode: 'vpn-conflict' }; emit(); throw new Error(error); } state.connection = { phase: 'connected', profileId: state.selectedId === 'auto' ? '1' : state.selectedId, since: new Date().toISOString(), exitIP: '192.0.2.10', latency: 124, systemProxy: true }; emit(); },
      disconnect: async () => { state.connection = { phase: 'idle', profileId: null, since: null, exitIP: null, latency: null, systemProxy: false }; emit(); },
      test: async () => { state.profiles.forEach((p, i) => p.lastTest = { status: 'ok', latency: 120 + i * 10 }); emit(); },
      settings: async (p) => { Object.assign(state.settings, p); emit(); },
      elevate: async () => { throw new Error('Windows не подтвердила запуск с правами администратора.'); },
      import: async (text) => { if (!text.startsWith('https://')) throw new Error('Подписка должна использовать HTTPS.'); return { count: 3, rejected: [] }; },
      refresh: async () => {}, openProvider: async () => {}, importFile: async () => null, exportDiagnostics: async () => true, minimize: async () => {}, close: async () => {}, environment: async () => { if (!state.environment.tunActive && state.connection.errorCode === 'vpn-conflict') state.connection = { phase: 'idle', systemProxy: false }; emit(); return state.environment; },
    };
  });
  await page.goto('http://127.0.0.1:5178');
  await page.locator('.world-map').waitFor();
  const fonts = await page.evaluate(async () => {
    const loaded = await Promise.all([
      document.fonts.load('600 19px "Golos Text"', 'Подключение JOXY'),
      document.fonts.load('500 16px "Geist Mono"', '192.0.2.96 00:12:34 мс'),
    ]);
    await document.fonts.ready;
    return loaded.map((faces) => faces.length > 0 && faces.every((face) => face.status === 'loaded'));
  });
  assert.deepEqual(fonts, [true, true], 'Local fonts must load Cyrillic, Latin and live figures');
  await mkdir('artifacts', { recursive: true });
  await page.waitForTimeout(600);
  const shot = (name) => page.screenshot({ path: `artifacts/${name}.png`, animations: 'disabled' });
  const text = () => page.locator('body').innerText();
  const saved = () => page.evaluate(() => window.joxy.state());
  assert.equal(await page.title(), 'JOXY');

  // Home: auto selection, nothing private on screen.
  assert.equal((await page.locator('.picker-button').innerText()).trim(), 'Автовыбор');
  assert.equal(await page.locator('.world-map').getAttribute('data-servers'), 'NL', 'Countries with servers stay marked without a selection');
  await page.getByRole('heading', { name: 'Готово к подключению' }).waitFor();
  assert.equal(await page.locator('.timer').innerText(), '--:--:--');
  assert.ok(!(await text()).includes('192.0.2.10'));
  await shot('home');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'No horizontal overflow');

  // Location picker: flags, options, Escape closes it.
  await page.locator('.picker-button').click();
  assert.equal(await page.getByAltText('Флаг: Нидерланды').count(), 3);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.picker-menu').count(), 0);

  // Another VPN: one banner, no toast, no repeated error under the button.
  await page.evaluate(() => window.__joxyFixture.vpn(true));
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await page.locator('.stage.is-error').waitFor();
  assert.equal(await page.locator('.toast.error').count(), 0, 'Do not repeat the conflict in a toast');
  assert.equal(await page.locator('.connection-error').count(), 0, 'The banner explains the conflict once');
  await shot('vpn-conflict');
  await page.evaluate(() => window.__joxyFixture.vpn(false, false));
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).click();
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Готово к подключению' }).waitFor();
  await page.evaluate(() => window.__joxyFixture.vpn(true));
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).waitFor();
  await page.evaluate(() => { window.__joxyFixture.vpn(false, false); window.dispatchEvent(new Event('focus')); });
  await page.getByRole('button', { name: 'Проверить снова', exact: true }).waitFor({ state: 'hidden' });

  // Dragging and wheel move the map; the recenter pill brings it back.
  const map = page.locator('.world-map');
  const box = await map.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 3 + 20, { steps: 6 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Центрировать' }).waitFor();
  await page.mouse.wheel(0, -400);
  await page.getByRole('button', { name: 'Центрировать' }).click();
  await page.getByRole('button', { name: 'Центрировать' }).waitFor({ state: 'hidden' });

  // Selecting a server highlights its country; auto clears it.
  await page.locator('.picker-button').click();
  await page.getByRole('option', { name: 'Выбрать ZAGRAN XHTTP' }).click();
  assert.match(await page.locator('.picker-button').innerText(), /Нидерланды · ZAGRAN XHTTP/);
  await page.locator('.world-map[data-country="NL"][data-tone="selected"]').waitFor();
  await page.locator('.picker-button').click();
  await page.getByRole('option', { name: /Автовыбор/ }).click();
  assert.equal((await page.locator('.picker-button').innerText()).trim(), 'Автовыбор');
  assert.equal(await page.locator('.world-map').getAttribute('data-country'), '');
  await page.locator('.picker-button').click();
  await page.getByRole('option', { name: 'Выбрать ZAGRAN XHTTP' }).click();

  // Connected: green map, live timer, exit IP still hidden.
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await page.locator('.stage.is-connected').waitFor();
  await page.getByRole('heading', { name: 'Подключено' }).waitFor();
  await page.locator('.world-map[data-tone="connected"]').waitFor();
  assert.equal(await page.locator('.power').getAttribute('aria-pressed'), 'true');
  assert.ok(!(await text()).includes('192.0.2.10'), 'Exit IP is also hidden');
  await page.waitForFunction(() => document.querySelector('.timer')?.textContent !== '00:00:00');
  await page.waitForTimeout(900);
  await shot('connected');
  await page.getByRole('button', { name: 'Отключиться', exact: true }).click();
  await page.getByRole('heading', { name: 'Готово к подключению' }).waitFor();

  // Settings: subscriptions and their metadata variants.
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('heading', { name: 'Настройки' }).waitFor();
  await page.getByRole('button', { name: 'Подписки', exact: true }).click();
  await page.locator('.subscription-info').waitFor();
  assert.match(await page.locator('.subscription-info').innerText(), /Осталось 26 дней/);
  assert.equal(await page.getByRole('progressbar').getAttribute('value'), String(5 * 1073741824));
  assert.ok(!(await text()).includes('192.0.2.10'));
  await shot('subscriptions');
  await page.getByRole('button', { name: /Test subscription.*3 сервера/ }).click();
  assert.equal(await page.locator('.sub-server:visible').count(), 0);
  await page.getByRole('button', { name: /Test subscription.*3 сервера/ }).click();
  assert.equal(await page.locator('.sub-server:visible').count(), 3);
  await page.evaluate(() => window.__joxyFixture.usage({ upload: 0, download: 1024, total: 0, expire: 0 }));
  await page.getByText('Без срока действия', { exact: true }).waitFor();
  assert.match(await page.locator('.subscription-traffic').innerText(), /∞/);
  assert.equal(await page.getByRole('progressbar').count(), 0);
  await page.evaluate(() => window.__joxyFixture.usage({ expire: 1000000000, upload: 100, download: 100, total: 100 }));
  await page.getByText('Срок истёк', { exact: true }).waitFor();
  assert.match(await page.locator('.subscription-traffic').innerText(), /Лимит исчерпан/);
  await page.evaluate(() => window.__joxyFixture.usage({ download: 1024 }));
  await page.getByText('Срок не указан', { exact: true }).waitFor();
  assert.match(await page.locator('.subscription-traffic').innerText(), /Неполная статистика/);
  await page.evaluate(() => window.__joxyFixture.usage(null));
  await page.locator('.subscription-missing').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Поддержка', exact: true }).count(), 1, 'Support does not depend on quota headers');

  // Import errors stay at the field; Escape closes.
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ссылка или конфигурация' }).fill('broken');
  await page.getByRole('dialog').getByRole('button', { name: 'Добавить', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Подписка должна использовать HTTPS' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Ссылка или конфигурация' }).getAttribute('aria-invalid'), 'true');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  // Selecting text and releasing the mouse outside the sheet keeps it open; a real click on the backdrop closes it.
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  const field = await page.getByRole('textbox', { name: 'Ссылка или конфигурация' }).boundingBox();
  await page.mouse.move(field.x + 20, field.y + 20); await page.mouse.down();
  await page.mouse.move(20, 600, { steps: 8 }); await page.mouse.up();
  assert.equal(await page.getByRole('dialog').count(), 1, 'Drag-select ending outside must not close the sheet');
  await page.mouse.click(20, 600);
  await page.getByRole('dialog').waitFor({ state: 'hidden' });

  // Privacy: addresses appear only on request and hide again on blur.
  await page.getByRole('button', { name: 'Приватность', exact: true }).click();
  await page.getByRole('switch', { name: 'Показывать адреса' }).click();
  await page.getByRole('button', { name: 'Подписки', exact: true }).click();
  assert.ok((await text()).includes('192.0.2.10:443'));
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.waitForFunction(() => !document.body.innerText.includes('192.0.2.10'));
  await page.getByRole('button', { name: 'Диагностика', exact: true }).click();
  assert.ok(!(await text()).includes('192.0.2.10'), 'Logs are masked too');

  // Settings apply at once.
  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await page.getByRole('switch', { name: 'Резервный маршрут' }).click();
  assert.equal((await saved()).settings.autoFallback, false);
  // The custom drop-down: keyboard opens it, arrows move, Enter picks; Escape closes without a change.
  const timeout = page.getByRole('combobox', { name: 'Тайм-аут проверки' });
  await timeout.focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('listbox', { name: 'Тайм-аут проверки' }).waitFor();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal((await saved()).settings.timeout, 12000);
  assert.equal(await page.getByRole('listbox').count(), 0);
  await timeout.click(); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Escape');
  assert.equal((await saved()).settings.timeout, 12000, 'Escape keeps the value');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Тайм-аут проверки', 'Focus returns to the control');
  await page.getByRole('button', { name: 'Основные', exact: true }).click();
  assert.equal(await page.getByRole('switch', { name: 'Kill switch' }).isDisabled(), true, 'Kill switch needs TUN');
  // Choosing TUN asks Windows for rights at once; a declined prompt leaves the previous mode.
  await page.getByRole('combobox', { name: 'Режим подключения' }).click();
  await page.getByRole('listbox', { name: 'Режим подключения' }).getByRole('option', { name: 'TUN' }).click();
  await page.locator('.toast.error').filter({ hasText: 'Windows не подтвердила' }).waitFor();
  assert.equal((await saved()).settings.mode, 'system', 'Declined elevation keeps the previous mode');
  await page.evaluate(() => window.joxy.settings({ mode: 'tun' }));
  await page.getByText('Права администратора не получены.', { exact: false }).waitFor();
  await page.getByRole('switch', { name: 'Kill switch' }).click();
  assert.equal((await saved()).settings.killSwitch, true);
  await page.getByRole('button', { name: 'Запросить права', exact: true }).click();
  await page.locator('.toast.error').filter({ hasText: 'Windows не подтвердила' }).nth(0).waitFor();
  await page.getByRole('radio', { name: 'Тёмная' }).click();
  assert.equal((await saved()).settings.theme, 'dark');
  await shot('settings');
  await page.getByRole('button', { name: 'Маршрутизация', exact: true }).click();
  await page.getByLabel('Адреса без VPN').fill('example.com\n203.0.113.0/24');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  assert.deepEqual((await saved()).settings.directRules, ['example.com', '203.0.113.0/24']);

  // Compact window, dark theme, reduced motion.
  await page.setViewportSize({ width: 760, height: 580 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Settings fit the minimum window');
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Home fits the minimum window');
  // TUN without rights: the press asks Windows for them; a declined prompt explains itself in a card.
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await page.locator('.card').filter({ hasText: 'Права администратора не получены' }).waitFor();
  assert.equal((await saved()).connection.phase, 'idle', 'No connection attempt without rights');
  await shot('compact');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  assert.equal(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), true);
  await shot('dark');
  assert.deepEqual(errors, []);
  console.log('UI verified: location picker, map states, VPN conflict, privacy, subscriptions, import errors, settings, compact and dark layouts.');
} finally { await browser.close(); await vite.close(); }
