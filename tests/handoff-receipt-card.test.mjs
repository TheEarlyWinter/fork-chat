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
  for (const context of [null, { slot: 'card', cardInstanceId: 'card-1', appId: 'timeline-reverser' }, { slot: 'card', embeddedSessionId: '' }]) {
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
  const hana = fakeHana({ slot: 'card', cardInstanceId: 'card-1', appId: 'timeline-reverser', embeddedSessionId: SESSION_A });
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
  assert.deepEqual(hana.resourceCalls, [{
    input: { resource: { kind: 'session-file', sessionId: SESSION_A, fileId: 'sf_report_1' }, mode: 'preview' },
    options: undefined,
  }]);
  card.dispose();
});

test('a refused preview reports a fixed short error instead of looking opened', async () => {
  const documentRef = createFakeDocument();
  const hana = fakeHana({ slot: 'card', embeddedSessionId: SESSION_A });
  hana.resources.open = async input => {
    hana.resourceCalls.push({ input, options: undefined });
    return { opened: false };
  };
  const recorder = requestRecorder();
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  documentRef.body.querySelectorAll('.handoff-receipt-file')[0].dispatchEvent({ type: 'click' });
  await waitFor(() => /无法打开|未打开|失败/.test(documentRef.body.querySelector('.handoff-receipt-status').textContent));
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
    if (path.includes(SESSION_A)) return response({ ok: true, receipt: RECEIPT });
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
  const recorder = requestRecorder();
  const card = createHandoffReceiptCard({ hana, documentRef, requestHost: recorder.requestHost });
  await waitFor(() => documentRef.body.querySelectorAll('.handoff-receipt-file').length === 2);

  documentRef.body.querySelectorAll('.handoff-receipt-file')[0].dispatchEvent({ type: 'click' });
  await waitFor(() => hana.resourceCalls.length === 1);
  const status = documentRef.body.querySelector('.handoff-receipt-status');
  card.dispose();
  preview.reject(new Error('EACCES'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(status.textContent, '', 'dispose 后的失败不得改写已卸载的状态栏');
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

  assert.equal(manifest.version, '2.3.0-beta.4');
  assert.equal(manifest.minAppVersion, '1.2.1-beta');
});
