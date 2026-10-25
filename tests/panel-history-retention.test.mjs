import test from 'node:test';
import assert from 'node:assert/strict';
import { cloneCardTopology, createHistoryManager } from '../ui/assets/panel-history.js';
import { createHistoryController } from '../ui/assets/panel-history-controller.js';
import { createCanvasActions } from '../ui/assets/panel-canvas-actions.js';
import { createSessionState } from '../ui/assets/panel-session-state.js';

const topology = (id, x = 0, extra = {}) => ({
  id,
  x,
  y: 0,
  width: 340,
  height: 360,
  parentId: null,
  ...extra,
});

const businessCard = (id, x = 0, extra = {}) => ({
  ...topology(id, x, extra),
  messages: [{ role: 'assistant', text: `初始-${id}` }],
  docContent: `文档-${id}`,
  attachments: [{ name: `${id}.txt`, bytes: [1, 2, 3] }],
});

function controllerHarness(initialCards, archive = new Map(), options = {}) {
  let cards = initialCards;
  let selectedCardId = initialCards[0]?.id ?? null;
  const manager = createHistoryController({
    getCards: () => cards,
    setCards: next => { cards = next; },
    getSelectedCardId: () => selectedCardId,
    setSelectedCardId: next => { selectedCardId = next; },
    getRemovedCardArchive: () => archive,
    renderCards: () => {},
    renderConnectors: () => {},
    scheduleSave: () => {},
    isDisposed: () => false,
    maxRetainedBytes: options.maxRetainedBytes,
    onBudgetTrim: options.onBudgetTrim,
  });
  return {
    manager,
    archive,
    get cards() { return cards; },
    get selectedCardId() { return selectedCardId; },
    setCards(next) { cards = next; },
  };
}

function productionCanvasHarness(initialCards, options = {}) {
  let cards = initialCards;
  let selectedCardId = initialCards[0]?.id ?? null;
  let history;
  const actions = createCanvasActions({
    getCards: () => cards,
    setCards: next => { cards = next; },
    getSelectedCardId: () => selectedCardId,
    setSelectedCardId: next => { selectedCardId = next; },
    multiSelectedCardIds: new Set(),
    canMutateCanvas: () => true,
    chainIsBusy: () => false,
    isBusy: () => false,
    isModalOpen: () => false,
    abortActiveRequest: () => {},
    abortDocumentTasksFor: () => {},
    calculateBranchYPositions: () => [],
    recordSnapshot: (next, selectedId) => history?.recordSnapshot(next, selectedId),
    renderCards: () => {},
    scheduleSave: () => {},
    getSessionController: () => ({ generation: 1 }),
    initialSnapshot: () => ({}),
    extractDocumentFile: async () => ({ ok: false }),
    isDisposed: () => false,
  });
  history = createHistoryController({
    getCards: () => cards,
    setCards: next => { cards = next; },
    setSelectedCardId: next => { selectedCardId = next; },
    getRemovedCardArchive: () => actions.removedCardArchive,
    renderCards: () => {},
    renderConnectors: () => {},
    scheduleSave: () => {},
    isDisposed: () => false,
    maxRetainedBytes: options.maxRetainedBytes,
    onBudgetTrim: options.onBudgetTrim,
  });
  return {
    actions,
    history,
    get cards() { return cards; },
    get selectedCardId() { return selectedCardId; },
    setCards(next) { cards = next; },
  };
}

test('panel-history: cloneCardTopology is a pure own-field metadata projection and never reads business payloads', () => {
  let payloadReads = 0;
  const card = Object.create({ title: 'inherited title', messages: [] });
  Object.assign(card, {
    id: 'card-1', x: 10, y: 20, width: 340, height: 360,
    isCollapsed: false, zIndex: 7, parentId: null,
    parentIds: ['root'], statusStamp: 'working',
  });
  for (const key of ['messages', 'docContent', 'attachments']) {
    Object.defineProperty(card, key, {
      enumerable: true,
      get() {
        payloadReads += 1;
        throw new Error(`${key} must not be read by a layout snapshot`);
      },
    });
  }

  const projected = cloneCardTopology(card);

  assert.deepEqual(Object.keys(projected).sort(), [
    'height', 'id', 'isCollapsed', 'parentId', 'parentIds', 'statusStamp', 'width', 'x', 'y', 'zIndex',
  ]);
  assert.equal(projected.title, undefined, '继承属性不得进入布局快照');
  assert.notStrictEqual(projected.parentIds, card.parentIds, 'parentIds 必须只复制数组本身');
  projected.parentIds.push('mutated');
  assert.deepEqual(card.parentIds, ['root']);
  assert.equal(payloadReads, 0, '布局快照不能读取 messages/docContent/attachments');
});

test('panel-history: thirty layout records retain one latest business reference instead of thirty payload copies', () => {
  const card = businessCard('card-1');
  card.messages.push({ role: 'assistant', text: 'A'.repeat(4000) });
  const manager = createHistoryManager({ onRestore() {} });

  manager.syncCards([card]);
  for (let step = 0; step < 30; step += 1) {
    card.x = step * 10;
    manager.recordSnapshot([card], card.id);
  }

  const stats = manager.getStats();
  assert.equal(stats.contentCount, 1, '同一 card id 只能保留一份业务对象引用');
  assert.equal(new Set(manager.getRetainedCardIds()).size, 1);
  assert.equal(stats.retainedBytes, 0, '当前画布内容不计入 retainedBytes');
  assert.equal(stats.maxRetainedBytes, 64 * 1024 * 1024);
  assert.equal(stats.trimmedCount, 0, '未超预算时不应误报裁剪');
});

test('panel-history: repeated recordSnapshot never evaluates business getters', () => {
  let reads = 0;
  const card = topology('getter-card');
  for (const key of ['messages', 'docContent', 'attachments']) {
    Object.defineProperty(card, key, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(`${key} must not be read by recordSnapshot`);
      },
    });
  }
  const manager = createHistoryManager({ onRestore() {} });

  for (let step = 0; step < 30; step += 1) {
    card.x = step;
    manager.recordSnapshot([card], card.id);
  }

  assert.equal(reads, 0);
  assert.equal(manager.getStats().contentCount, 1);
});

test('panel-history: layout undo keeps completed answer and removes optional topology fields absent from target snapshot', () => {
  const card = businessCard('card-1');
  const h = controllerHarness([card]);
  h.manager.recordSnapshot([card], card.id);

  card.x = 500;
  card.statusStamp = 'working';
  h.manager.recordSnapshot([card], card.id);
  card.messages.push({ role: 'assistant', text: '完整回答正文' });
  card.docContent = '问答完成后的正文';
  const identity = card;

  assert.equal(h.manager.undo(), true);
  assert.strictEqual(h.cards[0], identity, '布局撤销必须保持现存业务对象身份');
  assert.equal(h.cards[0].x, 0);
  assert.equal(h.cards[0].statusStamp, undefined, '目标快照没有的可选属性必须从 live card 删除');
  assert.equal(h.cards[0].messages.at(-1).text, '完整回答正文');
  assert.equal(h.cards[0].docContent, '问答完成后的正文');
});

test('panel-history: after undo, edit/delete then redo restores the latest content rather than stale history payloads', () => {
  const root = businessCard('root');
  const child = businessCard('child', 500, { parentId: 'root', parentIds: ['root'] });
  const h = controllerHarness([root]);
  h.manager.recordSnapshot([root], root.id);

  h.setCards([root, child]);
  h.manager.recordSnapshot(h.cards, child.id);
  assert.equal(h.manager.undo(), true);
  assert.deepEqual(h.cards.map(c => c.id), ['root']);

  root.messages.push({ role: 'assistant', text: '撤销后新增消息' });
  root.docContent = '撤销后的最新文档';
  h.setCards([]); // 编辑后删除当前对象，再重做创建步骤
  assert.equal(h.manager.redo(), true);

  const restoredRoot = h.cards.find(card => card.id === 'root');
  const restoredChild = h.cards.find(card => card.id === 'child');
  assert.ok(restoredRoot && restoredChild, 'redo 必须完整恢复两张卡');
  assert.equal(restoredRoot.messages.at(-1).text, '撤销后新增消息');
  assert.equal(restoredRoot.docContent, '撤销后的最新文档');
  assert.equal(restoredChild.messages[0].text, '初始-child');
  assert.equal(restoredChild.docContent, '文档-child');
});

test('panel-history: deleting more than forty cards restores every latest document and attachment', () => {
  const root = businessCard('card-0');
  const allCards = [root];
  for (let i = 1; i < 45; i += 1) {
    allCards.push(businessCard(`card-${i}`, i * 400, { parentId: root.id, parentIds: [root.id] }));
  }
  const latestById = new Map();
  const h = productionCanvasHarness(allCards);
  h.history.recordSnapshot(h.cards, root.id);
  for (const card of allCards) {
    card.messages.push({ role: 'assistant', text: `最新回答-${card.id}` });
    card.docContent = `最新文档-${card.id}`;
    card.attachments = [{ name: `latest-${card.id}.bin`, bytes: [9, 8, 7] }];
    latestById.set(card.id, card);
  }

  h.actions.closeCardHierarchy(root);
  assert.deepEqual(h.cards, []);
  assert.strictEqual(h.actions.removedCardArchive.get('card-44'), allCards[44], '快速归档必须按引用保存');
  assert.equal(h.history.undo(), true);

  assert.equal(h.cards.length, allCards.length, '整批删除超过 archive 上限也必须完整恢复');
  for (const restored of h.cards) {
    const original = latestById.get(restored.id);
    assert.equal(restored.docContent, `最新文档-${restored.id}`);
    assert.strictEqual(restored.attachments, original.attachments);
    assert.equal(restored.messages.at(-1).text, `最新回答-${restored.id}`);
  }
});

test('panel-history: production archive survives delete→undo→edit→redo→undo with latest content', () => {
  const original = businessCard('card-1');
  const h = productionCanvasHarness([original]);
  h.history.recordSnapshot(h.cards, original.id);

  h.actions.closeCardHierarchy(original);
  assert.deepEqual(h.cards, []);
  assert.equal(h.history.undo(), true);
  const restoredAfterUndo = h.cards[0];
  assert.notStrictEqual(restoredAfterUndo, original, '删除撤销允许生成新对象，但必须来自最新内容池');

  restoredAfterUndo.docContent = '撤销后重新编辑的正文';
  restoredAfterUndo.attachments = [{ name: 'after-undo.bin', bytes: [4, 5, 6] }];
  assert.equal(h.history.redo(), true, 'redo 必须重新执行删除');
  assert.deepEqual(h.cards, []);
  assert.equal(h.history.undo(), true, '再次 undo 必须恢复修改后的业务内容');
  assert.equal(h.cards[0].docContent, '撤销后重新编辑的正文');
  assert.deepEqual(h.cards[0].attachments, [{ name: 'after-undo.bin', bytes: [4, 5, 6] }]);
});

test('panel-history: retention budget trims a whole unreachable state, never an empty topology shell', () => {
  const oldCard = businessCard('old');
  oldCard.messages = [{ role: 'assistant', text: 'X'.repeat(500) }];
  const currentCard = businessCard('current');
  const manager = createHistoryManager({ maxRetainedBytes: 64, onRestore() {} });

  manager.syncCards([oldCard]);
  manager.recordSnapshot([oldCard], oldCard.id);
  manager.syncCards([currentCard]);
  manager.recordSnapshot([currentCard], currentCard.id);

  const stats = manager.getStats();
  assert.equal(stats.undoCount, 1, '超预算必须淘汰完整最旧 undo 状态');
  assert.equal(stats.redoCount, 0);
  assert.equal(manager.canUndo(), false, '裁剪后不应留下不可恢复的空壳 undo 步');
  assert.ok(stats.trimmedCount >= 1);
  assert.deepEqual(new Set(manager.getRetainedCardIds()), new Set(['current']));
});

test('panel-history: budget trim releases shared archive, notifies once, and clear allows a second notification', () => {
  const old = businessCard('old');
  const notices = [];
  const h = productionCanvasHarness([old], {
    maxRetainedBytes: 0,
    onBudgetTrim: stats => notices.push({ budgetTrimmedCount: stats.budgetTrimmedCount, retainedBytes: stats.retainedBytes }),
  });
  h.history.recordSnapshot(h.cards, old.id);
  h.history.recordSnapshot(h.cards, old.id);
  h.history.recordSnapshot(h.cards, old.id);
  h.actions.rememberRemovedCard(old);
  old.docContent = '预算触发前才变大的正文'.repeat(200);
  h.setCards([]);
  h.history.syncCards([]);

  assert.equal(h.actions.removedCardArchive.size, 0, '预算裁剪后共享 archive 不得保留孤儿引用');
  assert.equal(notices.length, 1, '一次预算操作只通知一次');
  assert.ok(notices[0].budgetTrimmedCount >= 1);
  assert.equal(h.history.getStats().retainedBytes, 0);

  h.history.clear();
  assert.equal(h.history.getStats().budgetTrimmedCount, 0);
  assert.equal(h.actions.removedCardArchive.size, 0);

  const live = businessCard('live');
  h.setCards([live]);
  h.history.recordSnapshot([live], live.id);
  h.history.syncCards([live]);
  assert.strictEqual(h.cards[0], live, '当前画布卡片不能被预算裁剪');
  assert.equal(h.history.getStats().retainedBytes, 0);
  h.setCards([]);
  h.history.syncCards([]);
  assert.equal(notices.length, 2, 'clear 后新的预算裁剪必须再次通知');
  assert.equal(h.history.getStats().contentCount, 0);
});

test('panel-history: zero-budget syncCards([]) removes the last baseline and every orphan', () => {
  const baseline = businessCard('baseline');
  const manager = createHistoryManager({ maxRetainedBytes: 0, onRestore() {} });
  manager.recordSnapshot([baseline], baseline.id);
  manager.syncCards([]);

  const stats = manager.getStats();
  assert.equal(stats.undoCount, 0);
  assert.equal(stats.redoCount, 0);
  assert.equal(stats.contentCount, 0);
  assert.equal(stats.retainedBytes, 0);
  assert.equal(manager.getRetainedCardIds().size, 0);
});

test('panel-history: redo truncation and clear release retained content references', () => {
  const a = businessCard('a');
  const b = businessCard('b');
  const c = businessCard('c');
  const manager = createHistoryManager({ onRestore() {} });

  manager.syncCards([a]);
  manager.recordSnapshot([a], 'a');
  manager.syncCards([a, b]);
  manager.recordSnapshot([a, b], 'b');
  assert.equal(manager.undo(), true);
  assert.equal(manager.canRedo(), true);

  manager.syncCards([a, c]);
  manager.recordSnapshot([a, c], 'c');
  assert.equal(manager.canRedo(), false);
  assert.equal(new Set(manager.getRetainedCardIds()).has('b'), false, 'redo 截断后不得继续留住 b 的业务对象');

  manager.clear();
  assert.equal(new Set(manager.getRetainedCardIds()).size, 0);
  assert.equal(manager.getStats().contentCount, 0);
  assert.equal(manager.getStats().retainedBytes, 0);
});

test('panel-session-state: applySnapshot(null) clears archive and history for a new session', () => {
  const archive = new Map([['card-1', businessCard('card-1')]]);
  let cards = [businessCard('card-1')];
  let clearHistoryCalls = 0;
  const view = { x: 1, y: 2, scale: 1.5, isDragging: true };
  const state = createSessionState({
    documentRef: { getElementById: () => null },
    getCards: () => cards,
    setCards: next => { cards = next; },
    getView: () => view,
    getSelectedCardId: () => null,
    getCurrentAgent: () => ({ id: 'agent', name: 'Agent', model: 'model', provider: 'provider' }),
    getReasoningEffort: () => null,
    getIsDisposed: () => false,
    initialCards: () => [],
    clearRemovedCardArchive: () => archive.clear(),
    restoreAgent: () => {},
    updateHeaderStatus: () => {},
    updateTransform: () => {},
    renderCards: () => {},
    clearHistory: () => { clearHistoryCalls += 1; },
    recordSnapshot: () => { throw new Error('null snapshot must not create a new history step'); },
    abortAllDocumentTasks: () => {},
    cancelAllRequests: () => {},
    getSessionController: () => ({ generation: 1 }),
    bus: { postMessage() {} },
    canvasId: 'canvas-1',
  });

  state.applySnapshot(null);

  assert.deepEqual(cards, []);
  assert.equal(archive.size, 0);
  assert.equal(clearHistoryCalls, 1, '跨会话 null 快照必须清历史');
  assert.deepEqual(view, { x: 60, y: 40, scale: 1, isDragging: false });
});
