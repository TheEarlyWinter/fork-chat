/**
 * 交接卡的只读前端：只认宿主盖戳的 embeddedSessionId，不借 URL、全局焦点、
 * getActive 或 originSessionId 猜会话。正文以文本节点显示（不注入 HTML），
 * Markdown/纯文本文件按需读应用自己的只读预览接口并在卡内显示，其它文件入口
 * 继续走正式 resources.open 的 session-file 预览。
 *
 * 没有绑定就明确不可用且不发请求；绑定变化立即清空旧内容，迟到响应直接丢弃。
 * 每张卡同时只发一个文件请求；这里没有业务写、没有模型调用、也没有轮询。
 */
import { safeDetail } from './host-api.js';
import { createFilePreviewView } from './handoff-file-preview.js';

const STATUS_IDLE = '';
const PREVIEW_FAILED = '文件无法打开，请稍后重试。';
const FILE_PREVIEW_FAILED = '文件暂时无法预览';
const TEXT_MIMES = new Set(['text/markdown', 'text/plain']);

function isTextFile(file) {
  if (typeof file?.mime !== 'string') return false;
  return TEXT_MIMES.has(file.mime.split(';')[0].trim().toLowerCase());
}

function createEl(documentRef, tag, className, textValue) {
  const el = documentRef.createElement(tag);
  if (className) el.className = className;
  if (textValue !== undefined) el.textContent = textValue;
  return el;
}

function errorText(error) {
  const status = typeof error?.status === 'number' ? `HTTP ${error.status}` : '';
  const message = safeDetail(error?.message || '');
  return ['无法读取交接记录', status, message].filter(Boolean).join(' — ');
}

export function createHandoffReceiptCard({ hana, documentRef, requestHost } = {}) {
  if (!hana || typeof hana !== 'object') throw new TypeError('createHandoffReceiptCard 需要宿主 hana');
  if (!documentRef || typeof documentRef.createElement !== 'function') {
    throw new TypeError('createHandoffReceiptCard 需要 document');
  }
  if (typeof requestHost !== 'function') throw new TypeError('createHandoffReceiptCard 需要已鉴权 requestHost');

  const root = createEl(documentRef, 'div', 'handoff-receipt');
  root.id = 'handoff-receipt-root';
  const title = createEl(documentRef, 'div', 'handoff-receipt-title', '交接记录');
  const meta = createEl(documentRef, 'div', 'handoff-receipt-meta');
  const status = createEl(documentRef, 'div', 'handoff-receipt-status');
  status.id = 'handoff-receipt-status';
  status.setAttribute('role', 'status');
  const transcript = createEl(documentRef, 'pre', 'handoff-receipt-transcript');
  transcript.id = 'handoff-receipt-transcript';
  const fileSection = createEl(documentRef, 'div', 'handoff-receipt-files');
  const fileStatus = createEl(documentRef, 'div', 'handoff-file-status');
  fileStatus.setAttribute('role', 'status');
  // 用户关闭预览时让该卡已合并中的文件请求失效；不碰绑定 generation
  const previewView = createFilePreviewView({ documentRef, onUserClose: () => invalidateFileRequest() });
  root.appendChild(title);
  root.appendChild(meta);
  root.appendChild(status);
  root.appendChild(transcript);
  root.appendChild(fileSection);
  root.appendChild(fileStatus);
  root.appendChild(previewView.root);
  documentRef.body.appendChild(root);

  let sessionId;
  let generation = 0;
  let disposed = false;
  // 文件请求自己的代号与 busy：与绑定代号无关，关闭预览/换绑定/卸载均使它失效
  let fileToken = 0;
  let fileBusy = false;

  function setStatus(value) {
    status.textContent = value || STATUS_IDLE;
    status.style.display = value ? 'block' : 'none';
  }

  function setFileStatus(value) {
    fileStatus.textContent = value || STATUS_IDLE;
    fileStatus.style.display = value ? 'block' : 'none';
  }

  function setFileButtonsDisabled(disabled) {
    for (const child of fileSection.children) child.disabled = disabled;
  }

  /** 开始一次文件请求；已有在进行中就拒绝（返回 null） */
  function beginFileRequest() {
    if (fileBusy || disposed) return null;
    fileBusy = true;
    fileToken += 1;
    setFileButtonsDisabled(true);
    setFileStatus('');
    return fileToken;
  }

  function isCurrentFileRequest(token) {
    return !disposed && token === fileToken;
  }

  function finishFileRequest(token) {
    if (!isCurrentFileRequest(token)) return;
    fileBusy = false;
    setFileButtonsDisabled(false);
  }

  /** 关闭预览/换绑定/卸载：旧请求的内容、错误与 finally 写入全部作废 */
  function invalidateFileRequest() {
    fileToken += 1;
    fileBusy = false;
    setFileButtonsDisabled(false);
    setFileStatus('');
  }

  function clearContent() {
    transcript.textContent = '';
    meta.textContent = '';
    // 文件按钮属于上一条绑定：绑定一变就整批移除，避免旧 fileId 被点开
    while (fileSection.children.length > 0) fileSection.removeChild(fileSection.children[0]);
    invalidateFileRequest();
    previewView.close();
    setStatus('');
  }

  async function openFile(token, receiptSessionId, file) {
    const requestToken = beginFileRequest();
    if (requestToken === null) return;
    let opened = false;
    try {
      const receipt = await hana.resources.open({
        resource: { kind: 'session-file', sessionId: receiptSessionId, fileId: file.fileId },
        mode: 'preview',
      });
      // 宿主可以“没抛错但也没打开”：不把未打开当成功
      opened = receipt?.opened === true;
    } catch {
      opened = false;
    } finally {
      // 旧绑定/已关闭/已卸载的迟到结果一律丢弃，不写任何状态
      if (token === generation && isCurrentFileRequest(requestToken) && !opened) {
        setFileStatus(`${PREVIEW_FAILED}（HANDOFF_FILE_UNAVAILABLE）`);
      }
      finishFileRequest(requestToken);
    }
  }

  async function openTextPreview(token, receiptSessionId, file) {
    const requestToken = beginFileRequest();
    if (requestToken === null) return;
    try {
      const response = await requestHost(
        hana,
        `/api/handoff/sessions/${encodeURIComponent(receiptSessionId)}/files/${encodeURIComponent(file.fileId)}/preview`,
        { method: 'GET' },
      );
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      // 旧绑定/已关闭/已卸载的迟到响应一律丢弃，不重开预览
      if (token !== generation || !isCurrentFileRequest(requestToken)) return;
      if (response.ok === false || body?.ok !== true || !body.preview) {
        const code = typeof body?.code === 'string' ? body.code : 'HANDOFF_FILE_PREVIEW_FAILED';
        setFileStatus(`${FILE_PREVIEW_FAILED}（${code}）`);
        return;
      }
      setFileStatus('');
      previewView.open(body.preview);
    } catch {
      if (token === generation && isCurrentFileRequest(requestToken)) {
        setFileStatus(`${FILE_PREVIEW_FAILED}（HANDOFF_FILE_PREVIEW_FAILED）`);
      }
    } finally {
      finishFileRequest(requestToken);
    }
  }

  function render(receipt) {
    const files = Array.isArray(receipt.files) ? receipt.files : [];
    const actionLabel = typeof receipt.actionId === 'string' && receipt.actionId ? receipt.actionId : '未记录动作标识';
    meta.textContent = `会话 ${receipt.sessionId} · 动作 ${actionLabel} · 助手 ${receipt.agentId || '未知'} · ${files.length} 个交付文件`;
    transcript.textContent = receipt.transcript;
    for (const file of files) {
      const button = createEl(documentRef, 'button', 'handoff-receipt-file', file.name);
      button.type = 'button';
      button.setAttribute('data-file-id', file.fileId);
      // 按钮绑定自己的代号：切换会话后旧按钮不得再打开旧会话的文件
      const token = generation;
      button.addEventListener('click', () => {
        if (token !== generation || disposed) return;
        if (isTextFile(file)) void openTextPreview(token, receipt.sessionId, file);
        else void openFile(token, receipt.sessionId, file);
      });
      fileSection.appendChild(button);
    }
  }

  async function load(token, target) {
    setStatus('正在读取交接记录…');
    let response;
    try {
      response = await requestHost(hana, `/api/handoff/sessions/${encodeURIComponent(target)}/receipt`, { method: 'GET' });
    } catch (error) {
      if (token === generation && !disposed) setStatus(errorText(error));
      return;
    }
    if (token !== generation || disposed) return;
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (token !== generation || disposed) return;
    if (response.ok === false || body?.ok !== true || !body.receipt) {
      const code = typeof body?.code === 'string' ? body.code : '';
      const message = typeof body?.error === 'string' ? body.error : '';
      setStatus(['无法显示交接记录', code, safeDetail(message)].filter(Boolean).join(' — '));
      return;
    }
    setStatus('');
    render(body.receipt);
  }

  function applyContext(context) {
    if (disposed) return;
    const next = typeof context?.embeddedSessionId === 'string' && context.embeddedSessionId.trim()
      ? context.embeddedSessionId.trim()
      : null;
    if (next === sessionId) return;
    sessionId = next;
    // 每次绑定变化都推进代号：之前发出的响应即使回来也已失效
    generation += 1;
    clearContent();
    if (!sessionId) {
      setStatus('无法确定当前会话，交接记录暂不可用。');
      return;
    }
    void load(generation, sessionId);
  }

  let unsubscribe = null;
  if (typeof hana.surface?.onContextChanged === 'function') {
    unsubscribe = hana.surface.onContextChanged(applyContext);
  } else {
    applyContext(typeof hana.surface?.getContext === 'function' ? hana.surface.getContext() : null);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    try {
      unsubscribe?.();
    } catch {
      // 卸载阶段的取消失败不影响页面销毁
    }
    unsubscribe = null;
    invalidateFileRequest();
    previewView.dispose();
    root.remove();
  }

  return { dispose };
}
