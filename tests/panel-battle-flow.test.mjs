import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattleFlow } from '../ui/assets/panel-battle-flow.js';

function createElement() {
  const element = {
    id: '',
    className: '',
    innerHTML: '',
    children: [],
    style: {},
    classList: {
      add() {},
      remove() {},
    },
    appendChild(child) {
      this.children.push(child);
    },
    querySelector(selector) {
      if (selector === 'input[type="checkbox"]') return { checked: false };
      return null;
    },
    focus() {},
  };
  return element;
}

function makeBattleHarness({ agents = null, cards = null, efforts = {} } = {}) {
  const parent = {
    id: 'parent',
    parentId: null,
    x: 100,
    y: 200,
    width: 340,
    messages: [{ role: 'user', text: '父卡问题' }],
  };
  let availableAgents = agents || [
    { id: 'agent-a', name: 'Agent A', model: 'model-a' },
    { id: 'agent-b', name: 'Agent B', model: 'model-b' },
  ];
  let currentCards = cards || [parent];
  const session = { generation: 1 };
  const listeners = [];
  const events = [];
  const fitCalls = [];
  const sendCalls = [];
  const snapshots = [];
  const reasoningEfforts = { ...efforts };
  const promptInput = { value: '', focus() {} };
  const agentsList = {
    innerHTML: '',
    children: [],
    appendChild(item) { this.children.push(item); },
  };
  const selectedCount = { textContent: '' };
  const error = { textContent: '' };
  const dialog = {
    showCount: 0,
    closeCount: 0,
    showModal() { this.showCount += 1; },
    close() { this.closeCount += 1; },
  };
  const btnBattleClose = {};
  const btnBattleCancel = {};
  const btnBattleSubmit = {};
  const btnUseLastPrompt = {};
  const cleanups = new Set();
  let disposed = false;
  let busy = false;
  let nextId = 0;
  let sendCardPromptImpl = async (card, text, options) => {
    sendCalls.push({ card, text, options });
  };

  const listen = (target, type, handler, options) => {
    const entry = { target, type, handler, options };
    listeners.push(entry);
    return () => {
      const index = listeners.indexOf(entry);
      if (index >= 0) listeners.splice(index, 1);
    };
  };
  const deps = {
    battleDialog: dialog,
    battlePromptInput: promptInput,
    battleAgentsList: agentsList,
    battleSelectedCount: selectedCount,
    battleDialogError: error,
    btnBattleClose,
    btnBattleCancel,
    btnBattleSubmit,
    btnUseLastPrompt,
    listen,
    documentRef: { createElement },
    getAgentReasoningEffort: agentId => reasoningEfforts[agentId] || null,
    getAvailableAgents: () => availableAgents,
    loadAvailableAgents: async () => availableAgents,
    chainIsBusy: () => busy,
    getCards: () => currentCards,
    getSession: () => session,
    getIsDisposed: () => disposed,
    canMutateCanvas: generation => !disposed && (generation === undefined || generation === session.generation),
    cardHasParent: (card, parentId) => card.parentId === parentId
      || (Array.isArray(card.parentIds) && card.parentIds.includes(parentId)),
    calculateBranchYPositions: (targetParent, count, targetX) => {
      events.push({ type: 'calculateBranchYPositions', targetParent, count, targetX });
      return Array.from({ length: count }, (_value, index) => targetParent.y + index * 380);
    },
    fitViewportToCluster: cluster => {
      events.push({ type: 'fitViewportToCluster', cluster });
      fitCalls.push(cluster);
    },
    renderCards: () => events.push({ type: 'renderCards' }),
    scheduleSave: () => events.push({ type: 'scheduleSave' }),
    recordSnapshot: (list, selectedId) => {
      events.push({ type: 'recordSnapshot', list, selectedId });
      snapshots.push({ list, selectedId });
    },
    getSelectedCardId: () => 'selected-parent',
    sendCardPrompt: (...args) => sendCardPromptImpl(...args),
    uniqueId: prefix => `${prefix}-${++nextId}`,
    cleanups,
  };
  const flow = createBattleFlow(deps);

  return {
    flow,
    deps,
    parent,
    dialog,
    promptInput,
    btnBattleSubmit,
    listeners,
    events,
    fitCalls,
    sendCalls,
    snapshots,
    session,
    get cards() { return currentCards; },
    setCards(next) { currentCards = next; },
    setAvailableAgents(next) { availableAgents = next; },
    setDisposed(next) { disposed = next; },
    setBusy(next) { busy = next; },
    setSendCardPrompt(next) { sendCardPromptImpl = next; },
  };
}

test('panel-battle-flow: disposed gate never opens the battle dialog', async () => {
  const h = makeBattleHarness();
  let openCalls = 0;
  h.flow.controller.open = async () => { openCalls += 1; };
  h.setDisposed(true);

  await h.flow.openBattleDialog(h.parent, '问题');

  assert.equal(openCalls, 0);
  assert.equal(h.dialog.showCount, 0);
});

test('panel-battle-flow: busy-chain gate never opens the battle dialog', async () => {
  const h = makeBattleHarness();
  let openCalls = 0;
  h.flow.controller.open = async () => { openCalls += 1; };
  h.setBusy(true);

  await h.flow.openBattleDialog(h.parent, '问题');

  assert.equal(openCalls, 0);
  assert.equal(h.dialog.showCount, 0);
});

test('panel-battle-flow: card-membership gate rejects a card absent from the current list', async () => {
  const h = makeBattleHarness();
  let openCalls = 0;
  h.flow.controller.open = async () => { openCalls += 1; };
  h.setCards([]);

  await h.flow.openBattleDialog(h.parent, '问题');

  assert.equal(openCalls, 0);
  assert.equal(h.dialog.showCount, 0);
});

test('panel-battle-flow: generation change after open closes the dialog', async () => {
  const h = makeBattleHarness();
  let openCalls = 0;
  let closeCalls = 0;
  h.flow.controller.open = async () => {
    openCalls += 1;
    h.session.generation = 2;
  };
  h.flow.controller.close = () => { closeCalls += 1; };

  await h.flow.openBattleDialog(h.parent, '问题');

  assert.equal(openCalls, 1);
  assert.equal(closeCalls, 1);
});

test('panel-battle-flow: three existing children make the next branch start at #4', async () => {
  const h = makeBattleHarness({ agents: [{ id: 'agent-a', name: 'Agent A', model: 'model-a' }] });
  h.cards.push(
    { id: 'child-1', parentId: h.parent.id },
    { id: 'child-2', parentId: h.parent.id },
    { id: 'child-3', parentId: h.parent.id },
  );

  await h.flow.runBattleBranches(h.parent, '对比问题', [{ id: 'agent-a', name: 'Agent A', model: 'model-a' }]);

  const newCard = h.cards.at(-1);
  assert.equal(newCard.title, '对比 #4 (Agent A)');
  assert.equal(newCard.parentId, h.parent.id);
  assert.equal(newCard.isBattle, true);
  assert.equal(h.cards.length, 5);
});

test('panel-battle-flow: card creation calls render, save, then snapshot with the new card', async () => {
  const h = makeBattleHarness({ agents: [{ id: 'agent-a', name: 'Agent A', model: 'model-a' }] });

  await h.flow.runBattleBranches(h.parent, '对比问题', [{ id: 'agent-a', name: 'Agent A', model: 'model-a' }]);

  assert.deepEqual(h.events.map(event => event.type), [
    'calculateBranchYPositions',
    'renderCards',
    'scheduleSave',
    'recordSnapshot',
    'fitViewportToCluster',
  ]);
  assert.deepEqual(
    h.events.filter(event => ['renderCards', 'scheduleSave', 'recordSnapshot'].includes(event.type)).map(event => event.type),
    ['renderCards', 'scheduleSave', 'recordSnapshot'],
  );
  assert.equal(h.snapshots.length, 1);
  assert.equal(h.snapshots[0].selectedId, 'selected-parent');
  assert.equal(h.snapshots[0].list.length, 2);
  assert.equal(h.snapshots[0].list.includes(h.cards.at(-1)), true);
});

test('panel-battle-flow: fitViewportToCluster only runs for created cards and starts with the parent', async () => {
  const populated = makeBattleHarness({ agents: [{ id: 'agent-a', name: 'Agent A', model: 'model-a' }] });
  await populated.flow.runBattleBranches(populated.parent, '对比问题', [{ id: 'agent-a', name: 'Agent A', model: 'model-a' }]);

  assert.equal(populated.fitCalls.length, 1);
  assert.equal(populated.fitCalls[0][0], populated.parent);
  assert.equal(populated.fitCalls[0].length, 2);
  assert.equal(populated.fitCalls[0][1], populated.cards.at(-1));

  const empty = makeBattleHarness({ agents: [] });
  await empty.flow.runBattleBranches(empty.parent, '没有分支', []);

  assert.equal(empty.cards.length, 1);
  assert.equal(empty.fitCalls.length, 0);
});

test('panel-battle-flow: concurrent sends preserve each agent and its reasoning effort', async () => {
  const agents = [
    { id: 'agent-a', name: 'Agent A', model: 'model-a' },
    { id: 'agent-b', name: 'Agent B', model: 'model-b' },
    { id: 'agent-c', name: 'Agent C', model: 'model-c' },
  ];
  const efforts = { 'agent-a': 'low', 'agent-b': 'high', 'agent-c': 'medium' };
  const h = makeBattleHarness({ agents, efforts });

  await h.flow.runBattleBranches(h.parent, '并发问题', agents);

  assert.equal(h.sendCalls.length, 3);
  h.sendCalls.forEach((call, index) => {
    assert.equal(call.card.parentId, h.parent.id);
    assert.equal(call.text, '并发问题');
    assert.equal(call.options.agent, agents[index]);
    assert.equal(call.options.reasoningEffort, efforts[agents[index].id]);
  });
});

test('panel-battle-flow: one rejected send is isolated by Promise.allSettled', async () => {
  const agents = [
    { id: 'agent-a', name: 'Agent A', model: 'model-a' },
    { id: 'agent-b', name: 'Agent B', model: 'model-b' },
    { id: 'agent-c', name: 'Agent C', model: 'model-c' },
  ];
  const h = makeBattleHarness({ agents });
  let failedAgent = null;
  const completedAgents = [];
  h.setSendCardPrompt(async (card, text, options) => {
    h.sendCalls.push({ card, text, options });
    if (options.agent.id === 'agent-b') {
      failedAgent = options.agent.id;
      throw new Error('agent-b failed');
    }
    completedAgents.push(options.agent.id);
  });

  await assert.doesNotReject(() => h.flow.runBattleBranches(h.parent, '容错问题', agents));

  assert.equal(failedAgent, 'agent-b');
  assert.deepEqual(completedAgents, ['agent-a', 'agent-c']);
  assert.equal(h.sendCalls.length, 3);
  assert.equal(h.cards.length, 4);
});

test('panel-battle-flow: submit filters selected ids against the available agent list', async () => {
  const agents = [
    { id: 'agent-a', name: 'Agent A', model: 'model-a' },
    { id: 'agent-b', name: 'Agent B', model: 'model-b' },
  ];
  const h = makeBattleHarness({ agents });
  await h.flow.openBattleDialog(h.parent, '初始问题');
  h.flow.controller.getSelectedAgentIds().add('missing-agent');
  h.promptInput.value = '过滤问题';

  const submit = h.listeners.find(entry => entry.target === h.btnBattleSubmit && entry.type === 'click');
  assert.equal(typeof submit?.handler, 'function');
  await submit.handler({});
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(h.sendCalls.length, 2);
  assert.deepEqual(h.sendCalls.map(call => call.options.agent.id), ['agent-a', 'agent-b']);
  assert.equal(h.cards.length, 3);
  assert.equal(h.cards.some(card => card.title?.includes('missing-agent')), false);
});
