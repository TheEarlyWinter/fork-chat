import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateConnectorGeometry } from '../ui/assets/panel-connectors.js';
import { calculateBranchYPositions, computeAutoTidyPositions, fitViewportToCluster } from '../ui/assets/panel-layout.js';
import { findCardByDirection } from '../ui/assets/panel-shortcuts.js';

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
