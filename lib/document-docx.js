/** DOCX adapter: receives neutral blocks, returns an actual OOXML ZIP. */
export async function renderDocxDocument(title, blocks) {
  const { default: docx } = await import('./vendor/office/docx.cjs');
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType } = docx;
  const { documentRuns } = await import('./document-spec.js');
  const runs = text => documentRuns(text).map(run => new TextRun({ text: run.text, bold: run.bold, font: run.code ? 'Consolas' : undefined }));
  const children = blocks.map(block => {
    if (block.type === 'table') return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: block.rows.map((row, index) => new TableRow({ tableHeader: index === 0, children: row.map(cell => new TableCell({ children: [new Paragraph({ children: runs(cell) })] })) })) });
    return new Paragraph({ children: block.type === 'code' ? block.text.split('\n').map((text, index) => new TextRun({ text, font: 'Consolas', ...(index ? { break: 1 } : {}) })) : runs(block.type === 'list' && block.ordered ? `${block.number}. ${block.text}` : block.text),
      ...(block.type === 'heading' ? { heading: `Heading${block.level}` } : {}),
      ...(block.type === 'list' && !block.ordered ? { bullet: { level: 0 } } : {}), spacing: { after: 140 } });
  });
  const document = new Document({ title, creator: 'Fork Chat', styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 22 }, paragraph: { spacing: { line: 300 } } } } }, sections: [{ children }] });
  return Packer.toBuffer(document);
}
