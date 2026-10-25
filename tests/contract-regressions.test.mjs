import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryController } from '../ui/assets/panel-history-controller.js';
import { createHistoryManager } from '../ui/assets/panel-history.js';
import { createRefController } from '../ui/assets/panel-refs.js';
import { createSelectionBranchController } from '../ui/assets/panel-selection-popover.js';
import { createCardEvents } from '../ui/assets/panel-card-events.js';
import { createChatEngine } from '../ui/assets/panel-chat-engine.js';
import { buildContextPlan } from '../ui/assets/panel-context-plan.js';
import { createContextPreview } from '../ui/assets/panel-context-preview.js';
import { normalizeForkSnapshot } from '../ui/assets/fork-session-store.js';
import { normalizeContextRefs } from '../ui/assets/fork-context-policy.js';

// 独立验收那 14 个反例转成的回归：全部走生产模块，不复制算法。
// 每条都对应一个真实违约点，改坏了会立刻红。

const noop = () => {};
const node = (tag = 'div') => ({
  tagName: tag, children: [], listeners: new Map(), events: new Map(), style: {}, dataset: {}, value: '',
  textContent: '', className: '', classList: { add: noop, remove: noop },
  addEventListener(type, fn) {
    const list = this.listeners.get(type) || [];
    list.push(fn);
    this.listeners.set(type, list);
  },
  removeEventListener(type, fn) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(f => f !== fn));
  },
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
  removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; },
  remove() { this.parentNode?.removeChild(this); },
  querySelector() { return null; }, querySelectorAll() { return []; },
  focus: noop, blur: noop,
});
const docFixture = () => Object.assign(node('document'), { body: node('body'), createElement: node, activeElement: null });
const walk = root => [root, ...root.children.flatMap(walk)];
const card = (id, extra = {}) => ({ id, title: id, parentId: null, x: 0, y: 0, width: 340, messages: [], ...extra });
const ref = (id, sourceCardId, text) => ({ id, sourceCardId, sourceTitle: sourceCardId, text });
const msg = (role, text, extra = {}) => ({ role, text, status: 'completed', ...extra });

function selectionFixture(text = 'SELECTED_TEXT', bubbleId = null) {
  const doc = docFixture();
  const cardRoot = { id: 'dom-source' };
  const row = { parentNode: cardRoot };
  const bubble = {
    nodeType: 1, parentNode: row, querySelector: () => null,
    ...(bubbleId ? { id: bubbleId } : {}),
    closest: selector => (selector === '.msg-bubble' ? bubble : selector === '.msg-row.msg-asst' ? row : null),
  };
  const range = {
    startContainer: bubble, endContainer: bubble, commonAncestorContainer: bubble,
    getBoundingClientRect: () => ({ top: 100, left: 100, width: 20 }),
  };
  doc.getSelection = () => ({
    isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => text, removeAllRanges: noop,
  });
  return { doc, bubble };
}

function refLifecyclePorts(overrides = {}) {
  return {
    getGeneration: () => 1,
    canMutateCanvas: () => true,
    getIsDisposed: () => false,
    ...overrides,
  };
}

function selectionLifecyclePorts({ doc, cards, generation = () => 1, overrides = {} } = {}) {
  return {
    getDocument: () => doc,
    getCards: () => cards,
    getGeneration: generation,
    getIsDisposed: () => false,
    canMutateCanvas: () => true,
    chainIsBusy: () => false,
    listen(target, type, handler, options, scope) {
      if (!target?.addEventListener) return noop;
      target.addEventListener(type, handler, options);
      const cleanup = () => target.removeEventListener?.(type, handler, options);
      scope?.add?.(cleanup);
      return cleanup;
    },
    reportIssue: noop,
    ...overrides,
  };
}

// --- R01：历史 facade 必须转发引用 id 集合 ---

test('R01 历史 controller 转发 getRetainedReferenceIds，引用能真正加上', () => {
  let cards = [card('owner'), card('source', { messages: [msg('assistant', '来源正文')] })];
  const controller = createHistoryController({
    getCards: () => cards,
    setCards: next => { cards = next; },
    setSelectedCardId: noop, renderCards: noop, renderConnectors: noop, scheduleSave: noop,
    removedCardArchive: new Map(),
  });
  const manager = createHistoryManager({});
  assert.equal(typeof manager.getRetainedReferenceIds, 'function');
  const ids = controller.getRetainedReferenceIds();
  assert.ok(ids instanceof Set, '必须是 Set，不能是 Map 或其他形状');
  const refs = createRefController({
    ...refLifecyclePorts(),
    getCards: () => cards,
    getRetainedReferenceIds: () => controller.getRetainedReferenceIds(),
    renderCards: noop, renderConnectors: noop, scheduleSave: noop, recordSnapshot: noop,
  });
  const result = refs.addRef('owner', { sourceCard: cards[1], text: '一段原文' });
  assert.equal(result.ok, true);
  assert.equal(cards[0].contextRefs.length, 1);
});

// --- R02：引用成功路径不能再抛错 ---

test('R02 引用加成功后不抛 ReferenceError（计数工具已正确引入）', () => {
  const cards = [card('owner'), card('source', { messages: [msg('assistant', 'QUOTE', { requestId: 'selection-r02' })] })];
  const notices = [];
  const refs = createRefController({
    ...refLifecyclePorts(),
    getCards: () => cards,
    getRetainedReferenceIds: () => new Set(),
    renderCards: noop, renderConnectors: noop, scheduleSave: noop, recordSnapshot: noop,
    flashMessage: text => notices.push(text),
  });
  const { doc, bubble } = selectionFixture('QUOTE', 'selection-r02');
  const selection = createSelectionBranchController({
    ...selectionLifecyclePorts({ doc, cards, overrides: { reportIssue: text => notices.push(text) } }),
    createBranchCard: noop,
    getSelectedCardId: () => 'owner',
    addContextRef: (ownerId, payload) => refs.addRef(ownerId, payload),
  });
  selection.inspect();
  assert.doesNotThrow(() => selection.commitReference());
  assert.equal(cards[0].contextRefs.length, 1, '引用应真的落进 owner');
  assert.ok(notices.some(t => /字节/.test(t)), '成功路径要报告引用了多少字节');
  assert.ok(bubble);
});

// --- R03 / R04：发送边界 ---

function makeCardEventsHarness({ engine, target: targetOverride, extra = {} } = {}) {
  const input = node('input');
  const cardEl = node('card');
  const header = node('header');
  const sendBtn = node('button');
  const target = targetOverride || card('target');
  const lookups = {
    '.msg-bubble': null,
    '[data-action="send"]': sendBtn,
    '[data-action="cancel"]': null,
    '[data-action="battle"]': null,
    '[data-action="branch"]': null,
    '[data-action="branch-battle"]': null,
    '[data-action="attach"]': null,
    '[data-action="close"]': null,
    '[data-action="cycle-stamp"]': null,
    '[data-action="export-chain"]': null,
    '[data-action="export-topology"]': null,
    '[data-action="toggle-context-mode"]': null,
    '[data-action="preview-context"]': null,
    '[data-action="manage-refs"]': null,
    [`#input-${target.id}`]: input,
    '.card-header': header,
  };
  cardEl.querySelector = selector => (Object.hasOwn(lookups, selector) ? lookups[selector] : null);
  cardEl.querySelectorAll = () => [];
  cardEl.contains = () => false;
  cardEl.classList = { add: noop, remove: noop };
  header.classList = { add: noop, remove: noop };
  const documentRef = { activeElement: null, body: node('body') };
  const sendCalls = [];
  const deps = {
    listen(scope, type, handler) { scope?.events?.set?.(type, handler); return noop; },
    getCardCleanups: () => new Set(),
    hana: {},
    flashMessage: noop,
    safeDetail: v => String(v),
    getSession: () => ({ generation: 1 }),
    getCards: () => [target],
    getIsDisposed: () => false,
    getIsSpacePressed: () => false,
    getSelectedCardId: () => target.id,
    getDocumentRef: () => documentRef,
    getNavigator: () => null,
    activeRequests: new Map(),
    paintMessage: noop,
    ChatError: class extends Error {},
    chainIsBusy: () => false,
    openBattleDialog: async () => {},
    documentUi: { attachFilesToCard: async () => {}, removeStagedAttachment: noop, hideDropIndicator: noop },
    cardGestures: { beginCardDrag: noop, bindResizeHandles: noop },
    createBranchCard: noop,
    closeCardHierarchy: noop,
    cycleCardStatusStamp: () => null,
    selectCard: noop,
    toggleMultiSelectCard: noop,
    clearMultiSelect: noop,
    renderCards: noop,
    renderConnectors: noop,
    scheduleSave: noop,
    recordSnapshot: noop,
    canMutateCanvas: () => true,
    sendCardPrompt: engine ? (c, text, options) => engine(c, text, options) : async (c, text, options) => {
      sendCalls.push([c, text, options]);
      options?.onAccepted?.({ cardId: c.id });
      return true;
    },
    cancelCardRequest: noop,
    findCardAncestorChain: () => [],
    cardParentIds: () => [],
    formatCardChainMarkdown: () => '',
    buildTopologyOutline: () => '',
    openContextPreview: noop,
    openRefManager: noop,
    ...extra,
  };
  cardEl.events = new Map();
  const controller = createCardEvents(deps);
  controller.bindCardEvents(cardEl, target);
  return { cardEl, input, sendBtn, target, documentRef, sendCalls };
}

test('R03 预检失败时 input、draft、暂存附件一个都不能丢', async () => {
  const harness = makeCardEventsHarness({
    engine: async () => false, // 计划失败：不进接受边界
  });
  harness.input.value = 'SYNTHETIC_UNSENT_DRAFT';
  await harness.input.events.get('input')();
  harness.target.stagedAttachments = [{ name: 'a.txt', content: 'x' }];
  assert.equal(harness.target.draft, 'SYNTHETIC_UNSENT_DRAFT');

  await harness.sendBtn.events.get('click')({});

  assert.equal(harness.input.value, 'SYNTHETIC_UNSENT_DRAFT', 'input 必须原样保留');
  assert.equal(harness.target.draft, 'SYNTHETIC_UNSENT_DRAFT', 'draft 必须原样保留');
  assert.equal(harness.target.stagedAttachments.length, 1, '暂存附件必须原样保留');
});

test('R04 onAccepted 在真实 engine 成功路径上恰好被调用一次且 meta 冻结', async () => {
  const target = card('target');
  const cards = [target];
  const planCalls = [];
  let modelCalls = 0;
  const planPort = (targetCard, options = {}) => {
    assert.strictEqual(targetCard, target, 'engine 必须使用 canonical card/options 编译端口');
    planCalls.push({ targetCard, options });
    return {
      messages: [{ role: 'user', content: options.pendingUserMessage?.text || options.pendingMessage?.text || '问' }],
      errors: [], warnings: [], isRequestReady: true,
    };
  };
  const engine = createChatEngine({
    hana: {},
    runChat: async () => { modelCalls += 1; return { text: '回答' }; },
    ChatError: class extends Error {}, safeDetail: String,
    activeRequests: new Map(), getCards: () => cards, getSession: () => ({ generation: 3 }),
    getAgent: () => ({ id: 'agent' }), getReasoningEffort: () => null,
    getAgentReasoningEffort: () => null, buildContextPlan: planPort,
    reportContextIssue: noop, flashMessage: noop, getIsDisposed: () => false,
    canMutateCanvas: () => true, uniqueId: prefix => `${prefix}-r04`,
    paintMessage: noop, renderCards: noop, scheduleSave: noop,
    cardParentIds: () => [], documentRef: { getElementById: () => null },
  });
  const accepted = [];
  await engine.sendCardPrompt(target, '问一句', { onAccepted: meta => accepted.push(meta) });
  assert.equal(planCalls.length, 1, '一次发送只编译一次');
  assert.equal(modelCalls, 1);
  assert.equal(accepted.length, 1, 'onAccepted 必须恰好一次');
  assert.deepEqual(Object.keys(accepted[0]).sort(), ['cardId', 'generation', 'requestId']);
  assert.equal(accepted[0].generation, 3);
  assert.ok(Object.isFrozen(accepted[0]), 'meta 必须冻结');
});

// --- R05 / R06：候选身份与消息资格 ---

test('R05 旧会话的候选不能作用到复用同 ID 的新卡上', () => {
  let cards = [card('source', { title: 'OLD', messages: [msg('assistant', 'OLD_QUOTE', { requestId: 'r05' })] })];
  const created = [];
  const { doc } = selectionFixture('OLD_QUOTE', 'r05');
  const selection = createSelectionBranchController({
    ...selectionLifecyclePorts({ doc, cards, overrides: { getCards: () => cards } }),
    createBranchCard: (source, options) => { created.push({ title: source.title, ...options }); return {}; },
  });
  selection.inspect();
  cards = [card('source', { title: 'NEW' })];
  selection.commit();
  assert.equal(created.length, 0, '卡片对象换了就不能再动作');
});

test('R06 未完成、失败、本地提示的助手消息都不产生候选', () => {
  const cases = [
    { name: 'streaming', messages: [{ role: 'assistant', text: '正在生成的内容足够长', status: 'generating', streaming: true }] },
    { name: 'failed', messages: [{ role: 'assistant', text: '失败的回答内容足够长', failed: true, status: 'failed' }] },
    { name: 'localOnly', messages: [{ role: 'assistant', text: '本地提示内容足够长', localOnly: true }] },
  ];
  for (const item of cases) {
    const cards = [card('source', { messages: item.messages })];
    const notices = [];
    const { doc } = selectionFixture('正在生成的内容足够长');
    const selection = createSelectionBranchController({
      ...selectionLifecyclePorts({ doc, cards, overrides: { reportIssue: text => notices.push(text) } }),
      createBranchCard: noop,
    });
    selection.inspect();
    assert.equal(selection.getPending(), null, `${item.name} 不该有候选`);
  }
  // 正向控制：完成的消息可以
  const okCards = [card('source', { messages: [{ role: 'assistant', text: '完成的回答内容足够长', status: 'completed' }] })];
  const { doc } = selectionFixture('完成的回答内容足够长');
  const okSelection = createSelectionBranchController({
    ...selectionLifecyclePorts({ doc, cards: okCards }),
    createBranchCard: noop,
  });
  okSelection.inspect();
  assert.notEqual(okSelection.getPending(), null);
});

// --- R07：没有 pending 就不发引用 ---

test('R07 有历史消息但没有本次提问时，返回历史投影但不贴引用且不 ready', () => {
  const target = card('target', {
    messages: [msg('user', 'OLD_QUESTION'), msg('assistant', 'OLD_ANSWER')],
    contextRefs: [ref('r1', 'src', 'QUOTE')],
  });
  const plan = buildContextPlan({ cards: [target, card('src')], targetCard: target });
  assert.equal(plan.isRequestReady, false);
  assert.equal(plan.errors.length, 0);
  assert.match(plan.messages.map(m => m.content).join('\n'), /OLD_QUESTION/);
  assert.ok(!plan.messages.some(m => m.content.includes('QUOTE')));
});

// --- R08：跨卡同 ID 异文必须拒绝 ---

test('R08 两张卡用同一个 ref id 装不同正文时整份快照被拒绝', () => {
  const snapshot = {
    cards: [
      card('a', { contextRefs: [ref('same_ref', 'src', '甲')] }),
      card('b', { contextRefs: [ref('same_ref', 'src', '乙')] }),
    ],
    view: { x: 0, y: 0, scale: 1 },
  };
  assert.throws(() => normalizeForkSnapshot(snapshot), err => err.code === 'INVALID_SESSION_SNAPSHOT');
});

// --- R09：undo/redo 之后引用仍然只读 ---

test('R09 撤销重做之后 contextRefs 仍是冻结数组', () => {
  let cards = [card('a', { contextRefs: [ref('r1', 'src', 'QUOTE')] })];
  const controller = createHistoryController({
    getCards: () => cards,
    setCards: next => { cards = next; },
    setSelectedCardId: noop, renderCards: noop, renderConnectors: noop, scheduleSave: noop,
    removedCardArchive: new Map(),
  });
  controller.recordSnapshot(cards, 'a');
  const b = card('b');
  cards = [cards[0], b];
  controller.recordSnapshot(cards, 'b');
  controller.undo();
  controller.redo();
  const restored = cards.find(c => c.id === 'a');
  assert.ok(Array.isArray(restored.contextRefs));
  assert.ok(Object.isFrozen(restored.contextRefs), '恢复出来的引用数组必须还是只读的');
});

// --- R10：保留引用集合是纯 Set，clear 后释放 ---

test('R10 保留引用集合只有 id 字符串，清空历史后旧引用也放掉', () => {
  const manager = createHistoryManager({});
  let cards = [card('a'), card('b', { contextRefs: [ref('r1', 'src', 'OLD_TEXT')] })];
  manager.recordSnapshot(cards, null);
  cards = [card('a'), card('b')];
  manager.syncCards(cards); // 明确切换 live contents，才真正触达 history-only refs
  const ids = manager.getRetainedReferenceIds();
  assert.ok(ids instanceof Set);
  for (const id of ids) assert.equal(typeof id, 'string', `集合里只能是 id，混进了 ${typeof id}`);
  assert.ok(ids.has('r1'), '只在历史里活着的引用也要算进来');
  manager.clear();
  const after = manager.getRetainedReferenceIds();
  assert.equal(after.size, 0, '清空之后不该还有旧引用');
});

// --- R11：预览必须包含本次待发送内容 ---

test('R11 预览按本次待发送计划算，只列真正采纳的引用', () => {
  const doc = docFixture();
  const inputEl = node('input');
  inputEl.value = '预检要看这件事';
  doc.getElementById = id => (id === 'input-target' ? inputEl : null);
  const source = card('src');
  const target = card('target', {
    draft: '预检要看这件事',
    contextRefs: [ref('r1', 'src', '真正采纳的原文')],
  });
  const unrelated = card('other', { contextRefs: [ref('r2', 'src', '无关分支的引用')] });
  const preview = createContextPreview({
    getDocument: () => doc,
    getCards: () => [source, target, unrelated],
    reportIssue: noop,
  });
  preview.show(target);
  const text = walk(doc.body).map(n => n.textContent).join('\n');
  assert.match(text, /待发送：预检要看这件事/);
  assert.match(text, /真正采纳的原文/);
  assert.ok(!text.includes('无关分支的引用'), '与本次请求无关的引用不该出现在预览里');
  preview.dispose();
});

// --- R12：target 作为引用来源时同样受排除约束 ---

test('R12 来源恰好是当前 target 且被排除时，引用不进计划', () => {
  const target = card('target', { contextMode: 'exclude', parentId: 'ancestor' });
  const ancestor = card('ancestor', {
    messages: [msg('user', '问'), msg('assistant', '答')],
    contextRefs: [ref('r1', 'target', 'EXCLUDED_SOURCE_QUOTE')],
  });
  const plan = buildContextPlan({
    cards: [ancestor, target],
    targetCard: target,
    pendingMessage: msg('user', '当前问题'),
  });
  assert.ok(!plan.messages.some(m => m.content.includes('EXCLUDED_SOURCE_QUOTE')));
  assert.equal(plan.warnings.some(w => w.code === 'REFERENCE_SOURCE_EXCLUDED' || w.code === 'REF_SOURCE_EXCLUDED'), true);
});

// --- R13：划词不该改选中，且引用能加进去 ---

test('R13 正文上按下鼠标不改选中，引用仍能落到原定目标', () => {
  let selected = 'owner';
  const source = card('source', { messages: [msg('assistant', '来源正文', { requestId: 'r13' })] });
  const cards = [card('owner'), source];
  let additions = 0;
  const { doc, bubble } = selectionFixture('来源正文', 'r13');
  const selection = createSelectionBranchController({
    ...selectionLifecyclePorts({
      doc,
      cards,
      overrides: {
        getSelectedCardId: () => selected,
        addContextRef: () => { additions += 1; return { ok: true }; },
      },
    }),
    createBranchCard: noop,
  });
  const harness = makeCardEventsHarness({
    target: source,
    extra: {
      getCards: () => cards,
      selectCard: id => { selected = id; },
      getSelectedCardId: () => selected,
    },
  });
  // 直接调用生产的事件入口：正文上的 mousedown 不应改选中
  const mousedown = harness.cardEl.events?.get('mousedown');
  if (mousedown) mousedown({ target: bubble, shiftKey: false, stopPropagation: noop });
  selection.inspect();
  selection.commitReference();
  assert.equal(selected, 'owner', '正文上按下不应把目标改成来源卡');
  assert.equal(additions, 1);
});

// --- R14：旧管理面板回调不能动新会话 ---

test('R14 旧引用管理面板的删除回调在新会话里失效', () => {
  let cards = [card('owner', { contextRefs: [ref('r1', 'source', 'OLD_SESSION_REF')] })];
  const doc = docFixture();
  const refs = createRefController({
    ...refLifecyclePorts(),
    getCards: () => cards,
    getRetainedReferenceIds: () => new Set(),
    renderCards: noop, renderConnectors: noop, scheduleSave: noop, recordSnapshot: noop,
    getDocument: () => doc,
    flashMessage: noop,
  });
  refs.showManager(cards[0]);
  const deleteButton = walk(doc.body).find(n => n.className === 'ctx-ref-remove');
  assert.ok(deleteButton, '管理面板要能渲染出删除按钮');
  cards = [card('owner', { contextRefs: [ref('r1', 'source', 'NEW_SESSION_REF')] })];
  deleteButton.listeners.get('click')[0]();
  assert.equal(cards[0].contextRefs.length, 1, '新会话的引用不能被旧面板删掉');
  assert.equal(cards[0].contextRefs[0].text, 'NEW_SESSION_REF');
});

// 单卡引用的正向控制：合法引用照常通过，避免上面的拒绝规则误伤正常数据
test('正向控制：单卡合法引用仍然通过规范化', () => {
  const refs = normalizeContextRefs([ref('r1', 'src', '原文')], { ownerCardId: 'owner' });
  assert.equal(refs.length, 1);
  assert.ok(Object.isFrozen(refs));
});
