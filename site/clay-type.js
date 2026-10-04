'use strict';
/** Hand-moulded clay lettering. Coordinates are compiled from the generated atlas.
 * Accessible names stay as real text; the decorative glyphs have no duplicate names.
 * Source prompts and measurements: review/design-direction/clay-alphabet-type.md.
 */
(function () {
  const metrics = {"width":1536,"height":1024,"capHeight":170,"glyphs":{"A":[57,31,183,171],"B":[326,31,156,175],"C":[564,31,155,175],"D":[810,31,164,173],"E":[1063,31,154,174],"F":[1323,31,145,176],"G":[57,230,174,176],"H":[316,232,168,171],"I":[603,232,84,172],"J":[811,233,154,171],"K":[1054,233,168,170],"L":[1325,233,150,172],"M":[47,431,208,165],"N":[314,430,178,166],"O":[558,428,179,173],"P":[811,427,161,174],"Q":[1042,427,192,175],"R":[1315,427,163,174],"S":[75,627,148,172],"T":[308,624,184,176],"U":[558,630,175,170],"V":[798,630,186,167],"W":[1028,635,226,159],"X":[1309,633,169,163],"Y":[64,823,169,167],"Z":[318,819,169,172],"?":[578,812,140,179],"+":[803,828,168,158],"&":[1050,817,186,176],".":[1358,911,72,69]}};
  const horizontalScale = .78;
  const emX = (value) => (value / metrics.capHeight * horizontalScale).toFixed(5) + 'em';
  const emY = (value) => (value / metrics.capHeight).toFixed(5) + 'em';
  const source = './assets/ott/clay-alphabet.webp';
  const atlas = new Image();
  const ready = new Promise((resolve) => {
    atlas.onload = () => { document.documentElement.classList.add('ott-clay-ready'); resolve(true); };
    // Plain text remains visible if the artwork cannot load.
    atlas.onerror = () => resolve(false);
    atlas.src = source;
  });
  function label(h, value, attrs = {}) {
    const text = String(value);
    const words = text.toUpperCase().trim().split(/\s+/);
    if (!text.trim() || words.some((word) => Array.from(word).some((letter) => !metrics.glyphs[letter]))) return h('span', attrs, text);
    const letters = (word) => Array.from(word).map((letter) => {
      const [x, y, width, height] = metrics.glyphs[letter];
      const glyph = h('span', { class: 'ott-clay-glyph' });
      // CSSOM properties preserve the production CSP without permitting inline style strings.
      glyph.style.width = emX(width);
      glyph.style.height = emY(height);
      glyph.style.backgroundSize = emX(metrics.width) + ' ' + emY(metrics.height);
      glyph.style.backgroundPosition = '-' + emX(x) + ' -' + emY(y);
      return glyph;
    });
    return h('span', { ...attrs, class: ((attrs.class || '') + ' ott-clay-type').trim() },
      h('span', { class: 'ott-clay-readable' }, text),
      h('span', { class: 'ott-clay-label', 'aria-hidden': 'true' }, words.map((word) => h('span', { class: 'ott-clay-word' }, letters(word)))));
  }
  window.WhateverClayType = { label, ready };
})();
