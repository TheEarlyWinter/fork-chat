import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactPanel } from '../ui/assets/panel-artifact-panel.js';
import { createArtifactView } from '../ui/assets/panel-artifact-view.js';
import { collectSessionArtifacts } from '../ui/assets/artifact-session-index.js';

/*
 * 文档面板视图层回归（flash 交叉复核发现的死按钮缺陷的哨兵）：
 * overlay 上的 data-artifact-action 按钮必须真正触发 actions（preview/save），
 * 且走跨卡查找；会话切换（resetTransientUI→close）必须关闭面板。
 */

const meta = (id, name, extra = {}) => ({
  artifactId: id, status: 'ready', name, mime: 'text/markdown', format: 'md',
  bytes: 100, sha256: 'a'.repeat(64), createdAt: '2026-10-24T00:00:00.000Z', ...extra,
});

class FakeElement {
  constructor() { this.children = []; this.parentNode = null; this.dataset = {}; this._text = ''; }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  set className(v) { this._class = String(v); }
  get className() { return this._class || ''; }
  set type(v) { this._type = v; }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  append(...kids) { kids.forEach(child => this.appendChild(child)); }
  addEventListener(type, fn) { (this.listeners ||= {})[type] = fn; }
  closest(selector) {
    if (selector === '[data-artifact-action]' && this.dataset?.artifactAction) return this;
    if (selector === '[data-locate-card-id]' && this.dataset?.locateCardId) return this;
    return null;
  }
  removeEventListener() {}
  remove() { this.parentNode?.removeChild?.(this); }
  removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); child.parentNode = null; return child; }
}

function makeDoc() {
  const body = new FakeElement();
  const nodes = [];
  const documentRef = {
    body,
    createElement: () => { const el = new FakeElement(); nodes.push(el); return el; },
    addEventListener() {}, removeEventListener() {},
  };
  return { documentRef, nodes };
}

const v1 = meta('a'.repeat(32), '文档.md');
const v2 = meta('c'.repeat(32), '文档-v2.md', { version: 2, revisedFrom: 'a'.repeat(32), revisionRootId: 'a'.repeat(32) });
const cards = [
  { id: 'c1', title: '父卡', messages: [{ role: 'assistant', requestId: 'r1', artifacts: [v1] }] },
  { id: 'c2', title: '子卡', messages: [{ role: 'assistant', requestId: 'r2', artifacts: [v2] }] },
  { id: 'c3', title: '孙卡', messages: [{ role: 'assistant', requestId: 'r3', artifactRefs: [v2] }] },
];

test('面板 onAction 把 overlay 按钮点击接到真实 actions（死按钮哨兵）', () => {
  const { documentRef } = makeDoc();
  const calls = [];
  const panel = createArtifactPanel({
    getDocument: () => documentRef,
    getCards: () => cards,
    onAction: (artifactId, action) => calls.push({ artifactId, action }),
    locateCard: () => {},
  });
  const entries = panel.show();
  assert.ok(entries.length >= 1, '面板有数据');
  // 模拟点击 overlay 里「另存最新」按钮
  const overlay = documentRef.body.children.at(-1);
  const saveBtn = flatten(overlay).find(el => el.dataset?.artifactAction === 'save' && el.dataset?.artifactId === v2.artifactId);
  assert.ok(saveBtn, 'overlay 里有另存按钮');
  const clickEvent = { target: saveBtn, preventDefault() {}, stopPropagation() {} };
  (overlay.listeners || {}).click?.(clickEvent);
  assert.deepEqual(calls, [{ artifactId: v2.artifactId, action: 'save' }], '点击必须路由到 actions');
});

test('handleOverlayClick 跨卡查找 artifact 并触发 preview（真实 view 模块）', async () => {
  const { documentRef } = makeDoc();
  const previews = [];
  const requests = [];
  const view = createArtifactView({
    hana: { resources: {} },
    requestHost: async (hana, path, init) => { requests.push(path); return { ok: true, result: { contentBase64: Buffer.from('# ok').toString('base64'), format: 'md' } }; },
    flashMessage: () => {},
    getCards: () => cards,
    getGeneration: () => 1,
    isDisposed: () => false,
    getDocument: () => documentRef,
  });
  // 劫持 showPreview 通道：通过 actions 的 preview 路径验证（showPreview 是闭包注入，这里验证 preview 请求发出）
  const fakeBtn = { dataset: { artifactId: v1.artifactId, artifactAction: 'preview' }, closest: () => fakeBtn };
  const event = { target: fakeBtn, preventDefault() {}, stopPropagation() {} };
  const handled = view.handleOverlayClick(event);
  assert.equal(handled, true, '点击被处理');
  await new Promise(r => setImmediate(r));
  assert.ok(requests.some(p => p.includes('preview')), 'preview 请求已发出（真实 actions 链路）');
});

test('locate 链接点击先关面板再定位', () => {
  const { documentRef } = makeDoc();
  const located = [];
  const panel = createArtifactPanel({
    getDocument: () => documentRef,
    getCards: () => cards,
    onAction: () => {},
    locateCard: id => located.push(id),
  });
  panel.show();
  const overlay = documentRef.body.children.at(-1);
  const link = flatten(overlay).find(el => el.dataset?.locateCardId === 'c3');
  assert.ok(link, '有引用定位链接');
  (overlay.listeners || {}).click?.({ target: link });
  assert.deepEqual(located, ['c3']);
  assert.equal(panel.isOpen(), false, '面板已关闭');
});

test('close 后 isOpen 为 false，重复 close 幂等', () => {
  const { documentRef } = makeDoc();
  const panel = createArtifactPanel({ getDocument: () => documentRef, getCards: () => cards, onAction: () => {}, locateCard: () => {} });
  panel.show();
  panel.close();
  panel.close();
  assert.equal(panel.isOpen(), false);
});

function flatten(node, acc = []) {
  acc.push(node);
  for (const child of node.children || []) flatten(child, acc);
  return acc;
}
