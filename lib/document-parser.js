import zlib from "node:zlib";
import path from "node:path";

function isReadableText(str) {
  if (!str || str.length < 2) return false;
  let nonPrintable = 0;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
      nonPrintable++;
    } else if (code >= 127 && code <= 159) {
      nonPrintable++;
    }
  }
  return (nonPrintable / str.length) < 0.10;
}

function decodePdfString(str) {
  const res = str.replace(/\\([0-7]{1,3})/g, (m, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");

  return res.replace(/Þ/g, "fi")
    .replace(/ß/g, "fl")
    .replace(/¡\s*C/g, "°C");
}

function decodePdfHex(hex) {
  if (!hex) return "";
  let chars = "";
  if (hex.startsWith("feff") || hex.startsWith("FEFF")) {
    for (let i = 4; i < hex.length; i += 4) {
      const code = parseInt(hex.slice(i, i + 4), 16);
      if (!isNaN(code)) chars += String.fromCharCode(code);
    }
    return chars;
  }
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (!isNaN(code)) chars += String.fromCharCode(code);
  }
  return decodePdfString(chars);
}

function parseTjArray(inner) {
  let line = "";
  let i = 0;
  while (i < inner.length) {
    const ch = inner[i];
    if (ch === "(") {
      i++;
      let depth = 1;
      let str = "";
      while (i < inner.length && depth > 0) {
        if (inner[i] === "\\" && i + 1 < inner.length) {
          str += inner[i] + inner[i + 1];
          i += 2;
          continue;
        }
        if (inner[i] === "(") depth++;
        else if (inner[i] === ")") depth--;
        if (depth > 0) str += inner[i];
        i++;
      }
      line += decodePdfString(str);
    } else if (ch === "<") {
      i++;
      let hex = "";
      while (i < inner.length && inner[i] !== ">") {
        if (!/\s/.test(inner[i])) hex += inner[i];
        i++;
      }
      i++;
      line += decodePdfHex(hex);
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let numStr = "";
      while (i < inner.length && (inner[i] === "-" || inner[i] === "." || (inner[i] >= "0" && inner[i] <= "9"))) {
        numStr += inner[i++];
      }
      const num = parseFloat(numStr);
      if (num <= -120) {
        if (!line.endsWith(" ") && line.length > 0) line += " ";
      }
    } else {
      i++;
    }
  }
  return line;
}

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
 * 纯内存、零依赖 PDF 文本抽取引擎
 * 遍历 PDF 内部压缩流，解码 Content Streams 中的 BT...ET 块与 TJ/Tj 算子
 * 完全运行于内存中，免除任何子进程调用或文件系统写入权限需求
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
export async function extractPdfText(buffer) {
  const str = buffer.toString("latin1");
  const streamRegex = /(<<[\s\S]*?>>)?\s*stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match;
  const sections = [];

  while ((match = streamRegex.exec(str)) !== null) {
    const dict = match[1] || "";
    if (dict.includes("/Subtype /Image") || (dict.includes("/Type /XObject") && dict.includes("/Subtype/Image")) || dict.includes("/DCTDecode")) {
      continue;
    }

    let content = "";
    const raw = Buffer.from(match[2], "latin1");
    try {
      content = zlib.inflateSync(raw).toString("latin1");
    } catch {
      try {
        content = zlib.inflateRawSync(raw).toString("latin1");
      } catch {
        content = match[2];
      }
    }

    if (!content.includes("BT")) continue;

    const btRegex = /BT([\s\S]*?)ET/g;
    let btMatch;
    const blockTexts = [];

    while ((btMatch = btRegex.exec(content)) !== null) {
      const block = btMatch[1];

      // 1. 匹配 TJ 数组
      const tjArrayRegex = /\[([\s\S]*?)\]\s*TJ/g;
      let tjMatch;
      while ((tjMatch = tjArrayRegex.exec(block)) !== null) {
        const text = parseTjArray(tjMatch[1]).trim();
        if (text && isReadableText(text)) blockTexts.push(text);
      }

      // 2. 匹配单一 Tj 或 ' 或 "
      const tjSingleRegex = /(?:\(([\s\S]*?)\)|<([0-9a-fA-F\s]+)>)\s*(?:Tj|'|")/g;
      let singleMatch;
      while ((singleMatch = tjSingleRegex.exec(block)) !== null) {
        if (singleMatch[1] !== undefined) {
          const t = decodePdfString(singleMatch[1]).trim();
          if (t && isReadableText(t)) blockTexts.push(t);
        } else if (singleMatch[2] !== undefined) {
          const t = decodePdfHex(singleMatch[2].replace(/\s+/g, "")).trim();
          if (t && isReadableText(t)) blockTexts.push(t);
        }
      }
    }

    if (blockTexts.length > 0) {
      sections.push(blockTexts.join(" "));
    }
  }

  const result = sections.join("\n\n").trim();
  if (result.length > 0) return result;

  // 极端备用回退：如果在流中未解析出内容，尝试文本正则扫描
  const plainTextMatches = str.match(/\(([^)]{2,})\)/g) || [];
  const fallback = plainTextMatches.map(m => m.slice(1, -1).trim()).filter(Boolean).filter(isReadableText).join(" ");
  if (fallback.length > 0) return fallback;

  throw new Error("无法从该 PDF 中提取到可读文本，可能为纯扫描图片或已加密。");
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
