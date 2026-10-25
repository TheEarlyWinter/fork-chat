import test from 'node:test';
import assert from 'node:assert/strict';
import { writeRenameIntent, readRenameIntent, clearRenameIntent } from '../ui/assets/fork-session-commands.js';
import { memoryHost } from './helpers/fork-memory.mjs';

const intent = { requestId: 'req-private', sessionId: 'session-one', title: 'private title', expectedTitle: 'old title' };
test('rename intents stay in owner-only host storage, are target-bound and are consumed explicitly', async () => {
  const host = memoryHost();
  await writeRenameIntent(host, intent);
  assert.equal((await readRenameIntent(host, intent.requestId, intent.sessionId)).title, intent.title);
  await assert.rejects(readRenameIntent(host, intent.requestId, 'wrong-session'), /过期/);
  await clearRenameIntent(host, intent.requestId);
  await assert.rejects(readRenameIntent(host, intent.requestId, intent.sessionId), /过期/);
});

test('expired or malformed intents fail closed without a collection write', async () => {
  const host = memoryHost();
  await assert.rejects(writeRenameIntent(host, { ...intent, requestId: '../escape' }), /Invalid/);
  assert.equal(host.control.writes, 0);
  await writeRenameIntent(host, intent);
  const [key, value] = [...host.values][0];
  host.values.set(key, { ...value, createdAt: Date.now() - 300001 });
  await assert.rejects(readRenameIntent(host, intent.requestId, intent.sessionId), /过期/);
  host.values.set(key, { ...value, createdAt: Date.now() + 60000 });
  await assert.rejects(readRenameIntent(host, intent.requestId, intent.sessionId), /过期/);
});

test('intent cleanup failure does not misreport an already committed operation', async () => {
  const host = memoryHost(); await writeRenameIntent(host, intent);
  host.control.failWrites = true;
  await assert.doesNotReject(clearRenameIntent(host, intent.requestId));
});
