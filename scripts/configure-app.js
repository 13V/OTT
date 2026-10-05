#!/usr/bin/env node
'use strict';
/** Save explicitly supplied public connection settings; never accept provider secrets. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CONFIG_FILE = path.join(__dirname, '..', 'site', 'config', 'app.json');
const USAGE = 'Usage: node scripts/configure-app.js [--project-id <32 hexadecimal characters>] [--api-origin <HTTPS origin>]';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const input = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--project-id' && flag !== '--api-origin') throw new Error('Unknown option. Only --project-id and --api-origin are accepted.');
    const key = flag === '--project-id' ? 'projectId' : 'apiOrigin';
    if (Object.hasOwn(input, key)) throw new Error('Each public setting can be supplied only once.');
    const value = args[++index];
    if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('Each option requires an explicit value.');
    input[key] = value;
  }
  if (!Object.keys(input).length) throw new Error('Supply --project-id or --api-origin with its public value.');
  if (Object.hasOwn(input, 'projectId')) {
    if (!/^[\da-f]{32}$/i.test(input.projectId)) throw new Error('The public Reown project ID must contain exactly 32 hexadecimal characters.');
    input.projectId = input.projectId.toLowerCase();
  }
  if (Object.hasOwn(input, 'apiOrigin')) {
    let url;
    try { url = new URL(input.apiOrigin); } catch (_) { throw new Error('The backend address must be a valid HTTPS origin.'); }
    // Check the original text too: URL parsing can normalize /.., whitespace or
    // a backslash into a root path, hiding an input that was not an exact origin.
    const rawOrigin = /^https:\/\/[^/\\?#\s]+\/?$/i.test(input.apiOrigin);
    if (!rawOrigin || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('The backend address must be a HTTPS origin without a path, query, fragment or credentials.');
    }
    input.apiOrigin = url.origin;
  }
  return input;
}

function configureApp(args, filename = CONFIG_FILE) {
  const input = parseArgs(args);
  if (input.help) return { help: true, changed: false };
  let original;
  let config;
  let stat;
  try {
    stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
    original = fs.readFileSync(filename, 'utf8');
  } catch (_) { throw new Error('The existing public app configuration could not be read as a regular file.'); }
  try { config = JSON.parse(original); }
  catch (_) { throw new Error('The public app configuration must contain valid JSON.'); }
  if (!object(config)) throw new Error('The public app configuration must be a JSON object.');
  const next = { ...config };
  const fields = [];
  if (Object.hasOwn(input, 'projectId')) {
    if (config.walletConnect !== undefined && !object(config.walletConnect)) throw new Error('The existing walletConnect settings must be a JSON object.');
    next.walletConnect = { ...config.walletConnect || {}, projectId: input.projectId };
    if (config.walletConnect?.projectId !== input.projectId) fields.push('Reown project ID');
  }
  if (Object.hasOwn(input, 'apiOrigin')) {
    next.apiBaseUrl = input.apiOrigin;
    if (config.apiBaseUrl !== input.apiOrigin) fields.push('backend origin');
  }
  if (!fields.length) return { changed: false, fields };
  const temporary = filename + '.configure-' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: stat.mode & 0o777 });
    fs.renameSync(temporary, filename);
  } catch (_) {
    throw new Error('The public app settings could not be saved.');
  } finally {
    // This exact sibling file is owned by this invocation; no directory cleanup.
    try { fs.unlinkSync(temporary); } catch (_) { /* Renaming already removed it. */ }
  }
  return { changed: true, fields };
}

if (require.main === module) {
  try {
    const result = configureApp(process.argv.slice(2));
    if (result.help) console.log(USAGE);
    else {
      console.log(result.changed ? 'Saved public app settings: ' + result.fields.join(', ') + '.' : 'Public app settings already match.');
      console.log('Run launch checks and deploy to apply these settings.');
    }
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, configureApp };
