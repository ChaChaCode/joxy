import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

// Runs joxy-guard, which blocks every connection but the core's and the TUN's while its stdin stays open, or with
// leaksOnly just DNS and IPv6 outside the TUN: the kill switch and the leak protection are each one instance.
// Its WFP filters are dynamic: they vanish with the guard, and libuv's job object ends the guard with JOXY,
// so no state of JOXY can leave Windows without internet.
export class KillSwitch extends EventEmitter {
  constructor(binary, spawner = spawn, label = 'Kill switch') { super(); this.binary = binary; this.spawner = spawner; this.label = label; this.child = null; this.arming = null; }
  get armed() { return !!this.child && !this.arming; }
  async arm({ apps, tun, allowLan, leaksOnly = false, blockDns = false, blockIpv6 = false }) {
    if (this.child) return this.arming || undefined;
    const child = this.spawner(this.binary, ['-parent', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    this.arming = new Promise((resolve, reject) => {
      const lines = createInterface({ input: child.stdout });
      const timer = setTimeout(() => fail(new Error(`${this.label} не ответил вовремя.`)), 15000);
      const fail = (error) => { clearTimeout(timer); if (this.child === child) this.child = null; child.kill(); reject(error); };
      child.once('error', (e) => fail(new Error(`${this.label} не запустился: ${e.message}`)));
      child.once('exit', () => {
        if (this.child !== child) return;
        this.child = null;
        if (this.arming) fail(new Error(`${this.label} завершился при запуске.`));
        else this.emit('failed', new Error(`${this.label} неожиданно завершился. Блокировка снята.`));
      });
      lines.on('line', (line) => {
        const [kind, ...rest] = line.split(' '); const message = rest.join(' ');
        if (kind === 'READY') { clearTimeout(timer); resolve(); }
        else if (kind === 'ERROR') fail(new Error(`${this.label}: ${message}`));
        else if (kind === 'WARN') this.emit('warning', message);
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify({ apps, tun, allowLan: !!allowLan, ...(leaksOnly ? { leaksOnly: true, blockDns: !!blockDns, blockIpv6: !!blockIpv6 } : {}) })}\n`);
    try { await this.arming; } finally { this.arming = null; }
  }
  // Closing stdin makes the guard close its WFP session and exit; a kill does the same, a little less politely.
  async disarm() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
