import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildHandoffContext } from '../ui/assets/fork-handoff-context.js';
import { validateHandoffContext } from '../ui/assets/fork-handoff-contract.js';

// ---------------------------------------------------------------------------
// 图性能阶段的保行为回归
//
// 这是纯保行为优化：固定 300 节点 / 44850 边的编译输出（字节数与 SHA256）必须
// 与优化前基线逐字节一致；错误优先级、兄弟自由顺序、exclude 传播、reference 边界
// 都必须保持。唯一的“性能型”断言是确定性的父列表读取计数（不是墙钟阈值）。
// ---------------------------------------------------------------------------

const DENSE_SIZE = 300;
const DENSE_EDGES = DENSE_SIZE * (DENSE_SIZE - 1) / 2;
const BASELINE_JSON_BYTES = 504307;
const BASELINE_SHA256 = 'a2ba829dd03d9b001d57384c9ec6371f838b971efef877187995deddb0142636';

/** 与 graph-benchmark.mjs 完全相同的合成输入（合法 include、无 status、仅目标有 21 字正文） */
function denseGraph(size = DENSE_SIZE, { countReads = false } = {}) {
  const reads = [];
  const cards = Array.from({ length: size }, (_, index) => {
    const parents = Array.from({ length: index }, (_, parent) => `perf-${parent}`);
    const card = {
      id: `perf-${index}`,
      title: `性能节点${index}`,
      contextMode: 'include',
      messages: index === size - 1 ? [{ id: 'perf-message', role: 'user', text: 'x'.repeat(21) }] : [],
    };
    if (countReads) {
      // 只统计调用方可见的“取父列表”次数，不依赖任何测试专用导出或运行时埋点
      Object.defineProperty(card, 'parentIds', {
        enumerable: true,
        configurable: true,
        get() {
          reads.push(index);
          return parents;
        },
      });
    } else {
      card.parentIds = parents;
    }
    return card;
  });
  const targetId = `perf-${size - 1}`;
  return {
    reads,
    cards,
    input: {
      snapshot: { cards, agent: { id: 'perf-agent', name: '性能探针' } },
      source: { canvasId: 'perf-canvas', revision: '1', targetCardId: targetId },
      targetCardId: targetId,
      agentId: 'perf-agent',
      nextStep: '',
    },
  };
}

function msg(role, text, extra = {}) {
  return { role, text, ...extra };
}

function card(id, { parents = [], messages = [], ...extra } = {}) {
  const built = { id, x: 0, y: 0, width: 320, draft: '', messages, ...extra };
  if (parents.length === 1) built.parentId = parents[0];
  else if (parents.length > 1) built.parentIds = [...parents];
  return built;
}

function snapshot(cards) {
  return { cards, view: { x: 0, y: 0, scale: 1 }, agent: { id: 'agent-a', name: '助手' } };
}

function build(cards, target, extra = {}) {
  return buildHandoffContext({
    snapshot: snapshot(cards),
    source: { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: target },
    targetCardId: target,
    agentId: 'agent-a',
    ...extra,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fails(fn, code) {
  assert.throws(fn, error => {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}：${error.message}`);
    return true;
  });
}

// ---------------------------------------------------------------------------
// 1. 极端图：输出逐字节稳定，且 validate 幂等
// ---------------------------------------------------------------------------

test('the fixed 300-node / 44850-edge graph keeps byte-identical output and revalidates unchanged', () => {
  const { input } = denseGraph();
  const dto = buildHandoffContext(input);
  const encoded = JSON.stringify(dto);

  assert.equal(dto.nodes.length, DENSE_SIZE);
  assert.equal(
    dto.nodes.reduce((sum, node) => sum + node.parentIds.length, 0),
    DENSE_EDGES,
    '每条父边都要保留',
  );
  assert.equal(Buffer.byteLength(encoded), BASELINE_JSON_BYTES, 'JSON 字节数必须与优化前基线一致');
  assert.equal(
    createHash('sha256').update(encoded).digest('hex'),
    BASELINE_SHA256,
    '同输入输出必须与优化前基线逐字节一致',
  );

  const revalidated = validateHandoffContext(clone(dto));
  assert.deepEqual(revalidated, dto, '合法 DTO 再校验必须原样通过');
  assert.equal(revalidated.stats.nodeCount, DENSE_SIZE);
});

test('parent-first order of the dense graph still puts every parent before its child', () => {
  const { input } = denseGraph(40);
  const dto = buildHandoffContext(input);
  const index = new Map(dto.nodes.map((node, position) => [node.cardId, position]));
  assert.equal(index.size, 40);
  for (const [position, node] of dto.nodes.entries()) {
    for (const parentId of node.parentIds) {
      assert.ok(index.get(parentId) < position, `${parentId} 必须排在 ${node.cardId} 前面`);
    }
  }
  assert.equal(dto.nodes.at(-1).cardId, 'perf-39', '目标节点最后完成');
});

// ---------------------------------------------------------------------------
// 2. 父列表读取次数：确定性复杂度守卫（旧实现每次弹边都重建父列表）
// ---------------------------------------------------------------------------

test('each DFS frame reads its parent list once instead of rebuilding it per edge', () => {
  const size = 60;
  const { input, reads } = denseGraph(size, { countReads: true });
  const dto = buildHandoffContext(input);

  assert.equal(dto.nodes.length, size);
  assert.equal(dto.nodes.reduce((sum, node) => sum + node.parentIds.length, 0), size * (size - 1) / 2);
  // 允许索引、节点装配等一次性读取；DFS 若逐边重建父集合，这里会到 ~1770 次
  assert.ok(
    reads.length <= 4 * size,
    `父节点列表被反复重建：读取 ${reads.length} 次 / ${size} 个节点（上限 ${4 * size}）`,
  );
});

// ---------------------------------------------------------------------------
// 3. exclude 传播：经连续多个排除节点的包含祖先仍要排在前面
// ---------------------------------------------------------------------------

test('an included ancestor behind two excluded nodes must still precede its descendant', () => {
  const context = build([
    card('A', { messages: [msg('user', 'ROOT-BODY')] }),
    card('E1', { parents: ['A'], contextMode: 'exclude', messages: [msg('assistant', 'E1-BODY')] }),
    card('E2', { parents: ['E1'], contextMode: 'exclude', messages: [msg('assistant', 'E2-BODY')] }),
    card('T', { parents: ['E2'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');

  assert.deepEqual(context.nodes.map(node => node.cardId), ['A', 'T']);
  assert.deepEqual(context.exclusions.map(item => item.cardId), ['E1', 'E2']);
  const revalidated = validateHandoffContext(clone(context));
  assert.deepEqual(revalidated, context);

  const reversed = clone(context);
  reversed.nodes.reverse();
  fails(() => validateHandoffContext(reversed), 'HANDOFF_ORDER');

  // 只把 A 挪到最后也要拒绝（排除节点没有 index，但仍然传播祖先）
  const rotated = clone(context);
  rotated.nodes = [rotated.nodes[1], rotated.nodes[0]];
  fails(() => validateHandoffContext(rotated), 'HANDOFF_ORDER');

  // 排除节点自身不在节点列表里，也不占用 index
  const counted = clone(context);
  counted.nodes[1].parentIds = ['E2'];
  assert.deepEqual(validateHandoffContext(counted).nodes.map(node => node.cardId), ['A', 'T']);
});

// ---------------------------------------------------------------------------
// 4. 兄弟自由顺序：无依赖的兄弟可以互换，目标仍必须最后
// ---------------------------------------------------------------------------

test('independent siblings may swap freely but the target must stay last', () => {
  const context = build([
    card('R', { messages: [msg('user', 'ROOT-BODY')] }),
    card('A1', { parents: ['R'], messages: [msg('user', 'A1-BODY')] }),
    card('A2', { parents: ['R'], messages: [msg('user', 'A2-BODY')] }),
    card('T', { parents: ['A1', 'A2'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');
  assert.deepEqual(context.nodes.map(node => node.cardId), ['R', 'A1', 'A2', 'T']);

  const swapped = clone(context);
  swapped.nodes = [swapped.nodes[0], swapped.nodes[2], swapped.nodes[1], swapped.nodes[3]];
  const revalidated = validateHandoffContext(swapped);
  assert.deepEqual(revalidated.nodes.map(node => node.cardId), ['R', 'A2', 'A1', 'T']);

  // 把目标提前到兄弟之前就是非法反序
  const early = clone(context);
  early.nodes = [early.nodes[0], early.nodes[3], early.nodes[1], early.nodes[2]];
  fails(() => validateHandoffContext(early), 'HANDOFF_ORDER');

  // 兄弟排到共同祖先前面同样非法
  const beforeRoot = clone(context);
  beforeRoot.nodes = [beforeRoot.nodes[1], beforeRoot.nodes[0], beforeRoot.nodes[2], beforeRoot.nodes[3]];
  fails(() => validateHandoffContext(beforeRoot), 'HANDOFF_ORDER');
});

// ---------------------------------------------------------------------------
// 5. reference 不是父边：引用来源不参与顺序约束
// ---------------------------------------------------------------------------

test('references never act as parent edges', () => {
  const context = build([
    card('R', { messages: [msg('user', 'ROOT-BODY')] }),
    card('A1', {
      parents: ['R'],
      messages: [msg('user', 'A1-BODY')],
      contextRefs: [{ id: 'ref-a', sourceCardId: 'A2', sourceTitle: '兄弟', text: 'REF-TEXT' }],
    }),
    card('A2', { parents: ['R'], messages: [msg('user', 'A2-BODY')] }),
    card('T', { parents: ['A1', 'A2'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');

  assert.deepEqual(context.nodes.map(node => node.cardId), ['R', 'A1', 'A2', 'T']);
  assert.deepEqual(context.references.map(reference => reference.sourceCardId), ['A2']);
  assert.equal(context.references[0].included, true);

  // A1 引用 A2，但两者仍是无依赖兄弟：互换必须被接受
  const swapped = clone(context);
  swapped.nodes = [swapped.nodes[0], swapped.nodes[2], swapped.nodes[1], swapped.nodes[3]];
  assert.deepEqual(validateHandoffContext(swapped).nodes.map(node => node.cardId), ['R', 'A2', 'A1', 'T']);

  // 引用不会让 A2 变成 A1 的祖先：把 R 挪到 A1 之后依然非法
  const broken = clone(context);
  broken.nodes = [broken.nodes[1], broken.nodes[0], broken.nodes[2], broken.nodes[3]];
  fails(() => validateHandoffContext(broken), 'HANDOFF_ORDER');
});

// ---------------------------------------------------------------------------
// 6. 失败优先级：缺父 → 环 → 不可达 → 顺序，不能被新算法打乱
// ---------------------------------------------------------------------------

test('missing parent and cycles still win over ordering errors', () => {
  const base = build([
    card('R', { messages: [msg('user', 'ROOT-BODY')] }),
    card('M', { parents: ['R'], messages: [msg('user', 'M-BODY')] }),
    card('T', { parents: ['M'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');

  // 缺父 + 反序：缺父优先
  const missing = clone(base);
  missing.nodes.reverse();
  missing.nodes[1].parentIds = ['ghost'];
  fails(() => validateHandoffContext(missing), 'HANDOFF_MISSING_PARENT');

  // 环 + 反序：环优先
  const cycle = clone(base);
  cycle.nodes.reverse();
  cycle.nodes[0].parentIds = ['R'];
  cycle.nodes[1].parentIds = ['M'];
  fails(() => validateHandoffContext(cycle), 'HANDOFF_CYCLE');

  // 编译期同样优先报缺父，而不是先报顺序
  fails(() => build([
    card('T', { parents: ['missing'], messages: [msg('user', 'T-BODY')] }),
  ], 'T'), 'HANDOFF_MISSING_PARENT');

  fails(() => build([
    card('A', { parents: ['B'], messages: [msg('user', 'A-BODY')] }),
    card('B', { parents: ['A'], messages: [msg('user', 'B-BODY')] }),
    card('T', { parents: ['A'], messages: [msg('user', 'T-BODY')] }),
  ], 'T'), 'HANDOFF_CYCLE');
});

test('unreachable nodes and unreachable cycles stay unreachable errors, not order or cycle errors', () => {
  const base = build([
    card('R', { messages: [msg('user', 'ROOT-BODY')] }),
    card('T', { parents: ['R'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');

  // 多出一个与目标无关的节点：不可达优先于顺序
  const extra = clone(base);
  extra.nodes.push({
    cardId: 'Z',
    title: '',
    parentIds: ['R'],
    contextMode: 'include',
    doc: null,
    messages: [{ role: 'user', text: 'Z-BODY', agentName: '', status: 'ok', attachments: [], artifactIds: [] }],
    artifactIds: [],
  });
  fails(() => validateHandoffContext(extra), 'HANDOFF_UNREACHABLE_NODE');

  // 不可达的环：仍是不可达，不能被当成可达环
  const loop = clone(base);
  loop.nodes.push(
    {
      cardId: 'X',
      title: '',
      parentIds: ['Y'],
      contextMode: 'include',
      doc: null,
      messages: [{ role: 'user', text: 'X-BODY', agentName: '', status: 'ok', attachments: [], artifactIds: [] }],
      artifactIds: [],
    },
    {
      cardId: 'Y',
      title: '',
      parentIds: ['X'],
      contextMode: 'include',
      doc: null,
      messages: [{ role: 'user', text: 'Y-BODY', agentName: '', status: 'ok', attachments: [], artifactIds: [] }],
      artifactIds: [],
    },
  );
  fails(() => validateHandoffContext(loop), 'HANDOFF_UNREACHABLE_NODE');

  // 不可达的排除项同样拒绝
  const orphanExclusion = clone(base);
  orphanExclusion.exclusions.push({ cardId: 'Q', title: '', parentIds: ['R'] });
  fails(() => validateHandoffContext(orphanExclusion), 'HANDOFF_UNREACHABLE_NODE');
});

// ---------------------------------------------------------------------------
// 7. parents 去重保留首次出现顺序（节点与排除项都一样）
// ---------------------------------------------------------------------------

test('duplicate parent ids are deduped in first-occurrence order for nodes and exclusions', () => {
  const context = build([
    card('R', { messages: [msg('user', 'ROOT-BODY')] }),
    card('S', { messages: [msg('user', 'S-BODY')] }),
    card('E', { parents: ['R'], contextMode: 'exclude', messages: [msg('assistant', 'E-BODY')] }),
    card('T', { parents: ['S', 'E'], messages: [msg('user', 'T-BODY')] }),
  ], 'T');
  assert.deepEqual(context.nodes.map(node => node.cardId), ['S', 'R', 'T']);
  assert.deepEqual(context.exclusions.map(item => item.cardId), ['E']);

  const duplicated = clone(context);
  duplicated.nodes[2].parentIds = ['S', 'E', 'S', 'E'];
  const normalized = validateHandoffContext(duplicated);
  assert.deepEqual(normalized.nodes[2].parentIds, ['S', 'E'], '保留首次出现顺序并去重');

  const excludedDup = clone(context);
  excludedDup.exclusions[0].parentIds = ['R', 'R', 'S'];
  const normalizedExclusion = validateHandoffContext(excludedDup);
  assert.deepEqual(normalizedExclusion.exclusions[0].parentIds, ['R', 'S'], '排除项同样按首次顺序去重');
});
