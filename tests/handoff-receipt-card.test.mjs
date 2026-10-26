import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHandoffReceiptCard } from '../ui/assets/handoff-receipt.js';
import { createFakeDocument, response, deferred, waitFor } from './fixtures/handoff-fixtures.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 交接卡只认宿主盖戳的 embeddedSessionId：没有绑定就不请求，
// 绑定变化立即清空旧内容，迟到的旧响应不得串到新会话。
const SESSION_A = 'sess_home_a';
const SESSION_B = 'sess_home_b';
const RECEIPT = {
  sessionId: SESSION_A,
  actionId: 'ha_' + 'd'.repeat(32),
  agentId: 'agent-a',
  source: { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: 'card-1' },
  transcript: '# 交接正文\n\n<div class="evil">加上 <script>alert(1)</script> 也不能当 HTML 执行</div>',
  files: [
    { fileId: 'sf_report_1', name: '报告.md', mime: 'text/markdown', kind: 'artifact' },
    { fileId: 'sf_archive_1', name: 'handoff.md', mime: 'text/markdown', kind: 'archive' },
  ],
};

const PDF_RECEIPT = {
  ...RECEIPT,
  files: [
    { fileId: 'sf_pdf_1', name: 'report.pdf', mime: 'application/pdf', kind: 'artifact' },
    { fileId: 'sf_pdf_2', name: 'appendix.pdf', mime: 'application/pdf', kind: 'artifact' },
  ],
};

function fakeHana(context) {
  const listeners = new Set();
  const resourceCalls = [];
  const hana = {
    context,
    listeners,
    resourceCalls,
    surface: {
      getContext() {
        return hana.context;
      },
      onContextChanged(callback) {
        listeners.add(callback);
        callback(hana.context);
        return () => listeners.delete(callback);
      },
    },
    resources: {
      async open(input, options) {
        resourceCalls.push({ input, options });
        return { ok: true };
      },
    },
  };
  hana.emit = next => {
    hana.context = next;
    for (const callback of [...listeners]) callback(next);
  };
  return hana;
}

function requestRecorder(handler = async () => response({ ok: true, receipt: RECEIPT })) {
  const calls = [];
  return {
    calls,
    async requestHost(hana, path, init) {
      calls.push({ path, init });
      return handler({ hana, path, init, index: calls.length });
    },
  };
}

function bodyText(documentRef) {
  return documentRef.body.textContent;
}

test('without an embedded session the card requests nothing and says why', async () => {
  for (const context of [null, { slot: 'card', cardInstanceId: 'card-1', appId: 'fork-chat' }, { slot: 'card', embeddedSessionId: '' }]) {
    const documentRef = createFakeDocument();
    const hana = fakeHana(context);
    const recorder = requestRecorder();
    const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(recorder.calls.length, 0, '没有宿主会话绑定就不允许发请求');
    assert.match(bodyText(documentRef), /无法确定|没有.*会话|不可用/);
    assert.equal(documentRef.body.querySelectorAll('.handoff-receipt-file').length, 0);
    card.dispose();
  }
});

test('the card reads the receipt for its embedded session and renders text and file buttons', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', cardInstanceId: 'card-1', appId: 'fork-chat', embeddedSessionId: SESSION_A });
  const recorder = requestRecorder();
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  await waitFor(() => documentRef.body.querySelector('.handoff-receipt-transcript')?.textContent !== '');

  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].path, `/api/handoff/sessions/${encodeURIComponent(SESSION_A)}/receipt`);
  const transcript = documentRef.body.querySelector('.handoff-receipt-transcript');
  // 正文按文本节点渲染：原文逐字符一致，且没有因为 HTML 生成子元素
  assert.equal(transcript.textContent, RECEIPT.transcript);
  assert.equal(transcript.children.length, 0);

  const buttons = documentRef.body.querySelectorAll('.handoff-receipt-file');
  assert.deepEqual(buttons.map(button => button.textContent), ['报告.md', 'handoff.md']);

  // 卡片元信息必须可核对到具体会话与动作，纯文本可选中
  const meta = documentRef.body.querySelector('.handoff-receipt-meta');
  assert.match(meta.textContent, new RegExp(SESSION_A));
  assert.match(meta.textContent, new RegExp(RECEIPT.actionId));

  buttons[0].dispatchEvent({ type: 'click' });
  await new Promise(resolve => setImmediate(resolve));
  // Markdown 不再借宿主 resources.open，而是按需请求应用自己的只读预览接口
  assert.equal(recorder.calls.length, 2);
  assert.equal(recorder.calls[1].path, `/api/handoff/sessions/${SESSION_A}/files/sf_report_1/preview`);
  assert.deepEqual(hana.resourceCalls, [], 'MD 不得再走 resources.open');
  card.dispose();
});

test('a refused preview reports a fixed short error instead of looking opened', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  hana.resources.open = async input => {
    hana.resourceCalls.push({ input, options: undefined });
    return { opened: false };
  };
  const recorder = requestRecorder(async () => response({ ok: true, receipt: PDF_RECEIPT }));
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  documentRef.body.querySelectorAll('.handoff-receipt-file')[0].dispatchEvent({ type: 'click' });
  await waitFor(() => /无法打开|未打开|失败/.test(bodyText(documentRef)));
  assert.equal(documentRef.body.querySelector('.handoff-receipt-status').textContent, '', '文件错误只写文件状态行');
  card.dispose();
});

test('a file failure from an old binding cannot overwrite the new card', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const preview = deferred();
  hana.resources.open = input => {
    hana.resourceCalls.push({ input, options: undefined });
    return preview.promise;
  };
  const recorder = requestRecorder(({ path }) => {
    if (path.includes(SESSION_A)) return response({ ok: true, receipt: PDF_RECEIPT });
    return response({ ok: true, receipt: { ...RECEIPT, sessionId: SESSION_B, transcript: 'B 会话正文', files: [] } });
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  const staleButton = documentRef.body.querySelectorAll('.handoff-receipt-file')[0];
  staleButton.dispatchEvent({ type: 'click' });
  await waitFor(() => hana.resourceCalls.length === 1);

  hana.emit({ slot: 'card', embeddedSessionId: SESSION_B });
  await waitFor(() => documentRef.body.textContent.includes('B 会话正文'));
  preview.reject(new Error('EACCES /private/handoff/secret'));
  await new Promise(resolve => setImmediate(resolve));
  const statusText = documentRef.body.querySelector('.handoff-receipt-status').textContent;
  assert.equal(statusText, '', '旧绑定的预览失败不得污染新卡状态');
  assert.equal(documentRef.body.querySelector('.handoff-file-status').textContent, '', '旧绑定失败不得写文件状态行');
  assert.equal(documentRef.body.textContent.includes('/private/handoff/secret'), false);

  // 旧按钮回调不得在新的绑定下打开旧会话的文件
  staleButton.dispatchEvent({ type: 'click' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hana.resourceCalls.length, 1, '旧按钮必须失效');
  card.dispose();
});

test('a preview failure after dispose is ignored', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const preview = deferred();
  hana.resources.open = input => {
    hana.resourceCalls.push({ input, options: undefined });
    return preview.promise;
  };
  const recorder = requestRecorder(async () => response({ ok: true, receipt: PDF_RECEIPT }));
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  documentRef.body.querySelectorAll('.handoff-receipt-file')[0].dispatchEvent({ type: 'click' });
  await waitFor(() => hana.resourceCalls.length === 1);
  const status = documentRef.body.querySelector('.handoff-receipt-status');
  const fileStatus = documentRef.body.querySelector('.handoff-file-status');
  card.dispose();
  preview.reject(new Error('EACCES'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.textContent, '', 'dispose 后的失败不得改写已卸载的状态栏');
  assert.equal(fileStatus.textContent, '');
  assert.equal(documentRef.body.children.length, 0);
});

test('a binding change clears the old receipt immediately and a late answer cannot overwrite it', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const first = deferred();
  const recorder = requestRecorder(({ path }) => {
    if (path.includes(SESSION_A)) return first.promise;
    return response({ ok: true, receipt: { ...RECEIPT, sessionId: SESSION_B, transcript: 'B 会话正文', files: [] } });
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  await waitFor(() => recorder.calls.length === 1);
  hana.emit({ slot: 'card', embeddedSessionId: SESSION_B });
  // 绑定一换，旧内容立刻消失，不能继续展示 A 的数据
  assert.equal(documentRef.body.querySelector('.handoff-receipt-transcript')?.textContent || '', '');
  await waitFor(() => documentRef.body.textContent.includes('B 会话正文'));

  first.resolve(response({ ok: true, receipt: RECEIPT }));
  await new Promise(resolve => setImmediate(resolve));
  const transcript = documentRef.body.querySelector('.handoff-receipt-transcript');
  assert.equal(transcript.textContent, 'B 会话正文', '迟到响应不得覆盖当前绑定');
  assert.equal(documentRef.body.textContent.includes('交接正文'), false);
  card.dispose();
});

test('an unbound context after a bound one clears the receipt and stops further requests', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const recorder = requestRecorder();
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelector('.handoff-receipt-transcript')?.textContent !== '');

  hana.emit({ slot: 'card', cardInstanceId: 'card-1' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(documentRef.body.querySelector('.handoff-receipt-transcript')?.textContent || '', '');
  assert.equal(recorder.calls.length, 1, '失去绑定后不再发起请求');
  assert.match(bodyText(documentRef), /无法确定|没有.*会话|不可用/);
  card.dispose();
});

test('a failed read shows a safe message without leaking body text or paths', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const recorder = requestRecorder(async () => response({ ok: false, code: 'HANDOFF_RECEIPT_NOT_FOUND', error: '交接记录不存在' }, 404));
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  await waitFor(() => /不存在|失败|不可用/.test(bodyText(documentRef)));
  assert.equal(documentRef.body.textContent.includes('/var/'), false);
  assert.equal(documentRef.body.querySelectorAll('.handoff-receipt-file').length, 0);
  card.dispose();
});

test('dispose unsubscribes the surface so later context changes do nothing', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const recorder = requestRecorder();
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => recorder.calls.length === 1);

  card.dispose();
  assert.equal(hana.listeners.size, 0);
  hana.emit({ slot: 'card', embeddedSessionId: SESSION_B });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorder.calls.length, 1, 'dispose 后不得再请求');
  assert.equal(documentRef.body.children.length, 0, '根节点应被移除');
});

// ---------------------------------------------------------------------------
// 文件预览：MD/纯文本走新只读接口，不再依赖宿主 resources.open
// ---------------------------------------------------------------------------

const PREVIEW_TEXT = '# 报告\n\n真实字节正文，<script>alert(1)</script> 必须当文本。\n';
const PREVIEW_HTML = '<h1>报告</h1>\n<p>真实字节正文，&lt;script&gt;alert(1)&lt;/script&gt; 必须当文本。</p>';

function previewRecorder({ receipt = RECEIPT, receipts = null, previewByFile = {}, previewHttp = null } = {}) {
  const calls = [];
  return {
    calls,
    async requestHost(hana, requestPath, init) {
      calls.push({ path: requestPath, init });
      if (requestPath.endsWith('/receipt')) {
        if (receipts) {
          const match = /\/sessions\/([^/]+)\/receipt$/.exec(requestPath);
          const key = match ? decodeURIComponent(match[1]) : '';
          return response({ ok: true, receipt: receipts[key] ?? receipts.default });
        }
        return response({ ok: true, receipt });
      }
      const match = /\/files\/([^/]+)\/preview$/.exec(requestPath);
      if (!match) throw new Error(`unexpected path ${requestPath}`);
      const fileId = decodeURIComponent(match[1]);
      if (previewHttp) return previewHttp(fileId);
      const preview = previewByFile[fileId];
      if (!preview) return response({ ok: false, code: 'HANDOFF_FILE_NOT_FOUND', error: '文件不在本次交接回执中' }, 404);
      return response({ ok: true, preview });
    },
  };
}

function previewOf(fileId, { text = PREVIEW_TEXT, html = PREVIEW_HTML, format = 'markdown', name = '报告.md', mime = 'text/markdown' } = {}) {
  return { fileId, name, mime, format, text, ...(html === undefined ? {} : { html }) };
}

async function openFirstFile(documentRef) {
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);
  const button = documentRef.body.querySelectorAll('.handoff-receipt-file')[0];
  button.dispatchEvent({ type: 'click' });
  return button;
}

function fileButton(documentRef, fileId) {
  return documentRef.body.querySelectorAll('.handoff-receipt-file')
    .find(button => button.getAttribute('data-file-id') === fileId);
}

function previewShown(documentRef) {
  return documentRef.body.querySelector('.handoff-file-preview')?.style.display === 'block';
}

test('closing the preview discards a pending file request without killing the binding', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const gates = { sf_report_1: deferred(), sf_archive_1: deferred() };
  gates.sf_report_1.resolve();
  const recorder = previewRecorder({
    previewHttp: fileId => gates[fileId].promise.then(() => response({
      ok: true,
      preview: previewOf(fileId, { name: fileId === 'sf_report_1' ? '报告.md' : 'handoff.md', text: `${fileId} 正文` }),
    })),
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  fileButton(documentRef, 'sf_report_1').dispatchEvent({ type: 'click' });
  await waitFor(() => previewShown(documentRef));

  // 文件 2 挂起时关闭旧预览
  fileButton(documentRef, 'sf_archive_1').dispatchEvent({ type: 'click' });
  await waitFor(() => recorder.calls.length === 3);
  documentRef.body.querySelector('.handoff-file-preview-close').dispatchEvent({ type: 'click' });
  assert.equal(previewShown(documentRef), false);
  assert.equal(fileButton(documentRef, 'sf_archive_1').disabled, false, '关闭后必须恢复按钮');

  gates.sf_archive_1.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(previewShown(documentRef), false, '关闭后迟到的文件 2 不得重新打开预览');
  assert.equal(documentRef.body.textContent.includes('sf_archive_1 正文'), false);

  // 同一绑定下仍可正常再次打开（不得因为关闭而使按钮永久失效）
  fileButton(documentRef, 'sf_archive_1').dispatchEvent({ type: 'click' });
  await waitFor(() => previewShown(documentRef));
  assert.equal(documentRef.body.querySelector('.handoff-file-preview-name').textContent, 'handoff.md');
  assert.equal(documentRef.body.querySelector('.handoff-file-preview-text').textContent, 'sf_archive_1 正文');
  card.dispose();
});

test('a late file failure after closing the preview cannot write status or re-open it', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const pending = deferred();
  const recorder = previewRecorder({
    previewHttp: fileId => (fileId === 'sf_report_1'
      ? Promise.resolve(response({ ok: true, preview: previewOf(fileId) }))
      : pending.promise.then(() => response({ ok: false, code: 'HANDOFF_FILE_UNAVAILABLE', error: '文件暂时无法预览' }, 409))),
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  fileButton(documentRef, 'sf_report_1').dispatchEvent({ type: 'click' });
  await waitFor(() => previewShown(documentRef));
  fileButton(documentRef, 'sf_archive_1').dispatchEvent({ type: 'click' });
  await waitFor(() => recorder.calls.length === 3);

  documentRef.body.querySelector('.handoff-file-preview-close').dispatchEvent({ type: 'click' });
  pending.resolve();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(previewShown(documentRef), false);
  assert.equal(documentRef.body.querySelector('.handoff-file-status').textContent, '', '关闭后的迟到错误不得写状态');
  assert.equal(documentRef.body.querySelector('.handoff-receipt-status').textContent, '', '不得污染主收据状态');
  assert.match(documentRef.body.querySelector('.handoff-receipt-transcript').textContent, /交接正文/);
  card.dispose();
});

test('a markdown file opens in-card from the preview route while the host file registry stays untouched', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const recorder = previewRecorder({ previewByFile: { sf_report_1: previewOf('sf_report_1') } });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  await openFirstFile(documentRef);
  await waitFor(() => documentRef.body.querySelector('.handoff-file-preview-frame')?.srcdoc !== undefined);

  assert.equal(recorder.calls.length, 2, '收据 + 一次文件预览请求');
  assert.equal(recorder.calls[1].path, `/api/handoff/sessions/${SESSION_A}/files/sf_report_1/preview`);
  assert.equal(hana.resourceCalls.length, 0, 'MD 预览不得依赖宿主 resources.open');

  const frame = documentRef.body.querySelector('.handoff-file-preview-frame');
  assert.equal(frame.getAttribute('sandbox'), '', 'Markdown iframe 必须是空 sandbox');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.ok(frame.srcdoc.includes('default-src \'none\''), 'iframe 必须带严格 CSP');
  assert.ok(frame.srcdoc.includes(PREVIEW_HTML));

  // 完整原文可切换查看
  const toggle = documentRef.body.querySelector('.handoff-file-preview-toggle');
  toggle.dispatchEvent({ type: 'click' });
  const text = documentRef.body.querySelector('.handoff-file-preview-text');
  assert.equal(text.textContent, PREVIEW_TEXT);
  assert.equal(frame.style.display, 'none');
  toggle.dispatchEvent({ type: 'click' });
  assert.notEqual(frame.style.display, 'none');

  // 关闭后预览区隐藏，收据正文不受影响
  documentRef.body.querySelector('.handoff-file-preview-close').dispatchEvent({ type: 'click' });
  assert.equal(documentRef.body.querySelector('.handoff-file-preview').style.display, 'none');
  assert.equal(documentRef.body.querySelector('.handoff-receipt-transcript').textContent, RECEIPT.transcript);
  card.dispose();
});

test('only one file preview runs at a time and the buttons are disabled while loading', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const gate = deferred();
  const recorder = previewRecorder({
    previewHttp: fileId => gate.promise.then(() => response({ ok: true, preview: previewOf(fileId) })),
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  const button = await openFirstFile(documentRef);
  await waitFor(() => recorder.calls.length === 2);
  assert.equal(button.disabled, true, '加载中必须禁用文件按钮');
  button.dispatchEvent({ type: 'click' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorder.calls.length, 2, '加载中再次点击不得发第二个请求');

  gate.resolve();
  await waitFor(() => button.disabled === false);
  card.dispose();
});

test('a late file response after rebinding cannot open a preview or leak into the new card', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const gate = deferred();
  const recorder = previewRecorder({
    receipts: {
      [SESSION_A]: RECEIPT,
      [SESSION_B]: { ...RECEIPT, sessionId: SESSION_B, transcript: 'B 会话正文', files: [] },
    },
    previewHttp: fileId => gate.promise.then(() => response({ ok: true, preview: previewOf(fileId) })),
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  await openFirstFile(documentRef);
  await waitFor(() => recorder.calls.length === 2);

  hana.emit({ slot: 'card', embeddedSessionId: SESSION_B });
  await waitFor(() => documentRef.body.textContent.includes('B 会话正文'));
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(documentRef.body.querySelector('.handoff-file-preview')?.style.display, 'none', '旧绑定响应不得重开预览');
  assert.equal(documentRef.body.textContent.includes('真实字节正文'), false);
  card.dispose();
});

test('a preview failure shows a fixed message and code without touching the receipt transcript', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const recorder = previewRecorder({
    previewHttp: () => response({ ok: false, code: 'HANDOFF_FILE_UNAVAILABLE', error: '文件内容暂时不可用' }, 409),
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  await openFirstFile(documentRef);
  await waitFor(() => /HANDOFF_FILE_UNAVAILABLE/.test(bodyText(documentRef)));
  assert.match(documentRef.body.textContent, /文件暂时无法预览|文件预览失败/);
  assert.equal(documentRef.body.textContent.includes('/home/'), false);
  assert.equal(documentRef.body.querySelector('.handoff-receipt-transcript').textContent, RECEIPT.transcript);
  assert.equal(documentRef.body.querySelector('.handoff-file-preview').style.display, 'none');
  card.dispose();
});

test('a non-text file keeps the official resources.open path and its opened check', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  hana.resources.open = async input => {
    hana.resourceCalls.push({ input, options: undefined });
    return { opened: false };
  };
  const receipt = {
    ...RECEIPT,
    files: [{ fileId: 'sf_pdf_1', name: 'report.pdf', mime: 'application/pdf', kind: 'artifact' }],
  };
  const recorder = previewRecorder({ receipt });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 1);
  documentRef.body.querySelectorAll('.handoff-receipt-file')[0].dispatchEvent({ type: 'click' });
  await waitFor(() => hana.resourceCalls.length === 1);
  assert.deepEqual(hana.resourceCalls[0].input, {
    resource: { kind: 'session-file', sessionId: SESSION_A, fileId: 'sf_pdf_1' },
    mode: 'preview',
  });
  await waitFor(() => /无法打开/.test(documentRef.body.textContent));
  assert.equal(recorder.calls.length, 1, '非文本不得请求应用预览接口');
  card.dispose();
});

test('closing the preview and disposing invalidate pending file responses', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const gate = deferred();
  const recorder = previewRecorder({
    previewHttp: fileId => gate.promise.then(() => response({ ok: true, preview: previewOf(fileId) })),
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });

  await openFirstFile(documentRef);
  await waitFor(() => recorder.calls.length === 2);
  card.dispose();
  gate.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(documentRef.body.children.length, 0);
});

test('native files share the single-request gate and report failures only in the file status line', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const gate = deferred();
  hana.resources.open = input => {
    hana.resourceCalls.push({ input, options: undefined });
    return gate.promise;
  };
  const recorder = previewRecorder({ receipt: PDF_RECEIPT });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  fileButton(documentRef, 'sf_pdf_1').dispatchEvent({ type: 'click' });
  await waitFor(() => hana.resourceCalls.length === 1);
  assert.equal(fileButton(documentRef, 'sf_pdf_2').disabled, true, 'Native 请求也必须禁用其它文件按钮');
  fileButton(documentRef, 'sf_pdf_2').dispatchEvent({ type: 'click' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hana.resourceCalls.length, 1, '一次只允许一个文件请求');
  assert.equal(recorder.calls.length, 1, 'Native 不得请求文本预览接口');

  // 宿主没打开：只写文件状态行，不动主收据状态
  gate.resolve({ opened: false });
  await waitFor(() => /无法打开/.test(documentRef.body.querySelector('.handoff-file-status').textContent));
  assert.match(documentRef.body.querySelector('.handoff-file-status').textContent, /HANDOFF_FILE_UNAVAILABLE/);
  assert.equal(documentRef.body.querySelector('.handoff-receipt-status').textContent, '', '文件错误不得写主收据状态');
  assert.equal(fileButton(documentRef, 'sf_pdf_1').disabled, false, '结束（失败）后释放按钮');

  // 释放后可以再试；新调用成功就不留旧错误
  hana.resources.open = async input => {
    hana.resourceCalls.push({ input, options: undefined });
    return { opened: true };
  };
  fileButton(documentRef, 'sf_pdf_2').dispatchEvent({ type: 'click' });
  await waitFor(() => fileButton(documentRef, 'sf_pdf_2').disabled === false);
  assert.equal(documentRef.body.querySelector('.handoff-file-status').textContent, '');
  assert.equal(hana.resourceCalls.length, 2);
  card.dispose();
});

test('a stale native failure after a newer request cannot overwrite the current file status', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  const first = deferred();
  hana.resources.open = input => {
    hana.resourceCalls.push({ input, options: undefined });
    return first.promise;
  };
  const recorder = previewRecorder({
    receipts: {
      [SESSION_A]: PDF_RECEIPT,
      [SESSION_B]: { ...PDF_RECEIPT, sessionId: SESSION_B, transcript: 'B 会话正文', files: [] },
    },
  });
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  fileButton(documentRef, 'sf_pdf_1').dispatchEvent({ type: 'click' });
  await waitFor(() => hana.resourceCalls.length === 1);

  // 旧绑定的 Native 失败不得写新卡状态
  hana.emit({ slot: 'card', embeddedSessionId: SESSION_B });
  await waitFor(() => documentRef.body.textContent.includes('B 会话正文'));
  first.reject(new Error('EACCES /home/private/handoff.pdf'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(documentRef.body.querySelector('.handoff-file-status').textContent, '', '旧绑定失败不得写新卡的文件状态');
  assert.equal(documentRef.body.querySelector('.handoff-receipt-status').textContent, '');
  assert.equal(documentRef.body.textContent.includes('/home/private'), false);
  card.dispose();
});

// ---------------------------------------------------------------------------
// 清单映射：没有 messageRenderers，宿主不会为这条 custom 消息生成流内卡
// ---------------------------------------------------------------------------

test('the manifest maps branch-handoff to a declared card whose route page exists', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'manifest.json'), 'utf8'));
  const renderers = Array.isArray(manifest.contributes?.messageRenderers) ? manifest.contributes.messageRenderers : [];
  const renderer = renderers.find(item => item.customType === 'branch-handoff');
  assert.ok(renderer, '必须声明 branch-handoff 的 messageRenderers 映射，否则 Chat 不产生流内卡');

  const cards = Array.isArray(manifest.contributes?.cards) ? manifest.contributes.cards : [];
  const card = cards.find(item => item.id === renderer.cardId);
  assert.ok(card, '映射必须指向本应用已声明的卡');
  assert.equal(card.route, '/handoff-receipt.html', '映射目标卡必须带 route');

  const page = await fs.readFile(path.join(repoRoot, 'ui', 'handoff-receipt.html'), 'utf8');
  assert.match(page, /assets\/handoff-receipt-boot\.js/, '卡页面必须加载自己的轻量启动脚本');
  assert.equal(page.includes('panel.html'), false, '交接卡不得加载完整画布');

  // 官方 APPS.md：resources.open/pick/requestAccess 共用 app/resources.read
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  assert.ok(capabilities.includes('app/resources.read'), '预览会话文件必须声明只读资源能力');
  assert.ok(capabilities.includes('app/resources.write'));
  assert.equal(capabilities.length, 13, '只新增预览必需的只读资源能力');

  assert.equal(manifest.version, '2.5.2');
  assert.equal(manifest.minAppVersion, '1.2.1-beta');
});
