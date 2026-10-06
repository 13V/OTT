'use strict';
/* Public catalogue preferences only. Credit, identities and eSIM credentials are never stored here. */
(function () {
  const BASE = new URL('./', document.currentScript?.src || location.href);
  const KEY = 'ott-saved-places:' + BASE.pathname + 'v1';
  const LIMIT = 12;
  let memory = [];
  let storageUnavailable = false;
  function clean(values, cfg) {
    const allowed = new Set((cfg?.packages || []).map(pkg => pkg.slug));
    return Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string'
      && /^[a-z0-9-]{1,80}$/.test(value) && allowed.has(value)))].slice(0, LIMIT) : [];
  }
  function savedPlaces(cfg) {
    if (storageUnavailable) return clean(memory, cfg);
    try {
      const raw = localStorage.getItem(KEY);
      memory = clean(raw && raw.length <= 2048 ? JSON.parse(raw) : [], cfg);
    } catch { storageUnavailable = true; memory = clean(memory, cfg); }
    return memory.slice();
  }
  function toggleSaved(cfg, slug) {
    const values = savedPlaces(cfg);
    if (!clean([slug], cfg).length) throw new Error('This destination is not in the current catalogue.');
    const exists = values.includes(slug);
    if (!exists && values.length >= LIMIT) throw new Error('You can save up to 12 destinations. Remove one to add another.');
    memory = exists ? values.filter(value => value !== slug) : [...values, slug];
    let persisted = true;
    try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch { persisted = false; storageUnavailable = true; }
    return { saved: !exists, persisted, places: memory.slice() };
  }
  function fitPlans(cfg, amount, slug) {
    if (!Number.isFinite(amount) || amount < 0) return [];
    return (cfg?.packages || []).filter(pkg => (!slug || pkg.slug === slug)
      && Number.isFinite(pkg.priceUsd) && pkg.priceUsd > 0 && pkg.priceUsd <= amount + 1e-9
      && Number.isFinite(pkg.gb) && pkg.gb > 0 && Number.isInteger(pkg.days) && pkg.days > 0)
      .sort((a, b) => a.priceUsd - b.priceUsd || b.gb - a.gb || a.code.localeCompare(b.code));
  }
  function publicSims(sims, cfg) {
    const allowed = new Set((cfg?.packages || []).map(pkg => pkg.slug));
    const byPlace = new Map();
    for (const sim of Array.isArray(sims) ? sims.slice(0, 200) : []) {
      if (!sim || typeof sim.slug !== 'string' || !allowed.has(sim.slug)) continue;
      const created = typeof sim.createdAt === 'string' && Number.isFinite(Date.parse(sim.createdAt)) ? sim.createdAt : null;
      const prior = byPlace.get(sim.slug);
      if (prior && (Date.parse(prior.createdAt || '') || 0) >= (Date.parse(created || '') || 0)) continue;
      byPlace.set(sim.slug, { slug: sim.slug, createdAt: created,
        iccidTail: typeof sim.iccid === 'string' && sim.iccid.length <= 80 ? sim.iccid.slice(-4) : '' });
    }
    return [...byPlace.values()];
  }
  window.OTTHolderTools = { savedPlaces, toggleSaved, fitPlans, publicSims };
})();
