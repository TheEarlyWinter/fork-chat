/**
 * panel-layout.js
 * 画布树状排版、碰撞规避、分支Y坐标分布与视口聚焦计算引擎
 */

/**
 * 在目标 X 坐标处为 count 个兄弟分支计算规避碰撞的 Y 轴分布
 */
export function calculateBranchYPositions(parentCard, count, targetX, cards = []) {
  const step = 380;
  const totalSpan = (count - 1) * step;
  const idealStartY = Math.round(parentCard.y - (totalSpan / 2));
  const candidateYs = Array.from({ length: count }, (_, i) => idealStartY + i * step);

  const existingInColumn = cards.filter(c => c.id !== parentCard.id && Math.abs(c.x - targetX) < 120);
  if (existingInColumn.length === 0) {
    return candidateYs;
  }

  // 检测理想排布是否与现有卡片发生重叠（间距小于 320px 视为重叠）
  const hasCollision = candidateYs.some(y => existingInColumn.some(c => Math.abs(c.y - y) < 320));
  if (!hasCollision) {
    return candidateYs;
  }

  // 发生碰撞，向下平移至已有列的最底端之后
  const maxY = Math.max(...existingInColumn.map(c => c.y));
  const safeStartY = maxY + step;
  return Array.from({ length: count }, (_, i) => safeStartY + i * step);
}

/**
 * 将视口缩放与平移对齐聚焦至卡片集群
 */
export function fitViewportToCluster(clusterCards, { viewport, view }) {
  if (!clusterCards || clusterCards.length === 0 || !view) return;

  const cardW = c => (typeof c.width === 'number' && c.width > 0 ? c.width : 340);
  // 卡片高度以前写死 360，长文档卡和短卡混在一起时，垂直中心就偏了
  const cardH = c => (typeof c.height === 'number' && c.height > 0 ? c.height : 360);

  const minX = Math.min(...clusterCards.map(c => c.x));
  const maxX = Math.max(...clusterCards.map(c => c.x + cardW(c)));
  const minY = Math.min(...clusterCards.map(c => c.y));
  const maxY = Math.max(...clusterCards.map(c => c.y + cardH(c)));

  const padX = 80;
  const padY = 80;
  const clusterWidth = (maxX - minX) + padX * 2;
  const clusterHeight = (maxY - minY) + padY * 2;
  if (clusterWidth <= 0 || clusterHeight <= 0) return;

  // clientWidth/Height 不含边框与滚动条，跟 translate 的坐标系一致
  const vpRect = viewport?.getBoundingClientRect?.() || {};
  const vpWidth = viewport?.clientWidth || vpRect.width || 1000;
  const vpHeight = viewport?.clientHeight || vpRect.height || 700;

  // 下限跟着存储契约走（0.4–2.2），越界会被快照校验打回
  const targetScale = Math.min(1.0, Math.max(0.4, Math.min(vpWidth / clusterWidth, vpHeight / clusterHeight)));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  view.scale = Number(targetScale.toFixed(2));
  // surface 的 transform-origin 是 0 0，所以屏幕上某点 = 卡片坐标 * scale + view.x
  view.x = Math.round(vpWidth / 2 - centerX * view.scale);
  view.y = Math.round(vpHeight / 2 - centerY * view.scale);
}

/**
 * 树状一键自动整理排版算法 (Auto-Tidy Engine)
 * 计算每个卡片的拓扑层级、列宽分布与树状垂直对称对齐
 */
export function computeAutoTidyPositions(cards, cardParentIds) {
  if (!cards || cards.length === 0) return new Map();

  const cardMap = new Map(cards.map(c => [c.id, c]));
  const childrenMap = new Map();
  const roots = [];

  cards.forEach(c => {
    childrenMap.set(c.id, []);
  });

  cards.forEach(c => {
    const parents = cardParentIds(c).filter(parentId => cardMap.has(parentId));
    if (parents.length > 0) {
      for (const parentId of parents) childrenMap.get(parentId).push(c);
    } else {
      roots.push(c);
    }
  });

  childrenMap.forEach(list => {
    list.sort((a, b) => a.y - b.y);
  });
  roots.sort((a, b) => a.y - b.y);

  let currentY = 80;
  const startX = 80;
  const cardH = 360;
  const gapY = 32;
  const gapRoot = 60;

  // 计算每层的最大卡片宽度，确保拉伸后的宽卡片在排版时列间距自适应且不重叠
  const depthMap = new Map();
  const depthVisiting = new Set();
  function assignDepth(node, depth) {
    if (!node) return;
    const previous = depthMap.get(node.id);
    if (previous !== undefined && previous >= depth) return;
    depthMap.set(node.id, depth);
    if (depthVisiting.has(node.id)) return;
    depthVisiting.add(node.id);
    const children = childrenMap.get(node.id) || [];
    children.forEach(child => assignDepth(child, depth + 1));
    depthVisiting.delete(node.id);
  }
  roots.forEach(root => assignDepth(root, 0));
  cards.forEach(card => {
    if (!depthMap.has(card.id)) assignDepth(card, 0);
  });

  const maxColWidth = new Map();
  cards.forEach(c => {
    const d = depthMap.get(c.id) || 0;
    const w = c.width || 340;
    maxColWidth.set(d, Math.max(maxColWidth.get(d) || 340, w));
  });

  const colStartX = new Map();
  let accumulatedX = startX;
  const maxDepth = Math.max(0, ...Array.from(depthMap.values()));
  for (let d = 0; d <= maxDepth; d++) {
    colStartX.set(d, accumulatedX);
    const colW = maxColWidth.get(d) || 340;
    accumulatedX += colW + 120;
  }

  const positions = new Map();
  const laidOut = new Set();
  const layoutVisiting = new Set();
  const colNextY = new Map();

  function layoutSubtree(node, depth) {
    if (!node || laidOut.has(node.id) || layoutVisiting.has(node.id)) return;
    layoutVisiting.add(node.id);
    const nodeDepth = depthMap.get(node.id) ?? depth;
    const children = childrenMap.get(node.id) || [];
    const targetX = colStartX.get(nodeDepth) ?? (startX + nodeDepth * 460);
    const nodeH = typeof node.height === 'number' ? node.height : cardH;

    children.forEach(child => {
      layoutSubtree(child, nodeDepth + 1);
    });

    const positionedChildren = children.filter(child => positions.has(child.id));
    const minColY = colNextY.get(nodeDepth) ?? 80;
    let targetY = 0;
    if (positionedChildren.length === 0) {
      targetY = Math.max(currentY, minColY);
      currentY = targetY + nodeH + gapY;
    } else {
      const firstChild = positions.get(positionedChildren[0].id);
      const lastChild = positions.get(positionedChildren[positionedChildren.length - 1].id);
      const idealY = Math.round((firstChild.y + lastChild.y) / 2);
      targetY = Math.max(idealY, minColY);
      currentY = Math.max(currentY, targetY + nodeH + gapY);
    }
    colNextY.set(nodeDepth, targetY + nodeH + gapY);
    positions.set(node.id, { x: targetX, y: targetY });
    layoutVisiting.delete(node.id);
    laidOut.add(node.id);
  }

  roots.forEach(root => {
    layoutSubtree(root, 0);
    currentY += gapRoot;
  });

  // 兜底：处理未能从 roots 触达的残余或独立卡片
  cards.forEach(card => {
    if (!positions.has(card.id)) {
      layoutSubtree(card, depthMap.get(card.id) || 0);
      currentY += gapRoot;
    }
  });

  return positions;
}

/**
 * 递归搜集指定根卡片之下的所有后代节点 ID（不含根卡片本身）
 * @param {object} options
 * @param {Array<object>} options.cards
 * @param {string} options.rootCardId
 * @param {Function} [options.cardParentIds]
 * @returns {Set<string>}
 */
export function collectSubtreeCardIds({ cards = [], rootCardId, cardParentIds } = {}) {
  const result = new Set();
  if (!Array.isArray(cards) || !rootCardId) return result;

  const resolveParentIds = (card) => {
    if (typeof cardParentIds === 'function') {
      const res = cardParentIds(card);
      if (Array.isArray(res)) return res;
    }
    const ids = [];
    if (card?.parentId) ids.push(card.parentId);
    if (Array.isArray(card?.parentIds)) ids.push(...card.parentIds);
    return Array.from(new Set(ids));
  };

  // 建立 parent -> children 邻接表
  const childrenMap = new Map();
  for (const card of cards) {
    if (!card || !card.id) continue;
    const pIds = resolveParentIds(card);
    for (const pId of pIds) {
      if (!childrenMap.has(pId)) childrenMap.set(pId, []);
      childrenMap.get(pId).push(card.id);
    }
  }

  // 广度优先遍历所有子孙节点
  const queue = [...(childrenMap.get(rootCardId) || [])];
  while (queue.length > 0) {
    const childId = queue.shift();
    if (!result.has(childId) && childId !== rootCardId) {
      result.add(childId);
      const grandChildren = childrenMap.get(childId) || [];
      for (const gcId of grandChildren) {
        if (!result.has(gcId) && gcId !== rootCardId) {
          queue.push(gcId);
        }
      }
    }
  }

  return result;
}

/**
 * 遍历卡片集合，计算受折叠状态影响后真正可见的卡片列表与隐藏卡片集合
 * @param {object} options
 * @param {Array<object>} options.cards
 * @param {Function} [options.cardParentIds]
 * @returns {{ visibleCards: Array<object>, hiddenCardIds: Set<string> }}
 */
export function computeVisibleCards({ cards = [], cardParentIds } = {}) {
  if (!Array.isArray(cards)) return { visibleCards: [], hiddenCardIds: new Set() };

  const hiddenCardIds = new Set();

  for (const card of cards) {
    if (card && card.isCollapsed) {
      const subtreeIds = collectSubtreeCardIds({ cards, rootCardId: card.id, cardParentIds });
      for (const id of subtreeIds) {
        hiddenCardIds.add(id);
      }
    }
  }

  const visibleCards = cards.filter(card => card && !hiddenCardIds.has(card.id));
  return { visibleCards, hiddenCardIds };
}
