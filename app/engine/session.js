// Decides whether the Mac should be held awake right now. Pure logic, no I/O.
//
// A manual session is one of:
//   time  - until switched off, for a preset or custom length, or until a clock time
//   app   - while one chosen app keeps running
//   file  - while one chosen file is still downloading
// AUTO rules (watched apps, audio, downloads) can hold the Mac awake on their own.
'use strict';

const DURATION_MINUTES = [0, 15, 30, 60, 120, 180, 240, 360, 480, 720]; // knob stops; 0 = until switched off
const CUSTOM_INDEX = DURATION_MINUTES.length;                             // the knob's SET position
const AUDIO_GRACE_MS = 30000;

/** Next time the local clock reads hour:minute (today if still ahead, else tomorrow). */
function nextClockTime(hour, minute, now) {
  const d = new Date(now);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now + 30000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

class Session {
  constructor({ durationIndex = 0, custom = null } = {}) {
    this.durationIndex = durationIndex;
    this.custom = custom;       // { kind: 'for', minutes } | { kind: 'until', hour, minute }
    this.manual = null;         // { kind: 'time'|'app'|'file', endsAt, appId, appName, filePath, fileName }
    this.awakeSince = null;
    this.suppressed = false;    // switched off during an auto hold: wait until that cause goes away
    this.lastCause = null;
    this.audioUntil = 0;
  }

  /** End time for a timed session starting now (null = until switched off). */
  endsAtFrom(now) {
    if (this.durationIndex === CUSTOM_INDEX && this.custom) {
      if (this.custom.kind === 'for') return now + this.custom.minutes * 60000;
      if (this.custom.kind === 'until') return nextClockTime(this.custom.hour, this.custom.minute, now);
    }
    const m = DURATION_MINUTES[this.durationIndex] || 0;
    return m ? now + m * 60000 : null;
  }

  /** Power button. */
  setPower(on, now = Date.now()) {
    if (on) {
      this.manual = { kind: 'time', endsAt: this.endsAtFrom(now) };
      this.suppressed = false;
    } else {
      this.manual = null;
      if (this.lastCause) this.suppressed = true;
    }
  }

  /** Knob. During a timed session the timer restarts from now. */
  setDuration(index, now = Date.now()) {
    if (!Number.isInteger(index) || index < 0 || index > CUSTOM_INDEX) return;
    if (index === CUSTOM_INDEX && !this.custom) return; // SET needs a custom time first
    this.durationIndex = index;
    if (this.manual && this.manual.kind === 'time') this.manual.endsAt = this.endsAtFrom(now);
  }

  /** Custom length or clock time (the SET position); optionally starts a session right away. */
  setCustom(custom, now = Date.now(), start = true) {
    this.custom = custom;
    this.durationIndex = CUSTOM_INDEX;
    if (start || (this.manual && this.manual.kind === 'time')) this.setPower(true, now);
  }

  /** Stay awake while one app runs (ends when it quits). */
  startForApp(appId, appName) {
    this.manual = { kind: 'app', endsAt: null, appId, appName };
    this.suppressed = false;
  }

  /** Stay awake while one file downloads (ends when it finishes or disappears). */
  startForFile(filePath, fileName) {
    this.manual = { kind: 'file', endsAt: null, filePath, fileName };
    this.suppressed = false;
  }

  /**
   * inputs: { now, runningIds:Set, watchedRunning:string[], fileActive, downloadsActive, audioActive,
   *           autoApps, autoDownloads, autoAudio }
   * Returns { awake, reason, paused, startedAt, endsAt, expired }. expired is a short message once,
   * when a manual session ends on its own; paused names an auto cause the user switched off.
   */
  decide({
    now = Date.now(), runningIds = new Set(), watchedRunning = [], fileActive = false,
    downloadsActive = false, audioActive = false, autoApps = false, autoDownloads = false, autoAudio = false,
  } = {}) {
    let expired = '';
    const m = this.manual;
    if (m && m.kind === 'time' && m.endsAt && now >= m.endsAt) { expired = 'Time is up.'; this.manual = null; }
    else if (m && m.kind === 'app' && !runningIds.has(m.appId)) { expired = `${m.appName} quit.`; this.manual = null; }
    else if (m && m.kind === 'file' && !fileActive) { expired = `${m.fileName} finished downloading.`; this.manual = null; }

    if (audioActive) this.audioUntil = now + AUDIO_GRACE_MS;
    const audioOn = audioActive || now < this.audioUntil;
    let cause = null;
    if (autoApps && watchedRunning.length) {
      cause = watchedRunning.length === 1 ? `Auto: ${watchedRunning[0]} is open` : `Auto: ${watchedRunning[0]} +${watchedRunning.length - 1} are open`;
    } else if (autoAudio && audioOn) {
      cause = 'Auto: audio is playing';
    } else if (autoDownloads && downloadsActive) {
      cause = 'Auto: a download is in progress';
    }
    if (!cause) this.suppressed = false;
    this.lastCause = cause;

    const man = this.manual;
    const awake = !!man || (!!cause && !this.suppressed);
    if (awake && !this.awakeSince) this.awakeSince = now;
    if (!awake) this.awakeSince = null;

    let reason = '';
    if (man && man.kind === 'app') reason = `While ${man.appName} is open`;
    else if (man && man.kind === 'file') reason = `While ${man.fileName} downloads`;
    else if (!man && awake) reason = cause;
    return {
      awake, reason,
      paused: !awake && this.suppressed && cause ? cause.replace(/^Auto: /, '') : '',
      startedAt: this.awakeSince,
      endsAt: man && man.kind === 'time' ? man.endsAt : null,
      manualKind: man ? man.kind : '',
      expired,
    };
  }
}

module.exports = { Session, DURATION_MINUTES, CUSTOM_INDEX, AUDIO_GRACE_MS, nextClockTime };
