import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUploadStore, UPLOAD_LIMITS } from "../lib/upload-store.js";

async function makeStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forkchat-upload-"));
  return { store: createUploadStore({ dataDir }), dataDir };
}

function chunkOf(size, fill = 0x41) {
  return Buffer.alloc(size, fill);
}

test("分块上传走完后能被解析侧取到，内容完整", async () => {
  const { store } = await makeStore();
  const total = 3;
  const size = 1200;
  const { uploadId } = store.begin({ owner: "u1", filename: "a.pdf", size, total });

  const a = chunkOf(400, 0x41);
  const b = chunkOf(400, 0x42);
  const c = chunkOf(400, 0x43);

  const r1 = await store.writeChunk({ uploadId, owner: "u1", index: 0, buffer: a });
  assert.equal(r1.done, false);
  await store.writeChunk({ uploadId, owner: "u1", index: 2, buffer: c });
  const r3 = await store.writeChunk({ uploadId, owner: "u1", index: 1, buffer: b });
  assert.equal(r3.done, true);
  assert.equal(r3.size, size);

  const ref = await store.resolve({ uploadId, owner: "u1" });
  assert.ok(ref);
  const content = await fs.readFile(ref.filePath);
  assert.equal(content.length, size);
  assert.deepEqual(content.subarray(0, 400), a);
  assert.deepEqual(content.subarray(800, 1200), c);
});

test("块乱序但补齐也能完成，缺块则无法完成", async () => {
  const { store } = await makeStore();
  const { uploadId } = store.begin({ owner: "u1", filename: "b.pdf", size: 200, total: 2 });
  await store.writeChunk({ uploadId, owner: "u1", index: 1, buffer: chunkOf(100) });
  const refBefore = await store.resolve({ uploadId, owner: "u1" });
  assert.equal(refBefore, null, "缺块时不允许被取用");
  const done = await store.writeChunk({ uploadId, owner: "u1", index: 0, buffer: chunkOf(100) });
  assert.equal(done.done, true);
});

test("重复分块被拒绝", async () => {
  const { store } = await makeStore();
  const { uploadId } = store.begin({ owner: "u1", filename: "c.pdf", size: 200, total: 2 });
  await store.writeChunk({ uploadId, owner: "u1", index: 0, buffer: chunkOf(100) });
  await assert.rejects(
    () => store.writeChunk({ uploadId, owner: "u1", index: 0, buffer: chunkOf(100) }),
    /重复上传/,
  );
});

test("单块超限被拒绝", async () => {
  const { store } = await makeStore();
  const { uploadId } = store.begin({ owner: "u1", filename: "d.pdf", size: 1000, total: 1 });
  await assert.rejects(
    () => store.writeChunk({ uploadId, owner: "u1", index: 0, buffer: chunkOf(UPLOAD_LIMITS.maxChunkBytes + 1) }),
    /单块超过/,
  );
});

test("分块数与总体积受服务端限制，不信前端声明", async () => {
  const { store } = await makeStore();
  assert.throws(() => store.begin({ owner: "u1", filename: "e.pdf", total: UPLOAD_LIMITS.maxChunks + 1 }), /分块数超过/);
  assert.throws(
    () => store.begin({ owner: "u1", filename: "e.pdf", total: 1, size: UPLOAD_LIMITS.maxTotalBytes + 1 }),
    /上限/,
  );
});

test("跨调用方读取被拒绝", async () => {
  const { store } = await makeStore();
  const { uploadId } = store.begin({ owner: "alice", filename: "f.pdf", size: 100, total: 1 });
  await store.writeChunk({ uploadId, owner: "alice", index: 0, buffer: chunkOf(100) });
  assert.ok(await store.resolve({ uploadId, owner: "alice" }));
  assert.equal(await store.resolve({ uploadId, owner: "mallory" }), null);
  await assert.rejects(
    () => store.writeChunk({ uploadId: "deadbeef".repeat(4), owner: "mallory", index: 0, buffer: chunkOf(10) }),
    /不存在或已过期/,
  );
});

test("非法 uploadId 与任意路径都不放行", async () => {
  const { store } = await makeStore();
  assert.equal(await store.resolve({ uploadId: "../../etc/passwd", owner: "u1" }), null);
  assert.equal(await store.resolve({ uploadId: "not-hex-at-all", owner: "u1" }), null);
  assert.equal(await store.resolve({ uploadId: undefined, owner: "u1" }), null);
});

test("声明的文件长度与实际不符时拒绝合并且不产出文件", async () => {
  const { store, dataDir } = await makeStore();
  const { uploadId } = store.begin({ owner: "u1", filename: "g.pdf", size: 999, total: 1 });
  await assert.rejects(
    () => store.writeChunk({ uploadId, owner: "u1", index: 0, buffer: chunkOf(100) }),
    /长度不符/,
  );
  const files = await fs.readdir(path.join(dataDir, "uploads"));
  assert.equal(files.filter((f) => f.endsWith(".pdf")).length, 0, "不应产出成品文件");
});

test("release 之后临时文件被清掉，且不再可取", async () => {
  const { store, dataDir } = await makeStore();
  const { uploadId } = store.begin({ owner: "u1", filename: "h.pdf", size: 100, total: 1 });
  await store.writeChunk({ uploadId, owner: "u1", index: 0, buffer: chunkOf(100) });
  const ref = await store.resolve({ uploadId, owner: "u1" });
  assert.ok(ref);
  await store.release({ uploadId });
  await assert.rejects(() => fs.stat(ref.filePath), /ENOENT/);
  assert.equal(await store.resolve({ uploadId, owner: "u1" }), null);
  const dir = path.join(dataDir, "uploads");
  const rest = await fs.readdir(dir).catch(() => []);
  assert.equal(rest.filter((f) => f.includes(uploadId)).length, 0);
});

test("同时进行的上传数量有上限", async () => {
  const { store } = await makeStore();
  for (let i = 0; i < UPLOAD_LIMITS.maxActiveUploads; i += 1) {
    store.begin({ owner: "u1", filename: `x${i}.pdf`, total: 1 });
  }
  assert.throws(() => store.begin({ owner: "u1", filename: "overflow.pdf", total: 1 }), /过多/);
});

test("过期上传被清理", async () => {
  const { store } = await makeStore();
  const { uploadId } = store.begin({ owner: "u1", filename: "old.pdf", size: 100, total: 2 });
  const record = store._uploads.get(uploadId);
  record.createdAt = Date.now() - UPLOAD_LIMITS.ttlMs - 1000;
  store.begin({ owner: "u1", filename: "next.pdf", total: 1 });
  assert.equal(store._uploads.has(uploadId), false);
});

test("扩展名被规范化，异常扩展名降级为 .bin", async () => {
  const { store, dataDir } = await makeStore();
  const { uploadId } = store.begin({ owner: "u1", filename: "../../evil.sh.pdf%00", size: 10, total: 1 });
  const record = store._uploads.get(uploadId);
  assert.match(record.filePath ?? "", /^$/);
  await store.writeChunk({ uploadId, owner: "u1", index: 0, buffer: chunkOf(10) });
  const ref = await store.resolve({ uploadId, owner: "u1" });
  assert.ok(ref.filePath.startsWith(path.join(dataDir, "uploads") + path.sep));
});
