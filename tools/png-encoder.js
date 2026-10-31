// PNG decode / lossless encode / palette reduction, using only Node's built-in zlib.
'use strict';
const zlib = require('zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Images larger than this are refused before any pixel memory is allocated
// (a tiny file can claim enormous dimensions).
const MAX_PIXELS = 150_000_000;

class TooLargeError extends Error {}

function checkDimensions(width, height) {
  if (!width || !height) throw new Error('Bad PNG dimensions');
  if (width * height > MAX_PIXELS) throw new TooLargeError('Image too large to process safely');
}

// ---------------------------------------------------------------- CRC

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- Decode

function readChunks(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG');
  const chunks = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length) throw new Error('Truncated PNG');
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === 'IEND') break;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decodes to non-premultiplied RGBA8. Returns { width, height, rgba, info, chunks }.
 * Throws for 16-bit (callers check `info.bitDepth` via peek() first).
 */
function decode(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find(c => c.type === 'IHDR');
  if (!ihdr) throw new Error('Missing IHDR');
  const width = ihdr.data.readUInt32BE(0), height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8], colorType = ihdr.data[9], interlace = ihdr.data[12];
  checkDimensions(width, height);
  if (bitDepth > 8) throw new Error('16-bit PNG');
  if (!(colorType in CHANNELS)) throw new Error('Unsupported PNG color type');

  const plte = chunks.find(c => c.type === 'PLTE');
  const trns = chunks.find(c => c.type === 'tRNS');
  const idat = Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));

  const ch = CHANNELS[colorType];
  const bitsPP = ch * bitDepth;
  // The exact size the pixel data must inflate to; anything bigger is refused
  // by zlib itself (guards against decompression bombs).
  const passList = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  let expected = 0;
  for (const [x0, y0, dx, dy] of passList) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw > 0 && ph > 0) expected += ph * (1 + Math.ceil((pw * bitsPP) / 8));
  }
  const raw = zlib.inflateSync(idat, { maxOutputLength: Math.max(expected, 1) });
  if (raw.length < expected) throw new Error('Truncated PNG data');
  const bpp = Math.max(1, bitsPP >> 3);
  const rgba = new Uint8Array(width * height * 4);

  // tRNS for gray / RGB: a single transparent color (8-bit samples here).
  let transparentGray = -1, transparentRGB = null;
  if (trns && colorType === 0) transparentGray = trns.data.readUInt16BE(0);
  if (trns && colorType === 2) transparentRGB = [trns.data.readUInt16BE(0), trns.data.readUInt16BE(2), trns.data.readUInt16BE(4)];
  const scaleGray = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1;

  let offset = 0;
  const passes = passList;

  for (const [x0, y0, dx, dy] of passes) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil((pw * bitsPP) / 8);
    let prev = new Uint8Array(rowBytes);
    for (let r = 0; r < ph; r++) {
      const ft = raw[offset];
      const cur = Uint8Array.from(raw.subarray(offset + 1, offset + 1 + rowBytes));
      offset += 1 + rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        switch (ft) {
          case 0: break;
          case 1: cur[i] = (cur[i] + a) & 255; break;
          case 2: cur[i] = (cur[i] + b) & 255; break;
          case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 255; break;
          case 4: cur[i] = (cur[i] + paeth(a, b, c)) & 255; break;
          default: throw new Error('Bad PNG filter');
        }
      }
      const y = y0 + r * dy;
      for (let k = 0; k < pw; k++) {
        const x = x0 + k * dx;
        const o = (y * width + x) * 4;
        let sample0;
        if (bitDepth < 8) {
          const bit = k * bitDepth;
          sample0 = (cur[bit >> 3] >> (8 - bitDepth - (bit & 7))) & ((1 << bitDepth) - 1);
        }
        switch (colorType) {
          case 0: {
            const v = bitDepth < 8 ? sample0 : cur[k];
            const g = Math.round(v * scaleGray);
            rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
            rgba[o + 3] = v === transparentGray ? 0 : 255;
            break;
          }
          case 2: {
            const p = k * 3;
            rgba[o] = cur[p]; rgba[o + 1] = cur[p + 1]; rgba[o + 2] = cur[p + 2];
            rgba[o + 3] = transparentRGB && cur[p] === transparentRGB[0] && cur[p + 1] === transparentRGB[1] && cur[p + 2] === transparentRGB[2] ? 0 : 255;
            break;
          }
          case 3: {
            const idx = bitDepth < 8 ? sample0 : cur[k];
            if (!plte || idx * 3 + 2 >= plte.data.length) throw new Error('Bad palette index');
            rgba[o] = plte.data[idx * 3]; rgba[o + 1] = plte.data[idx * 3 + 1]; rgba[o + 2] = plte.data[idx * 3 + 2];
            rgba[o + 3] = trns && idx < trns.data.length ? trns.data[idx] : 255;
            break;
          }
          case 4: {
            const p = k * 2;
            rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[p]; rgba[o + 3] = cur[p + 1];
            break;
          }
          case 6: {
            const p = k * 4;
            rgba[o] = cur[p]; rgba[o + 1] = cur[p + 1]; rgba[o + 2] = cur[p + 2]; rgba[o + 3] = cur[p + 3];
            break;
          }
        }
      }
      prev = cur;
    }
  }
  return { width, height, rgba, info: { bitDepth, colorType, interlace }, chunks };
}

/** Cheap header check without decoding pixels. */
function peek(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find(c => c.type === 'IHDR');
  if (!ihdr || ihdr.data.length < 13) throw new Error('Missing IHDR');
  checkDimensions(ihdr.data.readUInt32BE(0), ihdr.data.readUInt32BE(4));
  return {
    width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4),
    bitDepth: ihdr.data[8], colorType: ihdr.data[9],
    animated: chunks.some(c => c.type === 'acTL'),
    chunks,
  };
}

// ---------------------------------------------------------------- Encode

function analyze(rgba) {
  let opaque = true, gray = true, tooMany = false;
  const seen = new Map();
  const order = [];
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
  let last = -1;
  for (let i = 0; i < u32.length; i++) {
    const p = i * 4;
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
    if (a !== 255) opaque = false;
    if (r !== g || g !== b) gray = false;
    if (!tooMany) {
      const key = u32[i];
      if (key !== last) {
        if (!seen.has(key)) {
          if (order.length === 256) tooMany = true;
          else { seen.set(key, order.length); order.push(key); }
        }
        last = key;
      }
    }
  }
  return { opaque, gray, palette: tooMany ? null : order };
}

// Keys are read as little-endian uint32: byte order in memory is R,G,B,A.
const keyR = k => k & 255, keyG = k => (k >>> 8) & 255, keyB = k => (k >>> 16) & 255, keyA = k => (k >>> 24) & 255;

function paletteLayout(rgba, width, height, unsorted) {
  const palette = unsorted.filter(k => keyA(k) !== 255).concat(unsorted.filter(k => keyA(k) === 255));
  const index = new Map(palette.map((k, i) => [k, i]));
  const n = palette.length;
  const depth = n <= 2 ? 1 : n <= 4 ? 2 : n <= 16 ? 4 : 8;
  const perByte = 8 / depth;
  const rowBytes = Math.ceil(width / perByte);
  const rows = new Uint8Array(rowBytes * height);
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
  let lastKey = -1, lastIdx = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const key = u32[y * width + x];
      if (key !== lastKey) { lastIdx = index.get(key); lastKey = key; }
      if (depth === 8) rows[y * rowBytes + x] = lastIdx;
      else rows[y * rowBytes + ((x / perByte) | 0)] |= lastIdx << (8 - depth * ((x % perByte) + 1));
    }
  }
  const plte = new Uint8Array(n * 3);
  const trns = [];
  palette.forEach((k, i) => {
    plte[i * 3] = keyR(k); plte[i * 3 + 1] = keyG(k); plte[i * 3 + 2] = keyB(k);
    if (keyA(k) !== 255) trns.push(keyA(k));
  });
  return { colorType: 3, bitDepth: depth, rowBytes, bpp: 1, rows, plte, trns: Uint8Array.from(trns), palette: true };
}

function grayLayout(rgba, width, height, opaque) {
  const ch = opaque ? 1 : 2;
  const rows = new Uint8Array(width * height * ch);
  for (let i = 0; i < width * height; i++) {
    rows[i * ch] = rgba[i * 4];
    if (!opaque) rows[i * ch + 1] = rgba[i * 4 + 3];
  }
  return { colorType: opaque ? 0 : 4, bitDepth: 8, rowBytes: width * ch, bpp: ch, rows };
}

function truecolorLayout(rgba, width, height, opaque) {
  if (!opaque) return { colorType: 6, bitDepth: 8, rowBytes: width * 4, bpp: 4, rows: rgba };
  const rows = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    rows[i * 3] = rgba[i * 4]; rows[i * 3 + 1] = rgba[i * 4 + 1]; rows[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return { colorType: 2, bitDepth: 8, rowBytes: width * 3, bpp: 3, rows };
}

function filterRows(layout, height, adaptive) {
  const rb = layout.rowBytes, bpp = layout.bpp, src = layout.rows;
  const out = new Uint8Array((rb + 1) * height);
  if (!adaptive) {
    for (let y = 0; y < height; y++) out.set(src.subarray(y * rb, (y + 1) * rb), y * (rb + 1) + 1);
    return out;
  }
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(rb));
  for (let y = 0; y < height; y++) {
    const cur = y * rb, prev = (y - 1) * rb;
    let best = 0, bestCost = Infinity;
    for (let f = 0; f < 5; f++) {
      const c = cand[f];
      let cost = 0;
      for (let x = 0; x < rb; x++) {
        const raw = src[cur + x];
        const left = x >= bpp ? src[cur + x - bpp] : 0;
        const up = y > 0 ? src[prev + x] : 0;
        const ul = y > 0 && x >= bpp ? src[prev + x - bpp] : 0;
        const pred = f === 0 ? 0 : f === 1 ? left : f === 2 ? up : f === 3 ? (left + up) >> 1 : paeth(left, up, ul);
        const v = (raw - pred) & 255;
        c[x] = v;
        cost += v < 128 ? v : 256 - v;
        if (cost >= bestCost) break;
      }
      if (cost < bestCost) { bestCost = cost; best = f; }
    }
    // Recompute the winner (the early-exit may have left its buffer partial).
    const c = cand[best];
    for (let x = 0; x < rb; x++) {
      const raw = src[cur + x];
      const left = x >= bpp ? src[cur + x - bpp] : 0;
      const up = y > 0 ? src[prev + x] : 0;
      const ul = y > 0 && x >= bpp ? src[prev + x - bpp] : 0;
      const pred = best === 0 ? 0 : best === 1 ? left : best === 2 ? up : best === 3 ? (left + up) >> 1 : paeth(left, up, ul);
      c[x] = (raw - pred) & 255;
    }
    const o = y * (rb + 1);
    out[o] = best;
    out.set(c, o + 1);
  }
  return out;
}

function bestIDAT(layout, height) {
  const streams = [filterRows(layout, height, false), filterRows(layout, height, true)];
  let best = null;
  streams.forEach((s, n) => {
    const strategies = layout.palette && n === 0
      ? [zlib.constants.Z_DEFAULT_STRATEGY]
      : [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED];
    for (const strategy of strategies) {
      const z = zlib.deflateSync(s, { level: 9, memLevel: 9, windowBits: 15, strategy });
      if (!best || z.length < best.length) best = z;
    }
  });
  return best;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const body = Buffer.concat([head.subarray(4), Buffer.from(data)]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, tail]);
}

/**
 * Lossless encode. `extra` = ancillary chunks to carry over, as { type, data }
 * (placed before PLTE/IDAT as the spec requires). `allowGray` must be false
 * when an RGB ICC profile is carried.
 */
function encode(rgba, width, height, { extra = [], allowGray = true } = {}) {
  const a = analyze(rgba);
  const layouts = [];
  if (a.palette) layouts.push(paletteLayout(rgba, width, height, a.palette));
  if (a.gray && allowGray) layouts.push(grayLayout(rgba, width, height, a.opaque));
  if (!a.palette && !(a.gray && allowGray)) layouts.push(truecolorLayout(rgba, width, height, a.opaque));

  let best = null;
  for (const L of layouts) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = L.bitDepth; ihdr[9] = L.colorType;
    const parts = [SIGNATURE, chunk('IHDR', ihdr)];
    for (const c of extra) parts.push(chunk(c.type, c.data));
    if (L.plte) parts.push(chunk('PLTE', L.plte));
    if (L.trns && L.trns.length) parts.push(chunk('tRNS', L.trns));
    parts.push(chunk('IDAT', bestIDAT(L, height)));
    parts.push(chunk('IEND', new Uint8Array(0)));
    const file = Buffer.concat(parts);
    if (!best || file.length < best.length) best = file;
  }
  return best;
}

// ---------------------------------------------------------------- Quantize

/**
 * ≤256-color palette: weighted median cut seeded from a histogram, refined with
 * k-means, no dithering. Returns null when the image already has ≤256 colors
 * or is too photographic to bother.
 */
function quantize(rgba, colors = 256) {
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length >> 2);
  const hist = new Map();
  let last = -1, run = 0;
  for (let i = 0; i < u32.length; i++) {
    const k = u32[i];
    if (run && k === last) { run++; continue; }
    if (run) hist.set(last, (hist.get(last) || 0) + run);
    last = k; run = 1;
  }
  if (run) hist.set(last, (hist.get(last) || 0) + run);
  if (hist.size <= colors || hist.size > 1_000_000) return null;

  // Bins (coarsen until manageable).
  let bins = toBins(hist, 0);
  for (let shift = 1; bins.n > 65536 && shift <= 4; shift++) bins = toBins(hist, shift);

  let palette = medianCut(bins, colors);
  for (let it = 0; it < 4; it++) palette = kmeansStep(bins, palette);
  palette = palette.map(c => c.map(v => Math.min(255, Math.max(0, Math.round(v)))));

  const mapping = new Map();
  const used = new Set();
  for (const k of hist.keys()) {
    const c = palette[nearest([keyR(k), keyG(k), keyB(k), keyA(k)], palette)];
    const mapped = (c[0] | (c[1] << 8) | (c[2] << 16) | (c[3] << 24)) >>> 0;
    mapping.set(k, mapped);
    used.add(mapped);
  }
  const out = new Uint8Array(rgba.length);
  const o32 = new Uint32Array(out.buffer);
  let lk = -1, lm = 0;
  for (let i = 0; i < u32.length; i++) {
    const k = u32[i];
    if (k !== lk) { lm = mapping.get(k); lk = k; }
    o32[i] = lm;
  }
  return { rgba: out, colorCount: used.size };
}

function toBins(hist, shift) {
  const cols = [], ws = [];
  if (shift === 0) {
    for (const [k, n] of hist) { cols.push([keyR(k), keyG(k), keyB(k), keyA(k)]); ws.push(n); }
  } else {
    const m = (0xff >> shift) << shift;
    const mask = (m | (m << 8) | (m << 16) | (m << 24)) >>> 0;
    const sums = new Map();
    for (const [k, n] of hist) {
      const g = (k & mask) >>> 0;
      let e = sums.get(g);
      if (!e) { e = [0, 0, 0, 0, 0]; sums.set(g, e); }
      e[0] += keyR(k) * n; e[1] += keyG(k) * n; e[2] += keyB(k) * n; e[3] += keyA(k) * n; e[4] += n;
    }
    for (const e of sums.values()) { cols.push([e[0] / e[4], e[1] / e[4], e[2] / e[4], e[3] / e[4]]); ws.push(e[4]); }
  }
  return { cols, ws, n: cols.length };
}

function boxStats(bins, members) {
  let total = 0;
  const mean = [0, 0, 0, 0];
  for (const i of members) { const c = bins.cols[i], w = bins.ws[i]; total += w; for (let d = 0; d < 4; d++) mean[d] += c[d] * w; }
  for (let d = 0; d < 4; d++) mean[d] /= total || 1;
  const sse = [0, 0, 0, 0];
  for (const i of members) { const c = bins.cols[i], w = bins.ws[i]; for (let d = 0; d < 4; d++) { const e = c[d] - mean[d]; sse[d] += e * e * w; } }
  return { members, mean, sse, total };
}

function medianCut(bins, colors) {
  const boxes = [boxStats(bins, Array.from({ length: bins.n }, (_, i) => i))];
  while (boxes.length < colors) {
    let pick = -1, worst = 0;
    boxes.forEach((b, i) => {
      if (b.members.length < 2) return;
      const s = b.sse[0] + b.sse[1] + b.sse[2] + b.sse[3];
      if (s > worst) { worst = s; pick = i; }
    });
    if (pick < 0) break;
    const box = boxes[pick];
    const ch = box.sse.indexOf(Math.max(...box.sse));
    const sorted = box.members.slice().sort((a, b) => bins.cols[a][ch] - bins.cols[b][ch]);
    const half = box.total / 2;
    let acc = 0, cut = 1;
    for (let n = 0; n < sorted.length; n++) { acc += bins.ws[sorted[n]]; if (acc >= half) { cut = n + 1; break; } }
    cut = Math.min(Math.max(cut, 1), sorted.length - 1);
    boxes[pick] = boxStats(bins, sorted.slice(0, cut));
    boxes.push(boxStats(bins, sorted.slice(cut)));
  }
  return boxes.map(b => b.mean);
}

function nearest(c, palette) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const p = palette[i];
    const d0 = c[0] - p[0], d1 = c[1] - p[1], d2 = c[2] - p[2], d3 = c[3] - p[3];
    const d = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function kmeansStep(bins, palette) {
  const sums = palette.map(() => [0, 0, 0, 0]), tot = palette.map(() => 0);
  for (let i = 0; i < bins.n; i++) {
    const c = bins.cols[i], w = bins.ws[i], j = nearest(c, palette);
    for (let d = 0; d < 4; d++) sums[j][d] += c[d] * w;
    tot[j] += w;
  }
  return palette.map((p, j) => (tot[j] ? sums[j].map(v => v / tot[j]) : p));
}

module.exports = { decode, peek, encode, quantize, crc32, MAX_PIXELS, TooLargeError };
