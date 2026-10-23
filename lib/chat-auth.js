/** Principal projection and cancellation authorization; never reads credentials or the SDK. */
export function getPrincipalInfo(context) {
  const requestContext = typeof context?.get === 'function' ? context.get('appRequestContext') : null;
  const principal = requestContext?.principal;
  if (!principal || typeof principal !== 'object') return null;
  const principalId = typeof (principal.principalId || principal.id) === 'string' && (principal.principalId || principal.id).trim()
    ? (principal.principalId || principal.id).trim() : null;
  const credentialId = typeof principal.credentialId === 'string' && principal.credentialId.trim() ? principal.credentialId.trim() : null;
  const kind = typeof principal.kind === 'string' ? principal.kind.trim() : null;
  const appId = typeof (requestContext.appId || principal.appId) === 'string' && (requestContext.appId || principal.appId).trim()
    ? (requestContext.appId || principal.appId).trim() : null;
  return principalId || credentialId ? { principalId, credentialId, kind, appId } : null;
}

export function canCancel(streamPrincipal, cancelPrincipal) {
  if (!streamPrincipal || !cancelPrincipal) return false;
  if (streamPrincipal.appId && cancelPrincipal.appId && streamPrincipal.appId !== cancelPrincipal.appId) return false;
  if (streamPrincipal.credentialId) return cancelPrincipal.credentialId === streamPrincipal.credentialId;
  return Boolean(streamPrincipal.principalId && cancelPrincipal.principalId && streamPrincipal.principalId === cancelPrincipal.principalId);
}
