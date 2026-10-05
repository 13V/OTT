#!/usr/bin/env node
'use strict';
/** npm ci && npm run build:wallet recreates the committed, self-hosted SDK. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'site', 'vendor');

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const result = await esbuild.build({
    absWorkingDir: root,
    entryPoints: ['scripts/wallet-sdk-entry.mjs'],
    outfile: 'site/vendor/walletconnect.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['safari15.4', 'chrome100', 'firefox100'],
    minify: true,
    legalComments: 'external',
    metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: '/*! OTT wallet connector. Portions © 2025 Reown, Inc. All Rights Reserved. See walletconnect-NOTICES.txt and walletconnect.js.LEGAL.txt. */' },
    logLevel: 'warning',
  });
  const packages = new Map();
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.includes('node_modules/')) continue;
    let dir = path.dirname(path.resolve(root, input));
    while (dir.startsWith(root) && dir !== root) {
      const filename = path.join(dir, 'package.json');
      if (fs.existsSync(filename)) {
        const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'));
        if (pkg.name && pkg.version) { packages.set(pkg.name + '@' + pkg.version, { dir, pkg }); break; }
      }
      dir = path.dirname(dir);
    }
  }
  const notices = [
    'OTT wallet connector — bundled third-party notices',
    'Portions © 2025 Reown, Inc. All Rights Reserved.',
    'Source entry: scripts/wallet-sdk-entry.mjs. Rebuild with npm ci && npm run build:wallet.',
    'The SDK dependencies below retain their own licenses; they are not covered by OTT’s MIT license.',
    '',
  ];
  for (const [name, item] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    notices.push('='.repeat(72), name + ' — ' + String(item.pkg.license || 'see package distribution'), '');
    const licenses = fs.readdirSync(item.dir).filter((filename) => /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(filename));
    for (const filename of licenses) {
      const file = path.join(item.dir, filename);
      if (fs.statSync(file).isFile()) notices.push(fs.readFileSync(file, 'utf8'), '');
    }
    if (!licenses.length) notices.push('License text: https://www.npmjs.com/package/' + item.pkg.name + '/v/' + item.pkg.version, '');
  }
  fs.writeFileSync(path.join(output, 'walletconnect-NOTICES.txt'), notices.join('\n'));
  const buffer = fs.readFileSync(path.join(output, 'walletconnect.js'));
  console.log('Wallet SDK: ' + buffer.length + ' bytes (' + zlib.gzipSync(buffer).length + ' bytes gzip), ' + packages.size + ' dependency notices.');
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
