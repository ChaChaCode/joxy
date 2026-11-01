import { readFileSync } from 'node:fs';

// package.json is the single source of the release number, also inside app.asar.
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
