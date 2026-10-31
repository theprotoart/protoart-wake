// Talking to macOS: the keep-awake hold (caffeinate), what pmset reports, running
// apps (ps) and in-progress downloads. Every helper is a fixed absolute path run
// with an argument array and no shell. No Electron imports (unit-testable).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CAFFEINATE = '/usr/bin/caffeinate';
const PMSET = '/usr/bin/pmset';
const PS = '/bin/ps';
const IOREG = '/usr/sbin/ioreg';
const ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };

/** Runs a program and resolves { code, stdout } (never rejects on exit code). */
function run(file, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'], env: ENV });
    let out = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { if (out.length < 4 << 20) out += d; });
    child.on('error', err => { clearTimeout(t); reject(err); });
    child.on('close', code => { clearTimeout(t); resolve({ code, stdout: out }); });
  });
}

/**
 * The keep-awake hold. macOS's own caffeinate takes the power assertions on our
 * behalf and watches our process (-w): if this app quits or crashes, the hold is
 * released automatically, so a Mac can never be left stuck awake.
 */
class Hold {
  constructor(ownerPid = process.pid) { this.ownerPid = ownerPid; this.child = null; this.mode = null; this.onLost = null; }
  get active() { return !!this.child; }
  get pid() { return this.child ? this.child.pid : null; }

  /** mode: 'display' keeps the screen and the Mac awake; 'system' lets the screen sleep. */
  start(mode) {
    if (this.child && this.mode === mode) return;
    this.stop();
    const args = mode === 'display' ? ['-d', '-i', '-w', String(this.ownerPid)] : ['-i', '-w', String(this.ownerPid)];
    const child = spawn(CAFFEINATE, args, { shell: false, stdio: 'ignore', env: ENV });
    this.child = child; this.mode = mode;
    child.on('error', () => {});
    child.on('exit', () => {
      if (this.child !== child) return; // replaced or stopped on purpose
      this.child = null; this.mode = null;
      if (this.onLost) this.onLost();
    });
  }

  stop() {
    const c = this.child;
    this.child = null; this.mode = null;
    if (c) c.kill('SIGTERM');
  }
}

/** Tells macOS the user is active for a few seconds (resets the screen-saver timer). */
function pulseUserActive(seconds = 5) {
  const c = spawn(CAFFEINATE, ['-u', '-t', String(seconds)], { shell: false, stdio: 'ignore', env: ENV });
  c.on('error', () => {});
  return c;
}

/** Turns the display off now (the Mac itself stays as it is). */
function displaySleepNow() { return run(PMSET, ['displaysleepnow']); }

// ------------------------------------------------------------------ pmset parsing

const HOLD_TYPES = /^(PreventUserIdleSystemSleep|PreventUserIdleDisplaySleep|PreventSystemSleep|NoIdleSleepAssertion|NoDisplaySleepAssertion)$/;
const SYSTEM_OWNERS = new Set(['powerd', 'WindowServer', 'kernel_task', 'coreaudiod', 'hidd']);

/**
 * Parses `pmset -g assertions`. Returns { byPid: Map<pid, {name, types:Set, details:[]}> }.
 * Lines look like:  pid 2820(caffeinate): [0x...] 00:00:01 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
 * followed by optional indented "Details:" / "Timeout" lines.
 */
function parseAssertions(text) {
  const byPid = new Map();
  let last = null;
  for (const line of String(text).split('\n')) {
    const m = /^\s*pid (\d+)\((.*?)\): \[0x[0-9a-fA-F]+\] [\d:]+ (\w+) named: "(.*)"\s*$/.exec(line);
    if (m) {
      const pid = Number(m[1]);
      const e = byPid.get(pid) || { pid, name: m[2], types: new Set(), labels: [], details: [] };
      e.types.add(m[3]); e.labels.push(m[4]);
      byPid.set(pid, e); last = e;
      continue;
    }
    const d = /^\s+Details: (.*)$/.exec(line);
    if (d && last) last.details.push(d[1]);
    if (/^\S/.test(line)) last = null;
  }
  return { byPid };
}

/** Friendly names of other processes keeping the Mac awake (not us, not macOS housekeeping). */
function otherHolders(parsed, ownPids = []) {
  const own = new Set(ownPids.map(Number));
  const names = [];
  for (const e of parsed.byPid.values()) {
    if (own.has(e.pid) || SYSTEM_OWNERS.has(e.name)) continue;
    if (![...e.types].some(t => HOLD_TYPES.test(t))) continue;
    let name = e.name;
    // caffeinate run by someone else: say on whose behalf if it tells us.
    if (name === 'caffeinate') name = 'caffeinate (Terminal)';
    if (name === 'AddressBookSourceSync') name = 'Contacts sync';
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * True when audio is playing or recording: macOS's audio daemon (coreaudiod)
 * holds a sleep-prevention assertion for as long as any audio device is running.
 */
function audioActive(parsed) {
  for (const e of parsed.byPid.values()) {
    if (e.name === 'coreaudiod' && [...e.types].some(t => HOLD_TYPES.test(t))) return true;
  }
  return false;
}

/** True when macOS lists the expected assertion types for our caffeinate. */
function holdVerified(parsed, caffeinatePid, mode) {
  const e = caffeinatePid && parsed.byPid.get(Number(caffeinatePid));
  if (!e) return false;
  if (!e.types.has('PreventUserIdleSystemSleep')) return false;
  return mode !== 'display' || e.types.has('PreventUserIdleDisplaySleep');
}

/** Parses `pmset -g`: { sleepMinutes, displayMinutes } (0 = never). */
function parseSettings(text) {
  const num = key => {
    const m = new RegExp(`^\\s*${key}\\s+(\\d+)`, 'm').exec(String(text));
    return m ? Number(m[1]) : null;
  };
  return { sleepMinutes: num('sleep'), displayMinutes: num('displaysleep') };
}

/** Parses `pmset -g batt`: { onBattery, percent|null }. */
function parseBattery(text) {
  const t = String(text);
  const pct = /(\d+)%/.exec(t);
  return { onBattery: /Battery Power/.test(t), percent: pct ? Number(pct[1]) : null };
}

async function readAssertions() { return parseAssertions((await run(PMSET, ['-g', 'assertions'])).stdout); }
async function readSettings() { return parseSettings((await run(PMSET, ['-g'])).stdout); }
async function readBattery() { return parseBattery((await run(PMSET, ['-g', 'batt'])).stdout); }

/** Seconds since the last keyboard/mouse input. */
async function readIdleSeconds() {
  const r = await run(IOREG, ['-c', 'IOHIDSystem', '-d', '4', '-k', 'HIDIdleTime']);
  const m = /"HIDIdleTime" = (\d+)/.exec(r.stdout);
  return m ? Math.floor(Number(m[1]) / 1e9) : null;
}

// ------------------------------------------------------------------ Running apps

const APP_ROOTS = ['/Applications/', '/System/Applications/', path.join(process.env.HOME || '/nonexistent', 'Applications') + '/'];

/**
 * Turns `ps -axo comm=` output into the set of running app bundles:
 * [{ id: '/Applications/Final Cut Pro.app', name: 'Final Cut Pro' }]. Only the
 * app's own executables (Contents/MacOS directly inside the outermost .app under an
 * Applications folder) count: widgets, plug-ins and nested helper apps don't.
 */
function parseRunningApps(text) {
  const out = new Map();
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('/')) continue;
    const root = APP_ROOTS.find(r => line.startsWith(r));
    if (!root) continue;
    const i = line.indexOf('.app/', root.length);
    if (i < 0) continue;
    // Only the app's own executables count, not widgets, plug-ins or nested helper apps.
    if (!/^Contents\/MacOS\/[^/]+$/.test(line.slice(i + 5))) continue;
    const id = line.slice(0, i + 4);
    if (!out.has(id)) out.set(id, { id, name: path.basename(id, '.app') });
  }
  return [...out.values()];
}

async function readRunningApps() { return parseRunningApps((await run(PS, ['-axo', 'comm='])).stdout); }

// ------------------------------------------------------------------ Downloads

const PARTIAL = /\.(crdownload|download|part|partial|opdownload|tmp\.download)$/i;
const isPartialDownload = p => PARTIAL.test(String(p));

/**
 * True when a browser download is still in progress in `dir`: a partial-download
 * entry (Chrome .crdownload, Safari .download, Firefox .part, …) that changed in
 * the last `freshMs`. Only names and modification times are read, never contents.
 */
async function downloadsInProgress(dir, now = Date.now(), freshMs = 120000) {
  let names;
  try { names = await fs.promises.readdir(dir); } catch { return false; }
  for (const n of names) {
    if (!PARTIAL.test(n)) continue;
    try {
      const st = await fs.promises.lstat(path.join(dir, n));
      let newest = st.mtimeMs;
      if (st.isDirectory()) { // Safari: a .download bundle holding the growing file
        for (const inner of await fs.promises.readdir(path.join(dir, n))) {
          const s2 = await fs.promises.lstat(path.join(dir, n, inner)).catch(() => null);
          if (s2) newest = Math.max(newest, s2.mtimeMs);
        }
      }
      if (now - newest < freshMs) return true;
    } catch { /* vanished: finished */ }
  }
  return false;
}

module.exports = {
  run, Hold, pulseUserActive, displaySleepNow,
  parseAssertions, otherHolders, holdVerified, audioActive, parseSettings, parseBattery,
  readAssertions, readSettings, readBattery, readIdleSeconds,
  parseRunningApps, readRunningApps, downloadsInProgress, isPartialDownload,
  CAFFEINATE, PMSET, PS, IOREG,
};
