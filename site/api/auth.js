'use strict';

const crypto = require('node:crypto');
const { store: chooseStore } = require('./_lib/store');
const { allowRequestOrigin } = require('./_lib/request-origin');
const solana = require('./_lib/solana-auth');
const walletLinks = require('./_lib/wallet-links');

const CHALLENGE_SECONDS = 5 * 60;
const SESSION_SECONDS = 30 * 60;
const MAX_BODY_BYTES = 16 * 1024;
const STATEMENT = 'Sign in to OTT. This does not move funds.';
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const challengeKey = id => 'auth:challenge:' + id;
const sessionKey = token => 'auth:session:' + digest(token);
const account = address => ({ address, chain: 'solana', verified: true, credit: 0, eligible: false });

function fail(status, message) { const error = new Error(message); error.status = status; return error; }
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function originOf(value) {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '';
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return '';
    return url.origin;
  } catch (_) { return ''; }
}

function frontend(body, req) {
  let url;
  try { url = new URL(body.uri); } catch (_) { throw fail(400, 'a configured frontend URI is required'); }
  const origin = originOf(url.origin);
  const configured = String(process.env.FRONTEND_ORIGINS || '').split(',').map(value => originOf(value.trim())).filter(Boolean);
  const signIn = String(process.env.SIGNIN_HOST || '').trim();
  const signInOrigin = originOf(/^https?:\/\//.test(signIn) ? signIn : 'https://' + signIn);
  const signInHost = signInOrigin ? new URL(signInOrigin).host : '';
  if (!origin || url.username || url.password || url.search || url.hash
    || body.uri !== url.origin + url.pathname || body.domain !== url.host
    || (!configured.includes(origin) && !(signInHost === url.host && url.protocol === 'https:'))) {
    throw fail(403, 'sign-in frontend is not allowed');
  }
  if (req.headers?.origin && req.headers.origin !== origin) throw fail(403, 'sign-in frontend does not match request origin');
  return { domain: url.host, uri: url.origin + url.pathname, origin };
}

function requestOriginMatches(origin, req) {
  if (req.headers?.origin && req.headers.origin !== origin) throw fail(403, 'session belongs to another frontend');
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    const parsed = typeof req.body === 'object';
    const text = parsed ? JSON.stringify(req.body) : String(req.body);
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw fail(413, 'request body exceeds 16 KiB');
    return parsed ? req.body : JSON.parse(text);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw fail(413, 'request body exceeds 16 KiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token)
    && Buffer.from(token, 'base64url').toString('base64url') === token;
}

module.exports = async (req, res) => {
  if (!allowRequestOrigin(req, res, ['POST'])) return;
  if (req.method !== 'POST') { res.setHeader('allow', 'POST'); return send(res, 405, { ok: false, error: 'method not allowed' }); }
  try {
    let body;
    try { body = await readBody(req); } catch (error) {
      if (error.status === 413) { res.setHeader('connection', 'close'); throw error; }
      throw fail(400, 'body must be a JSON object');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, 'body must be a JSON object');
    if (!['challenge', 'verify', 'session', 'logout', 'link-challenge', 'link-verify', 'link', 'unlink'].includes(body.action)) throw fail(400, 'unknown authentication action');
    const store = chooseStore();
    const now = Date.now();

    if (body.action === 'challenge') {
      if (!solana.decodeAddress(body.address)) throw fail(400, 'a canonical Solana address is required');
      const site = frontend(body, req);
      const source = req.headers?.['x-vercel-forwarded-for'] || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
      const ip = String(source).split(',')[0].trim();
      for (const key of ['auth:rate:ip:' + digest(ip), 'auth:rate:address:' + digest(body.address)]) {
        if (!(await store.set(key, { at: now }, { nx: true, ex: 1 }))) {
          res.setHeader('retry-after', '1');
          throw fail(429, 'please wait a moment before signing in again');
        }
      }
      const challengeId = crypto.randomBytes(24).toString('hex');
      const input = {
        domain: site.domain, address: body.address, statement: STATEMENT, uri: site.uri,
        version: '1', chainId: 'solana:mainnet', nonce: crypto.randomBytes(24).toString('hex'),
        issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + CHALLENGE_SECONDS * 1000).toISOString(),
      };
      if (!(await store.set(challengeKey(challengeId), { input, origin: site.origin, expiresAt: now + CHALLENGE_SECONDS * 1000 }, { nx: true, ex: CHALLENGE_SECONDS }))) {
        throw fail(503, 'sign-in is temporarily unavailable');
      }
      return send(res, 200, { ok: true, input, challengeId });
    }

    if (body.action === 'verify') {
      if (typeof body.challengeId !== 'string' || !/^[a-f0-9]{48}$/.test(body.challengeId)
        || !solana.decodeAddress(body.address)) throw fail(401, 'sign-in challenge is invalid or expired');
      const key = challengeKey(body.challengeId);
      const challenge = await store.get(key);
      if (!challenge || !Number.isSafeInteger(challenge.expiresAt) || now >= challenge.expiresAt || body.address !== challenge.input?.address
        || (body.signatureType !== undefined && body.signatureType !== 'ed25519')) throw fail(401, 'sign-in challenge is invalid or expired');
      frontend(challenge.input, req);
      if (!solana.verify(challenge.input, body.signedMessage, body.signature)) throw fail(401, 'wallet signature is invalid');
      // Consuming the exact stored challenge is atomic across function instances and parallel requests.
      if (!(await store.compareDel(key, challenge))) throw fail(401, 'sign-in challenge is invalid or expired');
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = now + SESSION_SECONDS * 1000;
      if (!(await store.set(sessionKey(token), { address: body.address, origin: challenge.origin, expiresAt }, { nx: true, ex: SESSION_SECONDS }))) {
        throw fail(503, 'sign-in is temporarily unavailable');
      }
      const linkedWallet = await walletLinks.read(store, body.address);
      return send(res, 200, { ok: true, token, account: account(body.address), expiresAt, ...(linkedWallet ? { linkedWallet } : {}) });
    }

    if (!validToken(body.token)) throw fail(401, 'session is invalid or expired');
    const key = sessionKey(body.token);
    const session = await store.get(key);
    if (session) requestOriginMatches(session.origin, req);
    if (body.action === 'logout') { await store.del(key); return send(res, 200, { ok: true }); }
    if (!session || !Number.isSafeInteger(session.expiresAt) || now >= session.expiresAt
      || !solana.decodeAddress(session.address)) throw fail(401, 'session is invalid or expired');
    const context = { sessionKey: key, session, sessionHash: digest(body.token) };
    if (body.action === 'link-challenge') {
      return send(res, 200, await walletLinks.challenge(store, { ...context, site: frontend(body, req), evmAddress: body.evmAddress }));
    }
    if (body.action === 'link-verify') {
      return send(res, 200, await walletLinks.verify(store, { ...context, body, checkFrontend: input => frontend(input, req) }));
    }
    if (body.action === 'unlink') return send(res, 200, await walletLinks.unlink(store, context));
    const linkedWallet = await walletLinks.read(store, session.address);
    if (body.action === 'link') return send(res, 200, { ok: true, linkedWallet });
    return send(res, 200, { ok: true, account: account(session.address), expiresAt: session.expiresAt, ...(linkedWallet ? { linkedWallet } : {}) });
  } catch (error) {
    // Store failures are never echoed: they may contain deployment URLs or bearer credentials.
    const known = [400, 401, 403, 409, 413, 429].includes(error.status);
    return send(res, known ? error.status : 503, { ok: false, error: known ? error.message : 'sign-in is temporarily unavailable' });
  }
};
