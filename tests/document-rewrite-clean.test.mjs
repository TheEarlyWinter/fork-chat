import test from 'node:test';
import assert from 'node:assert/strict';
import { stripAssistantPrefixBlocks, documentBodyFromModelText } from '../lib/document-rewrite-clean.js';

/*
 * reflect 污染修复回归（实机 2.1.0-rc.1 验收发现）：
 * 修订 child 模型把 <reflect> 思考块写进文档正文落盘。
 * 剥离规则与 ui/assets/assistant-output.js 的 UI 解析同语法：
 * 仅前缀、精确小写无属性标签、嵌套计数、未闭合拒绝。
 */

test('前缀 reflect 块被剥离，正文保留原始空白', () => {
  const raw = '<reflect>\nPremise:\n  - 修订请求\n</reflect>\n\n# Clean Acceptance\n\n正文内容。';
  assert.equal(stripAssistantPrefixBlocks(raw), '\n\n# Clean Acceptance\n\n正文内容。');
});

test('多个连续前缀块（mood+reflect）全部剥离', () => {
  const raw = '<mood>focus</mood><reflect>思考</reflect># 文档\n\n内容';
  assert.equal(stripAssistantPrefixBlocks(raw), '# 文档\n\n内容');
});

test('正文中间出现的标签不动（只剥前缀）', () => {
  const raw = '# 标题\n\n<reflect>正文里引用的标签是数据</reflect>\n\n内容';
  assert.equal(stripAssistantPrefixBlocks(raw), raw);
});

test('嵌套同名标签正确计数', () => {
  const raw = '<reflect>外层<reflect>内层</reflect>仍外层</reflect>正文';
  assert.equal(stripAssistantPrefixBlocks(raw), '正文');
});

test('未闭合前缀块返回 null，发布路径抛 INVALID_CONTENT', () => {
  const raw = '<reflect>只写了一半';
  assert.equal(stripAssistantPrefixBlocks(raw), null);
  assert.throws(() => documentBodyFromModelText(raw), err => err.code === 'INVALID_CONTENT');
});

test('干净正文原样通过（含空串与 BOM）', () => {
  assert.equal(stripAssistantPrefixBlocks('# 干净文档'), '# 干净文档');
  assert.equal(stripAssistantPrefixBlocks(''), '');
  assert.equal(stripAssistantPrefixBlocks('\uFEFF\n<reflect>r</reflect>正文'), '正文');
});

test('前导空白后跟正文（无标签）不受影响', () => {
  assert.equal(stripAssistantPrefixBlocks('\n\n  # 标题'), '\n\n  # 标题');
});

test('Unicode 空白（全角空格/NBSP）前缀的思考块同样剥离，与 UI 谓词一致', () => {
  // 定向复核复现的绕过边界：server 旧版只认 ASCII 空白，这两种形态曾残留 reflect
  assert.equal(stripAssistantPrefixBlocks('　<reflect>r</reflect>\n# Body'), '\n# Body');
  assert.equal(stripAssistantPrefixBlocks(' <reflect>r</reflect>\n# Body'), '\n# Body');
  assert.equal(stripAssistantPrefixBlocks('　<reflect>未闭合'), null);
});

test('真实污染样本形态：reflect 整块在最前，剥离后是完整 Markdown', () => {
  const sample = '<reflect>\nPremise:\n  - 催花清雨要求重构 Action Items。\n</reflect>\n# Clean Acceptance\n\n## Summary\n\nBaseline acceptance criteria.';
  const body = documentBodyFromModelText(sample);
  assert.ok(body.trimStart().startsWith('# Clean Acceptance'));
  assert.ok(!body.includes('<reflect>'));
});
