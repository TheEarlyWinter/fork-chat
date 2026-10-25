import test from 'node:test';
import assert from 'node:assert/strict';
import { syntheticSnapshot, benchmarkHost, runContextMemoryBenchmark } from '../scripts/stress-context-memory.mjs';
import { normalizeForkSnapshot } from '../ui/assets/fork-snapshot.js';
import { createForkSessionStore, FORK_SESSION_STORAGE_KEY } from '../ui/assets/fork-session-store.js';
import { buildContextPlan } from '../ui/assets/panel-context-plan.js';

test('stress fixture: deterministic legal synthetic data, 10000 retained across compile/save/restore', async () => {
  const source = syntheticSnapshot({ messageCount: 10000, cardCount: 100, repeats: 1 });
  assert.deepEqual(source, syntheticSnapshot({ messageCount: 10000, cardCount: 100, repeats: 1 }));
  const normalized = normalizeForkSnapshot(source);
  const host = benchmarkHost();
  let record = await createForkSessionStore(host, { locks: host.locks, idFactory: () => 'synthetic-session' }).ensure(source);
  const savedBefore = JSON.stringify(host.values.get(FORK_SESSION_STORAGE_KEY));
  const plan = buildContextPlan({ cards: source.cards, targetCard: source.cards.at(-1), pendingUserMessage: { role: 'user', text: 'next' } });
  assert.equal(plan.isRequestReady, true); assert.ok(plan.messages.length <= 256);
  assert.equal(JSON.stringify(host.values.get(FORK_SESSION_STORAGE_KEY)), savedBefore, 'compile does not prune saved history');
  const fresh = createForkSessionStore(host, { locks: host.locks });
  record = await fresh.get(record.id);
  assert.deepEqual(record.snapshot, normalized);
  assert.equal(record.snapshot.cards.reduce((n, card) => n + card.messages.length, 0), 10000);
});

test('snapshot hard limits unchanged: 300 cards/10000 messages accepted, 301/10001 rejected atomically', async () => {
  const host = benchmarkHost(), store = createForkSessionStore(host, { locks: host.locks, idFactory: () => 'synthetic-session' });
  const source = syntheticSnapshot({ messageCount: 10000, cardCount: 300, repeats: 1 });
  const record = await store.ensure(source);
  const before = JSON.stringify(host.values.get(FORK_SESSION_STORAGE_KEY));
  const tooManyMessages = structuredClone(source);
  tooManyMessages.cards.at(-1).messages.push({ role: 'user', text: 'overflow' });
  await assert.rejects(store.save(record.id, record.revision, tooManyMessages), error => error.code === 'INVALID_SESSION_SNAPSHOT');
  const tooManyCards = structuredClone(source);
  tooManyCards.cards.push({ ...tooManyCards.cards[0], id: 'extra-card', parentId: null, messages: [] });
  await assert.rejects(store.save(record.id, record.revision, tooManyCards), error => error.code === 'INVALID_SESSION_SNAPSHOT');
  assert.equal(JSON.stringify(host.values.get(FORK_SESSION_STORAGE_KEY)), before);
});

test('store quota is global across sessions, not per snapshot; rejected save never overwrites', async () => {
  const host = benchmarkHost(); let id = 0;
  const store = createForkSessionStore(host, { locks: host.locks, idFactory: () => `synthetic-${++id}` });
  const first = syntheticSnapshot({ messageCount: 2, cardCount: 1 });
  first.cards[0].messages[0].text = 'x'.repeat(7 * 1024 * 1024);
  await store.ensure(first);
  const before = JSON.stringify(host.values.get(FORK_SESSION_STORAGE_KEY));
  const second = syntheticSnapshot({ messageCount: 2, cardCount: 1 });
  second.cards[0].messages[0].text = 'y'.repeat(6 * 1024 * 1024);
  await assert.rejects(store.create(second), error => error.code === 'STORAGE_QUOTA_EXCEEDED');
  assert.equal(JSON.stringify(host.values.get(FORK_SESSION_STORAGE_KEY)), before);
});

test('benchmark uses actual compiler/save/fresh-store restore and emits metrics without fragile timing gate', async () => {
  const report = await runContextMemoryBenchmark({ counts: [100], iterations: 2, warmups: 0 });
  assert.equal(report.cases.length, 1);
  const result = report.cases[0];
  assert.equal(result.inputMessages, 100);
  assert.ok(result.outputMessages <= 256); assert.ok(result.outputWireBytes <= 512 * 1024);
  for (const phase of ['compile', 'normalize', 'save', 'restore']) {
    assert.ok(result.timingsMs[phase].p95 >= 0);
    assert.ok(result.timingsMs[phase].max >= result.timingsMs[phase].p95);
  }
  assert.equal(report.storageKind, 'synthetic-memory-host-with-json-clone');
});
