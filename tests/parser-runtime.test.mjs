import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";

// 助手模块顶层会读 PARSER_DATA_DIR，必须先设好再 import
const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "forkchat-parser-"));
process.env.PARSER_DATA_DIR = sandboxDir;
const { assertSafeUrl, assertReadableInsideDataDir, createParserService } = await import("../runtime/parser.mjs");
const { parsePdfWithMineru } = await import("../lib/mineru-parse.js");

function buildZip(name, content) {
  const fileName = Buffer.from(name, "utf8");
  const raw = Buffer.from(content, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(raw.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(raw.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const localBlock = Buffer.concat([local, fileName, raw]);
  const centralBlock = Buffer.concat([central, fileName]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(localBlock.length, 16);
  return Buffer.concat([localBlock, centralBlock, eocd]);
}

test("助手只连 https 与白名单域名，http 与其他域名一律拒绝", () => {
  assert.doesNotThrow(() => assertSafeUrl("https://mineru.net/api/v4/file-urls/batch", "接口"));
  assert.doesNotThrow(() => assertSafeUrl("https://cdn-mineru.openxlab.org.cn/x.zip", "结果"));
  assert.throws(() => assertSafeUrl("http://mineru.net/api/v4", "接口"), /https/);
  assert.throws(() => assertSafeUrl("https://evil.example.com/steal", "接口"), /白名单/);
  assert.throws(() => assertSafeUrl("file:///etc/passwd", "接口"), /https/);
  assert.throws(() => assertSafeUrl("not a url", "接口"), /合法地址/);
});

test("助手只能读 App 数据目录内的普通文件", async () => {
  await fs.mkdir(path.join(sandboxDir, "uploads"), { recursive: true });
  const inside = path.join(sandboxDir, "uploads", "ok.pdf");
  await fs.writeFile(inside, Buffer.alloc(64, 7));
  const ok = await assertReadableInsideDataDir(inside);
  assert.equal(ok.size, 64);

  await assert.rejects(
    () => assertReadableInsideDataDir(path.join(sandboxDir, "..", "etc", "passwd")),
    /数据目录内/,
  );
  await assert.rejects(() => assertReadableInsideDataDir("/etc/passwd"), /数据目录内/);

  const link = path.join(sandboxDir, "uploads", "link.pdf");
  await fs.symlink(inside, link);
  await assert.rejects(() => assertReadableInsideDataDir(link), /符号链接/);

  await assert.rejects(() => assertReadableInsideDataDir(path.join(sandboxDir, "uploads")), /普通文件|数据目录/);
});

test("大文件走流式：PUT 收到的是文件流而不是整包缓冲区", async () => {
  const bigPath = path.join(sandboxDir, "uploads", "big.pdf");
  const size = 3 * 1024 * 1024;
  await fs.writeFile(bigPath, Buffer.alloc(size, 0x5a));

  let putInit = null;
  let putBytes = 0;
  const seenUrls = [];
  const fakeFetch = async (url, init = {}) => {
    const target = String(url);
    seenUrls.push(`${init.method || "GET"} ${target}`);
    if (target.endsWith("/file-urls/batch")) {
      return new Response(
        JSON.stringify({ code: 0, data: { batch_id: "b1", file_urls: ["https://mineru.net/api/v4/upload/abc"] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (init.method === "PUT") {
      putInit = init;
      for await (const chunk of init.body) putBytes += chunk.length;
      return new Response("", { status: 200 });
    }
    if (target.includes("/extract-results/batch/")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { extract_result: [{ state: "done", full_zip_url: "https://mineru.net/ok.zip", page_count: 3 }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("ok.zip")) {
      return new Response(buildZip("full.md", "# 测试\n\n正文写够二十个字，用来通过内容长度下限检查。"), {
        status: 200,
      });
    }
    throw new Error(`未预期的请求 ${target}`);
  };

  const result = await parsePdfWithMineru({
    buffer: null,
    fileName: "big.pdf",
    fileSize: size,
    options: {
      token: "test-token",
      apiBase: "https://mineru.net/api/v4",
      modelVersion: "vlm",
      language: "ch",
      isOcr: false,
      enableFormula: true,
      enableTable: true,
      timeoutSeconds: 30,
      pollIntervalSeconds: 0,
    },
    fetchFn: fakeFetch,
    createBody: async () => {
      const handle = await fs.open(bigPath);
      return Readable.toWeb(handle.createReadStream());
    },
  });

  assert.ok(putInit, "应当发生过一次 PUT");
  assert.equal(putInit.duplex, "half", "流式上传要声明 half duplex");
  assert.ok(!Buffer.isBuffer(putInit.body), "PUT 的 body 不能是整包 Buffer");
  assert.equal(putBytes, size, "上传字节数必须与文件大小一致");
  // 光是"字数大于 20"太松：占位文本、乱码、把 HTML 当正文都能过。
  // 这里比的是具体内容，接口返回什么就必须原样拿到什么。
  assert.match(result.text, /正文写够二十个字/, "返回正文必须与载荷一致");
  assert.equal(result.charCount, result.text.length);
  assert.equal(result.source, "mineru");
  assert.ok(!seenUrls.some((u) => u.includes("data:")), "不应出现内联 base64 请求");
});

test("合成 26,764,891 字节文件：流式上传字节数与 sha256 均与源文件一致", async () => {
  const size = 26_764_891;
  const source = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) source[i] = (i * 7) % 251;
  const srcPath = path.join(sandboxDir, "uploads", "scan-26mb.pdf");
  await fs.writeFile(srcPath, source);
  const srcHash = createHash("sha256").update(source).digest("hex");

  let putBytes = 0;
  let putHash = null;
  let putIsBuffer = null;
  const fakeFetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/file-urls/batch")) {
      return new Response(
        JSON.stringify({ code: 0, data: { batch_id: "b3", file_urls: ["https://mineru.net/api/v4/upload/big"] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (init.method === "PUT") {
      putIsBuffer = Buffer.isBuffer(init.body);
      const hash = createHash("sha256");
      for await (const chunk of init.body) {
        putBytes += chunk.length;
        hash.update(chunk);
      }
      putHash = hash.digest("hex");
      return new Response("", { status: 200 });
    }
    if (target.includes("/extract-results/batch/")) {
      return new Response(
        JSON.stringify({
          code: 0,
          data: { extract_result: [{ state: "done", full_zip_url: "https://mineru.net/big.zip", page_count: 1 }] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (target.includes("big.zip")) {
      return new Response(buildZip("full.md", "# 扫描件\n\n这是模拟回来的正文，字数足够通过下限检查。"), { status: 200 });
    }
    throw new Error(`未预期的请求 ${target}`);
  };

  const result = await parsePdfWithMineru({
    buffer: null,
    fileName: "scan-26mb.pdf",
    fileSize: size,
    options: {
      token: "test-token",
      apiBase: "https://mineru.net/api/v4",
      modelVersion: "vlm",
      language: "ch",
      isOcr: false,
      enableFormula: true,
      enableTable: true,
      timeoutSeconds: 30,
      pollIntervalSeconds: 0,
    },
    fetchFn: fakeFetch,
    createBody: async () => {
      const handle = await fs.open(srcPath);
      return Readable.toWeb(handle.createReadStream());
    },
  });

  assert.equal(putIsBuffer, false, "PUT body 不是整包 Buffer");
  assert.equal(putBytes, size, "上传字节数必须等于 26,764,891");
  assert.equal(putHash, srcHash, "上传内容 sha256 必须与源文件一致");
  assert.equal(result.ok, true);
  assert.match(result.text, /模拟回来的正文/, "大文件路径拿到的正文也必须与载荷一致");
  assert.equal(result.charCount, result.text.length);
});

test("流式失败时错误信息保留阶段，不泄露 Token", async () => {
  const fakeFetch = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith("/file-urls/batch")) {
      return new Response(
        JSON.stringify({ code: 0, data: { batch_id: "b2", file_urls: ["https://mineru.net/api/v4/upload/x"] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (init.method === "PUT") {
      throw new Error("网络断了");
    }
    throw new Error("不该走到这里");
  };

  await assert.rejects(
    () =>
      parsePdfWithMineru({
        buffer: null,
        fileName: "x.pdf",
        fileSize: 1024,
        options: {
          token: "super-secret-token-value",
          apiBase: "https://mineru.net/api/v4",
          modelVersion: "vlm",
          language: "ch",
          isOcr: true,
          enableFormula: true,
          enableTable: true,
          timeoutSeconds: 5,
          pollIntervalSeconds: 0,
        },
        fetchFn: fakeFetch,
        createBody: () => new ReadableStream({ start(c) { c.close(); } }),
      }),
    (err) => {
      assert.doesNotMatch(String(err.message), /super-secret-token-value/);
      return true;
    },
  );
});

test("助手重试时每次上传使用独立文件描述符，不继承 fd=-1", async () => {
  const fileId = "a".repeat(32) + ".pdf";
  const fileBytes = Buffer.from("synthetic pdf bytes for descriptor retry");
  const filePath = path.join(sandboxDir, "uploads", fileId);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, fileBytes);
  const authToken = "b".repeat(64);
  const service = await createParserService({
    dataDir: sandboxDir,
    authToken,
    parseFn: async ({ createBody }) => {
      const first = await createBody();
      first.on("error", () => {});
      await new Promise((resolve) => {
        first.once("close", resolve);
        first.destroy();
      });
      const second = await createBody();
      const chunks = [];
      for await (const chunk of second) chunks.push(chunk);
      return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
    },
  });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  const port = service.server.address().port;
  const sha256 = createHash("sha256").update(fileBytes).digest("hex");
  try {
    const started = await fetch(`http://127.0.0.1:${port}/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        fileId,
        sha256,
        filename: "retry.pdf",
        options: { token: "synthetic-token", apiBase: "https://mineru.net/api/v4", timeoutSeconds: 30 },
      }),
    });
    assert.equal(started.status, 202);
    const { jobId } = await started.json();
    let state;
    for (let i = 0; i < 40; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const response = await fetch(`http://127.0.0.1:${port}/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${authToken}` },
      });
      state = await response.json();
      if (state.status !== "running") break;
    }
    assert.equal(state.status, "done", JSON.stringify(state));
  } finally {
    await service.close();
  }
});
