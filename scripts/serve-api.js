#!/usr/bin/env node
'use strict';

/** Portable HTTP entry for OTT API handlers. It never serves repository files. */
const http = require('node:http');
const net = require('node:net');
const redeem = require('../site/api/redeem');
const status = require('../site/api/status');
const auth = require('../site/api/auth');
const { allowRequestOrigin } = require('../site/api/_lib/request-origin');

const MAX_BODY_BYTES = 16 * 1024;
const ROUTES = new Map([
  ['/api/redeem', { handler: redeem, methods: ['GET', 'POST', 'OPTIONS'] }],
  ['/api/status', { handler: status, methods: ['GET', 'OPTIONS'] }],
  ['/api/auth', { handler: auth, methods: ['POST', 'OPTIONS'] }],
]);

function sendError(res, code, message, close = false) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (close) res.setHeader('connection', 'close');
  res.end(JSON.stringify({ ok: false, error: message }));
}

function bodyError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function readJson(req) {
  const type = String(req.headers['content-type'] || '');
  const media = type.split(';')[0].trim().toLowerCase();
  const charset = /;\s*charset\s*=\s*([^;]+)/i.exec(type)?.[1].trim();
  if (media !== 'application/json' || charset && !/^"?utf-8"?$/i.test(charset)) {
    req.resume();
    return Promise.reject(bodyError(415, 'POST requires application/json encoded as UTF-8'));
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    req.resume();
    return Promise.reject(bodyError(413, 'request body exceeds 16 KiB'));
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const cleanup = () => {
      req.removeListener('data', data);
      req.removeListener('end', end);
      req.removeListener('aborted', aborted);
      req.removeListener('error', failed);
    };
    const fail = error => { cleanup(); req.resume(); reject(error); };
    const data = chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { fail(bodyError(413, 'request body exceeds 16 KiB')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
        resolve(body);
      } catch (_) { reject(bodyError(400, 'body must be a JSON object')); }
    };
    const aborted = () => fail(bodyError(400, 'request body was interrupted'));
    const failed = () => fail(bodyError(400, 'request body could not be read'));
    req.on('data', data);
    req.once('end', end);
    req.once('aborted', aborted);
    req.once('error', failed);
  });
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    req.on('error', () => { /* An interrupted client must not become an unhandled stream error. */ });
    res.setHeader('x-content-type-options', 'nosniff');
    let route;
    try { route = ROUTES.get(new URL(req.url || '/', 'http://local').pathname); }
    catch (_) { return sendError(res, 400, 'invalid request URL', true); }
    if (!route) { req.resume(); return sendError(res, 404, 'API route not found'); }
    try {
      // Unsupported methods are delegated before parsing a body, preserving each handler's
      // existing Allow header and origin policy. OPTIONS never consumes a JSON body.
      if (req.method === 'POST' && route.methods.includes('POST')) {
        // Apply the handler's shared origin policy before buffering a body. Allowed frontends
        // can also read a bounded-body error; unrelated browsers never reach JSON parsing.
        if (!allowRequestOrigin(req, res, ['GET', 'POST'])) { req.resume(); return; }
        req.body = await readJson(req);
      }
      else req.resume();
      await route.handler(req, res);
    } catch (error) {
      // Handler failures never echo a stack, provider URL, signature or environment value.
      const known = [400, 413, 415].includes(error?.statusCode);
      sendError(res, known ? error.statusCode : 500, known ? error.message : 'API request failed', known);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 100;
  return server;
}

function loopback(host) {
  return host.toLowerCase() === 'localhost' || host === '::1' || net.isIP(host) === 4 && host.startsWith('127.');
}

function main() {
  const host = String(process.env.HOST || '127.0.0.1').trim();
  const portText = process.env.PORT === undefined ? '3000' : String(process.env.PORT).trim();
  if (!host || !/^\d{1,5}$/.test(portText) || Number(portText) > 65535) {
    console.error('OTT API: configure a valid HOST and PORT (0–65535).');
    process.exitCode = 1;
    return;
  }
  // A public listener must never inherit a development mock or an in-memory order ledger.
  // The existing API selectors enforce real providers, payers and durable storage in production.
  if (!loopback(host)) process.env.NODE_ENV = 'production';
  const server = createServer();
  server.once('error', error => {
    console.error('OTT API could not listen (' + String(error.code || 'startup error') + ').');
    process.exitCode = 1;
  });
  server.listen(Number(portText), host, () => {
    const address = server.address();
    const formattedHost = address.family === 'IPv6' ? '[' + address.address + ']' : address.address;
    console.log('OTT API listening on http://' + formattedHost + ':' + address.port);
  });
  let stopping = false;
  function shutdown() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 70000);
    deadline.unref();
    server.close(() => { clearTimeout(deadline); process.exit(0); });
    server.closeIdleConnections();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

module.exports = { createServer };
if (require.main === module) main();
