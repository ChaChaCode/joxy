import { _electron as electron } from 'playwright';
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SystemProxy, fetchSubscription } from '../electron/network.mjs';

const privateConfig = await readFile(process.env.JOXY_SUBSCRIPTION_FILE, 'utf8');
const expectedMetadata = (await fetchSubscription(JSON.parse(privateConfig).subscriptionUrl)).metadata;
const temporary = await mkdtemp(path.join(os.tmpdir(), 'zagran-desktop-test-'));
const bootstrap = path.join(temporary, 'bootstrap.json');
await writeFile(bootstrap, privateConfig, { mode: 0o600 });
const env = { ...process.env, JOXY_TEST_DATA: path.join(temporary, 'data') }; delete env.ELECTRON_RUN_AS_NODE;
if (process.env.JOXY_LEGACY_DATA) {
  await mkdir(env.JOXY_TEST_DATA, { recursive: true });
  for (const name of ['settings.enc', 'Local State']) {
    await copyFile(path.join(process.env.JOXY_LEGACY_DATA, name), path.join(env.JOXY_TEST_DATA, name));
  }
}
const proxy = new SystemProxy(path.resolve('resources/windows-proxy.ps1'), temporary);
const before = await proxy.run('status');
let desktop;
async function pollState(page, predicate, timeout = 30000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    const state = await page.evaluate(() => window.joxy.state());
    last = state;
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await writeFile('artifacts/desktop-failure.json', JSON.stringify(last, null, 2));
  await page.screenshot({ path: 'artifacts/desktop-failure.png', fullPage: true });
  throw new Error('Timed out waiting for desktop state: '+JSON.stringify(last?.profiles.map((p) => ({name:p.name,result:p.lastTest}))));
}
try {
  desktop = await electron.launch({ executablePath: process.env.JOXY_DESKTOP_PATH || path.resolve('release-joxy-0.6.11/win-unpacked/JOXY.exe'), args: ['--bootstrap', bootstrap], env, timeout: 45000 });
  const page = await desktop.firstWindow();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.getByRole('heading', { name: 'Подключение' }).waitFor({ timeout: 30000 });
  let state = await page.evaluate(() => window.joxy.state());
  assert.equal(await page.title(), 'JOXY');
  assert.equal((await page.locator('.brand').innerText()).trim(), 'JOXY');
  assert.equal(await page.locator('.brand svg, .about svg, .brand-mark').count(), 0);
  assert.equal(state.profiles.length, 3); assert.equal(state.core.ready, true);
  assert.ok(state.profiles.some((p) => p.transport === 'raw' && p.fragment));
  await page.evaluate(() => window.joxy.refresh());
  state = await page.evaluate(() => window.joxy.state());
  assert.equal(state.sources[0].label, 'ZAGRAN');
  assert.equal(state.sources[0].remote, true);
  assert.deepEqual(state.sources[0].usage, expectedMetadata.usage);
  assert.ok(state.profiles.every((p) => p.countryCode === expectedMetadata.countryCode));
  await page.getByRole('button', { name: 'Серверы', exact: false }).first().click();
  if (expectedMetadata.usage) await page.locator('.subscription-info').waitFor();
  else await page.locator('.subscription-missing').waitFor();
  assert.equal(await page.locator('.subscription-card .server-row').count(), 3);
  await page.screenshot({ path: 'artifacts/desktop-servers.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Диагностика', exact: true }).click();
  await page.getByRole('button', { name: 'Запустить проверку' }).click();
  state = await pollState(page, (s) => !s.checking && s.profiles.every((p) => p.lastTest?.status === 'ok'), 45000);
  assert.equal(state.profiles.filter((p) => p.lastTest?.status === 'ok').length, 3);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/desktop-diagnostics.png', fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await page.getByRole('tab', { name: 'Приложение', exact: true }).click();
  await page.getByRole('switch', { name: 'Сворачивать в трей', exact: true }).click();
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByRole('button', { name: 'Подключение', exact: true }).click();
  await page.getByRole('button', { name: 'Подключиться', exact: true }).click();
  await page.locator('.connection-panel.is-connected').waitFor({ timeout: 30000 });
  state = await pollState(page, (s) => s.connection.phase === 'connected' && s.stats.down > 0, 15000);
  assert.ok(state.connection.exitIP); assert.equal(state.connection.systemProxy, true);
  const enabled = await proxy.run('status');
  assert.equal(enabled.ProxyServer.value, `127.0.0.1:${state.connection.ports.http}`);
  assert.equal(enabled.ProxyEnable.value, 1);
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.screenshot({ path: 'artifacts/desktop-connected.png', fullPage: true, animations: 'disabled' });
  const encrypted = await readFile(path.join(temporary, 'data/settings.enc'));
  assert.ok(!encrypted.includes(Buffer.from(JSON.parse(privateConfig).subscriptionUrl)));
  assert.ok(!JSON.stringify(state).includes('outbound'));
  assert.deepEqual(errors, []);
  const application = desktop;
  const closed = application.waitForEvent('close', { timeout: 15000 });
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await closed; desktop = null;
  assert.deepEqual(await proxy.run('status'), before);
  console.log(JSON.stringify({ app: 'packaged Electron', version: state.version, profiles: state.profiles.map((p) => ({ name: p.name, result: p.lastTest?.status })), connected: true, exitIP: state.connection.exitIP, metrics: state.stats.down > 0, dpapi: 'encrypted', systemProxy: 'restored after app exit', rendererErrors: errors.length }));
} finally {
  if (desktop) await desktop.close().catch(() => {});
  // Fail visibly if the application ever leaves Windows in a different state.
  assert.deepEqual(await proxy.run('status'), before);
  await rm(temporary, { recursive: true, force: true });
}
