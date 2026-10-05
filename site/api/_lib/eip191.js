'use strict';
/**
 * eip191.js — what `personal_sign` actually signs, and how to get the signer back out.
 *
 * A wallet asked to personal_sign a string does not sign the string. It signs
 * keccak256("\x19Ethereum Signed Message:\n" + <byte length> + <string>) — EIP-191, version 0x45 —
 * so that a signature over a friendly sentence can never double as a signature over a transaction
 * (no transaction starts with 0x19). The length is in BYTES, not characters, which only matters
 * when a message carries non-ASCII; ours never does, but the digest is computed the correct way
 * regardless so this file stays true for any message.
 *
 * The signature a wallet returns is 65 bytes, r || s || v, and `v` is the one inconsistency in the
 * ecosystem: MetaMask and most others give 27/28, some hardware wallets and libraries give 0/1.
 * Both are accepted here and normalised to what secp256k1.recover expects (27/28). Nothing else
 * is lenient — a signature of the wrong length is a bad signature, not a malformed one.
 *
 * sign() exists for tests and tooling so that the round trip (this file signs, this file recovers)
 * is exercised end to end with the exact byte layout a wallet would have produced.
 */
const { keccak256 } = require('./keccak');
const secp = require('./secp256k1');

const PREFIX = '\x19Ethereum Signed Message:\n';

/** The 32-byte digest a wallet signs for `message` under personal_sign. */
function digest(message) {
  const body = Buffer.from(String(message), 'utf8');
  return keccak256(Buffer.concat([Buffer.from(PREFIX + body.length, 'utf8'), body]));
}

/**
 * Split a 65-byte hex signature into what recover() takes. Returns null rather than throwing on
 * anything that is not exactly r||s||v, so a caller can treat "malformed" and "wrong" the same way
 * (both are 401; a client gains nothing from knowing which).
 */
function splitSignature(sigHex) {
  const hex = String(sigHex || '').replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{130}$/.test(hex)) return null;
  let v = parseInt(hex.slice(128, 130), 16);
  if (v === 0 || v === 1) v += 27;
  if (v !== 27 && v !== 28) return null;
  return { r: '0x' + hex.slice(0, 64), s: '0x' + hex.slice(64, 128), v };
}

/** Lowercase address that produced `sigHex` over `message`, or null if the signature is no good. */
function recoverAddress(message, sigHex) {
  const sig = splitSignature(sigHex);
  if (!sig) return null;
  const who = secp.recover(digest(message), sig.v, sig.r, sig.s);
  return who ? who.toLowerCase() : null;
}

/** personal_sign as a wallet would do it: 0x + r + s + v(27/28), one hex string. */
function sign(privHex, message) {
  const sig = secp.sign(privHex, digest(message));
  return '0x' + sig.r.slice(2) + sig.s.slice(2) + sig.v.toString(16).padStart(2, '0');
}

module.exports = { PREFIX, digest, splitSignature, recoverAddress, sign };
