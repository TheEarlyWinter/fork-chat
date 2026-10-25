import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocumentSmart, PARSE_MODES } from '../lib/parse-router.js';

// 这一组测试全部通过 localFn / cloudFn 注入，不碰网络、不碰真实文件。
// 之前这里只有一条「非 PDF 不升级」，等于云端路整条没测。

const readyConfig = (key) => {
  if (key === 'mineruEnabled') return true;
  if (key === 'mineruApiToken') return 'test-token';
  return undefined;
};
const disabledConfig = (key) => (key === 'mineruEnabled' ? false : undefined);
const noTokenConfig = (key) => (key === 'mineruEnabled' ? true : undefined);

const goodLocal = (overrides = {}) => ({
  ok: true,
  filename: 'paper.pdf',
  extension: '.pdf',
  charCount: 800,
  lineCount: 30,
  pageCount: 4,
  text: '正文内容足够长，质量检测会判为可读。'.repeat(40),
  preview: '正文内容',
  quality: { readable: true, score: 0.95, reasons: [] },
  ...overrides,
});

const badQualityLocal = (overrides = {}) => goodLocal({
  charCount: 40,
  text: '零星几十个字',
  quality: { readable: false, score: 0.2, reasons: ['control_chars'] },
  ...overrides,
});

test('parse-router: 模式白名单就是这三个', () => {
  assert.deepEqual([...PARSE_MODES], ['auto', 'local', 'cloud']);
});

test('parse-router: 本地结果合格时不上云', async () => {
  let cloudCalls = 0;
  const result = await parseDocumentSmart({
    filename: 'paper.pdf',
    mode: 'auto',
    getConfig: readyConfig,
    localFn: async () => goodLocal(),
    cloudFn: async () => { cloudCalls += 1; return { text: 'x', charCount: 1, modelVersion: 'vlm' }; },
  });
  assert.equal(result.engine, 'local');
  assert.equal(cloudCalls, 0);
  assert.equal(result.ok, true);
  assert.equal(result.quality.readable, true);
});

test('parse-router: 本地报 no_text_layer 的 PDF 会升级上云，并记下原因', async () => {
  const result = await parseDocumentSmart({
    filename: 'scan.pdf',
    mode: 'auto',
    getConfig: readyConfig,
    localFn: async () => { throw Object.assign(new Error('no text layer'), { code: 'no_text_layer' }); },
    cloudFn: async () => ({ text: '扫描件识别出来的正文'.repeat(30), charCount: 330, modelVersion: 'vlm', ocrFallback: true }),
  });
  assert.equal(result.engine, 'mineru');
  assert.equal(result.escalatedFrom, 'no_text_layer');
  assert.match(result.engineLabel, /OCR/);
  assert.equal(result.quality.source, 'mineru');
});

test('parse-router: 本地能用但字数太少，也会升级上云', async () => {
  const result = await parseDocumentSmart({
    filename: 'watermark.pdf',
    mode: 'auto',
    getConfig: readyConfig,
    localFn: async () => goodLocal({ charCount: 60, text: '只有水印' }),
    cloudFn: async () => ({ text: '真正的正文'.repeat(60), charCount: 300, modelVersion: 'vlm' }),
  });
  assert.equal(result.engine, 'mineru');
  assert.equal(result.escalatedFrom, 'suspiciously-short');
});

test('parse-router: 非 PDF 即使质量不够也不上云，并在结果里说明', async () => {
  let cloudCalls = 0;
  const result = await parseDocumentSmart({
    filename: 'notes.docx',
    mode: 'auto',
    getConfig: readyConfig,
    localFn: async () => badQualityLocal({ filename: 'notes.docx', extension: '.docx' }),
    cloudFn: async () => { cloudCalls += 1; return { text: 'x', charCount: 1, modelVersion: 'vlm' }; },
  });
  assert.equal(cloudCalls, 0);
  assert.equal(result.engine, 'local');
  assert.match(result.quality.cloudSkipped, /非 PDF/);
});

test('parse-router: 云端不可用时抛出带提示的错误（本地已彻底失败）', async () => {
  await assert.rejects(
    () => parseDocumentSmart({
      filename: 'scan.pdf',
      mode: 'auto',
      getConfig: disabledConfig,
      localFn: async () => { throw Object.assign(new Error('no text layer'), { code: 'no_text_layer' }); },
    }),
    (err) => /no text layer/.test(err.message) && /云端解析未启用/.test(err.message),
  );
});

test('parse-router: 已启用但没填 Token 时，错误信息要指出这一点', async () => {
  await assert.rejects(
    () => parseDocumentSmart({
      filename: 'scan.pdf',
      mode: 'auto',
      getConfig: noTokenConfig,
      localFn: async () => { throw Object.assign(new Error('no text layer'), { code: 'no_text_layer' }); },
    }),
    (err) => /还没填 API Token/.test(err.message),
  );
});

test('parse-router: 云端失败要回落到本地结果，不能整件事白费', async () => {
  const result = await parseDocumentSmart({
    filename: 'paper.pdf',
    mode: 'auto',
    getConfig: readyConfig,
    localFn: async () => badQualityLocal(),
    cloudFn: async () => { throw new Error('云端 503'); },
  });
  assert.equal(result.engine, 'local');
  assert.equal(result.ok, true);
  assert.match(result.quality.cloudFailed, /503/);
});

test('parse-router: local 模式绝不上云，哪怕配了 Token', async () => {
  let cloudCalls = 0;
  const result = await parseDocumentSmart({
    filename: 'paper.pdf',
    mode: 'local',
    getConfig: readyConfig,
    localFn: async () => goodLocal(),
    cloudFn: async () => { cloudCalls += 1; return { text: 'x', charCount: 1, modelVersion: 'vlm' }; },
  });
  assert.equal(cloudCalls, 0);
  assert.equal(result.engine, 'local');
});

test('parse-router: local 模式本地失败就直接抛，不偷偷上云', async () => {
  let cloudCalls = 0;
  await assert.rejects(
    () => parseDocumentSmart({
      filename: 'scan.pdf',
      mode: 'local',
      getConfig: readyConfig,
      localFn: async () => { throw Object.assign(new Error('no text layer'), { code: 'no_text_layer' }); },
      cloudFn: async () => { cloudCalls += 1; return { text: 'x', charCount: 1, modelVersion: 'vlm' }; },
    }),
    /no text layer/,
  );
  assert.equal(cloudCalls, 0);
});

test('parse-router: cloud 模式跳过本地，直接上云并标注 requested', async () => {
  let localCalls = 0;
  const result = await parseDocumentSmart({
    filename: 'paper.pdf',
    mode: 'cloud',
    getConfig: readyConfig,
    localFn: async () => { localCalls += 1; return goodLocal(); },
    cloudFn: async () => ({ text: '云端正文'.repeat(50), charCount: 200, modelVersion: 'vlm' }),
  });
  assert.equal(localCalls, 0);
  assert.equal(result.engine, 'mineru');
  assert.equal(result.escalatedFrom, 'requested');
});

test('parse-router: cloud 模式遇到非 PDF 直接拒绝', async () => {
  await assert.rejects(
    () => parseDocumentSmart({
      filename: 'notes.txt',
      mode: 'cloud',
      getConfig: readyConfig,
      localFn: async () => goodLocal(),
      cloudFn: async () => ({ text: 'x', charCount: 1, modelVersion: 'vlm' }),
    }),
    /只支持 PDF/,
  );
});

test('parse-router: 云端返回乱码时不能标成可读', async () => {
  // 全是控制字符，字数够多但根本读不懂
  const garbage = '\u0001\u0002\u0003'.repeat(400);
  const result = await parseDocumentSmart({
    filename: 'scan.pdf',
    mode: 'cloud',
    getConfig: readyConfig,
    cloudFn: async () => ({ text: garbage, charCount: garbage.length, modelVersion: 'vlm' }),
  });
  assert.equal(result.quality.readable, false, '乱码不得被判为 readable');
  assert.equal(result.quality.longEnough, true, '字数另记一笔，不参与可读判定');
  assert.ok(result.quality.reasons.length > 0);
});

test('parse-router: 未知 mode 退回 auto，不抛错', async () => {
  const result = await parseDocumentSmart({
    filename: 'paper.pdf',
    mode: 'whatever',
    getConfig: readyConfig,
    localFn: async () => goodLocal(),
    cloudFn: async () => ({ text: 'x', charCount: 1, modelVersion: 'vlm' }),
  });
  assert.equal(result.engine, 'local');
});

test('parse-router: 文件名大小写不影响 PDF 判断', async () => {
  const result = await parseDocumentSmart({
    filename: 'PAPER.PDF',
    mode: 'auto',
    getConfig: readyConfig,
    localFn: async () => { throw Object.assign(new Error('no text layer'), { code: 'no_text_layer' }); },
    cloudFn: async () => ({ text: 'cloud text'.repeat(40), charCount: 400, modelVersion: 'vlm' }),
  });
  assert.equal(result.engine, 'mineru');
});
