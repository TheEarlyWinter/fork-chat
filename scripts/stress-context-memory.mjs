import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildContextPlan } from '../ui/assets/panel-context-plan.js';
import { normalizeForkSnapshot } from '../ui/assets/fork-snapshot.js';
import { createForkSessionStore } from '../ui/assets/fork-session-store.js';

/** Deterministic fake data only; no SDK, credentials, filesystem sessions or model/network calls. */
export function syntheticSnapshot({ messageCount = 1000, cardCount = Math.min(100, Math.max(1, Math.ceil(messageCount / 100))), repeats = 12 } = {}) {
  if (!Number.isSafeInteger(messageCount) || messageCount < 0 || messageCount > 10000 || !Number.isSafeInteger(cardCount) || cardCount < 1 || cardCount > 300
    || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 100) throw new RangeError('invalid synthetic fixture size');
  const cards = Array.from({ length: cardCount }, (_, i) => ({ id: `synthetic-card-${i}`, title: `Synthetic ${i}`, parentId: i ? `synthetic-card-${i - 1}` : null,
    x: i * 10, y: 0, width: 320, messages: [], ...(i > 0 && i % 13 === 0 ? { contextMode: 'exclude' } : {}) }));
  for (let i = 0; i < messageCount; i++) {
    const owner = cards[Math.min(cardCount - 1, Math.floor(i * cardCount / Math.max(1, messageCount)))];
    const message = { role: i % 2 ? 'assistant' : 'user', status: 'completed', text: `synthetic-${i}:` + '汉😀\\\"\n-data-'.repeat(repeats) };
    if (i % 250 === 0) message.attachments = [{ name: 'synthetic.txt', content: '合成附件'.repeat(32) }];
    if (i % 200 === 1) message.artifactRefs = [{ artifactId: (i + 1).toString(16).padStart(32, '0'), name: `synthetic-${i}-v2.md`, format: 'md', mime: 'text/markdown',
      bytes: 100, sha256: 'b'.repeat(64), createdAt: '2026-01-01T00:00:00Z', status: 'ready', version: 2, revisedFrom: 'a'.repeat(32), revisionRootId: 'a'.repeat(32) }];
    owner.messages.push(message);
  }
  if (cardCount > 1) cards.at(-1).contextRefs = [{ id: 'synthetic-reference', sourceCardId: cards[0].id, sourceTitle: 'Synthetic source', text: 'Explicit synthetic reference' }];
  return { cards, view: { x: 0, y: 0, scale: 1 }, agent: { id: 'synthetic-agent', provider: 'p', model: 'm' } };
}

/** JSON cloning models storage serialization, but NOT real host IPC/disk latency. */
export function benchmarkHost() {
  const values = new Map(); let tail = Promise.resolve();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  return { values,
    storage: { global: { get: async key => clone(values.get(key) ?? null), set: async (key, value) => { values.set(key, clone(value)); }, onChanged: () => () => {} } },
    locks: { request(_name, callback) { const current = tail.catch(() => {}).then(callback); tail = current; return current; } },
  };
}
const summarize = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) };
};

export async function runContextMemoryBenchmark({ counts = [100, 1000, 10000], iterations = 5, warmups = 2, enforce = false } = {}) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100 || !Number.isSafeInteger(warmups) || warmups < 0 || warmups > 10) throw new RangeError('invalid benchmark repetitions');
  const cases = [];
  for (const inputMessages of counts) {
    const snapshot = syntheticSnapshot({ messageCount: inputMessages });
    const inputJson = JSON.stringify(snapshot), host = benchmarkHost();
    const options = { locks: host.locks, idFactory: () => 'synthetic-session' };
    const store = createForkSessionStore(host, options);
    // Return only a cursor; do not accidentally retain full save/restore results during post-GC sampling.
    let cursor = await (async () => { const value = await store.ensure(snapshot); return { id: value.id, revision: value.revision }; })();
    const timings = { compile: [], normalize: [], save: [], restore: [] };
    const iteration = async () => {
      let start = performance.now();
      const plan = buildContextPlan({ cards: snapshot.cards, targetCard: snapshot.cards.at(-1), pendingUserMessage: { role: 'user', text: 'Synthetic next prompt' } });
      const compileMs = performance.now() - start;
      assert.equal(plan.isRequestReady, true); assert.ok(plan.messages.length <= 256);
      assert.ok(Buffer.byteLength(JSON.stringify(plan.messages)) <= 512 * 1024);
      start = performance.now(); const normalized = normalizeForkSnapshot(snapshot); const normalizeMs = performance.now() - start;
      assert.equal(normalized.cards.reduce((n, card) => n + card.messages.length, 0), inputMessages);
      start = performance.now(); const saved = await store.save(cursor.id, cursor.revision, snapshot); const saveMs = performance.now() - start;
      start = performance.now(); const restored = await createForkSessionStore(host, options).get(saved.id); const restoreMs = performance.now() - start;
      assert.deepEqual(restored.snapshot, normalized);
      return { cursor: { id: saved.id, revision: saved.revision }, outputMessages: plan.messages.length, outputWireBytes: plan.stats.wireBytes,
        timings: { compile: compileMs, normalize: normalizeMs, save: saveMs, restore: restoreMs } };
    };
    globalThis.gc?.(); const heapBefore = process.memoryUsage().heapUsed;
    let outputMessages = 0, outputWireBytes = 0;
    for (let i = -warmups; i < iterations; i++) {
      const sample = await iteration();
      cursor = sample.cursor; outputMessages = sample.outputMessages; outputWireBytes = sample.outputWireBytes;
      if (i >= 0) for (const [key, ms] of Object.entries(sample.timings)) timings[key].push(ms);
    }
    assert.equal(JSON.stringify(snapshot), inputJson, 'compiler and storage must not mutate live input');
    globalThis.gc?.(); const heapAfter = process.memoryUsage().heapUsed;
    const timingsMs = Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, summarize(values)]));
    if (enforce) {
      assert.ok(timingsMs.compile.p95 <= 100, 'compile p95 target 100ms');
      assert.ok(timingsMs.save.p95 <= 500, 'save p95 target 500ms');
      assert.ok(timingsMs.restore.p95 <= 500, 'restore p95 target 500ms');
    }
    cases.push({ inputMessages, inputSnapshotBytes: Buffer.byteLength(inputJson), outputMessages, outputWireBytes, timingsMs,
      heap: { gcAvailable: typeof globalThis.gc === 'function', before: heapBefore, after: heapAfter, delta: heapAfter - heapBefore, note: 'retained live/saved history is intentional; this is not a browser DOM leak test' } });
  }
  return { node: process.version, platform: process.platform, arch: process.arch, iterations, warmups, enforce,
    storageKind: 'synthetic-memory-host-with-json-clone', notes: ['No private data/model/network/host writes.', 'Timing excludes real host IPC/disk; no heap plateau guarantee from these samples.'], cases };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const quick = process.argv.includes('--quick');
  const report = await runContextMemoryBenchmark({ iterations: quick ? 3 : 7, warmups: quick ? 1 : 2, enforce: process.argv.includes('--enforce') });
  console.log(JSON.stringify(report, null, 2));
}
