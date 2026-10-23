import { documentRuns } from './document-spec.js';
import { documentPdfFonts, pdfFontRuns } from './document-pdf-fonts.js';
/** Pure JS PDF generation; no Chromium, host callToken, subprocess or network. */
export async function renderPdfDocument(title, blocks, maxBytes) {
  const { default: PdfPrinter } = await import('./vendor/office/pdfmake.cjs');
  const printer = new PdfPrinter(documentPdfFonts());
  const rich = text => documentRuns(text).flatMap(run => pdfFontRuns(run.text).map(part => ({ ...part, ...(run.bold ? { bold: true } : {}) })));
  const content = blocks.map(block => {
    if (block.type === 'heading') return { text: rich(block.text), fontSize: Math.max(12, 24 - block.level * 2), bold: true, margin: [0, 12, 0, 6], headlineLevel: block.level };
    if (block.type === 'table') return { table: { headerRows: 1, widths: block.rows[0].map(() => '*'), body: block.rows.map(row => row.map(cell => ({ text: rich(cell), margin: [3, 3, 3, 3] }))) }, layout: 'lightHorizontalLines', margin: [0, 8, 0, 12] };
    return { text: block.type === 'list' ? [...pdfFontRuns(block.ordered ? `${block.number}. ` : '• '), ...rich(block.text)] : block.type === 'code' ? pdfFontRuns(block.text) : rich(block.text), margin: [0, 0, 0, 7], ...(block.type === 'code' ? { fontSize: 9, background: '#f5f5f5' } : {}) };
  });
  return new Promise((resolve, reject) => {
    const document = printer.createPdfKitDocument({ info: { title, producer: 'Fork Chat' }, pageSize: 'A4', pageMargins: [42, 44, 42, 44], defaultStyle: { font: 'Latin', fontSize: 11, lineHeight: 1.3 }, content });
    const chunks = []; let bytes = 0;
    document.on('data', chunk => { bytes += chunk.length; if (bytes > maxBytes) document.destroy(new Error('生成的PDF超过大小上限')); else chunks.push(chunk); });
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.end();
  });
}
