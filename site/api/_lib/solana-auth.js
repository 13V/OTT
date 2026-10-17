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

/** True when `signature` (base58, 64 bytes) is `address`'s ed25519 signature over the UTF-8 bytes of `message`. */
function verifyMessage(message, signature, address) {
  if (typeof message !== 'string' || !message || message.length > MAX_MESSAGE_CHARS) return false;
  const key = S.addressBytes(address);
  if (!key || !S.isSignature(signature)) return false;
  try {
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, Buffer.from(key)]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(S.decodeBase58(signature)));
  } catch (_) { return false; }
}

module.exports = { encodeAddress, decodeAddress, verifyMessage };
