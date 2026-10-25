import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentRewriteSource } from '../lib/document-rewrite-model.js';

/*
 * 端到端哨兵：child 模型吐 <reflect> 思考块时，发布正文必须已被剥离。
 * 这是实机 2.1.0-rc.1 验收抓到的真实缺陷（v2 落盘正文以 <reflect> 开头），
 * 断言落在 createDocumentRewriteSource 的真实返回值上，防止剥离调用被悄悄绕过。
 */

const binding = { provider: 'p', model: 'm', systemPrompt: '' };
const harness = events => {
  const models = { streamEvents() { const iterator = (async function* () { yield* events; })(); return { [Symbol.asyncIterator]() { return { next: () => iterator.next(), return: () => iterator.return() }; } }; } };
  return createDocumentRewriteSource({ models, binding });
};
const input = { sourceText: '# 旧文档\n\n旧正文', instruction: '收紧范围', sourceFormat: 'md', targetFormat: 'md', sourceFidelity: 'text' };

test('rewrite child 输出 reflect 前缀块：发布正文不含思考块', async () => {
  const rewrite = harness([
    { type: 'text-delta', delta: '<reflect>\nPremise:\n  - 修订请求\n' },
    { type: 'text-delta', delta: '</reflect>\n\n# 修订稿\n\n新正文。' },
    { type: 'done' },
  ]);
  const out = await rewrite(input);
  assert.equal(out.content, '\n\n# 修订稿\n\n新正文。');
});

test('rewrite child 只输出未闭合 reflect：拒绝发布，不落思考文本', async () => {
  const rewrite = harness([
    { type: 'text-delta', delta: '<reflect>只写了一半的思考' },
    { type: 'done' },
  ]);
  await assert.rejects(() => rewrite(input), err => err.code === 'INVALID_CONTENT');
});
