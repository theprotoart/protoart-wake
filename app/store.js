// Settings saved as JSON in the app's own folder, written atomically.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { custom: cleanCustom } = require('./validate');

const DEFAULTS = {
  durationIndex: 0, custom: null, mode: 'display', screensaver: 'allow',
  autoApps: false, autoDownloads: false, autoAudio: false, autoLogin: false, hotkey: true,
  pinned: false, pinX: null, pinY: null,
  watched: [], // [{ id, name }]
};
const MAX_WATCHED = 50;

function load(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run or unreadable: defaults */ }
  const s = { ...DEFAULTS };
  s.custom = cleanCustom(data.custom);
  for (const k of ['pinX', 'pinY']) if (Number.isInteger(data[k]) && Math.abs(data[k]) < 100000) s[k] = data[k];
  if (Number.isInteger(data.durationIndex) && data.durationIndex >= 0 && data.durationIndex <= (s.custom ? 10 : 9)) s.durationIndex = data.durationIndex;
  if (['display', 'system'].includes(data.mode)) s.mode = data.mode;
  if (['allow', 'block'].includes(data.screensaver)) s.screensaver = data.screensaver;
  for (const k of ['autoApps', 'autoDownloads', 'autoAudio', 'autoLogin', 'hotkey', 'pinned']) if (typeof data[k] === 'boolean') s[k] = data[k];
  if (Array.isArray(data.watched)) {
    s.watched = data.watched
      .filter(w => w && typeof w.id === 'string' && typeof w.name === 'string' && w.id.startsWith('/') && w.id.endsWith('.app'))
      .slice(0, MAX_WATCHED).map(w => ({ id: w.id, name: w.name.slice(0, 120) }));
  }
  return s;
}

function save(file, s) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.settings-${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}

module.exports = { load, save, DEFAULTS, MAX_WATCHED };
