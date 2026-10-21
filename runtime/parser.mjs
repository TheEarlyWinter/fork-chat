#!/usr/bin/env node
/**
 * App 的 Node 助手：替主进程把大文件流式送去 MinerU。
 *
 * 为什么需要它：主进程走的是宿主的 network.fetch RPC，每条消息上限 32 MiB，
 * 26 MB 的扫描件一转 base64 就 34 MiB，必然被拒。这个进程用原生 HTTP/HTTPS
 * 直连，文件从磁盘边读边发，不经过任何消息通道。
 *
 * 边界（都在这里自己兜）：
 *   - 只监听 127.0.0.1，端口由 App 传入并预先声明给宿主
 *   - 只读 dataDir 内、由 App 交办的文件，真实路径与符号链接都校验
 *   - 只连 MinerU 官方域名，https，重定向逐跳复核
 *   - Token 只从请求体拿，不进日志、不进命令行
 *   - 结果落盘，回给 App 的只有小状态与文件路径
 */
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parsePdfWithMineru, storeMineruCache } from "../lib/mineru-parse.js";

const READY_MARKER = "PARSER_READY";
const MAX_JOB_BYTES = 200 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = 2;
const MAX_ZIP_BYTES = 250 * 1024 * 1024;
const JOB_TTL_MS = 10 * 60 * 1000;

const port = Number(process.argv[2] || process.env.PARSER_PORT || 0);
const dataDir = process.env.PARSER_DATA_DIR || process.cwd();
const resultDir = path.join(dataDir, "helper-results");

/** jobId → { status, stage, startedAt, ... } */
const jobs = new Map();
let running = 0;

function log(message) {
  // 只用 stdout 报状态，不打印文件内容、Token 或签名 URL
  process.stdout.write(`${JSON.stringify({ type: "log", text: String(message).slice(0, 300) })}\n`);
}

/** 只连官方域名，https，且不接受可疑跳转 */
const ALLOWED_HOSTS = ["mineru.net", "cdn-mineru.openxlab.org.cn", "oss-mineru.openxlab.org.cn"];
export function assertSafeUrl(raw, label) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`${label}不是合法地址`);
  }
  if (url.protocol !== "https:") throw new Error(`${label}必须使用 https`);
  const host = url.hostname.toLowerCase();
  const ok = ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  if (!ok) throw new Error(`${label}域名不在白名单：${host}`);
  return url;
}

/** 包一层 fetch：带上超时与响应体上限，跳转后复核目标域名 */
async function nodeFetch(input, init = {}) {
  const { timeoutMs, maxResponseBytes, ...rest } = init;
  const signal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
  let current = String(input);
  assertSafeUrl(current, "请求地址");

  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(current, { ...rest, signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      current = new URL(location, current).toString();
      assertSafeUrl(current, "跳转地址");
      if (rest.method && rest.method !== "GET" && rest.method !== "HEAD") {
        throw new Error("上传请求遇到跳转，已拒绝以免重放内容");
      }
      continue;
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (maxResponseBytes && declared && declared > maxResponseBytes) {
      throw new Error(`响应过大：${declared} 字节`);
    }
    return response;
  }
  throw new Error("跳转次数过多");
}

export async function assertReadableInsideDataDir(target) {
  const realDataDir = await fsp.realpath(dataDir);
  const resolved = path.resolve(String(target));
  if (!resolved.startsWith(realDataDir + path.sep)) throw new Error("文件不在 App 数据目录内");
  const stat = await fsp.lstat(resolved);
  if (stat.isSymbolicLink()) throw new Error("拒绝读取符号链接");
  if (!stat.isFile()) throw new Error("目标不是普通文件");
  if (stat.size > MAX_JOB_BYTES) throw new Error(`文件超过 ${Math.round(MAX_JOB_BYTES / 1048576)} MB`);
  return { realPath: resolved, size: stat.size };
}

async function runJob(jobId, job) {
  running += 1;
  try {
    const { realPath, size } = await assertReadableInsideDataDir(job.filePath);
    job.size = size;
    job.stage = "上传文件";
    log(`任务 ${jobId.slice(0, 8)} 开始，${(size / 1048576).toFixed(2)} MB`);

    const result = await parsePdfWithMineru({
      buffer: null,
      fileName: job.filename || path.basename(realPath),
      fileSize: size,
      options: job.options,
      fetchFn: nodeFetch,
      createBody: () => fs.createReadStream(realPath),
      onProgress: (stage) => {
        job.stage = stage;
      },
    });

    const zipBytes = result._zip;
    if (zipBytes && zipBytes.length > MAX_ZIP_BYTES) throw new Error("结果包超过上限");
    await storeMineruCache({ dataDir, cacheId: result.cacheId, zipBytes });

    await fsp.mkdir(resultDir, { recursive: true });
    const resultPath = path.join(resultDir, `${jobId}.json`);
    const payload = {
      ok: true,
      source: result.source,
      engine: result.engine,
      engineLabel: "MinerU 云端",
      modelVersion: result.modelVersion,
      language: result.language,
      ocrFallback: result.ocrFallback,
      fileName: result.fileName,
      charCount: result.charCount,
      pageCount: result.pageCount,
      imageCount: result.imageCount,
      elapsedMs: result.elapsedMs,
      cacheId: result.cacheId,
      text: result.text,
    };
    await fsp.writeFile(resultPath, JSON.stringify(payload));

    job.status = "done";
    job.stage = "完成";
    job.chars = result.charCount;
    job.resultPath = resultPath;
    log(`任务 ${jobId.slice(0, 8)} 完成，${result.charCount} 字`);
  } catch (err) {
    job.status = "error";
    job.stage = "失败";
    job.error = String(err?.message || err).slice(0, 500);
    log(`任务 ${jobId.slice(0, 8)} 失败：${job.error}`);
  } finally {
    job.finishedAt = Date.now();
    running -= 1;
    setTimeout(() => jobs.delete(jobId), JOB_TTL_MS).unref?.();
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  if (!total) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

const server = isMain
  ? http.createServer(handleRequest)
  : null;

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, ready: true, running, jobs: jobs.size });
    }

    if (req.method === "POST" && url.pathname === "/jobs") {
      if (running >= MAX_CONCURRENT_JOBS) return sendJson(res, 429, { ok: false, error: "助手正在忙，请稍候" });
      const body = await readBody(req);
      if (!body.filePath) return sendJson(res, 400, { ok: false, error: "缺少 filePath" });
      if (!body.options?.token) return sendJson(res, 400, { ok: false, error: "缺少 MinerU 配置" });
      const jobId = String(body.jobId || randomUUID().replace(/-/g, "").slice(0, 16));
      const job = {
        status: "running",
        stage: "排队",
        startedAt: Date.now(),
        filePath: String(body.filePath),
        filename: String(body.filename || ""),
        options: body.options,
      };
      jobs.set(jobId, job);
      void runJob(jobId, job);
      return sendJson(res, 202, { ok: true, jobId });
    }

    if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
      const jobId = decodeURIComponent(url.pathname.slice("/jobs/".length));
      const job = jobs.get(jobId);
      if (!job) return sendJson(res, 404, { ok: false, error: "任务不存在或已过期" });
      return sendJson(res, 200, {
        ok: true,
        status: job.status,
        stage: job.stage,
        chars: job.chars,
        resultPath: job.resultPath,
        error: job.error,
        elapsedMs: Date.now() - job.startedAt,
      });
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/jobs/")) {
      const jobId = decodeURIComponent(url.pathname.slice("/jobs/".length));
      const job = jobs.get(jobId);
      if (!job) return sendJson(res, 404, { ok: false, error: "任务不存在" });
      job.status = "error";
      job.error = "已取消";
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: "未知路径" });
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: String(err?.message || err).slice(0, 300) });
  }
}

if (server) {
  server.listen(port, "127.0.0.1", () => {
    const actual = server.address()?.port;
    // 宿主靠这一行认定服务就绪，然后才允许代理到这个端口
    process.stdout.write(`${READY_MARKER} ${actual}\n`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref?.();
  }
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
