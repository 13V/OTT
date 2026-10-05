#!/usr/bin/env node
'use strict';

// The status API's ok means it answered. A healthy live service must pass its dependency checks.
const fs = require('node:fs');
const path = require('node:path');
const { statusChecks } = require('./check-launch');

function summary(body, esim, now = Date.now()) {
  return statusChecks(body, esim, now).filter(check => !check.ok).map(check => '- **' + check.label + '**: ' + check.detail).join('\n');
}

module.exports = { summary };
if (require.main === module) {
  let input = '', tooLarge = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    if (input.length + chunk.length > 65536) { tooLarge = true; input = ''; }
    else if (!tooLarge) input += chunk;
  });
  process.stdin.on('end', () => {
    try {
      if (tooLarge) throw new Error();
      const esim = JSON.parse(fs.readFileSync(path.join(__dirname, '../site/config/esim.json'), 'utf8'));
      const result = summary(JSON.parse(input), esim);
      if (result) console.log(result);
    } catch (_) { console.log('The health response or local configuration could not be validated.'); }
  });
  process.stdin.on('error', () => { console.log('The health response could not be read.'); });
}
