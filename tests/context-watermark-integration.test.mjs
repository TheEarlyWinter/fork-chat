import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextPlan } from '../ui/assets/panel-context-plan.js';
import { createChatService } from '../lib/chat.js';
const card = (id, messages = [], extra = {}) => ({ id, title: id, parentId: null, messages, ...extra });
const history = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `msg-${i}`, status: 'completed' }));
const pending = { role: 'user', text: 'new question' };

test('planner watermark: real compiler bounds 10000 messages without mutating live history', () => {
  const root = card('root', history(10000));
  const before = JSON.stringify(root);
  const plan = buildContextPlan({ cards: [root], targetCard: root, pendingUserMessage: pending });
  assert.equal(plan.isRequestReady, true);
  assert.ok(plan.messages.length <= 192);
  assert.ok(Buffer.byteLength(JSON.stringify(plan.messages)) <= 384 * 1024);
  assert.equal(plan.messages.at(-1).content, pending.text);
  assert.match(plan.messages[0].content, /^msg-/);
  assert.equal(plan.messages[0].role, 'user');
  assert.equal(plan.stats.omittedMessageCount + plan.messages.length, 10001);
  assert.equal(plan.stats.wireBytes, Buffer.byteLength(JSON.stringify(plan.messages)));
  assert.ok(plan.warnings.some(w => w.code === 'CONTEXT_HISTORY_TRUNCATED'));
  assert.equal(JSON.stringify(root), before);
});

test('planner watermark: optional smaller limits reach actual compiler, not a parallel formula', () => {
  const root = card('r', history(12));
  const plan = buildContextPlan({ cards: [root], targetCard: root, pendingUserMessage: pending, contextLimits: { maxMessages: 6, targetMessages: 4 } });
  assert.deepEqual(plan.messages.map(m => m.content), ['msg-10', 'msg-11', pending.text]);
});

test('planner watermark: explicit reference and pending attachments stay complete or fail closed', () => {
  const root = card('r', history(12), { contextRefs: [{ id: 'ref-1', sourceCardId: 'source', sourceTitle: 's', text: '显式原文' }] });
  const p = { role: 'user', text: '问', attachments: [{ name: 'a.txt', content: '附件原文' }] };
  const ok = buildContextPlan({ cards: [root], targetCard: root, pendingUserMessage: p, contextLimits: { maxMessages: 3 } });
  assert.equal(ok.isRequestReady, true);
  assert.match(ok.messages.at(-1).content, /显式原文/);
  assert.match(ok.messages.at(-1).content, /附件原文/);
  const bad = buildContextPlan({ cards: [root], targetCard: root, pendingUserMessage: p, contextLimits: { maxBytes: 80 } });
  assert.equal(bad.isRequestReady, false);
  assert.deepEqual(bad.messages, []);
  assert.equal(bad.errors[0].code, 'CONTEXT_PENDING_TOO_LARGE');
});

test('planner watermark: oldest attachment body is not materialized after newest suffix fills budget', () => {
  let touched = false;
  const attachment = { name: 'old.txt', get content() { touched = true; throw new Error('old body read'); } };
  const root = card('r', [{ role: 'user', text: 'old', attachments: [attachment] }, { role: 'assistant', text: 'old answer' }, ...history(12)]);
  const plan = buildContextPlan({ cards: [root], targetCard: root, pendingUserMessage: pending, contextLimits: { maxMessages: 4 } });
  assert.equal(plan.errors.length, 0);
  assert.equal(touched, false);
});

test('planner watermark: exclude and unrelated branches remain excluded under pruning', () => {
  const secret = card('secret', history(200).map(m => ({ ...m, text: 'NEVER_INCLUDE' })), { contextMode: 'exclude' });
  const other = card('other', [{ role: 'user', text: 'OTHER_BRANCH' }]);
  const target = card('t', history(200), { parentId: secret.id });
  const plan = buildContextPlan({ cards: [secret, other, target], targetCard: target, pendingUserMessage: pending, contextLimits: { maxMessages: 8 } });
  assert.equal(plan.isRequestReady, true);
  assert.ok(!JSON.stringify(plan.messages).includes('NEVER_INCLUDE'));
  assert.ok(!JSON.stringify(plan.messages).includes('OTHER_BRANCH'));
  assert.deepEqual(plan.excludedCardIds, ['secret']);
});

test('planner watermark: no pending remains not-ready even when preview is trimmed', () => {
  const root = card('r', history(1000));
  const plan = buildContextPlan({ cards: [root], targetCard: root });
  assert.equal(plan.isRequestReady, false);
  assert.ok(plan.messages.length <= 192);
});

test('HTTP watermark: oversize initial request rejected before profile or model, ordinary request still works', async () => {
  let profileCalls = 0, modelCalls = 0;
  const chat = createChatService({ models: { async *streamEvents() { modelCalls++; yield { type: 'text-delta', delta: 'ok' }; yield { type: 'done' }; } } }, {
    getAgentFullProfile: async () => { profileCalls++; return { provider: 'p', model: 'm' }; },
  });
  const context = messages => ({
    get: key => key === 'appRequestContext' ? { appId: 'fork-chat', principal: { kind: 'app', principalId: 'synthetic' } } : undefined,
    req: { json: async () => ({ requestId: 'synthetic-watermark', agentId: 'agent', cardId: 'c', messages }) },
    json: (data, status = 200) => Response.json(data, { status }),
  });
  for (const messages of [Array.from({ length: 257 }, () => ({ role: 'user', content: 'x' })), [{ role: 'user', content: '汉'.repeat(180000) }]]) {
    const response = await chat.handleStream(context(messages));
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'CONTEXT_REQUEST_TOO_LARGE');
  }
  assert.equal(profileCalls, 0); assert.equal(modelCalls, 0);
  const response = await chat.handleStream(context([{ role: 'user', content: 'ok' }]));
  assert.ok((await response.text()).includes('done'));
  assert.equal(modelCalls, 1);
});
