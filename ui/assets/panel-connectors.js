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
 * 渲染全量卡片之间的贝塞尔连线到 SVG 容器
 */
export function renderConnectorsLayer({ svg, cards, cardParentIds, cardHasParent, documentRef = typeof document !== 'undefined' ? document : null }) {
  if (!svg || !cards) return;
  const doc = documentRef || svg.ownerDocument;
  if (!doc) return;

  svg.innerHTML = '';

  cards.forEach(child => {
    const parentIds = cardParentIds(child);
    if (!parentIds || parentIds.length === 0) return;

    parentIds.forEach((pId, pIndex) => {
      const parent = cards.find(c => c.id === pId);
      if (!parent) return;

      const siblings = cards.filter(c => cardHasParent(c, parent.id));
      const sibIndex = siblings.indexOf(child);
      const sibCount = siblings.length;

      const geom = calculateConnectorGeometry({
        parent,
        child,
        sibIndex: sibIndex >= 0 ? sibIndex : 0,
        sibCount: sibCount > 0 ? sibCount : 1,
        pIndex,
        parentCount: parentIds.length,
      });

      // 背景粗边描边（5px 白色隔离带）
      const pathBg = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathBg.setAttribute('d', geom.d);
      pathBg.setAttribute('fill', 'none');
      pathBg.setAttribute('stroke', '#ffffff');
      pathBg.setAttribute('stroke-width', '5');
      svg.appendChild(pathBg);

      // 主连线（1.8px 深色主干）
      const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', geom.d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#18181b');
      path.setAttribute('stroke-width', '1.8');
      svg.appendChild(path);

      // 终点微圆环
      const circle = doc.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(geom.endX));
      circle.setAttribute('cy', String(geom.endY));
      circle.setAttribute('r', '3');
      circle.setAttribute('fill', '#18181b');
      svg.appendChild(circle);
    });
  });
}
