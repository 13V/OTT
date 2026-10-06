'use strict';
/* Solana identity only. Login tokens stay in page memory and never authorize EVM credit or purchases. */
(function () {
  let session = null;
  let generation = 0;
  let expiryTimer = null;
  let pendingAccount = null;
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
    clearTimeout(expiryTimer);
    const token = session?.token;
    session = null;
    pendingAccount = null;
    changed();
    return revoke(token);
  }
  function state() {
    if (!session || session.expiresAt <= Date.now() || !current(session.account.address)) return null;
    return { account: { ...session.account }, expiresAt: session.expiresAt };
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
      session = { token: result.token, account: result.account, expiresAt: result.expiresAt };
      pendingAccount = null;
      expiryTimer = setTimeout(() => { void reset(); }, result.expiresAt - Date.now());
      changed();
      return { ...result.account };
    } finally {
      if (attempt === generation && pendingAccount === address) { pendingAccount = null; changed(); }
    }
  }
  window.OTTSolanaLogin = { login, reset, state, pending: address => pendingAccount === address,
    onChange(listener) { listeners.add(listener); } };
})();
