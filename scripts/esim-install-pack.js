#!/usr/bin/env node
'use strict';
// Build an offline installation page from an already-issued operator test. Never fetches a URL.
const fs = require('fs');
const path = require('path');
const { privatePath, writePrivate } = require('./operator-test-files');
const qr = require('../site/qr');
const escape = value => String(value || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function activation(order) {
  if (!order || order.purpose !== 'ott-operator-phone-test' || order.step !== 'done' || order.pending !== false ||
      order.topupOf || !/^\d{18,22}$/.test(String(order.iccid || ''))) throw new Error('Use a completed, newly issued operator-test eSIM.');
  const code = String(order.ac || order.manualCode || '');
  const fields = code.split('$');
  if (fields[0] !== 'LPA:1' || fields.length < 3 || fields.length > 4 ||
      !/^[a-z0-9.-]+$/i.test(fields[1]) || !fields[1].includes('.') ||
      !fields[2] || /[\s<>"'\\]/.test(fields[2]) || Buffer.byteLength(code, 'utf8') > qr.capacityBytes(10)) {
    throw new Error('The completed order does not contain a valid supported LPA activation code.');
  }
  if ((order.smdpAddress && order.smdpAddress !== fields[1]) ||
      (order.matchingId && order.matchingId !== fields[2])) throw new Error('Provider manual details disagree with the activation code.');
  return { code, smdp: fields[1], matchingId: fields[2] };
}
function render(order) {
  const a = activation(order);
  const pkg = order.package || {};
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>OTT private phone test</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3eee3;color:#172d2f;font:17px/1.6 system-ui,sans-serif}main{max-width:900px;margin:auto;padding:40px 24px}h1{font-size:42px;line-height:1.1}h2{font-size:24px}small{color:#576969}.tag{color:#ba3a16;font-weight:700}.grid{display:grid;grid-template-columns:320px 1fr;gap:36px}img{width:100%;height:auto;background:white;padding:14px;border:1px solid #c7c6bb}code{display:block;overflow-wrap:anywhere;background:#fff9ee;padding:12px;margin:5px 0 18px}li{margin-bottom:16px}.note{padding:16px;border:1px solid #c7c6bb;margin:28px 0}@media(max-width:700px){.grid{grid-template-columns:1fr}img{max-width:320px}h1{font-size:34px}}
</style></head><body><main><p class="tag">OT+T / PRIVATE OPERATOR TEST</p><h1>Get this phone online.</h1>
<p>${escape(pkg.name)} · ${escape(pkg.gb)} GB · ${escape(pkg.days)} days</p>
<p class="note">This page contains a real eSIM activation code. Keep it private. This test checks payment, issuance and phone connectivity. It does not validate holder eligibility or weekly credit.</p>
<div class="grid"><div><img alt="Private eSIM activation QR" src="${qr.svg(a.code)}"><small>Scan from your phone's Add eSIM screen. This is an offline QR; no external image service is used.</small></div>
<div><h2>1. Prepare</h2><p>Use an unlocked, eSIM-compatible phone and connect to Wi-Fi. Keep your existing line for calls and texts.</p>
<h2>2. Add the eSIM</h2><p>On iPhone, open Settings → Mobile Service or Cellular → Add eSIM → Use QR Code. On Android, open your SIM settings and choose Add eSIM; wording varies by phone.</p>
<p>For manual entry, use the provider's exact details:</p><small>SM-DP+ address</small><code>${escape(a.smdp)}</code><small>Activation code / matching ID</small><code>${escape(a.matchingId)}</code></div></div>
<h2>3. Test mobile data</h2><ol><li>Select the new line for mobile data. Follow the provider's APN and data-roaming instructions. The package works only inside its coverage area.</li>
<li>Turn Wi-Fi off, open a webpage and confirm it loads through this eSIM. An installed profile alone is not a successful data test.</li>
<li>Record only whether payment, issuance, installation and mobile data worked. Do not copy the activation code or ICCID into public reports.</li></ol>
<details><summary>Full activation code for manual setup</summary><code>${escape(a.code)}</code></details>
<p><small>No automatic installation, tracking, scripts or external requests. The installed package's validity follows the provider's rules.</small></p></main></body></html>`;
}
function build({ orderFile, outDir }) {
  if (!orderFile) throw new Error('Supply --order-file for an already-issued private order.');
  const input = privatePath(orderFile);
  const size = fs.statSync(input).size;
  if (size > 128 * 1024) throw new Error('Order file exceeds the expected size.');
  const order = JSON.parse(fs.readFileSync(input, 'utf8'));
  const html = render(order);
  const directory = privatePath(outDir || path.dirname(input));
  return writePrivate(path.join(directory, 'install.html'), html);
}
function parse(argv) {
  const opts = {};
  const names = { '--order-file': 'orderFile', '--out-dir': 'outDir' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') opts.help = true;
    else if (names[argv[i]] && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[names[argv[i]]] = argv[++i];
    else throw new Error('Unknown or incomplete install-pack option.');
  }
  return opts;
}
if (require.main === module) {
  try {
    const opts = parse(process.argv.slice(2));
    if (opts.help) console.log('node scripts/esim-install-pack.js --order-file <private order.json> [--out-dir <private directory>]');
    else console.log('Private installation page: ' + build(opts));
  } catch {
    console.error('Installation pack was not created. Use a completed private operator order with matching activation details, outside the repository and OneDrive. No activation details were printed.');
    process.exitCode = 1;
  }
}
module.exports = { activation, render, build, parse };
