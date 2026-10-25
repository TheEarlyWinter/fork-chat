import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvasActions } from '../ui/assets/panel-canvas-actions.js';

// 删除预检的接线：删一张被排除的来源，不能让别处的引用悄悄复活。
// 纯函数规则在 context-policy 里测过，这里只验证 closeCardHierarchy 真的会停下来。

function makeActions({ cards, messages = [] }) {
  let current = cards;
  let selected = null;
  const actions = createCanvasActions({
    getCards: () => current,
    setCards: next => { current = next; },
    getSelectedCardId: () => selected,
    setSelectedCardId: id => { selected = id; },
    canMutateCanvas: () => true,
    chainIsBusy: () => false,
    abortActiveRequest: () => {},
    abortDocumentTasksFor: () => {},
    calculateBranchYPositions: (_card, _n, x) => [0, x],
    renderCards: () => {},
    scheduleSave: () => {},
    recordSnapshot: () => {},
    extractDocumentFile: async () => ({ ok: false }),
    initialSnapshot: () => ({ cards: [], view: { x: 0, y: 0, scale: 1 }, agent: null }),
    getSessionController: () => ({}),
    uniqueId: prefix => `${prefix}-test`,
    flashMessage: message => messages.push(message),
    isDisposed: () => false,
  });
  return { actions, getCards: () => current };
}

const card = (id, overrides = {}) => ({ id, title: `卡 ${id}`, parentId: null, x: 0, y: 0, width: 340, messages: [], ...overrides });

test('删除预检：被排除的来源还有外部引用时整次拆除被拒绝', () => {
  const messages = [];
  const source = card('src', { contextMode: 'exclude' });
  const owner = card('owner', {
    contextRefs: [{ id: 'ref_1', sourceCardId: 'src', sourceTitle: '来源', text: '原文' }],
  });
  const { actions, getCards } = makeActions({ cards: [source, owner], messages });
  actions.closeCardHierarchy(source);
  assert.equal(getCards().length, 2, '一张卡都不能少');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /引用/);
});

test('删除预检：来源是 include 时照常删除，引用保留快照', () => {
  const messages = [];
  const source = card('src');
  const owner = card('owner', {
    contextRefs: [{ id: 'ref_1', sourceCardId: 'src', sourceTitle: '来源', text: '原文' }],
  });
  const { actions, getCards } = makeActions({ cards: [source, owner], messages });
  actions.closeCardHierarchy(source);
  assert.equal(getCards().length, 1);
  assert.equal(getCards()[0].id, 'owner');
  assert.equal(getCards()[0].contextRefs.length, 1, '快照应该留着');
});

test('删除预检：owner 和来源一起删时不阻塞', () => {
  const messages = [];
  const source = card('src', { contextMode: 'exclude' });
  const owner = card('owner', {
    parentId: 'src',
    contextRefs: [{ id: 'ref_1', sourceCardId: 'src', sourceTitle: '来源', text: '原文' }],
  });
  const { actions, getCards } = makeActions({ cards: [source, owner], messages });
  actions.closeCardHierarchy(source);
  assert.equal(getCards().length, 0);
  assert.equal(messages.length, 0);
});
