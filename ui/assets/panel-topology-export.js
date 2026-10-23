import { collectChainCards, cardParentIds } from './panel-context.js';
import { STATUS_STAMPS } from './fork-session-store.js';
import { contextByteLength } from './fork-context-policy.js';

/**
 * 拓扑结构大纲导出。
 *
 * 与「导出整条问答链路」不同，这里**只导结构**：节点、父边、标记、类型。
 * 正文、附件、文档内容一律不进大纲，所以它可以放心贴给协作方看。
 *
 * 纯函数，不碰 DOM。
 */

/** 单行标题的清洗：换行与控制字符会把大纲的行结构伪造掉 */
function sanitizeTitle(value) {
  const text = String(value ?? '');
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function cardKind(card) {
  if (card?.isDoc) return 'doc';
  if (card?.isMerge) return 'merge';
  if (card?.isBattle) return 'battle';
  return 'branch';
}

/**
 * 白名单投影：只取结构相关的字段。
 *
 * `parentIds` 里指向链外的父节点单独列出来，它们不是错误，
 * 只是不在这次的祖先范围内（比如兄弟分支或已删除的卡片）。
 */
export function projectTopology({ cards = [], targetCard } = {}) {
  const cardList = Array.isArray(cards) ? cards : [];
  const chain = collectChainCards({ cards: cardList, targetCard });
  const inChain = new Set(chain.map(card => card.id));
  const nodes = chain.map((card, index) => {
    const parents = cardParentIds(card);
    return {
      index: index + 1,
      id: String(card.id ?? ''),
      title: sanitizeTitle(card.title) || '对话卡片',
      kind: cardKind(card),
      stamp: STATUS_STAMPS.includes(card.statusStamp) ? card.statusStamp : null,
      parentIds: parents.filter(id => inChain.has(id)),
      detachedParentIds: parents.filter(id => !inChain.has(id)),
      isTarget: card.id === targetCard?.id,
      // 引用只留身份与来源，正文不进大纲——大纲是能贴出去给人看的东西
      refs: (Array.isArray(card.contextRefs) ? card.contextRefs : []).map(ref => ({
        id: ref.id,
        sourceCardId: ref.sourceCardId,
        sourceTitle: sanitizeTitle(ref.sourceTitle),
        bytes: contextByteLength(ref.text),
      })),
    };
  });
  const edges = [];
  for (const node of nodes) {
    for (const parentId of node.parentIds) edges.push({ from: parentId, to: node.id });
  }
  return {
    targetId: targetCard?.id ? String(targetCard.id) : null,
    nodes,
    edges,
    ok: nodes.length > 0,
  };
}

const KIND_LABEL = { doc: '资料源', merge: '合并', battle: '对比', branch: '分支' };
const STAMP_LABEL = { starred: '星标', accepted: '已采纳', rejected: '已否决' };

/**
 * 把投影渲染成大纲。节点用 `[序号] id` 开头，标题放引号里，
 * 标题再怪也不会被当成结构指令。
 */
export function formatTopologyOutline(projection, { title } = {}) {
  const { nodes = [], edges = [], targetId = null } = projection || {};
  const heading = sanitizeTitle(title) || '结构大纲';
  if (!nodes.length) return `# ${heading}\n\n（没有可导出的节点）\n`;
  const lines = [];
  lines.push(`# ${heading}`);
  lines.push('');
  lines.push(`节点 ${nodes.length} 个 · 父边 ${edges.length} 条${targetId ? ` · 目标 ${targetId}` : ''}`);
  lines.push('');
  for (const node of nodes) {
    const marks = [];
    marks.push(KIND_LABEL[node.kind] || '分支');
    if (node.stamp) marks.push(STAMP_LABEL[node.stamp]);
    if (node.isTarget) marks.push('当前节点');
    const parents = node.parentIds.length ? node.parentIds.join(', ') : '无（根）';
    const detached = node.detachedParentIds.length
      ? ` · 链外父节点 ${node.detachedParentIds.join(', ')}`
      : '';
    lines.push(`[${node.index}] ${node.id} 「${node.title}」`);
    lines.push(`    类型 ${marks.join(' / ')} · 父节点 ${parents}${detached}`);
    if (node.refs && node.refs.length) {
      const refText = node.refs
        .map(ref => `${ref.sourceCardId}「${ref.sourceTitle}」${ref.bytes}字节`)
        .join('、');
      lines.push(`    引用 ${node.refs.length} 条 · ${refText}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 一步到位：从卡片直接得到大纲文本 */
export function buildTopologyOutline({ cards = [], targetCard, title } = {}) {
  return formatTopologyOutline(projectTopology({ cards, targetCard }), { title });
}
