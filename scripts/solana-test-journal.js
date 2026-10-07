'use strict';
// Private, append-only review/recovery foundation. No keys, signing, RPC or broadcast.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const kit = require('@solana/kit');
const { PRIVATE_BASE, privatePath, writePrivate } = require('./operator-test-files');
const { decodeAddress } = require('../site/api/_lib/solana-auth');
const { serializeUnsignedUsdcIntent } = require('./solana-test-transfer');

const BASE = path.join(PRIVATE_BASE, 'solana-journal');
const FAILURE = 'Could not use the private Solana test journal. Keep the original reservation and review protected storage and records.';
const U64 = (1n << 64n) - 1n;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function refuse() { throw new Error(FAILURE); }
function exact(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) refuse();
}
function integer(value, positive = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64 || (positive && value === '0')) refuse();
  return BigInt(value);
}
function time(value) {
  if (typeof value !== 'string' || !Number.isSafeInteger(Date.parse(value)) || new Date(value).toISOString() !== value) refuse();
  return Date.parse(value);
}
function now(options) {
  const value = options.now === undefined ? Date.now() : typeof options.now === 'function' ? options.now() : options.now;
  if (!Number.isSafeInteger(value) || value < 0) refuse();
  return value;
}
function address(value) { if (!decodeAddress(value)) refuse(); return value; }
function safePath(value) {
  const absolute = path.resolve(value);
  for (let current = absolute; ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) refuse(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current === path.dirname(current)) break;
  }
  return privatePath(absolute);
}
function locations(sourceAddress, options) {
  address(sourceAddress);
  const base = safePath(options.baseDir === undefined ? BASE : options.baseDir);
  const directory = safePath(path.join(base, 'wallet-' + sha256(sourceAddress)));
  return { directory, active: path.join(directory, 'active.json'), signed: path.join(directory, 'signed.json') };
}
function assertPrivate(file) {
  if (process.platform !== 'win32') {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) || stat.uid !== process.getuid()) refuse();
    return;
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$journalPayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$journalItem = Get-Item -LiteralPath $journalPayload.file -Force
$journalAcl = $journalItem.GetAccessControl()
$journalOwner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$journalIds = $journalAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }
if (!$journalAcl.AreAccessRulesProtected -or $journalAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $journalOwner -or ($journalIds | Where-Object { $_ -ne $journalOwner -and $_ -ne 'S-1-5-18' })) { throw 'Private journal ACL required' }
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: JSON.stringify({ file }), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 10000,
  });
}
function read(file) {
  const target = safePath(file);
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.size > 65536) refuse();
  assertPrivate(path.dirname(target)); assertPrivate(target);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}
function flush(file) {
  const fd = fs.openSync(safePath(file), fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function publish(file, value, beforePublication = () => {}) {
  const target = safePath(file);
  const serialized = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(serialized) > 65536) refuse();
  const staging = safePath(path.join(path.dirname(target), '.journal-' + crypto.randomUUID() + '.tmp'));
  try {
    // writePrivate establishes protected ACLs before any journal content is written.
    // Only a unique staging file is written; authoritative files are never truncated.
    writePrivate(staging, serialized);
    flush(staging);
    safePath(target);
    beforePublication();
    try { fs.linkSync(staging, target); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    flush(target);
    if (process.platform !== 'win32') {
      const fd = fs.openSync(path.dirname(target), fs.constants.O_RDONLY);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return true;
  } finally {
    // A post-publication failure retains the authoritative reservation/signed record.
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
  }
}
function limits(value) {
  exact(value, ['maxFeeLamports', 'maxRentLamports', 'maxRequiredSolLamports']);
  integer(value.maxFeeLamports, true); integer(value.maxRentLamports); integer(value.maxRequiredSolLamports, true);
  return { maxFeeLamports: value.maxFeeLamports, maxRentLamports: value.maxRentLamports, maxRequiredSolLamports: value.maxRequiredSolLamports };
}
function gas(value, intent, caps) {
  const fields = ['status', 'feeLamports', 'ataRentEachLamports', 'ataRentLamports', 'feePayerReserveLamports', 'requiredSolLamports', 'checkedAt', 'confirmedSlot'];
  const optional = ['priorityFeeLamports', 'usdMicros', 'ataRentExpectedLamports', 'availableSolLamports'];
  exact(value, fields, optional);
  if (value.status !== 'rpc-quoted' || !Number.isSafeInteger(value.confirmedSlot) || value.confirmedSlot < 0) refuse();
  const fee = integer(value.feeLamports, true), each = integer(value.ataRentEachLamports, true);
  const rent = integer(value.ataRentLamports), reserve = integer(value.feePayerReserveLamports), required = integer(value.requiredSolLamports, true);
  if (rent !== each * BigInt(Number(intent.createSourceAta) + Number(intent.createDestinationAta)) || required !== fee + rent + reserve ||
      fee > integer(caps.maxFeeLamports) || rent > integer(caps.maxRentLamports) || required > integer(caps.maxRequiredSolLamports)) refuse();
  time(value.checkedAt);
  if (value.priorityFeeLamports !== undefined && value.priorityFeeLamports !== '0') refuse();
  if (value.usdMicros !== undefined && value.usdMicros !== null) integer(value.usdMicros);
  for (const field of ['ataRentExpectedLamports', 'availableSolLamports']) if (value[field] !== undefined) integer(value[field]);
  if (value.ataRentExpectedLamports !== undefined && integer(value.ataRentExpectedLamports) > rent) refuse();
  return Object.fromEntries([...fields, ...optional].filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
}
function economicIntent(intent) {
  const frozen = clone(intent);
  delete frozen.blockhash; delete frozen.lastValidBlockHeight;
  if (frozen.orderBinding) delete frozen.orderBinding.expiresAt;
  return frozen;
}
async function preparedRecord(input, caps) {
  if (!input || typeof input !== 'object') refuse();
  const rebuilt = await serializeUnsignedUsdcIntent(input.intent);
  for (const field of Object.keys(rebuilt)) if (!same(input[field], rebuilt[field])) refuse();
  const data = { artifact: clone(rebuilt), gas: gas(input.gas, rebuilt.intent, caps) };
  return { schema: 1, kind: 'ott-solana-prepared', preparedId: sha256(JSON.stringify(data)), ...data };
}
async function validatePrepared(record, caps) {
  exact(record, ['schema', 'kind', 'preparedId', 'artifact', 'gas']);
  const rebuilt = await preparedRecord({ ...record.artifact, gas: record.gas }, caps);
  if (!same(record, rebuilt)) refuse();
  return rebuilt;
}
function fresh(prepared, options) {
  const at = now(options), checkedAt = time(prepared.gas.checkedAt);
  if (checkedAt > at || at - checkedAt > 60000 ||
      (prepared.artifact.intent.orderBinding && time(prepared.artifact.intent.orderBinding.expiresAt) <= at)) refuse();
}
function reservationId(sourceAddress, purpose, ownerReturnAddress, intent) {
  return sha256(JSON.stringify([sourceAddress, purpose, ownerReturnAddress, economicIntent(intent)]));
}
async function validateActive(record, sourceAddress) {
  exact(record, ['schema', 'kind', 'reservationId', 'runId', 'purpose', 'sourceAddress', 'ownerReturnAddress', 'limits', 'economicHash', 'reservedAtISO', 'initialPrepared']);
  if (record.schema !== 1 || record.kind !== 'ott-solana-reservation' || record.sourceAddress !== sourceAddress ||
      !['merchant-payment', 'owner-recovery'].includes(record.purpose) || typeof record.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(record.runId)) refuse();
  address(record.ownerReturnAddress); time(record.reservedAtISO);
  if (record.ownerReturnAddress === sourceAddress || kit.isOffCurveAddress(kit.address(record.ownerReturnAddress))) refuse();
  const caps = limits(record.limits), prepared = await validatePrepared(record.initialPrepared, caps), intent = prepared.artifact.intent;
  if (intent.walletAddress !== sourceAddress || intent.purpose !== (record.purpose === 'merchant-payment' ? 'merchant-test' : 'recovery') ||
      (record.purpose === 'owner-recovery' && intent.recipientOwner !== record.ownerReturnAddress) ||
      record.economicHash !== sha256(JSON.stringify(economicIntent(intent))) ||
      record.reservationId !== reservationId(sourceAddress, record.purpose, record.ownerReturnAddress, intent)) refuse();
  return record;
}
async function active(sourceAddress, options) {
  const files = locations(sourceAddress, options);
  if (!fs.existsSync(files.active)) {
    if (fs.existsSync(files.directory)) {
      if (!fs.lstatSync(files.directory).isDirectory()) refuse();
      assertPrivate(files.directory);
      // Missing active.json is safe only before publication. Existing authoritative
      // evidence must never be treated as a fresh wallet or overwritten by a retry.
      if (fs.readdirSync(files.directory).some(name => !/^\.journal-[0-9a-f-]+\.tmp$/.test(name))) refuse();
    }
    return { files, record: null };
  }
  return { files, record: await validateActive(read(files.active), sourceAddress) };
}
function preparedPath(files, id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) refuse();
  return path.join(files.directory, 'prepared-' + id + '.json');
}
async function findPrepared(files, reservation, id) {
  const prepared = id === reservation.initialPrepared.preparedId ? reservation.initialPrepared : await validatePrepared(read(preparedPath(files, id)), reservation.limits);
  if (prepared.preparedId !== id || sha256(JSON.stringify(economicIntent(prepared.artifact.intent))) !== reservation.economicHash) refuse();
  return prepared;
}
function signedBytes(transactionBase64, signature, prepared) {
  if (typeof transactionBase64 !== 'string' || transactionBase64.length > 1644 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(transactionBase64) ||
      typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) refuse();
  const wire = Buffer.from(transactionBase64, 'base64');
  if (!wire.length || wire.length > 1232 || wire.toString('base64') !== transactionBase64) refuse();
  const transaction = kit.getTransactionDecoder().decode(wire), source = prepared.artifact.intent.walletAddress;
  if (Object.keys(transaction.signatures).length !== 1 || !Object.hasOwn(transaction.signatures, source) ||
      !Buffer.from(transaction.messageBytes).equals(Buffer.from(prepared.artifact.messageBase64, 'base64')) ||
      !Buffer.from(kit.getTransactionEncoder().encode(transaction)).equals(wire)) refuse();
  const bytes = transaction.signatures[source];
  if (!bytes || bytes.length !== 64 || kit.getBase58Decoder().decode(bytes) !== signature) refuse();
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decodeAddress(source)]), format: 'der', type: 'spki' });
  if (!crypto.verify(null, transaction.messageBytes, publicKey, bytes)) refuse();
}
async function validateSigned(record, files, reservation) {
  exact(record, ['schema', 'kind', 'reservationId', 'preparedId', 'transactionBase64', 'signature', 'messageHash', 'currentBlockHeight', 'storedAtISO']);
  if (record.schema !== 1 || record.kind !== 'ott-solana-signed' || record.reservationId !== reservation.reservationId) refuse();
  const prepared = await findPrepared(files, reservation, record.preparedId);
  integer(record.currentBlockHeight); time(record.storedAtISO);
  if (record.messageHash !== prepared.artifact.messageHash || integer(record.currentBlockHeight) >= integer(prepared.artifact.intent.lastValidBlockHeight)) refuse();
  signedBytes(record.transactionBase64, record.signature, prepared);
  return record;
}
function observation(input, signature) {
  exact(input, ['method', 'network', 'signature', 'observedAtISO', 'response']);
  if (input.method !== 'getSignatureStatuses' || input.network !== 'solana-mainnet' || input.signature !== signature) refuse();
  time(input.observedAtISO);
  exact(input.response, ['context', 'value']); exact(input.response.context, ['slot'], ['apiVersion']);
  if (!Number.isSafeInteger(input.response.context.slot) || input.response.context.slot < 0 ||
      (input.response.context.apiVersion !== undefined && typeof input.response.context.apiVersion !== 'string') ||
      !Array.isArray(input.response.value) || input.response.value.length !== 1) refuse();
  const status = input.response.value[0];
  if (status !== null) {
    exact(status, ['slot', 'confirmations', 'err', 'confirmationStatus']);
    if (!Number.isSafeInteger(status.slot) || status.slot < 0 || status.slot > input.response.context.slot ||
        (status.confirmations !== null && (!Number.isSafeInteger(status.confirmations) || status.confirmations < 0)) ||
        ![null, 'processed', 'confirmed', 'finalized'].includes(status.confirmationStatus) ||
        (status.err !== null && typeof status.err !== 'string' && (typeof status.err !== 'object' || Array.isArray(status.err)))) refuse();
  }
  const serialized = JSON.stringify(input);
  if (serialized.length > 8192) refuse();
  return { schema: 1, kind: 'ott-solana-status-observation', observationId: sha256(serialized), evidence: clone(input) };
}
async function readJournalInternal(sourceAddress, options) {
  const { files, record } = await active(sourceAddress, options);
  if (!record) return null;
  const prepared = [record.initialPrepared], observations = [];
  for (const name of fs.readdirSync(files.directory)) {
    if (/^prepared-[0-9a-f]{64}\.json$/.test(name)) {
      const entry = await findPrepared(files, record, name.slice(9, -5));
      if (prepared.some(item => item.preparedId === entry.preparedId)) refuse();
      prepared.push(entry);
    } else if (/^observation-[0-9a-f]{64}\.json$/.test(name)) {
      const entry = read(path.join(files.directory, name));
      if (entry.observationId !== name.slice(12, -5)) refuse();
      observations.push(entry);
    }
    else if (name !== 'active.json' && name !== 'signed.json' && !/^\.journal-[0-9a-f-]+\.tmp$/.test(name)) refuse();
  }
  const signed = fs.existsSync(files.signed) ? await validateSigned(read(files.signed), files, record) : null;
  for (const entry of observations) {
    exact(entry, ['schema', 'kind', 'observationId', 'evidence']);
    if (!signed || !same(entry, observation(entry.evidence, signed.signature))) refuse();
  }
  observations.sort((a, b) => a.evidence.observedAtISO.localeCompare(b.evidence.observedAtISO) || a.observationId.localeCompare(b.observationId));
  return { schema: 1, stage: signed ? 'signed' : 'reserved', reservationActive: true, paymentReady: false, sendAvailable: false,
    reservation: record, prepared, signed, observations };
}
function guarded(fn) {
  return async (...args) => { try { return await fn(...args); } catch { throw new Error(FAILURE); } };
}
const reserveIntent = guarded(async (input, options = {}) => {
  input = clone(input);
  exact(input, ['purpose', 'runId', 'ownerReturnAddress', 'prepared', 'limits']);
  if (!['merchant-payment', 'owner-recovery'].includes(input.purpose) || typeof input.runId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.runId)) refuse();
  address(input.ownerReturnAddress);
  const caps = limits(input.limits), prepared = await preparedRecord(input.prepared, caps), intent = prepared.artifact.intent;
  if (input.ownerReturnAddress === intent.walletAddress || kit.isOffCurveAddress(kit.address(input.ownerReturnAddress))) refuse();
  if (intent.purpose !== (input.purpose === 'merchant-payment' ? 'merchant-test' : 'recovery') ||
      (input.purpose === 'owner-recovery' && intent.recipientOwner !== input.ownerReturnAddress)) refuse();
  const { files, record } = await active(intent.walletAddress, options);
  const id = reservationId(intent.walletAddress, input.purpose, input.ownerReturnAddress, intent);
  if (record) {
    if (record.reservationId !== id || !same(record.limits, caps)) refuse();
    return readJournalInternal(intent.walletAddress, options);
  }
  fresh(prepared, options);
  const reservation = { schema: 1, kind: 'ott-solana-reservation', reservationId: id, runId: input.runId, purpose: input.purpose,
    sourceAddress: intent.walletAddress, ownerReturnAddress: input.ownerReturnAddress, limits: caps,
    economicHash: sha256(JSON.stringify(economicIntent(intent))), reservedAtISO: new Date(now(options)).toISOString(), initialPrepared: prepared };
  publish(files.active, reservation, () => fresh(prepared, options));
  const winner = await active(intent.walletAddress, options);
  if (!winner.record || winner.record.reservationId !== id || !same(winner.record.limits, caps)) refuse();
  return readJournalInternal(intent.walletAddress, options);
});
const recordPrepared = guarded(async (sourceAddress, input, options = {}) => {
  input = clone(input);
  const { files, record } = await active(sourceAddress, options);
  if (!record || fs.existsSync(files.signed)) refuse();
  const prepared = await preparedRecord(input, record.limits);
  if (sha256(JSON.stringify(economicIntent(prepared.artifact.intent))) !== record.economicHash) refuse();
  fresh(prepared, options);
  if (fs.existsSync(files.signed)) refuse();
  if (prepared.preparedId !== record.initialPrepared.preparedId) {
    const file = preparedPath(files, prepared.preparedId);
    publish(file, prepared, () => fresh(prepared, options));
    if (!same(read(file), prepared)) refuse();
  }
  return readJournalInternal(sourceAddress, options);
});
const storeSigned = guarded(async (sourceAddress, input, options = {}) => {
  input = clone(input);
  exact(input, ['preparedId', 'transactionBase64', 'signature', 'currentBlockHeight']);
  integer(input.currentBlockHeight);
  const { files, record } = await active(sourceAddress, options);
  if (!record) refuse();
  const prepared = await findPrepared(files, record, input.preparedId);
  signedBytes(input.transactionBase64, input.signature, prepared);
  if (fs.existsSync(files.signed)) {
    const existing = await validateSigned(read(files.signed), files, record);
    if (existing.preparedId !== input.preparedId || existing.transactionBase64 !== input.transactionBase64 || existing.signature !== input.signature) refuse();
    return readJournalInternal(sourceAddress, options);
  }
  fresh(prepared, options);
  if (integer(input.currentBlockHeight) >= integer(prepared.artifact.intent.lastValidBlockHeight)) refuse();
  const signed = { schema: 1, kind: 'ott-solana-signed', reservationId: record.reservationId, preparedId: input.preparedId,
    transactionBase64: input.transactionBase64, signature: input.signature, messageHash: prepared.artifact.messageHash,
    currentBlockHeight: input.currentBlockHeight, storedAtISO: new Date(now(options)).toISOString() };
  publish(files.signed, signed, () => fresh(prepared, options));
  const winner = await validateSigned(read(files.signed), files, record);
  if (winner.preparedId !== input.preparedId || winner.transactionBase64 !== input.transactionBase64 || winner.signature !== input.signature) refuse();
  return readJournalInternal(sourceAddress, options);
});
const readJournal = guarded(async (sourceAddress, options = {}) => readJournalInternal(sourceAddress, options));
const reconcile = guarded(async (sourceAddress, evidence, options = {}) => {
  evidence = clone(evidence);
  const { files, record } = await active(sourceAddress, options);
  if (!record || !fs.existsSync(files.signed)) refuse();
  const signed = await validateSigned(read(files.signed), files, record), entry = observation(evidence, signed.signature);
  if (time(evidence.observedAtISO) > now(options)) refuse();
  const file = path.join(files.directory, 'observation-' + entry.observationId + '.json');
  publish(file, entry);
  if (!same(read(file), entry)) refuse();
  // These are caller-supplied RPC observations, never proof of merchant settlement
  // or permission to release/re-sign. Null/error/finalized evidence keeps active.json.
  return readJournalInternal(sourceAddress, options);
});
module.exports = { BASE, reserveIntent, recordPrepared, storeSigned, readJournal, reconcile };
