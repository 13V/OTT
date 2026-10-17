'use strict';
/**
 * whatever.fun — /api/redeem
 *
 * The one server-side piece of the Data page: turn a wallet's standing allowance into a real eSIM.
 *
 * Membership is the subscription. Every week, 80% of the pump.fun creator fees collected the week
 * before becomes this week's data budget, and a member's allowance is its capped share of that
 * budget by the OTT it held at the Monday snapshot — written per-week into
 * site/data/allowances.json by the indexer (scripts/allowances.js), read here over HTTP. Trading
 * earns nothing; only membership and holding, only for the week you hold it in.
 * Credit is in dollars, not gigabytes, because the reseller's wholesale price for a gigabyte runs
 * from $0.62 in Europe to $4.60 worldwide and a ledger in gigabytes would let every wallet spend a
 * cheap one on a dear one. A package costs its priceUsd from site/config/esim.json; what a wallet
 * has redeemed is the sum of the prices of the packages it holds this week.
 * Everything else about the product is static (allowances.json is written by the indexer, the
 * page reads it) — this exists only because handing out a profile costs money and so needs a
 * signature check and a provider secret, neither of which can live in a browser.
 *
 *   GET  /api/redeem?address=<base58>   this wallet's standing for the current week — what it
 *                                  holds, its allowance, what it has redeemed and can still redeem,
 *                                  this week's orders and the last three weeks' — without codes.
 *                                  Balances are public (they are derived from public chain data);
 *                                  an activation code is a one-time thing, and whoever installs it
 *                                  first has the data. A Solana address is case-sensitive base58
 *                                  and is used exactly as sent.
 *   POST /api/redeem               { address, message, signature }              -> the same, with codes
 *   POST /api/redeem               { address, message, signature, packageCode, n } -> a new order,
 *                                  where n is how many orders the caller has seen THIS WEEK: its
 *                                  own idea of which slot it is filling. See "idempotence" below.
 *
 * There is no database of wallets. The provider is the ledger: a wallet's Nth redemption in week W
 * always carries transactionId "ott-" + keccak(address:W:n)[0..32], so "how many has this wallet
 * redeemed this week" is answered by asking the provider find(id) for n = 0, 1, 2… until one is
 * missing, and "redeem one more" is an order under the next id. Scoping the id by week is what
 * makes an expiring allowance work at all: every Monday the sequence starts over at n=0 for every
 * wallet, with nothing to reset, because last week's ids simply stop being the ones this week's
 * redemptions look under. Past orders are not deleted or affected in any way — they are just found
 * under last week's ids instead, which is what `history` is for (see below). (The eSIM Access
 * provider answers find() from the reseller's own order history; the wholesale one from a record it
 * keeps per id, because wholesale keeps none — see _lib/providers/wholesale.js and _lib/store.js.) Two
 * requests racing for the same id resolve at the provider, which refuses a duplicate
 * transactionId — so the worst case is one of them being told to try again, never a second eSIM.
 * Each week's lookup loop is capped at 200 so a whale cannot turn a GET into hundreds of upstream
 * calls indefinitely; a wallet's allowance, being a share of one week's budget, makes 200 orders in
 * a single week implausible on its own, but the cap holds regardless.
 *
 * Sign-in is the wallet's ed25519 signature (signMessage) over a short labelled message, good for
 * ten minutes, which proves control of the wallet without a session, a cookie, or a nonce store —
 * and which names the action it authorises, so it proves rather more than that. A redemption's
 * message carries the plan and the slot; a read's carries neither and cannot redeem. See
 * checkMessage() for why that is the line that matters and binding the site alone would not have
 * been.
 *
 * Idempotence: a redeem names the slot it means to fill this week, `n`. If that slot is already
 * filled with the same package, the existing order comes back and nothing is minted — so a
 * retried, replayed or double-clicked POST is the same POST. If the slot is ahead of the ledger, or
 * filled with a different package, the caller's picture is stale and it is told to reload (409). A
 * replayed signature therefore cannot redeem more than the request it was made for.
 *
 * Membership (docs/membership.md): a wallet joins by sending about $5 of OTT to the incinerator's
 * token account. The standing reports whether it is a member, this week's join amount, and whether
 * the app may offer the join right now (`membership.enrolment`). A member claims one welcome eSIM
 * with
 *   POST /api/redeem  { address, message, signature, welcome: true, packageCode, joinTx? }
 * under its own fixed id (welcomeIdFor), outside every week, paid from the reserve. Membership is
 * proven by the weekly ledger, or, for a join newer than the ledger, by that transaction itself,
 * read from Solana (_lib/rpc.js) and judged by the same rule the ledger uses.
 *
 * Config is explicitly included in Vercel's function bundles by site/vercel.json and normally
 * read from disk (fast, no fetch). ESIM_CONFIG_URL can select a different reviewed config, and
 * an HTTP fallback covers a missing bundled file. allowances.json is only
 * ever fetched over HTTP: it is regenerated by the indexer far more often than the function is
 * deployed, and a bundled copy would be stale from the first commit — and, now, it carries a
 * `week` of its own that this file checks against the clock on every request (see "staleness").
 */
const fs = require('fs');
const path = require('path');
const solanaAuth = require('./_lib/solana-auth');
const S = require('../solana.js');
const { provider: chooseProvider } = require('./_lib/providers');
const { weekOf, weekEnd: weekEndOf } = require('./_lib/week');
const { allowRequestOrigin, isProduction } = require('./_lib/request-origin');
const { redemptionsEnabled } = require('./_lib/redemption-policy');
const { redactError, orderSecrets } = require('./_lib/redact');
const rules = require('./_lib/membership');
const chainRpc = require('./_lib/rpc');

const MESSAGE_HEAD = 'OT+T';
// What each kind of signature authorises. The first line is what tells them apart, so a read can
// never place an order and a weekly redemption can never claim a welcome eSIM, or the reverse.
const HEADS = {
  redeem: MESSAGE_HEAD + ' — authorise a data redemption',
  read: MESSAGE_HEAD + ' — show my eSIM codes',
  welcome: MESSAGE_HEAD + ' — claim my welcome eSIM',
};
const ACTION_NAMES = { redeem: 'a redemption', read: 'a read', welcome: 'a welcome eSIM claim' };
const SIGNIN_WINDOW_S = 10 * 60;
// Allow brief client clock drift without giving a future timestamp another ten minutes.
const SIGNIN_FUTURE_SKEW_S = 30;
const MAX_ORDERS = 200;
const HISTORY_WEEKS = 3;
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;
// A public GET costs this deployment five round trips to the store — one for this week's orders,
// three for the weeks of history, one for the wallet's eSIMs — for any address at all, invented
// ones included. Answering the same address twice inside this window from memory is what stops
// that being an amplifier: a page load is one read, a loop is still one read.
const STANDING_TTL_MS = 10 * 1000;
// And a ceiling on how many DISTINCT addresses one warm instance will do that work for per
// minute, so the same loop cannot simply vary the address. Generous enough that a real burst of
// holders never meets it; serverless means this is per instance, which makes it a brake rather
// than a gate, and the brake is the part worth having.
const STANDING_BURST = 240;
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'esim.json');

// ---------------------------------------------------------------------------------------------
// Fetching with a short memory. One cache for both files, keyed by URL, so a burst of GETs from
// one page load costs the deployment one static-file read a minute rather than one per request.
// ---------------------------------------------------------------------------------------------
const cache = new Map(); // url -> { at, value }
const standingCache = new Map(); // address:week -> { at, body }
let burst = { minute: 0, count: 0 };

/** True while this instance is still willing to compute a standing it has not got cached. */
function withinBurst(nowMs) {
  const minute = Math.floor(nowMs / 60000);
  if (burst.minute !== minute) burst = { minute, count: 0 };
  burst.count += 1;
  return burst.count <= STANDING_BURST;
}

/**
 * Error context can be public; credentials and installation data cannot. Scrub saved order
 * values as well as recognizable new activation codes/invoices and deployment secrets before
 * truncating the message, including on unsigned reads.
 */
function scrubbed(message, order) {
  return redactError(message, { privateValues: orderSecrets(order) });
}

async function fetchJson(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    const value = await res.json();
    cache.set(url, { at: Date.now(), value });
    return value;
  } finally { clearTimeout(timer); }
}

function selfUrl(p) {
  // Where this deployment serves its own static files from. VERCEL_PROJECT_PRODUCTION_URL is the
  // project's production domain and is preferred, because VERCEL_URL is the *deployment's* host —
  // and a project with deployment protection turned on answers 401 there, even to itself, which
  // is exactly how this was found. Locally, or on another host, the explicit env overrides
  // (ESIM_CONFIG_URL, ALLOWANCES_URL) are the only way to say where the files are.
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (!host) throw new Error('no VERCEL_PROJECT_PRODUCTION_URL or VERCEL_URL');
  return 'https://' + host + p;
}

async function readConfig() {
  // An explicit URL wins over the bundled file so a test (or a staging deploy) can point at a
  // config that is not the one checked in — the same override the allowances have.
  if (process.env.ESIM_CONFIG_URL) return fetchJson(process.env.ESIM_CONFIG_URL);
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { /* fall through */ }
  return fetchJson(selfUrl('/config/esim.json'));
}

async function readAllowances() {
  return fetchJson(process.env.ALLOWANCES_URL || selfUrl('/data/allowances.json'));
}

/**
 * The pool, as scripts/treasury.js last measured it. Advisory, never a gate: it is up to half an
 * hour old, and a wallet that can in fact be paid must never be refused because a file was stale.
 * What it buys is honesty — a holder whose allowance the pool plainly cannot cover is told before
 * they press the button, rather than after, by a provider that could not pay.
 */
async function readTreasury() {
  // Defensive to the point of swallowing everything, selfUrl() included: this figure only ever
  // makes an answer more honest, and nothing about it is worth failing a redemption over.
  try { return await fetchJson(process.env.TREASURY_URL || selfUrl('/data/treasury.json')); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------------------------
// Small pure helpers.
// ---------------------------------------------------------------------------------------------
// A wallet is a canonical base58 Solana address. Launch addresses must also not be the all-zero
// key (the system program's), which is what an unset Pubkey looks like.
const isAddress = (a) => S.isAddress(a);
const isLaunchAddress = S.isLaunchAddress;

/**
 * The coin counts as launched when esim.json names the chain, the mint, the token program that
 * owns it, the treasury and the incinerator's token account for it (docs/membership.md). Anything
 * less, or anything malformed, is prelaunch. The rule is site/solana.js's, shared with the site.
 */
const launched = S.launchedConfig;
// Anything that becomes an href or an <img src> on the page is scheme-checked HERE as well as
// where it was written, so a record stored before the provider checked — or by a provider that
// never did — cannot put a "javascript:" link on the page that is showing a wallet's codes.
const safeHref = (u) => (/^https:\/\//i.test(String(u || '')) ? String(u) : '');
const safeImg = (u) => (/^(data:image\/|https:\/\/)/i.test(String(u || '')) ? String(u) : '');
const round6 = (x) => Math.round(x * 1e6) / 1e6;

// The order ids (fixed forever; see _lib/order-ids.js): a wallet's Nth redemption in week W, and
// its one welcome order.
const { transactionIdFor, welcomeIdFor } = require('./_lib/order-ids');

/**
 * What a past order cost, from the catalogue. The provider's record carries the package (as its
 * slug, or its code) but not the price paid, so the price is looked up. A package that has since
 * left the catalogue is charged at the dearest price still in it — the conservative reading, since
 * the alternative is credit that can be spent twice.
 */
function priceOf(order, config) {
  // What this order was actually charged, when the provider wrote it down. It is the only figure
  // that cannot move afterwards: the catalogue is regenerated from wholesale's live prices whenever
  // scripts/catalogue.js runs, and pricing a past order from the current catalogue means a
  // mid-week refresh silently rewrites what a wallet has already spent — a package that got
  // cheaper hands back allowance the pool has already paid out, one that got dearer takes away
  // allowance nobody spent. Neither is a thing a week's budget can absorb.
  const paid = Number(order && order.priceUsd);
  if (Number.isFinite(paid) && paid > 0) return paid;
  const code = String(order && order.packageCode || '');
  const pkg = config.packages.find((p) => p && (p.code === code || p.packageCode === code));
  if (pkg && Number.isFinite(Number(pkg.priceUsd))) return Number(pkg.priceUsd);
  // Nothing recorded and nothing in the catalogue: charge the dearest thing still sold, since the
  // alternative is credit that can be spent twice.
  return config.packages.reduce((m, p) => Math.max(m, Number(p && p.priceUsd) || 0), 0);
}

/** Every order the provider holds for this wallet in `week`, in order, stopping at the first gap. */
async function pastOrders(prov, address, week) {
  const orders = [];
  for (let n = 0; n < MAX_ORDERS; n++) {
    const o = await prov.find(transactionIdFor(address, week, n));
    if (!o) break;
    orders.push(Object.assign({ n, week }, o));
  }
  return orders;
}

/**
 * The previous HISTORY_WEEKS weeks' orders, most recent week first — display only. An eSIM already
 * issued does not stop existing when the week rolls and its allowance expires, so a wallet's past
 * redemptions stay visible even once they no longer count against anything. Each week is its own
 * pastOrders() loop with its own MAX_ORDERS cap, so a GET costs at most (1 + HISTORY_WEEKS) capped
 * loops to the provider, never an unbounded one.
 */
async function historyOrders(prov, address, week) {
  const out = [];
  for (let i = 1; i <= HISTORY_WEEKS; i++) out.push(...(await pastOrders(prov, address, week - i)));
  return out;
}

/**
 * An order as the wire shows it. With `codes` the QR, the activation code, the manual-install pair
 * and the install links are included; without, they are blank — a GET by address is public, and
 * the codes go only to the wallet that signed for them.
 */
/**
 * An eSIM as the wire shows it. The codes are withheld on an unsigned read, exactly as an order's
 * are: the QR and the activation string are the eSIM, and anyone holding them can install it.
 */
function publicSim(sim, { codes = false } = {}) {
  const c = (v) => (codes ? v || '' : '');
  return {
    iccid: sim.iccid || '', slug: sim.slug || '', createdAt: sim.createdAt || null,
    qrCodeUrl: safeImg(c(sim.qrCodeUrl)), ac: c(sim.ac), manualCode: c(sim.manualCode),
    smdpAddress: c(sim.smdpAddress), matchingId: c(sim.matchingId),
    appleInstallUrl: safeHref(c(sim.appleInstallUrl)), androidInstallUrl: safeHref(c(sim.androidInstallUrl)),
    codes,
  };
}

function publicOrder(o, config, { codes = false } = {}) {
  const c = (v) => (codes ? v || '' : '');
  return {
    n: o.n, week: o.week, transactionId: o.transactionId, packageCode: o.packageCode, priceUsd: priceOf(o, config),
    qrCodeUrl: safeImg(c(o.qrCodeUrl)), ac: c(o.ac), iccid: o.iccid || '', createdAt: o.createdAt || null,
    pending: !!o.pending,
    // Which eSIM this bundle is on, and whether it queued on one already installed. A top-up
    // carries no code of its own — the profile it joined is the one the holder already scanned.
    topupOf: o.topupOf || '', toppedUp: !!o.toppedUp,
    // What a Lightning-paid provider adds: where a pending order stands (invoiced, paid, done), the
    // other ways into the phone besides the QR, and one line of why if it is stuck.
    stage: o.stage || o.step || (o.pending ? 'pending' : 'done'),
    smdpAddress: c(o.smdpAddress), matchingId: c(o.matchingId),
    appleInstallUrl: safeHref(c(o.appleInstallUrl)), androidInstallUrl: safeHref(c(o.androidInstallUrl)),
    note: o.error ? scrubbed(o.error, o) : '',
    codes,
  };
}

/**
 * The sign-in message, checked line by line. Returns a short reason or null. The address in the
 * message must be exactly the one in the request so a signature over one wallet's message cannot
 * be submitted with another wallet's address (the signature check would catch it anyway; this
 * gives a better error and costs nothing).
 */
/**
 * The hosts this deployment will accept a signature for. Vercel names the production host and the
 * deployment's own host in the environment; SIGNIN_HOST covers a custom domain. A deployment that
 * can name none of them skips the check only in development. Production refuses signatures
 * until the operator configures a known frontend host.
 */
function knownHosts() {
  return [process.env.SIGNIN_HOST, process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL]
    .map((h) => String(h || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase())
    .filter(Boolean);
}

/**
 * What the wallet signed, and whether it authorises the thing being asked for.
 *
 * The message used to be three opaque lines — a header, an address, a clock reading — which made
 * one signature a bearer token for that wallet's whole week: anything holding it could redeem any
 * package, at any slot, until the window closed. A page that talked a holder into signing that
 * exact string could relay it and take the eSIMs, walking it across slots to drain the allowance.
 *
 * Binding the site would not have stopped that on its own — whoever asks for the signature chooses
 * the string, so a phishing page can put our domain in it just as easily. What actually shrinks the
 * damage is binding the ACTION: a redemption's signature names the plan and the slot, so it
 * authorises that one order and nothing else, and a read's signature cannot redeem at all. The site
 * line stays because it is what gives a person reading their wallet prompt a chance to notice, and
 * because the server rejects one naming somewhere else.
 *
 * `want` is { action: 'redeem', packageCode, n }, { action: 'welcome', packageCode } or
 * { action: 'read' }.
 */
function checkMessage(message, address, nowS, want) {
  const lines = String(message || '').split('\n');
  if (!Object.hasOwn(HEADS, want.action)) return 'unknown signature action';
  if (lines[0] !== HEADS[want.action]) return 'this signature does not authorise ' + ACTION_NAMES[want.action];
  const field = (name) => {
    const line = lines.find((l) => l.startsWith(name + ': '));
    return line === undefined ? null : line.slice(name.length + 2);
  };
  const hosts = knownHosts();
  const site = String(field('Site') || '').toLowerCase();
  if (!site) return 'sign-in message names no site';
  if (!hosts.length && isProduction()) return 'sign-in host is not configured';
  if (hosts.length && !hosts.includes(site)) return 'sign-in message was signed for ' + site + ', not this site';
  if (field('Wallet') !== address) return 'sign-in message is for another address';
  if (want.action === 'redeem' || want.action === 'welcome') {
    if (field('Plan') !== String(want.packageCode)) return 'this signature authorises a different plan';
  }
  if (want.action === 'redeem') {
    if (field('Slot') !== String(want.n)) return 'this signature authorises a different order; sign again';
  }
  const issued = field('Issued');
  if (!/^\d{1,12}$/.test(String(issued))) return 'sign-in message has no timestamp';
  const age = nowS - Number(issued);
  if (age > SIGNIN_WINDOW_S || age < -SIGNIN_FUTURE_SKEW_S) return 'sign-in expired, sign again';
  // The slot restarts at zero each Monday. A signature from the last ten minutes of the old
  // week must not mint that slot again in the new one; the authenticated timestamp binds it.
  if (want.action === 'redeem' && weekOf(Number(issued)) !== weekOf(nowS)) return 'redemption was signed for another week; sign again';
  return null;
}

/** req.body is an object on Vercel (when the content-type said JSON), a string on some hosts, and absent on bare Node. */
async function readBody(req) {
  const checkSize = (size) => {
    if (size > MAX_BODY_BYTES) { const e = new Error('body too large'); e.tooLarge = true; throw e; }
  };
  if (req.body !== undefined && req.body !== null) {
    const parsed = typeof req.body === 'object';
    const text = parsed ? JSON.stringify(req.body) : String(req.body);
    checkSize(Buffer.byteLength(text, 'utf8'));
    return parsed ? req.body : JSON.parse(text);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    checkSize(size);
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function send(res, status, body) {
  // Origin permissions are checked once, before any configuration or provider work. Signed
  // installation details are never cached, including when a trusted frontend uses another host.
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
const fail = (res, status, error) => send(res, status, { ok: false, error });

// ---------------------------------------------------------------------------------------------
// Shared between GET and POST: where a wallet stands this week.
// ---------------------------------------------------------------------------------------------

/**
 * `week` is the current week (computed from the clock, never from the file). The allowances file
 * carries the week it was written FOR; when that does not match `week`, the file is stale — the
 * indexer has not run yet since the boundary — and every wallet's allowanceUsd (and so its
 * remainingUsd) is treated as 0 rather than let a wallet spend a week-old number. `tokens` and
 * `share` are holdings, not spending power, so they are still reported from whatever the file last
 * said even while stale — a wallet can see what it holds; it just cannot spend against it yet.
 *
 * A ledger about some other coin (the file written before esim.json's coin changed) counts as not
 * published at all: it is stale whatever its week, and none of its rows are this wallet's.
 */
async function standing(prov, config, allowances, address, week, treasury = null, { includeSims = true } = {}) {
  const about = ledgerAbout(config, allowances);
  const stale = !about || Number(allowances.week) !== week;
  const row = (about && rowOf(allowances.wallets, address)) || {};
  const tokens = String(row.tokens || '0');
  const share = Number(row.share) || 0;
  const allowanceUsd = stale ? 0 : round6(Number(row.allowanceUsd) || 0);
  const orders = await pastOrders(prov, address, week);
  const redeemedUsd = round6(orders.reduce((s, o) => s + priceOf(o, config), 0));
  const remainingUsd = round6(Math.max(0, allowanceUsd - redeemedUsd));
  const history = await historyOrders(prov, address, week);
  // The eSIMs themselves, which outlive any week: a bundle claimed in week 2958 queues on the
  // profile issued in 2957. A provider with no such notion (the reseller one) simply has none.
  let sims = [];
  if (includeSims && typeof prov.sims === 'function') {
    try { sims = await prov.sims(address); } catch (e) { sims = []; }
  }
  let holds = false;
  try { holds = BigInt(tokens) > 0n; } catch (e) { holds = false; }
  const poolRaw = Number(treasury && treasury.reseller && treasury.reseller.balanceUsd);
  const poolUsd = Number.isFinite(poolRaw) ? round6(poolRaw) : null;
  return {
    stale, week, weekEnd: weekEndOf(week), tokens, share, allowanceUsd, redeemedUsd, remainingUsd,
    orders, history, sims, holds, poolUsd,
  };
}

/**
 * A redemption signs for one order, not the wallet's full roster. Include public profile details,
 * but reveal installation codes only for the exact profile this order issued or topped up. A
 * pending order without an identifier, or a record naming conflicting profiles, grants none.
 * Never fatal: a new profile's codes also ride on the order itself.
 */
async function simsFor(prov, address, order) {
  if (typeof prov.sims !== 'function') return [];
  const issued = String(order && order.iccid || '');
  const target = String(order && order.topupOf || '');
  const authorized = issued && target && issued !== target ? '' : issued || target;
  try {
    return (await prov.sims(address)).map((x) => publicSim(x, {
      codes: !!authorized && String(x.iccid || '') === authorized,
    }));
  } catch (e) { return []; }
}

/** The standing as the wire shows it — the shape both GET and a signed read answer with. */
function standingBody(s, address, allowances, config, codes, membership = { configured: false }) {
  const fileWeek = Number(allowances && allowances.week);
  return {
    ok: true, address,
    week: s.week, weekEnd: s.weekEnd,
    // tokens are base units of the coin, at the ledger's decimals (null until the ledger is about
    // this coin); share is the fraction of the members' snapshot holdings.
    tokens: s.tokens, share: s.share, decimals: ledgerDecimals(config, allowances),
    allowanceUsd: s.allowanceUsd, redeemedUsd: s.redeemedUsd, remainingUsd: s.remainingUsd,
    stale: s.stale, allowancesWeek: Number.isFinite(fileWeek) ? fileWeek : null,
    // What the pool holds, so the page can say plainly when this week has promised more data than
    // there is money to buy — the one thing a holder cannot otherwise discover until the button
    // fails. null when the treasury file could not be read, which the page reads as "no idea"
    // rather than "nothing there".
    poolUsd: s.poolUsd,
    orders: s.orders.map((o) => publicOrder(o, config, { codes })),
    history: s.history.map((o) => publicOrder(o, config, { codes })),
    sims: (s.sims || []).map((x) => publicSim(x, { codes })),
    membership,
  };
}

// ---------------------------------------------------------------------------------------------
// Membership (docs/membership.md): join by sending OTT to the incinerator, one welcome eSIM, a
// capped weekly share.
// ---------------------------------------------------------------------------------------------

/** esim.json's membership rules, or null when membership is off or its block is malformed. */
function membershipRules(config) {
  try { return rules.membershipConfig(config); } catch (e) { return null; }
}

/** True when the weekly ledger is about the configured coin. Base58 is compared exactly. */
function ledgerAbout(config, allowances) {
  return !!allowances && typeof allowances === 'object' && isLaunchAddress(allowances.coin) && allowances.coin === config.coin;
}

/** The ledger's token decimals, but only when the ledger is about the configured coin. */
function ledgerDecimals(config, allowances) {
  if (!ledgerAbout(config, allowances)) return null;
  const decimals = Number(allowances.decimals);
  return Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : null;
}

/** The ledger's `membership` block, when the ledger is about the configured coin. */
function ledgerMembership(config, allowances) {
  if (ledgerDecimals(config, allowances) === null) return null;
  const lm = allowances.membership;
  return lm && typeof lm === 'object' && !Array.isArray(lm) ? lm : null;
}

// One wallet's row in one of the ledger's maps, or null. Own keys only: an address can never be
// "__proto__", but the lookup should not depend on that.
const rowOf = (map, address) => {
  const row = map && typeof map === 'object' && Object.hasOwn(map, address) ? map[address] : null;
  return row && typeof row === 'object' && !Array.isArray(row) ? row : null;
};
const unitsIn = (value) => (typeof value === 'string' && /^\d{1,40}$/.test(value) ? BigInt(value) : 0n);

/** This wallet's entry in the ledger's members list, or null. */
function ledgerMember(config, allowances, address) {
  return ledgerDecimals(config, allowances) === null ? null : rowOf(allowances.members, address);
}

/** The OTT (base units) the ledger has counted from this wallet: a member's total, or a partial join's. */
function ledgerBurned(config, allowances, address) {
  if (ledgerDecimals(config, allowances) === null) return 0n;
  const row = rowOf(allowances.members, address) || rowOf(allowances.joins, address);
  return row ? unitsIn(row.burned) : 0n;
}

/** The send that made a ledger member one, keeping only well-formed fields. */
function sinceOf(row) {
  const s = row && row.since;
  if (!s || typeof s !== 'object') return null;
  const at = Number(s.at), slot = Number(s.slot);
  return { at: Number.isSafeInteger(at) ? at : null, slot: Number.isSafeInteger(slot) ? slot : null, tx: S.isSignature(s.tx) ? s.tx : null };
}

/**
 * This week's join amount from the ledger: { week, burnTokens, burnUnits, priceUsd }, or null
 * unless the ledger is about this coin, is this week's, and carries an amount for this week that
 * agrees with itself: `burnTokens` (whole tokens) at the ledger's decimals is `burnUnits`, and
 * `requirements` records the same figure for the week, since that map is what a fresh join is
 * judged against.
 */
function currentRequirement(config, allowances, week) {
  const decimals = ledgerDecimals(config, allowances);
  const lm = ledgerMembership(config, allowances);
  if (decimals === null || !lm || Number(allowances.week) !== week) return null;
  const req = lm.requirement;
  if (!req || typeof req !== 'object' || Number(req.week) !== week) return null;
  const burnTokens = String(req.burnTokens || ''), burnUnits = String(req.burnUnits || '');
  if (!/^\d{1,30}$/.test(burnTokens) || !/^\d{1,40}$/.test(burnUnits)) return null;
  let units;
  try { units = rules.unitsOf(burnTokens, decimals); } catch (e) { return null; }
  if (units <= 0n || units !== BigInt(burnUnits) || rules.weekAmount(lm.requirements, week) !== units) return null;
  const priceUsd = Number(req.priceUsd);
  return { week, burnTokens, burnUnits, priceUsd: Number.isFinite(priceUsd) && priceUsd > 0 ? priceUsd : null };
}

/**
 * Whether the app may offer the join right now. A join can't be undone, so it is offered only when
 * this week's amount is known and a welcome eSIM can actually be bought: purchases are on, the
 * ledger is about the coin and is this week's, it carries this week's amount, the treasury reports
 * the pool funded, and the pool less what this week still owes members covers the dearest welcome
 * plan. The treasury file is up to half an hour old; this is a gate on the offer, and the order
 * itself still fails safely if the pool turns out short.
 */
function enrolmentOf(m, { config, allowances, week, requirement }, treasury) {
  if (!redemptionsEnabled()) return { open: false, reason: 'Joining opens when eSIM purchases are switched on.' };
  if (ledgerDecimals(config, allowances) === null) return { open: false, reason: 'Joining opens once the weekly ledger includes the coin.' };
  if (Number(allowances.week) !== week) return { open: false, reason: 'Joining reopens once this week’s ledger is published.' };
  if (!requirement) return { open: false, reason: 'This week’s join amount isn’t set yet. Try again shortly.' };
  const balance = Number(treasury && treasury.reseller && treasury.reseller.balanceUsd);
  const owed = Number(treasury && treasury.owedUsd);
  if (!treasury || treasury.reseller?.balanceUsd == null || treasury.owedUsd == null || !Number.isFinite(balance) || !Number.isFinite(owed)) {
    return { open: false, reason: 'The reserve that pays for welcome eSIMs cannot be confirmed right now.' };
  }
  if (treasury.status !== 'funded' || balance - owed < m.welcome.maxUsd) {
    return { open: false, reason: 'The reserve is too low to pay for a welcome eSIM right now. Try again after the next top-up.' };
  }
  return { open: true, reason: '' };
}

/** A welcome order as the wire shows it: an ordinary order, marked, and outside every week. */
function welcomeOrderOut(order, config, codes) {
  return Object.assign(publicOrder(Object.assign({}, order, { n: 0, week: null }), config, { codes }), { welcome: true });
}

/** The `membership` object that GET and a signed read both answer with. */
async function membershipOf(prov, config, allowances, address, week, treasury, { codes = false } = {}) {
  const m = membershipRules(config);
  if (!m) return { configured: false };
  const requirement = currentRequirement(config, allowances, week);
  const row = ledgerMember(config, allowances, address);
  const fileRow = ledgerAbout(config, allowances) ? rowOf(allowances.wallets, address) : null;
  const found = await prov.find(welcomeIdFor(address));
  return {
    configured: true,
    coin: config.coin, tokenProgram: config.tokenProgram, decimals: ledgerDecimals(config, allowances),
    burnOwner: m.burnOwner, burnAccount: m.burnAccount, burnUsd: m.burnUsd,
    requirement,
    burned: ledgerBurned(config, allowances, address).toString(),
    welcome: m.welcome, capMultiple: m.capMultiple,
    member: !!row,
    memberSince: row ? sinceOf(row) : null,
    sharing: Number(allowances && allowances.week) === week && !!fileRow && fileRow.member === true,
    welcomeOrder: found ? welcomeOrderOut(found, config, codes) : null,
    enrolment: enrolmentOf(m, { config, allowances, week, requirement }, treasury),
  };
}

/**
 * Whether `joinTx` makes `address` a member now, by the rule the ledger keeper applies
 * (docs/membership.md): a successful transaction the ledger has not read yet (newer than its
 * cursor), in which this wallet alone sent OTT to the incinerator's account, enough, with what the
 * ledger already counted from it, to reach the amount for that transaction's week. A transaction
 * the ledger has read was counted there already, so it adds nothing here.
 */
async function joinProvesMembership(config, m, allowances, address, joinTx) {
  const lm = ledgerMembership(config, allowances);
  if (!lm) return false;
  const tx = await chainRpc.getTransaction(joinTx);
  if (!tx || !S.succeeded(tx)) return false;
  const signature = tx.transaction && Array.isArray(tx.transaction.signatures) ? tx.transaction.signatures[0] : null;
  if (signature !== joinTx) return false;
  const cursorSlot = Number(lm.cursor && lm.cursor.slot);
  if (Number.isFinite(cursorSlot) && !(Number(tx.slot) > cursorSlot)) return false;
  const join = rules.joinFromTransaction(tx, { coin: config.coin, burnAccount: m.burnAccount, exclude: [config.treasury] });
  if (!join || join.skip || join.wallet !== address) return false;
  const need = rules.requirementFor(lm.requirements, join.at);
  return need !== null && ledgerBurned(config, allowances, address) + join.amount >= need;
}

/**
 * A signed welcome claim, already checked for shape and signature. The existing order comes back
 * for a repeat of the same plan; otherwise the wallet must be a member, by the ledger or by the
 * join transaction it names, and then the order is placed under the wallet's fixed welcome id.
 */
async function claimWelcome(res, { prov, config, m, allowances, address, pkg, joinTx }) {
  const transactionId = welcomeIdFor(address);
  const supplierPackage = pkg.packageCode || pkg.code;
  const place = pkg.slug || pkg.code;
  const recordedPackage = prov.name === 'wholesale' ? supplierPackage : place;
  const matchesOrder = (order) => order && order.packageCode === recordedPackage
    && (prov.name !== 'wholesale' || order.slug === place);
  const existing = await prov.find(transactionId);
  if (existing) {
    if (!matchesOrder(existing)) return fail(res, 409, 'your welcome eSIM has already been claimed');
    return send(res, 200, { ok: true, order: welcomeOrderOut(existing, config, true), sims: await simsFor(prov, address, existing), replayed: true });
  }
  if (!ledgerMember(config, allowances, address)) {
    if (!joinTx) return fail(res, 409, 'join OT+T first');
    if (!(await joinProvesMembership(config, m, allowances, address, joinTx))) return fail(res, 409, 'the join transaction was not found or did not send enough OTT');
  }
  const order = await prov.order({ transactionId, packageCode: supplierPackage, slug: place, code: pkg.code, priceUsd: Number(pkg.priceUsd), address });
  // Another claim for a different plan can win the id while this one waits.
  if (!matchesOrder(order)) return fail(res, 409, 'your welcome eSIM has already been claimed');
  return send(res, 200, { ok: true, order: welcomeOrderOut(order, config, true), sims: await simsFor(prov, address, order) });
}

module.exports = async (req, res) => {
  if (!allowRequestOrigin(req, res, ['GET', 'POST'])) return;
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    return fail(res, 405, 'method not allowed');
  }

  try {
    const config = await readConfig().catch(() => null);
    if (!config || !Array.isArray(config.packages)) return fail(res, 503, 'data config unavailable');
    // An empty, zero or malformed launch address is not a launched configuration. Everything
    // downstream would "work" against an empty allowances file, but the honest answer is that there
    // is nothing to redeem yet, and the page shows the rules and the launch link instead.
    if (!launched(config)) return fail(res, 409, 'coin not launched yet');

    if (req.method === 'GET') {
      const url = new URL(req.url || '/', 'http://local');
      // Base58 is case-sensitive: the address is used exactly as sent, and must be canonical.
      const address = String(url.searchParams.get('address') || '');
      if (!isAddress(address)) return fail(res, 400, 'address required');
      const nowMs = Date.now();
      const week = weekOf(Math.floor(nowMs / 1000));
      // The allowances file is read first and cheaply — fetchJson keeps it for a minute — because
      // its own stamp goes into the cache key. A freshly published ledger must never be answered
      // from a picture taken against the old one, however few seconds old that picture is.
      const allowances = await readAllowances().catch(() => null);
      if (!allowances) return fail(res, 503, 'allowances unavailable');
      const key = address + ':' + week + ':' + (allowances.asOf || 0) + ':' + (allowances.week || 0);
      const hit = standingCache.get(key);
      if (hit && nowMs - hit.at < STANDING_TTL_MS) return send(res, 200, hit.body);
      if (!withinBurst(nowMs)) {
        res.setHeader('retry-after', '30');
        return fail(res, 429, 'too many requests; try again in a moment');
      }
      const prov = chooseProvider();
      const treasury = await readTreasury();
      const s = await standing(prov, config, allowances, address, week, treasury);
      const membership = await membershipOf(prov, config, allowances, address, week, treasury);
      const out = standingBody(s, address, allowances, config, false, membership);
      standingCache.set(key, { at: nowMs, body: out });
      // Bounded, because the keys come from the caller: an attacker walking addresses must not be
      // able to grow this instance's memory without limit. Oldest out first.
      if (standingCache.size > 2000) for (const k of [...standingCache.keys()].slice(0, 1000)) standingCache.delete(k);
      return send(res, 200, out);
    }

    let body;
    try { body = await readBody(req); } catch (e) {
      // An oversized streamed body is abandoned mid-read (see readBody() above), so close the
      // socket rather than offer it back for HTTP/1.1 keep-alive, or whatever request happens
      // to reuse the connection next can be answered out of a corrupted stream (observed directly
      // as an ECONNRESET, or as several seconds' stall while a client's pool waits on it).
      if (e && e.tooLarge) res.setHeader('connection', 'close');
      return fail(res, 400, 'body must be JSON');
    }
    if (!body || typeof body !== 'object') return fail(res, 400, 'body must be JSON');
    const address = typeof body.address === 'string' ? body.address : '';
    if (!isAddress(address)) return fail(res, 400, 'address required');

    // A signed request with no package is a read: the standing, with the codes this time. Which it
    // is has to be settled BEFORE the signature is checked, because the signature says which one it
    // authorises — that is the whole point of binding the action into it. A welcome claim names a
    // plan but no slot: it fills the wallet's one welcome order.
    const welcomeClaim = body.welcome === true;
    const reading = !welcomeClaim && (body.packageCode === undefined || body.packageCode === null || body.packageCode === '');

    // A host can be fully configured and funded while purchases are still closed. Keep account
    // and installation reads available, but refuse every package POST before provider work.
    if (!reading && !redemptionsEnabled()) return fail(res, 503, 'data redemption is not enabled yet');

    // The shape of the request is settled before the signature, because the signature now names
    // the plan and the slot: a body missing either is a malformed request, not a bad signature,
    // and answering 401 for it would send a caller looking for a wallet problem they do not have.
    let pkg = null, priceUsd = 0, m = null;
    if (welcomeClaim) {
      m = membershipRules(config);
      if (!m) return fail(res, 503, 'membership is not configured');
      pkg = config.packages.find((p) => p && p.code === body.packageCode);
      if (!pkg) return fail(res, 400, 'unknown package');
      if (!rules.welcomeEligible(pkg, m.welcome)) return fail(res, 400, 'this plan is not included with membership');
      const tx = body.joinTx;
      if (tx !== undefined && tx !== null && tx !== '' && !S.isSignature(tx)) return fail(res, 400, 'joinTx must be a transaction signature');
    } else if (!reading) {
      pkg = config.packages.find((p) => p && p.code === body.packageCode);
      if (!pkg) return fail(res, 400, 'unknown package');
      priceUsd = Number(pkg.priceUsd);
      if (!(priceUsd > 0)) return fail(res, 503, 'package has no price');
      if (body.n === undefined || body.n === null || !/^\d{1,6}$/.test(String(body.n))) return fail(res, 400, 'n required: how many orders you have seen this week');
    }

    const nowS = Math.floor(Date.now() / 1000);
    const why = checkMessage(body.message, address, nowS,
      welcomeClaim ? { action: 'welcome', packageCode: String(body.packageCode) }
        : reading ? { action: 'read' } : { action: 'redeem', packageCode: String(body.packageCode), n: String(body.n) });
    if (why) return fail(res, 401, why);
    // The wallet's ed25519 signature over the message's exact UTF-8 bytes, base58 (signMessage).
    if (!solanaAuth.verifyMessage(body.message, body.signature, address)) return fail(res, 401, 'signature does not match address');

    const prov = chooseProvider();
    const allowances = await readAllowances().catch(() => null);
    if (!allowances) return fail(res, 503, 'allowances unavailable');
    const week = weekOf(nowS);
    // A signed request is about to change this wallet's standing. The cached public answer is then
    // the wrong one to hand the page when it refetches a moment later — a holder who has just
    // redeemed must not be shown their balance from ten seconds ago — and the key carries the
    // ledger's stamp, so every picture of this wallet goes, not just the one matching this read.
    for (const k of standingCache.keys()) if (k.startsWith(address + ':')) standingCache.delete(k);
    if (welcomeClaim) {
      return await claimWelcome(res, { prov, config, m, allowances, address, pkg, joinTx: body.joinTx ? String(body.joinTx) : '' });
    }
    const s = await standing(prov, config, allowances, address, week, null, { includeSims: reading });
    if (reading) {
      const membership = await membershipOf(prov, config, allowances, address, week, await readTreasury(), { codes: true });
      return send(res, 200, standingBody(s, address, allowances, config, true, membership));
    }

    const supplierPackage = pkg.packageCode || pkg.code;
    const place = pkg.slug || pkg.code;
    // Wholesale records the supplier SKU; the older adapters expose the supplied slug/code.
    // Compare the exact identifier that this adapter records, never any matching catalogue alias.
    const recordedPackage = prov.name === 'wholesale' ? supplierPackage : place;
    const matchesOrder = (order) => order && order.packageCode === recordedPackage
      && (prov.name !== 'wholesale' || order.slug === place);

    // The slot. A caller that names a slot already filled with the same package is retrying,
    // replaying or double-clicking, and gets that order back; one that names a slot ahead of the
    // ledger, or filled with something else, is out of step and told to reload.
    const n = s.orders.length;
    const asked = Number(body.n);
    if (asked < n) {
      const done = s.orders[asked];
      if (matchesOrder(done)) {
        return send(res, 200, {
          ok: true, order: publicOrder(done, config, { codes: true }), remainingUsd: s.remainingUsd,
          sims: await simsFor(prov, address, done), replayed: true,
        });
      }
      return fail(res, 409, 'your orders have changed since; reload');
    }
    if (asked > n) return fail(res, 409, 'your orders have changed since; reload');
    // Below this point a fresh order is actually being placed, so the wallet's standing has to be
    // real: not a stale file, and not a wallet with nothing to spend.
    if (s.stale) return fail(res, 409, "this week's allowance has not been published yet");
    if (!s.holds) {
      // Say why there is nothing to spend. With membership on, weekly credit is for the members at
      // Monday's snapshot: a wallet the ledger doesn't list as a member (yet) shares from the first
      // snapshot after its join, and a member who joined after this one, from the next.
      if (membershipRules(config)) {
        if (!ledgerMember(config, allowances, address)) return fail(res, 409, 'weekly credit is for members, from the first Monday snapshot after they join');
        if (!rowOf(allowances.wallets, address)) return fail(res, 409, 'your weekly share starts at the next Monday snapshot');
        return fail(res, 409, 'this wallet held no OTT at this week’s snapshot');
      }
      return fail(res, 409, 'this wallet holds no OTT this week');
    }
    if (s.remainingUsd + 1e-9 < priceUsd) return fail(res, 409, 'not enough data credit: $' + s.remainingUsd.toFixed(2) + ' banked, $' + priceUsd.toFixed(2) + ' needed');

    // find() first, even though pastOrders() just said the slot was free: a racing request may
    // have placed it in the meantime, and returning that order is the idempotent answer.
    const transactionId = transactionIdFor(address, week, n);
    const existing = await prov.find(transactionId);
    if (existing && !matchesOrder(existing)) return fail(res, 409, 'your orders have changed since; reload');
    // The provider is given the catalogue entry three ways: `packageCode` is what it keys the order
    // on (eSIM Access's package code, wholesale's bundle name), `slug` is the place it is priced
    // for (wholesale) or the record name (eSIM Access), and `code` is what priceOf() looks up.
    const order = existing || await prov.order({ transactionId, packageCode: supplierPackage, slug: place, code: pkg.code, priceUsd, address });
    // Another plan can win the slot while order() waits. Its codes require its own signature.
    if (!matchesOrder(order)) return fail(res, 409, 'your orders have changed since; reload');
    const remainingUsd = round6(Math.max(0, s.remainingUsd - priceOf(order, config)));
    // The eSIMs after this order, not before: a wallet's first claim mints the profile this very
    // call created. Its signature authorizes that profile's code, never unrelated profile codes.
    return send(res, 200, {
      ok: true, order: publicOrder(Object.assign({ n, week }, order), config, { codes: true }),
      remainingUsd, sims: await simsFor(prov, address, order),
    });
  } catch (e) {
    // Provider and config failures land here. The message is the provider's or ours, never a
    // stack, and never anything that came from the environment. A provider that knows its problem
    // is temporary (the pool cannot pay right now) says so with a 503; anything else is a 502.
    return fail(res, (e && e.status) || 502, scrubbed(e && e.message));
  }
};

// Exposed for tests; not part of the HTTP contract.
module.exports.transactionIdFor = transactionIdFor;
module.exports.welcomeIdFor = welcomeIdFor;
module.exports.HEADS = HEADS;
module.exports.MESSAGE_HEAD = MESSAGE_HEAD;
module.exports.checkMessage = checkMessage;
// Tests only. The public GET is answered from memory for a few seconds, which is correct in a
// deployment — the only thing that changes a wallet's standing there is a POST, and a POST clears
// it — but a test that reaches past the endpoint to reset the provider underneath it has changed
// the world in a way no request did, and has to say so.
module.exports._resetCaches = () => { cache.clear(); standingCache.clear(); burst = { minute: 0, count: 0 }; };
