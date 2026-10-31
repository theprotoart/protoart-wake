// Tests for ProtoArt Wake's logic and safety rules. Run: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Session, CUSTOM_INDEX, nextClockTime } = require('../app/engine/session');
const macos = require('../app/engine/macos');
const validate = require('../app/validate');
const store = require('../app/store');

const MIN = 60000;

// ---------------------------------------------------------------- Session

test('manual: on until switched off by default', () => {
  const s = new Session();
  s.setPower(true, 0);
  let d = s.decide({ now: 10 * 3600 * 1000 });
  assert.strictEqual(d.awake, true); assert.strictEqual(d.endsAt, null); assert.strictEqual(d.startedAt, 10 * 3600 * 1000);
  s.setPower(false, 1);
  d = s.decide({ now: 2 });
  assert.strictEqual(d.awake, false); assert.strictEqual(d.startedAt, null);
});

test('timer: ends once, reports expiry exactly once', () => {
  const s = new Session({ durationIndex: 1 }); // 15 min
  s.setPower(true, 0);
  assert.strictEqual(s.decide({ now: 14 * MIN }).awake, true);
  const end = s.decide({ now: 15 * MIN });
  assert.strictEqual(end.awake, false); assert.strictEqual(end.expired, 'Time is up.');
  assert.strictEqual(s.decide({ now: 16 * MIN }).expired, '');
});

test('turning the knob mid-session restarts the timer from now', () => {
  const s = new Session({ durationIndex: 1 });
  s.setPower(true, 0);
  s.setDuration(3, 10 * MIN); // 1 h
  assert.strictEqual(s.decide({ now: 69 * MIN }).awake, true);
  assert.strictEqual(s.decide({ now: 70 * MIN }).awake, false);
  s.setDuration(99); s.setDuration(-1); s.setDuration(1.5);
  assert.strictEqual(s.durationIndex, 3);
});

test('auto: awake while a watched app runs, released after', () => {
  const s = new Session();
  let d = s.decide({ now: 0, autoApps: true, watchedRunning: ['Final Cut Pro'] });
  assert.strictEqual(d.awake, true); assert.match(d.reason, /Final Cut Pro/);
  d = s.decide({ now: 1, autoApps: true, watchedRunning: [] });
  assert.strictEqual(d.awake, false);
  d = s.decide({ now: 2, autoApps: false, watchedRunning: ['Final Cut Pro'] });
  assert.strictEqual(d.awake, false, 'APPS off means watched apps are ignored');
});

test('auto: switching off during an auto hold wins until the cause goes away', () => {
  const s = new Session();
  s.decide({ now: 0, autoDownloads: true, downloadsActive: true });
  s.setPower(false, 1);
  assert.strictEqual(s.decide({ now: 2, autoDownloads: true, downloadsActive: true }).awake, false);
  s.decide({ now: 3, autoDownloads: true, downloadsActive: false });
  assert.strictEqual(s.decide({ now: 4, autoDownloads: true, downloadsActive: true }).awake, true, 'a new download counts again');
});

test('manual timer and auto: auto keeps it awake after the timer ends', () => {
  const s = new Session({ durationIndex: 1 });
  s.setPower(true, 0);
  const d = s.decide({ now: 20 * MIN, autoApps: true, watchedRunning: ['Logic Pro'] });
  assert.strictEqual(d.expired, 'Time is up.'); assert.strictEqual(d.awake, true); assert.match(d.reason, /Logic Pro/);
});

test('auto: audio playing keeps it awake only with AUDIO on, through short gaps', () => {
  const s = new Session();
  assert.strictEqual(s.decide({ now: 0, audioActive: true }).awake, false);
  const d = s.decide({ now: 1, audioActive: true, autoAudio: true });
  assert.strictEqual(d.awake, true); assert.match(d.reason, /audio/);
  assert.strictEqual(s.decide({ now: 20000, audioActive: false, autoAudio: true }).awake, true, 'gap between songs');
  assert.strictEqual(s.decide({ now: 40000, audioActive: false, autoAudio: true }).awake, false, 'silence past 30 s');
});

test('auto: a paused cause is reported so the panel can say so', () => {
  const s = new Session();
  s.decide({ now: 0, autoApps: true, watchedRunning: ['Logic Pro'] });
  s.setPower(false, 1);
  const d = s.decide({ now: 2, autoApps: true, watchedRunning: ['Logic Pro'] });
  assert.strictEqual(d.awake, false); assert.strictEqual(d.paused, 'Logic Pro is open');
  assert.strictEqual(s.decide({ now: 3, autoApps: true, watchedRunning: [] }).paused, '');
});

test('custom: any length, then expiry with a message', () => {
  const s = new Session();
  s.setCustom({ kind: 'for', minutes: 95 }, 0);
  assert.strictEqual(s.durationIndex, CUSTOM_INDEX);
  assert.strictEqual(s.decide({ now: 94 * MIN }).awake, true);
  const d = s.decide({ now: 95 * MIN });
  assert.strictEqual(d.awake, false); assert.strictEqual(d.expired, 'Time is up.');
});

test('custom: until a clock time, rolling to tomorrow when it has passed', () => {
  const morning = new Date(2026, 9, 16, 7, 30).getTime();
  assert.strictEqual(nextClockTime(18, 30, morning), new Date(2026, 9, 16, 18, 30).getTime());
  assert.strictEqual(nextClockTime(6, 0, morning), new Date(2026, 9, 17, 6, 0).getTime());
  const s = new Session();
  s.setCustom({ kind: 'until', hour: 18, minute: 30 }, morning);
  assert.strictEqual(s.decide({ now: morning }).endsAt, new Date(2026, 9, 16, 18, 30).getTime());
});

test('SET on the knob needs a custom time first', () => {
  const s = new Session();
  s.setDuration(CUSTOM_INDEX);
  assert.strictEqual(s.durationIndex, 0);
});

test('while an app is running: ends when it quits', () => {
  const s = new Session();
  s.startForApp('/Applications/Logic Pro.app', 'Logic Pro');
  let d = s.decide({ now: 0, runningIds: new Set(['/Applications/Logic Pro.app']) });
  assert.strictEqual(d.awake, true); assert.strictEqual(d.reason, 'While Logic Pro is open'); assert.strictEqual(d.endsAt, null);
  d = s.decide({ now: 1, runningIds: new Set() });
  assert.strictEqual(d.awake, false); assert.strictEqual(d.expired, 'Logic Pro quit.');
});

test('while a file is downloading: ends when it finishes', () => {
  const s = new Session();
  s.startForFile('/Users/x/Downloads/big.zip.crdownload', 'big.zip');
  assert.strictEqual(s.decide({ now: 0, fileActive: true }).reason, 'While big.zip downloads');
  assert.strictEqual(s.decide({ now: 1, fileActive: false }).expired, 'big.zip finished downloading.');
});

// ---------------------------------------------------------------- pmset parsing (real macOS 26.2 output)

const ASSERTIONS = `Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
Listed by owning process:
   pid 2702(AddressBookSourceSync): [0x0000015d00018650] 00:00:24 PreventUserIdleSystemSleep named: "Address Book Source Sync"  
	Timeout will fire in 1777 secs Action=TimeoutActionTurnOff
   pid 2820(caffeinate): [0x0000017400018676] 00:00:01 PreventUserIdleSystemSleep named: "caffeinate command-line tool"  
	Details: caffeinate asserting on behalf of Process ID 2819
   pid 2820(caffeinate): [0x0000017400058677] 00:00:01 PreventUserIdleDisplaySleep named: "caffeinate command-line tool"  
	Details: caffeinate asserting on behalf of Process ID 2819
   pid 1098(Claude): [0x000000500001846d] 00:04:51 NoIdleSleepAssertion named: "Electron"  
   pid 427(WindowServer): [0x000000210009808d] 00:00:01 UserIsActive named: "com.apple.iohideventsystem.queue.tickle"  
   pid 368(powerd): [0x0000001f00018009] 00:05:40 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"  
Kernel Assertions: 0x104=USB,MAGICWAKE
   id=537  level=255 0x4=USB creat= description=com.apple.usb.externaldevice.02200000 owner=Z12 Gaming Keyboard
`;

test('pmset: our hold is verified only with the right assertion types', () => {
  const p = macos.parseAssertions(ASSERTIONS);
  assert.strictEqual(macos.holdVerified(p, 2820, 'display'), true);
  assert.strictEqual(macos.holdVerified(p, 2820, 'system'), true);
  assert.strictEqual(macos.holdVerified(p, 9999, 'system'), false);
  assert.strictEqual(macos.holdVerified(p, null, 'system'), false);
  assert.deepStrictEqual(p.byPid.get(2820).details, ['caffeinate asserting on behalf of Process ID 2819', 'caffeinate asserting on behalf of Process ID 2819']);
});

test('pmset: audio activity comes from coreaudiod holds', () => {
  assert.strictEqual(macos.audioActive(macos.parseAssertions(ASSERTIONS)), false);
  // Captured on macOS 26.2 while audio played through a USB interface:
  const playing = ASSERTIONS + '   pid 434(coreaudiod): [0x000008fd000188ac] 00:00:00 PreventUserIdleSystemSleep named: "com.apple.audio.AppleUSBAudioEngine:Focusrite:Scarlett Solo USB:Y7UNYC1049095C:1,2.context.preventuseridlesleep"  \n\tResources: audio-in audio-out AppleUSBAudioEngine:Focusrite:Scarlett Solo USB:Y7UNYC1049095C:1,2 \n';
  assert.strictEqual(macos.audioActive(macos.parseAssertions(playing)), true);
});

test('pmset: other holders exclude us and macOS housekeeping', () => {
  const p = macos.parseAssertions(ASSERTIONS);
  assert.deepStrictEqual(macos.otherHolders(p, [2820]), ['Contacts sync', 'Claude']);
});

test('pmset: settings and battery', () => {
  const g = ' disksleep            10\n sleep                1 (sleep prevented by AddressBookSourceSync, Claude, powerd)\n displaysleep         10\n';
  assert.deepStrictEqual(macos.parseSettings(g), { sleepMinutes: 1, displayMinutes: 10 });
  assert.deepStrictEqual(macos.parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t8%; discharging"), { onBattery: true, percent: 8 });
  assert.deepStrictEqual(macos.parseBattery("Now drawing from 'AC Power'"), { onBattery: false, percent: null });
});

// ---------------------------------------------------------------- Running apps and downloads

test('running apps: an app\'s own executables under Applications folders only', () => {
  const ps = [
    '/Applications/Final Cut Pro.app/Contents/MacOS/Final Cut Pro',
    '/Applications/Final Cut Pro.app/Contents/XPCServices/x.xpc/Contents/MacOS/x',
    '/System/Applications/FindMy.app/Contents/PlugIns/FindMyWidgetItems.appex/Contents/MacOS/FindMyWidgetItems',
    '/Applications/Avast.app/Contents/Backend/services/com.avast.leap',
    '/Applications/Little Snitch.app/Contents/Components/Little Snitch Agent.app/Contents/MacOS/Little Snitch Agent',
    '/System/Applications/Music.app/Contents/MacOS/Music',
    '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '/usr/libexec/trustd', 'launchd', '/tmp/Evil.app/Contents/MacOS/Evil',
  ].join('\n');
  assert.deepStrictEqual(macos.parseRunningApps(ps), [
    { id: '/Applications/Final Cut Pro.app', name: 'Final Cut Pro' },
    { id: '/System/Applications/Music.app', name: 'Music' },
  ]);
});

test('downloads: fresh partial downloads count, stale or finished ones do not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-dl-'));
  fs.writeFileSync(path.join(dir, 'movie.mp4'), 'done');
  assert.strictEqual(await macos.downloadsInProgress(dir), false);
  const part = path.join(dir, 'big.zip.crdownload');
  fs.writeFileSync(part, 'x');
  assert.strictEqual(await macos.downloadsInProgress(dir), true);
  const old = new Date(Date.now() - 10 * MIN);
  fs.utimesSync(part, old, old);
  assert.strictEqual(await macos.downloadsInProgress(dir), false, 'a paused download for 10 min does not count');
  const safari = path.join(dir, 'disk.dmg.download');
  fs.mkdirSync(safari); fs.utimesSync(safari, old, old);
  fs.writeFileSync(path.join(safari, 'disk.dmg'), 'growing');
  assert.strictEqual(await macos.downloadsInProgress(dir), true, 'Safari bundle with a growing file');
  assert.strictEqual(await macos.downloadsInProgress(path.join(dir, 'missing')), false);
});

// ---------------------------------------------------------------- Validation, settings, safety

test('panel requests: only known keys and valid values', () => {
  assert.deepStrictEqual(validate.patch({ awake: 'yes', durationIndex: 11, mode: 'turbo', screensaver: 'block', extra: 1, autoApps: true }),
    { screensaver: 'block', autoApps: true });
  assert.deepStrictEqual(validate.patch({ __proto__: { awake: true } }), {});
  assert.deepStrictEqual(validate.patch({ custom: { kind: 'for', minutes: 90 }, durationIndex: 10 }), { durationIndex: 10, custom: { kind: 'for', minutes: 90 } });
  assert.deepStrictEqual(validate.patch({ custom: { kind: 'until', hour: 18, minute: 30, x: 1 } }), { custom: { kind: 'until', hour: 18, minute: 30 } });
  for (const bad of [{ kind: 'for', minutes: 0 }, { kind: 'for', minutes: 1441 }, { kind: 'until', hour: 24, minute: 0 }, { kind: 'until', hour: 1.5, minute: 0 }, { kind: 'never' }, 'x'])
    assert.deepStrictEqual(validate.patch({ custom: bad }), {}, JSON.stringify(bad));
  assert.deepStrictEqual(validate.patch(null), {});
  assert.deepStrictEqual(validate.patch({ pinned: true, hotkey: false }), { hotkey: false, pinned: true });
  assert.ok(validate.appId('/Applications/Logic Pro.app'));
  for (const bad of ['Logic.app', '/Applications/../etc.app', '/x.app\0', 42, '/Applications/Logic Pro']) assert.ok(!validate.appId(bad), String(bad));
});

test('settings: bad or hostile files fall back to defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-set-'));
  const f = path.join(dir, 'settings.json');
  assert.deepStrictEqual(store.load(f), store.DEFAULTS);
  fs.writeFileSync(f, '{not json');
  assert.deepStrictEqual(store.load(f), store.DEFAULTS);
  fs.writeFileSync(f, JSON.stringify({ mode: 'system', durationIndex: 10, custom: { kind: 'for', minutes: 5000 }, watched: [{ id: '/Applications/A.app', name: 'A' }, { id: 'rm -rf', name: 'x' }, 7] }));
  const s = store.load(f);
  assert.strictEqual(s.mode, 'system'); assert.strictEqual(s.durationIndex, 0);
  assert.deepStrictEqual(s.watched, [{ id: '/Applications/A.app', name: 'A' }]);
  store.save(f, s);
  assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(dir), ['settings.json']);
});

test('helpers: fixed system paths, argument arrays, never a shell', () => {
  const src = fs.readFileSync(path.join(__dirname, '../app/engine/macos.js'), 'utf8');
  assert.doesNotMatch(src, /execSync|execFile|child_process'\)\.exec|shell: true/);
  for (const m of src.matchAll(/const (CAFFEINATE|PMSET|PS|IOREG) = '([^']+)'/g)) assert.ok(/^\/(usr\/)?s?bin\//.test(m[2]), m[2]);
  assert.match(src, /'-w', String\(this\.ownerPid\)/, 'the hold is tied to our process');
});

test('the panel only gets panel files', () => {
  const main = fs.readFileSync(path.join(__dirname, '../app/main.js'), 'utf8');
  const SERVED = new RegExp(main.match(/const SERVED = \/(.+)\/;/)[1]);
  assert.ok(SERVED.test('/renderer/wake.js'));
  for (const p of ['/main.js', '/engine/macos.js', '/store.js', '/renderer/../main.js', '/assets/trayTemplate.png']) assert.ok(!SERVED.test(p), p);
  assert.match(main, /sandbox: true/); assert.match(main, /contextIsolation: true/); assert.match(main, /devTools: false/);
});

test('hold: tied to its owner and released when stopped', { skip: process.platform !== 'darwin' }, async () => {
  const h = new macos.Hold();
  h.start('system');
  await new Promise(r => setTimeout(r, 400));
  const p = await macos.readAssertions();
  assert.ok(macos.holdVerified(p, h.pid, 'system'));
  h.stop();
});
