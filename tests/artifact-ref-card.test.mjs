import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactRefsHtml } from '../ui/assets/panel-artifact-markup.js';
import { deliveredFilesHtml } from '../ui/assets/panel-messages.js';
import { cardContentSignature } from '../ui/assets/panel-render-diff.js';
import { normalizeArtifactList } from '../ui/assets/artifact-contract.js';

/*
 * 本轮修订引用卡（2.1.0 用户拍板：每次修订在本轮消息弹可见引用卡）。
 * 契约（Sol document-revise-污染处置与引用卡契约.md §B）：
 * refs 数据形状不变（ArtifactMetadata[]）；同 ID 完整文件卡不重复显示；
 * refs-only 变化必须令渲染签名失效；恶意 name 转义。
 */

const meta = (id, extra = {}) => ({
  artifactId: id, status: 'ready', name: '文档.md', mime: 'text/markdown', format: 'md',
  bytes: 100, sha256: 'a'.repeat(64), createdAt: '2026-10-24T00:00:00.000Z', ...extra,
});
const v2 = meta('c'.repeat(32), { name: '文档-v2.md', version: 2, revisedFrom: 'a'.repeat(32), revisionRootId: 'a'.repeat(32) });

test('refs 渲染为引用卡：名称、已更新到 v2、预览/另存按钮', () => {
  const html = artifactRefsHtml({ artifactRefs: [v2] });
  assert.ok(html.includes('artifact-ref-card'));
  assert.ok(html.includes('文档-v2.md'));
  assert.ok(html.includes('已更新到 v2'));
  assert.ok(html.includes(`data-artifact-id="${v2.artifactId}"`));
  assert.ok(html.includes('data-artifact-action="preview"'));
  assert.ok(html.includes('data-artifact-action="save"'));
});

test('与本消息完整文件卡同 ID 的引用不重复显示', () => {
  const message = { artifacts: [v2], artifactRefs: [v2] };
  const html = artifactRefsHtml(message);
  assert.equal(html, '');
});

test('无 refs 或 refs 为空数组时不输出任何标记', () => {
  assert.equal(artifactRefsHtml({}), '');
  assert.equal(artifactRefsHtml({ artifactRefs: [] }), '');
  assert.equal(artifactRefsHtml(null), '');
});

test('恶意文件名被转义，不能注入 HTML', () => {
  const evil = meta('e'.repeat(32), { name: '<img src=x onerror=alert(1)>.md', version: 2, revisedFrom: 'a'.repeat(32), revisionRootId: 'a'.repeat(32) });
  const html = artifactRefsHtml({ artifactRefs: [evil] });
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});

test('deliveredFilesHtml 完整输出包含文件卡 + 引用卡', () => {
  const v1 = meta('a'.repeat(32));
  const message = { artifacts: [v1], artifactRefs: [v2] };
  const html = deliveredFilesHtml(message);
  assert.ok(html.includes('artifact-file-card'), '完整文件卡仍在');
  assert.ok(html.includes('artifact-ref-card'), '引用卡新增');
});

test('refs-only 变化令渲染签名失效（不依赖 status/text 变化）', () => {
  const card = id => ({ id: 'c1', title: 't', x: 0, y: 0, width: 300, messages: [{ role: 'assistant', requestId: 'r1', text: 'done', status: 'completed', artifactRefs: id ? [meta(id)] : [] }] });
  const without = cardContentSignature(card(null));
  const withRef = cardContentSignature(card('b'.repeat(32)));
  assert.notEqual(without, withRef, 'refs 增减必须改变签名');
  const refChanged = cardContentSignature(card('d'.repeat(32)));
  assert.notEqual(withRef, refChanged, 'refs 内容变化必须改变签名');
});

test('refs 经过 normalize 白名单后仍可渲染（数据形状不变）', () => {
  const refs = normalizeArtifactList([v2]);
  assert.equal(refs.length, 1);
  const html = artifactRefsHtml({ artifactRefs: refs });
  assert.ok(html.includes('已更新到 v2'));
});

test('渲染层自归一化：非法 refs（坏 ID/字段）不进入 HTML', () => {
  const dirty = [
    { ...v2, artifactId: 'not-hex!' },
    { ...v2, artifactId: 'f'.repeat(32), sha256: 'short' },
    null,
    'string-item',
  ];
  const html = artifactRefsHtml({ artifactRefs: dirty });
  assert.ok(!html.includes('not-hex!'));
  assert.ok(!html.includes('data-artifact-ref-id="f'.repeat(32)), '非法字段的项被哨兵拒掉');
  const validOnly = artifactRefsHtml({ artifactRefs: [v2, ...dirty] });
  assert.ok(validOnly.includes(v2.artifactId), '合法项保留');
  assert.equal((validOnly.match(/artifact-ref-card/g) || []).length, 1, '只渲染合法那一项');
});

test('引用卡文案指向固定版本（另存此版本），不承诺最新版', () => {
  const html = artifactRefsHtml({ artifactRefs: [v2] });
  assert.ok(html.includes('另存此版本'));
  assert.ok(!html.includes('另存最新版'));
});
