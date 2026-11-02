import { app, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu, safeStorage, nativeTheme, shell, powerMonitor } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { EncryptedStore } from './store.mjs';
import { Controller, redact } from './controller.mjs';
import { SystemProxy, TunGuard } from './network.mjs';
import { providerUrl } from './subscription.mjs';
import { settingsPatch, normalizeSettings } from './settings.mjs';
import { elevate, isElevated, waitForPreviousProcess } from './elevation.mjs';
import { KillSwitch } from './killswitch.mjs';
import { Updater } from './updates.mjs';
import { spawn } from 'node:child_process';

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, '..');
const preferredDataDir = path.join(app.getPath('appData'), 'JOXY');
const previousDataDir = path.join(app.getPath('appData'), 'JOMO');
const legacyDataDir = path.join(app.getPath('appData'), 'ZAGRAN');
// Existing installations retain the original encryption keys and storage path.
const dataDir = process.env.JOXY_TEST_DATA || process.env.JOMO_TEST_DATA || process.env.ZAGRAN_TEST_DATA ||
  (existsSync(path.join(preferredDataDir, 'settings.enc')) ? preferredDataDir :
    existsSync(path.join(previousDataDir, 'settings.enc')) ? previousDataDir :
    existsSync(path.join(legacyDataDir, 'settings.enc')) ? legacyDataDir : preferredDataDir);
app.setPath('userData', dataDir);
app.setName('JOXY');
app.setAppUserModelId('app.joxy.desktop');
let window, tray, controller, updater, quitting = false, cleanupStarted = false;
const resources = app.isPackaged ? process.resourcesPath : path.join(root, 'resources');

await waitForPreviousProcess();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(async (e) => {
    dialog.showErrorBox('JOXY — запуск', redact(e.message));
    try { await controller?.close(); } catch {}
    quitting = true; app.exit(1);
  });
}

async function start() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error('Windows не предоставила шифрование DPAPI. Секретные профили не будут сохранены открытым текстом.');
  const store = new EncryptedStore(dataDir, {
    encrypt: (s) => safeStorage.encryptStringAsync(s),
    decrypt: async (b) => (await safeStorage.decryptStringAsync(b)).result,
  });
  await store.load();
  // As Throne does: TUN cannot run without administrator rights, so a TUN setup restarts itself elevated at launch and
  // Windows shows its usual prompt. A declined prompt is remembered, so JOXY does not ask on every start.
  const tun = normalizeSettings(store.data.settings).mode === 'tun';
  if (process.platform === 'win32' && tun && store.data.settings.elevateOnStart !== false && !process.argv.includes('--wait-for-parent') && !await isElevated()) {
    try { await elevate(app, false); quitting = true; app.quit(); return; }
    catch { store.data.settings.elevateOnStart = false; await store.save(); }
  }
  controller = new Controller({ store, binaryDir: path.join(resources, 'xray'), runtimeDir: path.join(dataDir, 'runtime'), proxy: new SystemProxy(path.join(resources, 'windows-proxy.ps1'), dataDir), tunGuard: new TunGuard(path.join(resources, 'windows-tun.ps1'), dataDir), killSwitch: new KillSwitch(path.join(resources, 'guard', 'joxy-guard.exe')), leakGuard: new KillSwitch(path.join(resources, 'guard', 'joxy-guard.exe'), undefined, 'Защита от утечек'), updater: updater = new Updater({ version: app.getVersion() }), version: app.getVersion() });
  await controller.initialize();
  if (tun && controller.env.elevated && store.data.settings.elevateOnStart === false) { store.data.settings.elevateOnStart = true; await store.save(); }
  const bootstrapIndex = process.argv.indexOf('--bootstrap');
  if (bootstrapIndex >= 0 && process.argv[bootstrapIndex + 1] && !store.data.profiles.length) {
    const bootstrap = JSON.parse(await readFile(process.argv[bootstrapIndex + 1], 'utf8'));
    if (typeof bootstrap.subscriptionUrl === 'string') await controller.importValue(bootstrap.subscriptionUrl);
    else if (typeof bootstrap.profiles === 'string') await controller.importValue(bootstrap.profiles);
    await rm(process.argv[bootstrapIndex + 1], { force: true });
  }
  if (process.argv.includes('--self-test')) {
    try {
      await controller.checkAll();
      const statuses = store.data.profiles.map((p) => ({ name: p.name, result: p.lastTest }));
      console.log(JSON.stringify({ encrypted: true, version: app.getVersion(), profiles: statuses }));
      await controller.close(); quitting = true; app.exit(statuses.every((p) => p.result?.status === 'ok') ? 0 : 1);
    } catch (e) { console.error(redact(e.message)); await controller.close(); quitting = true; app.exit(1); }
    return;
  }
  registerIPC();
  nativeTheme.themeSource = store.data.settings.theme || 'system';
  window = new BrowserWindow({
    width: 900, height: 660, minWidth: 760, minHeight: 580, show: false, frame: false,
    title: 'JOXY', backgroundColor: nativeTheme.shouldUseDarkColors ? '#111214' : '#ffffff', icon: path.join(resources, 'window-icon.png'),
    webPreferences: { preload: path.join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.on('render-process-gone', () => { controller.disconnect().catch(() => {}); });
  window.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      if (store.data.settings.closeToTray) window.hide();
      else { quitting = true; app.quit(); }
    }
  });
  window.once('ready-to-show', () => window.show());
  await window.loadFile(path.join(root, 'dist', 'index.html'));
  const trayImage = nativeImage.createFromPath(path.join(resources, 'window-icon.png')).resize({ width: 20, height: 20, quality: 'best' });
  tray = new Tray(trayImage);
  tray.on('click', () => { window.show(); window.focus(); });
  tray.on('double-click', () => { window.show(); window.focus(); });
  const updateTray = () => {
    const connected = controller.connection.phase === 'connected';
    tray.setToolTip(`JOXY · ${connected ? 'Подключено' : 'Отключено'}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Открыть JOXY', click: () => { window.show(); window.focus(); } },
      { label: connected ? 'Отключиться' : 'Подключиться', enabled: !controller.busy, click: () => (connected ? controller.disconnect() : controller.connect()).catch((e) => controller.log('error', e.message)) },
      { type: 'separator' }, { label: 'Выход', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  updateTray();
  controller.on('state', (state) => {
    if (nativeTheme.themeSource !== (state.settings.theme || 'system')) nativeTheme.themeSource = state.settings.theme || 'system';
    if (!window.isDestroyed()) window.webContents.send('joxy:state', state); updateTray();
  });
  // Give Wi-Fi a few seconds to come back before probing the tunnel.
  powerMonitor.on('resume', () => setTimeout(() => controller.afterResume(), 4000));
  if (store.data.sources.some((s) => s.url)) controller.refreshSources().catch((e) => controller.log('warning', e.message));
  if (process.argv.includes('--reconnect') || store.data.settings.autoConnect && store.data.profiles.length) controller.connect().catch((e) => controller.log('error', e.message));
  // A quiet check soon after start and then every six hours; a failure waits for the next one.
  setTimeout(() => updater.check(), 8000);
  setInterval(() => updater.check(), 6 * 3600_000);
}

// The update replaces this portable file's folder copy, or lands in Downloads when JOXY runs unpacked. The new build
// starts once this process has ended (--wait-for-parent) and reconnects if JOXY was connected.
async function installUpdate() {
  if (controller.busy || controller.checking) throw new Error('Дождитесь завершения подключения или проверки.');
  const file = await updater.download(process.env.PORTABLE_EXECUTABLE_DIR || app.getPath('downloads'));
  const reconnect = controller.connection.phase === 'connected';
  const child = spawn(file, ['--wait-for-parent', String(process.pid), ...(reconnect ? ['--reconnect'] : [])], { cwd: path.dirname(file), detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', (e) => reject(new Error(`Не удалось запустить новую версию: ${e.message}`))); });
  child.unref();
  controller.log('info', `Обновление скачано: ${path.basename(file)}. Перезапускаем JOXY.`);
  setImmediate(() => { quitting = true; app.quit(); });
}

function registerIPC() {
  const actions = {
    state: () => controller.snapshot(),
    import: (v) => controller.importValue(v),
    refresh: (id = null) => controller.refreshSources(id),
    'open-provider': async (id, kind) => {
      if (!['supportUrl', 'websiteUrl'].includes(kind)) throw new Error('Ссылка недоступна.');
      const source = controller.store.data.sources.find((s) => s.id === id);
      const url = providerUrl(source?.[kind]);
      if (!url) throw new Error('Ссылка недоступна.');
      await shell.openExternal(url);
    },
    select: (id) => controller.select(id),
    connect: () => controller.connect(),
    disconnect: () => controller.disconnect(),
    test: (id = null) => controller.checkAll(id),
    settings: (patch) => controller.updateSettings(patch),
    // connect: the restarted instance connects at once, so pressing connect in TUN needs only the Windows prompt.
    elevate: async (patch = {}, options = {}) => {
      if (controller.busy || controller.checking) throw new Error('Дождитесь завершения подключения или проверки.');
      const next = settingsPatch(controller.store.data.settings, patch, controller.env.interfaces);
      if (controller.env.elevated) { await controller.updateSettings(patch); if (options?.connect === true) await controller.connect(); return; }
      await elevate(app, controller.connection.phase === 'connected' || options?.connect === true);
      controller.store.data.settings = { ...next, elevateOnStart: true }; await controller.store.save();
      setImmediate(() => { quitting = true; app.quit(); });
    },
    environment: () => controller.refreshEnvironment(),
    'update-check': () => updater.check({ manual: true }),
    'update-install': () => installUpdate(),
    minimize: () => window.minimize(),
    close: () => { setImmediate(() => window.close()); },
    'import-file': async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Импорт профилей', properties: ['openFile'], filters: [{ name: 'VLESS / Xray', extensions: ['txt', 'json'] }] });
      if (result.canceled) return null;
      const buffer = await readFile(result.filePaths[0]);
      if (buffer.length > 2_000_000) throw new Error('Максимальный размер файла — 2 МБ.');
      return controller.importValue(buffer.toString('utf8'));
    },
    'export-diagnostics': async () => {
      const result = await dialog.showSaveDialog(window, { title: 'Сохранить диагностику', defaultPath: 'JOXY-diagnostics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (result.canceled) return false;
      const state = controller.snapshot();
      const report = { version: state.version, core: state.core, time: new Date().toISOString(), environment: state.environment, profiles: state.profiles.map(({ id, sourceId, ...p }) => ({ ...p, address: '[server]', name: '[profile]' })), connection: { phase: state.connection.phase, mode: state.connection.mode || state.settings.mode, systemProxy: state.connection.systemProxy }, network: { mode: state.settings.mode, killSwitch: state.settings.killSwitch, killSwitchArmed: state.killSwitch.armed, dnsProvider: state.settings.dnsProvider, tunMtu: state.settings.tunMtu, tunIpv6: state.settings.tunIpv6, tunDnsProtection: state.settings.tunDnsProtection, bypassLan: state.settings.bypassLan, directRuleCount: state.settings.directRules.length }, logs: state.logs.map((l) => ({ ...l, message: redact(l.message) })) };
      await writeFile(result.filePath, JSON.stringify(report, null, 2), { mode: 0o600 }); return true;
    },
  };
  for (const [name, action] of Object.entries(actions)) ipcMain.handle(`joxy:${name}`, async (event, ...args) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return { ok: false, error: 'Недопустимый источник запроса.' };
    try { return { ok: true, value: await action(...args) }; } catch (e) { return { ok: false, error: redact(e.message) }; }
  });
}

app.on('before-quit', (event) => {
  if (cleanupStarted || !controller) return;
  event.preventDefault(); quitting = true; cleanupStarted = true;
  controller.close().catch((e) => console.error(redact(e.message))).finally(() => app.quit());
});
app.on('window-all-closed', () => { if (!tray) app.quit(); });
