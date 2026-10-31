// Rack hardware: screws, knobs, fader, bat-handle toggles, 7-segment digits, masking tape, VU meter.
(() => {
'use strict';

const SVGNS = 'http://www.w3.org/2000/svg';
let uid = 0;
const nextId = p => `${p}${++uid}`;

function el(tag, attrs = {}, parent) {
  const e = tag.startsWith('svg:') ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.setAttribute('class', v);
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

function svg(w, h, inner) {
  const s = el('svg:svg', { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
  s.innerHTML = inner;
  return s;
}

// ------------------------------------------------------------------ Screw

function screw(size = 15, angle = 20) {
  const id = nextId('scr');
  const r = size / 2;
  const arm = size * 0.31, t = size * 0.075;
  const cross = `<rect x="${r - arm}" y="${r - t}" width="${arm * 2}" height="${t * 2}" rx="${t}"/><rect x="${r - t}" y="${r - arm}" width="${t * 2}" height="${arm * 2}" rx="${t}"/>`;
  const wrap = el('div', { class: 'screw-wrap' });
  wrap.appendChild(svg(size + 2, size + 2, `
    <defs>
      <radialGradient id="${id}" cx="32%" cy="28%" r="80%"><stop offset="0" stop-color="#f6f6f6"/><stop offset=".55" stop-color="#a6a6a8"/><stop offset="1" stop-color="#5c5c5e"/></radialGradient>
    </defs>
    <circle cx="${r + 1.4}" cy="${r + 2}" r="${r}" fill="rgba(0,0,0,.45)" style="filter:blur(1px)"/>
    <circle cx="${r}" cy="${r}" r="${r - 0.3}" fill="url(#${id})" stroke="rgba(0,0,0,.4)" stroke-width=".7"/>
    <g transform="rotate(${angle} ${r} ${r})">
      <g fill="rgba(255,255,255,.5)" transform="translate(.5 .8)">${cross}</g>
      <g fill="#373738">${cross}</g>
    </g>
    <circle cx="${r}" cy="${r}" r="${size * 0.14}" fill="rgba(90,64,38,.18)"/>`));
  return wrap;
}

// ------------------------------------------------------------------ Knob

function bakeliteKnob(host, { title, labels, index, onChange, onReset, sweep = 270 }) {
  const angleOf = i => (labels.length > 1 ? -sweep / 2 + (sweep * i) / (labels.length - 1) : 0);
  const scale = el('div', { class: 'knob-scale' }, host);
  const center = 85, rTick = 47, rLab = labels.length > 4 ? 70 : 66;
  const labs = labels.map((text, i) => {
    const a = angleOf(i);
    el('div', { class: 'tick', style: `transform: rotate(${a + 180}deg) translateY(${rTick}px)` }, scale);
    const rad = (a * Math.PI) / 180;
    const lab = el('div', { class: 'engr lab', text, style: `left:${center + Math.sin(rad) * rLab}px; top:${center - Math.cos(rad) * rLab}px` }, scale);
    lab.addEventListener('click', () => set(i));
    return lab;
  });

  const knob = el('div', { class: 'knob' }, host);
  el('div', { class: 'shadow' }, knob);
  const rotor = el('div', { class: 'rotor' }, knob);
  const g1 = nextId('kb'), g2 = nextId('kc');
  let knurl = '';
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2, c = 38;
    knurl += `M${c + Math.cos(a) * 32} ${c + Math.sin(a) * 32}L${c + Math.cos(a) * 37} ${c + Math.sin(a) * 37}`;
  }
  rotor.appendChild(svg(76, 76, `
    <defs>
      <radialGradient id="${g1}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#46302a"/><stop offset=".5" stop-color="#221712"/><stop offset="1" stop-color="#0d0907"/></radialGradient>
      <radialGradient id="${g2}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#4a332b"/><stop offset="1" stop-color="#1a110d"/></radialGradient>
    </defs>
    <circle cx="38" cy="38" r="37.5" fill="url(#${g1})"/>
    <path d="${knurl}" stroke="rgba(0,0,0,.6)" stroke-width="1.7"/>
    <path d="${knurl}" stroke="rgba(255,255,255,.07)" stroke-width=".8" transform="rotate(1.5 38 38)"/>
    <circle cx="38" cy="39.5" r="28" fill="rgba(0,0,0,.45)" style="filter:blur(1.5px)"/>
    <circle cx="38" cy="38" r="28" fill="url(#${g2})" stroke="rgba(0,0,0,.6)"/>
    <rect x="36.5" y="9" width="3" height="20" rx="1.5" fill="#eee6d2" opacity=".93"/>`));
  el('div', { class: 'spec' }, knob);
  el('div', { class: 'engr knob-title', text: title }, host);

  let current = index, dragging = false, committed = index;
  function render() {
    rotor.style.transform = `rotate(${angleOf(current)}deg)`;
    labs.forEach((l, i) => l.classList.toggle('sel', i === current));
  }
  const clamp = i => Math.max(0, Math.min(labels.length - 1, i));
  /** Moves the pointer (visual only); commit() reports it. */
  function preview(i) { i = clamp(i); if (i !== current) { current = i; render(); } }
  function commit() { if (current !== committed) { committed = current; onChange(current); } }
  function set(i) { preview(i); commit(); }

  // Turn it like a real knob: the pointer's angle around the centre picks the nearest stop,
  // so it follows your hand and never "fights" back. While you hold it, updates from the app
  // don't move it; the choice is sent once, when you let go.
  const stopNearest = (ev) => {
    const r = knob.getBoundingClientRect();
    const a = Math.atan2(ev.clientX - (r.left + r.width / 2), -(ev.clientY - (r.top + r.height / 2))) * 180 / Math.PI;
    let best = current, bestD = 1e9;
    labels.forEach((_, i) => { const d = Math.abs(angleOf(i) - a); if (d < bestD) { bestD = d; best = i; } });
    return bestD <= sweep / (labels.length - 1) * 1.5 + 25 ? best : current; // ignore the dead zone at the bottom
  };
  knob.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    knob.setPointerCapture(e.pointerId);
    dragging = true; knob.classList.add('turning');
    const r = knob.getBoundingClientRect();
    const nearCentre = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < r.width * 0.18;
    const sx = e.clientX, sy = e.clientY, start = current;
    const move = ev => {
      // from the cap's centre a rotation angle is meaningless: drag up/right instead
      if (nearCentre) preview(start + Math.round(((ev.clientX - sx) - (ev.clientY - sy)) / step));
      else preview(stopNearest(ev));
    };
    const up = () => {
      dragging = false; knob.classList.remove('turning');
      knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', up); knob.removeEventListener('pointercancel', up);
      commit();
    };
    knob.addEventListener('pointermove', move);
    knob.addEventListener('pointerup', up);
    knob.addEventListener('pointercancel', up);
  });
  const step = labels.length > 4 ? 12 : 26;
  // Scroll: trackpads send many small events, so add them up to one click per notch.
  let wheelAcc = 0, wheelT = 0;
  knob.addEventListener('wheel', e => {
    e.preventDefault();
    wheelAcc += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX;
    const notch = 40;
    while (Math.abs(wheelAcc) >= notch) { preview(current + Math.sign(wheelAcc)); wheelAcc -= Math.sign(wheelAcc) * notch; }
    clearTimeout(wheelT); wheelT = setTimeout(() => { wheelAcc = 0; commit(); }, 250);
  }, { passive: false });
  // Double-click springs the knob back to its default.
  if (onReset) knob.addEventListener('dblclick', onReset);

  render();
  return {
    set: i => { if (dragging) return; current = committed = clamp(i); render(); },
    change: set,
    angleOf,
    get dragging() { return dragging; },
  };
}

// ------------------------------------------------------------------ Fader

function fader(host, { title, subtitle, value, min, max, marks, onChange, onReset }) {
  const len = 160, top = 14; // cap travel inside the track
  const frac = v => (v - min) / (max - min);
  const scale = el('div', { class: 'scale' }, host);
  for (const m of marks) {
    const row = el('div', { class: 'mark', style: `top:${(1 - frac(m)) * len}px` }, scale);
    el('span', { class: 'engr', text: String(m) }, row);
    el('i', {}, row);
  }
  const track = el('div', { class: 'track' }, host);
  el('div', { class: 'slot-line' }, track);
  const cap = el('div', { class: 'cap' }, track);
  const gid = nextId('fc');
  cap.appendChild(svg(42, 28, `
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a332b"/><stop offset="1" stop-color="#110b08"/></linearGradient></defs>
    <rect x="2" y="5" width="40" height="23" rx="4" fill="rgba(0,0,0,.45)" style="filter:blur(2px)"/>
    <rect x="0" y="0" width="40" height="26" rx="4" fill="url(#${gid})" stroke="rgba(0,0,0,.5)"/>
    <rect x="1" y="1" width="38" height="1" fill="rgba(255,255,255,.2)"/>
    ${[5, 9, 17, 21].map(y => `<rect x="5" y="${y}" width="30" height="1" fill="rgba(0,0,0,.6)"/><rect x="5" y="${y + 1}" width="30" height=".6" fill="rgba(255,255,255,.12)"/>`).join('')}
    <rect x="3" y="12.2" width="34" height="2" fill="#eee6d2"/>`));
  const titles = el('div', { class: 'titles' }, host);
  el('span', { class: 'engr', text: title }, titles);
  el('span', { class: 'engr small', text: subtitle }, titles);

  let current = value;
  const render = () => { cap.style.top = `${top + (1 - frac(current)) * len}px`; };
  const fromY = y => {
    const r = track.getBoundingClientRect();
    const f = 1 - (y - r.top - top) / len;
    return Math.max(min, Math.min(max, Math.round(min + f * (max - min))));
  };
  track.addEventListener('pointerdown', e => {
    track.setPointerCapture(e.pointerId);
    const move = ev => { const v = fromY(ev.clientY); if (v !== current) { current = v; render(); onChange(v); } };
    move(e);
    const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
  });
  if (onReset) track.addEventListener('dblclick', onReset);
  render();
  return { change: v => { if (v !== current) { current = v; render(); onChange(v); } } };
}

// ------------------------------------------------------------------ Bat-handle toggle

/** labels: bottom → top (2 or 3 positions). */
function batToggle(host, { title, labels, position, onChange }) {
  const root = el('div', { class: 'toggle' }, host);
  const n = labels.length;
  const posEls = [];
  const up = el('div', { class: 'engr pos up', text: labels[n - 1] }, root); posEls[n - 1] = up;
  const down = el('div', { class: 'engr pos down', text: labels[0] }, root); posEls[0] = down;
  if (n === 3) posEls[1] = el('div', { class: 'engr pos mid', text: labels[1] }, root);
  posEls.forEach((p, i) => p.addEventListener('click', () => set(i)));

  const sw = el('div', { class: 'sw' }, root);
  const chrome = nextId('ch'), bush = nextId('bu');
  const hex = Array.from({ length: 6 }, (_, i) => { const a = (i * Math.PI) / 3 + 0.2; return `${24 + Math.cos(a) * 15},${40 + Math.sin(a) * 15}`; }).join(' ');
  // Lever drawn pointing up from the bushing center (24,40); scaled vertically to swing.
  const lever = 'M21.6 40 L20.4 16 A5.6 5.6 0 1 1 27.6 16 L26.4 40 Z';
  sw.appendChild(svg(48, 80, `
    <defs>
      <linearGradient id="${chrome}" x1="0" x2="1"><stop offset="0" stop-color="#7e7e80"/><stop offset=".28" stop-color="#fafafa"/><stop offset=".52" stop-color="#a8a8aa"/><stop offset=".76" stop-color="#ededee"/><stop offset="1" stop-color="#6a6a6c"/></linearGradient>
      <radialGradient id="${bush}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#d9d9da"/><stop offset="1" stop-color="#57575a"/></radialGradient>
    </defs>
    <circle cx="25" cy="42" r="20" fill="rgba(0,0,0,.4)" style="filter:blur(2px)"/>
    <circle cx="24" cy="40" r="20" fill="url(#${chrome})" stroke="rgba(0,0,0,.3)"/>
    <polygon points="${hex}" fill="url(#${chrome})" stroke="rgba(0,0,0,.4)" stroke-width=".8"/>
    <circle cx="24" cy="40" r="8" fill="url(#${bush})"/>
    <g class="lever-shadow lever" style="transform-origin:24px 40px; filter:blur(1.4px)" opacity=".35" transform="translate(3 5)"><path d="${lever}" fill="#000"/></g>
    <g class="lever-body lever" style="transform-origin:24px 40px"><path d="${lever}" fill="url(#${chrome})" stroke="rgba(0,0,0,.35)" stroke-width=".6"/><ellipse cx="22.5" cy="13" rx="1.6" ry="2.3" fill="rgba(255,255,255,.85)"/></g>`));
  el('div', { class: 'engr title', text: title }, root);

  const levers = sw.querySelectorAll('.lever');
  let current = position;
  function render() {
    // -1 lever down … +1 lever up; near 0 it points at the viewer.
    const t = n > 1 ? (current / (n - 1)) * 2 - 1 : 0;
    const s = Math.abs(t) < 0.24 ? 0.24 : t;
    levers.forEach((l, i) => { l.style.transform = (i === 0 ? 'translate(3px,5px) ' : '') + `scaleY(${s})`; });
    posEls.forEach((p, i) => p && p.classList.toggle('sel', i === current));
  }
  function set(i) {
    i = Math.max(0, Math.min(n - 1, i));
    if (i === current) return;
    current = i; render(); onChange(i);
  }
  let startY = null;
  sw.addEventListener('pointerdown', e => { startY = e.clientY; sw.setPointerCapture(e.pointerId); });
  sw.addEventListener('pointerup', e => {
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 6) set(current + (dy < 0 ? 1 : -1));       // push the lever
    else set(current + 1 > n - 1 ? 0 : current + 1);                // click cycles upward
    startY = null;
  });
  render();
  return { set: i => { current = i; render(); }, change: set };
}

// ------------------------------------------------------------------ Seven-segment display

const SEGMENTS = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc',
  '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '',
};

function segPolygons(ox, h) {
  const w = h * 0.52, t = h * 0.12, g = t * 0.18, slant = 0.1;
  const P = (x, y) => `${(ox + x + (h - y) * slant - h * slant * 0.5).toFixed(2)},${y.toFixed(2)}`;
  const L = t / 2, R = w - t / 2, T = t / 2, M = h / 2, B = h - t / 2;
  const horiz = y => [P(L + g, y), P(L + g + t / 2, y - t / 2), P(R - g - t / 2, y - t / 2), P(R - g, y), P(R - g - t / 2, y + t / 2), P(L + g + t / 2, y + t / 2)].join(' ');
  const vert = (x, y0, y1) => [P(x, y0 + g), P(x + t / 2, y0 + g + t / 2), P(x + t / 2, y1 - g - t / 2), P(x, y1 - g), P(x - t / 2, y1 - g - t / 2), P(x - t / 2, y0 + g + t / 2)].join(' ');
  return { a: horiz(T), g: horiz(M), d: horiz(B), f: vert(L, T, M), b: vert(R, T, M), e: vert(L, M, B), c: vert(R, M, B), w };
}

function sevenSegment(text, h = 24, color = '#ffb02a') {
  let x = 0, body = '';
  const gap = h * 0.16;
  for (const ch of text) {
    if (ch === ':' || ch === '.') {
      const r = h * 0.066;
      const cx = x + r + 1;
      if (ch === ':') body += `<circle cx="${cx}" cy="${h * 0.32}" r="${r}" fill="${color}"/><circle cx="${cx}" cy="${h * 0.7}" r="${r}" fill="${color}"/>`;
      else body += `<circle cx="${cx}" cy="${h - r}" r="${r}" fill="${color}"/>`;
      x += r * 2 + 2 + gap;
      continue;
    }
    const segs = segPolygons(x, h);
    const lit = SEGMENTS[ch] || '';
    for (const s of 'abcdefg') {
      body += `<polygon points="${segs[s]}" fill="${color}" opacity="${lit.includes(s) ? 1 : 0.085}"/>`;
    }
    x += segs.w + gap;
  }
  const s = svg(Math.ceil(x - gap + 3), h, body);
  return s;
}

// ------------------------------------------------------------------ Masking tape

function tape(text, { size = 17, angle = -2, seed = 1 } = {}) {
  const rng = PressTexture.seededRandom(seed * 7919 + 17);
  const t = el('div', { class: 'tape' });
  t.style.fontSize = size + 'px';
  t.style.transform = `rotate(${angle}deg)`;
  const paper = el('div', { class: 'paper' }, t);
  // Torn ends: jagged polygon on the left and right edges.
  const pts = [];
  pts.push(`${rng() * 3}px 0`, `calc(100% - ${rng() * 3}px) 0`);
  for (let y = 0; y <= 100; y += 9) pts.push(`calc(100% - ${rng() * 5}px) ${y}%`);
  pts.push(`calc(100% - ${rng() * 3}px) 100%`, `${rng() * 3}px 100%`);
  for (let y = 100; y >= 0; y -= 9) pts.push(`${rng() * 5}px ${y}%`);
  paper.style.clipPath = `polygon(${pts.join(',')})`;
  const ink = el('span', { class: 'ink', text }, t);
  ink.style.transform = `rotate(${(-angle * 0.4).toFixed(2)}deg)`;
  return t;
}

// ------------------------------------------------------------------ VU meter

/**
 * Backlit analog VU meter. The needle shows completion of the current batch.
 * The lamp is off when idle and warms up like a tube when work starts, with a
 * faint flicker; the needle rests at zero when the unit is idle.
 */
class VUMeter {
  constructor(canvas, w, h, bezel) {
    const s = window.devicePixelRatio || 1;
    canvas.width = w * s; canvas.height = h * s;
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    this.ctx = canvas.getContext('2d');
    this.ctx.scale(s, s);
    this.w = w; this.h = h; this.bezel = bezel;
    this.target = 0; this.pos = 0; this.vel = 0;
    this.lit = false; this.lamp = 0;
    this.sweep = (96 * Math.PI) / 180;
    this.last = performance.now();
    const loop = now => { this.step(now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  /** value: 0…1 completion. lit: lamp on. */
  set(value, lit) { this.target = Math.max(0, Math.min(1, value)); this.lit = lit; }

  step(now) {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    // Under-damped spring: real meter ballistics with a little overshoot.
    const k = 38, c = 6.5;
    this.vel += (k * (this.target - this.pos) - c * this.vel) * dt;
    this.pos += this.vel * dt;
    // Tube lamp: slow warm-up, quicker fade.
    const goal = this.lit ? 1 : 0;
    this.lamp += (goal - this.lamp) * Math.min(1, dt * (this.lit ? 2.4 : 3.2));
    const t = now / 1000;
    const flicker = this.lit ? 1 - 0.035 * (0.5 + 0.5 * Math.sin(t * 37.0) * Math.sin(t * 13.7)) - (Math.random() < 0.015 ? 0.06 : 0) : 1;
    const tremble = this.lit ? (Math.sin(t * 11.3) * 0.45 + Math.sin(t * 6.1) * 0.3 + Math.sin(t * 23) * 0.15) * 0.003 : 0;
    const L = Math.max(0, Math.min(1, this.lamp * flicker));
    this.draw(Math.max(0, this.pos + tremble), L);
    if (this.bezel) {
      this.bezel.style.setProperty('--tube', L.toFixed(3));
    }
  }

  angle(f) { return -this.sweep / 2 + this.sweep * f; }

  draw(f, L) {
    const { ctx, w, h } = this;
    const px = w / 2, py = h * 1.06, R = h * 0.86;
    const mix = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * L));
    const rgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
    // Dial: dim and cold when off, warm cream when the lamp is on.
    const dial = ctx.createLinearGradient(0, 0, 0, h);
    dial.addColorStop(0, rgb(mix([70, 64, 52], [253, 238, 189])));
    dial.addColorStop(1, rgb(mix([46, 41, 33], [238, 209, 148])));
    ctx.fillStyle = dial; ctx.fillRect(0, 0, w, h);
    // Lamp hot-spot from below, like bulbs behind the scale.
    const glow = ctx.createRadialGradient(px, h, 0, px, h, w * 0.8);
    glow.addColorStop(0, `rgba(255,170,60,${0.55 * L})`);
    glow.addColorStop(0.55, `rgba(255,190,90,${0.18 * L})`);
    glow.addColorStop(1, 'rgba(255,200,100,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

    const ink = `rgba(0,0,0,${0.55 + 0.3 * L})`;
    const red = rgb(mix([110, 30, 24], [194, 26, 18]));
    const pt = (a, r) => [px + Math.sin(a) * r, py - Math.cos(a) * r];
    ctx.lineWidth = 1.4; ctx.strokeStyle = ink;
    ctx.beginPath(); ctx.arc(px, py, R, this.angle(0) - Math.PI / 2, this.angle(0.8) - Math.PI / 2); ctx.stroke();
    ctx.lineWidth = 5; ctx.strokeStyle = red;
    ctx.beginPath(); ctx.arc(px, py, R + 2.5, this.angle(0.8) - Math.PI / 2, this.angle(1) - Math.PI / 2); ctx.stroke();
    ctx.font = '700 10px "DIN Condensed", "Arial Narrow", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 20; i++) {
      const fr = i / 20, a = this.angle(fr), major = i % 4 === 0, isRed = fr > 0.8;
      const [x1, y1] = pt(a, R), [x2, y2] = pt(a, R + (major ? 11 : 6));
      ctx.strokeStyle = isRed ? red : ink; ctx.lineWidth = major ? 1.6 : 1;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      if (major) { const [tx, ty] = pt(a, R + 21); ctx.fillStyle = isRed ? red : ink; ctx.fillText(String(i * 5), tx, ty); }
    }
    ctx.fillStyle = ink;
    ctx.font = '900 italic 22px Georgia, "Times New Roman", serif';
    ctx.fillText('VU', px, h * 0.6);
    ctx.font = '700 7.5px "DIN Condensed", "Arial Narrow", sans-serif';
    ctx.fillText('C O M P L E T E', px, h * 0.6 + 16);
    ctx.fillText('%', w - 16, h * 0.5);

    // Needle and its shadow (the shadow only exists when the lamp is lit).
    const a = this.angle(f);
    const [nx, ny] = pt(a, R + 6);
    ctx.lineCap = 'round';
    if (L > 0.02) {
      ctx.strokeStyle = `rgba(0,0,0,${0.2 * L})`; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(px + 3, py + 2); ctx.lineTo(nx + 3, ny + 2); ctx.stroke();
    }
    ctx.strokeStyle = '#111'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(nx, ny); ctx.stroke();

    const hous = ctx.createLinearGradient(0, h - 16, 0, h);
    hous.addColorStop(0, '#3a3a3a'); hous.addColorStop(1, '#050505');
    ctx.fillStyle = hous;
    ctx.beginPath(); ctx.ellipse(px, h + 2, 30, 15, 0, Math.PI, 0); ctx.fill();
    const glass = ctx.createLinearGradient(0, 0, w * 0.6, h * 0.7);
    glass.addColorStop(0, `rgba(255,255,255,${0.12 + 0.18 * L})`); glass.addColorStop(0.4, 'rgba(255,255,255,.04)'); glass.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glass; ctx.fillRect(0, 0, w, h);
  }
}


// ------------------------------------------------------------------ Compact knob (channel strips)

/** Smaller bakelite knob with readable labels, for the per-format channel rows. */
function compactKnob(host, { title, labels, index, onChange, onReset, sweep = 270, size = 46, radius = 38 }) {
  const box = el('div', { class: 'cknob' }, host);
  const W = 2 * (radius + 34), H = 2 * (radius + 16);
  box.style.width = W + 'px';
  box.style.height = (H + 14) + 'px';
  const cx = W / 2, cy = radius + 16;
  const angleOf = i => (labels.length > 1 ? -sweep / 2 + (sweep * i) / (labels.length - 1) : 0);
  const labs = labels.map((text, i) => {
    const a = angleOf(i), rad = (a * Math.PI) / 180;
    el('div', { class: 'tick', style: `left:${cx - 1}px; top:${cy}px; transform: rotate(${a + 180}deg) translateY(${size / 2 + 3}px)` }, box);
    const lab = el('div', { class: 'engr lab', text, style: `left:${cx + Math.sin(rad) * radius}px; top:${cy - Math.cos(rad) * radius}px` }, box);
    lab.addEventListener('click', () => set(i));
    return lab;
  });
  const knob = el('div', { class: 'cknob-body', style: `left:${cx - size / 2}px; top:${cy - size / 2}px; width:${size}px; height:${size}px` }, box);
  el('div', { class: 'shadow' }, knob);
  const rotor = el('div', { class: 'rotor' }, knob);
  const g1 = nextId('ckb'), g2 = nextId('ckc'), c = size / 2;
  let knurl = '';
  for (let i = 0; i < 32; i++) {
    const a = (i / 32) * Math.PI * 2;
    knurl += `M${c + Math.cos(a) * (c - 4)} ${c + Math.sin(a) * (c - 4)}L${c + Math.cos(a) * (c - 0.5)} ${c + Math.sin(a) * (c - 0.5)}`;
  }
  rotor.appendChild(svg(size, size, `
    <defs>
      <radialGradient id="${g1}" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#46302a"/><stop offset=".5" stop-color="#221712"/><stop offset="1" stop-color="#0d0907"/></radialGradient>
      <radialGradient id="${g2}" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#4a332b"/><stop offset="1" stop-color="#1a110d"/></radialGradient>
    </defs>
    <circle cx="${c}" cy="${c}" r="${c - 0.5}" fill="url(#${g1})"/>
    <path d="${knurl}" stroke="rgba(0,0,0,.6)" stroke-width="1.4"/>
    <circle cx="${c}" cy="${c + 1}" r="${c * 0.72}" fill="rgba(0,0,0,.45)" style="filter:blur(1px)"/>
    <circle cx="${c}" cy="${c}" r="${c * 0.72}" fill="url(#${g2})" stroke="rgba(0,0,0,.6)"/>
    <rect x="${c - 1.25}" y="${c * 0.22}" width="2.5" height="${c * 0.55}" rx="1.25" fill="#eee6d2" opacity=".93"/>`));
  el('div', { class: 'spec' }, knob);
  el('div', { class: 'engr cknob-title', text: title, style: `top:${H - 4}px` }, box);

  let current = index;
  function render() {
    rotor.style.transform = `rotate(${angleOf(current)}deg)`;
    labs.forEach((l, i) => l.classList.toggle('sel', i === current));
  }
  function set(i) {
    i = Math.max(0, Math.min(labels.length - 1, i));
    if (i === current) return;
    current = i; render(); onChange && onChange(i);
  }
  const step = labels.length > 4 ? 14 : 22;
  knob.addEventListener('pointerdown', e => {
    knob.setPointerCapture(e.pointerId);
    const sx = e.clientX, sy = e.clientY, start = current;
    const move = ev => set(start + Math.round(((ev.clientX - sx) - (ev.clientY - sy)) / step));
    const up = () => { knob.removeEventListener('pointermove', move); knob.removeEventListener('pointerup', up); };
    knob.addEventListener('pointermove', move);
    knob.addEventListener('pointerup', up);
  });
  knob.addEventListener('wheel', e => { e.preventDefault(); set(current + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  if (onReset) knob.addEventListener('dblclick', onReset);
  render();
  return { set: i => { current = i; render(); }, change: set };
}

// ------------------------------------------------------------------ Compact bat toggle (labels beside the lever)

function compactToggle(host, { title, labels, position, onChange }) {
  const n = labels.length;
  const root = el('div', { class: 'ctoggle' }, host);
  const sw = el('div', { class: 'csw' }, root);
  const chrome = nextId('cch');
  const lever = 'M16.2 28 L15.3 11 A4.2 4.2 0 1 1 20.7 11 L19.8 28 Z';
  sw.appendChild(svg(36, 56, `
    <defs><linearGradient id="${chrome}" x1="0" x2="1"><stop offset="0" stop-color="#7e7e80"/><stop offset=".28" stop-color="#fafafa"/><stop offset=".52" stop-color="#a8a8aa"/><stop offset=".76" stop-color="#ededee"/><stop offset="1" stop-color="#6a6a6c"/></linearGradient></defs>
    <circle cx="18.6" cy="29.4" r="14" fill="rgba(0,0,0,.4)" style="filter:blur(1.5px)"/>
    <circle cx="18" cy="28" r="14" fill="url(#${chrome})" stroke="rgba(0,0,0,.3)"/>
    <circle cx="18" cy="28" r="6" fill="#6a6a6c"/>
    <g class="lever" style="transform-origin:18px 28px"><path d="${lever}" fill="url(#${chrome})" stroke="rgba(0,0,0,.35)" stroke-width=".5"/></g>`));
  const labs = el('div', { class: 'clabels' }, root);
  const posEls = [];
  for (let i = n - 1; i >= 0; i--) {
    const l = el('div', { class: 'engr cpos', text: labels[i] }, labs);
    l.addEventListener('click', () => set(i));
    posEls[i] = l;
  }
  if (title) el('div', { class: 'engr ctitle', text: title }, root);
  const lv = sw.querySelector('.lever');
  let current = position;
  function render() {
    const t = n > 1 ? (current / (n - 1)) * 2 - 1 : 0;
    const s = Math.abs(t) < 0.24 ? 0.24 : t;
    lv.style.transform = `scaleY(${s})`;
    posEls.forEach((p, i) => p.classList.toggle('sel', i === current));
  }
  function set(i) {
    i = Math.max(0, Math.min(n - 1, i));
    if (i === current) return;
    current = i; render(); onChange && onChange(i);
  }
  sw.addEventListener('click', () => set(current + 1 > n - 1 ? 0 : current + 1));
  render();
  return { set: i => { current = i; render(); }, change: set };
}

// ------------------------------------------------------------------ Horizontal fader

function hFader(host, { title, subtitle, value, min, max, marks, onChange, onReset, length = 260 }) {
  const root = el('div', { class: 'hfader' }, host);
  const frac = v => (v - min) / (max - min);
  const scale = el('div', { class: 'hscale', style: `width:${length}px` }, root);
  for (const m of marks) {
    const mk = el('div', { class: 'hmark', style: `left:${frac(m) * length}px` }, scale);
    el('i', {}, mk); el('span', { class: 'engr', text: String(m) }, mk);
  }
  const track = el('div', { class: 'htrack', style: `width:${length + 30}px` }, root);
  el('div', { class: 'hslot' }, track);
  const cap = el('div', { class: 'hcap' }, track);
  const gid = nextId('hfc');
  cap.appendChild(svg(26, 40, `
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#4a332b"/><stop offset="1" stop-color="#110b08"/></linearGradient></defs>
    <rect x="3" y="3" width="23" height="37" rx="4" fill="rgba(0,0,0,.45)" style="filter:blur(2px)"/>
    <rect x="0" y="0" width="24" height="38" rx="4" fill="url(#${gid})" stroke="rgba(0,0,0,.5)"/>
    ${[5, 9, 15, 19].map(x => `<rect x="${x}" y="5" width="1" height="28" fill="rgba(0,0,0,.6)"/>`).join('')}
    <rect x="11" y="3" width="2" height="32" fill="#eee6d2"/>`));
  const titles = el('div', { class: 'htitles' }, root);
  el('span', { class: 'engr', text: title }, titles);
  if (subtitle) el('span', { class: 'engr small', text: subtitle }, titles);
  let current = value;
  const render = () => { cap.style.left = `${frac(current) * length}px`; };
  const fromX = x => {
    const r = track.getBoundingClientRect();
    const f = (x - r.left - 15) / length;
    return Math.max(min, Math.min(max, Math.round(min + f * (max - min))));
  };
  track.addEventListener('pointerdown', e => {
    track.setPointerCapture(e.pointerId);
    const move = ev => { const v = fromX(ev.clientX); if (v !== current) { current = v; render(); onChange && onChange(v); } };
    move(e);
    const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
  });
  if (onReset) track.addEventListener('dblclick', onReset);
  render();
  return { change: v => { if (v !== current) { current = v; render(); onChange && onChange(v); } } };
}


/**
 * Interlocking lit push buttons (one lit at a time), like the selector row
 * on a vintage compressor. Pass multi:true for a single latching on/off button.
 */
function buttonGroup(host, { title, labels, subs, index = 0, lamp = 'amber', vertical = false, width, onChange, onReset, caption }) {
  const box = el('div', { class: 'bgroup' + (vertical ? ' vertical' : '') }, host);
  if (title) el('div', { class: 'engr bg-title', text: title }, box);
  const row = el('div', { class: 'bg-row' }, box);
  let current = index;
  const btns = labels.map((text, i) => {
    const b = el('button', { class: `pbtn lamp-${lamp}`, type: 'button' }, row);
    if (width) b.style.width = width + 'px';
    el('span', { class: 'cap-face' }, b);
    el('span', { class: 'cap-text', text }, b);
    if (subs && subs[i]) el('span', { class: 'cap-sub', text: subs[i] }, b);
    b.addEventListener('click', () => set(i));
    if (onReset) b.addEventListener('dblclick', onReset);
    return b;
  });
  if (caption) el('div', { class: 'engr bg-caption', text: caption }, box);
  function render() { btns.forEach((b, i) => b.classList.toggle('lit', i === current)); }
  function set(i) { if (i === current) return; current = i; render(); onChange && onChange(i); }
  render();
  return { set: i => { current = i; render(); }, change: set, el: box };
}

/** A single latching lit button (e.g. a module's IN switch). */
function latchButton(host, { label, on = true, lamp = 'green', onChange, title }) {
  const box = el('div', { class: 'bgroup latch' }, host);
  const b = el('button', { class: `pbtn round lamp-${lamp}`, type: 'button' }, box);
  el('span', { class: 'cap-face' }, b);
  el('span', { class: 'cap-text', text: label }, b);
  if (title) el('div', { class: 'engr bg-title', text: title }, box);
  let state = on;
  const render = () => b.classList.toggle('lit', state);
  b.addEventListener('click', () => { state = !state; render(); onChange && onChange(state); });
  render();
  return { set: v => { state = !!v; render(); }, el: box };
}

window.Parts = { el, screw, bakeliteKnob, fader, batToggle, sevenSegment, tape, VUMeter, compactKnob, compactToggle, hFader, buttonGroup, latchButton };
})();
