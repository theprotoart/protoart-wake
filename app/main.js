// ProtoArt Wake: menu-bar keep-awake app. The main process owns the hold, the
// timer, the auto triggers and the menu-bar icon; the panel only displays state.
'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, Notification, protocol, session, screen, powerMonitor, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const macos = require('./engine/macos');
const { Session, DURATION_MINUTES, CUSTOM_INDEX } = require('./engine/session');
const store = require('./store');
const validate = require('./validate');

const APP_ORIGIN = 'app://wake';
const PANEL_URL = `${APP_ORIGIN}/renderer/index.html`;
const TICK_MS = 5000;
const PULSE_EVERY_MS = 30000;
const LOW_BATTERY = 10;
const HOTKEY = 'Control+Option+Command+W';

app.enableSandbox();
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();

let win = null, tray = null;
let settingsFile = null;
let settings = { ...store.DEFAULTS };
const sess = new Session();
const hold = new macos.Hold();
let view = { awake: false, reason: '', paused: '', startedAt: null, endsAt: null };
let shownAt = 0;
let verified = false, report = null, running = [], downloadsActive = false, audioActive = false, lastParsed = null;
let lastPulse = 0, lightsOutAt = 0, holdRestarts = 0, lastSettingsRead = 0;
let fileState = null; // { path, size, changedAt } for a "while file is downloading" session

// ------------------------------------------------------------------ State

function persist() {
  try { store.save(settingsFile, settings); } catch { /* not fatal: settings just won't stick */ }
}

function publicState() {
  const watchedIds = new Set(settings.watched.map(w => w.id));
  const runningIds = new Set(running.map(r => r.id));
  const apps = [
    ...settings.watched.map(w => ({ id: w.id, name: w.name, watched: true, running: runningIds.has(w.id) })),
    ...running.filter(r => !watchedIds.has(r.id)).map(r => ({ id: r.id, name: r.name, watched: false, running: true })),
  ].slice(0, 80);
  return {
    awake: view.awake, reason: view.reason, paused: view.paused, startedAt: view.startedAt, endsAt: view.endsAt, verified,
    manualKind: view.manualKind || '', durationIndex: sess.durationIndex, custom: sess.custom, mode: settings.mode, screensaver: settings.screensaver,
    autoApps: settings.autoApps, autoDownloads: settings.autoDownloads, autoAudio: settings.autoAudio, autoLogin: settings.autoLogin,
    hotkey: settings.hotkey, pinned: settings.pinned, downloadsActive, audioActive, apps, report,
  };
}

function push() {
  if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('state', publicState());
  updateTray();
}

// ------------------------------------------------------------------ The loop

let ticking = false, tickAgain = false;
async function tick() {
  if (ticking) { tickAgain = true; return; }
  ticking = true;
  try {
    const now = Date.now();
    const panelOpen = !!(win && win.isVisible());
    const appSession = sess.manual && sess.manual.kind === 'app';
    if (settings.autoApps || panelOpen || appSession) running = await macos.readRunningApps().catch(() => running);
    const fileActive = sess.manual && sess.manual.kind === 'file' ? await fileStillDownloading(now) : false;
    if (settings.autoDownloads) downloadsActive = await macos.downloadsInProgress(app.getPath('downloads'));
    else downloadsActive = false;

    const needAssertions = settings.autoAudio || view.awake || panelOpen;
    lastParsed = needAssertions ? await macos.readAssertions().catch(() => null) : null;
    audioActive = !!(lastParsed && macos.audioActive(lastParsed));

    const runningIds = new Set(running.map(r => r.id));
    const watchedRunning = settings.watched.filter(w => runningIds.has(w.id)).map(w => w.name);
    const d = sess.decide({
      now, runningIds, watchedRunning, fileActive, downloadsActive, audioActive,
      autoApps: settings.autoApps, autoDownloads: settings.autoDownloads, autoAudio: settings.autoAudio,
    });
    view = d;

    if (d.awake) {
      const fresh = !hold.active || hold.mode !== settings.mode;
      hold.start(settings.mode);
      if (fresh) setTimeout(tick, 800); // confirm with macOS once caffeinate is up
    } else hold.stop();
    if (d.expired) { notify(d.expired, 'Your Mac can sleep again.'); fileState = null; }

    // Ask macOS what it's actually doing: is our hold in place, and who else is holding?
    if (d.awake || panelOpen) {
      const parsed = d.awake ? await macos.readAssertions().catch(() => lastParsed) : lastParsed;
      if (parsed) {
        verified = d.awake && macos.holdVerified(parsed, hold.pid, settings.mode);
        const others = macos.otherHolders(parsed, [hold.pid, process.pid]);
        report = { ...(report || {}), others };
      }
    } else verified = false;
    if (panelOpen && now - lastSettingsRead > 60000) {
      const s = await macos.readSettings().catch(() => null);
      if (s) { report = { ...(report || {}), ...s }; lastSettingsRead = now; }
    }

    // Screen saver BLOCK: tell macOS the user is active now and then. Paused after
    // LIGHTS OUT until someone touches the keyboard or mouse again.
    if (d.awake && settings.mode === 'display' && settings.screensaver === 'block' && now - lastPulse >= PULSE_EVERY_MS) {
      let paused = false;
      if (lightsOutAt) {
        const idle = await macos.readIdleSeconds().catch(() => null);
        if (idle !== null && idle * 1000 < now - lightsOutAt) lightsOutAt = 0; // input since lights out
        else paused = true;
      }
      if (!paused) { macos.pulseUserActive(5); lastPulse = now; }
    }

    // Don't run a laptop flat.
    if (d.awake) {
      const b = await macos.readBattery().catch(() => null);
      if (b && b.onBattery && b.percent !== null && b.percent <= LOW_BATTERY) {
        sess.setPower(false); settings.autoApps = false; settings.autoDownloads = false; settings.autoAudio = false; persist();
        hold.stop(); view = sess.decide({ now });
        notify('Battery low', `Stopped keeping the Mac awake at ${b.percent}%. Auto is off until you turn it back on.`);
      }
    }
  } finally {
    ticking = false;
    push();
    if (tickAgain) { tickAgain = false; setImmediate(tick); }
  }
}

/**
 * A picked download counts as in progress while it exists and is still changing (or still has a
 * browser's partial-download name). Two quiet minutes, or the file vanishing (renamed when done),
 * ends the session.
 */
async function fileStillDownloading(now) {
  if (!fileState) return false;
  let st;
  try { st = await fs.promises.stat(fileState.path); } catch { return false; }
  if (st.isDirectory()) { // Safari .download bundle: newest file inside
    try {
      for (const n of await fs.promises.readdir(fileState.path)) {
        const s2 = await fs.promises.stat(path.join(fileState.path, n)).catch(() => null);
        if (s2 && s2.mtimeMs > st.mtimeMs) st = s2;
      }
    } catch { /* keep the bundle's own date */ }
  }
  if (st.size !== fileState.size || st.mtimeMs !== fileState.mtime) {
    fileState.size = st.size; fileState.mtime = st.mtimeMs; fileState.changedAt = now;
  }
  const quietFor = now - fileState.changedAt;
  return quietFor < (macos.isPartialDownload(fileState.path) ? 10 * 60000 : 2 * 60000);
}

async function pickFile() {
  const r = await dialog.showOpenDialog({
    title: 'Keep the Mac awake while this file downloads',
    buttonLabel: 'Watch', defaultPath: app.getPath('downloads'),
    properties: ['openFile', 'treatPackageAsDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  const p = r.filePaths[0];
  let target = p;
  // Inside a Safari .download bundle: watch the bundle itself.
  const bundle = p.match(/^(.*\.download)\//);
  if (bundle) target = bundle[1];
  const st = await fs.promises.stat(target).catch(() => null);
  if (!st) return;
  fileState = { path: target, size: st.size, mtime: st.mtimeMs, changedAt: Date.now() };
  sess.startForFile(target, path.basename(target).replace(/\.(crdownload|download|part|partial|opdownload)$/i, ''));
  tick();
}

hold.onLost = () => {
  // caffeinate went away without us asking (killed from Activity Monitor, say): put it back.
  holdRestarts++;
  setTimeout(tick, holdRestarts > 5 ? 30000 : 500);
};

function applyHotkey() {
  globalShortcut.unregisterAll();
  if (!settings.hotkey) return;
  try { globalShortcut.register(HOTKEY, () => applyPatch({ awake: !view.awake })); } catch { /* taken by another app */ }
}

function notify(title, body) {
  try { if (Notification.isSupported()) new Notification({ title: `ProtoArt Wake: ${title}`, body, silent: true }).show(); } catch { /* ignore */ }
}

// ------------------------------------------------------------------ Panel requests

function fromPanel(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && !!event.senderFrame && event.senderFrame.url === PANEL_URL;
}
const on = (channel, fn) => ipcMain.on(channel, (event, ...args) => { if (fromPanel(event)) fn(...args); });

function applyPatch(p) {
  const now = Date.now();
  if ('custom' in p) {
    sess.setCustom(p.custom, now, p.awake !== false);
    settings.custom = p.custom; settings.durationIndex = CUSTOM_INDEX;
    delete p.awake;
  }
  if ('durationIndex' in p) { sess.setDuration(p.durationIndex, now); settings.durationIndex = sess.durationIndex; }
  if ('awake' in p) { sess.setPower(p.awake, now); holdRestarts = 0; if (!p.awake) fileState = null; }
  if ('mode' in p) settings.mode = p.mode;
  if ('screensaver' in p) settings.screensaver = p.screensaver;
  if ('autoApps' in p) settings.autoApps = p.autoApps;
  if ('autoDownloads' in p) settings.autoDownloads = p.autoDownloads;
  if ('autoAudio' in p) settings.autoAudio = p.autoAudio;
  if ('hotkey' in p) { settings.hotkey = p.hotkey; applyHotkey(); }
  if ('pinned' in p) { settings.pinned = p.pinned; applyPin(); }
  if ('autoLogin' in p) {
    settings.autoLogin = p.autoLogin;
    try { app.setLoginItemSettings({ openAtLogin: p.autoLogin, openAsHidden: true }); } catch { /* unsupported */ }
  }
  persist();
  tick();
}

on('set', p => applyPatch(validate.patch(p)));
on('toggle-app', id => {
  if (!validate.appId(id)) return;
  const i = settings.watched.findIndex(w => w.id === id);
  if (i >= 0) settings.watched.splice(i, 1);
  else {
    const r = running.find(x => x.id === id);
    if (!r || settings.watched.length >= store.MAX_WATCHED) return; // only apps we actually saw running
    settings.watched.push({ id: r.id, name: r.name });
  }
  persist(); tick();
});
on('start-app', id => {
  if (!validate.appId(id)) return;
  const r = running.find(x => x.id === id);
  if (r) { sess.startForApp(r.id, r.name); tick(); }
});
on('pick-file', () => { pickFile(); });
on('lights-out', () => { lightsOutAt = Date.now(); macos.displaySleepNow().catch(() => {}); });
on('quit', () => app.quit());

// ------------------------------------------------------------------ Menu-bar icon and popover

const icon = name => {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', `${name}.png`));
  img.setTemplateImage(true);
  return img;
};
let icons = null;

function updateTray() {
  if (!tray) return;
  tray.setImage(view.awake ? icons.awake : icons.idle);
  let title = '';
  if (view.awake && view.endsAt) {
    const m = Math.max(0, Math.ceil((view.endsAt - Date.now()) / 60000));
    title = m >= 60 ? ` ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : ` ${m}m`;
  }
  tray.setTitle(title, { fontType: 'monospacedDigit' });
  tray.setToolTip(view.awake ? `ProtoArt Wake: awake${view.reason ? ` (${view.reason})` : ''}` : 'ProtoArt Wake: standby');
}

/** Pinned: floats on top, stays open, and can be dragged anywhere. Unpinned: a menu-bar drop-down. */
function applyPin() {
  if (!win) return;
  win.setMovable(settings.pinned);
  win.setAlwaysOnTop(true, settings.pinned ? 'floating' : 'pop-up-menu');
  if (settings.pinned) {
    const [x, y] = win.getPosition();
    settings.pinX = x; settings.pinY = y; persist();
  }
}

/** A saved pinned position, if it's still on a connected display. */
function pinnedPosition() {
  if (!settings.pinned || settings.pinX === null || settings.pinY === null) return null;
  const [w] = win.getSize();
  const onScreen = screen.getAllDisplays().some(d => {
    const a = d.workArea;
    return settings.pinX + w > a.x + 40 && settings.pinX < a.x + a.width - 40 && settings.pinY >= a.y - 10 && settings.pinY < a.y + a.height - 60;
  });
  return onScreen ? [settings.pinX, settings.pinY] : null;
}

function showPanel() {
  if (!win) return;
  lastSettingsRead = 0;
  const pinned = pinnedPosition();
  if (pinned) {
    win.setPosition(pinned[0], pinned[1], false);
    shownAt = Date.now();
    app.focus({ steal: true });
    win.show(); win.focus();
    tick();
    return;
  }
  const b = tray.getBounds();
  const [w, h] = win.getSize();
  const display = screen.getDisplayNearestPoint({ x: b.x, y: b.y });
  const area = display.workArea;
  const x = Math.round(Math.min(Math.max(b.x + b.width / 2 - w / 2, area.x + 6), area.x + area.width - w - 6));
  const y = Math.round(b.y + b.height + 6 > area.y ? b.y + b.height + 6 : area.y + 6);
  win.setPosition(x, y, false);
  shownAt = Date.now();
  app.focus({ steal: true }); // a menu-bar app isn't active: make the panel key so clicks land
  win.show(); win.focus();
  tick();
}

function togglePanel() { if (win.isVisible()) win.hide(); else showPanel(); }

function openPanelWith(cmd) {
  showPanel();
  const send = () => win.webContents.send('menu', cmd);
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
}

const forMinutes = minutes => applyPatch({ custom: { kind: 'for', minutes } });
const hoursLabel = h => `${h} hour${h === 1 ? '' : 's'}`;

function quickMenu() {
  const appsNow = [...running].sort((a, b) => a.name.localeCompare(b.name));
  const set = patch => () => applyPatch(patch);
  return Menu.buildFromTemplate([
    { label: 'Start New Session:', enabled: false },
    { label: 'Indefinitely', click: () => applyPatch({ durationIndex: 0, awake: true }) },
    { label: 'Minutes', submenu: [5, 10, 15, 20, 30, 45].map(m => ({ label: `${m} minutes`, click: () => forMinutes(m) })) },
    { label: 'Hours', submenu: [1, 2, 3, 4, 5, 6, 8, 10, 12].map(h => ({ label: hoursLabel(h), click: () => forMinutes(h * 60) })) },
    { label: 'Other Time / Until…', click: () => openPanelWith('custom') },
    { label: 'While App Is Running', submenu: appsNow.length
      ? appsNow.map(r => ({ label: r.name, click: () => { sess.startForApp(r.id, r.name); tick(); } }))
      : [{ label: 'Open the app first', enabled: false }] },
    { label: 'While File Is Downloading…', click: () => { pickFile(); } },
    { type: 'separator' },
    ...(view.awake ? [{ label: 'End Session (let the Mac sleep)', click: set({ awake: false }) }, { type: 'separator' }] : []),
    { label: 'Quick Settings', submenu: [
      { label: 'Keep display on', type: 'radio', checked: settings.mode === 'display', click: set({ mode: 'display' }) },
      { label: 'Let display sleep (Mac only)', type: 'radio', checked: settings.mode === 'system', click: set({ mode: 'system' }) },
      { type: 'separator' },
      { label: 'Block screen saver', type: 'checkbox', checked: settings.screensaver === 'block', click: () => applyPatch({ screensaver: settings.screensaver === 'block' ? 'allow' : 'block' }) },
      { type: 'separator' },
      { label: 'Auto: while watched apps are open', type: 'checkbox', checked: settings.autoApps, click: () => applyPatch({ autoApps: !settings.autoApps }) },
      { label: 'Auto: while audio plays', type: 'checkbox', checked: settings.autoAudio, click: () => applyPatch({ autoAudio: !settings.autoAudio }) },
      { label: 'Auto: while downloading', type: 'checkbox', checked: settings.autoDownloads, click: () => applyPatch({ autoDownloads: !settings.autoDownloads }) },
      { type: 'separator' },
      { label: 'Hotkey ⌃⌥⌘W toggles awake', type: 'checkbox', checked: settings.hotkey, click: () => applyPatch({ hotkey: !settings.hotkey }) },
      { label: 'Open at login', type: 'checkbox', checked: settings.autoLogin, click: () => applyPatch({ autoLogin: !settings.autoLogin }) },
    ] },
    { label: 'Open Panel', click: showPanel },
    { label: 'How It Works…', click: () => openPanelWith('about') },
    { label: 'Turn Display Off Now', click: () => { lightsOutAt = Date.now(); macos.displaySleepNow().catch(() => {}); } },
    { type: 'separator' },
    { label: 'Quit ProtoArt Wake', click: () => app.quit() },
  ]);
}

// ------------------------------------------------------------------ Panel files

const SERVED = /^\/renderer\/[a-z-]+\.(html|js|css)$/;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
async function servePanelFile(request) {
  const url = new URL(request.url);
  if (url.host !== 'wake' || !SERVED.test(url.pathname)) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.promises.readFile(path.join(__dirname, url.pathname));
    return new Response(body, { headers: { 'Content-Type': TYPES[path.extname(url.pathname)] } });
  } catch { return new Response('Not found', { status: 404 }); }
}

function lockDownSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(`${APP_ORIGIN}/`) || d.url.startsWith('data:')) }));
}

function createWindow() {
  win = new BrowserWindow({
    width: 440, height: 772, useContentSize: true, show: false, frame: false, transparent: true,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, hasShadow: true, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false, devTools: false,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-redirect', e => e.preventDefault());
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // Close like a menu when you click elsewhere (but not in the instant it's being opened).
  win.on('blur', () => { if (win && !settings.pinned && Date.now() - shownAt > 400) win.hide(); });
  let moveTimer = null;
  win.on('moved', () => {
    if (!settings.pinned) return;
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => { const [x, y] = win.getPosition(); settings.pinX = x; settings.pinY = y; persist(); }, 400);
  });
  win.webContents.on('did-finish-load', push);
  win.loadURL(PANEL_URL);
  applyPin();
}

// ------------------------------------------------------------------ App

app.on('second-instance', () => { if (tray) showPanel(); });
// Opened again from Applications, Launchpad or Spotlight while already running: show the panel.
app.on('activate', () => { if (tray) showPanel(); });
app.whenReady().then(() => {
  // Menu-bar only. A test build (marker file) keeps its Dock icon so UI-testing tools can see it.
  if (app.dock && !fs.existsSync(path.join(process.resourcesPath || '', 'wake-test-build'))) app.dock.hide();
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  settings = store.load(settingsFile);
  sess.custom = settings.custom;
  sess.setDuration(settings.durationIndex);
  protocol.handle('app', servePanelFile);
  lockDownSession();
  icons = { idle: icon('trayTemplate'), awake: icon('trayAwakeTemplate') };
  tray = new Tray(icons.idle);
  tray.on('click', togglePanel);
  tray.on('right-click', async () => {
    running = await macos.readRunningApps().catch(() => running);
    tray.popUpContextMenu(quickMenu());
  });
  createWindow();
  applyHotkey();
  // Opened by hand (Applications, Launchpad, Spotlight): show the panel. Opened at login: stay quiet.
  let atLogin = false;
  try { atLogin = !!app.getLoginItemSettings().wasOpenedAtLogin; } catch { /* unknown: treat as opened by hand */ }
  if (!atLogin) win.once('ready-to-show', () => setTimeout(showPanel, 150));
  powerMonitor.on('resume', () => tick());
  powerMonitor.on('unlock-screen', () => tick());
  tick();
  setInterval(tick, TICK_MS);
});
app.on('window-all-closed', e => e.preventDefault()); // lives in the menu bar
app.on('before-quit', () => hold.stop());
app.on('will-quit', () => globalShortcut.unregisterAll());
