import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { defaultSettings, normalizeSettings } from './settings.mjs';

export const defaults = () => ({ schema: 1, profiles: [], sources: [], selectedId: 'auto', settings: defaultSettings() });

export class EncryptedStore {
  constructor(directory, crypto) { this.directory = directory; this.file = path.join(directory, 'settings.enc'); this.crypto = crypto; this.queue = Promise.resolve(); this.data = defaults(); }
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const raw = await readFile(this.file);
      const data = JSON.parse(await this.crypto.decrypt(raw));
      if (data.schema !== 1 || !Array.isArray(data.profiles) || !Array.isArray(data.sources) || data.profiles.length > 1000) throw new Error('Неподдерживаемый формат настроек.');
      this.data = { ...defaults(), ...data, settings: normalizeSettings(data.settings) };
    } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('Не удалось расшифровать настройки JOXY. Исходный файл сохранён; приложение не будет его перезаписывать.');
    }
    return this.data;
  }
  async save() {
    const snapshot = JSON.stringify(this.data);
    this.queue = this.queue.catch(() => {}).then(async () => {
      const encrypted = await this.crypto.encrypt(snapshot);
      const temp = this.file + '.next';
      await writeFile(temp, encrypted, { mode: 0o600 });
      await rename(temp, this.file);
    });
    await this.queue;
  }
}
