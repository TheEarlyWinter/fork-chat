import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SELECTION_BYTES,
  selectionByteLength,
  validateSelection,
  buildBranchDraft,
  findCardIdFromNode,
  resolveSelectionBubble,
  isAssistantBubble,
  selectionContainsMath,
} from '../ui/assets/panel-selection.js';
import { createSelectionBranchController } from '../ui/assets/panel-selection-popover.js';

// 划词分叉的底线：能选的才给入口，选错了要说清楚为什么，
// 而且只预填草稿，绝不自己发请求。

test('validateSelection: 正常选区通过并保留原文', () => {
  const verdict = validateSelection({ text: '  玻璃化转变温度会下降  ' });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.text, '玻璃化转变温度会下降');
  assert.equal(verdict.bytes, selectionByteLength('玻璃化转变温度会下降'));
});

test('validateSelection: 纯空白拒绝', () => {
  for (const text of ['', '   ', '\n\t ']) {
    assert.deepEqual(validateSelection({ text }).reason, 'EMPTY');
  }
});

test('validateSelection: 跨消息、非助手、含公式、超限各有自己的理由', () => {
  assert.equal(validateSelection({ text: 'abc', sameBubble: false }).reason, 'MULTI_BUBBLE');
  assert.equal(validateSelection({ text: 'abc', insideAssistant: false }).reason, 'NOT_ASSISTANT');
  assert.equal(validateSelection({ text: 'abc', hasKatex: true }).reason, 'CONTAINS_MATH');
  const tooLong = 'a'.repeat(MAX_SELECTION_BYTES + 1);
  assert.equal(validateSelection({ text: tooLong }).reason, 'TOO_LONG');
});

test('validateSelection: 超限不截断，空文本不返回半成品', () => {
  const tooLong = 'a'.repeat(MAX_SELECTION_BYTES + 1);
  const verdict = validateSelection({ text: tooLong });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.text, undefined, '拒绝时不应顺带给出截断后的文本');
});

test('validateSelection: 字节上限按 UTF-8 算，中文三个字节一个字', () => {
  assert.equal(selectionByteLength('中'), 3);
  const atLimit = '中'.repeat(Math.floor(MAX_SELECTION_BYTES / 3));
  assert.equal(validateSelection({ text: atLimit }).ok, true);
  assert.equal(validateSelection({ text: atLimit + '中' }).reason, 'TOO_LONG');
});

test('buildBranchDraft: 引用块逐行前缀，问题留空不替用户猜', () => {
  const draft = buildBranchDraft({ cardTitle: '父卡', text: '第一行\n第二行' });
  assert.match(draft, /【引用片段 · 来自「父卡」】/);
  assert.match(draft, /> 第一行\n> 第二行/);
  assert.ok(draft.endsWith('\n\n'), '结尾留空行，光标落在能直接写问题的地方');
  assert.ok(!/问题[:：]/.test(draft), '不应替用户写问题');
});

test('buildBranchDraft: 空文本不产出草稿', () => {
  assert.equal(buildBranchDraft({ cardTitle: '父卡', text: '   ' }), '');
});

function fakeNode({ id = '', parentNode = null, closest = null } = {}) {
  return { id, parentNode, closest };
}

test('findCardIdFromNode: 从气泡往上找到 dom- 前缀的卡片根', () => {
  const root = fakeNode({ id: 'dom-branch-7' });
  const middle = fakeNode({ parentNode: root });
  const bubble = fakeNode({ parentNode: middle });
  assert.equal(findCardIdFromNode(bubble), 'branch-7');
});

test('findCardIdFromNode: 找不到就返回 null，不猜', () => {
  assert.equal(findCardIdFromNode(fakeNode({ id: 'something-else' })), null);
  assert.equal(findCardIdFromNode(null), null);
});

test('resolveSelectionBubble: 同一气泡才算有效选区', () => {
  const bubble = { nodeType: 1, closest: selector => (selector === '.msg-bubble' ? bubble : null) };
  const other = { nodeType: 1, closest: selector => (selector === '.msg-bubble' ? other : null) };
  const range = (a, b) => ({ startContainer: a, endContainer: b, commonAncestorContainer: a });
  assert.equal(resolveSelectionBubble(range(bubble, bubble)).sameBubble, true);
  assert.equal(resolveSelectionBubble(range(bubble, other)).sameBubble, false);
  assert.equal(resolveSelectionBubble(null).sameBubble, false);
});

test('isAssistantBubble: 只认助手那一侧的消息行', () => {
  const asst = { closest: sel => (sel === '.msg-row.msg-asst' ? {} : null) };
  const user = { closest: () => null };
  assert.equal(isAssistantBubble(asst), true);
  assert.equal(isAssistantBubble(user), false);
});

test('selectionContainsMath: 选区内有渲染后的公式就认出来', () => {
  const katexParent = { parentElement: { closest: sel => (sel === '.katex' ? {} : null), querySelector: () => null } };
  assert.equal(selectionContainsMath({ commonAncestorContainer: { nodeType: 1, closest: sel => (sel === '.katex' ? {} : null), querySelector: () => null } }), true);
  const plain = { nodeType: 1, closest: () => null, querySelector: () => null };
  assert.equal(selectionContainsMath({ commonAncestorContainer: plain }), false);
  assert.equal(selectionContainsMath(null), false);
});

// --- 控制器：用假 DOM 验证「只建卡不发送」与清理 ---

function createFakeDom() {
  const listeners = new Map();
  const body = { children: [], appendChild(node) { this.children.push(node); node.parentNode = this; } };
  const createElement = tag => {
    const el = {
      tagName: tag, textContent: '', hidden: false, style: {}, parentNode: null, type: '',
      handlers: {}, children: [], dataset: {},
      appendChild(node) { this.children.push(node); node.parentNode = this; return node; },
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
      removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter(f => f !== fn); },
      remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; },
    };
    Object.defineProperty(el, 'parentNode', { writable: true, value: null });
    return el;
  };
  const doc = {
    body,
    createElement,
    selection: null,
    getSelection: () => doc.selection,
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
    removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter(f => f !== fn)); },
    defaultView: null,
  };
  return { doc, listeners };
}

function selectionRequiredPorts(doc, cards, overrides = {}) {
  return {
    getDocument: () => doc,
    getCards: () => cards,
    getGeneration: () => 1,
    getIsDisposed: () => false,
    canMutateCanvas: () => true,
    chainIsBusy: () => false,
    listen(target, type, handler, options, scope) {
      if (!target?.addEventListener) return () => {};
      target.addEventListener(type, handler, options);
      const cleanup = () => target.removeEventListener?.(type, handler, options);
      scope?.add?.(cleanup);
      return cleanup;
    },
    ...overrides,
  };
}

test('createSelectionBranchController: 缺依赖当场报错，不用空实现的默认值放行', () => {
  assert.throws(() => createSelectionBranchController({}), /缺少依赖：getDocument/);
  assert.throws(() => createSelectionBranchController({ getDocument: () => null }), /缺少依赖：createBranchCard/);
  assert.throws(
    () => createSelectionBranchController({ getDocument: () => null, createBranchCard: () => null }),
    /缺少依赖：getCards/,
  );
  for (const key of ['getGeneration', 'getIsDisposed', 'canMutateCanvas', 'chainIsBusy', 'listen']) {
    const deps = selectionRequiredPorts(null, []);
    deps.createBranchCard = () => null;
    delete deps[key];
    assert.throws(() => createSelectionBranchController(deps), TypeError, `缺 ${key} 必须失败`);
  }
});

test('createSelectionBranchController: 选中助手正文后只创建带草稿的子卡，不发请求', () => {
  const { doc } = createFakeDom();
  const created = [];
  const bubble = {
    nodeType: 1,
    id: 'reply-req-1',
    closest: sel => (sel === '.msg-bubble' ? bubble : sel === '.msg-row.msg-asst' ? {} : null),
    parentNode: { id: 'dom-branch-1', parentNode: null },
  };
  const range = {
    startContainer: bubble, endContainer: bubble, commonAncestorContainer: bubble,
    getBoundingClientRect: () => ({ top: 100, left: 50, width: 200 }),
  };
  doc.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range, toString: () => '玻璃化转变温度会下降', removeAllRanges: () => {} };

  // 真实 getCards 返回同一份数组引用；每次新建对象会让身份校验失效
  const cards = [{
    id: 'branch-1',
    title: '父卡',
    messages: [{ role: 'assistant', requestId: 'req-1', status: 'completed', text: '玻璃化转变温度会下降' }],
  }];
  const controller = createSelectionBranchController({
    ...selectionRequiredPorts(doc, cards),
    createBranchCard: (card, opts) => { created.push({ card, opts }); return { id: 'branch-2' }; },
    reportIssue: () => {},
  });
  controller.attach();
  controller.inspect();

  assert.equal(controller.getPending()?.text, '玻璃化转变温度会下降');
  controller.commit();
  assert.equal(created.length, 1);
  assert.equal(created[0].card.id, 'branch-1');
  assert.match(created[0].opts.initialDraft, /玻璃化转变温度会下降/);
  assert.equal(controller.getPending(), null, '提交后候选应清空');
  controller.dispose();
});

test('createSelectionBranchController: 选区不合格时没有候选，也就点不出卡', () => {
  const { doc } = createFakeDom();
  let created = 0;
  doc.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: null, endContainer: null }), toString: () => 'abc', removeAllRanges: () => {} };
  const emptyCards = [];
  const controller = createSelectionBranchController({
    ...selectionRequiredPorts(doc, emptyCards),
    createBranchCard: () => { created += 1; return null; },
    reportIssue: () => {},
  });
  controller.attach();
  controller.inspect();
  assert.equal(controller.getPending(), null);
  controller.commit();
  assert.equal(created, 0);
  controller.dispose();
});

test('createSelectionBranchController: dispose 之后不再理会选区', () => {
  const { doc } = createFakeDom();
  const bubble = { nodeType: 1, closest: sel => (sel === '.msg-bubble' ? bubble : sel === '.msg-row.msg-asst' ? {} : null) };
  doc.selection = {
    isCollapsed: false, rangeCount: 1, toString: () => '文字',
    getRangeAt: () => ({ startContainer: bubble, endContainer: bubble, commonAncestorContainer: bubble, getBoundingClientRect: () => ({ top: 0, left: 0, width: 10 }) }),
    removeAllRanges: () => {},
  };
  const emptyCards = [];
  const controller = createSelectionBranchController({
    ...selectionRequiredPorts(doc, emptyCards),
    createBranchCard: () => null,
    reportIssue: () => {},
  });
  controller.attach();
  controller.dispose();
  controller.inspect();
  assert.equal(controller.getPending(), null);
});
