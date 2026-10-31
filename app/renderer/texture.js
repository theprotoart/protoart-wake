// Procedural brushed-aluminum faceplate: hairline grain, sheen bands, grime,
// smudges, micro-scratches, real scratches (groove + lit lip), keyed clusters, dings.
(() => {
'use strict';

function seededRandom(seed) {
  // mulberry32
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.chance = p => next() < p;
  return next;
}

/**
 * finish: 'black' (anodized; scratches cut through to bright bare aluminum)
 * or 'silver' (bare brushed aluminum; scratches read as dark grooves).
 */
function drawFaceplate(canvas, width, height, seed = 0x50524553, finish = 'black') {
  const black = finish === 'black';
  const s = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * s);
  canvas.height = Math.round(height * s);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d');
  const rng = seededRandom(seed);

  // 1. Sheen bands across the brushing, darker toward the bottom.
  const sheen = ctx.createLinearGradient(0, 0, W, 0);
  const bands = black
    ? [[0, .115], [.18, .155], [.37, .13], [.55, .175], [.72, .14], [.86, .16], [1, .12]]
    : [[0, .70], [.18, .80], [.37, .74], [.55, .84], [.72, .77], [.86, .81], [1, .71]];
  bands.forEach(([o, v]) => sheen.addColorStop(o, `rgb(${v * 255},${v * 255},${v * 255 + (black ? 3 : 2)})`));
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, W, H);
  const vert = ctx.createLinearGradient(0, 0, 0, H);
  vert.addColorStop(0, 'rgba(255,255,255,0.10)');
  vert.addColorStop(0.35, 'rgba(255,255,255,0)');
  vert.addColorStop(0.7, 'rgba(0,0,0,0.05)');
  vert.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = vert;
  ctx.fillRect(0, 0, W, H);

  // 2. Hairline grain: noise smeared along x into long streaks.
  const img = ctx.getImageData(0, 0, W, H);
  const px = img.data;
  for (let y = 0; y < H; y++) {
    const smear = rng.range(0.006, 0.025);
    const rowShift = rng.range(-2, 2);
    let streak = 0;
    let i = y * W * 4;
    for (let x = 0; x < W; x++, i += 4) {
      streak += (rng.range(-30, 30) - streak) * smear;
      const d = (streak * 2.2 + rowShift + rng.range(-3.5, 3.5)) * (black ? 0.42 : 1);
      px[i] += d; px[i + 1] += d; px[i + 2] += d;
    }
  }
  ctx.putImageData(img, 0, 0);

  const blob = (x, y, r, rgb, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  // 3. Grime and polish, heavier at the edges and bottom.
  for (let k = 0; k < 48; k++) {
    const nearEdge = rng.chance(0.6);
    const x = nearEdge ? (rng.chance(0.5) ? rng.range(0, W * 0.12) : rng.range(W * 0.88, W)) : rng.range(0, W);
    const y = rng.chance(0.55) ? rng.range(H * 0.75, H) : rng.range(0, H);
    const dark = rng.chance(0.7);
    if (black) blob(x, y, rng.range(40, 200) * s, dark ? '0,0,0' : '190,190,200', dark ? rng.range(0.10, 0.22) : rng.range(0.02, 0.05));
    else blob(x, y, rng.range(40, 200) * s, dark ? '38,38,40' : '255,255,255', dark ? rng.range(0.03, 0.08) : rng.range(0.03, 0.07));
  }
  // Smudges where hands reach for the knobs and switches.
  for (let k = 0; k < 7; k++) {
    // On black, skin oil leaves a lighter haze.
    blob(rng.range(W * 0.5, W * 0.95), rng.range(H * 0.4, H * 0.95), rng.range(18, 36) * s, black ? '170,170,180' : '70,70,70', black ? 0.045 : 0.05);
  }

  ctx.lineCap = 'round';
  // 4. Micro-scratches.
  for (let k = 0; k < 520; k++) {
    const x = rng() * W, y = rng() * H, a = rng.range(0, Math.PI * 2), len = rng.range(2, 14) * s;
    const light = rng.chance(black ? 0.85 : 0.55);
    ctx.strokeStyle = light ? `rgba(255,255,255,${rng.range(0.12, 0.3) * (black ? 0.55 : 1)})` : `rgba(0,0,0,${rng.range(0.06, 0.16) * (black ? 2 : 1)})`;
    ctx.lineWidth = rng.range(0.3, 0.7) * s;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len); ctx.stroke();
  }

  // 5. Scratches: dark groove with a bright lip offset toward the light.
  const scratch = (x, y, a, len, bend, depth) => {
    const ex = x + Math.cos(a) * len, ey = y + Math.sin(a) * len;
    const mx = (x + ex) / 2 - Math.sin(a) * bend, my = (y + ey) / 2 + Math.cos(a) * bend;
    const w = Math.max(0.45, depth * 3.2) * s;
    const path = (dx, dy) => { ctx.beginPath(); ctx.moveTo(x + dx, y + dy); ctx.quadraticCurveTo(mx + dx, my + dy, ex + dx, ey + dy); };
    if (black) {
      // Cut through the anodizing: bright bare metal with a dark shadow edge.
      ctx.strokeStyle = `rgba(0,0,0,${Math.min(0.6, depth * 1.8)})`; ctx.lineWidth = w; path(0.8 * s, 0.8 * s); ctx.stroke();
      ctx.strokeStyle = `rgba(196,198,204,${Math.min(0.7, depth * 1.7)})`; ctx.lineWidth = w * 0.75; path(0, 0); ctx.stroke();
    } else {
      ctx.strokeStyle = `rgba(31,31,33,${depth})`; ctx.lineWidth = w; path(0, 0); ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${Math.min(0.75, depth * 2.4)})`; ctx.lineWidth = w * 0.7; path(-0.8 * s, -0.8 * s); ctx.stroke();
    }
  };
  for (let k = 0; k < 64; k++) {
    const base = rng.chance(0.7) ? rng.range(-0.6, 0.6) : rng.range(0.8, 2.3);
    const a = rng.chance(0.5) ? base : base + Math.PI;
    scratch(rng() * W, rng() * H, a, rng.range(18, 260) * s, rng.range(-14, 14) * s, rng.range(0.1, 0.3));
  }
  // Keyed clusters: parallel scratches from one drag.
  for (let k = 0; k < 4; k++) {
    const ox = rng() * W, oy = rng() * H;
    const a = rng.range(-0.5, 0.5) + (rng.chance(0.5) ? 0 : Math.PI);
    const len = rng.range(60, 220) * s, count = Math.floor(rng.range(3, 6));
    for (let c = 0; c < count; c++) {
      const off = c * rng.range(1.5, 3.5) * s;
      scratch(ox - Math.sin(a) * off, oy + Math.cos(a) * off, a, len * rng.range(0.6, 1), rng.range(-6, 6) * s, rng.range(0.1, 0.22));
    }
  }

  // 6. Dings: a dark dent with a lit rim on the far side.
  for (let k = 0; k < 14; k++) {
    const x = rng() * W, y = rng() * H, r = rng.range(1.5, 4.5) * s;
    blob(x, y, r * 1.8, black ? '150,150,155' : '0,0,0', black ? 0.22 : 0.28); // dings chip the anodizing
    ctx.strokeStyle = black ? 'rgba(220,220,225,0.55)' : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 0.6 * s;
    ctx.beginPath();
    ctx.arc(x + r * 0.25, y + r * 0.25, r, Math.PI * 0.05, Math.PI * 0.85);
    ctx.stroke();
  }
}

window.PressTexture = { drawFaceplate, seededRandom };
})();
