import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { KillSwitch } from '../electron/killswitch.mjs';

function fakeGuard(respond) {
  const spawned = [];
  const spawner = (binary, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.written = '';
    child.stdin.on('data', (chunk) => { child.written += chunk; const reply = respond(child.written); if (reply) child.stdout.write(`${reply}\n`); });
    child.stdin.on('finish', () => setImmediate(() => child.emit('exit', 0)));
    child.kill = () => setImmediate(() => child.emit('exit', 1));
    spawned.push({ binary, args, child });
    return child;
  };
  return { spawner, spawned };
}

test('arming sends one JSON line and waits for READY; disarming closes stdin', async () => {
  const { spawner, spawned } = fakeGuard(() => 'READY');
  const ks = new KillSwitch('joxy-guard.exe', spawner);
  await ks.arm({ apps: ['C:/xray.exe'], tun: 'JOXY', allowLan: true });
  assert.equal(ks.armed, true);
  assert.deepEqual(spawned[0].args, ['-parent', String(process.pid)]);
  assert.deepEqual(JSON.parse(spawned[0].child.written), { apps: ['C:/xray.exe'], tun: 'JOXY', allowLan: true });
  await ks.disarm();
  assert.equal(ks.armed, false);
});
test('a guard error is reported and nothing stays armed', async () => {
  const { spawner } = fakeGuard(() => 'ERROR the kill switch needs administrator rights');
  const ks = new KillSwitch('joxy-guard.exe', spawner);
  await assert.rejects(ks.arm({ apps: ['x'], tun: 'JOXY' }), /administrator rights/);
  assert.equal(ks.armed, false);
});
test('an unexpected guard exit is reported as failed', async () => {
  const { spawner, spawned } = fakeGuard(() => 'READY');
  const ks = new KillSwitch('joxy-guard.exe', spawner);
  await ks.arm({ apps: ['x'], tun: 'JOXY' });
  const failed = new Promise((resolve) => ks.once('failed', resolve));
  spawned[0].child.emit('exit', 2);
  assert.match((await failed).message, /неожиданно/);
  assert.equal(ks.armed, false);
});
