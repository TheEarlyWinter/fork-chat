import test from 'node:test';
import assert from 'node:assert/strict';
import { createMergeController } from '../ui/assets/panel-merge.js';

function makeHarness(options = {}) {
  const multiSelectedCardIds = options.multiSelectedCardIds || new Set();
  const c1 = {
    id: 'c1',
    parentId: null,
    title: '分支A 方案',
    x: 100,
    y: 100,
    width: 340,
    messages: [
      { role: 'user', content: '如何优化缓存？' },
      { role: 'assistant', text: '使用多级 LRU 缓存策略。', status: 'completed' },
    ],
  };
  const c2 = {
    id: 'c2',
    parentId: null,
    title: '分支B 方案',
    x: 200,
    y: 300,
    width: 340,
    messages: [
      { role: 'user', text: '如何优化缓存？' },
      { role: 'assistant', text: '使用分布式 Redis 缓存。', status: 'completed' },
    ],
  };
  let cards = options.cards || [c1, c2];
  let selectedCardId = options.selectedCardId ?? null;
  let disposed = false;
  let canvasCanMutate = true;
  let renderCardsCount = 0;
  let saveCount = 0;
  let snapshotRecord = null;
  let fitCluster = null;
  let sentPrompt = null;
  const contextIssues = [];
  let nextUniqueId = 1;
  const note = label => { if (Array.isArray(options.order)) options.order.push(label); };

  const domElements = new Map();
  function getOrCreateDom(id) {
    if (!domElements.has(id)) {
      domElements.set(id, {
        id,
        classList: {
          _classes: new Set(),
          add(cls) { this._classes.add(cls); },
          remove(cls) { this._classes.delete(cls); },
          contains(cls) { return this._classes.has(cls); },
        },
      });
    }
    return domElements.get(id);
  }

  const documentRef = {
    getElementById: id => getOrCreateDom(id),
  };

  const mergeToolbar = { hidden: true };
  const mergeCountText = { textContent: '' };
  const btnMergeCancel = { addEventListener() {} };
  const btnMergeSubmit = { addEventListener() {} };
  const eventListeners = [];
  function listen(target, type, handler, _options, cleanups) {
    const entry = { target, type, handler };
    eventListeners.push(entry);
    cleanups?.add?.(() => {
      const idx = eventListeners.indexOf(entry);
      if (idx !== -1) eventListeners.splice(idx, 1);
    });
  }

  const deps = {
    multiSelectedCardIds,
    getCards: () => cards,
    getSelectedCardId: () => selectedCardId,
    canMutateCanvas: () => canvasCanMutate,
    isDisposed: () => disposed,
    chainIsBusy: card => card.busy === true,
    calculateBranchYPositions: options.calculateBranchYPositions || ((parent, count, targetX) => {
      const step = (targetX - parent.x) + (parent.width || 0);
      return Array.from({ length: count }, (_value, index) => parent.y + step + index * step);
    }),
    fitViewportToCluster: options.fitViewportToCluster || (clusterCards => {
      note('fitViewportToCluster');
      fitCluster = clusterCards;
    }),
    renderCards: () => {
      note('renderCards');
      renderCardsCount += 1;
    },
    scheduleSave: () => {
      note('scheduleSave');
      saveCount += 1;
    },
    recordSnapshot: options.recordSnapshot || ((c, sId) => {
      note('recordSnapshot');
      snapshotRecord = { cards: [...c], sId };
    }),
    sendCardPrompt: options.sendCardPrompt || ((card, prompt) => {
      note('sendCardPrompt');
      sentPrompt = { card, prompt };
    }),
    reportContextIssue: issue => { contextIssues.push(issue); },
    uniqueId: prefix => `${prefix}_${nextUniqueId++}`,
    outputFor: msg => ({ body: msg.text || '' }),
    documentRef,
    mergeToolbar,
    mergeCountText,
    btnMergeCancel,
    btnMergeSubmit,
    listen,
  };
  const controller = createMergeController(deps);

  return {
    controller,
    deps,
    multiSelectedCardIds,
    getCards: () => cards,
    setCards: next => { cards = next; },
    setSelectedCardId: id => { selectedCardId = id; },
    setDisposed: d => { disposed = d; },
    setCanMutate: m => { canvasCanMutate = m; },
    getRenderCardsCount: () => renderCardsCount,
    getSaveCount: () => saveCount,
    getSnapshotRecord: () => snapshotRecord,
    getFitCluster: () => fitCluster,
    getSentPrompt: () => sentPrompt,
    getContextIssues: () => contextIssues,
    mergeToolbar,
    mergeCountText,
    domElements,
    eventListeners,
    c1,
    c2,
  };
}

test('panel-merge: reportContextIssue is a required port and excluded-only merge reports a structured refusal', async () => {
  const h = makeHarness();
  const withoutReport = { ...h.deps };
  delete withoutReport.reportContextIssue;
  assert.throws(() => createMergeController(withoutReport), /reportContextIssue|依赖|函数/i);

  h.c1.contextMode = 'exclude';
  h.multiSelectedCardIds.add('c1');
  h.multiSelectedCardIds.add('c2');
  const before = h.getCards().length;
  assert.equal(await h.controller.createMergeCardFromSelected(), null);
  assert.equal(h.getCards().length, before);
  assert.equal(h.getContextIssues().length, 1);
  assert.match(String(h.getContextIssues()[0]?.message || h.getContextIssues()[0]), /至少要两条|排除|合流/);
});

test('panel-merge: toggleMultiSelectCard respects canvas mutation guard and includes previous selectedCardId on first selection', () => {
  const h = makeHarness({ selectedCardId: 'c1' });

  // 1. 测试 canMutateCanvas 为 false 时不执行任何改动
  h.setCanMutate(false);
  h.controller.toggleMultiSelectCard('c2');
  assert.equal(h.multiSelectedCardIds.size, 0);

  // 2. canMutateCanvas 允许时，首次点选 c2，应连同原选中的 c1 一并加入多选
  h.setCanMutate(true);
  h.controller.toggleMultiSelectCard('c2');
  assert.equal(h.multiSelectedCardIds.size, 2);
  assert.ok(h.multiSelectedCardIds.has('c1'));
  assert.ok(h.multiSelectedCardIds.has('c2'));

  // 3. 再次点选 c2 应反选移除
  h.controller.toggleMultiSelectCard('c2');
  assert.equal(h.multiSelectedCardIds.size, 1);
  assert.ok(!h.multiSelectedCardIds.has('c2'));
  assert.ok(h.multiSelectedCardIds.has('c1'));
});

test('panel-merge: updateMultiSelectionUI toggles DOM class and shows/hides merge toolbar with formatted count', () => {
  const h = makeHarness();

  h.controller.toggleMultiSelectCard('c1');
  assert.equal(h.mergeToolbar.hidden, true);
  assert.ok(h.domElements.get('dom-c1').classList.contains('is-multi-selected'));

  h.controller.toggleMultiSelectCard('c2');
  assert.equal(h.mergeToolbar.hidden, false);
  assert.equal(h.mergeCountText.textContent, '已选 2 个分支');
  assert.ok(h.domElements.get('dom-c2').classList.contains('is-multi-selected'));

  h.controller.clearMultiSelect();
  assert.equal(h.multiSelectedCardIds.size, 0);
  assert.equal(h.mergeToolbar.hidden, true);
  assert.ok(!h.domElements.get('dom-c1').classList.contains('is-multi-selected'));
  assert.ok(!h.domElements.get('dom-c2').classList.contains('is-multi-selected'));
});

test('panel-merge: clearMultiSelect is guarded against disposed state', () => {
  const h = makeHarness();
  h.multiSelectedCardIds.add('c1');
  h.setDisposed(true);

  h.controller.clearMultiSelect();
  // 已销毁状态下不应清空或更新
  assert.equal(h.multiSelectedCardIds.size, 1);

  h.setDisposed(false);
  h.controller.clearMultiSelect();
  assert.equal(h.multiSelectedCardIds.size, 0);
});

test('panel-merge: synthesizeMergePrompt extracts questions, answers, and truncates long conclusions with exact marker', () => {
  const h = makeHarness();
  const longConclusion = 'A'.repeat(700);
  const cardLong = {
    id: 'c_long',
    title: '超长结论分支',
    messages: [
      { role: 'user', text: '长问题' },
      { role: 'assistant', text: longConclusion, status: 'completed' },
    ],
  };

  const prompt = h.controller.synthesizeMergePrompt([h.c1, cardLong]);
  const expectedPrompt = `你现在作为首席架构裁判与决策顾问，请对以下 2 个独立探索分支的推导结论进行深度交叉对比与合流收敛：\n\n### 分支 #1：分支A 方案\n- **探讨问题**：如何优化缓存？\n- **推导结论要点**：\n使用多级 LRU 缓存策略。\n\n### 分支 #2：超长结论分支\n- **探讨问题**：长问题\n- **推导结论要点**：\n${'A'.repeat(600)}… [已截断核心]\n\n---\n【合流裁决任务】：\n1. **核心共识与关键分歧**：提炼各个分支方案的交集共识与核心分歧点；\n2. **适用边界与权衡代价 (Trade-offs)**：客观剖析各方案在性能、复杂度、可靠性及维护成本上的利弊得失；\n3. **终局综合决策方案**：给出最终的落地裁决意见与明确的执行路线。`;
  assert.equal(prompt, expectedPrompt);
  assert.equal(prompt.includes(`${'A'.repeat(600)}… [已截断核心]`), true);
  assert.equal(prompt.includes('A'.repeat(601)), false);
});

test('panel-merge: createMergeCardFromSelected guards against busy cards, creates merge node with complete fields, and adheres to step order', async () => {
  const order = [];
  const selectedIds = new Set(['c1', 'c2']);
  selectedIds.clear = () => {
    order.push('clearMultiSelect');
    Set.prototype.clear.call(selectedIds);
  };
  const h = makeHarness({ order, multiSelectedCardIds: selectedIds });

  // 若存在 busy 卡片，拒绝创建
  h.c1.busy = true;
  const busyResult = await h.controller.createMergeCardFromSelected();
  assert.equal(busyResult, null);
  h.c1.busy = false;

  // 成功创建合流卡
  const origPush = h.getCards().push.bind(h.getCards());
  h.getCards().push = (...args) => {
    order.push('push');
    return origPush(...args);
  };

  const mergeCard = await h.controller.createMergeCardFromSelected();
  assert.equal(mergeCard.id, 'merge_node_1');
  assert.equal(mergeCard.parentId, 'c1');
  assert.deepEqual(mergeCard.parentIds, ['c1', 'c2']);
  assert.equal(mergeCard.isMerge, true);
  assert.equal(mergeCard.title, '合并总结 (分支A + 分支B)');
  assert.equal(mergeCard.x, 200 + 340 + 140); // maxX + 140
  assert.equal(mergeCard.y, 340); // input-sensitive calculateBranchYPositions result
  assert.equal(mergeCard.width, 360);
  assert.deepEqual(mergeCard.messages, []);

  assert.deepEqual(order, [
    'push',
    'clearMultiSelect',
    'renderCards',
    'scheduleSave',
    'recordSnapshot',
    'fitViewportToCluster',
    'sendCardPrompt',
  ]);
  assert.equal(h.multiSelectedCardIds.size, 0);
  assert.equal(h.getRenderCardsCount(), 1);
  assert.equal(h.getSaveCount(), 1);

  const snapshot = h.getSnapshotRecord();
  assert.equal(snapshot.cards.length, 3);
  assert.equal(snapshot.cards[0], h.c1);
  assert.equal(snapshot.cards[1], h.c2);
  assert.equal(snapshot.cards[2], mergeCard);
  assert.equal(snapshot.sId, mergeCard.id);
  assert.deepEqual(h.getFitCluster(), [h.c1, h.c2, mergeCard]);

  const expectedPrompt = `你现在作为首席架构裁判与决策顾问，请对以下 2 个独立探索分支的推导结论进行深度交叉对比与合流收敛：\n\n### 分支 #1：分支A 方案\n- **探讨问题**：如何优化缓存？\n- **推导结论要点**：\n使用多级 LRU 缓存策略。\n\n### 分支 #2：分支B 方案\n- **探讨问题**：如何优化缓存？\n- **推导结论要点**：\n使用分布式 Redis 缓存。\n\n---\n【合流裁决任务】：\n1. **核心共识与关键分歧**：提炼各个分支方案的交集共识与核心分歧点；\n2. **适用边界与权衡代价 (Trade-offs)**：客观剖析各方案在性能、复杂度、可靠性及维护成本上的利弊得失；\n3. **终局综合决策方案**：给出最终的落地裁决意见与明确的执行路线。`;
  assert.equal(h.getSentPrompt().card, mergeCard);
  assert.equal(h.getSentPrompt().prompt, expectedPrompt);
});

test('panel-merge: bindToolbar wires cancel and submit to real controller behavior', async () => {
  const h = makeHarness();
  const cancelBtn = {};
  const submitBtn = {};
  const listeners = [];
  const fakeListen = (target, type, fn) => {
    listeners.push({ target, type, fn });
  };

  h.controller.bindToolbar({
    btnMergeCancel: cancelBtn,
    btnMergeSubmit: submitBtn,
    listen: fakeListen,
  });

  assert.equal(listeners.length, 2);
  const cancelListener = listeners.find(l => l.target === cancelBtn);
  const submitListener = listeners.find(l => l.target === submitBtn);
  assert.equal(typeof cancelListener?.fn, 'function');
  assert.equal(typeof submitListener?.fn, 'function');

  h.multiSelectedCardIds.add('c1');
  cancelListener.fn();
  assert.equal(h.multiSelectedCardIds.size, 0);

  h.multiSelectedCardIds.add('c1');
  h.multiSelectedCardIds.add('c2');
  submitListener.fn();
  await Promise.resolve();

  const mergeCard = h.getCards().at(-1);
  assert.equal(mergeCard.isMerge, true);
  assert.equal(mergeCard.parentId, 'c1');
  assert.deepEqual(mergeCard.parentIds, ['c1', 'c2']);
  assert.equal(h.getCards().length, 3);
  assert.equal(h.getSentPrompt().card, mergeCard);

  // 引用透明性：getMultiSelectedIds 返回同一个 Set 实例
  assert.equal(h.controller.getMultiSelectedIds(), h.multiSelectedCardIds);
});

test('panel-merge: createMergeController preserves Set identity and uses a replacement Set independently', () => {
  const oldIds = new Set(['c1']);
  const oldHarness = makeHarness({ multiSelectedCardIds: oldIds });
  assert.equal(oldHarness.controller.getMultiSelectedIds(), oldIds);

  const replacementIds = new Set(['c2']);
  const replacementHarness = makeHarness({ multiSelectedCardIds: replacementIds });
  assert.equal(replacementHarness.controller.getMultiSelectedIds(), replacementIds);

  replacementHarness.controller.clearMultiSelect();

  assert.equal(replacementIds.size, 0);
  assert.deepEqual([...oldIds], ['c1']);
  assert.equal(oldHarness.controller.getMultiSelectedIds(), oldIds);
});

test('panel-merge: merge placement uses the width fallback and the exact branch Y result', async () => {
  const makeCard = (id, title, x, y, width) => ({
    id,
    parentId: null,
    title,
    x,
    y,
    ...(width === undefined ? {} : { width }),
    messages: [
      { role: 'user', text: `问题-${id}` },
      { role: 'assistant', text: `结论-${id}`, status: 'completed' },
    ],
  });
  const cards = [
    makeCard('c1', '第一分支', 10, 20, 100),
    makeCard('c2', '第二分支', 400, 100, undefined),
    makeCard('c3', '第三分支', 250, 300, 220),
  ];
  const branchCalls = [];
  const h = makeHarness({
    cards,
    calculateBranchYPositions: (parent, count, targetX) => {
      branchCalls.push({ parent, count, targetX });
      return [615];
    },
  });
  h.multiSelectedCardIds.add('c1');
  h.multiSelectedCardIds.add('c2');
  h.multiSelectedCardIds.add('c3');

  const mergeCard = await h.controller.createMergeCardFromSelected();

  assert.equal(branchCalls.length, 1);
  assert.equal(branchCalls[0].parent.x, 740);
  assert.equal(branchCalls[0].parent.y, 140);
  assert.equal(branchCalls[0].parent.width, 0);
  assert.equal(branchCalls[0].count, 1);
  assert.equal(branchCalls[0].targetX, 880);
  assert.equal(mergeCard.x, 880);
  assert.equal(mergeCard.y, 615);
  assert.deepEqual(mergeCard.parentIds, ['c1', 'c2', 'c3']);
});

test('panel-merge: merge creation side effects occur in the exact required order', async () => {
  const order = [];
  const selectedIds = new Set(['c1', 'c2']);
  selectedIds.clear = () => {
    order.push('clearMultiSelect');
    Set.prototype.clear.call(selectedIds);
  };
  const h = makeHarness({ multiSelectedCardIds: selectedIds, order });
  const cards = h.getCards();
  const originalPush = cards.push.bind(cards);
  cards.push = (...args) => {
    order.push('push');
    return originalPush(...args);
  };

  const mergeCard = await h.controller.createMergeCardFromSelected();

  assert.deepEqual(order, [
    'push',
    'clearMultiSelect',
    'renderCards',
    'scheduleSave',
    'recordSnapshot',
    'fitViewportToCluster',
    'sendCardPrompt',
  ]);
  assert.equal(h.getSnapshotRecord().cards.length, 3);
  assert.equal(h.getSnapshotRecord().cards.at(-1), mergeCard);
});

test('panel-merge: known deviation — null historyManager skips recordSnapshot without throwing', async () => {
  const historyManager = null;
  const h = makeHarness({
    recordSnapshot: (...args) => historyManager?.recordSnapshot(...args),
  });
  h.multiSelectedCardIds.add('c1');
  h.multiSelectedCardIds.add('c2');

  await assert.doesNotReject(() => h.controller.createMergeCardFromSelected());

  const mergeCard = h.getCards().at(-1);
  assert.equal(mergeCard.isMerge, true);
  assert.equal(h.getCards().length, 3);
  assert.equal(h.getSnapshotRecord(), null);
  assert.equal(h.getRenderCardsCount(), 1);
  assert.equal(h.getSaveCount(), 1);
});
