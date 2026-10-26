import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateConnectorGeometry, renderConnectorsLayer } from '../ui/assets/panel-connectors.js';
import { calculateBranchYPositions, computeAutoTidyPositions, fitViewportToCluster } from '../ui/assets/panel-layout.js';
import * as panelLayout from '../ui/assets/panel-layout.js';
import { findCardByDirection, bindKeyboardShortcuts, isModalOrDialogActive, isFormControlElement } from '../ui/assets/panel-shortcuts.js';
import { clampScale, computeZoomAtPoint, computeCenterOnCard, computeEnsureCardVisible, applyViewportTransform, bindViewportController } from '../ui/assets/panel-viewport.js';
import { validateBattleInput, buildBattleBranchCards, bindBattleDialogController } from '../ui/assets/panel-battle.js';
import * as panelCards from '../ui/assets/panel-cards.js';
import { cloneCardTopology, createHistoryManager } from '../ui/assets/panel-history.js';
import { statusText, outputFor, asidesText, messageMarkup, createMessagePainter } from '../ui/assets/panel-messages.js';
import { cardParentIds, cardHasParent, buildChainContext } from '../ui/assets/panel-context.js';
import { escapeHtml } from '../ui/assets/panel-format.js';
import { createAgentController } from '../ui/assets/panel-agents.js';
import { createCanvasViewController } from '../ui/assets/panel-canvas-view.js';
import { createCanvasActions } from '../ui/assets/panel-canvas-actions.js';
import { createHistoryController } from '../ui/assets/panel-history-controller.js';

const { clampCardWidth, clampCardHeight, buildCardHtml } = panelCards;

function assertHistoryStats(manager, expected) {
  const stats = manager.getStats();
  assert.deepEqual(
    { undoCount: stats.undoCount, redoCount: stats.redoCount, maxDepth: stats.maxDepth },
    expected,
  );
  for (const key of ['retainedBytes', 'maxRetainedBytes', 'contentCount', 'trimmedCount', 'budgetTrimmedCount']) {
    assert.equal(Object.hasOwn(stats, key), true, `历史统计必须包含 ${key}`);
  }
}

test('panel-connectors: forward connector geometry calculates valid bezier anchor points', () => {
  const parent = { id: 'p', x: 100, y: 100, width: 340 };
  const child = { id: 'c', x: 500, y: 200, width: 340 };

  const geom = calculateConnectorGeometry({
    parent,
    child,
    sibIndex: 0,
    sibCount: 1,
    pIndex: 0,
    parentCount: 1,
  });

  assert.equal(geom.isForward, true);
  // parent.x(100) + parent.width(340) = 440; startY = 100 + 110 = 210
  assert.equal(geom.startX, 440);
  assert.equal(geom.startY, 210);
  // child.x = 500; endY = 200 + 110 = 310
  assert.equal(geom.endX, 500);
  assert.equal(geom.endY, 310);
  assert.match(geom.d, /^M 440 210 C/);
});

test('panel-connectors: backward connector geometry flips anchor edges and avoids twist', () => {
  const parent = { id: 'p', x: 600, y: 100, width: 340 };
  const child = { id: 'c', x: 100, y: 100, width: 340 };

  const geom = calculateConnectorGeometry({
    parent,
    child,
    sibIndex: 0,
    sibCount: 1,
    pIndex: 0,
    parentCount: 1,
  });

  assert.equal(geom.isForward, false);
  // 反向连线：从父卡片左侧引出
  assert.equal(geom.startX, 600);
  // 连入子卡片右侧
  assert.equal(geom.endX, 440);
  // 控制点 X 轴反向延展
  assert.ok(geom.c1X < geom.startX);
  assert.ok(geom.c2X > geom.endX);
});

test('panel-layout: branch Y positions detect collisions and shift downward safely', () => {
  const parent = { id: 'p', x: 100, y: 200, width: 340, height: 360 };
  // 在目标 X=560 处预先放置一张障碍卡片 (y: 150)
  const obstacle = { id: 'obs', x: 560, y: 150, width: 340, height: 360 };

  const positions = calculateBranchYPositions(parent, 2, 560, [parent, obstacle]);
  assert.equal(positions.length, 2);
  // 发生碰撞，候选 Y 坐标应整体避让到障碍卡片下方 (maxY 150 + step 380 = 530)
  assert.ok(positions[0] >= 530);
  assert.equal(positions[1] - positions[0], 380);
});

test('panel-layout: computeAutoTidyPositions arranges multi-level trees without overlap', () => {
  const root = { id: 'root', x: 0, y: 0, width: 340, height: 360, parentId: null };
  const b1 = { id: 'b1', x: 0, y: 0, width: 340, height: 360, parentId: 'root' };
  const b2 = { id: 'b2', x: 0, y: 0, width: 340, height: 360, parentId: 'root' };
  const cards = [root, b1, b2];

  const positions = computeAutoTidyPositions(cards, c => (c.parentId ? [c.parentId] : []));
  assert.equal(positions.size, 3);

  const rootPos = positions.get('root');
  const b1Pos = positions.get('b1');
  const b2Pos = positions.get('b2');

  assert.ok(rootPos.x < b1Pos.x);
  assert.equal(b1Pos.x, b2Pos.x);
  assert.ok(b2Pos.y > b1Pos.y);
  // 父节点垂直居中于两个子节点之间
  assert.equal(rootPos.y, Math.round((b1Pos.y + b2Pos.y) / 2));
});

test('panel-shortcuts: findCardByDirection navigates parent-child-sibling relationships', () => {
  const root = { id: 'root', parentId: null };
  const b1 = { id: 'b1', parentId: 'root' };
  const b2 = { id: 'b2', parentId: 'root' };
  const cards = [root, b1, b2];

  const cardParentIds = c => (c.parentId ? [c.parentId] : []);
  const cardHasParent = (c, pId) => c.parentId === pId;

  // 1. 从 root 向右应该找到第一个子分支 b1
  const rightTarget = findCardByDirection({
    cards,
    selectedCardId: 'root',
    direction: 'ArrowRight',
    cardParentIds,
    cardHasParent,
  });
  assert.equal(rightTarget?.id, 'b1');

  // 2. 从 b1 向左应该回到 root
  const leftTarget = findCardByDirection({
    cards,
    selectedCardId: 'b1',
    direction: 'ArrowLeft',
    cardParentIds,
    cardHasParent,
  });
  assert.equal(leftTarget?.id, 'root');

  // 3. 从 b1 向下应该切换到兄弟节点 b2
  const downTarget = findCardByDirection({
    cards,
    selectedCardId: 'b1',
    direction: 'ArrowDown',
    cardParentIds,
    cardHasParent,
  });
  assert.equal(downTarget?.id, 'b2');
});

test('panel-layout: LAYOUT-001 asymmetrical multi-parent DAG aligns merge node behind all parents', () => {
  // 构造非对称合流结构：
  // R (col 0) -> Short (col 1) -> Merge (必须为 col 3)
  // R (col 0) -> Long (col 1) -> X (col 2) -> Merge (必须为 col 3)
  const root = { id: 'R', width: 340, height: 360 };
  const shortNode = { id: 'Short', width: 340, height: 360 };
  const longNode = { id: 'Long', width: 340, height: 360 };
  const xNode = { id: 'X', width: 340, height: 360 };
  const mergeNode = { id: 'Merge', width: 340, height: 360 };

  const cards = [root, shortNode, longNode, xNode, mergeNode];
  const parentMap = {
    R: [],
    Short: ['R'],
    Long: ['R'],
    X: ['Long'],
    Merge: ['Short', 'X'],
  };

  const positions = computeAutoTidyPositions(cards, c => parentMap[c.id] || []);

  const rPos = positions.get('R');
  const shortPos = positions.get('Short');
  const longPos = positions.get('Long');
  const xPos = positions.get('X');
  const mergePos = positions.get('Merge');

  assert.ok(rPos && shortPos && longPos && xPos && mergePos);

  // 1. 验证同级列对其：Short 与 Long 均位于第 1 列
  assert.equal(shortPos.x, longPos.x, 'Short 与 Long 应处于同一拓扑列');
  assert.ok(shortPos.x > rPos.x, '一级分支应在根节点右侧');

  // 2. 验证中间节点 X 位于第 2 列
  assert.ok(xPos.x > longPos.x, '节点 X 应在父节点 Long 的右侧');

  // 3. 核心修复验证：Merge 节点必须严格位于 X 的右侧（第 3 列），绝不能与 X 落在同一列
  assert.ok(mergePos.x > xPos.x, 'Merge 节点 X 坐标必须严格大于长路径父节点 X');
  assert.ok(mergePos.x > shortPos.x, 'Merge 节点 X 坐标必须严格大于短路径父节点 Short');

  // 4. 同列防重叠验证：Short 与 Long 虽处于同一列，但垂直间距必须充足，绝不能在 (540, 80) 重叠
  assert.ok(
    Math.abs(longPos.y - shortPos.y) >= 360 + 32,
    `同列父卡 Short (${shortPos.y}) 与 Long (${longPos.y}) 垂直间距必须大于等于卡片高度与间隔，绝不能重叠`
  );
});

test('panel-shortcuts: UI-001 & LIFECYCLE-001 modal guard, button scope, IME guard, and lifecycle cleanup', () => {
  const windowListeners = new Map();
  const mockWindow = {
    addEventListener(event, handler) { windowListeners.set(event, handler); },
    removeEventListener(event, handler) {
      if (windowListeners.get(event) === handler) windowListeners.delete(event);
    },
  };

  const dialogElement = {
    id: 'battle-dialog',
    open: false,
    tagName: 'DIALOG',
    contains(el) { return el === this || el === dialogButton; },
  };
  const dialogButton = {
    tagName: 'BUTTON',
    id: 'battle-cancel',
  };

  let activeElement = null;
  const mockDoc = {
    getElementById(id) {
      if (id === 'battle-dialog') return dialogElement;
      return null;
    },
    get activeElement() { return activeElement; },
  };

  let closedCard = null;
  const actions = {
    setSpacePressed() {},
    chainIsBusy: () => false,
    createBranchCard() {},
    navigateCardFocus() {},
    closeBattleDialog() {},
    clearMultiSelect() {},
    selectCard() {},
    closeCardHierarchy(c) { closedCard = c; },
    autoTidyLayout() {},
    createMergeCardFromSelected() {},
  };

  let state = {
    cards: [{ id: 'card-1' }],
    selectedCardId: 'card-1',
    battleDialogOpen: false,
    isSpacePressed: false,
    multiSelectedCount: 0,
  };

  const unbind = bindKeyboardShortcuts({
    windowRef: mockWindow,
    documentRef: mockDoc,
    viewport: null,
    getState: () => state,
    actions,
  });

  const keydown = windowListeners.get('keydown');
  assert.ok(keydown, '应成功注册 keydown 监听');

  // 1. 正常状态：按 Delete 触发卡片删除
  activeElement = null;
  keydown({ key: 'Delete' });
  assert.equal(closedCard?.id, 'card-1', '非模态下按 Delete 应当触发卡片删除');

  // 2. UI-001 复现条件验证：弹窗打开且焦点落在按钮等控件上时按 Delete
  closedCard = null;
  dialogElement.open = true;
  state.battleDialogOpen = true;
  activeElement = dialogButton; // 焦点落在弹窗按钮上
  keydown({ key: 'Delete' });
  assert.equal(closedCard, null, '模态弹窗打开时，按 Delete 严禁穿透删除画布卡片');

  // 3. 焦点在普通表单控件（例如按钮）上时，即使弹窗关闭也不触发画布删除
  closedCard = null;
  dialogElement.open = false;
  state.battleDialogOpen = false;
  activeElement = { tagName: 'BUTTON' };
  keydown({ key: 'Delete' });
  assert.equal(closedCard, null, '普通按钮聚焦时，按 Delete 不应误删画布卡片');

  // 4. 输入法合成态保护 (IME Composition Guard)
  closedCard = null;
  activeElement = null;
  keydown({ key: 'Delete', isComposing: true });
  assert.equal(closedCard, null, '输入法合成态下按键不应触发卡片删除');

  // 5. LIFECYCLE-001 解绑闭环测试
  unbind();
  assert.equal(windowListeners.has('keydown'), false, '调用 unbind 后 keydown 必须被彻底移除');
  assert.equal(windowListeners.has('keyup'), false, '调用 unbind 后 keyup 必须被彻底移除');
});

test('panel-connectors: PERF-001 in-place incremental reuse and O(N) indexing', () => {
  const parent = { id: 'p', x: 100, y: 100, width: 340 };
  const child = { id: 'c', x: 500, y: 200, width: 340 };
  const cards = [parent, child];
  const cardParentIds = c => (c.id === 'c' ? ['p'] : []);
  const cardHasParent = (c, pId) => c.id === 'c' && pId === 'p';

  class MockSvgElement {
    constructor() {
      this.children = [];
      this.attributes = {};
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k] ?? null; }
  }

  const mockSvg = {
    children: [],
    attributes: {},
    innerHTML: 'not-empty',
    appendChild(el) { this.children.push(el); },
  };

  const mockDoc = {
    createElementNS(_ns, tag) {
      const el = new MockSvgElement();
      el.tag = tag;
      return el;
    },
  };

  // 1. 初次渲染：构建 3 个 DOM 元素（pathBg, path, circle）
  renderConnectorsLayer({
    svg: mockSvg,
    cards,
    cardParentIds,
    cardHasParent,
    documentRef: mockDoc,
  });

  assert.equal(mockSvg.children.length, 3);
  const originalPathBg = mockSvg.children[0];
  const originalPath = mockSvg.children[1];
  const originalCircle = mockSvg.children[2];

  assert.equal(originalPath.getAttribute('data-edge'), 'p->c');
  const firstD = originalPath.getAttribute('d');
  assert.ok(firstD);

  // 2. 模拟高频移动（如鼠标拖拽导致卡片坐标变动，拓扑不变）
  child.y = 350; // Y 轴微移
  renderConnectorsLayer({
    svg: mockSvg,
    cards,
    cardParentIds,
    cardHasParent,
    documentRef: mockDoc,
  });

  // 验证增量就地复用：DOM 节点实例没有被重新创建或替换！
  assert.equal(mockSvg.children.length, 3);
  assert.equal(mockSvg.children[0], originalPathBg, '背景路径 DOM 节点必须就地复用');
  assert.equal(mockSvg.children[1], originalPath, '主连线 DOM 节点必须就地复用');
  assert.equal(mockSvg.children[2], originalCircle, '端点圆环 DOM 节点必须就地复用');

  // 验证坐标属性已精准更新
  const updatedD = originalPath.getAttribute('d');
  assert.notEqual(updatedD, firstD, '更新后的几何路径属性应当同步反映坐标变化');
  assert.equal(originalCircle.getAttribute('cy'), String(350 + 110));

  // 3. 性能验证：大规模子节点（400 个分支）场景下几何索引计算应为严格 O(N)，无 indexOf 平方级衰退
  const largeCards = [{ id: 'parent-hub', x: 100, y: 100, width: 340 }];
  for (let i = 0; i < 400; i++) {
    largeCards.push({ id: `child-${i}`, x: 600, y: 100 + i * 40, width: 340 });
  }
  const largeParentIds = c => (c.id === 'parent-hub' ? [] : ['parent-hub']);
  const largeSvg = { children: [], innerHTML: '', appendChild(el) { this.children.push(el); } };

  const startT = performance.now();
  renderConnectorsLayer({
    svg: largeSvg,
    cards: largeCards,
    cardParentIds: largeParentIds,
    documentRef: mockDoc,
  });
  const elapsed = performance.now() - startT;

  assert.equal(largeSvg.children.length, 400 * 3, '400 条连线应完整构建 1200 个 SVG 节点');
  assert.ok(elapsed < 100, `400 条连线应在 100ms 内极速完成 (耗时: ${elapsed.toFixed(2)}ms)`);
});

test('panel-viewport: clampScale, zoom math, center-on-card, ensure-visible, and DOM transform', () => {
  // 1. 缩放范围限制 clampScale
  assert.equal(clampScale(0.2), 0.4, '低于最小缩放应 clamp 到 0.4');
  assert.equal(clampScale(3.0), 2.2, '高于最大缩放应 clamp 到 2.2');
  assert.equal(clampScale(1.5), 1.5, '合法缩放应保持原值');

  // 2. 以视口任意鼠标点为锚点进行缩放 computeZoomAtPoint
  const initialView = { x: 100, y: 100, scale: 1.0 };
  const zoomed = computeZoomAtPoint({
    view: initialView,
    mouseX: 400,
    mouseY: 300,
    factor: 1.5,
  });
  assert.equal(zoomed.scale, 1.5);
  // 缩放中心公式: newX = mouseX - (mouseX - x) * (newScale / scale)
  // 400 - (400 - 100) * 1.5 = 400 - 450 = -50
  assert.equal(zoomed.x, -50);
  // 300 - (300 - 100) * 1.5 = 300 - 300 = 0
  assert.equal(zoomed.y, 0);

  // 3. 将指定卡片居中到视口中心 computeCenterOnCard
  const card = { id: 'c1', x: 200, y: 100, width: 340, height: 360 };
  const centerPos = computeCenterOnCard({
    card,
    viewportWidth: 1000,
    viewportHeight: 800,
    scale: 1.0,
  });
  // center X = 1000 / 2 - (200 + 340 / 2) * 1 = 500 - 370 = 130
  assert.equal(centerPos.x, 130);
  // center Y = 800 / 2 - (100 + 360 / 2) * 1 = 400 - 280 = 120
  assert.equal(centerPos.y, 120);

  // 4. 边界可见性平移修正 computeEnsureCardVisible
  const viewAtOrigin = { x: 0, y: 0, scale: 1.0 };
  // 卡片超出右边界：card.x = 900, width = 340 => 右边界为 1240，视口宽 1000，margin 40 => 最大允许 960
  const adjusted = computeEnsureCardVisible({
    card: { x: 900, y: 100, width: 340, height: 360 },
    view: viewAtOrigin,
    viewportWidth: 1000,
    viewportHeight: 800,
    margin: 40,
  });
  assert.ok(adjusted.x < 0, '超出右侧视口应向左平移');
  assert.equal(adjusted.x, -280); // 1240 - 960 = 280 => view.x 减少 280

  // 5. DOM 变换同步 applyViewportTransform
  const mockSurface = { style: {} };
  const mockViewport = { style: {} };
  const mockZoomText = { textContent: '' };
  applyViewportTransform({
    surface: mockSurface,
    viewport: mockViewport,
    zoomText: mockZoomText,
    view: { x: 50, y: 80, scale: 1.25 },
    isDisposed: false,
  });
  assert.equal(mockSurface.style.transform, 'translate(50px, 80px) scale(1.25)');
  assert.equal(mockZoomText.textContent, '125%');
  assert.equal(mockViewport.style.backgroundPosition, '50px 80px');
  assert.equal(mockViewport.style.backgroundSize, `${24 * 1.25}px ${24 * 1.25}px`);

  // 6. 销毁保护：isDisposed 为 true 时禁止触碰 DOM
  mockSurface.style.transform = 'unchanged';
  applyViewportTransform({
    surface: mockSurface,
    viewport: mockViewport,
    zoomText: mockZoomText,
    view: { x: 100, y: 200, scale: 2.0 },
    isDisposed: true,
  });
  assert.equal(mockSurface.style.transform, 'unchanged', '已销毁状态下严禁修改 surface transform');
});

test('panel-viewport: bindViewportController manages mouse dragging, wheel zoom, and cleanup', () => {
  const listeners = [];
  const mockListen = (target, event, handler, options) => {
    const record = { target, event, handler, options };
    listeners.push(record);
    return () => {
      const idx = listeners.indexOf(record);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  };

  const mockViewport = {
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      remove(c) { this.classes.delete(c); },
      contains(c) { return this.classes.has(c); },
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
    style: {},
  };
  const mockSurface = { style: {} };
  const mockZoomText = { textContent: '' };
  const mockBtnZoomIn = {};
  const mockBtnZoomOut = {};
  const mockWindow = {};

  const view = { x: 60, y: 40, scale: 1.0, isDragging: false, dragStartX: 0, dragStartY: 0 };
  let isDisposed = false;
  let isSpacePressed = false;
  let saveScheduled = false;

  const controller = bindViewportController({
    viewport: mockViewport,
    surface: mockSurface,
    zoomText: mockZoomText,
    btnZoomIn: mockBtnZoomIn,
    btnZoomOut: mockBtnZoomOut,
    view,
    getState: () => ({ isDisposed, isSpacePressed }),
    onTransformChange: () => { saveScheduled = true; },
    listen: mockListen,
    windowRef: mockWindow,
  });

  // 验证绑定的监听器清单
  assert.ok(listeners.length >= 5, '至少应绑定 mousedown, mousemove, mouseup, wheel 以及 zoom 按钮');

  // 模拟普通画布拖拽：mousedown on viewport
  const mousedownHandler = listeners.find(l => l.target === mockViewport && l.event === 'mousedown').handler;
  const preventDefaultCalled = false;
  mousedownHandler({
    button: 0,
    clientX: 200,
    clientY: 150,
    target: mockViewport,
    preventDefault: () => {},
  });
  assert.equal(view.isDragging, true, '按下左键应当启动拖拽');
  assert.equal(mockViewport.classList.contains('is-dragging-canvas'), true);

  // 模拟鼠标平移：mousemove on window
  const mousemoveHandler = listeners.find(l => l.target === mockWindow && l.event === 'mousemove').handler;
  mousemoveHandler({ clientX: 250, clientY: 180 });
  // 相对初始拖拽点移动了 dx: 50, dy: 30
  assert.equal(view.x, 60 + 50);
  assert.equal(view.y, 40 + 30);
  assert.equal(saveScheduled, true);

  // 模拟鼠标释放：mouseup on window
  const mouseupHandler = listeners.find(l => l.target === mockWindow && l.event === 'mouseup').handler;
  mouseupHandler();
  assert.equal(view.isDragging, false, '释放鼠标应当停止拖拽');
  assert.equal(mockViewport.classList.contains('is-dragging-canvas'), false);

  // 模拟按键缩放 zoomIn
  controller.zoomIn();
  assert.ok(view.scale > 1.0, 'zoomIn 应当使 scale 放大');

  // 验证 cleanup 闭环：注销后所有监听器被完全清空
  controller.cleanup();
  assert.equal(listeners.length, 0, '调用 cleanup 后必须解绑所有事件监听');
});

test('panel-viewport: data-canvas-ui 浮层与卡片在按住 Space 与滚轮时严格隔离视口拖拽与缩放', () => {
  const listeners = [];
  const mockListen = (target, event, handler, options) => {
    const record = { target, event, handler, options };
    listeners.push(record);
    return () => {
      const idx = listeners.indexOf(record);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  };

  const mockViewport = {
    classList: {
      classes: new Set(),
      add(c) { this.classes.add(c); },
      remove(c) { this.classes.delete(c); },
      contains(c) { return this.classes.has(c); },
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 800 }),
    style: {},
  };
  const mockSurface = { style: {} };
  const mockZoomText = { textContent: '' };
  const view = { x: 60, y: 40, scale: 1.0, isDragging: false, dragStartX: 0, dragStartY: 0 };
  let isDisposed = false;
  let isSpacePressed = false;

  const controller = bindViewportController({
    viewport: mockViewport,
    surface: mockSurface,
    zoomText: mockZoomText,
    view,
    getState: () => ({ isDisposed, isSpacePressed }),
    listen: mockListen,
  });

  const mousedownHandler = listeners.find(l => l.target === mockViewport && l.event === 'mousedown').handler;
  const wheelHandler = listeners.find(l => l.target === mockViewport && l.event === 'wheel').handler;

  // 构造带 data-canvas-ui 属性的元素与子元素
  const uiElement = { dataset: { canvasUi: '' } };
  const buttonInsideUi = {
    closest: (sel) => {
      if (sel.includes('data-canvas-ui') || sel.includes('[data-canvas-ui]')) return uiElement;
      return null;
    },
  };

  // 1. 在 data-canvas-ui 元素上按下鼠标，Space 未按下时：不得拖拽
  let defaultPrevented = false;
  mousedownHandler({
    button: 0,
    clientX: 200,
    clientY: 150,
    target: buttonInsideUi,
    preventDefault: () => { defaultPrevented = true; },
  });
  assert.equal(view.isDragging, false, '在 data-canvas-ui 内部按下鼠标不得启动画布拖拽');
  assert.equal(defaultPrevented, false, '不得 preventDefault 抢占浮层内按钮点击');

  // 2. 关键防御：在 data-canvas-ui 元素上按下鼠标，即使按住了 Space：也绝对不得启动画布拖拽或抢占事件
  isSpacePressed = true;
  defaultPrevented = false;
  mousedownHandler({
    button: 0,
    clientX: 200,
    clientY: 150,
    target: buttonInsideUi,
    preventDefault: () => { defaultPrevented = true; },
  });
  assert.equal(view.isDragging, false, 'Space 激活时，点击 data-canvas-ui 内部按钮也绝对不得拖拽画布');
  assert.equal(defaultPrevented, false, 'Space 激活时，也不得 preventDefault 抢占浮层内按钮点击');
  assert.equal(mockViewport.classList.contains('is-dragging-canvas'), false);

  // 3. 在 data-canvas-ui 上滚轮：不得缩放画布
  defaultPrevented = false;
  const initialScale = view.scale;
  wheelHandler({
    deltaY: -100,
    clientX: 200,
    clientY: 150,
    target: buttonInsideUi,
    preventDefault: () => { defaultPrevented = true; },
  });
  assert.equal(view.scale, initialScale, '在 data-canvas-ui 浮层上滚轮不得触发画布缩放');
  assert.equal(defaultPrevented, false, '在 data-canvas-ui 浮层上滚轮不得被 preventDefault 接管');

  controller.cleanup();
});

test('panel-battle: validateBattleInput and buildBattleBranchCards pure functions', () => {
  // 1. 输入校验
  assert.deepEqual(validateBattleInput({ prompt: '', selectedCount: 2 }), {
    ok: false,
    error: '请输入推导问题。',
  });
  assert.deepEqual(validateBattleInput({ prompt: '  ', selectedCount: 2 }), {
    ok: false,
    error: '请输入推导问题。',
  });
  assert.deepEqual(validateBattleInput({ prompt: '分析架构', selectedCount: 0 }), {
    ok: false,
    error: '请至少选择一个对比助手。',
  });
  assert.deepEqual(validateBattleInput({ prompt: '分析架构', selectedCount: 2 }), {
    ok: true,
    error: '',
  });

  // 2. 多模型分支卡片纯函数构建
  const parent = { id: 'card-root', x: 100, y: 100, width: 340 };
  const agents = [
    { id: 'agent-gemini', name: 'Gemini', model: 'gemini-3.8-flash' },
    { id: 'agent-luna', name: 'Luna', model: 'gpt-5.6-luna' },
  ];
  const yPositions = [100, 480];
  const branchCards = buildBattleBranchCards({
    parentCard: parent,
    selectedAgents: agents,
    startBranchIndex: 1,
    targetX: 560,
    yPositions,
    getReasoningEffort: (id) => (id === 'agent-luna' ? 'high' : null),
    uniqueId: (prefix) => `${prefix}_mock_id`,
  });

  assert.equal(branchCards.length, 2);
  assert.equal(branchCards[0].parentId, 'card-root');
  assert.equal(branchCards[0].isBattle, true);
  assert.equal(branchCards[0].title, '对比 #1 (Gemini)');
  assert.equal(branchCards[0].x, 560);
  assert.equal(branchCards[0].y, 100);

  // 第二张卡片带有思考档位标签
  assert.equal(branchCards[1].title, '对比 #2 (Luna · 思考 high)');
  assert.equal(branchCards[1].y, 480);
});

test('panel-battle: bindBattleDialogController handles open, select, submit and cleanup', () => {
  const listeners = [];
  const mockListen = (target, event, handler, options) => {
    const record = { target, event, handler, options };
    listeners.push(record);
    return () => {
      const idx = listeners.indexOf(record);
      if (idx !== -1) listeners.splice(idx, 1);
    };
  };

  const mockDialog = {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
  };
  const mockPromptInput = { value: '', focus() {} };
  const mockAgentsList = { innerHTML: '', appendChild(el) { this.children = this.children || []; this.children.push(el); } };
  const mockSelectedCount = { textContent: '' };
  const mockDialogError = { textContent: '' };
  const mockBtnClose = {};
  const mockBtnCancel = {};
  const mockBtnSubmit = {};
  const mockBtnUseLastPrompt = {};

  let submittedData = null;
  const parentCard = {
    id: 'p1',
    draft: '我的预置草稿',
    messages: [{ role: 'user', text: '历史提问' }],
  };

  const controller = bindBattleDialogController({
    dialog: mockDialog,
    promptInput: mockPromptInput,
    agentsList: mockAgentsList,
    selectedCountEl: mockSelectedCount,
    errorEl: mockDialogError,
    btnClose: mockBtnClose,
    btnCancel: mockBtnCancel,
    btnSubmit: mockBtnSubmit,
    btnUseLastPrompt: mockBtnUseLastPrompt,
    loadAgents: async () => [
      { id: 'a1', name: 'Agent 1' },
      { id: 'a2', name: 'Agent 2' },
      { id: 'a3', name: 'Agent 3' },
    ],
    getReasoningEffort: () => null,
    onSubmit: (data) => { submittedData = data; },
    listen: mockListen,
  });

  // 打开弹窗：应预填草稿，默认选中前 2 个 agent（因为总数 > 2）
  controller.open(parentCard);
  assert.equal(mockPromptInput.value, '我的预置草稿');

  // 空提交校验：清空 prompt 触发提交
  mockPromptInput.value = '';
  const submitHandler = listeners.find(l => l.target === mockBtnSubmit && l.event === 'click').handler;
  submitHandler();
  assert.equal(mockDialogError.textContent, '请输入推导问题。');
  assert.equal(submittedData, null, '未通过校验不得触发提交回调');

  // 校验 cleanup 闭环
  controller.cleanup();
  assert.equal(listeners.length, 0, '调用 cleanup 后必须解绑所有监听');
});

test('panel-viewport: non-1.0 scale ensureCardVisible keeps newly branched card strictly inside viewport', () => {
  // 模拟主人复现的实机场景：画布缩放到 50% (scale = 0.5)，父卡片在 X=1000, Y=200，新分支卡片在 X=1460, Y=200
  const scale = 0.5;
  const initialView = { x: -300, y: 0, scale };
  const newCard = { id: 'new-branch', x: 1460, y: 200, width: 340, height: 360 };
  const vpWidth = 1000;
  const vpHeight = 700;
  const margin = 60;

  // 如果按旧代码硬编码 view.x = -newCard.x + 300 = -1160
  // 屏幕位置 screenX = 1460 * 0.5 + (-1160) = 730 - 1160 = -430px （直接飞出左侧视野 430 像素！）
  const buggyViewX = -newCard.x + 300;
  const buggyScreenX = newCard.x * scale + buggyViewX;
  assert.ok(buggyScreenX < 0, `确认旧逻辑在 scale=0.5 时的越界飞出缺陷: ${buggyScreenX}px`);

  // 使用经过 scale 矩阵换算的 computeEnsureCardVisible
  const adjusted = computeEnsureCardVisible({
    card: newCard,
    view: initialView,
    viewportWidth: vpWidth,
    viewportHeight: vpHeight,
    margin,
  });

  const finalScreenX = newCard.x * scale + adjusted.x;
  const finalScreenY = newCard.y * scale + adjusted.y;
  const finalCardW = newCard.width * scale;
  const finalCardH = newCard.height * scale;

  assert.ok(finalScreenX >= margin, `新卡片左边缘 (${finalScreenX}px) 必须在左边距 (${margin}px) 之内`);
  assert.ok(finalScreenX + finalCardW <= vpWidth - margin, `新卡片右边缘 (${finalScreenX + finalCardW}px) 必须在右安全边距 (${vpWidth - margin}px) 之内`);
  assert.ok(finalScreenY >= margin, `新卡片上边缘 (${finalScreenY}px) 必须在顶部边距 (${margin}px) 之内`);
  assert.ok(finalScreenY + finalCardH <= vpHeight - margin, `新卡片下边缘 (${finalScreenY + finalCardH}px) 必须在底部边距 (${vpHeight - margin}px) 之内`);
});

test('panel-cards: clampCardWidth, clampCardHeight, and buildCardHtml', () => {
  // 1. 宽度与高度安全限制
  assert.equal(clampCardWidth(200), 340, '宽度低于 340 应 clamp 到 340');
  assert.equal(clampCardWidth(900), 720, '宽度高于 720 应 clamp 到 720');
  assert.equal(clampCardWidth(500), 500, '合法宽度保持原值');

  assert.equal(clampCardHeight(100), 240, '高度低于 240 应 clamp 到 240');
  assert.equal(clampCardHeight(1500), 1200, '高度高于 1200 应 clamp 到 1200');
  assert.equal(clampCardHeight(600), 600, '合法高度保持原值');

  // 2. buildCardHtml 结构生成与标签断言
  // 这里曾经传的是 identity（原样返回），等于把转义整个关掉，
  // 于是"注入测不出来"是必然的。用真实转义规则，测试才有意义。
  const mockEscape = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  const mockFormatSize = (s) => `${s} B`;
  const mockStatusText = () => '';
  const mockMarkup = (m) => `<div class="mock-body">${m.text || ''}</div>`;

  // 资料源卡片
  const docCard = {
    id: 'c-doc',
    title: '学术论文.pdf',
    isDoc: true,
    messages: [{ role: 'user', text: '提取摘要' }],
  };
  const docHtml = buildCardHtml({
    card: docCard,
    currentAgent: { name: 'Gemini' },
    isSelected: true,
    isMultiSelected: false,
    isBusy: false,
    chainBusy: false,
    escapeHtml: mockEscape,
    messageMarkup: mockMarkup,
    statusText: mockStatusText,
    formatFileSize: mockFormatSize,
  });
  assert.match(docHtml, /\[资料源\]/, '资料源卡片必须生成 [资料源] 标识');
  assert.match(docHtml, /data-action="resize-card"/, '卡片必须包含 2D 尺寸调整拖拽手柄');
  assert.match(docHtml, /input-c-doc/, '必须包含对应卡片 ID 的输入框');

  // 对比推导分支卡片
  const battleCard = {
    id: 'c-battle',
    title: '对比 #1 (Luna)',
    isBattle: true,
    parentId: 'c-root',
    messages: [],
  };
  const battleHtml = buildCardHtml({
    card: battleCard,
    currentAgent: { name: 'Gemini' },
    isSelected: false,
    isMultiSelected: false,
    isBusy: true,
    chainBusy: true,
    escapeHtml: mockEscape,
    messageMarkup: mockMarkup,
    statusText: mockStatusText,
    formatFileSize: mockFormatSize,
  });
  assert.match(battleHtml, /\[对比推导\]/, '对比推导卡片必须生成 [对比推导] 标识');
  assert.match(battleHtml, /disabled/, '路径忙碌时发送与分叉按钮应被禁用');
});

test('panel-cards: cycleCardStatusStamp rotates through star, accepted, rejected, and clear states', () => {
  assert.equal(typeof panelCards.cycleCardStatusStamp, 'function', 'panel-cards 必须导出 cycleCardStatusStamp');
  const cycleCardStatusStamp = panelCards.cycleCardStatusStamp;

  assert.equal(cycleCardStatusStamp(null), 'starred', '空状态第一次盖戳应为星标');
  assert.equal(cycleCardStatusStamp(undefined), 'starred', 'undefined 状态第一次盖戳应为星标');
  assert.equal(cycleCardStatusStamp('starred'), 'accepted', '星标应轮转为采纳');
  assert.equal(cycleCardStatusStamp('accepted'), 'rejected', '采纳应轮转为否决');
  assert.equal(cycleCardStatusStamp('rejected'), null, '否决应轮转为清除');
});

test('panel-cards: buildCardHtml renders status stamp badges and cycle button', () => {
  const renderStatusCard = (statusStamp) => buildCardHtml({
    card: {
      id: `status-${statusStamp || 'clear'}`,
      title: '状态测试卡片',
      statusStamp,
      messages: [],
    },
  });

  const cases = [
    {
      statusStamp: 'starred',
      className: 'card-stamp-badge stamp-starred',
      markers: ['★'],
      classAssertion: (html) => html.includes('class="card-stamp-badge stamp-starred"')
        || html.includes('data-status-stamp="starred"'),
    },
    {
      statusStamp: 'accepted',
      className: 'card-stamp-badge stamp-accepted',
      markers: ['✓', '[已采纳]'],
      classAssertion: (html) => html.includes('class="card-stamp-badge stamp-accepted"'),
    },
    {
      statusStamp: 'rejected',
      className: 'card-stamp-badge stamp-rejected',
      markers: ['✗', '[已否决]'],
      classAssertion: (html) => html.includes('class="card-stamp-badge stamp-rejected"'),
    },
  ];

  for (const { statusStamp, className, markers, classAssertion } of cases) {
    const html = renderStatusCard(statusStamp);
    assert.ok(classAssertion(html), `${statusStamp} 状态必须生成 ${className} 标记`);
    assert.ok(
      markers.some(marker => html.includes(marker)),
      `${statusStamp} 状态必须包含 ${markers.join(' 或 ')} 标记`,
    );
    const headerStart = html.indexOf('<div class="card-header"');
    const bodyStart = html.indexOf('<div class="card-body"', headerStart);
    const headerHtml = html.slice(headerStart, bodyStart);
    assert.match(
      headerHtml,
      /<button[^>]*data-action="cycle-stamp"/,
      '卡片头部必须包含 data-action="cycle-stamp" 的点击按钮',
    );
  }
});

test('panel-cards: findCardAncestorChain returns an ordered, deduplicated root-to-leaf chain', () => {
  assert.equal(typeof panelCards.findCardAncestorChain, 'function', 'panel-cards 必须导出 findCardAncestorChain');

  const cards = [
    { id: 'c-root', title: '根节点', parentId: null },
    { id: 'c-b1', title: '分支一', parentId: 'c-root' },
    { id: 'c-b2', title: '分支二', parentId: 'c-root' },
    { id: 'c-merge', title: '合并节点', parentIds: ['c-b1', 'c-b2'] },
    { id: 'c-leaf', title: '叶节点', parentId: 'c-merge' },
  ];
  const cardParentIds = (card) => Array.from(new Set([
    ...(card?.parentId ? [card.parentId] : []),
    ...(Array.isArray(card?.parentIds) ? card.parentIds : []),
  ]));

  const singleParentCards = [
    { id: 'c1', title: '节点一', parentId: null },
    { id: 'c2', title: '节点二', parentId: 'c1' },
    { id: 'c3', title: '节点三', parentId: 'c2' },
  ];
  const singleChain = panelCards.findCardAncestorChain({
    cards: singleParentCards,
    targetCardId: 'c3',
    cardParentIds,
  });
  assert.deepEqual(singleChain.map(card => card.id), ['c1', 'c2', 'c3'], '单亲链路必须按根到叶返回');

  const mergeChain = panelCards.findCardAncestorChain({
    cards,
    targetCardId: 'c-leaf',
    cardParentIds,
  });
  const mergeChainIds = mergeChain.map(card => card.id);
  assert.equal(mergeChainIds[0], 'c-root', '多亲链路必须从根节点开始');
  assert.equal(mergeChainIds.at(-1), 'c-leaf', '多亲链路必须以目标叶节点结束');
  assert.deepEqual(new Set(mergeChainIds), new Set(['c-root', 'c-b1', 'c-b2', 'c-merge', 'c-leaf']), '多亲合并链必须包含所有祖先');
  assert.equal(new Set(mergeChainIds).size, mergeChainIds.length, '多亲链路不得重复节点');

  assert.deepEqual(
    panelCards.findCardAncestorChain({ cards, targetCardId: 'missing', cardParentIds }),
    [],
    '目标卡片不存在时必须安全返回空数组',
  );
  assert.deepEqual(
    panelCards.findCardAncestorChain({ cards: [], targetCardId: 'c3', cardParentIds }),
    [],
    '卡片集合为空时必须安全返回空数组',
  );

  const cyclicCards = [
    { id: 'loop-a', title: '环 A', parentId: 'loop-b' },
    { id: 'loop-b', title: '环 B', parentId: 'loop-a' },
  ];
  const cyclicChain = panelCards.findCardAncestorChain({
    cards: cyclicCards,
    targetCardId: 'loop-a',
    cardParentIds,
  });
  assert.ok(Array.isArray(cyclicChain), '环形引用也必须返回数组');
  assert.equal(new Set(cyclicChain.map(card => card.id)).size, cyclicChain.length, '环形引用不得重复访问节点');
});

test('panel-cards: formatCardChainMarkdown renders title, node headings, messages, and status labels', () => {
  assert.equal(typeof panelCards.formatCardChainMarkdown, 'function', 'panel-cards 必须导出 formatCardChainMarkdown');

  const markdown = panelCards.formatCardChainMarkdown([
    {
      id: 'c-root',
      title: '根问题',
      statusStamp: 'starred',
      messages: [
        { role: 'user', text: '请分析这个问题' },
        { role: 'assistant', agentName: 'Gemini', text: '这是根节点的分析回复' },
      ],
    },
    {
      id: 'c-child',
      title: '采纳方案',
      statusStamp: 'accepted',
      messages: [
        { role: 'user', text: '请给出可执行方案' },
        { role: 'assistant', agentName: 'Gemini', text: '这是采纳节点的方案回复' },
      ],
    },
  ], { title: '完整推演链路' });

  assert.equal(typeof markdown, 'string', '导出结果必须是字符串');
  assert.match(markdown.trim(), /^#\s+完整推演链路/m, 'Markdown 必须包含文章总标题');
  assert.match(markdown, /^##\s+节点\s+1\s*[:：]\s*根问题/m, 'Markdown 必须包含第一个节点标题层级');
  assert.match(markdown, /^##\s+节点\s+2\s*[:：]\s*采纳方案/m, 'Markdown 必须包含第二个节点标题层级');
  assert.match(markdown, /\[星标\]/, '星标状态必须在节点头部清晰标识');
  assert.match(markdown, /\[已采纳\]/, '采纳状态必须在节点头部清晰标识');
  assert.match(markdown, /User/, 'Markdown 必须标识 User 消息');
  assert.match(markdown, /Assistant/, 'Markdown 必须标识 Assistant 消息');
  assert.match(markdown, /请分析这个问题/, 'Markdown 必须包含每条 User 消息内容');
  assert.match(markdown, /这是根节点的分析回复/, 'Markdown 必须包含每条 Assistant 消息内容');
  assert.match(markdown, /请给出可执行方案/, 'Markdown 必须包含后续 User 消息内容');
  assert.match(markdown, /这是采纳节点的方案回复/, 'Markdown 包含后续 Assistant 消息内容');
});

test('panel-cards: buildCardHtml exposes export-chain button in the card header', () => {
  const html = panelCards.buildCardHtml({
    card: { id: 'export-target', title: '导出目标', messages: [] },
  });
  const headerStart = html.indexOf('<div class="card-header"');
  const bodyStart = html.indexOf('<div class="card-body"', headerStart);
  const headerHtml = html.slice(headerStart, bodyStart);

  assert.match(
    headerHtml,
    /<button[^>]*data-action="export-chain"/,
    '卡片头部必须包含 data-action="export-chain" 的整链导出按钮',
  );
});

test('panel-layout: collectSubtreeCardIds gathers nested descendants, deduplicates DAG merges, and stops cycles', () => {
  assert.equal(typeof panelLayout.collectSubtreeCardIds, 'function', 'panel-layout 必须导出 collectSubtreeCardIds');
  const cardParentIds = card => Array.from(new Set([
    ...(card?.parentId ? [card.parentId] : []),
    ...(Array.isArray(card?.parentIds) ? card.parentIds : []),
  ]));
  const asIdSet = value => value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);

  const cards = [
    { id: 'root', parentId: null },
    { id: 'child', parentId: 'root' },
    { id: 'grandchild', parentId: 'child' },
    { id: 'branch-a', parentId: 'root' },
    { id: 'branch-b', parentId: 'root' },
    { id: 'merge', parentIds: ['branch-a', 'branch-b'] },
    { id: 'leaf', parentId: 'merge' },
  ];

  const descendants = asIdSet(panelLayout.collectSubtreeCardIds({
    cards,
    rootCardId: 'root',
    cardParentIds,
  }));
  assert.deepEqual(
    descendants,
    new Set(['child', 'grandchild', 'branch-a', 'branch-b', 'merge', 'leaf']),
    '多层树与 DAG 合流的所有后代都必须被搜集',
  );
  assert.equal(descendants.has('root'), false, '结果不得包含 rootCardId 本身');
  assert.equal(descendants.size, 6, '合流节点不得因多条父路径重复计数');

  const noChildren = asIdSet(panelLayout.collectSubtreeCardIds({
    cards,
    rootCardId: 'grandchild',
    cardParentIds,
  }));
  assert.deepEqual(noChildren, new Set(), '没有子卡片时必须返回空集合');
  assert.deepEqual(
    asIdSet(panelLayout.collectSubtreeCardIds({ cards, rootCardId: 'missing', cardParentIds })),
    new Set(),
    '目标卡片不存在时必须返回空集合',
  );

  const cyclicCards = [
    { id: 'cycle-root', parentId: 'cycle-child' },
    { id: 'cycle-child', parentId: 'cycle-root' },
  ];
  const cyclicDescendants = asIdSet(panelLayout.collectSubtreeCardIds({
    cards: cyclicCards,
    rootCardId: 'cycle-root',
    cardParentIds,
  }));
  assert.equal(cyclicDescendants.has('cycle-root'), false, '环形遍历不得把根节点重新加入结果');
  assert.equal(cyclicDescendants.size, 1, '环形引用必须安全熔断且不得重复访问');
});

test('panel-layout: computeVisibleCards hides descendants of collapsed cards and returns hidden IDs', () => {
  assert.equal(typeof panelLayout.computeVisibleCards, 'function', 'panel-layout 必须导出 computeVisibleCards');
  const cardParentIds = card => Array.from(new Set([
    ...(card?.parentId ? [card.parentId] : []),
    ...(Array.isArray(card?.parentIds) ? card.parentIds : []),
  ]));
  const cards = [
    { id: 'root', parentId: null },
    { id: 'child', parentId: 'root' },
    { id: 'grandchild', parentId: 'child' },
    { id: 'collapsed-branch', parentId: 'root', isCollapsed: true },
    { id: 'other-branch', parentId: 'root' },
    { id: 'merge', parentIds: ['collapsed-branch', 'other-branch'] },
    { id: 'leaf', parentId: 'merge' },
    { id: 'standalone', parentId: null },
  ];
  const asIdSet = value => value instanceof Set ? value : new Set(Array.isArray(value) ? value : []);

  const projected = panelLayout.computeVisibleCards({ cards, cardParentIds });
  assert.ok(projected && Array.isArray(projected.visibleCards), '必须返回 visibleCards 数组');
  assert.ok(projected && (projected.hiddenCardIds instanceof Set || Array.isArray(projected.hiddenCardIds)), '必须返回 hiddenCardIds 集合或数组');
  assert.deepEqual(
    new Set(projected.visibleCards.map(card => card.id)),
    new Set(['root', 'child', 'grandchild', 'collapsed-branch', 'other-branch', 'standalone']),
    '折叠卡片本身及无关分支必须保持可见，所有后代必须隐藏',
  );
  assert.deepEqual(asIdSet(projected.hiddenCardIds), new Set(['merge', 'leaf']), '隐藏结果必须包含 DAG 合流后的全部后代');

  const expandedCards = cards.map(card => ({ ...card, isCollapsed: false }));
  const expanded = panelLayout.computeVisibleCards({ cards: expandedCards, cardParentIds });
  assert.deepEqual(expanded.visibleCards, expandedCards, '没有任何折叠时 visibleCards 必须等于原卡片数组');
  assert.deepEqual(asIdSet(expanded.hiddenCardIds), new Set(), '没有任何折叠时 hiddenCardIds 必须为空');
});

test('panel-cards: buildCardHtml renders collapse toggle and collapsed descendant count badge', () => {
  const render = ({ childCount, isCollapsed = false }) => panelCards.buildCardHtml({
    card: { id: 'collapse-card', title: '可折叠卡片', isCollapsed, messages: [] },
    childCount,
  });
  const headerOf = html => {
    const headerStart = html.indexOf('<div class="card-header"');
    const bodyStart = html.indexOf('<div class="card-body"', headerStart);
    return html.slice(headerStart, bodyStart);
  };

  const withChildrenHeader = headerOf(render({ childCount: 2 }));
  assert.match(withChildrenHeader, /<button[^>]*data-action="toggle-collapse"/, '有子卡片时头部必须生成折叠按钮');

  const withoutChildren = render({ childCount: 0 });
  assert.doesNotMatch(withoutChildren, /data-action="toggle-collapse"/, '没有子卡片时不应生成折叠按钮');

  const collapsedHeader = headerOf(render({ childCount: 3, isCollapsed: true }));
  assert.match(collapsedHeader, /class="[^"]*collapsed-(?:pill|badge)[^"]*"/, '折叠状态必须生成折叠徽标或药丸');
  assert.match(collapsedHeader, /(?:已折叠|已收起)/, '折叠徽标必须明确标注收起状态');
  assert.match(collapsedHeader, /3/, '折叠徽标必须标注被收起的子孙数量');
});

test('panel-history: cloneCardTopology projects only own layout metadata', () => {
  const card = {
    id: 'card-child',
    title: '子卡片',
    x: 120,
    y: 240,
    width: 360,
    height: 480,
    parentId: 'card-root',
    parentIds: ['card-root', 'card-alt'],
    statusStamp: 'working',
    isDoc: true,
    messages: [{ role: 'user', text: '原始问题' }],
    docContent: '不得进入布局快照',
    stagedAttachments: [{ name: 'source.txt' }],
  };

  const cloned = cloneCardTopology(card);

  assert.deepEqual(cloned, {
    id: 'card-child', x: 120, y: 240, width: 360, height: 480,
    parentId: 'card-root', parentIds: ['card-root', 'card-alt'], statusStamp: 'working',
  });
  assert.notStrictEqual(cloned, card, '投影结果不得复用原对象');
  assert.notStrictEqual(cloned.parentIds, card.parentIds, 'parentIds 必须复制数组');
  assert.equal('messages' in cloned, false);
  assert.equal('docContent' in cloned, false);
  assert.equal('stagedAttachments' in cloned, false);
});

test('panel-history: records snapshots and restores undo/redo states with callback arguments', () => {
  const restoreCalls = [];
  const manager = createHistoryManager({
    onRestore(restoredCards, restoredSelectedId) {
      restoreCalls.push({ restoredCards, restoredSelectedId });
    },
  });
  const firstCards = [{
    id: 'card-root', title: '根卡片', x: 80, y: 100, width: 340, height: 360, parentId: null,
    messages: [{ role: 'assistant', text: '初始状态' }],
  }];
  const secondCards = [
    ...firstCards,
    {
      id: 'card-child', title: '分支卡片', x: 540, y: 100, width: 340, height: 360, parentId: 'card-root',
      parentIds: ['card-root'], messages: [{ role: 'assistant', text: '新分支' }],
    },
  ];

  manager.recordSnapshot(firstCards, 'card-root');
  manager.recordSnapshot(secondCards, 'card-child');

  assertHistoryStats(manager, { undoCount: 2, redoCount: 0, maxDepth: 30 });
  assert.equal(manager.canUndo(), true, '存在两个连续快照时必须可撤销');
  assert.equal(manager.canRedo(), false, '未撤销前不得可重做');

  assert.equal(manager.undo(), true, '有历史快照时 undo 必须成功');
  assert.deepEqual(restoreCalls.at(-1), {
    restoredCards: firstCards,
    restoredSelectedId: 'card-root',
  }, 'undo 必须恢复前一个快照并传递选中卡片 ID');
  assertHistoryStats(manager, { undoCount: 1, redoCount: 1, maxDepth: 30 });
  assert.equal(manager.canRedo(), true, '撤销后必须存在可重做状态');

  assert.equal(manager.redo(), true, '有 redo 状态时 redo 必须成功');
  assert.deepEqual(restoreCalls.at(-1), {
    restoredCards: secondCards,
    restoredSelectedId: 'card-child',
  }, 'redo 必须恢复被撤销的快照并传递选中卡片 ID');
  assertHistoryStats(manager, { undoCount: 2, redoCount: 0, maxDepth: 30 });
  assert.equal(manager.canUndo(), true);
  assert.equal(manager.canRedo(), false);
});

test('panel-history: new snapshot after undo immediately purges redo history', () => {
  const restored = [];
  const manager = createHistoryManager({
    onRestore(cards, selectedCardId) {
      restored.push({ cards, selectedCardId });
    },
  });
  const snapshotA = [{ id: 'a', title: 'A', x: 0, y: 0, width: 340, height: 360, parentId: null, messages: [] }];
  const snapshotB = [{ id: 'a', title: 'A', x: 100, y: 0, width: 340, height: 360, parentId: null, messages: [] }];
  const snapshotC = [{ id: 'a', title: 'A', x: 200, y: 0, width: 340, height: 360, parentId: null, messages: [] }];

  manager.recordSnapshot(snapshotA, 'a');
  manager.recordSnapshot(snapshotB, 'a');
  assert.equal(manager.undo(), true);
  assert.equal(manager.canRedo(), true);

  manager.recordSnapshot(snapshotC, 'a');

  assertHistoryStats(manager, { undoCount: 2, redoCount: 0, maxDepth: 30 });
  assert.equal(manager.canRedo(), false, '新快照必须立即清空 redo 栈');
  assert.equal(manager.redo(), false, 'redo 栈被清空后 redo 必须安全失败');
  assert.equal(restored.length, 1, '记录新快照不得额外触发 restore 回调');
});

test('panel-history: maxDepth strictly truncates the oldest snapshots at 30', () => {
  const restored = [];
  const manager = createHistoryManager({
    onRestore(cards, selectedCardId) {
      restored.push({ cards, selectedCardId });
    },
  });

  for (let i = 0; i < 35; i += 1) {
    manager.recordSnapshot([{
      id: `card-${i}`,
      title: `快照 ${i}`,
      x: i * 10,
      y: i * 20,
      width: 340,
      height: 360,
      parentId: i === 0 ? null : `card-${i - 1}`,
      messages: [],
    }], `card-${i}`);
  }

  assertHistoryStats(manager, { undoCount: 30, redoCount: 0, maxDepth: 30 });

  // 当前状态为 card-34；连续撤销到最老保留快照时应落在 card-5，card-0..4 已淘汰。
  for (let i = 0; i < 29; i += 1) {
    assert.equal(manager.undo(), true, `第 ${i + 1} 次撤销应成功`);
  }
  assert.equal(restored.at(-1).cards[0].id, 'card-5');
  assert.equal(restored.at(-1).selectedCardId, 'card-5');
  assert.equal(manager.getStats().undoCount, 1);
  assert.equal(manager.getStats().redoCount, 29);
});

test('panel-history: empty stacks are safe and clear resets both stacks', () => {
  const emptyManager = createHistoryManager({ onRestore() {} });

  assert.doesNotThrow(() => {
    assert.equal(emptyManager.undo(), false, '空 undo 栈必须返回 false');
    assert.equal(emptyManager.redo(), false, '空 redo 栈必须返回 false');
  });
  assertHistoryStats(emptyManager, { undoCount: 0, redoCount: 0, maxDepth: 30 });

  const manager = createHistoryManager({ onRestore() {} });
  const snapshotA = [{ id: 'a', title: 'A', x: 0, y: 0, width: 340, height: 360, parentId: null, messages: [] }];
  const snapshotB = [{ id: 'b', title: 'B', x: 100, y: 0, width: 340, height: 360, parentId: null, messages: [] }];
  manager.recordSnapshot(snapshotA, 'a');
  manager.recordSnapshot(snapshotB, 'b');
  assert.equal(manager.undo(), true);
  assert.equal(manager.canRedo(), true);

  manager.clear();

  assertHistoryStats(manager, { undoCount: 0, redoCount: 0, maxDepth: 30 });
  assert.equal(manager.canUndo(), false, 'clear 后 undo 栈必须为空');
  assert.equal(manager.canRedo(), false, 'clear 后 redo 栈必须为空');
  assert.equal(manager.undo(), false);
  assert.equal(manager.redo(), false);
});

test('panel-shortcuts: Undo/Redo shortcuts (Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y) with input & streaming guards', () => {
  const windowListeners = new Map();
  const mockWindow = {
    addEventListener(event, handler) { windowListeners.set(event, handler); },
    removeEventListener(event, handler) {
      if (windowListeners.get(event) === handler) windowListeners.delete(event);
    },
  };

  let activeEl = null;
  const mockDoc = {
    get activeElement() { return activeEl; },
    getElementById() { return null; },
    querySelector() { return null; },
  };

  let undoCalled = 0;
  let redoCalled = 0;
  let isBusy = false;
  let battleDialogOpen = false;

  const actions = {
    undo: () => { undoCalled += 1; },
    redo: () => { redoCalled += 1; },
    isBusy: () => isBusy,
    setSpacePressed: () => {},
    createBranchCard: () => {},
    navigateCardFocus: () => {},
    closeBattleDialog: () => {},
    clearMultiSelect: () => {},
    selectCard: () => {},
    closeCardHierarchy: () => {},
    autoTidyLayout: () => {},
    createMergeCardFromSelected: () => {},
    chainIsBusy: () => false,
  };

  const getState = () => ({
    isDisposed: false,
    isSpacePressed: false,
    cards: [{ id: 'c1' }],
    selectedCardId: 'c1',
    battleDialogOpen,
    multiSelectedCount: 0,
    canUndo: true,
    canRedo: true,
  });

  const unbind = bindKeyboardShortcuts({
    windowRef: mockWindow,
    documentRef: mockDoc,
    viewport: { classList: { add() {}, remove() {} } },
    getState,
    actions,
  });

  const dispatch = (evt) => {
    const handler = windowListeners.get('keydown');
    let defaultPrevented = false;
    handler({
      ...evt,
      preventDefault() { defaultPrevented = true; },
    });
    return { defaultPrevented };
  };

  // 1. 标准 Ctrl+Z 撤销
  undoCalled = 0;
  redoCalled = 0;
  let res = dispatch({ ctrlKey: true, key: 'z' });
  assert.equal(undoCalled, 1, 'Ctrl+Z 应当触发 actions.undo()');
  assert.equal(res.defaultPrevented, true, '快捷键触发后应当 preventDefault');

  // 2. 标准 Ctrl+Shift+Z 重做
  undoCalled = 0;
  redoCalled = 0;
  res = dispatch({ ctrlKey: true, shiftKey: true, key: 'z' });
  assert.equal(redoCalled, 1, 'Ctrl+Shift+Z 应当触发 actions.redo()');
  assert.equal(res.defaultPrevented, true);

  // 3. 标准 Ctrl+Y 重做
  undoCalled = 0;
  redoCalled = 0;
  res = dispatch({ ctrlKey: true, key: 'y' });
  assert.equal(redoCalled, 1, 'Ctrl+Y 应当触发 actions.redo()');

  // 4. macOS Meta+Z 与 Meta+Shift+Z 支持
  undoCalled = 0;
  redoCalled = 0;
  dispatch({ metaKey: true, key: 'z' });
  assert.equal(undoCalled, 1, 'Meta+Z 应当触发 actions.undo()');
  dispatch({ metaKey: true, shiftKey: true, key: 'Z' });
  assert.equal(redoCalled, 1, 'Meta+Shift+Z 应当触发 actions.redo()');

  // 5. 守卫 1：输入框智能穿透（有文字草稿时保留原生回退；无文字空输入时自动穿透触发画布撤销）
  activeEl = { tagName: 'INPUT', value: '正在打字的草稿' };
  undoCalled = 0;
  redoCalled = 0;
  res = dispatch({ ctrlKey: true, key: 'z' });
  assert.equal(undoCalled, 0, '输入框含有文字草稿时，必须保留原生文本撤销，禁止触发画布撤销');
  assert.equal(res.defaultPrevented, false, '有文字时不抢占原生事件');

  // 空输入框（刚创建卡片或没有草稿）按下 Ctrl+Z 必须智能穿透触发画布撤回
  activeEl = { tagName: 'INPUT', value: '' };
  undoCalled = 0;
  res = dispatch({ ctrlKey: true, key: 'z' });
  assert.equal(undoCalled, 1, '空输入框聚焦时按下 Ctrl+Z 必须智能穿透触发画布撤回');
  assert.equal(res.defaultPrevented, true);

  // 空文本域按下 Ctrl+Shift+Z 必须智能穿透触发画布重做
  activeEl = { tagName: 'TEXTAREA', value: '' };
  redoCalled = 0;
  dispatch({ ctrlKey: true, shiftKey: true, key: 'z' });
  assert.equal(redoCalled, 1, '空文本域聚焦时按下 Ctrl+Shift+Z 必须智能穿透触发画布重做');

  // 6. 守卫 2：弹窗打开时拦截
  activeEl = null;
  battleDialogOpen = true;
  undoCalled = 0;
  dispatch({ ctrlKey: true, key: 'z' });
  assert.equal(undoCalled, 0, '模态弹窗开启时禁止触发画布撤销');
  battleDialogOpen = false;

  // 7. 守卫 3：流式推导锁拦截（生成中禁止破坏性撤销）
  isBusy = true;
  undoCalled = 0;
  dispatch({ ctrlKey: true, key: 'z' });
  assert.equal(undoCalled, 0, '画布正忙或流式输出时禁止触发撤销');
  isBusy = false;

  // 8. 守卫 4：输入法合成态安全
  undoCalled = 0;
  dispatch({ ctrlKey: true, key: 'z', isComposing: true });
  assert.equal(undoCalled, 0, '输入法合成态下禁止触发撤销');

  // 9. Ctrl+F / Cmd+F 全画布卡片内容搜索触发
  let searchBarOpened = false;
  actions.openSearchBar = () => { searchBarOpened = true; };
  res = dispatch({ ctrlKey: true, key: 'f' });
  assert.equal(searchBarOpened, true, '按下 Ctrl+F 必须触发 actions.openSearchBar()');
  assert.equal(res.defaultPrevented, true, '按下 Ctrl+F 必须阻止浏览器原生网页搜索');

  searchBarOpened = false;
  res = dispatch({ metaKey: true, key: 'F' });
  assert.equal(searchBarOpened, true, '按下 Cmd+F (macOS) 必须触发 actions.openSearchBar()');
  assert.equal(res.defaultPrevented, true);

  unbind();
});

test('panel-search: findCardsByKeyword performs case-insensitive fuzzy match across title, draft, messages, docMeta and attachments', async () => {
  const { findCardsByKeyword } = await import('../ui/assets/panel-search.js');
  assert.equal(typeof findCardsByKeyword, 'function', 'panel-search 必须导出 findCardsByKeyword');

  const cards = [
    {
      id: 'c1',
      title: '高并发系统架构',
      draft: '',
      messages: [
        { role: 'user', text: '如何设计每秒10万并发的系统？' },
        { role: 'assistant', text: '可以使用 Redis 缓存和 Kafka 消息队列。' }
      ]
    },
    {
      id: 'c2',
      title: '数据库选型',
      draft: '这里有一份草稿：PostgreSQL 分库分表',
      messages: []
    },
    {
      id: 'c3',
      title: '资料汇总',
      docMeta: { name: 'architecture-whitepaper.pdf' },
      stagedAttachments: [{ name: 'benchmarks-summary.xlsx' }],
      messages: []
    }
  ];

  // 1. 匹配标题
  assert.deepEqual(findCardsByKeyword({ cards, query: '并发' }).map(c => c.id), ['c1']);

  // 2. 匹配助手回复
  assert.deepEqual(findCardsByKeyword({ cards, query: 'redis' }).map(c => c.id), ['c1'], '必须大小写不敏感匹配对话回复内容');

  // 3. 匹配草稿
  assert.deepEqual(findCardsByKeyword({ cards, query: '分库分表' }).map(c => c.id), ['c2']);

  // 4. 匹配附件与资料名称
  assert.deepEqual(findCardsByKeyword({ cards, query: 'whitepaper' }).map(c => c.id), ['c3']);
  assert.deepEqual(findCardsByKeyword({ cards, query: 'benchmarks' }).map(c => c.id), ['c3']);

  // 5. 空查询、空格或无卡片安全防护
  assert.deepEqual(findCardsByKeyword({ cards, query: '' }), []);
  assert.deepEqual(findCardsByKeyword({ cards, query: '   ' }), []);
  assert.deepEqual(findCardsByKeyword({ cards: [], query: 'test' }), []);

  // 6. 异常结构防御（空卡片、无 messages）
  assert.deepEqual(findCardsByKeyword({
    cards: [null, undefined, {}, { id: 'bad-messages', messages: 'not-an-array' }],
    query: 'test',
  }), [], '空卡片、缺失 messages 和非数组 messages 都必须安全处理');
});

test('panel-search: getNextMatchIndex cycles through matches circularly in both directions', async () => {
  const { getNextMatchIndex } = await import('../ui/assets/panel-search.js');
  assert.equal(typeof getNextMatchIndex, 'function', 'panel-search 必须导出 getNextMatchIndex');

  // 空集合或非法数量
  assert.equal(getNextMatchIndex({ currentIndex: 0, totalCount: 0 }), -1);
  assert.equal(getNextMatchIndex({ currentIndex: 0, totalCount: -1 }), -1);

  // 正向递增与尾部环回
  assert.equal(getNextMatchIndex({ currentIndex: 0, totalCount: 3, direction: 'next' }), 1);
  assert.equal(getNextMatchIndex({ currentIndex: 1, totalCount: 3, direction: 'next' }), 2);
  assert.equal(getNextMatchIndex({ currentIndex: 2, totalCount: 3, direction: 'next' }), 0, '末尾索引 next 必须环回 0');

  // 反向递减与首部环回
  assert.equal(getNextMatchIndex({ currentIndex: 2, totalCount: 3, direction: 'prev' }), 1);
  assert.equal(getNextMatchIndex({ currentIndex: 1, totalCount: 3, direction: 'prev' }), 0);
  assert.equal(getNextMatchIndex({ currentIndex: 0, totalCount: 3, direction: 'prev' }), 2, '首部索引 prev 必须环回末尾');
});





test('fitViewportToCluster 把卡片集群的中心真的放到视口中心', () => {
  const view = { x: 0, y: 0, scale: 1 };
  const viewport = { clientWidth: 1000, clientHeight: 700, getBoundingClientRect: () => ({ width: 1000, height: 700 }) };
  const card = { x: 100, y: 100, width: 340, height: 360 };
  fitViewportToCluster([card], { viewport, view });
  // 屏幕坐标 = 卡片坐标 * scale + view.偏移
  const centerScreenX = (card.x + card.width / 2) * view.scale + view.x;
  const centerScreenY = (card.y + card.height / 2) * view.scale + view.y;
  assert.ok(Math.abs(centerScreenX - 500) <= 1, `水平中心应在 500，实际 ${centerScreenX}`);
  assert.ok(Math.abs(centerScreenY - 350) <= 1, `垂直中心应在 350，实际 ${centerScreenY}`);
});

test('fitViewportToCluster 用卡片真实高度而不是写死的 360', () => {
  const view = { x: 0, y: 0, scale: 1 };
  const viewport = { clientWidth: 1000, clientHeight: 700, getBoundingClientRect: () => ({ width: 1000, height: 700 }) };
  const tall = { x: 0, y: 0, width: 340, height: 900 };
  fitViewportToCluster([tall], { viewport, view });
  const centerScreenY = (tall.y + tall.height / 2) * view.scale + view.y;
  assert.ok(Math.abs(centerScreenY - 350) <= 1, `高卡片的垂直中心也应在 350，实际 ${centerScreenY}`);
});

test('panel-messages: statusText, outputFor, asidesText, and messageMarkup formatting', () => {
  assert.equal(statusText(null), '');
  assert.equal(statusText({}), '');
  assert.match(statusText({ requestId: 'r1', status: 'waiting' }), /等待模型响应/);
  assert.match(statusText({ requestId: 'r1', status: 'generating' }), /生成中/);

  // outputFor 投影
  const plain = outputFor({ role: 'user', text: 'hello' });
  assert.equal(plain.body, 'hello');
  assert.equal(plain.blocks.length, 0);

  const assistant = outputFor({ role: 'assistant', text: '<mood>心境文本</mood>模型回答' });
  assert.equal(assistant.body, '模型回答');
  assert.equal(assistant.blocks.length, 1);
  assert.equal(assistant.blocks[0].type, 'mood');

  // asidesText
  const asides = asidesText(assistant, { streaming: false });
  assert.match(asides, /心境/);
  assert.match(asides, /心境文本/);

  // messageMarkup
  const markup = messageMarkup({ role: 'assistant', requestId: 'r1', text: 'test answer' });
  assert.match(markup, /reply-r1/);
  assert.match(markup, /test answer/);
  assert.match(markup, /asides-r1/);
});

test('panel-messages: createMessagePainter paints DOM correctly and respects isDisposed', () => {
  const nodes = new Map();
  const doc = {
    getElementById: id => nodes.get(id) || null,
  };
  nodes.set('reply-req-1', { textContent: '', hidden: false });
  nodes.set('status-req-1', { textContent: '' });

  let disposed = false;
  const painter = createMessagePainter({
    documentRef: () => doc,
    isDisposed: () => disposed,
  });

  painter({ role: 'assistant', requestId: 'req-1', text: 'new text', status: 'completed' });
  assert.equal(nodes.get('reply-req-1').textContent, 'new text');
  assert.match(nodes.get('status-req-1').textContent, /已完成/);

  // 销毁后调用不抛错且不涂色
  disposed = true;
  painter({ role: 'assistant', requestId: 'req-1', text: 'after dispose', status: 'generating' });
  assert.equal(nodes.get('reply-req-1').textContent, 'new text');
});

test('panel-context: cardParentIds and cardHasParent topology resolution', () => {
  const single = { id: 'c1', parentId: 'p1' };
  assert.deepEqual(cardParentIds(single), ['p1']);
  assert.equal(cardHasParent(single, 'p1'), true);
  assert.equal(cardHasParent(single, 'p2'), false);

  const multi = { id: 'c2', parentId: 'p1', parentIds: ['p1', 'p2', 'p3'] };
  assert.deepEqual(cardParentIds(multi), ['p1', 'p2', 'p3']);
  assert.equal(cardHasParent(multi, 'p2'), true);
});

test('panel-context: buildChainContext assembles full hierarchy and balances consecutive user messages', () => {
  const root = {
    id: 'root',
    parentId: null,
    messages: [
      { role: 'user', text: 'question 1', status: 'completed' },
      { role: 'assistant', text: 'answer 1', status: 'completed' },
    ],
  };

  const child = {
    id: 'child',
    parentId: 'root',
    messages: [
      { role: 'user', text: 'question 2 (first attempt, failed)', status: 'failed' },
      { role: 'user', text: 'question 2 (retry)', status: 'completed' },
      { role: 'assistant', text: 'answer 2', status: 'completed' },
    ],
  };

  const cards = [root, child];
  const context = buildChainContext({ cards, targetCard: child });

  // 检查拓扑回溯顺序：root -> child
  // 检查 consecutive user 保护：失败的问答如果前一个 user 的回复没有留存，下一个 user 应该弹掉前一个 user
  assert.equal(context.length, 4);
  assert.equal(context[0].role, 'user');
  assert.equal(context[0].content, 'question 1');
  assert.equal(context[1].role, 'assistant');
  assert.equal(context[1].content, 'answer 1');
  assert.equal(context[2].role, 'user');
  assert.equal(context[2].content, 'question 2 (retry)');
  assert.equal(context[3].role, 'assistant');
  assert.equal(context[3].content, 'answer 2');
});

function makeAgentControllerHarness() {
  let agent = { id: 'a1', name: 'Agent 1', model: 'm1', provider: 'p1' };
  let effort = null;
  let savedCount = 0;
  let renderCount = 0;
  let busy = false;
  const storageData = new Map();
  const storage = {
    getItem: key => (storageData.has(key) ? storageData.get(key) : null),
    setItem: (key, value) => storageData.set(key, String(value)),
  };
  const display = { textContent: '' };
  const controller = createAgentController({
    getAgent: () => agent,
    setAgent: next => { agent = next; },
    getReasoningEffort: () => effort,
    setReasoningEffort: next => { effort = next; },
    getActiveAgentDisplay: () => display,
    isBusy: () => busy,
    renderCards: () => { renderCount += 1; },
    scheduleSave: () => { savedCount += 1; },
    storage,
  });
  return {
    controller,
    storage,
    display,
    get agent() { return agent; },
    get effort() { return effort; },
    get savedCount() { return savedCount; },
    get renderCount() { return renderCount; },
    setBusy(value) { busy = value; },
  };
}

test('panel-agents: updateHeaderStatus projects the current agent state', () => {
  const h = makeAgentControllerHarness();

  h.controller.updateHeaderStatus();

  assert.equal(h.display.textContent, '当前助手: Agent 1 [m1]');
  assert.deepEqual(h.agent, { id: 'a1', name: 'Agent 1', model: 'm1', provider: 'p1' });
  assert.equal(h.renderCount, 0);
  assert.equal(h.savedCount, 0);
});

test('panel-agents: handleBroadcast applies reasoning and agent changes with concrete persistence', () => {
  const h = makeAgentControllerHarness();

  assert.equal(h.controller.handleBroadcast({ type: 'REASONING_EFFORT_CHANGED', reasoningEffort: 'high' }), true);
  assert.equal(h.effort, 'high');
  assert.equal(h.storage.getItem('fork_chat_reasoning_effort'), 'high');
  assert.equal(h.savedCount, 1);

  assert.equal(h.controller.handleBroadcast({
    type: 'AGENT_CHANGED',
    agent: { id: 'a2', name: 'Agent 2', model: 'm2', provider: 'p2' },
  }), true);
  assert.deepEqual(h.agent, { id: 'a2', name: 'Agent 2', model: 'm2', provider: 'p2' });
  assert.equal(h.display.textContent, '当前助手: Agent 2 [m2]');
  assert.equal(h.storage.getItem('fork_chat_active_agent_id'), 'a2');
  assert.equal(h.storage.getItem('fork_chat_active_agent_name'), 'Agent 2');
  assert.equal(h.storage.getItem('fork_chat_active_agent_model'), 'm2');
  assert.equal(h.storage.getItem('fork_chat_active_agent_provider'), 'p2');
  assert.equal(h.renderCount, 1);
  assert.equal(h.savedCount, 2);
});

test('panel-agents: busy AGENT_CHANGED defers saving but still updates state and rendering', () => {
  const h = makeAgentControllerHarness();
  h.setBusy(true);

  assert.equal(h.controller.handleBroadcast({
    type: 'AGENT_CHANGED',
    agent: { id: 'a3', name: 'Agent 3', model: 'm3', provider: 'p3' },
  }), true);

  assert.deepEqual(h.agent, { id: 'a3', name: 'Agent 3', model: 'm3', provider: 'p3' });
  assert.equal(h.display.textContent, '当前助手: Agent 3 [m3]');
  assert.equal(h.storage.getItem('fork_chat_active_agent_id'), 'a3');
  assert.equal(h.renderCount, 1);
  assert.equal(h.savedCount, 0);
});

test('panel-agents: restoreAgent restores agent, reasoning effort, and storage without side effects', () => {
  const h = makeAgentControllerHarness();

  h.controller.restoreAgent({ id: 'a4', name: 'Agent 4', model: 'm4', provider: 'p4', reasoningEffort: 'medium' });

  assert.deepEqual(h.agent, { id: 'a4', name: 'Agent 4', model: 'm4', provider: 'p4', reasoningEffort: 'medium' });
  assert.equal(h.effort, 'medium');
  assert.equal(h.storage.getItem('fork_chat_active_agent_id'), 'a4');
  assert.equal(h.storage.getItem('fork_chat_active_agent_name'), 'Agent 4');
  assert.equal(h.storage.getItem('fork_chat_active_agent_model'), 'm4');
  assert.equal(h.storage.getItem('fork_chat_active_agent_provider'), 'p4');
  assert.equal(h.storage.getItem('fork_chat_reasoning_effort'), 'medium');
  assert.equal(h.renderCount, 0);
  assert.equal(h.savedCount, 0);
});

test('panel-canvas-view: createCanvasViewController layout, selection, height fallback, and lifecycle', () => {
  let cards = [
    { id: 'c1', parentId: null, x: 0, y: 0, width: 340, height: 360 },
    { id: 'c2', parentId: 'c1', x: 200, y: 100, width: 340, height: 400 },
  ];
  let selectedId = null;
  const view = { x: 0, y: 0, scale: 1, isDragging: false };
  let saveCount = 0;
  let renderCount = 0;
  let snapshotCount = 0;
  let laterCallback = null;

  class FakeClassList {
    constructor() { this.classes = new Set(); }
    add(c) { this.classes.add(c); }
    remove(c) { this.classes.delete(c); }
    contains(c) { return this.classes.has(c); }
  }

  const nodes = new Map();
  function getOrCreateNode(id) {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        classList: new FakeClassList(),
        style: {},
        focusCallCount: 0,
        focus() { this.focusCallCount++; },
        offsetHeight: undefined,
      });
    }
    return nodes.get(id);
  }

  const surface = { style: {} };
  const viewport = {
    style: {},
    getBoundingClientRect: () => ({ width: 1000, height: 700 }),
    classList: new FakeClassList(),
  };
  const zoomText = { textContent: '' };
  const doc = {
    getElementById: id => getOrCreateNode(id),
  };

  const controller = createCanvasViewController({
    getCards: () => cards,
    getSelectedCardId: () => selectedId,
    setSelectedCardId: id => { selectedId = id; },
    canMutateCanvas: () => true,
    view,
    surface,
    viewport,
    zoomText,
    scheduleSave: () => { saveCount++; },
    renderCards: () => { renderCount++; },
    recordSnapshot: () => { snapshotCount++; },
    clearMultiSelect: () => {},
    documentRef: () => doc,
    later: (cb, ms) => {
      laterCallback = cb;
      return 123;
    },
    listen: (target, type, fn) => () => {},
  });

  // 1. updateTransform
  view.x = 120;
  view.y = 80;
  view.scale = 1.5;
  controller.updateTransform();
  assert.equal(surface.style.transform, 'translate(120px, 80px) scale(1.5)');
  assert.equal(zoomText.textContent, '150%');
  assert.equal(saveCount, 1);

  // 2. selectCard: 更新类名、注入 setter、支持 focusInput
  controller.selectCard('c1', true);
  assert.equal(selectedId, 'c1');
  assert.equal(getOrCreateNode('dom-c1').classList.contains('is-selected-card'), true);
  assert.equal(getOrCreateNode('input-c1').focusCallCount, 1);

  controller.selectCard('c2', false);
  assert.equal(selectedId, 'c2');
  assert.equal(getOrCreateNode('dom-c1').classList.contains('is-selected-card'), false);
  assert.equal(getOrCreateNode('dom-c2').classList.contains('is-selected-card'), true);

  // 3. focusCardInViewport 高防偏离阶梯回退
  // Case A: 读到真实 DOM 高度 (850px，长文档卡)
  view.scale = 1;
  const domC1 = getOrCreateNode('dom-c1');
  domC1.offsetHeight = 850;
  controller.focusCardInViewport(cards[0]);
  // 视口高 700，垂直中心在 350；卡片中心在 850/2 = 425；view.y 应为 350 - 425 = -75
  assert.equal(view.y, -75, `真实 DOM 高度 850 时，视口 Y 应为 -75，实际 ${view.y}`);
  assert.equal(domC1.classList.contains('is-imported-pulse'), true);
  assert.ok(laterCallback);
  laterCallback();
  assert.equal(domC1.classList.contains('is-imported-pulse'), false);

  // Case B: 没有真实 offsetHeight，退回 card.height (400px，card.y = 100)
  const domC2 = getOrCreateNode('dom-c2');
  domC2.offsetHeight = undefined;
  controller.focusCardInViewport(cards[1]);
  // 视口高 700，垂直中心 350；卡片绝对中心 100 + 400/2 = 300；view.y 应为 350 - 300 = 50
  assert.equal(view.y, 50, `退回 card.height 400 时，视口 Y 应为 50，实际 ${view.y}`);

  // Case C: 两者皆空，退回 360px
  const blankCard = { id: 'c-blank', x: 0, y: 0, width: 340 };
  controller.focusCardInViewport(blankCard);
  // 视口高 700，垂直中心 350；卡片默认 360，中心 180；view.y 应为 350 - 180 = 170
  assert.equal(view.y, 170, `退回 360 兜底时，视口 Y 应为 170，实际 ${view.y}`);

  // 4. visibleCardsForFraming 必须过滤折叠子孙
  const rootCard = { id: 'r1', parentId: null };
  const childCard = { id: 'ch1', parentId: 'r1' };
  cards = [rootCard, childCard];
  assert.equal(controller.visibleCardsForFraming().length, 2);
  rootCard.isCollapsed = true;
  const visible = controller.visibleCardsForFraming();
  assert.equal(visible.length, 1);
  assert.equal(visible[0].id, 'r1');

  // 5. autoTidyLayout
  controller.autoTidyLayout();
  assert.ok(renderCount > 0);
  assert.ok(snapshotCount > 0);

  // 6. bind & cleanup
  controller.bind();
  controller.cleanup();
});

test('panel-canvas-actions: createRootCard, createBranchCard, closeCardHierarchy, and rememberRemovedCard', async () => {
  let cards = [];
  let selectedId = null;
  const multiSelectedCardIds = new Set(['card-test-1', 'other']);
  const abortedDocs = [];
  let saveCount = 0;
  let renderCount = 0;
  let snapshots = [];

  const actions = createCanvasActions({
    getCards: () => cards,
    setCards: next => { cards = next; },
    getSelectedCardId: () => selectedId,
    setSelectedCardId: id => { selectedId = id; },
    multiSelectedCardIds,
    canMutateCanvas: () => true,
    chainIsBusy: () => false,
    abortActiveRequest: () => {},
    abortDocumentTasksFor: id => { abortedDocs.push(id); },
    isModalOpen: () => false,
    renderCards: () => { renderCount++; },
    scheduleSave: () => { saveCount++; },
    recordSnapshot: (c, sId) => { snapshots.push({ count: c.length, sId }); },
    calculateBranchYPositions: () => [150],
    getSessionController: () => ({
      generation: 1,
      state: { activeId: 'session-1' },
      async newSession() {},
    }),
    initialSnapshot: () => ({}),
    extractDocumentFile: async () => ({ ok: false }),
    uniqueId: prefix => `${prefix}-test-1`,
  });

  // 1. createRootCard
  const root = await actions.createRootCard();
  assert.equal(root.id, 'card-test-1');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].parentId, null);
  assert.equal(cards[0].messages.length, 1);

  // 2. createBranchCard
  root.messages.push({ role: 'user', text: 'what is fork-chat?' });
  root.messages.push({ role: 'assistant', text: 'a collaborative canvas chat', status: 'completed' });
  const branch = actions.createBranchCard(root, { autoFocus: false });
  assert.equal(branch.id, 'branch-test-1');
  assert.equal(cards.length, 2);
  assert.equal(branch.parentId, root.id);
  assert.match(branch.messages[0].text, /承袭前置上下文/);

  // 3. closeCardHierarchy 级联删除、取消解析任务、清空多选、记忆完整留档
  selectedId = branch.id;
  actions.closeCardHierarchy(root);
  // root 和 branch 均应被删
  assert.equal(cards.length, 0);
  assert.equal(selectedId, null, '当前选中卡被删应被置空');
  assert.ok(abortedDocs.includes('card-test-1'));
  assert.ok(abortedDocs.includes('branch-test-1'));
  assert.equal(multiSelectedCardIds.has('card-test-1'), false);
  assert.equal(multiSelectedCardIds.has('other'), true);

  // 4. removedCardArchive 完整留档
  const archivedRoot = actions.removedCardArchive.get(root.id);
  assert.ok(archivedRoot);
  assert.equal(archivedRoot.messages.length, 3, '留档必须包含删除前的完整消息数组');

  // 5. 30 张有界限制
  for (let i = 0; i < 35; i++) {
    actions.rememberRemovedCard({ id: `temp-${i}`, content: i });
  }
  assert.equal(actions.removedCardArchive.size, 30);
  assert.equal(actions.removedCardArchive.has('temp-0'), false, '超出 30 必须丢弃最老项');
  assert.equal(actions.removedCardArchive.has('temp-34'), true);
});

test('panel-history-controller: onRestore restores geometry only for live cards and resurrects from archive for deleted cards', () => {
  let cards = [
    {
      id: 'c1',
      x: 100,
      y: 100,
      width: 340,
      height: 360,
      messages: [{ role: 'user', text: 'live question' }, { role: 'assistant', text: 'live answer' }],
    },
  ];
  let selectedId = 'c1';
  const archive = new Map();
  archive.set('c-deleted', {
    id: 'c-deleted',
    x: 50,
    y: 50,
    width: 340,
    height: 360,
    messages: [{ role: 'user', text: 'resurrected question' }],
  });

  const history = createHistoryController({
    getCards: () => cards,
    setCards: next => { cards = next; },
    getSelectedCardId: () => selectedId,
    setSelectedCardId: id => { selectedId = id; },
    getRemovedCardArchive: () => archive,
    renderCards: () => {},
    renderConnectors: () => {},
    scheduleSave: () => {},
  });

  // 状态 0：c1 处于旧坐标 (0, 0) 且快照里只有空消息（模拟早期快照），c-deleted 处于旧快照
  const snapshot0Cards = [
    { id: 'c1', x: 0, y: 0, width: 340, height: 360, messages: [] },
    { id: 'c-deleted', x: 20, y: 20, width: 340, height: 360, messages: [] },
  ];
  history.recordSnapshot(snapshot0Cards, 'c1');

  // 状态 1：当前状态（产生后续改动，c1 移动到 100, 100 并有问答）
  history.recordSnapshot(cards, 'c1');

  // 触发 undo，回退到状态 0
  assert.equal(history.undo(), true);

  // 1. 现存卡 c1：只回填几何字段，保留现存消息
  const restoredC1 = cards.find(c => c.id === 'c1');
  assert.equal(restoredC1.x, 0, '几何坐标应恢复为快照值 0');
  assert.equal(restoredC1.messages.length, 2, '业务消息必须以现存卡为准，不能被快照的空消息冲掉');
  assert.equal(restoredC1.messages[1].text, 'live answer');

  // 2. 被删卡 c-deleted：从 removedCardArchive 恢复完整数据，而不是快照里的空消息
  const restoredDeleted = cards.find(c => c.id === 'c-deleted');
  assert.ok(restoredDeleted);
  assert.equal(restoredDeleted.messages.length, 1, '被删卡片应从留档中恢复完整内容');
  assert.equal(restoredDeleted.messages[0].text, 'resurrected question');
});




