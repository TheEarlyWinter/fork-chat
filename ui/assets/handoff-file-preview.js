/**
 * 交接卡里的小型只读文件预览区：Markdown 用空 sandbox + 严格 CSP 的 iframe，
 * 纯文本用 textContent 的 <pre>。不引用任何外部资源，不加载完整画布或文档查看器。
 *
 * 显示/隐藏与内容都只由调用方当前绑定决定：调用方在关闭、换绑定或卸载时必须
 * 调用 close()/dispose()，这里不自己发请求、不缓存文件内容。
 */
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'";
const PREVIEW_STYLE = 'body{margin:0;padding:4px 2px;font-family:system-ui,sans-serif;line-height:1.7;font-size:14px;color:#202020;overflow-wrap:anywhere}'
  + 'h1{font-size:20px}h2{font-size:18px}h3{font-size:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:10px;border-radius:6px}'
  + 'table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:6px;text-align:left}code{background:#f0f0f0;padding:1px 3px;border-radius:3px}';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function markdownDocument(name, html) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escapeHtml(name)}</title><style>${PREVIEW_STYLE}</style></head>`
    + `<body>${html}</body></html>`;
}

function createEl(documentRef, tag, className, textValue) {
  const el = documentRef.createElement(tag);
  if (className) el.className = className;
  if (textValue !== undefined) el.textContent = textValue;
  return el;
}

export function createFilePreviewView({ documentRef } = {}) {
  if (!documentRef || typeof documentRef.createElement !== 'function') {
    throw new TypeError('createFilePreviewView 需要 document');
  }

  const root = createEl(documentRef, 'div', 'handoff-file-preview');
  root.style.display = 'none';
  const head = createEl(documentRef, 'div', 'handoff-file-preview-head');
  const name = createEl(documentRef, 'span', 'handoff-file-preview-name');
  const toggle = createEl(documentRef, 'button', 'handoff-file-preview-toggle', '原文');
  toggle.type = 'button';
  toggle.style.display = 'none';
  const closeButton = createEl(documentRef, 'button', 'handoff-file-preview-close', '关闭');
  closeButton.type = 'button';
  const body = createEl(documentRef, 'div', 'handoff-file-preview-body');
  const frame = createEl(documentRef, 'iframe', 'handoff-file-preview-frame');
  // 空 sandbox：不允许脚本、同源访问、表单与弹窗；再不发出 referrer
  frame.setAttribute('sandbox', '');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.style.display = 'none';
  const textBlock = createEl(documentRef, 'pre', 'handoff-file-preview-text');
  textBlock.style.display = 'none';

  head.appendChild(name);
  head.appendChild(toggle);
  head.appendChild(closeButton);
  body.appendChild(frame);
  body.appendChild(textBlock);
  root.appendChild(head);
  root.appendChild(body);

  let html = '';
  let rawText = '';
  let showingHtml = false;
  let disposed = false;

  function applyMode() {
    const useHtml = showingHtml && !!html;
    frame.style.display = useHtml ? 'block' : 'none';
    textBlock.style.display = useHtml ? 'none' : 'block';
    toggle.style.display = html ? 'inline-block' : 'none';
    toggle.textContent = useHtml ? '原文' : '预览';
  }

  function open(preview) {
    if (disposed || !preview || typeof preview !== 'object') return;
    const fileId = typeof preview.fileId === 'string' ? preview.fileId : '';
    if (!fileId) return;
    root.setAttribute('data-file-id', fileId);
    name.textContent = typeof preview.name === 'string' && preview.name ? preview.name : fileId;
    rawText = typeof preview.text === 'string' ? preview.text : '';
    html = preview.format === 'markdown' && typeof preview.html === 'string' ? preview.html : '';
    showingHtml = !!html;
    // 只有可信渲染器产出的固定标签片段才会进 sandbox iframe
    if (html) frame.srcdoc = markdownDocument(name.textContent, html);
    else frame.srcdoc = '';
    textBlock.textContent = rawText;
    applyMode();
    root.style.display = 'block';
  }

  function close() {
    root.style.display = 'none';
    root.removeAttribute?.('data-file-id');
    html = '';
    rawText = '';
    showingHtml = false;
    frame.srcdoc = '';
    textBlock.textContent = '';
    name.textContent = '';
    applyMode();
  }

  toggle.addEventListener('click', () => {
    if (disposed || !html) return;
    showingHtml = !showingHtml;
    applyMode();
  });
  closeButton.addEventListener('click', () => {
    if (disposed) return;
    close();
  });

  function dispose() {
    if (disposed) return;
    disposed = true;
    close();
    root.remove();
  }

  return {
    root,
    open,
    close,
    dispose,
    get isOpen() { return root.style.display !== 'none'; },
  };
}
