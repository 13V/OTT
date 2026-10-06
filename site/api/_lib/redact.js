'use strict';

// Failure text is public even when the order's installation fields require a signature.
const ORDER_SECRET_FIELDS = ['ac', 'manualCode', 'smdpAddress', 'matchingId', 'qrCodeUrl',
  'appleInstallUrl', 'androidInstallUrl', 'paymentRequest', 'paymentHash', 'preimage'];

function orderSecrets(order) {
  return ORDER_SECRET_FIELDS.map(field => order && order[field]).filter(value => typeof value === 'string' && value);
}

function variants(value) {
  const values = new Set([value, JSON.stringify(value).slice(1, -1)]);
  // JSON permits escaped forward slashes, which still decode to the original private URL.
  values.add(JSON.stringify(value).slice(1, -1).replace(/\//g, '\\/'));
  try {
    const encoded = encodeURIComponent(value);
    values.add(encoded);
    values.add(encoded.replace(/%[\da-f]{2}/gi, part => part.toLowerCase()));
  } catch (_) { /* Raw and JSON forms still cover malformed Unicode. */ }
  return values;
}

function redactError(message, { privateValues = [], env = process.env, maxLength = 160 } = {}) {
  let out = String(message || 'redeem failed');
  const replacements = [];
  for (const value of privateValues) {
    if (typeof value === 'string' && value) for (const secret of variants(value)) replacements.push([secret, '[redacted]']);
  }
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length < 8) continue;
    const privateUrl = /^WHOLESALE_(BASE|PORTFOLIO)_URL$/i.test(name);
    if (!privateUrl && !/_KEY$|_TOKEN$|_SECRET$|_PASSWORD$|_CODE$|PRIVATE_KEY/i.test(name)) continue;
    const values = privateUrl ? [value, value.trim().replace(/\/+$/, '')] : [value];
    for (const secret of values) if (secret.length >= 8) {
      for (const variant of variants(secret)) replacements.push([variant, '[' + name + ']']);
    }
  }
  // Longer values first prevents a component of an activation code from hiding its full form.
  replacements.sort((a, b) => b[0].length - a[0].length);
  for (const [secret, marker] of replacements) out = out.split(secret).join(marker);
  // Errors can echo a newly received profile or invoice before it has reached the saved order.
  out = out.replace(/\bLPA(?::|%3a)[^\s"'<>]+/gi, '[redacted]')
    .replace(/\b(?:lightning:)?ln(?:bc|tb|bcrt)(?:[\d]+[munp]?)?1[\da-z]+/gi, '[redacted]')
    .replace(/\b(ac|smdpAddress|matchingId|manualCode|activationCode|qrCode|qrCodeUrl|appleInstallUrl|androidInstallUrl|paymentRequest|paymentHash|preimage)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1$2[redacted]');
  return out.slice(0, maxLength);
}

module.exports = { redactError, orderSecrets };
