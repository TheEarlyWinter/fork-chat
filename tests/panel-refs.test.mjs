import test from 'node:test';
import assert from 'node:assert/strict';
import { createRefController } from '../ui/assets/panel-refs.js';
import { renderReferenceConnectors } from '../ui/assets/panel-connectors.js';
import { MAX_REFS_PER_CARD } from '../ui/assets/fork-context-policy.js';

// 引用的底线：只加原文、不自引用、不超限、来源没了文字还在，
// 而且虚线是独立的，绝不混进父边。

function makeController({ cards = [], retained = new Set(), doc = null, generation = 1, overrides = {} } = {}) {
  const calls = { render: 0, save: 0, snapshot: 0, messages: [] };
  const controller = createRefController({
    getCards: () => cards,
    getRetainedReferenceIds: () => retained,
    renderCards: () => { calls.render += 1; },
    renderConnectors: () => {},
    scheduleSave: () => { calls.save += 1; },
    recordSnapshot: () => { calls.snapshot += 1; },
    flashMessage: message => calls.messages.push(message),
    getDocument: () => doc,
    getGeneration: () => generation,
    canMutateCanvas: () => true,
    getIsDisposed: () => false,
    ...overrides,
  });
  return { controller, calls };
}

const noop = () => {};
const card = (id, overrides = {}) => ({ id, title: `卡 ${id}`, parentId: null, messages: [], ...overrides });

test('addRef: 加进原文快照，并触发重绘、保存与一次历史', () => {
  const owner = card('owner');
  const source = card('source', { title: '来源卡' });
  const { controller, calls } = makeController({ cards: [owner, source] });
  const result = controller.addRef('owner', { sourceCard: source, text: '被选中的原文' });
  assert.equal(result.ok, true);
  assert.equal(owner.contextRefs.length, 1);
  assert.equal(owner.contextRefs[0].sourceCardId, 'source');
  assert.equal(owner.contextRefs[0].sourceTitle, '来源卡');
  assert.equal(owner.contextRefs[0].text, '被选中的原文');
  assert.ok(Object.isFrozen(owner.contextRefs));
  assert.equal(calls.render, 1);
  assert.equal(calls.save, 1);
  assert.equal(calls.snapshot, 1);
});

test('createRefController: generation/canMutate/isDisposed 是 required port', () => {
  const required = ['getGeneration', 'canMutateCanvas', 'getIsDisposed'];
  for (const key of required) {
    const deps = {
      getCards: () => [],
      getRetainedReferenceIds: () => new Set(),
      renderCards: noop,
      scheduleSave: noop,
      recordSnapshot: noop,
      [key]: undefined,
    };
    delete deps[key];
    assert.throws(() => createRefController(deps), /依赖|缺少|required|函数/i, `缺 ${key} 必须失败`);
  }
});

test('addRef: source 必须是当前 cards 中同 ID 的活对象', () => {
  const owner = card('owner');
  const source = card('source', { title: 'live source' });
  const staleSameId = { ...source, title: 'stale source' };
  const { controller } = makeController({ cards: [owner, source] });
  const rejected = controller.addRef('owner', { sourceCard: staleSameId, text: '旧来源' });
  assert.equal(rejected.ok, false, '同 ID 新对象/脱离 cards 的 source 不得写引用');
  assert.equal(owner.contextRefs, undefined);
  const accepted = controller.addRef('owner', { sourceCard: source, text: '当前来源' });
  assert.equal(accepted.ok, true, '当前 cards 中的活 source 必须仍可正常添加');
  assert.equal(owner.contextRefs[0].sourceCardId, source.id);
});

test('addRef: retained reference getter 必须拒绝非 Set<string>，不能静默放行', () => {
  const owner = card('owner');
  const source = card('source');
  const { controller } = makeController({ cards: [owner, source], retained: ['ref_aaaaaaaa'] });
  let result;
  try {
    result = controller.addRef('owner', { sourceCard: source, text: '原文' });
  } catch (error) {
    assert.match(String(error.message), /Set|string|引用|保留/i);
    return;
  }
  assert.equal(result.ok, false, '非法 retained 形状必须显式拒绝');
  assert.match(`${result.reason || ''} ${result.message || ''}`, /Set|string|引用|保留|INVALID/i);
  assert.equal(owner.contextRefs, undefined);
});

test('addRef: 不能引用自己', () => {
  const owner = card('owner');
  const { controller } = makeController({ cards: [owner] });
  const result = controller.addRef('owner', { sourceCard: owner, text: '自引用' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'SELF_REFERENCE');
  assert.equal(owner.contextRefs, undefined);
});

test('addRef: canMutateCanvas/disposed 门禁拒绝写入，合法状态仍可写', () => {
  const owner = card('owner');
  const source = card('source');
  let mutable = false;
  let disposed = false;
  const { controller } = makeController({
    cards: [owner, source],
    overrides: { canMutateCanvas: () => mutable, getIsDisposed: () => disposed },
  });
  assert.equal(controller.addRef('owner', { sourceCard: source, text: 'blocked' }).ok, false);
  mutable = true;
  disposed = true;
  assert.equal(controller.addRef('owner', { sourceCard: source, text: 'disposed' }).ok, false);
  disposed = false;
  assert.equal(controller.addRef('owner', { sourceCard: source, text: 'accepted' }).ok, true);
  assert.equal(owner.contextRefs.length, 1);
});

test('addRef: 超过每卡上限时拒绝，不动已有引用', () => {
  const owner = card('owner');
  const source = card('source');
  const { controller } = makeController({ cards: [owner, source] });
  for (let i = 0; i < MAX_REFS_PER_CARD; i += 1) {
    assert.equal(controller.addRef('owner', { sourceCard: source, text: `第 ${i} 段` }).ok, true);
  }
  const before = owner.contextRefs.length;
  const result = controller.addRef('owner', { sourceCard: source, text: '多出来的一段' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'TOO_MANY');
  assert.equal(owner.contextRefs.length, before);
});

test('addRef: 引用的 id 避开仍然可达的旧 id', () => {
  const owner = card('owner');
  const source = card('source');
  const retained = new Set(['ref_aaaaaaaa', 'ref_bbbbbbbb']);
  const { controller } = makeController({ cards: [owner, source], retained });
  const result = controller.addRef('owner', { sourceCard: source, text: '原文' });
  assert.equal(result.ok, true);
  assert.ok(!retained.has(result.ref.id), '新 id 不能撞上历史里还活着的');
});

test('removeRef: 部分删除后数组与条目仍冻结，删光后字段消失', () => {
  const owner = card('owner');
  const source = card('source');
  const { controller } = makeController({ cards: [owner, source] });
  controller.addRef('owner', { sourceCard: source, text: '甲' });
  controller.addRef('owner', { sourceCard: source, text: '乙' });
  const firstId = owner.contextRefs[0].id;
  const secondId = owner.contextRefs[1].id;
  assert.equal(controller.removeRef('owner', firstId), true);
  assert.equal(owner.contextRefs.length, 1);
  assert.ok(Object.isFrozen(owner.contextRefs), '部分删除后仍必须是冻结数组');
  assert.ok(Object.isFrozen(owner.contextRefs[0]), '部分删除后 ref 条目仍必须冻结');
  assert.equal(owner.contextRefs[0].id, secondId);
  assert.equal(controller.removeRef('owner', secondId), true);
  assert.equal(owner.contextRefs, undefined, '空引用不该留一个空数组');
});

test('removeRef: 删不存在的引用返回 false，不产生历史', () => {
  const owner = card('owner');
  const { controller, calls } = makeController({ cards: [owner] });
  assert.equal(controller.removeRef('owner', 'ref_nope'), false);
  assert.equal(calls.snapshot, 0);
});

// --- 虚线层 ---

function fakeSvg() {
  const nodes = [];
  return {
    children: nodes,
    set innerHTML(value) { if (value === '') nodes.length = 0; },
    get innerHTML() { return ''; },
    appendChild(node) { nodes.push(node); return node; },
    ownerDocument: {
      createElementNS: (ns, tag) => {
        const attrs = {};
        return {
          tagName: tag, attrs,
          setAttribute: (key, value) => { attrs[key] = value; },
          getAttribute: key => attrs[key],
        };
      },
    },
  };
}

test('renderReferenceConnectors: 每条引用一条虚线，key 带 ref 前缀', () => {
  const source = { id: 'src', x: 0, y: 0, width: 340, contextRefs: [] };
  const owner = { id: 'own', x: 500, y: 0, width: 340, contextRefs: [
    { id: 'ref_1', sourceCardId: 'src', sourceTitle: '来源', text: '原文' },
  ] };
  const svg = fakeSvg();
  renderReferenceConnectors({ svg, cards: [source, owner] });
  assert.equal(svg.children.length, 1);
  const path = svg.children[0];
  assert.equal(path.getAttribute('data-ref-edge'), 'ref:ref_1');
  assert.equal(path.getAttribute('stroke-dasharray'), '5 4');
});

test('renderReferenceConnectors: 来源已删除时不画指针线', () => {
  const owner = { id: 'own', x: 0, y: 0, width: 340, contextRefs: [
    { id: 'ref_1', sourceCardId: 'ghost', sourceTitle: '没了', text: '原文' },
  ] };
  const svg = fakeSvg();
  renderReferenceConnectors({ svg, cards: [owner] });
  assert.equal(svg.children.length, 0);
});

test('renderReferenceConnectors: 反复渲染不累积元素', () => {
  const source = { id: 'src', x: 0, y: 0, width: 340 };
  const owner = { id: 'own', x: 500, y: 0, width: 340, contextRefs: [
    { id: 'ref_1', sourceCardId: 'src', sourceTitle: '来源', text: '原文' },
  ] };
  const svg = fakeSvg();
  renderReferenceConnectors({ svg, cards: [source, owner] });
  renderReferenceConnectors({ svg, cards: [source, owner] });
  renderReferenceConnectors({ svg, cards: [source, owner] });
  assert.equal(svg.children.length, 1);
});
