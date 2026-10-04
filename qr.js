'use strict';
/**
 * whatever.fun — a QR encoder, for the one thing on the site that has to be scanned.
 *
 * An eSIM is installed by scanning its activation code ("LPA:1$<SM-DP+ address>$<matching id>").
 * wholesale answers a completed order with that code and, usually, a QR image; when the image is
 * missing, or is the code itself rather than a picture of it, the page draws the QR here. Byte
 * mode, error-correction level M, versions 1–10 (up to 213 bytes, which is four times the longest
 * activation code anyone issues), mask chosen by the standard penalty score. The arithmetic is
 * ISO/IEC 18004's, written in the order Nayuki's reference explains it, checked against a decoder.
 *
 * One global, window.WhateverQr: matrix(text) -> rows of booleans; svg(text) -> an SVG data URI
 * an <img> can show, quiet zone included.
 */
(function () {
  // ------------------------------------------------------------------ GF(256) and Reed–Solomon
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsDivisor(degree) {
    const coefs = new Array(degree).fill(0);
    coefs[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < coefs.length; j++) {
        coefs[j] = mul(coefs[j], root);
        if (j + 1 < coefs.length) coefs[j] ^= coefs[j + 1];
      }
      root = mul(root, 2);
    }
    return coefs;
  }
  function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((c, i) => { result[i] ^= mul(c, factor); });
    }
    return result;
  }

  // ------------------------------------------------------------------ the tables, level M
  // [ec codewords per block, [[blocks, data codewords per block], ...]] — short blocks first.
  const TABLE = {
    1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]],
    6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]],
  };
  const ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
  const dataCodewords = (v) => TABLE[v][1].reduce((n, [count, len]) => n + count * len, 0);
  const capacityBytes = (v) => Math.floor((dataCodewords(v) * 8 - 4 - (v < 10 ? 8 : 16)) / 8);

  // ------------------------------------------------------------------ bits and codewords
  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, 'utf8'));
  }

  function codewords(bytes, v) {
    const bits = [];
    const put = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(4, 4);                              // byte mode
    put(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    const total = dataCodewords(v) * 8;
    put(0, Math.min(4, total - bits.length));   // terminator
    while (bits.length % 8) bits.push(0);
    for (let pad = 0xec; bits.length < total; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // Split into blocks, append each block's Reed–Solomon remainder, then interleave.
    const [ecLen, shape] = TABLE[v];
    const divisor = rsDivisor(ecLen);
    const blocks = [];
    let at = 0;
    for (const [count, len] of shape) for (let i = 0; i < count; i++) { blocks.push(data.slice(at, at + len)); at += len; }
    const ecs = blocks.map((b) => rsRemainder(b, divisor));
    const out = [];
    const longest = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < longest; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
    return out;
  }

  // ------------------------------------------------------------------ the matrix
  function build(text) {
    const bytes = utf8(text);
    let v = 1;
    while (v <= 10 && capacityBytes(v) < bytes.length) v++;
    if (v > 10) throw new Error('text too long for a QR this file will draw (' + bytes.length + ' bytes, max ' + capacityBytes(10) + ')');
    const size = 17 + 4 * v;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => { if (x >= 0 && y >= 0 && x < size && y < size) { m[y][x] = dark; fn[y][x] = true; } };

    // Function patterns: timing, finders with separators, alignment, then the format and version
    // areas (drawn with placeholder bits so they are reserved before data is laid down).
    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); } };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = ALIGN[v] || [];
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    drawFormat(0);
    if (v >= 7) {
      let rem = v;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (v << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        set(a, b, bit); set(b, a, bit);
      }
    }

    function drawFormat(mask) {
      const data = (0 << 3) | mask;   // level M is 00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      const bit = (i) => ((bits >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    }

    // Data, zigzagging up and down two columns at a time from the right, skipping column 6.
    const cw = codewords(bytes, v);
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && i < cw.length * 8) { m[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; }
        }
      }
    }

    // The mask with the lowest penalty. Applying a mask twice undoes it.
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const apply = (k) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] = !m[y][x]; };
    let best = 0, bestScore = Infinity;
    for (let k = 0; k < 8; k++) {
      apply(k); drawFormat(k);
      const s = penalty(m, size);
      if (s < bestScore) { bestScore = s; best = k; }
      apply(k);
    }
    apply(best); drawFormat(best);
    return m;
  }

  function penalty(m, size) {
    let score = 0;
    const runs = (get) => {
      for (let a = 0; a < size; a++) {
        let run = 0, prev = null;
        const hist = [];  // run lengths, for the finder-like check
        for (let b = 0; b < size; b++) {
          const c = get(a, b);
          if (c === prev) run++; else { if (prev !== null) hist.push(run); run = 1; prev = c; }
          if (run === 5) score += 3; else if (run > 5) score += 1;
        }
        hist.push(run);
        // 1:1:3:1:1 dark-light with 4 light on a side, anywhere along the line.
        let dark = get(a, 0);
        let pos = 0;
        for (let k = 0; k < hist.length; k++, dark = !dark) {
          if (dark && k + 4 < hist.length) {
            const [n1, n2, n3, n4, n5] = hist.slice(k, k + 5);
            if (n1 === n2 && n3 === 3 * n1 && n4 === n1 && n5 === n1) {
              const before = k > 0 ? hist[k - 1] : 0, after = k + 5 < hist.length ? hist[k + 5] : 0;
              if (before >= 4 * n1 || after >= 4 * n1 || pos === 0 || pos + n1 * 7 === size) score += 40;
            }
          }
          pos += hist[k];
        }
      }
    };
    runs((y, x) => m[y][x]);
    runs((x, y) => m[y][x]);
    for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
      const c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
    }
    let dark = 0;
    for (const row of m) for (const c of row) if (c) dark++;
    const k = Math.ceil(Math.abs(dark * 20 - size * size * 10) / (size * size)) - 1;
    return score + Math.max(0, k) * 10;
  }

  // ------------------------------------------------------------------ out
  function svg(text, { quiet = 4 } = {}) {
    const m = build(text);
    const n = m.length + quiet * 2;
    let d = '';
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m.length; x++) if (m[y][x]) d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h1v1h-1z';
    const s = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges">' +
      '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(s);
  }

  const api = { matrix: build, svg, capacityBytes };
  if (typeof window !== 'undefined') window.WhateverQr = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
