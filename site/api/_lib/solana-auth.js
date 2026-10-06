'use strict';

// Phantom SIWS / wallet-standard message construction. Signatures cover these exact UTF-8 bytes.
// https://github.com/phantom/sign-in-with-solana#message-construction
const crypto = require('node:crypto');
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

function encodeAddress(bytes) {
  let value = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let encoded = '';
  while (value) { encoded = ALPHABET[Number(value % 58n)] + encoded; value /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; encoded = '1' + encoded; }
  return encoded;
}

function decodeAddress(address) {
  if (typeof address !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  let value = 0n;
  for (const char of address) value = value * 58n + BigInt(ALPHABET.indexOf(char));
  const hex = value.toString(16);
  const body = value ? Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex') : Buffer.alloc(0);
  const zeroes = /^1*/.exec(address)[0].length;
  const bytes = Buffer.concat([Buffer.alloc(zeroes), body]);
  return bytes.length === 32 && encodeAddress(bytes) === address ? bytes : null;
}

function messageBytes(input) {
  return Buffer.from([
    input.domain + ' wants you to sign in with your Solana account:', input.address, '',
    input.statement, '', 'URI: ' + input.uri, 'Version: ' + input.version,
    'Chain ID: ' + input.chainId, 'Nonce: ' + input.nonce, 'Issued At: ' + input.issuedAt,
    'Expiration Time: ' + input.expirationTime,
  ].join('\n'), 'utf8');
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value || value.length > 8192
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

function verify(input, signedMessage, signature) {
  const key = decodeAddress(input.address);
  const message = decodeBase64(signedMessage);
  const sig = decodeBase64(signature);
  const expected = messageBytes(input);
  if (!key || !message || !sig || sig.length !== 64 || message.length !== expected.length
    || !crypto.timingSafeEqual(message, expected)) return false;
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, key]), format: 'der', type: 'spki' });
    return crypto.verify(null, message, publicKey, sig);
  } catch (_) { return false; }
}

module.exports = { encodeAddress, decodeAddress, messageBytes, decodeBase64, verify };
