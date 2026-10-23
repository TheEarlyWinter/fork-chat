import { createArtifactActions } from './panel-artifacts.js';
/** DOM adapter only. The actions module owns async state; the store owns bytes. */
export function createArtifactView({ hana, requestHost, flashMessage, getCards, getGeneration, isDisposed, getDocument = () => document }) {
  let dialog = null;
  const contexts = new WeakMap();
  const dismiss = () => { if (dialog) { dialog.remove(); dialog = null; } };
  function showPreview(html, artifact) {
    dismiss();
    const doc = getDocument();
    dialog = doc.createElement('dialog'); dialog.className = 'artifact-preview-dialog';
    const title = doc.createElement('h2'); title.textContent = artifact.name;
    const note = doc.createElement('p'); note.textContent = '内容预览；不代表 Word 或 PDF 原文件的精确分页排版。';
    const frame = doc.createElement('iframe'); frame.title = `文档预览：${artifact.name}`;
    frame.setAttribute('sandbox', ''); frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>body{font:16px/1.8 system-ui,sans-serif;padding:16px;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%}td,th{border:1px solid #bbb;padding:8px}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
    const close = doc.createElement('button'); close.type = 'button'; close.textContent = '关闭'; close.addEventListener('click', dismiss);
    dialog.addEventListener('cancel', dismiss, { once: true });
    dialog.append(title, note, frame, close); doc.body.appendChild(dialog); dialog.showModal();
  }
  function bind(cardEl, card, on) {
    const generation = getGeneration();
    const active = () => !isDisposed() && getGeneration() === generation && getCards().includes(card);
    let context = contexts.get(card);
    if (!context || context.generation !== generation) {
      context = { generation, actions: createArtifactActions({ hana, requestHost, flashMessage, isActive: active, showPreview }) };
      contexts.set(card, context);
    }
    const { actions } = context;
    on(cardEl, 'click', event => {
      const target = event.target?.closest?.('[data-artifact-action]');
      if (!target || !cardEl.contains(target)) return;
      const id = target.dataset.artifactId;
      const artifact = card.messages.flatMap(message => message.artifacts || []).find(item => item.artifactId === id);
      if (!artifact || !active()) return;
      event.preventDefault(); event.stopPropagation();
      if (target.dataset.artifactAction === 'preview') void actions.preview(id);
      else if (target.dataset.artifactAction === 'save') void actions.save(id);
    });
  }
  return { bind, dismiss, dispose: dismiss };
}
