/** Owns active request identity and bounded pre-cancel tombstones; no transport or SDK. */
export function createChatLedger({ clock = Date, tombstoneTtlMs = 130000, tombstoneCapacity = 1024 } = {}) {
  if (typeof clock?.now !== 'function') throw new TypeError('createChatLedger: clock.now must be a function');
  if (!Number.isFinite(tombstoneTtlMs) || tombstoneTtlMs <= 0) throw new RangeError('createChatLedger: tombstoneTtlMs must be positive');
  if (!Number.isInteger(tombstoneCapacity) || tombstoneCapacity < 1) throw new RangeError('createChatLedger: tombstoneCapacity must be a positive integer');
  const inFlightRequests = new Map(), tombstones = new Map();
  const keyFor = (principal, requestId) => `${principal?.appId || ''}|${principal?.credentialId ? `cred:${principal.credentialId}` : `princ:${principal?.principalId || ''}`}|${requestId}`;
  function prune(now) {
    for (const [key, value] of tombstones) if (value.expireAt <= now) tombstones.delete(key);
  }
  function recordTombstone(principal, requestId) {
    const now = clock.now(); prune(now);
    const key = keyFor(principal, requestId);
    if (tombstones.has(key)) tombstones.delete(key);
    else if (tombstones.size >= tombstoneCapacity) tombstones.delete(tombstones.keys().next().value);
    tombstones.set(key, { expireAt: now + tombstoneTtlMs, principal, requestId });
  }
  function hasTombstone(principal, requestId) {
    const now = clock.now(); prune(now);
    return Boolean(tombstones.get(keyFor(principal, requestId)));
  }
  return {
    // Exposed for the existing service diagnostics API. Mutation belongs to this module.
    inFlightRequests, tombstones,
    get: requestId => inFlightRequests.get(requestId),
    has: requestId => inFlightRequests.has(requestId),
    reserve(session) {
      if (inFlightRequests.has(session.requestId)) return false;
      inFlightRequests.set(session.requestId, session);
      return true;
    },
    release(requestId, session) {
      if (inFlightRequests.get(requestId) === session) inFlightRequests.delete(requestId);
    },
    recordTombstone, hasTombstone,
  };
}
