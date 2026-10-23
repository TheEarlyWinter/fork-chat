import { documentRuns, escapeDocumentHtml as escape } from './document-spec.js';
const inline = text => documentRuns(text).map(run => run.bold ? `<strong>${escape(run.text)}</strong>` : run.code ? `<code>${escape(run.text)}</code>` : escape(run.text)).join('');
/** Only fixed tags are emitted; user HTML, URLs, scripts and style declarations stay text. */
export function renderDocumentHtmlFragment(blocks) {
  return blocks.map(block => {
    if (block.type === 'heading') return `<h${block.level}>${inline(block.text)}</h${block.level}>`;
    if (block.type === 'code') return `<pre><code>${escape(block.text)}</code></pre>`;
    if (block.type === 'list') return `<${block.ordered ? `ol start="${block.number}"` : 'ul'}><li>${inline(block.text)}</li></${block.ordered ? 'ol' : 'ul'}>`;
    if (block.type === 'table') return `<table>${block.rows.map((row, i) => `<tr>${row.map(cell => `<${i ? 'td' : 'th'}>${inline(cell)}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`;
    return `<p>${inline(block.text)}</p>`;
  }).join('\n');
}
export function renderDocumentHtml(title, blocks) {
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{max-width:860px;margin:40px auto;padding:0 24px;font-family:system-ui,sans-serif;line-height:1.8;color:#202020}table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #bbb;padding:8px;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f5f5;padding:14px}p{overflow-wrap:anywhere}@media print{body{margin:0;max-width:none}h1,h2,h3{break-after:avoid}tr{break-inside:avoid}}</style></head><body>${renderDocumentHtmlFragment(blocks)}</body></html>`;
}
