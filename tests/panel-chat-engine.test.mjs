import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatEngine } from '../ui/assets/panel-chat-engine.js';

class TestChatError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TestChatError';
    this.code = code;
  }
}

function makeHarness() {
  const activeRequests = new Map();
  const session = { generation: 1 };
  const card = { id: 'card-1', parentId: null, messages: [] };
  const cards = [card];
  const paintCalls = [];
  let renderCount = 0;
  let saveCount = 0;
  let nextRequestId = 0;
  let disposed = false;
  let runChatImpl = async () => ({ text: 'default response' });
  const reportIssues = [];

  const deps = {
    hana: { id: 'hana-test' },
    ChatError: TestChatError,
    safeDetail: message => message,
    activeRequests,
    getCards: () => cards,
    getSession: () => session,
    getAgent: () => ({ id: 'agent-1', name: 'Test Agent', provider: 'test-provider', model: 'test-model' }),
    getReasoningEffort: () => null,
    getAgentReasoningEffort: () => null,
    buildContextPlan: (targetCard, { pendingUserMessage }) => ({
      messages: [{
        role: 'user',
        content: pendingUserMessage
          ? `context for ${targetCard.id} | ${pendingUserMessage.text}`
          : `context for ${targetCard.id}`,
      }],
      errors: [],
      warnings: [],
      isRequestReady: true,
    }),
    reportContextIssue: issue => { reportIssues.push(issue); },
    getIsDisposed: () => disposed,
    canMutateCanvas: generation => !disposed && (generation === undefined || generation === session.generation),
    uniqueId: prefix => `${prefix}-${++nextRequestId}`,
    paintMessage: message => { paintCalls.push(message); },
    renderCards: () => { renderCount += 1; },
    scheduleSave: () => { saveCount += 1; },
    documentRef: { getElementById: () => null },
    cardParentIds: current => (current?.parentId ? [current.parentId] : []),
    runChat: (...args) => runChatImpl(...args),
  };

  return {
    engine: createChatEngine(deps),
    deps,
    activeRequests,
    session,
    card,
    cards,
    reportIssues,
    paintCalls,
    get renderCount() { return renderCount; },
    get saveCount() { return saveCount; },
    setRunChat(next) { runChatImpl = next; },
    setGeneration(next) { session.generation = next; },
    setDisposed(next) { disposed = next; },
  };
}

test('panel-chat-engine: normal start/delta/done flow completes with concrete text and cleanup', async () => {
  const h = makeHarness();
  h.setRunChat(async (hana, body, callbacks) => {
    assert.equal(hana, h.deps.hana);
    assert.equal(body.requestId, 'req-1');
    assert.equal(body.cardId, 'card-1');
    assert.equal(body.agentId, 'agent-1');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'context for card-1 | 问候' }]);
    callbacks.onEvent({ type: 'start', provider: 'test-provider', model: 'test-model' });
    callbacks.onEvent({ type: 'text-delta', delta: '你好，' });
    callbacks.onEvent({ type: 'text-delta', delta: '世界。' });
    callbacks.onEvent({ type: 'done' });
    return { text: '你好，世界。' };
  });

  await h.engine.sendCardPrompt(h.card, '  问候  ');

  const userMessage = h.card.messages[0];
  const assistantMessage = h.card.messages[1];
  assert.deepEqual(userMessage, { role: 'user', text: '问候' });
  assert.equal(assistantMessage.status, 'completed');
  assert.equal(assistantMessage.text, '你好，世界。');
  assert.equal(assistantMessage.modelRef, 'test-provider/test-model');
  assert.equal(assistantMessage.streaming, false);
  assert.equal(assistantMessage.failed, undefined);
  assert.equal(h.activeRequests.has(h.card.id), false);
  assert.equal(h.renderCount, 2);
  assert.equal(h.saveCount, 6);
});

test('panel-chat-engine: generation change blocks a late event from writing', async () => {
  const h = makeHarness();
  h.setRunChat(async (_hana, _body, callbacks) => {
    h.setGeneration(2);
    callbacks.onEvent({ type: 'text-delta', delta: '旧会话正文' });
    throw new TestChatError('REQUEST_CANCELLED', 'generation changed');
  });

  await h.engine.sendCardPrompt(h.card, '旧问题');

  const assistantMessage = h.card.messages[1];
  assert.equal(assistantMessage.text, '');
  assert.equal(assistantMessage.status, 'waiting');
  assert.equal(assistantMessage.streaming, true);
  assert.equal(h.paintCalls.length, 0);
  assert.equal(h.activeRequests.size, 0);
  assert.equal(h.renderCount, 1);
  assert.equal(h.saveCount, 1);
});

test('panel-chat-engine: replacing activeRequests rejects old callbacks without touching the replacement', async () => {
  const h = makeHarness();
  const replacement = { requestId: 'req-new', message: { text: '新请求' } };
  h.setRunChat(async (_hana, _body, callbacks) => {
    h.activeRequests.set(h.card.id, replacement);
    callbacks.onEvent({ type: 'text-delta', delta: '旧请求迟到正文' });
    throw new TestChatError('REQUEST_CANCELLED', 'superseded');
  });

  await h.engine.sendCardPrompt(h.card, '重发');

  const assistantMessage = h.card.messages[1];
  assert.equal(assistantMessage.text, '');
  assert.equal(assistantMessage.status, 'cancelled');
  assert.equal(assistantMessage.failed, true);
  assert.equal(h.paintCalls.length, 0);
  assert.equal(h.activeRequests.get(h.card.id), replacement);
  h.activeRequests.delete(h.card.id);
});

test('panel-chat-engine: removing the card blocks a late callback from writing', async () => {
  const h = makeHarness();
  h.setRunChat(async (_hana, _body, callbacks) => {
    h.cards.splice(h.cards.indexOf(h.card), 1);
    callbacks.onEvent({ type: 'text-delta', delta: '已删除卡片的迟到正文' });
    throw new TestChatError('REQUEST_CANCELLED', 'card removed');
  });

  await h.engine.sendCardPrompt(h.card, '已删除问题');

  const assistantMessage = h.card.messages[1];
  assert.equal(h.cards.includes(h.card), false);
  assert.equal(assistantMessage.text, '');
  assert.equal(assistantMessage.status, 'cancelled');
  assert.equal(assistantMessage.failed, true);
  assert.equal(h.activeRequests.has(h.card.id), false);
  assert.equal(h.renderCount, 1);
  assert.equal(h.saveCount, 1);
});

test('panel-chat-engine: mood-only result becomes EMPTY_BODY failure', async () => {
  const h = makeHarness();
  h.setRunChat(async () => ({ text: '<mood>只有心境</mood>' }));

  await h.engine.sendCardPrompt(h.card, '只返回心境');

  const assistantMessage = h.card.messages[1];
  assert.equal(assistantMessage.text, '<mood>只有心境</mood>');
  assert.equal(assistantMessage.status, 'failed');
  assert.equal(assistantMessage.failed, true);
  assert.equal(assistantMessage.partial, undefined);
  assert.equal(assistantMessage.error, 'EMPTY_BODY: 模型仅返回心境或沉思，未返回正文。');
  assert.equal(assistantMessage.streaming, false);
  assert.equal(h.activeRequests.size, 0);
});

test('panel-chat-engine: provider signature error with existing body is accepted as completed', async () => {
  const h = makeHarness();
  h.setRunChat(async (_hana, _body, callbacks) => {
    callbacks.onEvent({ type: 'text-delta', delta: '完整正文' });
    throw new TestChatError(
      'APP_MODEL_PROVIDER_ERROR',
      'The model provider could not complete the request: empty thinking signature rejected',
    );
  });

  await h.engine.sendCardPrompt(h.card, '签名错误');

  const assistantMessage = h.card.messages[1];
  assert.equal(assistantMessage.text, '完整正文');
  assert.equal(assistantMessage.status, 'completed');
  assert.equal(assistantMessage.failed, false);
  assert.equal(assistantMessage.partial, undefined);
  assert.equal(assistantMessage.error, '');
  assert.equal(assistantMessage.streaming, false);
  assert.equal(h.activeRequests.size, 0);
});

test('panel-chat-engine: ordinary provider error preserves partial text but stays failed', async () => {
  const h = makeHarness();
  h.setRunChat(async (_hana, _body, callbacks) => {
    callbacks.onEvent({ type: 'text-delta', delta: '部分正文' });
    throw new TestChatError('APP_MODEL_PROVIDER_ERROR', '普通提供方连接失败');
  });

  await h.engine.sendCardPrompt(h.card, '普通错误');

  const assistantMessage = h.card.messages[1];
  assert.equal(assistantMessage.text, '部分正文');
  assert.equal(assistantMessage.status, 'failed');
  assert.equal(assistantMessage.failed, true);
  assert.equal(assistantMessage.partial, true);
  assert.equal(assistantMessage.error, 'APP_MODEL_PROVIDER_ERROR: 普通提供方连接失败');
  assert.equal(assistantMessage.streaming, false);
  assert.equal(h.activeRequests.size, 0);
});

test('panel-chat-engine: cancel receipt persists cancelConfirmed and cancelError', async () => {
  const h = makeHarness();
  h.setRunChat(async (_hana, _body, callbacks) => {
    callbacks.onCancelResult(false, '服务端未确认取消');
    throw new TestChatError('REQUEST_CANCELLED', '用户取消了本次等待。');
  });

  await h.engine.sendCardPrompt(h.card, '取消问题');

  const assistantMessage = h.card.messages[1];
  assert.equal(assistantMessage.cancelConfirmed, false);
  assert.equal(assistantMessage.cancelError, '服务端未确认取消');
  assert.equal(assistantMessage.status, 'cancelled');
  assert.equal(assistantMessage.failed, true);
  assert.equal(assistantMessage.error, 'REQUEST_CANCELLED: 用户取消了本次等待。');
  assert.equal(h.saveCount, 3);
  assert.equal(h.activeRequests.size, 0);
});

test('panel-chat-engine: finally does not delete a replacement request with the same card id', async () => {
  const h = makeHarness();
  const replacement = { requestId: 'req-replacement', message: { text: '新请求仍在运行' } };
  h.setRunChat(async () => {
    h.activeRequests.set(h.card.id, replacement);
    return { text: '旧请求结果' };
  });

  await h.engine.sendCardPrompt(h.card, '旧问题');

  const assistantMessage = h.card.messages[1];
  assert.equal(assistantMessage.text, '旧请求结果');
  assert.equal(assistantMessage.status, 'completed');
  assert.equal(h.activeRequests.get(h.card.id), replacement);
  h.activeRequests.delete(h.card.id);
});

test('panel-chat-engine: chainIsBusy checks the card, its ancestors, and the idle case', () => {
  const h = makeHarness();
  const root = { id: 'root', parentId: null, messages: [] };
  const child = { id: 'child', parentId: 'root', messages: [] };
  h.cards.splice(0, h.cards.length, root, child);

  h.activeRequests.set('child', { requestId: 'child-request' });
  assert.equal(h.engine.chainIsBusy(child), true);

  h.activeRequests.clear();
  h.activeRequests.set('root', { requestId: 'root-request' });
  assert.equal(h.engine.chainIsBusy(child), true);

  h.activeRequests.clear();
  assert.equal(h.engine.chainIsBusy(child), false);
});
