'use strict';

// A Pages frontend may use a separately hosted API. List each trusted frontend's full origin
// in FRONTEND_ORIGINS, separated by commas. Paths and wildcards never grant access, and a
// browser from any other origin is refused before the handler reads a ledger or contacts a payer.
function originOf(value) {
  try {
    const url = new URL(String(value || '').trim());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch (e) { return ''; }
}

function refusal(res, error) {
  res.statusCode = 403;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ ok: false, error }));
  return false;
}

function allowRequestOrigin(req, res, methods) {
  const headers = req.headers || {};
  const raw = headers.origin;
  res.setHeader('vary', 'Origin');
  if (!raw) return req.method === 'OPTIONS' ? refusal(res, 'preflight requires an origin') : true;
  if (typeof raw !== 'string') return refusal(res, 'origin not allowed');
  const origin = originOf(raw);
  // Origin headers are origins, not arbitrary URLs: reject a path, credentials or a trailing
  // slash even though the configuration parser accepts an optional slash for convenience.
  if (!origin || raw !== origin) return refusal(res, 'origin not allowed');
  const allowed = String(process.env.FRONTEND_ORIGINS || '').split(',').map(originOf).filter(Boolean);
  const sameHost = new URL(origin).host === String(headers.host || '').toLowerCase();
  if (!sameHost && !allowed.includes(origin)) return refusal(res, 'origin not allowed');

  res.setHeader('access-control-allow-origin', origin);
  if (req.method !== 'OPTIONS') return true;
  const requested = String(headers['access-control-request-method'] || '').toUpperCase();
  const requestedHeaders = String(headers['access-control-request-headers'] || '')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!methods.includes(requested) || requestedHeaders.some(name => name !== 'content-type')) {
    return refusal(res, 'preflight request not allowed');
  }
  res.statusCode = 204;
  res.setHeader('access-control-allow-methods', methods.join(', '));
  res.setHeader('access-control-allow-headers', 'Content-Type');
  res.setHeader('cache-control', 'no-store');
  res.end();
  return false;
}

const isProduction = () => process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

module.exports = { allowRequestOrigin, isProduction };
