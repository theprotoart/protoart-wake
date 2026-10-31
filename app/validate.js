// Validation for everything the panel (renderer) sends to the main process.
'use strict';
const { CUSTOM_INDEX } = require('./engine/session');

const BOOL_KEYS = ['awake', 'autoApps', 'autoDownloads', 'autoAudio', 'autoLogin', 'hotkey', 'pinned'];
const own = (o, k) => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Returns a cleaned partial patch with only known keys and valid values. */
function patch(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const k of BOOL_KEYS) if (typeof own(input, k) === 'boolean') out[k] = input[k];
  const d = own(input, 'durationIndex');
  if (Number.isInteger(d) && d >= 0 && d <= CUSTOM_INDEX) out.durationIndex = d;
  const c = custom(own(input, 'custom'));
  if (c) out.custom = c;
  if (['display', 'system'].includes(own(input, 'mode'))) out.mode = input.mode;
  if (['allow', 'block'].includes(own(input, 'screensaver'))) out.screensaver = input.screensaver;
  return out;
}

/** A custom time: { kind: 'for', minutes 1–1440 } or { kind: 'until', hour 0–23, minute 0–59 }. */
function custom(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const kind = own(v, 'kind');
  if (kind === 'for') {
    const m = own(v, 'minutes');
    return Number.isInteger(m) && m >= 1 && m <= 1440 ? { kind, minutes: m } : null;
  }
  if (kind === 'until') {
    const h = own(v, 'hour'), m = own(v, 'minute');
    return Number.isInteger(h) && h >= 0 && h <= 23 && Number.isInteger(m) && m >= 0 && m <= 59 ? { kind, hour: h, minute: m } : null;
  }
  return null;
}

/** An app id is the absolute path of an .app bundle under an Applications folder. */
function appId(v) {
  return typeof v === 'string' && v.length < 1024 && !v.includes('\0') && v.startsWith('/') && v.endsWith('.app') &&
    !v.split('/').includes('..');
}

module.exports = { patch, appId, custom };
