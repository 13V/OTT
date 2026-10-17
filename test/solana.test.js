#!/usr/bin/env node
'use strict';
/**
 * site/solana.js against the reference libraries: base58 and base64 against @solana/kit's codecs,
 * program-derived and associated token addresses against getProgramDerivedAddress and
 * findAssociatedTokenPda, instruction data against @solana-program/token, and compiled messages
 * and wire transactions by decoding them with kit's own decoders. Also the jsonParsed readers and
 * the RPC rotation, against fixtures. Offline.
 *
 *   node test/solana.test.js
 */
const path = require('path');
const crypto = require('crypto');
const kit = require('@solana/kit');
const tok = require('@solana-program/token');
const S = require(path.join(__dirname, '..', 'site', 'solana.js'));

let failures = 0, checks = 0;
const norm = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() + 'n' : x instanceof Uint8Array ? Array.from(x) : x));
const check = (what, got, want) => {
  checks++;
  if (norm(got) === norm(want)) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}\n       got  ${norm(got)}\n       want ${norm(want)}`); }
};
const checkThat = (what, cond, detail) => {
  checks++;
  if (cond) console.log(`  ok   ${what}`);
  else { failures++; console.error(`  FAIL ${what}${detail ? '\n       ' + detail : ''}`); }
};
const throws = (what, fn, pattern) => {
  checks++;
  try { fn(); failures++; console.error(`  FAIL ${what}: did not throw`); }
  catch (e) {
    if (pattern.test(e.message)) console.log(`  ok   ${what}`);
    else { failures++; console.error(`  FAIL ${what}: threw "${e.message}"`); }
  }
};
// A seeded generator, so a failure reproduces.
let seed = 0x5eed;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
const randomBytes = (n) => Uint8Array.from({ length: n }, () => rand() & 0xff);

(async () => {
  const b58 = kit.getBase58Codec();
  const b64 = kit.getBase64Codec();

  // ---------------------------------------------------------------- base58 / base64
  let b58ok = true, b64ok = true;
  for (let i = 0; i < 400; i++) {
    const len = i % 70;
    const bytes = randomBytes(len);
    if (i % 5 === 0 && len) bytes.fill(0, 0, Math.min(len, 1 + (i % 4)));
    const ours = S.encodeBase58(bytes);
    const theirs = b58.decode(bytes);
    if (ours !== theirs || norm(S.decodeBase58(ours)) !== norm(bytes)) { b58ok = false; console.error('    base58 mismatch for', Array.from(bytes)); break; }
    const ours64 = S.encodeBase64(bytes);
    if (ours64 !== b64.decode(bytes) || norm(S.decodeBase64(ours64)) !== norm(bytes)) { b64ok = false; console.error('    base64 mismatch for', Array.from(bytes)); break; }
  }
  checkThat('base58 matches kit for 400 byte strings, leading zeros included', b58ok);
  checkThat('base64 matches kit for the same strings, and decodes back', b64ok);
  throws('base58 refuses a character outside the alphabet', () => S.decodeBase58('0OIl'), /not base58/);

  // ---------------------------------------------------------------- addresses
  check('the system program is a canonical address', S.isAddress(S.PROGRAMS.system), true);
  check('the incinerator is a canonical address', S.isAddress(S.INCINERATOR), true);
  check('an EVM address is not a Solana address', S.isAddress('0x000000000000000000000000000000000000dEaD'), false);
  check('a 31-byte key is not an address', S.isAddress(S.encodeBase58(new Uint8Array(31).fill(7))), false);
  check('a non-canonical spelling (an extra leading 1) is refused', S.isAddress('1' + S.PROGRAMS.token), false);
  const sigBytes = randomBytes(64);
  check('a 64-byte base58 string is a signature', S.isSignature(S.encodeBase58(sigBytes)), true);
  check('an address is not a signature', S.isSignature(S.PROGRAMS.token), false);

  // ---------------------------------------------------------------- program addresses
  // Each derivation tests the on-curve check on every bump it rejects, so a few hundred of them
  // exercise it on many hundreds of points, on both sides of the line.
  let pdaOk = true, rejected = 0;
  for (let i = 0; i < 300; i++) {
    const program = S.encodeBase58(randomBytes(32));
    const seeds = [randomBytes(1 + (rand() % 32)), S.utf8('seed-' + i)];
    const [address, bump] = await kit.getProgramDerivedAddress({ programAddress: kit.address(program), seeds });
    const ours = await S.programAddress(seeds, program);
    rejected += 255 - bump;
    if (ours.address !== address || ours.bump !== bump) { pdaOk = false; console.error('    pda mismatch', program, ours, address, bump); break; }
  }
  checkThat('program addresses match kit for 300 random seeds and programs', pdaOk, `(${rejected} on-curve candidates rejected along the way)`);
  // Real keys are on the curve; a known program address is not.
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const rawPublic = new Uint8Array(keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12));
  check('a real ed25519 public key is on the curve', S.isOnCurve(rawPublic), true);
  const pumpGlobal = await S.programAddress(['global'], S.PROGRAMS.pump);
  check('pump.fun\'s Global account derives to the address read on chain', pumpGlobal.address, '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  check('a program address is off the curve', S.isOnCurve(S.decodeBase58(pumpGlobal.address)), false);

  // ---------------------------------------------------------------- associated token accounts
  let ataOk = true;
  for (let i = 0; i < 40; i++) {
    const owner = S.encodeBase58(randomBytes(32));
    const mint = S.encodeBase58(randomBytes(32));
    const program = i % 2 ? S.PROGRAMS.token2022 : S.PROGRAMS.token;
    const [want] = await tok.findAssociatedTokenPda({ owner: kit.address(owner), mint: kit.address(mint), tokenProgram: kit.address(program) });
    const got = await S.associatedTokenAddress(owner, mint, program);
    if (got !== want) { ataOk = false; console.error('    ata mismatch', owner, mint, program, got, want); break; }
  }
  checkThat('associated token accounts match findAssociatedTokenPda, Token and Token-2022', ataOk);
  const [usdcIncinerator] = await tok.findAssociatedTokenPda({ owner: kit.address(S.INCINERATOR), mint: kit.address(S.MINTS.usdc), tokenProgram: kit.address(S.PROGRAMS.token) });
  check('the incinerator\'s USDC account', await S.associatedTokenAddress(S.INCINERATOR, S.MINTS.usdc, S.PROGRAMS.token), usdcIncinerator);
  let unknownProgram = null;
  try { await S.associatedTokenAddress(S.INCINERATOR, S.MINTS.usdc, S.PROGRAMS.system); } catch (e) { unknownProgram = e.message; }
  check('an associated account under a non-token program is refused', unknownProgram, 'unknown token program');

  // ---------------------------------------------------------------- instruction data
  const owner = S.encodeBase58(rawPublic);
  const mint = S.encodeBase58(randomBytes(32));
  const source = await S.associatedTokenAddress(owner, mint, S.PROGRAMS.token);
  const dest = await S.associatedTokenAddress(S.INCINERATOR, mint, S.PROGRAMS.token);
  const signerStub = { address: kit.address(owner), signTransactions: async () => [] };
  const ourTransfer = S.transferChecked({ source, mint, destination: dest, owner, amount: 1800000000000n, decimals: 6, tokenProgram: S.PROGRAMS.token });
  const kitTransfer = tok.getTransferCheckedInstruction({ source: kit.address(source), mint: kit.address(mint), destination: kit.address(dest), authority: signerStub, amount: 1800000000000n, decimals: 6 });
  check('TransferChecked data matches @solana-program/token', ourTransfer.data, new Uint8Array(kitTransfer.data));
  check('TransferChecked accounts match, in order', ourTransfer.keys.map((k) => k.address), kitTransfer.accounts.map((a) => a.address));
  const ourCreate = S.createAssociatedTokenIdempotent({ payer: owner, account: dest, owner: S.INCINERATOR, mint, tokenProgram: S.PROGRAMS.token });
  const kitCreate = tok.getCreateAssociatedTokenIdempotentInstruction({ payer: signerStub, ata: kit.address(dest), owner: kit.address(S.INCINERATOR), mint: kit.address(mint) });
  check('CreateIdempotent data matches', ourCreate.data, new Uint8Array(kitCreate.data));
  check('CreateIdempotent accounts match, in order', ourCreate.keys.map((k) => k.address), kitCreate.accounts.map((a) => a.address));
  const ourClose = S.closeAccount({ account: source, destination: owner, owner, tokenProgram: S.PROGRAMS.token });
  const kitClose = tok.getCloseAccountInstruction({ account: kit.address(source), destination: kit.address(owner), owner: signerStub });
  check('CloseAccount data matches', ourClose.data, new Uint8Array(kitClose.data));
  check('a system transfer is instruction 2 and a little-endian u64', Array.from(S.systemTransfer({ from: owner, to: dest, lamports: 1000000001n }).data), [2, 0, 0, 0, 1, 202, 154, 59, 0, 0, 0, 0]);
  check('compute unit limit', Array.from(S.computeUnitLimit(40000).data), [2, 64, 156, 0, 0]);
  check('compute unit price', Array.from(S.computeUnitPrice(100000).data), [3, 160, 134, 1, 0, 0, 0, 0, 0]);
  throws('a zero transfer is refused', () => S.transferChecked({ source, mint, destination: dest, owner, amount: 0n, decimals: 6, tokenProgram: S.PROGRAMS.token }), /positive/);

  // ---------------------------------------------------------------- messages
  const blockhash = S.encodeBase58(randomBytes(32));
  const instructions = [S.computeUnitLimit(40000), S.computeUnitPrice(50000), ourCreate, ourTransfer];
  const message = S.compileMessage({ payer: owner, blockhash, instructions });
  const decoded = kit.getCompiledTransactionMessageDecoder().decode(message);
  const back = kit.decompileTransactionMessage(decoded);
  check('kit reads the fee payer back', back.feePayer.address, owner);
  check('kit reads the blockhash back', back.lifetimeConstraint.blockhash, blockhash);
  const roleOf = (k) => (k.signer ? (k.writable ? kit.AccountRole.WRITABLE_SIGNER : kit.AccountRole.READONLY_SIGNER) : (k.writable ? kit.AccountRole.WRITABLE : kit.AccountRole.READONLY));
  // The roles kit reports are the merged ones, so compare against our keys merged the same way.
  const merged = new Map();
  for (const ix of instructions) for (const k of ix.keys) {
    const prior = merged.get(k.address) || { signer: false, writable: false };
    merged.set(k.address, { signer: prior.signer || k.signer || k.address === owner, writable: prior.writable || k.writable || k.address === owner });
  }
  let sameIx = back.instructions.length === instructions.length;
  back.instructions.forEach((ix, i) => {
    const want = instructions[i];
    if (ix.programAddress !== want.programId || norm(new Uint8Array(ix.data || [])) !== norm(want.data)) sameIx = false;
    const accounts = ix.accounts || [];
    if (accounts.length !== want.keys.length) sameIx = false;
    accounts.forEach((a, j) => { if (a.address !== want.keys[j].address || a.role !== roleOf(merged.get(a.address))) sameIx = false; });
  });
  checkThat('kit decompiles the same four instructions, accounts and roles', sameIx);
  check('the payer is the only signer', S.messageSigners(message), [owner]);
  // A transaction kit compiles from the same instructions has the same accounts in the header.
  const kitMessage = kit.pipe(kit.createTransactionMessage({ version: 'legacy' }),
    (m) => kit.setTransactionMessageFeePayer(kit.address(owner), m),
    (m) => kit.setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 1n }, m),
    (m) => kit.appendTransactionMessageInstructions([...instructions.map((ix) => ({ programAddress: kit.address(ix.programId), accounts: ix.keys.map((k) => ({ address: kit.address(k.address), role: roleOf(k) })), data: ix.data }))], m));
  const kitCompiled = kit.compileTransactionMessage(kitMessage);
  check('header counts match kit\'s compiler', [decoded.header.numSignerAccounts, decoded.header.numReadonlySignerAccounts, decoded.header.numReadonlyNonSignerAccounts],
    [kitCompiled.header.numSignerAccounts, kitCompiled.header.numReadonlySignerAccounts, kitCompiled.header.numReadonlyNonSignerAccounts]);
  check('the same set of accounts as kit\'s compiler', [...decoded.staticAccounts].sort(), [...kitCompiled.staticAccounts].sort());

  // Wire form, unsigned and signed.
  const unsigned = S.wireTransaction(message);
  const unsignedTx = kit.getTransactionDecoder().decode(unsigned);
  check('an unsigned wire transaction has one empty slot for the payer', Object.keys(unsignedTx.signatures), [owner]);
  checkThat('the empty slot is null to kit', unsignedTx.signatures[owner] === null || unsignedTx.signatures[owner] === undefined || Array.from(unsignedTx.signatures[owner]).every((b) => b === 0));
  const signature = new Uint8Array(crypto.sign(null, message, keyPair.privateKey));
  const signed = S.wireTransaction(message, [signature]);
  const signedTx = kit.getTransactionDecoder().decode(signed);
  check('the signed wire transaction carries the signature', Array.from(signedTx.signatures[owner]), Array.from(signature));
  checkThat('kit verifies the signature over the message bytes', await kit.verifySignature(await crypto.webcrypto.subtle.importKey('raw', rawPublic, 'Ed25519', true, ['verify']), signature, new Uint8Array(signedTx.messageBytes)));
  throws('a message without a blockhash is refused', () => S.compileMessage({ payer: owner, blockhash: '', instructions }), /blockhash/);
  check('compact lengths: 0, 127, 128, 16383, 16384', [0, 127, 128, 16383, 16384].map((n) => Array.from(S.compactLength(n))), [[0], [127], [128, 1], [255, 127], [128, 128, 1]]);
  check('and back', [0, 127, 128, 16383, 16384].map((n) => S.readCompactLength(S.compactLength(n), 0).value), [0, 127, 128, 16383, 16384]);

  // ---------------------------------------------------------------- amounts
  check('unitsOf 1,800,000 OTT at 6 decimals', S.unitsOf('1800000', 6), 1800000000000n);
  check('unitsOf a fraction', S.unitsOf('0.5', 6), 500000n);
  throws('unitsOf refuses more places than the token has', () => S.unitsOf('0.0000001', 6), /more decimal places/);
  check('tokensOf drops trailing zeros', [S.tokensOf(1800000000000n, 6), S.tokensOf(1500000n, 6), S.tokensOf(1n, 6)], ['1800000', '1.5', '0.000001']);

  // ---------------------------------------------------------------- reading transactions
  const A = owner, B = S.encodeBase58(randomBytes(32));
  const tx = {
    meta: {
      err: null, fee: 5000, preBalances: [1000000, 0, 2039280, 1], postBalances: [994920, 0, 2039280, 1],
      preTokenBalances: [{ accountIndex: 1, mint, owner: A, uiTokenAmount: { amount: '2500000000000', decimals: 6 } }],
      postTokenBalances: [{ accountIndex: 1, mint, owner: A, uiTokenAmount: { amount: '700000000000', decimals: 6 } },
        { accountIndex: 2, mint, owner: S.INCINERATOR, uiTokenAmount: { amount: '1800000000000', decimals: 6 } },
        { accountIndex: 3, mint: S.MINTS.usdc, owner: B, uiTokenAmount: { amount: '5', decimals: 6 } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: A, signer: true, writable: true }, { pubkey: source }, { pubkey: dest }, { pubkey: B }] } },
  };
  check('token changes for one mint, a missing side read as zero', S.tokenChanges(tx, mint), [
    { account: source, owner: A, pre: 2500000000000n, post: 700000000000n, programId: null },
    { account: dest, owner: S.INCINERATOR, pre: 0n, post: 1800000000000n, programId: null }]);
  check('lamports paid by the fee payer', S.lamportsChange(tx, A), -5080n);
  check('an account not in the transaction has no change', S.lamportsChange(tx, S.INCINERATOR), null);
  check('the fee payer is the first key', S.feePayer(tx), A);
  check('a json-encoded v0 transaction includes its lookup-table addresses', S.accountKeys({ transaction: { message: { accountKeys: [A] } }, meta: { loadedAddresses: { writable: [B], readonly: [dest] } } }), [A, B, dest]);
  check('a failed transaction did not succeed', S.succeeded({ meta: { err: { InstructionError: [0, 'x'] } } }), false);

  // ---------------------------------------------------------------- RPC rotation
  const answers = [];
  const fake = (script) => async (url) => {
    answers.push(url);
    const next = script[url].shift();
    if (next instanceof Error) throw next;
    return { ok: next.status ? next.status < 400 : true, status: next.status || 200, json: async () => next.body };
  };
  let rpc = S.createRpc(['https://a.test', 'https://b.test'], { pauseMs: 0, fetchImpl: fake({
    'https://a.test': [new Error('socket hang up')], 'https://b.test': [{ body: { result: 42 } }] }) });
  check('a failed endpoint hands over to the next', await rpc('getSlot', []), 42);
  rpc = S.createRpc(['https://a.test', 'https://b.test'], { pauseMs: 0, fetchImpl: fake({
    'https://a.test': [{ body: { result: null } }], 'https://b.test': [{ body: { result: { slot: 1 } } }] }) });
  check('one node\'s null is not believed while another has the answer', await rpc('getTransaction', ['x']), { slot: 1 });
  rpc = S.createRpc(['https://a.test', 'https://b.test'], { pauseMs: 0, fetchImpl: fake({
    'https://a.test': [{ body: { result: null } }], 'https://b.test': [{ body: { result: null } }] }) });
  check('a null every node agrees on is an answer', await rpc('getTransaction', ['x']), null);
  rpc = S.createRpc(['https://a.test'], { pauseMs: 0, rounds: 2, fetchImpl: fake({
    'https://a.test': [{ status: 429, body: { error: { message: 'rate limited' } } }, { body: { error: { code: -32602, message: 'invalid' } } }] }) });
  let rpcError = null;
  try { await rpc('getSlot', []); } catch (e) { rpcError = e.message; }
  check('when every attempt fails the call says so', rpcError, 'getSlot failed on every Solana endpoint: invalid');

  console.log(failures ? `\n${failures} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
