import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * MinerU 云端解析（可选能力，默认关闭）。
 *
 * 定位：本地 pdf.js 读的是文件里本来就有的文字层，扫描件它一无所知。
 * 这一层补的正是那个洞——把 PDF 送到 MinerU，由它的视觉模型看图识别，
 * 拿回排好版的 Markdown。
 *
 * 代价必须写在明面上：文件会离开本机，解析要等十几到几十秒，还耗额度。
 * 所以这里所有的默认值都偏向保守：token 没配就不启用，开关没开就不上传。
 */

const DEFAULT_API_BASE = "https://mineru.net/api/v4";
const MAX_ZIP_BYTES = 250 * 1024 * 1024;
const MAX_ENTRY_BYTES = 120 * 1024 * 1024;
const MAX_TOTAL_EXTRACTED_BYTES = 500 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10000;
const MAX_MARKDOWN_CHARS = 2_000_000;

/** 允许的官方域名：上传地址、结果下载地址都必须落在这些域里，防 SSRF */
const ALLOWED_HOSTS = [
  "mineru.net",
  ".mineru.net",
  "openxlab.org.cn",
  ".openxlab.org.cn",
  "mineru.oss-cn-shanghai.aliyuncs.com",
];

const ALLOWED_MODELS = new Set(["vlm", "pipeline"]);
const ALLOWED_LANGUAGES = new Set(["ch", "en", "japan", "latin"]);

export class MineruError extends Error {
  constructor(stage, message, { retryable = false, cause = null } = {}) {
    const detail = String(message || "MinerU 请求失败").trim();
    super(detail.startsWith(`${stage}：`) ? detail : `${stage}：${detail}`);
    this.name = "MineruError";
    this.stage = stage;
    this.retryable = retryable === true;
    if (cause) this.cause = cause;
  }
}

const str = (value, fallback = "") => (typeof value === "string" ? value.trim() : fallback);

function normalizeApiBase(value) {
  const candidate = str(value, DEFAULT_API_BASE).replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("MinerU API 地址无效");
  }
  const host = parsed.hostname.toLowerCase();
  const hostOk = host === "mineru.net" || host.endsWith(".mineru.net");
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !hostOk) {
    throw new Error("MinerU API 地址必须是 mineru.net 官方 HTTPS 域名");
  }
  return parsed.toString().replace(/\/+$/, "");
}

/** 校验 MinerU 返回的下载地址：必须 https、无内嵌凭据、落在白名单域名 */
function assertAllowedUrl(value, label) {
  const candidate = str(value);
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`MinerU 返回的${label}无效`);
  }
  const host = parsed.hostname.toLowerCase();
  const ok = ALLOWED_HOSTS.some((entry) =>
    entry.startsWith(".") ? host.endsWith(entry) : host === entry || host.endsWith(entry),
  );
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !ok) {
    throw new Error(`MinerU 返回的${label}不是允许的官方 HTTPS 地址`);
  }
  return parsed.toString();
}

/**
 * 从 App 配置里读解析参数。每次调用现读，改完设置不用重启。
 * @param {(key: string) => unknown} get
 */
export function resolveMineruOptions(get) {
  const token = str(get("mineruApiToken")).replace(/^Bearer\s+/i, "").trim();
  const modelVersion = str(get("mineruModelVersion"), "vlm");
  const language = str(get("mineruLanguage"), "ch");
  const timeoutSeconds = Number(get("mineruTimeoutSeconds"));
  return {
    token,
    apiBase: normalizeApiBase(get("mineruApiBaseUrl")),
    modelVersion: ALLOWED_MODELS.has(modelVersion) ? modelVersion : "vlm",
    language: ALLOWED_LANGUAGES.has(language) ? language : "ch",
    enableFormula: get("mineruEnableFormula") !== false,
    enableTable: get("mineruEnableTable") !== false,
    isOcr: get("mineruIsOcr") === true,
    timeoutSeconds: Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.min(1800, Math.max(30, Math.floor(timeoutSeconds)))
      : 600,
    pollIntervalSeconds: 5,
    enabled: get("mineruEnabled") === true,
  };
}

/** 当前是否可用：开关打开 + token 填了 */
export function mineruReady(get) {
  const options = resolveMineruOptions(get);
  return { ready: options.enabled && Boolean(options.token), options };
}

function safeFileName(fileName) {
  const cleaned = str(fileName, "document.pdf").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120);
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}

function normalizeZipPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("结果包缺少中央目录（可能不是有效 ZIP）");
}

/**
 * 纯内存读 ZIP。不依赖 unzip 命令，也不落临时文件。
 * 所有上限都是为了防压缩炸弹：单条体积、总解压体积、条目数。
 * @param {Buffer} zipBytes
 * @returns {Array<{name: string, data: Buffer}>}
 */
export function readZipEntries(zipBytes) {
  const buffer = Buffer.isBuffer(zipBytes) ? zipBytes : Buffer.from(zipBytes ?? []);
  if (!buffer.length) throw new Error("结果包为空");
  if (buffer.length > MAX_ZIP_BYTES) throw new Error("结果包体积超过上限");
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error("结果包内文件数量过多");

  const entries = [];
  let offset = centralOffset;
  let totalExtracted = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("结果包中央目录损坏");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > buffer.length) throw new Error("结果包文件名损坏");
    const entryName = normalizeZipPath(buffer.subarray(offset + 46, nameEnd).toString("utf8"));
    offset = nameEnd + extraLength + commentLength;
    if (!entryName || entryName.endsWith("/")) continue;
    if ((flags & 0x1) !== 0) throw new Error("结果包含加密文件");
    if (method !== 0 && method !== 8) throw new Error(`结果包压缩方式不支持：${method}`);
    if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`结果文件过大：${entryName}`);
    totalExtracted += uncompressedSize;
    if (totalExtracted > MAX_TOTAL_EXTRACTED_BYTES) throw new Error("结果包解压后体积过大");
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`结果包本地文件头损坏：${entryName}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw new Error(`结果包文件数据损坏：${entryName}`);
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    if (data.length > MAX_ENTRY_BYTES) throw new Error(`结果文件实际体积过大：${entryName}`);
    entries.push({ name: entryName, data });
  }
  return entries;
}

/**
 * 清掉 Markdown 里的图片引用和多余空行。
 * 图片本身留在缓存目录里，正文里保留一个 [图片] 占位，让模型知道那个位置本来有图。
 */
export function cleanMineruMarkdown(raw) {
  return String(raw || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图片]")
    .replace(/\(\s*images\/[^)]*\)/g, "")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pickMarkdown(entries) {
  const md = entries.filter((entry) => entry.name.toLowerCase().endsWith(".md"));
  if (!md.length) return null;
  // 优先取叫 full.md 的，其次取体积最大的那份
  const full = md.find((entry) => /(^|\/)full\.md$/i.test(entry.name));
  const chosen = full || md.sort((a, b) => b.data.length - a.data.length)[0];
  return chosen;
}

async function readJsonResponse(response, label) {
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MineruError(label, `返回内容不是 JSON（HTTP ${response.status}）`);
  }
  return parsed;
}

function assertApiOk(envelope, label) {
  if (!envelope || typeof envelope !== "object") throw new MineruError(label, "返回结构异常");
  if (envelope.code !== 0 && envelope.code !== undefined) {
    throw new MineruError(label, str(envelope.msg, `错误码 ${envelope.code}`));
  }
  return envelope.data || {};
}

/**
 * 跑一次解析尝试。
 * @param {object} params
 * @param {Buffer} params.buffer PDF 字节
 * @param {string} params.fileName
 * @param {object} params.options resolveMineruOptions 的结果
 * @param {boolean} params.isOcr 是否强制走 OCR 模式
 * @param {(input: string, init?: object) => Promise<Response>} params.fetchFn
 * @param {(stage: string, message: string) => void} [params.onProgress]
 */
async function runAttempt({ buffer, fileName, options, isOcr, fetchFn, onProgress, attempt, createBody, fileSize }) {
  const digest = buffer
    ? createHash("sha256").update(buffer).digest("hex").slice(0, 12)
    : createHash("sha256").update(`${fileName}:${fileSize || 0}`).digest("hex").slice(0, 12);
  const dataId = `fork_chat_${Date.now()}_${digest}_${isOcr ? "ocr" : "std"}${attempt}`;
  const authHeaders = {
    Authorization: `Bearer ${options.token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  onProgress?.("申请上传地址", "");
  const uploadEnvelope = await readJsonResponse(
    await fetchFn(`${options.apiBase}/file-urls/batch`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        files: [{ name: fileName, data_id: dataId, is_ocr: isOcr }],
        model_version: options.modelVersion,
        enable_formula: options.enableFormula,
        enable_table: options.enableTable,
        language: options.language,
      }),
      timeoutMs: 60000,
      maxResponseBytes: 2 * 1024 * 1024,
    }),
    "申请上传地址",
  );
  const uploadData = assertApiOk(uploadEnvelope, "申请上传地址");
  const batchId = str(uploadData.batch_id);
  const rawUploadUrl = Array.isArray(uploadData.file_urls) ? str(uploadData.file_urls[0]) : "";
  if (!batchId || !rawUploadUrl) {
    throw new MineruError("申请上传地址", "未返回批次 ID 或上传地址");
  }
  const uploadUrl = assertAllowedUrl(rawUploadUrl, "上传地址");

  onProgress?.("上传文件", "");
  // createBody 存在时走流式：大文件不过内存，也不会被整包交给宿主网络代理
  const putBody = createBody ? await createBody() : buffer;
  const putInit = {
    method: "PUT",
    body: putBody,
    timeoutMs: Math.max(120000, options.timeoutSeconds * 1000),
    maxResponseBytes: 2 * 1024 * 1024,
  };
  if (createBody) putInit.duplex = "half";
  const putResponse = await fetchFn(uploadUrl, putInit);
  if (!putResponse.ok) {
    throw new MineruError("上传文件", `HTTP ${putResponse.status}`, { retryable: putResponse.status >= 500 });
  }

  onProgress?.("等待解析", "");
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  let final = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalSeconds * 1000));
    const statusEnvelope = await readJsonResponse(
      await fetchFn(`${options.apiBase}/extract-results/batch/${encodeURIComponent(batchId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
        timeoutMs: 60000,
        maxResponseBytes: 4 * 1024 * 1024,
      }),
      "查询解析状态",
    );
    const statusData = assertApiOk(statusEnvelope, "查询解析状态");
    const results = Array.isArray(statusData.extract_result)
      ? statusData.extract_result
      : [statusData.extract_result].filter(Boolean);
    const current = results.find((item) => item?.data_id === dataId) || results[0];
    if (!current) continue;
    if (current.state === "done") {
      final = current;
      break;
    }
    if (current.state === "failed") {
      throw new MineruError("解析任务", str(current.err_msg, "解析失败"), { retryable: true });
    }
  }
  if (!final) {
    throw new MineruError("等待解析", `超时（${options.timeoutSeconds} 秒），批次 ${batchId}`, { retryable: true });
  }

  onProgress?.("下载结果", "");
  const zipUrl = assertAllowedUrl(final.full_zip_url, "结果地址");
  const zipResponse = await fetchFn(zipUrl, {
    method: "GET",
    timeoutMs: Math.max(120000, options.timeoutSeconds * 1000),
    maxResponseBytes: MAX_ZIP_BYTES,
  });
  if (!zipResponse.ok) throw new MineruError("下载结果", `HTTP ${zipResponse.status}`, { retryable: true });
  const zipBytes = Buffer.from(await zipResponse.arrayBuffer());

  const entries = readZipEntries(zipBytes);
  const mdEntry = pickMarkdown(entries);
  if (!mdEntry) {
    throw new MineruError("读取结果", "结果包里没有 Markdown 文件", { retryable: true });
  }
  const rawMarkdown = mdEntry.data.toString("utf8");
  const text = cleanMineruMarkdown(rawMarkdown).slice(0, MAX_MARKDOWN_CHARS);
  if (text.length < 20) {
    throw new MineruError("读取结果", "Markdown 内容为空", { retryable: true });
  }
  const pageCount = Number(final.page_count) || Number(final.pages) || 0;
  return {
    text,
    pageCount,
    imageCount: entries.filter((entry) => /\.(png|jpe?g|webp|gif|bmp)$/i.test(entry.name)).length,
    zipBytes,
    cacheId: createHash("sha256").update(zipBytes).digest("hex").slice(0, 16),
    mdFileName: mdEntry.name,
  };
}

/**
 * 主入口：把 PDF 交给 MinerU，拿回 Markdown。
 * 普通模式失败且错误标记为可重试时，自动切 OCR 模式再跑一次。
 *
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} params.fileName
 * @param {object} params.options
 * @param {(input: string, init?: object) => Promise<Response>} params.fetchFn
 * @param {(stage: string, message: string) => void} [params.onProgress]
 * @returns {Promise<object>}
 */
export async function parsePdfWithMineru({ buffer, fileName, options, fetchFn, onProgress, createBody, fileSize }) {
  if (!options?.token) throw new Error("未配置 MinerU API Token");
  if (!buffer?.length && !createBody) throw new Error("文件内容为空");
  const safeName = safeFileName(fileName);
  const startedAt = Date.now();

  let result;
  let ocrFallback = false;
  try {
    result = await runAttempt({
      buffer,
      fileName: safeName,
      options,
      isOcr: options.isOcr,
      fetchFn,
      onProgress,
      attempt: 1,
      createBody,
      fileSize,
    });
  } catch (firstError) {
    if (options.isOcr || !(firstError instanceof MineruError && firstError.retryable)) throw firstError;
    onProgress?.("普通解析未成功，改用 OCR 重试", "");
    ocrFallback = true;
    result = await runAttempt({
      buffer,
      fileName: safeName,
      options,
      isOcr: true,
      fetchFn,
      onProgress,
      attempt: 2,
      createBody,
      fileSize,
    });
  }

  return {
    ok: true,
    source: "mineru",
    engine: "mineru",
    modelVersion: options.modelVersion,
    language: options.language,
    ocrFallback,
    fileName: safeName,
    charCount: result.text.length,
    pageCount: result.pageCount,
    imageCount: result.imageCount,
    elapsedMs: Date.now() - startedAt,
    text: result.text,
    cacheId: result.cacheId,
    mdFileName: result.mdFileName,
    _zip: result.zipBytes,
  };
}

/**
 * 把结果包落到缓存目录，图片留在里面，正文只需要 Markdown。
 * 落盘失败不算解析失败，只记一笔日志。
 */
export async function storeMineruCache({ dataDir, cacheId, zipBytes, logger }) {
  if (!dataDir || !cacheId || !zipBytes) return null;
  try {
    const dir = path.join(dataDir, "mineru-cache", cacheId);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, "result.zip");
    await fs.writeFile(target, zipBytes);
    return dir;
  } catch (err) {
    logger?.warn?.(`MinerU 缓存写入失败：${err?.message || String(err)}`);
    return null;
  }
}
