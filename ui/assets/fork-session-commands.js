// Keep user-entered titles off the shared BroadcastChannel. Only opaque
// request/session ids travel there; payloads use owner-only host storage.
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const PREFIX = 'fork-chat.intent.rename.';
function key(id) {
  if (!ID.test(id || '')) throw new Error('Invalid rename request id');
  return PREFIX + id;
}
export async function writeRenameIntent(hana, { requestId, sessionId, title, expectedTitle }) {
  if (!ID.test(sessionId || '') || typeof title !== 'string' || typeof expectedTitle !== 'string') throw new Error('Invalid rename intent');
  await hana.storage.global.set(key(requestId), { version: 1, sessionId, title, expectedTitle, createdAt: Date.now() });
}
export async function readRenameIntent(hana, requestId, sessionId) {
  const raw = await hana.storage.global.get(key(requestId));
  const value = raw && Object.prototype.hasOwnProperty.call(raw, 'value') ? raw.value : raw;
  if (!value || value.version !== 1 || value.sessionId !== sessionId || typeof value.title !== 'string'
    || typeof value.expectedTitle !== 'string' || !Number.isFinite(value.createdAt)
    || Date.now() - value.createdAt > 300000 || value.createdAt > Date.now() + 30000) {
    throw new Error('重命名请求已过期，请重新操作。');
  }
  return value;
}
export async function clearRenameIntent(hana, requestId) {
  // Cleanup failure does not undo a committed rename or falsely report failure.
  try { await hana.storage.global.delete(key(requestId)); } catch {}
}
