import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChainContext } from '../ui/assets/panel-context.js';
import { buildContextPlan } from '../ui/assets/panel-context-plan.js';

// 编译器底线：默认逐项等于旧编译器；排除只断贡献不断遍历；引用只带原文。

const userMsg = (text, extra = {}) => ({ role: 'user', text, status: 'completed', ...extra });
const asstMsg = (text, extra = {}) => ({ role: 'assistant', text, status: 'completed', ...extra });

const card = (id, overrides = {}) => ({
  id,
  title: `卡 ${id}`,
  parentId: null,
  messages: [],
  ...overrides,
});

function makeChain() {
  const root = card('root', { messages: [userMsg('根问题'), asstMsg('根回答')] });
  const mid = card('mid', { parentId: 'root', messages: [userMsg('中间问题'), asstMsg('中间回答')] });
  const leaf = card('leaf', { parentId: 'mid', messages: [userMsg('叶子问题'), asstMsg('叶子回答')] });
  return { cards: [root, mid, leaf], root, mid, leaf };
}

test('默认等价：普通链路逐项等于旧编译器', () => {
  const { cards, leaf } = makeChain();
  const plan = buildContextPlan({ cards, targetCard: leaf });
  assert.deepEqual(plan.messages, buildChainContext({ cards, targetCard: leaf }));
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.isRequestReady, false, '无 pending 的历史投影不能被当作新请求');
});

test('默认等价：文档卡、附件、失败回复三种场景都一致', () => {
  const doc = card('doc', { isDoc: true, docContent: '张三的论文正文' });
  const withAttach = card('att', {
    parentId: 'doc',
    messages: [
      userMsg('看这个附件', { attachments: [{ name: 'a.txt', content: '附件内容' }] }),
      asstMsg('读完了'),
    ],
  });
  const failed = card('fail', {
    parentId: 'doc',
    messages: [userMsg('第一次提问'), { role: 'assistant', text: '失败', failed: true, status: 'failed' }],
  });
  for (const target of [doc, withAttach, failed]) {
    const plan = buildContextPlan({ cards: [doc, withAttach, failed], targetCard: target });
    assert.deepEqual(plan.messages, buildChainContext({ cards: [doc, withAttach, failed], targetCard: target }));
  }
});

test('排除中间节点：祖先照常保留，被排除节点一个字都不贡献', () => {
  const { cards, leaf, mid } = makeChain();
  mid.contextMode = 'exclude';
  const plan = buildContextPlan({ cards, targetCard: leaf });
  const joined = plan.messages.map(m => m.content).join('\n');
  assert.match(joined, /根问题/);
  assert.ok(!joined.includes('中间回答'), '被排除的节点不能贡献内容');
  assert.ok(!joined.includes('中间问题'));
  assert.match(joined, /叶子问题/, '目标自己的消息要留着');
  assert.deepEqual(plan.excludedCardIds, ['mid']);
  // 卡片本身和边都没被动过
  assert.equal(mid.title, '卡 mid');
  assert.equal(leaf.parentId, 'mid');
});

test('目标节点自己被排除时，自己的消息和文档仍完整保留', () => {
  const { cards, leaf } = makeChain();
  leaf.contextMode = 'exclude';
  const plan = buildContextPlan({ cards, targetCard: leaf });
  const joined = plan.messages.map(m => m.content).join('\n');
  assert.match(joined, /叶子问题/);
  assert.match(joined, /叶子回答/);
  assert.deepEqual(plan.excludedCardIds, []);
});

test('文档卡被排除：它的正文和历史一起不贡献，但不阻断祖先', () => {
  const doc = card('doc', { isDoc: true, docContent: '不该出现的正文' });
  const mid = card('mid', { parentId: 'doc', messages: [userMsg('中'), asstMsg('中答')] });
  const leaf = card('leaf', { parentId: 'mid', messages: [userMsg('末'), asstMsg('末答')] });
  doc.contextMode = 'exclude';
  const plan = buildContextPlan({ cards: [doc, mid, leaf], targetCard: leaf });
  const joined = plan.messages.map(m => m.content).join('\n');
  assert.ok(!joined.includes('不该出现的正文'));
  assert.match(joined, /中答/, '排除不该阻断祖先链路');
});

test('菱形里排除一路，公共祖先只出现一次，另一路照常', () => {
  const root = card('root', { messages: [userMsg('根'), asstMsg('根答')] });
  const left = card('left', { parentId: 'root', messages: [userMsg('左'), asstMsg('左答')] });
  const right = card('right', { parentId: 'root', messages: [userMsg('右'), asstMsg('右答')] });
  const join = card('join', { parentIds: ['left', 'right'], messages: [userMsg('合'), asstMsg('合答')] });
  left.contextMode = 'exclude';
  const plan = buildContextPlan({ cards: [root, left, right, join], targetCard: join });
  const joined = plan.messages.map(m => m.content).join('\n');
  assert.equal((joined.match(/根答/g) || []).length, 1);
  assert.match(joined, /右答/);
  assert.ok(!joined.includes('左答'));
});

const refOf = (id, sourceCardId, text, overrides = {}) => ({
  id, sourceCardId, sourceTitle: `来源 ${sourceCardId}`, text, ...overrides,
});

test('引用进入最后一条 user，不新增轮次', () => {
  const src = card('src', { messages: [userMsg('源'), asstMsg('源答')] });
  const target = card('target', { parentId: 'src', messages: [userMsg('当前提问'), asstMsg('当前回答')] });
  target.contextRefs = [refOf('r1', 'src', '被选中的原文')];
  const pending = { role: 'user', text: '这次的新问题', status: 'completed' };
  const before = buildChainContext({ cards: [src, target], targetCard: target });
  const plan = buildContextPlan({ cards: [src, target], targetCard: target, pendingMessage: pending });
  assert.equal(plan.messages.length, before.length + 1, '只多出这次提问本身');
  const last = plan.messages.at(-1);
  assert.equal(last.role, 'user');
  assert.match(last.content, /被选中的原文/);
  assert.match(last.content, /这次的新问题/);
  assert.ok(last.content.indexOf('被选中的原文') < last.content.indexOf('这次的新问题'));
  assert.ok(!plan.messages.some(m => m.content.includes('当前提问') && m.content.includes('被选中的原文')), '历史问句不能被加上引用');
  assert.equal(plan.referenceBytes > 0, true);
});

test('引用不递归：来源的祖先和来源自己的引用都不带进来', () => {
  const far = card('far', { messages: [userMsg('远祖'), asstMsg('远祖答')] });
  const src = card('src', { parentId: 'far', messages: [userMsg('源'), asstMsg('源答')] });
  src.contextRefs = [refOf('r-src', 'far', '来源自己的引用')];
  const target = card('target', { messages: [userMsg('当前提问')] });
  target.contextRefs = [refOf('r-t', 'src', '目标选的原文')];
  const plan = buildContextPlan({ cards: [far, src, target], targetCard: target, pendingMessage: { role: 'user', text: '问' } });
  const joined = plan.messages.map(m => m.content).join('\n');
  assert.match(joined, /目标选的原文/);
  assert.ok(!joined.includes('来源自己的引用'));
  assert.ok(!joined.includes('远祖答'), '来源的祖先不该因为引用被拖进来');
});

test('同源同文只带一次，不同源相同文字各带一次', () => {
  const a = card('a', { messages: [userMsg('a')] });
  const b = card('b', { messages: [userMsg('b')] });
  const target = card('target', { messages: [userMsg('问')] });
  target.contextRefs = [
    refOf('r1', 'a', '一样的字'),
    refOf('r2', 'a', '一样的字'),
    refOf('r3', 'b', '一样的字'),
  ];
  const plan = buildContextPlan({ cards: [a, b, target], targetCard: target, pendingMessage: { role: 'user', text: '问' } });
  const hits = (plan.messages.map(m => m.content).join('\n').match(/一样的字/g) || []).length;
  assert.equal(hits, 2, '同源同文去重，不同源保留');
  assert.equal(plan.duplicateRefs.length, 1);
});

test('来源被排除时该引用不带，并给出警告', () => {
  const src = card('src', { messages: [userMsg('源')] });
  src.contextMode = 'exclude';
  const target = card('target', { messages: [userMsg('问')] });
  target.contextRefs = [refOf('r1', 'src', '不该带的原文')];
  const plan = buildContextPlan({ cards: [src, target], targetCard: target, pendingMessage: { role: 'user', text: '问' } });
  assert.ok(!plan.messages.map(m => m.content).join('\n').includes('不该带的原文'));
  assert.equal(plan.warnings.some(w => w.code === 'REFERENCE_SOURCE_EXCLUDED' || w.code === 'REF_SOURCE_EXCLUDED'), true);
});

test('来源已删除：保留快照原文，并标注来源没了', () => {
  const target = card('target', { messages: [userMsg('问')] });
  target.contextRefs = [refOf('r1', 'ghost', '孤儿原文')];
  const plan = buildContextPlan({ cards: [target], targetCard: target, pendingMessage: { role: 'user', text: '问' } });
  assert.match(plan.messages.map(m => m.content).join('\n'), /孤儿原文/);
  assert.equal(plan.warnings.some(w => w.code === 'REFERENCE_SOURCE_MISSING' || w.code === 'REF_SOURCE_MISSING'), true);
});

test('引用合计超限时报错，不截断也不发送', () => {
  const src = card('src', { messages: [userMsg('源')] });
  const target = card('target', { messages: [userMsg('问')] });
  target.contextRefs = [refOf('r1', 'src', '长'.repeat(200))];
  const plan = buildContextPlan({ cards: [src, target], targetCard: target, pendingMessage: { role: 'user', text: '问' }, maxReferenceBytes: 100 });
  assert.equal(plan.isRequestReady, false);
  assert.equal(plan.errors[0].code, 'CONTEXT_REFERENCE_PREFIX_TOO_LARGE');
  assert.deepEqual(plan.messages, [], '任何 fatal plan error 都不得返回部分 messages');
});

test('没有 pending 提问时返回合法历史投影，不插引用且不 ready', () => {
  const src = card('src', { messages: [userMsg('源')] });
  const target = card('target', { messages: [userMsg('历史问题'), asstMsg('历史回答')] });
  target.contextRefs = [refOf('r1', 'src', '原文')];
  const plan = buildContextPlan({ cards: [src, target], targetCard: target });
  assert.equal(plan.isRequestReady, false);
  assert.deepEqual(plan.errors, []);
  assert.match(plan.messages.map(m => m.content).join('\n'), /历史问题/);
  assert.ok(!plan.messages.some(m => m.content.includes('原文')));
});

test('合流提示词也能走同一条排除路径', () => {
  const a = card('a', { messages: [userMsg('甲问'), asstMsg('甲答')] });
  const b = card('b', { messages: [userMsg('乙问'), asstMsg('乙答')] });
  a.contextMode = 'exclude';
  const plan = buildContextPlan({ cards: [a, b], targetCard: b });
  const joined = plan.messages.map(m => m.content).join('\n');
  assert.ok(!joined.includes('甲答'));
  assert.equal(plan.isRequestReady, false, '无 pending 的历史投影不能被当作新请求');
});
