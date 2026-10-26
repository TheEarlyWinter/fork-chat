import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/usr/bin/google-chrome';

function runChromeRenderReadyInspection() {
  const tmpDir = mkdtempSync(join(tmpdir(), 'chrome-render-ready-'));
  const htmlPath = join(tmpDir, 'test.html');

  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    .chat-card { position: absolute; }
    .card-input:disabled { opacity: 0.5; }
  </style>
</head>
<body>
  <div id="cards-layer"></div>
  <script type="module">
    import { createRenderer } from '${ROOT}/ui/assets/panel-renderer.js';
    import { cardContentSignature, canReuseCardElement } from '${ROOT}/ui/assets/panel-render-diff.js';
    import { buildCardHtml, getCardDraft, setCardDraft } from '${ROOT}/ui/assets/panel-cards.js';
    import { computeVisibleCards, collectSubtreeCardIds } from '${ROOT}/ui/assets/panel-layout.js';
    import { cardParentIds } from '${ROOT}/ui/assets/panel-context.js';
    import { escapeHtml, formatFileSize } from '${ROOT}/ui/assets/panel-format.js';
    import { statusText, messageMarkup } from '${ROOT}/ui/assets/panel-messages.js';

    const cardsLayer = document.getElementById('cards-layer');
    const card = { id: 'card-1', title: '主卡片', x: 0, y: 0, width: 320, messages: [] };
    const cards = [card];
    const agent = { id: 'agent-1', name: '助手 1', model: 'm1' };

    let isDisposed = false;
    let sessionState = { ready: false, busy: true, error: null };
    const session = {
      get state() { return sessionState; }
    };

    const sentRequests = [];
    const cardCleanups = new Set();
    const activeRequests = new Set();

    function bindCardEvents(cardEl, c) {
      const inputEl = cardEl.querySelector('#input-' + c.id);
      const sendBtn = cardEl.querySelector('[data-action="send"]');
      if (inputEl) {
        inputEl.value = getCardDraft(c);
        inputEl.addEventListener('input', () => {
          setCardDraft(c, inputEl.value);
        });
      }
      if (sendBtn) {
        sendBtn.addEventListener('click', () => {
          if (isDisposed) return;
          if (inputEl && inputEl.disabled) return;
          if (sendBtn.disabled) return;
          const text = inputEl ? inputEl.value : '';
          if (!text.trim()) return;
          sentRequests.push({ cardId: c.id, text });
          inputEl.value = '';
          setCardDraft(c, '');
        });
      }
    }

    const renderer = createRenderer({
      documentRef: document,
      getCardsLayer: () => cardsLayer,
      getBadgeStats: () => null,
      getIsDisposed: () => isDisposed,
      getCards: () => cards,
      getSelectedCardId: () => card.id,
      getCurrentAgent: () => agent,
      getSession: () => session,
      getMultiSelectedCardIds: () => new Set(),
      activeRequests,
      chainIsBusy: () => isDisposed || !sessionState?.ready || Boolean(sessionState?.busy),
      drain: (cleanups) => { cleanups.clear(); },
      getCardCleanups: () => cardCleanups,
      computeVisibleCards,
      collectSubtreeCardIds,
      cardParentIds,
      buildCardHtml,
      escapeHtml,
      messageMarkup,
      statusText,
      cardContentSignature,
      canReuseCardElement,
      formatFileSize,
      bindCardEvents,
      renderConnectors: () => {},
    });

    const results = {};

    // 缺少会话控制器时也必须保持锁定，不能误用 HTML 构造器的默认 ready。
    sessionState = undefined;
    renderer.renderCards();
    results.missingSessionInputDisabled = document.getElementById('input-card-1')?.disabled;
    sessionState = { ready: false, busy: true, error: null };

    // 1. Boot 阶段 (ready=false, busy=true)
    renderer.renderCards();
    const bootCardEl = document.getElementById('dom-card-1');
    const bootInput = document.getElementById('input-card-1');
    const bootSendBtn = bootCardEl ? bootCardEl.querySelector('[data-action="send"]') : null;

    results.bootInputDisabled = bootInput ? bootInput.disabled : null;
    results.bootSendDisabled = bootSendBtn ? bootSendBtn.disabled : null;
    if (bootInput) {
      bootInput.focus();
      results.bootCanFocus = (document.activeElement === bootInput);
    }
    if (bootSendBtn) {
      bootSendBtn.click();
      results.bootSentCount = sentRequests.length;
    }

    // 2. Ready 阶段 (ready=true, busy=false)
    sessionState = { ready: true, busy: false, error: null };
    renderer.renderCards();
    const readyCardEl = document.getElementById('dom-card-1');
    const readyInput = document.getElementById('input-card-1');
    const readySendBtn = readyCardEl ? readyCardEl.querySelector('[data-action="send"]') : null;

    results.readyInputDisabled = readyInput ? readyInput.disabled : null;
    results.readySendDisabled = readySendBtn ? readySendBtn.disabled : null;
    if (readyInput) {
      readyInput.focus();
      results.readyCanFocus = (document.activeElement === readyInput);
      results.nativeTextInserted = document.execCommand('insertText', false, 'hello draft test');
      results.draftSavedToCard = card.draft;
    }

    // 同相位再次 render，验证维持 DOM 引用（轻量轨道），不靠每次清空卡片修问题
    renderer.renderCards();
    const readyCardEl2 = document.getElementById('dom-card-1');
    const readyInput2 = document.getElementById('input-card-1');
    results.samePhaseMaintainsDomIdentity = (readyCardEl === readyCardEl2);
    results.draftPreservedAcrossRerender = readyInput2 ? readyInput2.value : null;

    // 触发发送
    if (readySendBtn) {
      readySendBtn.click();
      results.readySentCount = sentRequests.length;
      results.readySentText = sentRequests[0]?.text;
    }

    // 3. Busy 阶段 (ready=true, busy=true)
    const currentInputBeforeBusy = document.getElementById('input-card-1');
    if (currentInputBeforeBusy) {
      currentInputBeforeBusy.value = 'busy draft';
      currentInputBeforeBusy.dispatchEvent(new Event('input', { bubbles: true }));
    }
    sessionState = { ready: true, busy: true, error: null };
    renderer.renderCards();
    const busyInput = document.getElementById('input-card-1');
    const busySendBtn = document.getElementById('dom-card-1')?.querySelector('[data-action="send"]');
    results.busyInputDisabled = busyInput ? busyInput.disabled : null;
    results.busySendDisabled = busySendBtn ? busySendBtn.disabled : null;
    if (busyInput) {
      busyInput.focus();
      results.busyCanFocus = (document.activeElement === busyInput);
    }
    if (busySendBtn) {
      busySendBtn.click();
      results.busySentCount = sentRequests.length;
    }

    // 4. 恢复 Ready 阶段 (ready=true, busy=false)
    sessionState = { ready: true, busy: false, error: null };
    renderer.renderCards();
    const recoveredInput = document.getElementById('input-card-1');
    const recoveredSendBtn = document.getElementById('dom-card-1')?.querySelector('[data-action="send"]');
    results.recoveredInputDisabled = recoveredInput ? recoveredInput.disabled : null;
    results.recoveredSendDisabled = recoveredSendBtn ? recoveredSendBtn.disabled : null;
    results.recoveredDraftPreserved = recoveredInput ? recoveredInput.value : null;
    if (recoveredSendBtn) {
      recoveredSendBtn.click();
      results.recoveredSentCount = sentRequests.length;
      results.recoveredSentText = sentRequests[1]?.text;
    }

    // 5. 恢复失败/错误阶段 (ready=false, error="save failed")
    sessionState = { ready: false, busy: false, error: 'save failed' };
    renderer.renderCards();
    const errorInput = document.getElementById('input-card-1');
    results.errorInputDisabled = errorInput ? errorInput.disabled : null;
    results.errorSendDisabled = document.querySelector('[data-action="send"]')?.disabled;

    // 6. 销毁阶段 (isDisposed=true)
    isDisposed = true;
    const disposedSendBtn = document.getElementById('dom-card-1')?.querySelector('[data-action="send"]');
    if (disposedSendBtn) {
      disposedSendBtn.click();
      results.disposedSentCount = sentRequests.length;
    }

    document.body.setAttribute('data-inspect-result', JSON.stringify(results));
  </script>
</body>
</html>`;

  writeFileSync(htmlPath, htmlContent, 'utf8');

  const userDataDir = mkdtempSync(join(tmpdir(), 'chrome-render-profile-'));

  try {
    const dumpedHtml = execFileSync(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--allow-file-access-from-files',
      `--user-data-dir=${userDataDir}`,
      '--dump-dom',
      htmlPath,
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000 });

    const resultMatch = dumpedHtml.match(/data-inspect-result=["']([^"']+)["']/);
    if (!resultMatch) {
      throw new Error(`Chrome 未能返回评估结果: ${dumpedHtml.slice(0, 300)}`);
    }
    const unescaped = resultMatch[1].replace(/&quot;/g, '"');
    return JSON.parse(unescaped);
  } finally {
    rmSync(htmlPath, { force: true });
    // 浏览器临时配置目录交由系统临时目录清理，不在测试中递归删除目录。
  }
}

test('real Chrome DOM: boot 锁定无法聚焦/发送，就绪后解除禁用并可输入发送，忙态/错误态重新锁定，同相位保持 DOM identity 与草稿', () => {
  const result = runChromeRenderReadyInspection();

  assert.equal(result.missingSessionInputDisabled, true, '缺少会话状态时也必须禁止输入');
  // 1. Boot 阶段断言
  assert.equal(result.bootInputDisabled, true, 'Boot 阶段 input 必须是 disabled');
  assert.equal(result.bootSendDisabled, true, 'Boot 阶段发送按钮必须禁用');
  assert.equal(result.bootCanFocus, false, 'Boot 阶段 input 无法获得焦点');
  assert.equal(result.bootSentCount, 0, 'Boot 阶段点击发送不能产生任何请求');

  // 2. Ready 阶段断言
  assert.equal(result.readyInputDisabled, false, 'Ready 阶段 input 必须解除禁用 (disabled=false)');
  assert.equal(result.readySendDisabled, false, 'Ready 阶段发送按钮必须解除禁用');
  assert.equal(result.nativeTextInserted, true, '浏览器原生编辑必须能插入文本，不只依赖赋值与合成事件');
  assert.equal(result.readyCanFocus, true, 'Ready 阶段 input 能够正常聚焦');
  assert.equal(result.draftSavedToCard, 'hello draft test', '输入内容能同步到 card.draft');

  // 同相位复用与草稿
  assert.equal(result.samePhaseMaintainsDomIdentity, true, '相同 ready 相位再次 render 必须复用 DOM 保持元素一致');
  assert.equal(result.draftPreservedAcrossRerender, 'hello draft test', '相同相位下草稿完整保留');
  assert.equal(result.readySentCount, 1, 'Ready 阶段点击发送成功发送 1 次');
  assert.equal(result.readySentText, 'hello draft test');

  // 3. Busy 阶段断言
  assert.equal(result.busyInputDisabled, true, '忙态阶段 input 必须锁定为 disabled');
  assert.equal(result.busySendDisabled, true, '忙态发送按钮必须禁用');
  assert.equal(result.busyCanFocus, false, '忙态阶段无法聚焦');
  assert.equal(result.busySentCount, 1, '忙态下点击发送不得产生新请求');

  // 4. 恢复 Ready 阶段断言
  assert.equal(result.recoveredInputDisabled, false, '恢复就绪后 input 重新可用');
  assert.equal(result.recoveredSendDisabled, false, '恢复就绪后发送按钮重新可用');
  assert.equal(result.recoveredDraftPreserved, 'busy draft', '恢复就绪后在忙态输入的草稿完整保留');
  assert.equal(result.recoveredSentCount, 2, '恢复就绪后发送成功');
  assert.equal(result.recoveredSentText, 'busy draft');

  // 5. 错误与销毁断言
  assert.equal(result.errorInputDisabled, true, '错误态下 input 必须锁定为 disabled');
  assert.equal(result.errorSendDisabled, true, '恢复失败时发送按钮必须禁用');
  assert.equal(result.disposedSentCount, 2, '销毁后点击不得产生新发送');
});
