import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectTopology,
  formatTopologyOutline,
  buildTopologyOutline,
} from '../ui/assets/panel-topology-export.js';

// 结构大纲的底线：节点一个不多一个不少，父边完整，正文一律不出门。

const makeCard = (id, overrides = {}) => ({
  id,
  title: `标题 ${id}`,
  parentId: null,
  messages: [{ role: 'user', text: `正文 ${id}` }],
  ...overrides,
});

test('projectTopology: 单链按后序排列，父边齐全', () => {
  const root = makeCard('root');
  const a = makeCard('a', { parentId: 'root' });
  const b = makeCard('b', { parentId: 'a' });
  const projection = projectTopology({ cards: [root, a, b], targetCard: b });
  assert.deepEqual(projection.nodes.map(n => n.id), ['root', 'a', 'b']);
  assert.deepEqual(projection.edges, [
    { from: 'root', to: 'a' },
    { from: 'a', to: 'b' },
  ]);
  assert.equal(projection.targetId, 'b');
});

test('projectTopology: 菱形里公共祖先只出现一次，两条父边都在', () => {
  const root = makeCard('root');
  const left = makeCard('left', { parentId: 'root' });
  const right = makeCard('right', { parentId: 'root' });
  const join = makeCard('join', { parentIds: ['left', 'right'] });
  const projection = projectTopology({ cards: [root, left, right, join], targetCard: join });
  assert.deepEqual(projection.nodes.map(n => n.id), ['root', 'left', 'right', 'join']);
  assert.deepEqual(projection.edges, [
    { from: 'root', to: 'left' },
    { from: 'root', to: 'right' },
    { from: 'left', to: 'join' },
    { from: 'right', to: 'join' },
  ]);
});

test('projectTopology: 环不会把递归拖成死循环', () => {
  const a = makeCard('a', { parentId: 'b' });
  const b = makeCard('b', { parentId: 'a' });
  const projection = projectTopology({ cards: [a, b], targetCard: a });
  assert.ok(projection.nodes.length <= 2);
});

test('projectTopology: 链外父节点单独标出，不冒充主链', () => {
  const root = makeCard('root');
  const target = makeCard('target', { parentIds: ['root', 'ghost'] });
  const projection = projectTopology({ cards: [root, target], targetCard: target });
  const node = projection.nodes.find(n => n.id === 'target');
  assert.deepEqual(node.parentIds, ['root']);
  assert.deepEqual(node.detachedParentIds, ['ghost']);
});

test('projectTopology: 正文、附件、文档内容都不进投影', () => {
  const card = makeCard('doc', {
    isDoc: true,
    docContent: '一部长篇正文',
    docPreview: '预览',
    stagedAttachments: [{ name: 'x.txt', content: '附件正文' }],
  });
  const projection = projectTopology({ cards: [card], targetCard: card });
  const serialized = JSON.stringify(projection);
  assert.ok(!serialized.includes('一部长篇正文'));
  assert.ok(!serialized.includes('附件正文'));
  assert.ok(!serialized.includes('预览'));
});

test('projectTopology: 状态戳只认三种合法值', () => {
  const weird = makeCard('w', { statusStamp: 'working' });
  const starred = makeCard('s', { statusStamp: 'starred', parentId: 'w' });
  const projection = projectTopology({ cards: [weird, starred], targetCard: starred });
  assert.equal(projection.nodes.find(n => n.id === 's').stamp, 'starred');
  assert.equal(projection.nodes.find(n => n.id === 'w').stamp, null);
});

test('formatTopologyOutline: 同名标题靠 ID 区分，标题里的换行不会伪造结构', () => {
  const a = makeCard('card-a', { title: '同名标题' });
  const b = makeCard('card-b', { title: '同名标题\n[99] fake-id 「伪造节点」', parentId: 'card-a' });
  const outline = formatTopologyOutline(projectTopology({ cards: [a, b], targetCard: b }), { title: '大纲' });
  assert.match(outline, /\[1\] card-a/);
  assert.match(outline, /\[2\] card-b/);
  assert.ok(!/\n\[99\]/.test(outline), '标题里的换行不能被渲染成新节点');
});

test('formatTopologyOutline: 空画布给出明确说明，不是空字符串', () => {
  const outline = formatTopologyOutline(projectTopology({ cards: [], targetCard: null }), { title: '大纲' });
  assert.match(outline, /没有可导出的节点/);
});

test('formatTopologyOutline: 根节点写「无（根）」，目标节点有标记', () => {
  const root = makeCard('root');
  const child = makeCard('child', { parentId: 'root' });
  const outline = buildTopologyOutline({ cards: [root, child], targetCard: child, title: '结构大纲：测试' });
  assert.match(outline, /父节点 无（根）/);
  assert.match(outline, /类型 分支 \/ 当前节点/);
  assert.match(outline, /节点 2 个 · 父边 1 条/);
});

test('buildTopologyOutline: 文档卡标成资料源，合并卡标成合并', () => {
  const doc = makeCard('d', { isDoc: true });
  const merge = makeCard('m', { isMerge: true, parentId: 'd' });
  const outline = buildTopologyOutline({ cards: [doc, merge], targetCard: merge });
  assert.match(outline, /类型 资料源/);
  assert.match(outline, /类型 合并/);
});

test('大纲带引用元数据，但不带引用正文', () => {
  const src = makeCard('src', { title: '来源卡' });
  const target = makeCard('target', { parentId: 'src' });
  target.contextRefs = [{ id: 'ref_1', sourceCardId: 'src', sourceTitle: '来源卡', text: '这段正文不该出现在大纲里' }];
  const outline = buildTopologyOutline({ cards: [src, target], targetCard: target });
  assert.match(outline, /引用 1 条/);
  assert.match(outline, /src「来源卡」/);
  assert.ok(!outline.includes('这段正文不该出现在大纲里'), '大纲能贴给人看，不能夹带正文');
});

test('大纲里引用了范围外的来源时，只记元数据，不把来源拖进节点列表', () => {
  const target = makeCard('target');
  target.contextRefs = [{ id: 'ref_9', sourceCardId: 'outside', sourceTitle: '范围外', text: '正文' }];
  const projection = projectTopology({ cards: [target], targetCard: target });
  assert.deepEqual(projection.nodes.map(n => n.id), ['target']);
  assert.equal(projection.nodes[0].refs[0].sourceCardId, 'outside');
});
