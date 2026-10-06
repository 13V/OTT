'use strict';
/* Solana identity only. Login tokens stay in page memory and never authorize EVM credit or purchases. */
(function () {
  let session = null;
  let generation = 0;
  let expiryTimer = null;
  let pendingAccount = null;
  let linking = false;
  let unlinking = false;
  let linkRevision = 0;
  const listeners = new Set();
  const current = address => {
    const wallet = window.OTTWallet?.state();
    return wallet?.chain === 'solana' && wallet.accounts[0] === address;
  };
  const changed = () => listeners.forEach(listener => listener());
  async function api(body) {
    const url = window.OTTClientConfig.apiUrl('./api/auth');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
      const result = await response.json();
      if (!response.ok || result?.ok !== true) throw new Error(result?.error || 'Solana sign-in is unavailable. Try again.');
      return result;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Sign-in timed out. Please try again.');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function revoke(token) {
    if (token) return api({ action: 'logout', token }).catch(() => {});
    return Promise.resolve();
  }
  function reset() {
    generation++;
    linkRevision++;
    clearTimeout(expiryTimer);
    const token = session?.token;
    session = null;
    pendingAccount = null;
    changed();
    return revoke(token);
  }
  function state() {
    if (!session || session.expiresAt <= Date.now() || !current(session.account.address)) return null;
    return { account: { ...session.account }, expiresAt: session.expiresAt,
      linkedWallet: session.linkedWallet ? { ...session.linkedWallet } : null };
  }
  function linkValue(value) {
    if (value === undefined || value === null) return null;
    if (value.chain !== 'evm' || value.chainId !== 4663 || typeof value.address !== 'string'
      || !/^0x[0-9a-f]{40}$/.test(value.address) || /^0x0{40}$/.test(value.address)) throw new Error('OTT returned an invalid linked wallet.');
    return { address: value.address, chain: 'evm', chainId: 4663 };
  }
  function base64(bytes, min, max) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < min || bytes.byteLength > max) throw new Error('Your wallet returned an invalid sign-in response.');
    return btoa(Array.from(bytes, value => String.fromCharCode(value)).join(''));
  }
  async function login(address, isCurrent = () => true) {
    // Clear any previous identity before starting a new approval.
    await reset();
    const attempt = generation;
    const valid = () => attempt === generation && current(address) && isCurrent();
    if (!valid()) throw new Error('Your wallet changed. Sign in again with the selected account.');
    pendingAccount = address;
    changed();
    try {
      const uri = location.origin + location.pathname;
      const challenge = await api({ action: 'challenge', address, domain: location.host, uri });
      if (!valid()) throw new Error('Your wallet changed. Sign in again with the selected account.');
      const input = challenge.input;
      if (!input || input.address !== address || input.domain !== location.host || input.uri !== uri
        || input.version !== '1' || input.chainId !== 'solana:mainnet'
        || input.statement !== 'Sign in to OTT. This does not move funds.'
        || !/^[a-zA-Z0-9]{8,128}$/.test(input.nonce || '') || typeof challenge.challengeId !== 'string'
        || !Number.isFinite(Date.parse(input.issuedAt)) || !Number.isFinite(Date.parse(input.expirationTime)) || Date.parse(input.expirationTime) <= Date.now()
        || Date.parse(input.expirationTime) > Date.now() + 6 * 60 * 1000) {
        throw new Error('OTT returned an invalid sign-in request. Please try again.');
      }
      const output = await window.OTTWallet.request({ method: 'solana_signIn', params: input });
      if (!valid() || output.address !== address) throw new Error('Your wallet changed during approval. Sign in again.');
      if (output.signatureType && output.signatureType !== 'ed25519') throw new Error('Your wallet returned an unsupported signature.');
      const result = await api({ action: 'verify', address, challengeId: challenge.challengeId,
        signedMessage: base64(output.signedMessage, 1, 4096), signature: base64(output.signature, 64, 64), signatureType: 'ed25519' });
      if (!valid()) { await revoke(result.token); throw new Error('Your wallet changed during sign-in. Sign in again.'); }
      if (result.account?.address !== address || result.account.chain !== 'solana' || result.account.verified !== true
        || result.account.credit !== 0 || result.account.eligible !== false || typeof result.token !== 'string'
        || result.token.length < 32 || result.token.length > 256 || !Number.isFinite(result.expiresAt)
        || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 31 * 60 * 1000) {
        await revoke(result.token);
        throw new Error('OTT could not confirm this account. Please try again.');
      }
      let linkedWallet;
      try { linkedWallet = linkValue(result.linkedWallet); }
      catch (error) { await revoke(result.token); throw error; }
      session = { token: result.token, account: { address, chain: 'solana', verified: true, credit: 0, eligible: false }, expiresAt: result.expiresAt, linkedWallet };
      pendingAccount = null;
      expiryTimer = setTimeout(() => { void reset(); }, result.expiresAt - Date.now());
      changed();
      return { ...result.account };
    } finally {
      if (attempt === generation && pendingAccount === address) { pendingAccount = null; changed(); }
    }
  }
  async function refreshLink() {
    if (linking || unlinking) throw new Error('Finish the current wallet link change before refreshing its status.');
    const selected = session, attempt = generation, revision = ++linkRevision;
    if (!state()) throw new Error('Sign in with Solana before managing a linked wallet.');
    const result = await api({ action: 'link', token: selected.token });
    if (attempt !== generation || selected !== session || !state()) throw new Error('Your wallet changed. Sign in again.');
    if (revision !== linkRevision) return state()?.linkedWallet || null;
    const next = linkValue(result.linkedWallet);
    const updated = next?.address !== session.linkedWallet?.address;
    session.linkedWallet = next;
    if (updated) changed();
    return next ? { ...next } : null;
  }
  function evmLinkMessage(input, evmAddress) {
    return ['OT+T — link wallets', 'Purpose: Link accounts only; no funds, redemption, or installation-code access.',
      'Site: ' + input.domain, 'URI: ' + input.uri, 'Solana Wallet: ' + input.address,
      'Robinhood Chain Wallet: ' + evmAddress, 'Chain ID: 4663', 'Nonce: ' + input.nonce,
      'Issued At: ' + input.issuedAt, 'Expiration Time: ' + input.expirationTime].join('\n');
  }
  async function linkWallet({ transport = 'auto', isCurrent = () => true, progress = () => {} } = {}) {
    if (linking || unlinking) throw new Error('Finish the current wallet link change before starting another.');
    if (!state()) throw new Error('Sign in with Solana before linking a holder wallet.');
    linking = true;
    linkRevision++;
    const selected = session, attempt = generation;
    const identity = () => selected === session && attempt === generation && !!state();
    const valid = () => identity() && isCurrent();
    let signer;
    try {
      progress('Choose your Robinhood Chain wallet.');
      signer = await window.OTTWallet.evmLinkSigner({ transport });
      if (!valid()) throw new Error('Wallet linking was cancelled or your account changed.');
      const evmAddress = signer.address;
      if (!/^0x[0-9a-f]{40}$/.test(evmAddress)) throw new Error('The holder wallet address is invalid.');
      const uri = location.origin + location.pathname;
      const challenge = await api({ action: 'link-challenge', token: selected.token, evmAddress, domain: location.host, uri });
      if (!valid()) throw new Error('Wallet linking was cancelled or your account changed.');
      const input = challenge.solanaInput;
      if (!input || input.address !== selected.account.address || input.domain !== location.host || input.uri !== uri
        || input.statement !== 'Link this Solana account to Robinhood Chain wallet ' + evmAddress + ' on OTT. This does not move funds.'
        || input.version !== '1' || input.chainId !== 'solana:mainnet' || !/^[a-zA-Z0-9]{8,128}$/.test(input.nonce || '')
        || !/^[a-f0-9]{48}$/.test(challenge.challengeId || '') || !Number.isFinite(Date.parse(input.issuedAt))
        || !Number.isFinite(Date.parse(input.expirationTime)) || Date.parse(input.expirationTime) <= Date.now()
        || Date.parse(input.expirationTime) > Date.now() + 6 * 60 * 1000 || challenge.evmMessage !== evmLinkMessage(input, evmAddress)) {
        throw new Error('OTT returned an invalid wallet-link request.');
      }
      progress('Approve the link message in Phantom.');
      const proof = await window.OTTWallet.request({ method: 'solana_signIn', params: input });
      if (!valid() || proof.address !== selected.account.address) throw new Error('Your Solana wallet changed during approval.');
      progress('Approve the link message in your Robinhood Chain wallet.');
      const evmSignature = await signer.sign(challenge.evmMessage);
      if (!valid()) throw new Error('Wallet linking was cancelled or your account changed.');
      progress('Verifying both wallet approvals…');
      const result = await api({ action: 'link-verify', token: selected.token, challengeId: challenge.challengeId,
        addressSOL: selected.account.address, evmAddress, signedMessage: base64(proof.signedMessage, 1, 4096),
        signature: base64(proof.signature, 64, 64), signatureType: 'ed25519', evmSignature });
      if (!identity()) throw new Error('Your account changed while the link was being verified. Check the link after signing in again.');
      const linked = linkValue(result.linkedWallet);
      if (linked?.address !== evmAddress) throw new Error('OTT could not confirm the requested wallet link. Refresh its status.');
      session.linkedWallet = linked;
      linkRevision++;
      changed();
      return { ...linked };
    } finally { linking = false; await signer?.release(); }
  }
  async function unlinkWallet() {
    if (linking || unlinking) throw new Error('Finish the current wallet link change before unlinking.');
    const selected = session, attempt = generation;
    if (!state()) throw new Error('Sign in with Solana before unlinking a holder wallet.');
    unlinking = true;
    linkRevision++;
    try {
      const result = await api({ action: 'unlink', token: selected.token });
      if (attempt !== generation || selected !== session || !state()) throw new Error('Your wallet changed. Check the link after signing in again.');
      if (result.linkedWallet !== null) throw new Error('OTT could not confirm unlinking. Refresh the linked wallet status.');
      session.linkedWallet = null;
      linkRevision++;
      changed();
    } finally { unlinking = false; }
  }
  window.OTTSolanaLogin = { login, reset, state, pending: address => pendingAccount === address,
    refreshLink, linkWallet, unlinkWallet, onChange(listener) { listeners.add(listener); } };
})();
