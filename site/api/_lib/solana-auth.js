'use strict';
/**
 * solana-auth — Solana addresses and message signatures for the API, on node:crypto.
 *
 * A signed request to /api/redeem carries a labelled message and the wallet's ed25519 signature
 * over that message's exact UTF-8 bytes, base58-encoded (64 bytes), which is what a wallet's
 * signMessage returns. verifyMessage() checks it against the public key the address encodes.
 *
 * encodeAddress()/decodeAddress() keep the names the operator tooling in scripts/ already uses:
 * base58 of any bytes, and the 32 bytes of a canonical address (as a Buffer) or null.
 */
const crypto = require('node:crypto');
const S = require('../../solana.js');

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
// A sign-in message is a handful of short lines; anything longer is not one of ours.
const MAX_MESSAGE_CHARS = 4096;

function encodeAddress(bytes) {
  return S.encodeBase58(Uint8Array.from(bytes));
}

function decodeAddress(address) {
  const bytes = S.addressBytes(address);
  return bytes ? Buffer.from(bytes) : null;
}

// The small-order points of edwards25519, each with its sign bit cleared (libsodium's list,
// including the non-canonical encodings of 0 and 1). A public key that is one of them verifies
// forged signatures, so none is ever accepted.
const SMALL_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map((hex) => Buffer.from(hex, 'hex'));
function hasSmallOrder(key) {
  const k = Buffer.from(key);
  k[31] &= 0x7f;
  return SMALL_ORDER.some((p) => p.equals(k));
}

/** True when `signature` (base58, 64 bytes) is `address`'s ed25519 signature over the UTF-8 bytes of `message`. */
function verifyMessage(message, signature, address) {
  if (typeof message !== 'string' || !message || message.length > MAX_MESSAGE_CHARS) return false;
  const key = S.addressBytes(address);
  if (!key || !S.isSignature(signature) || hasSmallOrder(key)) return false;
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(key)]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(S.decodeBase58(signature)));
  } catch (_) { return false; }
}

module.exports = { encodeAddress, decodeAddress, verifyMessage, hasSmallOrder };
