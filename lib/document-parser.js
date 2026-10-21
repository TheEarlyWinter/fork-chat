import fs from "node:fs/promises";
import zlib from "node:zlib";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 从 Word (.docx) 的 Buffer 中提取段落纯文本
 * 基于标准 ZIP 格式与 word/document.xml 解析，零外部依赖
 * @param {Buffer} buffer
 * @returns {string}
 */
export function extractDocxText(buffer) {
  let offset = 0;
  while (offset < buffer.length - 30) {
    // 匹配 ZIP Local File Header 标识 0x04034b50
    if (buffer.readUInt32LE(offset) !== 0x04034b50) {
      offset++;
      continue;
    }
    const compression = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const fileName = buffer.toString("utf8", offset + 30, offset + 30 + fileNameLen);
    const dataStart = offset + 30 + fileNameLen + extraLen;

    if (fileName === "word/document.xml") {
      const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);
      let xml = "";
      if (compression === 0) {
        xml = compressedData.toString("utf8");
      } else if (compression === 8) {
        xml = zlib.inflateRawSync(compressedData).toString("utf8");
      } else {
        throw new Error(`Unsupported docx compression method: ${compression}`);
      }

      // 解析 XML 段落 (<w:p>) 与文本片元 (<w:t>)
      const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
      const lines = [];
      for (const p of paragraphs) {
        // 匹配段落内的所有文本节点
        const texts = p.match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g) || [];
        const line = texts.map((t) => t.replace(/<[^>]+>/g, "")).join("");
        if (line.trim()) {
          lines.push(line.trim());
        }
      }
      return lines.join("\n\n");
    }
    offset = dataStart + compressedSize;
  }
  return "";
}

/**
 * 从 PDF 的 Buffer 中提取纯文本
 * 优先调用本机 pdftotext，若不可用则回退基础流提取
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractPdfText(buffer) {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `fork-chat-pdf-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  try {
    await fs.writeFile(tmpPath, buffer);
    const { stdout } = await execFileAsync("pdftotext", ["-layout", tmpPath, "-"]);
    return stdout.trim();
  } catch (err) {
    // pdftotext 异常或不存在时的后备逻辑：基础文本流扫描
    const raw = buffer.toString("latin1");
    const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
    const texts = [];
    let match;
    while ((match = streamRegex.exec(raw)) !== null) {
      const streamContent = match[1];
      try {
        const uncompressed = zlib.inflateSync(Buffer.from(streamContent, "latin1")).toString("utf8");
        const tjMatches = uncompressed.match(/\(([^)]+)\)\s*Tj/g) || [];
        for (const tj of tjMatches) {
          const t = tj.replace(/^$$|$$\s*Tj$/g, "");
          if (t.trim()) texts.push(t.trim());
        }
      } catch {}
    }
    if (texts.length > 0) return texts.join(" ");
    throw new Error(`PDF 解析失败: ${err.message || String(err)}`);
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

/**
 * 统一文件提取调度中心
 * @param {object} params
 * @param {string} params.filename 文件名
 * @param {string} [params.text] 纯文本内容
 * @param {string} [params.contentBase64] Base64 编码的二进制流
 * @returns {Promise<object>}
 */
export async function parseDocument({ filename, text, contentBase64 }) {
  if (!filename || typeof filename !== "string") {
    throw new Error("缺少有效文件名");
  }

  const ext = path.extname(filename).toLowerCase();
  let extractedText = "";

  const textExtensions = new Set([
    ".md", ".markdown", ".txt", ".json", ".csv", ".tsv",
    ".js", ".ts", ".jsx", ".tsx", ".py", ".c", ".cpp",
    ".h", ".hpp", ".java", ".go", ".rs", ".html", ".css",
    ".sh", ".bash", ".sql", ".yaml", ".yml", ".xml", ".ini",
  ]);

  if (typeof text === "string" && text.length > 0) {
    extractedText = text;
  } else if (contentBase64) {
    const buffer = Buffer.from(contentBase64, "base64");
    if (ext === ".docx") {
      extractedText = extractDocxText(buffer);
    } else if (ext === ".pdf") {
      extractedText = await extractPdfText(buffer);
    } else if (textExtensions.has(ext)) {
      extractedText = buffer.toString("utf8");
    } else {
      // 默认尝试当作 UTF-8 文本解析
      extractedText = buffer.toString("utf8");
    }
  } else {
    throw new Error("文件内容为空");
  }

  const charCount = extractedText.length;
  const lines = extractedText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const lineCount = lines.length;
  const preview = extractedText.slice(0, 1500) + (charCount > 1500 ? "\n\n... (文档较长，后续内容已完全载入上下文)" : "");

  return {
    ok: true,
    filename,
    extension: ext,
    charCount,
    lineCount,
    text: extractedText,
    preview,
  };
}
