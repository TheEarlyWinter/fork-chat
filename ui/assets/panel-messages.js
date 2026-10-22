import { parseAssistantOutput } from './assistant-output.js';
import { formatFileSize, escapeHtml } from './panel-format.js';

/**
 * 消息投影与状态格式化纯函数模块。
 *
 * 负责状态文字、助手输出投影、沉思/心境旁白文案以及消息气泡 HTML 标记生成。
 * 纯函数无副作用，DOM 绘制通过 createMessagePainter 工厂函数依赖注入。
 * 严禁在顶层访问 window 或 document。
 */

export function statusText(message) {
  if (!message || !message.requestId) return '';
  const labels = {
    waiting: message.waitingLong ? '仍在等待模型响应，可取消' : '等待模型响应…',
    generating: '生成中…',
    completed: '已完成',
    cancelled: '已停止接收',
    failed: '失败',
  };
  const error = message.error ? ` · ${message.error}` : '';
  const cancellation = message.cancelConfirmed === false && ['cancelled', 'failed'].includes(message.status)
    ? ` · 服务端取消未确认${message.cancelError ? `：${message.cancelError}` : ''}`
    : '';
  return `${labels[message.status] || '等待'}${error}${cancellation} · ${message.requestId}${message.modelRef ? ` · ${message.modelRef}` : ''}`;
}

// message.text remains the raw model reply, including explicit mood tags.
// Presentation is a projection only: never execute generated HTML or rewrite personas.
export function outputFor(message) {
  if (!message) return { body: '', blocks: [] };
  return message.role === 'assistant' && !message.localOnly
    ? parseAssistantOutput(message.text || '', { streaming: Boolean(message.streaming) })
    : { body: message.text || '', blocks: [] };
}

export function asidesText(output, message) {
  if (!output || !Array.isArray(output.blocks)) return '';
  return output.blocks.map(block => {
    const label = { mood: '心境', pulse: '心绪', reflect: '沉思' }[block.type] || '心境';
    const state = block.closed ? '' : message && message.streaming ? ' · 生成中' : ' · 未闭合';
    return `${label}${state}\n${block.text}`;
  }).join('\n\n');
}

export function messageMarkup(message) {
  if (!message) return '';
  const output = outputFor(message);
  const replyId = message.requestId ? `id="reply-${message.requestId}"` : '';
  const bubble = `<div class="msg-bubble" ${replyId} ${output.body.trim() ? '' : 'hidden'}>${escapeHtml(output.body)}</div>`;
  const docPreviewHtml = message.docPreview ? `
    <details class="doc-content-preview">
      <summary>查看文档内容提取预览 (${message.docMeta?.lineCount || 0} 行 · ${message.docMeta?.charCount || 0} 字)</summary>
      <pre class="doc-content-body">${escapeHtml(message.docPreview)}</pre>
    </details>
  ` : '';
  const attachmentsHtml = Array.isArray(message.attachments) && message.attachments.length > 0 ? `
    <div class="msg-attachments-list">
      ${message.attachments.map(att => `
        <details class="msg-attachment-item">
          <summary class="msg-attachment-header">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
            <span class="msg-attachment-name">${escapeHtml(att.name)}</span>
            <span class="msg-attachment-meta">${formatFileSize(att.size)} · ${att.charCount || 0} 字</span>
          </summary>
          <pre class="msg-attachment-preview">${escapeHtml(att.preview || att.content?.slice(0, 1500) || '')}</pre>
        </details>
      `).join('')}
    </div>
  ` : '';
  if (!message.requestId || message.role !== 'assistant') return `${attachmentsHtml}${bubble}${docPreviewHtml}`;
  return `${attachmentsHtml}${bubble}${docPreviewHtml}
    <details class="assistant-asides" id="asides-${message.requestId}" ${message.asidesOpen ? 'open' : ''} ${output.blocks.length ? '' : 'hidden'}>
      <summary id="asides-toggle-${message.requestId}">心境 / 沉思</summary>
      <div class="assistant-asides-text" id="asides-text-${message.requestId}">${escapeHtml(asidesText(output, message))}</div>
    </details>`;
}

export function createMessagePainter({ documentRef, isDisposed }) {
  function paintMessage(message) {
    const disposed = typeof isDisposed === 'function' ? isDisposed() : Boolean(isDisposed);
    if (disposed || !message || !message.requestId) return;
    const doc = typeof documentRef === 'function' ? documentRef() : (documentRef || (typeof document !== 'undefined' ? document : null));
    if (!doc) return;
    const output = outputFor(message);
    const bubble = doc.getElementById(`reply-${message.requestId}`);
    if (bubble) { bubble.textContent = output.body; bubble.hidden = !output.body.trim(); }
    const asides = doc.getElementById(`asides-${message.requestId}`);
    if (asides) asides.hidden = output.blocks.length === 0;
    const asideText = doc.getElementById(`asides-text-${message.requestId}`);
    if (asideText) asideText.textContent = asidesText(output, message);
    const status = doc.getElementById(`status-${message.requestId}`);
    if (status) status.textContent = statusText(message);
  }
  paintMessage.paintMessage = paintMessage;
  return paintMessage;
}
