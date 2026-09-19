'use strict';
/**
 * bolt11 — read a Lightning invoice far enough to check it before paying it.
 *
 * A provider hands the redeem function an invoice and a payment hash and says "pay this". Before
 * a treasury wallet pays anything it should be able to see, from the invoice itself, what it is
 * about to pay: how many sats, to which payment hash, and until when. That is the whole of what
 * this file reads — the amount from the human-readable part, and the `p` (payment hash), `x`
 * (expiry) and `d` (description) tagged fields from the data part, per BOLT 11. The signature is
 * not checked: the invoice is paid through a wallet that checks it, and a forged one would simply
 * fail to route. What matters here is that the hash the provider quoted is the hash in the invoice
 * and that the amount is the amount the catalogue implies.
 *
 * bech32 is implemented in full (checksum included) because an invoice with a typo in it must be
 * refused, not paid to whatever the typo decodes to. BOLT 11 lifts bech32's 90-character limit.
 */
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const MSAT_PER = { '': 100000000000n, m: 100000000n, u: 100000n, n: 100n };   // per unit of the hrp amount
const SIG_WORDS = 104;      // 65 bytes of signature, in 5-bit words
const TIMESTAMP_WORDS = 7;  // 35 bits
const DEFAULT_EXPIRY_S = 3600;

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

function hrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

/** hrp + 5-bit words in, a checksummed bech32 string out. Used by tests to mint invoices. */
function bech32Encode(hrp, words) {
  const values = hrpExpand(hrp).concat(words, [0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const check = [];
  for (let i = 0; i < 6; i++) check.push((mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + words.concat(check).map((w) => CHARSET[w]).join('');
}

function bech32Decode(str) {
  const s = String(str || '').trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new Error('invoice mixes upper and lower case');
  const lower = s.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw new Error('invoice has no separator');
  const hrp = lower.slice(0, pos);
  const words = [];
  for (const c of lower.slice(pos + 1)) {
    const v = CHARSET.indexOf(c);
    if (v < 0) throw new Error('invoice has a character outside bech32');
    words.push(v);
  }
  if (polymod(hrpExpand(hrp).concat(words)) !== 1) throw new Error('invoice checksum does not match');
  return { hrp, words: words.slice(0, -6) };
}

const wordsToNumber = (words) => words.reduce((n, w) => n * 32 + w, 0);

/** 5-bit words to bytes, dropping the trailing bits that do not fill a byte (BOLT 11 pads with zeros). */
function wordsToBytes(words) {
  const out = [];
  let acc = 0, bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) { bits -= 8; out.push((acc >>> bits) & 0xff); }
    acc &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** Bytes to 5-bit words, zero-padded at the end. The inverse of wordsToBytes, for the encoder. */
function bytesToWords(bytes) {
  const out = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >>> bits) & 31); }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

function numberToWords(n, count) {
  const out = [];
  for (let i = 0; i < count; i++) { out.unshift(n % 32); n = Math.floor(n / 32); }
  return out;
}

/**
 * The amount in the human-readable part: ln + network + digits + multiplier. Returns msat as a
 * BigInt, or null for an invoice that names no amount (which the caller must refuse: an open
 * invoice would let the payee name the price).
 */
function parseAmount(hrp) {
  const m = /^ln(bcrt|tbs|tb|bc)(\d*)([munp]?)$/.exec(hrp);
  if (!m) throw new Error('not a Lightning invoice (prefix ' + hrp.slice(0, 6) + ')');
  const [, prefix, digits, mult] = m;
  if (!digits) return { prefix, msat: null };
  if (mult === 'p') {
    if (!/0$/.test(digits)) throw new Error('invoice amount is a fraction of a millisatoshi');
    return { prefix, msat: BigInt(digits) / 10n };
  }
  return { prefix, msat: BigInt(digits) * MSAT_PER[mult] };
}

/**
 * Decode. Throws on anything that is not a well-formed invoice. Returns
 *   { prefix, msat (string), sats (number, whole), paymentHash (hex, no 0x), timestamp, expiry,
 *     expiresAt (unix seconds), description }
 */
function decode(invoice) {
  const { hrp, words } = bech32Decode(invoice);
  const { prefix, msat } = parseAmount(hrp);
  if (words.length < TIMESTAMP_WORDS + SIG_WORDS) throw new Error('invoice is too short');
  const timestamp = wordsToNumber(words.slice(0, TIMESTAMP_WORDS));
  const tagged = words.slice(TIMESTAMP_WORDS, words.length - SIG_WORDS);
  let paymentHash = '', expiry = DEFAULT_EXPIRY_S, description = '';
  let sawHash = false, sawExpiry = false, sawDescription = false;
  for (let i = 0; i + 3 <= tagged.length;) {
    const type = tagged[i];
    const len = tagged[i + 1] * 32 + tagged[i + 2];
    const data = tagged.slice(i + 3, i + 3 + len);
    if (data.length < len) throw new Error('invoice tagged field runs past the end');
    // BOLT 11: a reader that sees a tagged field more than once keeps the first and ignores the
    // rest. Unconditionally overwriting here would make the LAST occurrence win instead — so an
    // invoice carrying a real payment hash and, after it, a decoy equal to whatever hash the
    // payee quoted separately would pass a hash check here while the payment settles under the
    // other. First-wins closes that off for every tagged field this file reads, not just the hash.
    if (type === 1 && len === 52 && !sawHash) { paymentHash = wordsToBytes(data).slice(0, 32).toString('hex'); sawHash = true; }
    else if (type === 6 && !sawExpiry) { expiry = wordsToNumber(data); sawExpiry = true; }
    else if (type === 13 && !sawDescription) { description = wordsToBytes(data).toString('utf8'); sawDescription = true; }
    i += 3 + len;
  }
  if (!paymentHash) throw new Error('invoice has no payment hash');
  return {
    prefix,
    msat: msat === null ? null : msat.toString(),
    sats: msat === null ? null : Number(msat / 1000n),
    paymentHash,
    timestamp,
    expiry,
    expiresAt: timestamp + expiry,
    description,
  };
}

/**
 * Mint an invoice with a given amount, hash, timestamp and expiry, signed with 65 zero bytes.
 * It decodes, and a real wallet would refuse it, which is exactly what a test double needs.
 */
function encode({ sats, paymentHash, timestamp, expiry = DEFAULT_EXPIRY_S, description = '', prefix = 'bc' }) {
  const hrp = 'ln' + prefix + (sats === null || sats === undefined ? '' : String(BigInt(sats) * 10n) + 'n');
  let words = numberToWords(timestamp, TIMESTAMP_WORDS);
  const field = (type, data) => { words = words.concat([type, Math.floor(data.length / 32), data.length % 32], data); };
  field(1, bytesToWords(Buffer.from(paymentHash, 'hex')));
  if (description) field(13, bytesToWords(Buffer.from(description, 'utf8')));
  const ew = []; let e = expiry; while (e > 0) { ew.unshift(e % 32); e = Math.floor(e / 32); }
  if (ew.length) field(6, ew);
  words = words.concat(bytesToWords(Buffer.alloc(65)));
  return bech32Encode(hrp, words);
}

module.exports = { decode, encode, bech32Decode, bech32Encode, wordsToBytes, bytesToWords };
