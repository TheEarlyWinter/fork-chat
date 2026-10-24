import { normalizeArtifactList, normalizeArtifactMetadata } from './artifact-contract.js';

/** A grouping is a view only, never proof that a file can be read. Branches keep distinct IDs. */
export function groupArtifactVersions(value) {
  const groups = new Map();
  for (const file of normalizeArtifactList(value)) {
    const rootId = file.revisionRootId || file.artifactId;
    let group = groups.get(rootId);
    if (!group) { group = { rootId, current: file, versions: [] }; groups.set(rootId, group); }
    group.versions.push(file);
    if (Date.parse(file.createdAt) >= Date.parse(group.current.createdAt)) group.current = file;
  }
  for (const group of groups.values()) group.versions.sort((a, b) => (a.version || 1) - (b.version || 1) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.artifactId.localeCompare(b.artifactId));
  return [...groups.values()];
}

/** Pure plan: the caller mutates only after its own generation/request/canvas guards pass. */
export function planArtifactVersionAttachment(messages, value, fallbackIndex = messages?.length - 1) {
  const artifact = normalizeArtifactMetadata(value);
  if (!artifact || !Array.isArray(messages) || !Number.isInteger(fallbackIndex) || messages[fallbackIndex]?.role !== 'assistant') return null;
  const lists = messages.map(message => message?.role === 'assistant' ? normalizeArtifactList(message.artifacts) : []);
  const duplicate = lists.findIndex(files => files.some(file => file.artifactId === artifact.artifactId));
  if (duplicate >= 0) return { messageIndex: duplicate, artifacts: lists[duplicate], changed: false, linked: Boolean(artifact.revisedFrom) };
  const existing = artifact.revisedFrom ? lists.findIndex(files => files.some(file => file.artifactId === artifact.revisedFrom || (file.revisionRootId || file.artifactId) === artifact.revisionRootId)) : -1;
  let messageIndex = existing >= 0 ? existing : fallbackIndex, reason;
  if (lists[messageIndex].length >= 20) { reason = 'target-full'; messageIndex = fallbackIndex; }
  if (lists[messageIndex].length >= 20) return null;
  return { messageIndex, artifacts: [...lists[messageIndex], artifact], changed: true, linked: existing >= 0 && messageIndex === existing,
    ...(reason ? { reason } : {}) };
}
