import test from 'node:test';
import assert from 'node:assert/strict';
import { bindContextToggle } from '../ui/assets/panel-card-events.js';

/*
 * 上下文开关防误触（2.2 专项①）：
 * 单击只弹确认态（文案+样式切换），3 秒无操作或指针离开自动还原；
 * 只有确认态下再点一次才真正切换 contextMode。
 * rc.1 实机验收教训：旧版单击即切换，坐标误触把卡片静默设为 exclude。
 */

function makeHarness({ mutateAllowed = true } = {}) {
  const card = { id: 'c1', title: 't', messages: [], contextMode: undefined };
  const listeners = new Map();
  const timers = [];
  let renders = 0, saves = 0, snapshots = 0;
  const button = {
    dataset: {}, classList: { values: new Set(), add(...n) { n.forEach(x => this.values.add(x)); }, remove(...n) { n.forEach(x => this.values.delete(x)); } },
    textContent: '向后续分支提供上下文',
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {},
  };
  const cardEl = { querySelector: sel => sel === '[data-action="toggle-context-mode"]' ? button : null };
  bindContextToggle({
    cardEl, card,
    on: (target, type, fn) => { if (target === button) listeners.set(type, fn); },
    getIsDisposed: () => false,
    canMutateCanvas: () => mutateAllowed,
    renderCards: () => { renders += 1; },
    scheduleSave: () => { saves += 1; },
    recordSnapshot: () => { snapshots += 1; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fired = true; },
  });
  const click = () => listeners.get('click')({ stopPropagation() {} });
  const leave = () => listeners.get('pointerleave')?.();
  const runTimers = () => { for (const t of timers.splice(0)) if (!t.fired) t.fn(); };
  return { card, button, click, leave, runTimers, stats: () => ({ renders, saves, snapshots }) };
}

test('单击第一次：只弹确认态，不改 contextMode', () => {
  const h = makeHarness();
  h.click();
  assert.equal(h.card.contextMode, undefined, '策略未变');
  assert.equal(h.button.dataset.confirm, '1');
  assert.ok(h.button.classList.values.has('is-confirming'));
  assert.ok(h.button.textContent.includes('确认'));
  assert.deepEqual(h.stats(), { renders: 0, saves: 0, snapshots: 0 }, '无渲染/保存/快照副作用');
});

test('确认态下第二次点击：真正切换为 exclude', () => {
  const h = makeHarness();
  h.click(); h.click();
  assert.equal(h.card.contextMode, 'exclude');
  assert.equal(h.stats().renders, 1);
  assert.equal(h.stats().saves, 1);
  assert.equal(h.button.dataset.confirm, undefined, '确认态退出');
});

test('确认弹出后 3 秒无操作：自动还原，不切换', () => {
  const h = makeHarness();
  h.click();
  h.runTimers();
  assert.equal(h.button.dataset.confirm, undefined);
  assert.equal(h.card.contextMode, undefined);
  // 还原后再点一次又是确认态（不是直接切换）
  h.click();
  assert.equal(h.card.contextMode, undefined);
  assert.equal(h.button.dataset.confirm, '1');
});

test('指针离开按钮：确认态立即还原', () => {
  const h = makeHarness();
  h.click();
  h.leave();
  assert.equal(h.button.dataset.confirm, undefined);
  assert.equal(h.card.contextMode, undefined);
});

test('exclude 状态恢复（反向切换）同样需要确认', () => {
  const h = makeHarness();
  h.card.contextMode = 'exclude';
  h.click();
  assert.equal(h.card.contextMode, 'exclude', '第一次点击不恢复');
  assert.ok(h.button.textContent.includes('确认恢复'));
  h.click();
  assert.equal(h.card.contextMode, undefined, '确认后恢复');
});

test('canMutateCanvas 为 false：点击无任何效果', () => {
  const h = makeHarness({ mutateAllowed: false });
  h.click(); h.click();
  assert.equal(h.card.contextMode, undefined);
  assert.equal(h.button.dataset.confirm, undefined);
});
