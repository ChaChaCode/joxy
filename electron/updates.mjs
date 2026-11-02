import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

// Updates come from the project's GitHub releases only: the portable build of the latest release, checked against the
// SHA256SUMS.txt published with it. Nothing runs that did not come from that repository over HTTPS and match its sum.
const repo = 'ChaChaCode/joxy';
const downloads = `https://github.com/${repo}/releases/download/`;
const maxSize = 400 * 1024 * 1024;

const parts = (v) => v.split('.').map(Number);
export function newer(candidate, current) {
  const a = parts(candidate), b = parts(current);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function parseRelease(data) {
  const version = /^v?(\d{1,4}\.\d{1,4}\.\d{1,4})$/.exec(String(data?.tag_name || ''))?.[1];
  if (!version) throw new Error('GitHub вернул релиз без номера версии.');
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const asset = (test) => assets.find((a) => typeof a?.name === 'string' && test(a.name) && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(downloads));
  const exe = asset((name) => name === `JOXY-${version}-Windows-x64.exe`);
  const sums = asset((name) => name === 'SHA256SUMS.txt');
  return {
    version,
    page: `https://github.com/${repo}/releases/tag/v${version}`,
    exe: exe && Number.isSafeInteger(exe.size) && exe.size > 0 && exe.size <= maxSize ? { name: exe.name, url: exe.browser_download_url, size: exe.size } : null,
    sums: sums?.browser_download_url || null,
  };
}

export function expectedSum(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f\d]{64})\s+\*?(\S+)\s*$/i.exec(line.trim());
    if (match && match[2] === name) return match[1].toLowerCase();
  }
  return null;
}

export class Updater extends EventEmitter {
  constructor({ version, fetcher = fetch }) {
    super(); this.version = version; this.fetcher = fetcher; this.release = null; this.work = null;
    this.state = { status: 'idle', version: null, progress: 0, error: null, checkedAt: null };
  }
  set(patch) { this.state = { ...this.state, ...patch }; this.emit('change', this.state); }
  async get(url, accept, timeout = 20000) {
    const response = await this.fetcher(url, { headers: { Accept: accept, 'User-Agent': `JOXY/${this.version}` }, signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error(response.status === 403 ? 'GitHub временно ограничил запросы. Попробуйте позже.' : `GitHub ответил ${response.status}.`);
    if (!response.url.startsWith('https://')) throw new Error('Обновление пришло не по HTTPS.');
    return response;
  }
  // manual: a failure shows; an automatic check fails quietly and tries again later.
  async check({ manual = false } = {}) {
    if (this.work) return this.state;
    const previous = this.state;
    this.set({ status: 'checking', error: null });
    try {
      const release = parseRelease(await (await this.get(`https://api.github.com/repos/${repo}/releases/latest`, 'application/vnd.github+json')).json());
      const available = newer(release.version, this.version) && release.exe && release.sums;
      this.release = available ? release : null;
      this.set({ status: available ? 'available' : 'latest', version: available ? release.version : null, checkedAt: new Date().toISOString() });
    } catch (e) {
      const message = e.name === 'TimeoutError' ? 'GitHub не ответил вовремя.' : e.message;
      this.set(manual ? { status: 'error', error: `Не удалось проверить обновления: ${message}` } : previous);
    }
    return this.state;
  }
  // Downloads next to `.part`, hashes on the way, and renames only a file whose size and SHA256 match.
  async download(dir) {
    const release = this.release;
    if (!release) throw new Error('Обновление не найдено. Проверьте обновления ещё раз.');
    if (this.work) return this.work;
    this.work = (async () => {
      this.set({ status: 'downloading', progress: 0, error: null });
      const file = path.join(dir, release.exe.name), part = `${file}.part`;
      try {
        const sum = expectedSum(await (await this.get(release.sums, 'text/plain')).text(), release.exe.name);
        if (!sum) throw new Error('В релизе нет контрольной суммы для файла обновления.');
        const response = await this.get(release.exe.url, 'application/octet-stream', 15 * 60000);
        await mkdir(dir, { recursive: true });
        const hash = createHash('sha256'), out = createWriteStream(part, { mode: 0o600 });
        let received = 0, shown = 0;
        try {
          for await (const chunk of response.body) {
            received += chunk.length;
            if (received > release.exe.size) throw new Error('Файл обновления больше, чем указано в релизе.');
            hash.update(chunk);
            if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
            const progress = received / release.exe.size;
            if (progress - shown >= 0.01) { shown = progress; this.set({ progress }); }
          }
        } finally { await new Promise((resolve) => out.end(resolve)); }
        if (received !== release.exe.size) throw new Error('Файл обновления скачался не полностью.');
        if (hash.digest('hex') !== sum) throw new Error('Контрольная сумма обновления не совпала. Файл удалён.');
        await rename(part, file);
        this.set({ status: 'ready', progress: 1 });
        return file;
      } catch (e) {
        await rm(part, { force: true }).catch(() => {});
        this.set({ status: 'available', progress: 0, error: `Не удалось скачать обновление: ${e.name === 'TimeoutError' ? 'GitHub не ответил вовремя.' : e.message}` });
        throw e;
      } finally { this.work = null; }
    })();
    return this.work;
  }
}
