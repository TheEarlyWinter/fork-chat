import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * 水位警告可见性（2.2 专项③的 UI 接线）：
 * 引擎 ready 分支必须把 CONTEXT_HISTORY_TRUNCATED 警告报给用户，
 * 否则 lib 层裁了投影但用户看到的是模型"静默失忆"。
 * 断言落在真实引擎 sendCardPrompt 驱动路径上。
 */

const OWNER = { get: key => key === 'appRequestContext' ? { appId: 'timeline-reverser', principal: { kind: 'app', principalId: 'owner-a' } } : undefined };
const { default: engineModule } = await import('../ui/assets/panel-chat-engine.js').then(m => ({ default: m }));
const { applyContextWatermark } = await import('../ui/assets/context-watermark.js');

function makeHarness({ cards, warnings = [], resultText = '好的。' }) {
  const activeRequests = new Map();
  const issues = [];
  const deps = {
    hana: {},
    runChat: async () => ({ text: resultText }),
    ChatError: class extends Error {},
    safeDetail: v => String(v),
    activeRequests,
    getCards: () => cards,
    getSession: () => ({ generation: 1 }),
    getAgent: () => ({ id: 'a', name: 'A' }),
    getReasoningEffort: () => null,
    getAgentReasoningEffort: () => null,
    buildContextPlan: () => ({ isRequestReady: true, messages: [{ role: 'user', content: 'q' }], warnings }),
    reportContextIssue: i => issues.push(i),
    getIsDisposed: () => false,
    canMutateCanvas: () => true,
    uniqueId: p => `${p}-1`,
    paintMessage: () => {},
    renderCards: () => {},
    scheduleSave: () => {},
    cardParentIds: card => (card.parentId ? [card.parentId] : []),
  };
  const engine = engineModule.createChatEngine(deps);
  return { engine, issues };
}

const truncation = { code: 'CONTEXT_HISTORY_TRUNCATED', message: '本次上下文省略了较早的12条消息，完整历史与文档未删除', omittedMessageCount: 12, retainedMessageCount: 8 };

test('水位触发时引擎必须向用户报告截断警告（真实 sendCardPrompt 路径）', async () => {
  const card = { id: 'c1', title: 't', x: 0, y: 0, width: 300, parentId: null, messages: [] };
  const h = makeHarness({ cards: [card], warnings: [truncation] });
  const accepted = await h.engine.sendCardPrompt(card, '继续', { agent: { id: 'a', name: 'A' } });
  assert.equal(accepted, true);
  const shown = h.issues.filter(i => String(i).includes('省略了较早的12条消息'));
  assert.equal(shown.length, 1, '用户必须看到一次水位提示');
  assert.ok(String(shown[0]).includes('未删除'), '提示必须说明历史仍在');
});

test('无水位警告时不产生额外噪音', async () => {
  const card = { id: 'c1', title: 't', x: 0, y: 0, width: 300, parentId: null, messages: [] };
  const h = makeHarness({ cards: [card], warnings: [] });
  await h.engine.sendCardPrompt(card, '继续', { agent: { id: 'a', name: 'A' } });
  assert.equal(h.issues.length, 0);
});

test('无关警告（非水位）不被水位路径重复播报', async () => {
  const card = { id: 'c1', title: 't', x: 0, y: 0, width: 300, parentId: null, messages: [] };
  const h = makeHarness({ cards: [card], warnings: [{ code: 'OTHER', message: '别的提醒' }] });
  await h.engine.sendCardPrompt(card, '继续', { agent: { id: 'a', name: 'A' } });
  assert.equal(h.issues.filter(i => String(i).includes('省略了较早的')).length, 0);
});
