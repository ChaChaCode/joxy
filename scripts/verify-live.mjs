import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { parseSubscription } from '../electron/profiles.mjs';
import { fetchSubscription, environment } from '../electron/network.mjs';
import { XrayEngine, testProfile } from '../electron/engine.mjs';

const configPath = process.env.JOXY_SUBSCRIPTION_FILE;
if (!configPath) throw new Error('Set JOXY_SUBSCRIPTION_FILE to a private JSON file containing subscriptionUrl. Never put credentials in the repository.');
const privateConfig = JSON.parse(await readFile(configPath, 'utf8'));
const { body } = await fetchSubscription(privateConfig.subscriptionUrl);
const { profiles } = parseSubscription(body);
assert.ok(profiles.length > 0);
const env = await environment();
const runtime = await mkdtemp(path.join(os.tmpdir(), 'zagran-live-test-'));
const binary = path.resolve('resources/xray/xray.exe');
let fail = false;
try {
  for (const profile of profiles) {
    const result = await testProfile(binary, runtime, profile, env.interface);
    console.log(JSON.stringify({ name: profile.name, transport: profile.transport, fragment: profile.fragment, ...result }));
    if (result.status !== 'ok') fail = true;
  }
  const engine = new XrayEngine(binary, runtime);
  try {
    await engine.start(profiles.find((p) => p.transport === 'xhttp') || profiles[0], env.interface);
    await engine.probe();
    const ip = await engine.exitIP(); assert.ok(ip);
    const metrics = await engine.metrics(); assert.ok(metrics.down > 0); assert.ok(metrics.up > 0);
    console.log(JSON.stringify({ metrics: 'real outbound counters verified', exitIP: ip, ...metrics }));
  } finally { await engine.stop(); }
} finally { await rm(runtime, { force: true, recursive: true }); }
if (fail) process.exitCode = 1;
