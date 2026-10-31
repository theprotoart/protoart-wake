// Draws the menu-bar template icons (black + alpha) as PNGs. Run: node tools/make-icons.js
'use strict';
const fs = require('fs');
const path = require('path');
const png = require('./png-encoder');

const inEnvelope = (x, y, inset) => {
  const l = 4 + inset, r = 14 - inset, rad = 5 - inset;
  if (y >= 6 && y <= 14.2 && x >= l && x <= r) return true;
  return y < 6 && (x - 9) ** 2 + (y - 6) ** 2 <= rad * rad;
};
const inBase = (x, y) => x >= 3 && x <= 15 && y >= 14.6 && y <= 17 && !(y > 16.4 && (x < 3.6 || x > 14.4));
const inFilament = (x, y) => {
  const w = 0.6;
  if (y >= 7 && y <= 12.6 && (Math.abs(x - 7.7) <= w || Math.abs(x - 10.3) <= w)) return true;
  const d = Math.hypot(x - 9, y - 7);
  return y < 7 && Math.abs(d - 1.3) <= w;
};

function draw(scale, awake) {
  const N = 18 * scale, rgba = new Uint8Array(N * N * 4), SS = 4;
  for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
    let hit = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const x = (px + (sx + 0.5) / SS) / scale, y = (py + (sy + 0.5) / SS) / scale + 0.4;
      let on;
      if (awake) on = (inEnvelope(x, y, 0) && !inFilament(x, y)) || inBase(x, y);
      else on = (inEnvelope(x, y, 0) && !inEnvelope(x, y, 1.35)) || inBase(x, y) || inFilament(x, y);
      if (on) hit++;
    }
    rgba[(py * N + px) * 4 + 3] = Math.round((255 * hit) / (SS * SS));
  }
  return png.encode(rgba, N, N);
}

const out = path.join(__dirname, '..', 'app', 'assets');
for (const [name, awake] of [['trayTemplate', false], ['trayAwakeTemplate', true]]) {
  fs.writeFileSync(path.join(out, `${name}.png`), draw(1, awake));
  fs.writeFileSync(path.join(out, `${name}@2x.png`), draw(2, awake));
}
console.log('icons written to', out);
