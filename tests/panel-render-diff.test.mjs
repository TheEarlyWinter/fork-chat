import test from 'node:test';
import assert from 'node:assert/strict';
import { cardContentSignature, canReuseCardElement } from '../ui/assets/panel-render-diff.js';

/*
 * 卡片级增量渲染测试（性能与内存专项第一批）。
 * 契约：
 * - 内容签名：卡片数据中影响 DOM 的字段进签名，坐标不进（坐标变了走挪位）
 * - 签名未变的卡：DOM 复用（不重建 innerHTML、不重绑监听）
 * - 签名变化的卡：重建并重新绑定
 * - 卡片集合增删：新卡建、消失卡移除，其余复用
 */

test('签名：覆盖影响 DOM 的字段，不含坐标', () => {
  const base = { id: 'c1', messages: [{ role: 'user', text: 'hi' }], statusStamp: 'starred', width: 300, isCollapsed: false };
  const sig1 = cardContentSignature(base);
  // 坐标与 savedScrollTop/scrollToEnd 不进签名
  assert.equal(sig1, cardContentSignature({ ...base, x: 99, y: 99, savedScrollTop: 40, scrollToEnd: true }));
  // 正文、状态、宽度、折叠变化都要进
  assert.notEqual(sig1, cardContentSignature({ ...base, messages: [{ role: 'user', text: 'hi2' }] }));
  assert.notEqual(sig1, cardContentSignature({ ...base, statusStamp: 'accepted' }));
  assert.notEqual(sig1, cardContentSignature({ ...base, width: 400 }));
  assert.notEqual(sig1, cardContentSignature({ ...base, isCollapsed: true }));
  // 高度自定义也影响 DOM 结构
  assert.notEqual(sig1, cardContentSignature({ ...base, height: 500 }));
});

test('签名：流式增量只动尾部时签名变化（触发重建），artifact 附加也算内容', () => {
  const base = { id: 'c1', messages: [{ role: 'assistant', text: '正在', streaming: true }] };
  const sig = cardContentSignature(base);
  assert.notEqual(sig, cardContentSignature({ ...base, messages: [{ ...base.messages[0], text: '正在生成' }] }));
  const withArtifact = { id: 'c1', messages: [{ role: 'assistant', text: 'done', artifacts: [{ artifactId: 'a'.repeat(32) }] }] };
  assert.notEqual(cardContentSignature({ ...base, messages: [{ role: 'assistant', text: 'done' }] }), cardContentSignature(withArtifact));
});

test('复用判定：相同签名的卡可复用 DOM，不同签名必须重建', () => {
  const card = { id: 'c1', messages: [], x: 0, y: 0 };
  const sig = cardContentSignature(card);
  assert.equal(canReuseCardElement(card, sig, { __boundCard: card, __contentSignature: sig }), true);
  assert.equal(canReuseCardElement(card, sig, { __boundCard: { ...card }, __contentSignature: sig }), false, '绑定的卡对象换了必须重建');
  assert.equal(canReuseCardElement(card, sig, { __boundCard: card, __contentSignature: 'other' }), false, '签名变化必须重建');
  assert.equal(canReuseCardElement(card, sig, null), false);
});
