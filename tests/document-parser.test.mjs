import test from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { parseDocument, extractDocxText } from "../lib/document-parser.js";

test("document-parser: 文本与 Markdown 直接解析", async () => {
  const result = await parseDocument({
    filename: "README.md",
    text: "# 标题\n这是一篇测试 Markdown。\n- 列表项 1\n- 列表项 2",
  });
  assert.equal(result.ok, true);
  assert.equal(result.filename, "README.md");
  assert.equal(result.extension, ".md");
  assert.equal(result.lineCount, 4);
  assert.match(result.text, /这是一篇测试 Markdown/);
});

test("document-parser: Base64 编码的纯文本正常还原", async () => {
  const rawText = "Hello from code!\nconst x = 42;";
  const b64 = Buffer.from(rawText, "utf8").toString("base64");
  const result = await parseDocument({
    filename: "script.js",
    contentBase64: b64,
  });
  assert.equal(result.ok, true);
  assert.equal(result.text, rawText);
  assert.equal(result.extension, ".js");
});

test("document-parser: Word (.docx) ZIP 结构文本提取", async () => {
  // 手工构造一个最小合法的 docx ZIP 缓冲包
  const xmlContent = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
  <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
    <w:body>
      <w:p><w:r><w:t>第一章 绪论</w:t></w:r></w:p>
      <w:p><w:r><w:t>这是文档的第一段内容。</w:t></w:r></w:p>
      <w:p><w:r><w:t>这是第二段，测试格式提取。</w:t></w:r></w:p>
      <w:p><w:r><w:t>Tom &amp; Jerry &lt;3 &quot;quoted&quot; &#39;single&#39;</w:t></w:r></w:p>
    </w:body>
  </w:document>`;

  const compressedXml = zlib.deflateRawSync(Buffer.from(xmlContent, "utf8"));
  const fileName = "word/document.xml";
  const fileNameBuf = Buffer.from(fileName, "utf8");

  // 构建 ZIP Local File Header (30 字节)
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); // Signature
  header.writeUInt16LE(20, 4); // Version needed
  header.writeUInt16LE(0, 6); // Flags
  header.writeUInt16LE(8, 8); // Compression method (8 = Deflate)
  header.writeUInt16LE(0, 10); // Mod time
  header.writeUInt16LE(0, 12); // Mod date
  header.writeUInt32LE(0, 14); // CRC-32 (ignored)
  header.writeUInt32LE(compressedXml.length, 18); // Compressed size
  header.writeUInt32LE(Buffer.byteLength(xmlContent), 22); // Uncompressed size
  header.writeUInt16LE(fileNameBuf.length, 26); // Filename length
  header.writeUInt16LE(0, 28); // Extra field length

  const docxBuffer = Buffer.concat([header, fileNameBuf, compressedXml]);

  const extracted = extractDocxText(docxBuffer);
  assert.match(extracted, /第一章 绪论/);
  assert.match(extracted, /这是文档的第一段内容。/);
  assert.match(extracted, /这是第二段，测试格式提取。/);
  assert.match(extracted, /Tom & Jerry <3 "quoted" 'single'/);

  // 通过 parseDocument 统一入口调用
  const result = await parseDocument({
    filename: "论文草稿.docx",
    contentBase64: docxBuffer.toString("base64"),
  });
  assert.equal(result.ok, true);
  assert.equal(result.extension, ".docx");
  assert.match(result.text, /第一章 绪论/);
});

/** 构造一个最小但结构合法（带 xref）的 PDF，供 pdf.js 解析 */
function buildMinimalPdf(lines) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const ops = ["BT", "/F1 12 Tf", "16 TL", "72 720 Td", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"];
  const content = ops.join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefPos = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

test("document-parser: PDF 文本提取（pdf.js 引擎）", async () => {
  const lines = [
    "Hello PDF World from the pdf.js engine.",
    "This paragraph exists to push the extracted",
    "character count above the scanning-detection",
    "threshold so the document is treated as a real",
    "text layer document rather than a blank scan.",
    "A second block checks that multiple lines are",
    "joined in reading order without reordering,",
    "dropping characters, or merging unrelated lines.",
    "End of the sample document body.",
    "Fin.",
  ];
  const pdfBuffer = buildMinimalPdf(lines);

  const result = await parseDocument({
    filename: "sample.pdf",
    contentBase64: pdfBuffer.toString("base64"),
  });

  assert.equal(result.ok, true);
  assert.equal(result.extension, ".pdf");
  assert.match(result.text, /Hello PDF World/);
  assert.match(result.text, /End of the sample document body/);
});

test("document-parser: 异常输入与空内容防护", async () => {
  await assert.rejects(async () => {
    await parseDocument({ filename: "" });
  }, /缺少有效文件名/);

  await assert.rejects(async () => {
    await parseDocument({ filename: "empty.txt" });
  }, /文件内容为空/);
});
