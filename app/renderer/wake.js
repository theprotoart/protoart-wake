// ProtoArt Wake panel: shows the state the main process sends and turns controls into requests.
(() => {
'use strict';
const { el, screw, bakeliteKnob, buttonGroup, sevenSegment } = window.Parts;
const $ = id => document.getElementById(id);
const api = window.wake || null; // null when previewed outside the app

const DURATIONS = ['∞', '5', '10', '15', '20', '30', '45', '1H', '1½', '2H', '3H', '4H', '6H', '8H', '12H', 'SET'];
const MINUTES = [0, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720]; // matches the app's knob
const SET = DURATIONS.length - 1;
const W = 440, H = 772;

PressTexture.drawFaceplate($('metal'), W, H, 0x57414b45, 'black');

// Brand plate screws.
[[5, 5, 30], [199, 5, 77], [5, 77, 120], [199, 77, 8]].forEach(([x, y, a]) => {
  const s = screw(10, a); s.style.left = x + 'px'; s.style.top = y + 'px'; $('brand').appendChild(s);
});

// ------------------------------------------------------------------ The tube

$('tube').innerHTML = `
<svg width="96" height="164" viewBox="0 0 96 164">
  <defs>
    <radialGradient id="tg" cx="50%" cy="56%" r="55%"><stop offset="0" stop-color="#ffcf80" stop-opacity=".95"/><stop offset=".35" stop-color="#ff8a2a" stop-opacity=".55"/><stop offset="1" stop-color="#ff5a10" stop-opacity="0"/></radialGradient>
    <linearGradient id="glass" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".18" stop-color="#fff" stop-opacity=".04"/><stop offset=".8" stop-color="#fff" stop-opacity=".02"/><stop offset="1" stop-color="#fff" stop-opacity=".12"/></linearGradient>
    <linearGradient id="plate" x1="0" x2="1"><stop offset="0" stop-color="#2a2a2c"/><stop offset=".5" stop-color="#58585c"/><stop offset="1" stop-color="#232325"/></linearGradient>
  </defs>
  <ellipse class="glow" cx="48" cy="88" rx="50" ry="62" fill="url(#tg)"/>
  <path d="M18 146 L18 40 Q18 8 48 6 Q78 8 78 40 L78 146 Z" fill="rgba(140,150,160,.05)" stroke="rgba(220,225,230,.35)" stroke-width="1.2"/>
  <path d="M22 140 L22 42 Q22 14 40 10" fill="none" stroke="url(#glass)" stroke-width="5" opacity=".9"/>
  <rect x="30" y="52" width="36" height="72" rx="3" fill="url(#plate)" stroke="#111"/>
  <rect x="35" y="58" width="26" height="60" rx="2" fill="#141416" opacity=".75"/>
  <path class="filament" d="M44 62 L44 114 M52 62 L52 114 M44 62 Q48 56 52 62" fill="none" stroke-width="2.2" stroke-linecap="round"/>
  <ellipse class="glow" cx="48" cy="88" rx="12" ry="30" fill="url(#tg)"/>
  <rect x="26" y="38" width="44" height="6" rx="2" fill="#3c3c40" stroke="#151515"/>
  <rect x="26" y="130" width="44" height="6" rx="2" fill="#3c3c40" stroke="#151515"/>
  <path d="M30 44 L30 52 M66 44 L66 52 M30 124 L30 130 M66 124 L66 130" stroke="#555" stroke-width="1.5"/>
  <rect x="14" y="144" width="68" height="18" rx="4" fill="#1b1410" stroke="#000"/>
  <rect x="14" y="144" width="68" height="5" rx="2" fill="rgba(255,255,255,.08)"/>
</svg>`;

// ------------------------------------------------------------------ Controls

const send = patch => { if (api) api.set(patch); else demo.set(patch); };

const power = el('button', { class: 'bigpower', type: 'button', title: 'Keep this Mac awake (click again to let it sleep)' }, $('power'));
el('span', { class: 'cap' }, power);
el('span', { class: 'sym' }, power).innerHTML = '<svg viewBox="0 0 30 30"><path d="M9 8.5 A10 10 0 1 0 21 8.5" fill="none" stroke-width="2.6" stroke-linecap="round"/><line x1="15" y1="3" x2="15" y2="14" stroke-width="2.6" stroke-linecap="round"/></svg>';
const label = el('div', { class: 'power-label' }, $('power'));
const stateText = el('div', { class: 'state', text: 'STANDBY' }, label);
const whyText = el('div', { class: 'engr why', text: '' }, label);
power.addEventListener('click', () => send({ awake: !state.awake }));

const knob = bakeliteKnob($('knob-duration'), {
  title: 'Duration', labels: DURATIONS, index: 0, sweep: 310,
  onChange: i => {
    if (i === SET) { openSheet('custom'); if (state.custom) send({ durationIndex: i }); else knob.set(state.durationIndex); return; }
    send({ durationIndex: i });
  },
  onReset: () => knob.change(0),
});
$('knob-duration').title = 'How long to stay awake: 5 minutes to 12 hours (numbers are minutes, H is hours). ∞ means until you switch it off; SET picks any time. Turning it during a session restarts the timer. Double-click for ∞.';

// Countdown ring: an amber arc around the knob that drains back toward ∞ as the time runs out,
// like a kitchen timer.
const ring = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(NS, 'svg');
  svgEl.setAttribute('class', 'count-ring'); svgEl.setAttribute('width', 170); svgEl.setAttribute('height', 170); svgEl.setAttribute('viewBox', '0 0 170 170');
  const track = document.createElementNS(NS, 'path'); track.setAttribute('class', 'ring-track');
  const arc = document.createElementNS(NS, 'path'); arc.setAttribute('class', 'ring-arc');
  const dot = document.createElementNS(NS, 'circle'); dot.setAttribute('class', 'ring-dot'); dot.setAttribute('r', 2.6);
  svgEl.append(track, arc, dot);
  $('knob-duration').prepend(svgEl);
  const C = 85, R = 44;
  const pt = a => [C + R * Math.sin(a * Math.PI / 180), C - R * Math.cos(a * Math.PI / 180)];
  const path = (a0, a1) => { const [x0, y0] = pt(a0), [x1, y1] = pt(a1); return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`; };
  return {
    show(frac, toIndex) {
      if (frac === null) { svgEl.classList.remove('on'); return; }
      const a0 = knob.angleOf(0), full = knob.angleOf(toIndex);
      const a1 = a0 + Math.max(0.0001, (full - a0) * Math.max(0, Math.min(1, frac)));
      track.setAttribute('d', path(a0, full));
      arc.setAttribute('d', path(a0, a1));
      const [x, y] = pt(a1); dot.setAttribute('cx', x.toFixed(2)); dot.setAttribute('cy', y.toFixed(2));
      svgEl.classList.add('on');
    },
  };
})();

const mode = buttonGroup($('modes'), {
  title: 'Keep awake', labels: ['DISPLAY + MAC', 'MAC ONLY'], width: 100, lamp: 'amber', index: 0,
  caption: 'MAC ONLY lets the screen sleep while downloads, renders and uploads keep running.',
  onChange: i => send({ mode: i ? 'system' : 'display' }),
});
const saver = buttonGroup($('modes'), {
  title: 'Screen saver', labels: ['ALLOW', 'BLOCK'], width: 100, lamp: 'amber', index: 0,
  caption: 'BLOCK tells macOS you are active, so the screen saver and lock never start.',
  onChange: i => send({ screensaver: i ? 'block' : 'allow' }),
});

/** A lit button that latches on and off (Auto options). */
function toggleButton(host, text, lamp, onChange) {
  const row = el('div', { class: 'bg-row' }, host);
  const b = el('button', { class: `pbtn lamp-${lamp}`, type: 'button' }, row);
  el('span', { class: 'cap-face' }, b);
  el('span', { class: 'cap-text', text }, b);
  b.addEventListener('click', () => onChange(!b.classList.contains('lit')));
  return { set: v => b.classList.toggle('lit', !!v), el: b };
}
const autoApps = toggleButton($('auto-buttons'), 'APPS', 'blue', v => send({ autoApps: v }));
const autoAudio = toggleButton($('auto-buttons'), 'AUDIO', 'blue', v => send({ autoAudio: v }));
const autoDl = toggleButton($('auto-buttons'), 'DOWNLOADS', 'blue', v => send({ autoDownloads: v }));
const autoLogin = toggleButton($('auto-buttons'), 'AT LOGIN', 'blue', v => send({ autoLogin: v }));
autoApps.el.title = 'Stay awake while any app lit in the list is running.';
autoAudio.el.title = 'Stay awake while any app is playing or recording audio (renders, bounces, streams).';
autoDl.el.title = 'Stay awake while a browser download is still in progress in your Downloads folder.';
autoLogin.el.title = 'Open ProtoArt Wake when you log in (it starts in standby).';

/** A momentary push button. */
function pushButton(host, text, lamp, onClick, title) {
  const row = el('div', { class: 'bg-row' }, host);
  const b = el('button', { class: `pbtn lamp-${lamp}`, type: 'button', title }, row);
  el('span', { class: 'cap-face' }, b);
  el('span', { class: 'cap-text', text }, b);
  b.addEventListener('click', () => { b.classList.add('lit'); setTimeout(() => b.classList.remove('lit'), 220); onClick(); });
  return b;
}
pushButton($('footer-buttons'), 'LIGHTS OUT', 'amber', () => (api ? api.lightsOut() : null), 'Turn the display off now. The Mac stays as it is.');
pushButton($('footer-buttons'), 'QUIT', 'red', () => (api ? api.quit() : null), 'Quit ProtoArt Wake. Your Mac goes back to its normal sleep settings.');

pushButton($('about-btn'), 'ABOUT', 'blue', () => openSheet('about'), 'How ProtoArt Wake works');
const pin = toggleButton($('pin-btn'), 'PIN', 'blue', v => send({ pinned: v }));
pushButton($('setup-btn'), 'SETUP', 'blue', () => openSheet('setup'), 'Triggers, session rules, reminders, menu bar, Drive Alive and statistics');
pin.el.title = 'Keep this panel open and on top. Drag it by the brand plate or the tube.';

// ------------------------------------------------------------------ Sheets: Set a time, How it works

const SHEETS = ['custom', 'about', 'setup'];
function openSheet(name) {
  for (const id of SHEETS) $(id).hidden = id !== name;
  if (name === 'custom') fillCustom();
  if (name === 'about') $('about').querySelector('.paper').scrollTop = 0;
  if (name === 'setup') { $('setup').querySelector('.paper').scrollTop = 0; renderSetup(true); }
  if (api && api.sheet) api.sheet(true);
}
const closeSheets = () => { for (const id of SHEETS) $(id).hidden = true; knob.set(state.durationIndex); if (api && api.sheet) api.sheet(false); };
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheets));
document.querySelectorAll('.sheet').forEach(sh => sh.addEventListener('click', e => { if (e.target === sh) closeSheets(); }));
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheets(); });

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
function untilParts() {
  const m = /^(\d{1,2}):(\d{2})$/.exec($('c-until').value || '');
  return m ? { hour: clampInt(m[1], 0, 23), minute: clampInt(m[2], 0, 59) } : null;
}
function untilHint() {
  const u = untilParts();
  if (!u) { $('c-until-hint').textContent = ''; return; }
  const d = new Date(); d.setHours(u.hour, u.minute, 0, 0);
  if (d.getTime() <= Date.now() + 30000) d.setDate(d.getDate() + 1);
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  $('c-until-hint').textContent = `in ${Math.floor(mins / 60)} h ${mins % 60} min${d.getDate() !== new Date().getDate() ? ' (tomorrow)' : ''}`;
}
$('c-until').addEventListener('input', untilHint);

function fillCustom() {
  const c = state.custom;
  if (c && c.kind === 'for') { $('c-hours').value = Math.floor(c.minutes / 60); $('c-mins').value = c.minutes % 60; }
  if (c && c.kind === 'until') $('c-until').value = `${two(c.hour)}:${two(c.minute)}`;
  untilHint();
  fillAppChoices();
}

/** Running apps for "While an app is running" (refreshed as the list arrives, keeping the choice). */
function fillAppChoices() {
  const sel = $('c-app');
  const keep = sel.value;
  const apps = state.apps.filter(a => a.running).sort((a, b) => a.name.localeCompare(b.name));
  const sig = apps.map(a => a.id).join('|');
  if (sel.dataset.sig === sig) return;
  sel.dataset.sig = sig;
  sel.replaceChildren();
  for (const a of apps) el('option', { value: a.id, text: a.name }, sel);
  if (!apps.length) el('option', { value: '', text: 'Open the app first' }, sel);
  if (apps.some(a => a.id === keep)) sel.value = keep;
  $('c-app-go').disabled = !apps.length;
}

$('c-for').addEventListener('click', () => {
  const minutes = clampInt($('c-hours').value, 0, 24) * 60 + clampInt($('c-mins').value, 0, 59);
  if (minutes < 1) return;
  send({ custom: { kind: 'for', minutes: Math.min(minutes, 1440) } }); closeSheets();
});
$('c-until-go').addEventListener('click', () => {
  const u = untilParts();
  if (!u) return;
  send({ custom: { kind: 'until', hour: u.hour, minute: u.minute } }); closeSheets();
});
$('c-app-go').addEventListener('click', () => {
  const id = $('c-app').value;
  if (id && api) api.startApp(id);
  closeSheets();
});
$('c-file').addEventListener('click', () => { if (api) api.pickFile(); closeSheets(); });

// ------------------------------------------------------------------ Rendering state

let state = {
  awake: false, mode: 'display', screensaver: 'allow', durationIndex: 0, startedAt: null, endsAt: null,
  verified: false, reason: '', custom: null, manualKind: '', pinned: false, autoApps: false, autoDownloads: false, autoAudio: false, autoLogin: false, downloadsActive: false, audioActive: false,
  apps: [], report: null,
};

function setSeg(id, text) {
  const host = $(id);
  if (host.dataset.text === text) return;
  host.dataset.text = text;
  host.replaceChildren(sevenSegment(text, 24));
}
const two = n => String(n).padStart(2, '0');
/** Time for a readout: MM:SS under an hour (the seconds tick), HH:MM above. Returns [text, units]. */
function clockText(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 3600) return [`${two(Math.floor(sec / 60))}:${two(sec % 60)}`, 'MIN · SEC'];
  const m = Math.floor(sec / 60);
  return [`${two(Math.floor(m / 60))}:${two(m % 60)}`, 'HR · MIN'];
}
function hhmm(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return `${two(Math.floor(m / 60))}:${two(m % 60)}`;
}
const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function render() {
  const s = state, now = Date.now();
  document.body.classList.toggle('awake', s.awake);
  document.body.classList.toggle('pinned', !!s.pinned);
  pin.set(s.pinned);
  stateText.textContent = s.awake ? 'AWAKE' : 'STANDBY';
  whyText.textContent = !s.awake ? (s.paused ? `Auto paused until ${s.paused.replace(/ (is|are) (open|playing|in progress)$/, ' stop' + (/ are /.test(s.paused) ? '' : 's'))}` : 'Your Mac sleeps normally')
    : s.reason ? s.reason
    : s.endsAt ? `Until ${clock(s.endsAt)}` : 'Until you switch it off';
  const left = s.awake && s.endsAt ? clockText(s.endsAt - now) : [s.awake ? '--:--' : '00:00', s.awake ? 'NO TIMER' : 'MIN · SEC'];
  const awakeFor = s.awake && s.startedAt ? clockText(now - s.startedAt) : ['00:00', 'MIN · SEC'];
  setSeg('ro-left', left[0]); $('ro-left-u').textContent = left[1];
  setSeg('ro-for', awakeFor[0]); $('ro-for-u').textContent = awakeFor[1];
  knob.set(s.durationIndex);
  if (s.awake && s.endsAt && s.timerFrom && s.endsAt > s.timerFrom) ring.show((s.endsAt - now) / (s.endsAt - s.timerFrom), s.durationIndex);
  else ring.show(null);
  mode.set(s.mode === 'system' ? 1 : 0);
  saver.set(s.screensaver === 'block' ? 1 : 0);
  saver.el.classList.toggle('dim', s.mode === 'system');
  saver.el.title = s.mode === 'system' ? 'Only applies with DISPLAY + MAC (in MAC ONLY the screen is allowed to sleep).' : '';
  autoApps.set(s.autoApps); autoAudio.set(s.autoAudio); autoDl.set(s.autoDownloads); autoLogin.set(s.autoLogin);
  $('auto').classList.toggle('disabled', !s.autoApps);

  $('led-held').classList.toggle('on', s.awake && s.verified);
  $('led-held').classList.toggle('blink', s.awake && !s.verified);
  $('led-timer').classList.toggle('on', s.awake && !!s.endsAt);
  const pr = s.prefs || {};
  $('led-auto').classList.toggle('on', !!(s.autoApps || s.autoDownloads || s.autoAudio || pr.trigSchedule || pr.trigPower || pr.trigDisplay || pr.trigDrive || pr.trigCPU));
  $('row-held').title = s.awake ? (s.verified ? 'macOS confirms the keep-awake hold is in place.' : 'Waiting for macOS to confirm the hold…') : 'No hold: the Mac sleeps normally.';

  renderApps();
  renderStatus();
  if (!$('custom').hidden && document.activeElement !== $('c-app')) fillAppChoices();
  if (!$('setup').hidden) renderSetup(false);
}

// ------------------------------------------------------------------ Set-up Card

const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // 1 = Sunday
const days = DAY_NAMES.map((n, i) => {
  const b = el('button', { class: 'day', type: 'button', text: n, title: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i] }, $('s-days'));
  b.addEventListener('click', () => {
    const cur = new Set((state.prefs && state.prefs.schedDays) || []);
    if (cur.has(i + 1)) cur.delete(i + 1); else cur.add(i + 1);
    send({ schedDays: [...cur].sort() });
  });
  return b;
});
const toTime = m => `${two(Math.floor(m / 60))}:${two(m % 60)}`;
const fromTime = v => { const m = /^(\d{1,2}):(\d{2})/.exec(v || ''); return m ? clampInt(m[1], 0, 23) * 60 + clampInt(m[2], 0, 59) : null; };

for (const input of document.querySelectorAll('#setup [data-pref]')) {
  input.addEventListener('change', () => {
    const k = input.dataset.pref;
    let v;
    if (input.type === 'checkbox') v = input.checked;
    else if ('time' in input.dataset) { v = fromTime(input.value); if (v === null) return; }
    else if ('num' in input.dataset) v = Number(input.value);
    else v = input.value;
    send({ [k]: v });
  });
}
$('s-reset').addEventListener('click', () => { if (api && api.resetStats) api.resetStats(); });

/** Drive check-boxes for one list (trigger drives or Drive Alive drives). */
function renderDrives(host, key, external) {
  const vols = (state.volumes || []).filter(v => !external || v.external);
  const chosen = new Set((state.prefs && state.prefs[key]) || []);
  const sig = vols.map(v => v.path).join('|') + '#' + [...chosen].join('|');
  if (host.dataset.sig === sig) return;
  host.dataset.sig = sig;
  host.replaceChildren();
  // drives chosen before but not connected now stay listed, so they can be unticked
  const list = [...vols.map(v => ({ path: v.path, name: v.name, here: true })),
    ...[...chosen].filter(p => !vols.some(v => v.path === p)).map(p => ({ path: p, name: p.replace(/^\/Volumes\//, ''), here: false }))];
  if (!list.length) { el('div', { class: 'note', text: external ? 'No external drives connected.' : 'No drives connected.' }, host); return; }
  for (const v of list) {
    const lab = el('label', { class: 'chk' }, host);
    const box = el('input', { type: 'checkbox' }, lab);
    box.checked = chosen.has(v.path);
    lab.append(` ${v.name}${v.here ? '' : ' (not connected)'}`);
    box.addEventListener('change', () => {
      const next = new Set(chosen);
      if (box.checked) next.add(v.path); else next.delete(v.path);
      send({ [key]: [...next].sort() });
    });
  }
}

function duration(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.round(h / 24)} days`;
}

function renderSetup(force) {
  const p = state.prefs;
  if (!p) { $('setup').querySelector('.lede').textContent = 'These settings need the ProtoArt Wake app.'; return; }
  for (const input of document.querySelectorAll('#setup [data-pref]')) {
    if (!force && document.activeElement === input) continue;
    const v = p[input.dataset.pref];
    if (v === undefined) continue;
    if (input.type === 'checkbox') input.checked = !!v;
    else if ('time' in input.dataset) input.value = toTime(v);
    else input.value = String(v);
  }
  const sd = new Set(p.schedDays || []);
  days.forEach((b, i) => b.classList.toggle('on', sd.has(i + 1)));
  const battery = state.power && state.power.hasBattery;
  $('s-power-row').classList.toggle('dim', !battery);
  $('s-unplug-row').classList.toggle('dim', !battery);
  $('s-cpu').textContent = p.trigCPU && state.cpu !== null && state.cpu !== undefined ? `Right now: ${state.cpu}%` : '';
  renderDrives($('s-trig-drives'), 'trigDrives', false);
  renderDrives($('s-alive-drives'), 'aliveDrives', true);
  const st = state.stats;
  if (st) {
    const since = new Date(st.since).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    $('s-stats').innerHTML = `<div><b>${st.sessions}</b> session${st.sessions === 1 ? '' : 's'} since ${esc(since)}</div>` +
      `<div>Kept awake <b>${esc(duration(st.seconds))}</b> in all</div><div>Longest <b>${esc(duration(st.longest))}</b></div>`;
  }
}

function renderApps() {
  const list = $('app-list');
  list.replaceChildren();
  const watched = s => s.watched;
  const apps = [...state.apps].sort((a, b) => (watched(b) - watched(a)) || (b.running - a.running) || a.name.localeCompare(b.name));
  if (!apps.length) { el('div', { class: 'hint', text: 'Open the apps you want here, then click one to watch it.' }, list); return; }
  for (const a of apps) {
    const row = el('div', { class: 'app' + (a.watched ? '' : ' off'), title: a.watched ? 'Click to stop watching' : 'Click to keep the Mac awake while this app runs' }, list);
    el('span', { class: `led mini ${a.watched && a.running ? 'green on' : a.watched ? 'amber on' : 'amber'}` }, row);
    el('span', { class: 'nm', text: a.name }, row);
    el('span', { class: 'tag', text: a.watched ? (a.running ? 'RUNNING' : 'WATCHING') : a.running ? 'OPEN' : '' }, row);
    row.addEventListener('click', () => (api ? api.toggleApp(a.id) : demo.toggleApp(a.id)));
  }
}

function renderStatus() {
  const r = state.report, s = state;
  const lines = [];
  if (s.awake) {
    lines.push(s.verified ? `<b>Held by macOS</b> since ${clock(s.startedAt)}${s.mode === 'system' ? ' · display may sleep' : ''}` : 'Asking macOS to hold…');
  }
  if (r) {
    const sys = r.sleepMinutes ? `${r.sleepMinutes} min` : 'never';
    const disp = r.displayMinutes ? `${r.displayMinutes} min` : 'never';
    lines.push(`Normally sleeps after <b>${esc(sys)}</b> · display <b>${esc(disp)}</b>`);
    const others = r.others || [];
    lines.push(others.length ? `Also awake for: ${others.map(o => `<b>${esc(o)}</b>`).join(', ')}` : 'Nothing else is keeping it awake');
  }
  $('status-text').innerHTML = lines.slice(0, 3).map(l => `<div>${l}</div>`).join('');
  $('status').title = r && r.others && r.others.length ? 'Other apps holding the Mac awake: ' + r.others.join(', ') : '';
}

setInterval(render, 1000);

// ------------------------------------------------------------------ Wiring (or a demo when previewed)

const demo = {
  set(p) {
    if (p.custom) { state.custom = p.custom; state.durationIndex = SET; p = { awake: true, durationIndex: SET }; }
    Object.assign(state, p);
    if ('awake' in p || 'durationIndex' in p) {
      if (state.awake) {
        state.startedAt = state.startedAt && !('durationIndex' in p) ? state.startedAt : Date.now();
        const c = state.custom;
        const mins = state.durationIndex === SET && c ? (c.kind === 'for' ? c.minutes : 90) : MINUTES[state.durationIndex];
        state.endsAt = mins ? Date.now() + mins * 60000 : null; state.timerFrom = Date.now();
        state.verified = true;
      } else { state.startedAt = state.endsAt = null; state.verified = false; }
    }
    render();
  },
  toggleApp(id) { const a = state.apps.find(x => x.id === id); if (a) a.watched = !a.watched; render(); },
};
window.__demo = (patch) => { Object.assign(state, patch); render(); };

if (api) {
  api.onState(s => { state = s; render(); });
  if (api.onMenu) api.onMenu(cmd => { if (SHEETS.includes(cmd)) openSheet(cmd); });
}
else render();
})();
