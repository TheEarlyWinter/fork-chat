import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArtifactMetadata } from '../ui/assets/artifact-contract.js';
import { groupArtifactVersions, planArtifactVersionAttachment } from '../ui/assets/artifact-versions.js';
import { artifactFilesHtml } from '../ui/assets/panel-artifact-markup.js';
import { createArtifactIndexStore } from '../ui/assets/artifact-index-store.js';
import { normalizeForkSnapshot } from '../ui/assets/fork-snapshot.js';
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32), D = 'd'.repeat(32);
const base = { artifactId: A, name: '报告.md', format: 'md', mime: 'text/markdown', bytes: 20, sha256: 'f'.repeat(64), status: 'ready', createdAt: '2026-10-24T00:00:00Z', origin: 'generated' };
const v2 = { ...base, artifactId: B, name: '报告-v2.md', revisedFrom: A, version: 2, revisionRootId: A, revisionSource: 'preview-excerpt', revisionNotice: '仅基于旧预览摘要进行内容级重写，可能不含全文，不保留原 Word/PDF 版式、分页或样式。', createdAt: '2026-10-24T01:00:00Z' };
const v3 = { ...v2, artifactId: C, name: '报告-v3.md', revisedFrom: B, version: 3, createdAt: '2026-10-24T02:00:00Z' };

test('versions: old receipts default to v1 without changing old public metadata shape', () => {
  const normalized = normalizeArtifactMetadata(base);
  assert.equal(Object.hasOwn(normalized, 'revisedFrom'), false); assert.equal(Object.hasOwn(normalized, 'version'), false);
  const [group] = groupArtifactVersions([base]); assert.equal(group.rootId, A); assert.equal(group.current.artifactId, A);
});
test('versions: whitelist lineage through receipts and snapshots, never owner/path/source content', () => {
  const normalized = normalizeArtifactMetadata({ ...v2, owner: 'secret', path: '/private', content: 'whole source' });
  assert.equal(normalized.revisedFrom, A); assert.equal(normalized.version, 2); assert.equal(normalized.revisionRootId, A); assert.match(normalized.revisionNotice, /摘要/);
  for (const key of ['owner', 'path', 'content']) assert.equal(Object.hasOwn(normalized, key), false);
  const snapshot = normalizeForkSnapshot({ cards: [{ id: 'card-a', parentId: null, x: 0, y: 0, width: 320, messages: [{ role: 'assistant', text: 'ok', artifacts: [base, v2] }] }], view: { x: 0, y: 0, scale: 1 }, agent: {} });
  assert.equal(snapshot.cards[0].messages[0].artifacts[1].version, 2);
});
test('versions: reject invalid/self lineage instead of silently treating a revision as v1', () => {
  for (const value of [{ ...v2, revisedFrom: B }, { ...v2, revisionRootId: B }, { ...v2, version: 99 }, { ...v2, version: undefined }, { ...v2, revisionRootId: undefined }, { ...v2, revisedFrom: '../x' }, { ...base, version: 2 }, { ...base, revisionRootId: D }, { ...v2, revisionSource: 'trusted-layout' }]) assert.equal(normalizeArtifactMetadata(value), null);
});
test('versions: same root becomes one card with both versions actionable and truthful labels', () => {
  const original = structuredClone([base, v2, v3]);
  const groups = groupArtifactVersions(original); assert.equal(groups.length, 1); assert.equal(groups[0].versions.length, 3); assert.equal(groups[0].current.artifactId, C);
  assert.deepEqual(original, [base, v2, v3]);
  const html = artifactFilesHtml({ artifacts: original }); assert.equal((html.match(/<section class="artifact-file-card"/g) || []).length, 1);
  assert.match(html, /v3 · 基于 v2 修订/); assert.match(html, /版本记录/); assert.match(html, new RegExp(`data-artifact-id="${A}"`)); assert.match(html, new RegExp(`data-artifact-id="${B}"`)); assert.match(html, new RegExp(`data-artifact-id="${C}"`));
  assert.match(html, /可能不含全文/); assert.match(html, /不保留/);
});
test('versions: branches retain distinct IDs and newest creation is current, not highest version', () => {
  const sibling = { ...v2, artifactId: D, createdAt: '2026-10-24T03:00:00Z' };
  const [group] = groupArtifactVersions([base, v2, v3, sibling]); assert.equal(group.versions.length, 4); assert.equal(group.current.artifactId, D);
});
test('versions: different roots and same filenames never merge; malicious names stay escaped', () => {
  const other = { ...base, artifactId: D, name: '<img src=x onerror=boom>.md' };
  const html = artifactFilesHtml({ artifacts: [base, v2, other] }); assert.equal((html.match(/<section class="artifact-file-card"/g) || []).length, 2); assert.doesNotMatch(html, /<img /); assert.match(html, /&lt;img/);
});
test('versions: pure attachment plan finds original message, dedupes and leaves caller objects untouched', () => {
  const messages = [{ role: 'assistant', text: 'old', artifacts: [base] }, { role: 'assistant', text: 'new' }], before = structuredClone(messages);
  const plan = planArtifactVersionAttachment(messages, v2, 1); assert.equal(plan.messageIndex, 0); assert.equal(plan.linked, true); assert.deepEqual(plan.artifacts.map(a => a.artifactId), [A, B]); assert.deepEqual(messages, before);
  const duplicate = planArtifactVersionAttachment([{ ...messages[0], artifacts: [base, v2] }, messages[1]], v2, 1); assert.equal(duplicate.changed, false);
  const missing = planArtifactVersionAttachment([messages[1]], v2, 0); assert.equal(missing.messageIndex, 0); assert.equal(missing.linked, false);
});
test('versions: full original message never silently drops old files to append a revision', () => {
  const crowded = Array.from({ length: 20 }, (_, i) => ({ ...base, artifactId: i.toString(16).padStart(32, '0') })); crowded[0] = base;
  const messages = [{ role: 'assistant', artifacts: crowded }, { role: 'assistant', artifacts: [] }]; const plan = planArtifactVersionAttachment(messages, v2, 1);
  assert.equal(plan.messageIndex, 1); assert.equal(plan.reason, 'target-full'); assert.equal(messages[0].artifacts.length, 20); assert.equal(plan.artifacts[0].artifactId, B);
});
test('versions: attachment never rewrites a user message or an invalid fallback target', () => {
  const messages = [{ role: 'user', artifacts: [base] }, { role: 'assistant', text: '' }];
  const plan = planArtifactVersionAttachment(messages, v2, 1); assert.equal(plan.messageIndex, 1); assert.equal(plan.linked, false);
  assert.equal(planArtifactVersionAttachment(messages, v2, 0), null);
});
test('versions: index preserves only normalized lineage, remains a non-authorizing hint', async () => {
  let stored; const hana = { storage: { global: { get: async () => structuredClone(stored), set: async (_key, value) => { stored = structuredClone(value); } } } };
  const store = createArtifactIndexStore({ hana, locks: { request: async (_key, _mode, fn) => fn() } }); const scope = 'e'.repeat(64);
  await store.upsert(scope, { ...v2, owner: 'secret', sourceText: 'private' }, { canvasId: 'canvas-a', cardId: 'card-a' });
  const entry = (await store.read(scope)).entries[B]; assert.equal(entry.revisedFrom, A); assert.equal(entry.version, 2); assert.equal(entry.revisionRootId, A);
  assert.equal(Object.hasOwn(entry, 'owner'), false); assert.equal(Object.hasOwn(entry, 'sourceText'), false);
});
