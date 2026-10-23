/**
 * panel-connectors.js
 * SVG 贝塞尔曲线连线渲染与几何计算引擎
 */

/**
 * 计算两个卡片之间的精确贝塞尔曲线锚点与控制点几何
 */
export function calculateConnectorGeometry({ parent, child, sibIndex = 0, sibCount = 1, pIndex = 0, parentCount = 1 }) {
  // 多分支子卡片在起点微调 Y 锚点错位，形成规整线束扇出效果
  const startOffsetY = sibCount > 1
    ? 110 + (sibIndex - (sibCount - 1) / 2) * 12
    : 110;

  // 判断相对位置：子卡片在父卡片右侧还是左侧
  const isForward = child.x >= parent.x;

  // 起点：前进向右从父右边缘引出；后退向左从父左边缘引出，规避麻花畸变
  const startX = isForward ? parent.x + (parent.width || 340) : parent.x;
  const startY = parent.y + startOffsetY;

  // 终点：前进向右连入子左边缘；后退向左连入子右边缘
  const endOffsetY = parentCount > 1
    ? 110 + (pIndex - (parentCount - 1) / 2) * 14
    : 110;
  const endX = isForward ? child.x : child.x + (child.width || 340);
  const endY = child.y + endOffsetY;

  const spanX = Math.abs(endX - startX);
  const deltaX = Math.max(spanX * 0.55, 30);
  const c1X = isForward ? startX + deltaX : startX - deltaX;
  const c2X = isForward ? endX - deltaX : endX + deltaX;

  const d = `M ${startX} ${startY} C ${c1X} ${startY}, ${c2X} ${endY}, ${endX} ${endY}`;

  return {
    isForward,
    startX,
    startY,
    endX,
    endY,
    c1X,
    c2X,
    d,
  };
}

/**
 * 渲染全量卡片之间的贝塞尔连线到 SVG 容器（支持拓扑 O(N) 索引加速与节点增量原位复用）
 */
export function renderConnectorsLayer({ svg, cards, cardParentIds, cardHasParent, documentRef = typeof document !== 'undefined' ? document : null }) {
  if (!svg || !cards) return;
  const doc = documentRef || svg.ownerDocument;
  if (!doc) return;

  // 1. O(N) 一次遍历：建立卡片字典、兄弟序号与兄弟总数索引，彻底消灭内层循环中的 indexOf 平方级扫描
  const cardMap = new Map();
  for (let i = 0; i < cards.length; i++) {
    cardMap.set(cards[i].id, cards[i]);
  }

  const childIndexMap = new Map(); // key: `${pId}->${child.id}` => sibIndex (0-based)
  const parentSibCounts = new Map(); // key: pId => total siblings count

  for (let i = 0; i < cards.length; i++) {
    const child = cards[i];
    const parentIds = cardParentIds(child);
    if (parentIds && parentIds.length > 0) {
      for (let j = 0; j < parentIds.length; j++) {
        const pId = parentIds[j];
        const currentCount = parentSibCounts.get(pId) || 0;
        childIndexMap.set(`${pId}->${child.id}`, currentCount);
        parentSibCounts.set(pId, currentCount + 1);
      }
    }
  }

  // 2. 收集所有有效边及其计算几何（全过程纯 O(1) 字典查找，严格 O(N) 几何计算）
  const edges = [];
  for (let i = 0; i < cards.length; i++) {
    const child = cards[i];
    const parentIds = cardParentIds(child);
    if (!parentIds || parentIds.length === 0) continue;

    for (let pIndex = 0; pIndex < parentIds.length; pIndex++) {
      const pId = parentIds[pIndex];
      const parent = cardMap.get(pId);
      if (!parent) continue;

      const sibIndex = childIndexMap.get(`${pId}->${child.id}`) ?? 0;
      const sibCount = parentSibCounts.get(pId) || 1;

      const geom = calculateConnectorGeometry({
        parent,
        child,
        sibIndex,
        sibCount,
        pIndex,
        parentCount: parentIds.length,
      });

      edges.push({
        edgeKey: `${pId}->${child.id}`,
        geom,
      });
    }
  }

  const existingChildren = svg.children || [];
  const requiredElementCount = edges.length * 3;

  // 3. 增量复用检测：如果现有 DOM 节点数量与拓扑边结构完全一致（如卡片拖拽、尺寸缩放高频帧），直接原位更新属性
  let canReuseInPlace = existingChildren.length === requiredElementCount;
  if (canReuseInPlace) {
    for (let i = 0; i < edges.length; i++) {
      const pathEl = existingChildren[i * 3 + 1];
      if (!pathEl || pathEl.getAttribute?.('data-edge') !== edges[i].edgeKey) {
        canReuseInPlace = false;
        break;
      }
    }
  }

  if (canReuseInPlace) {
    for (let i = 0; i < edges.length; i++) {
      const { geom } = edges[i];
      const baseIdx = i * 3;
      const pathBg = existingChildren[baseIdx];
      const path = existingChildren[baseIdx + 1];
      const circle = existingChildren[baseIdx + 2];

      if (pathBg.getAttribute?.('d') !== geom.d) pathBg.setAttribute('d', geom.d);
      if (path.getAttribute?.('d') !== geom.d) path.setAttribute('d', geom.d);
      const strEndX = String(geom.endX);
      const strEndY = String(geom.endY);
      if (circle.getAttribute?.('cx') !== strEndX) circle.setAttribute('cx', strEndX);
      if (circle.getAttribute?.('cy') !== strEndY) circle.setAttribute('cy', strEndY);
    }
    return;
  }

  // 4. 拓扑结构变动或初次挂载：清空并全量构建
  svg.innerHTML = '';

  for (let i = 0; i < edges.length; i++) {
    const { edgeKey, geom } = edges[i];

    // 背景粗边描边（5px 白色隔离带）
    const pathBg = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    pathBg.setAttribute('d', geom.d);
    pathBg.setAttribute('fill', 'none');
    pathBg.setAttribute('stroke', '#ffffff');
    pathBg.setAttribute('stroke-width', '5');
    pathBg.setAttribute('data-edge-bg', edgeKey);
    svg.appendChild(pathBg);

    // 主连线（1.8px 深色主干）
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', geom.d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#18181b');
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('data-edge', edgeKey);
    svg.appendChild(path);

    // 终点微圆环
    const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', String(geom.endX));
    circle.setAttribute('cy', String(geom.endY));
    circle.setAttribute('r', '3');
    circle.setAttribute('fill', '#18181b');
    circle.setAttribute('data-edge-circle', edgeKey);
    svg.appendChild(circle);
  }
}

/**
 * 引用虚线层。
 *
 * 与父边完全分开：自己的容器、自己的 key、自己清空重建。
 * 引用不参与根节点计算、折叠、级联删除和祖先忙检查，
 * 所以这里也只做一件事——画出来，缺端点就不画。
 */
export function renderReferenceConnectors({ svg, cards, documentRef = null } = {}) {
  if (!svg || !Array.isArray(cards)) return;
  const doc = documentRef || svg.ownerDocument;
  if (doc) {
    const cardMap = new Map(cards.map(card => [card.id, card]));
    const edges = [];
    for (const owner of cards) {
      const refs = Array.isArray(owner.contextRefs) ? owner.contextRefs : [];
      for (const ref of refs) {
        const source = cardMap.get(ref?.sourceCardId);
        // 来源没了就只保留文字快照，不画一条指向虚空的线
        if (!source) continue;
        if (source.x === owner.x && source.y === owner.y) continue;
        edges.push({ edgeKey: `ref:${ref.id}`, source, owner });
      }
    }
    svg.innerHTML = '';
    for (const { edgeKey, source, owner } of edges) {
      const geom = calculateConnectorGeometry({ parent: source, child: owner });
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', geom.d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#8a8378');
      path.setAttribute('stroke-width', '1.2');
      path.setAttribute('stroke-dasharray', '5 4');
      path.setAttribute('data-ref-edge', edgeKey);
      svg.appendChild(path);
    }
  }
}
