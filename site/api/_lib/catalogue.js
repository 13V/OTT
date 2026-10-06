'use strict';

const { createHash } = require('node:crypto');
const FIELDS = ['code', 'slug', 'name', 'kind', 'regions', 'gb', 'days', 'priceUsd'];

function catalogueReady(config) {
  const packages = config && config.packages;
  return Array.isArray(packages) && packages.length > 0 && new Set(packages.map(item => item && item.code)).size === packages.length
    && packages.every(item => item && ['code', 'slug', 'name', 'regions'].every(key => typeof item[key] === 'string' && item[key].trim())
      && ['country', 'region'].includes(item.kind) && Number.isFinite(item.gb) && item.gb > 0
      && Number.isSafeInteger(item.days) && item.days > 0 && Number.isFinite(item.priceUsd) && item.priceUsd > 0);
}

// Hash only public purchase terms, in a stable order. Missing/invalid terms cannot agree.
function catalogueFingerprint(config) {
  if (!catalogueReady(config)) return '';
  const packages = config.packages.slice().sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const canonical = packages.map(item => FIELDS.map(field => item[field]));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

module.exports = { catalogueReady, catalogueFingerprint };
