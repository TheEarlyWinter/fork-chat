import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBridgeOutbox } from "../lib/bridge-outbox.js";
import { BRIDGE_LIMITS } from "../lib/bridge-contract.js";

async function makeOutbox(overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "forkchat-outbox-"));
  let now = Date.now();
  const outbox = createBridgeOutbox({
    dataDir,
    clock: () => now,
    dispatch: async () => ({ accepted: true }),
    ...overrides,
  });
  return { outbox, dataDir, advance: (ms) => { now += ms; } };
}

test("outbox: prepare 只冻结，不调用派发", async () => {
  let called = 0;
  const { outbox } = await makeOutbox({ dispatch: async () => { called += 1; return { accepted: true }; } });
  const prepared = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "你好" });
  assert.match(prepared.actionId, /^act_[0-9a-f]{24}$/);
  assert.equal(called, 0, "prepare 不应产生任何副作用");
  assert.equal(prepared.state, "prepared");
});

test("outbox: confirm 才派发，且只派发一次", async () => {
  let calls = 0;
  const { outbox } = await makeOutbox({
    dispatch: async () => { calls += 1; return { accepted: true }; },
  });
  const prepared = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "你好" });
  const first = await outbox.confirm({ actionId: prepared.actionId });
  assert.equal(first.state, "accepted");
  assert.equal(calls, 1);
  await assert.rejects(() => outbox.confirm({ actionId: prepared.actionId }), /已使用/);
  assert.equal(calls, 1, "重复确认不能再发一次");
});

test("outbox: 并发 confirm 只有一个能派发", async () => {
  let calls = 0;
  const { outbox } = await makeOutbox({
    dispatch: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { accepted: true };
    },
  });
  const prepared = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "并发" });
  const results = await Promise.allSettled([
    outbox.confirm({ actionId: prepared.actionId }),
    outbox.confirm({ actionId: prepared.actionId }),
    outbox.confirm({ actionId: prepared.actionId }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "只能有一个成功");
  assert.equal(rejected.length, 2);
  assert.equal(calls, 1, "派发只发生一次");
});

test("outbox: 过期动作不能再派发", async () => {
  const { outbox, advance } = await makeOutbox();
  const prepared = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "过期" });
  advance(BRIDGE_LIMITS.actionTtlMs + 1000);
  await assert.rejects(() => outbox.confirm({ actionId: prepared.actionId }), /已过期/);
});

test("outbox: 派发结果不确定时记 unknown，不自动重试", async () => {
  let calls = 0;
  const { outbox } = await makeOutbox({
    dispatch: async () => {
      calls += 1;
      throw new Error("网络中断");
    },
  });
  const prepared = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "未知" });
  await assert.rejects(() => outbox.confirm({ actionId: prepared.actionId }));
  const state = await outbox.get({ actionId: prepared.actionId });
  assert.equal(state.state, "unknown");
  assert.equal(state.errorCode, "action_unknown");
  assert.equal(calls, 1, "不得自动重试");
  await assert.rejects(() => outbox.confirm({ actionId: prepared.actionId }), /已使用/);
  assert.equal(calls, 1);
});

test("outbox: 明确失败记 failed，不记 unknown", async () => {
  const { outbox } = await makeOutbox({
    dispatch: async () => {
      const err = new Error("permission denied");
      err.code = "permission_missing";
      throw err;
    },
  });
  const prepared = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "被拒" });
  await assert.rejects(() => outbox.confirm({ actionId: prepared.actionId }));
  const state = await outbox.get({ actionId: prepared.actionId });
  assert.equal(state.state, "failed");
  assert.equal(state.errorCode, "permission_missing");
});

test("outbox: 重启后遗留 dispatching 转 unknown", async () => {
  const { outbox, dataDir } = await makeOutbox();
  const prepared = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "崩溃中" });
  const record = outbox._actions.get(prepared.actionId);
  record.state = "dispatching";
  await fs.writeFile(
    path.join(dataDir, "bridge-actions.json"),
    JSON.stringify({ version: 1, actions: [{ ...record }] }),
  );

  const revived = createBridgeOutbox({ dataDir, dispatch: async () => ({ accepted: true }) });
  const state = await revived.get({ actionId: prepared.actionId });
  assert.equal(state.state, "unknown");
  assert.equal(state.errorCode, "action_unknown");
});

test("outbox: 目标会话与动作类型在 prepare 时冻结，confirm 不接受替换", async () => {
  const { outbox } = await makeOutbox();
  const prepared = await outbox.prepare({ targetSessionId: "sess-A", kind: "send-text", text: "冻结" });
  // confirm 只收 actionId，多给的字段被忽略
  const result = await outbox.confirm({ actionId: prepared.actionId, targetSessionId: "sess-B" });
  assert.equal(result.targetSessionId, "sess-A");
  assert.equal(result.kind, "send-text");
});

test("outbox: 正文不写进元数据文件，只在私有准备区", async () => {
  const { outbox, dataDir } = await makeOutbox();
  const secret = "这是一段不该出现在元数据里的正文";
  const prepared = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: secret });
  const meta = await fs.readFile(path.join(dataDir, "bridge-actions.json"), "utf8");
  assert.equal(meta.includes(secret), false, "元数据里不能有正文");
  assert.match(meta, /payloadHash/);
  const body = await fs.readFile(path.join(dataDir, "bridge-export", `${prepared.actionId}.txt`), "utf8");
  assert.equal(body, secret);
});

test("outbox: 超限内容与空内容被拒", async () => {
  const { outbox } = await makeOutbox();
  await assert.rejects(() => outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "   " }), /内容为空/);
  const huge = "x".repeat(BRIDGE_LIMITS.textMaxBytes + 10);
  await assert.rejects(() => outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: huge }), /上限/);
  await assert.rejects(() => outbox.prepare({ targetSessionId: "sess-1", kind: "nope", text: "x" }), /未知的投递类型/);
  await assert.rejects(() => outbox.prepare({ targetSessionId: "../../etc", kind: "send-text", text: "x" }), /会话标识/);
});

test("outbox: 文件交付与消息发送是两种独立动作", async () => {
  const kinds = [];
  const { outbox } = await makeOutbox({
    dispatch: async ({ record }) => { kinds.push(record.kind); return { accepted: true }; },
  });
  const a = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "消息" });
  const b = await outbox.prepare({ targetSessionId: "sess-1", kind: "stage-markdown", text: "# 文件" });
  await outbox.confirm({ actionId: a.actionId });
  await outbox.confirm({ actionId: b.actionId });
  assert.deepEqual(kinds, ["send-text", "stage-markdown"]);
});

test("outbox: 未知 actionId 报过期而不是崩", async () => {
  const { outbox } = await makeOutbox();
  await assert.rejects(() => outbox.get({ actionId: "act_ffffffffffffffffffffffff" }), /已过期/);
  await assert.rejects(() => outbox.confirm({ actionId: "../../etc" }), /不合法|已过期/);
});

test("outbox: sweep 清掉过期终态与过期未派发动作，但绝不动已发出过的", async () => {
  const { outbox, advance } = await makeOutbox();
  const done = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "完成" });
  await outbox.confirm({ actionId: done.actionId });
  const pending = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "待定" });
  advance(BRIDGE_LIMITS.actionTtlMs + 1000);
  await outbox.sweep();
  assert.equal(await outbox.get({ actionId: done.actionId }).catch(() => null), null);
  // 过期且从未派发：留着只会占满配额，回收是安全的
  assert.equal(await outbox.get({ actionId: pending.actionId }).catch(() => null), null,
    "过期未派发的 prepared 应当被回收，否则 64 条之后永久报满");
});

test("outbox: dispatching / unknown 即使过期也不回收（可能已送达）", async () => {
  const { outbox, advance } = await makeOutbox({ dispatch: async () => { throw new Error("超时"); } });
  const act = await outbox.prepare({ targetSessionId: "sess-1", kind: "send-text", text: "不确定" });
  // 结果不明的派发，confirm 会把错误抛出来，这里只关心落盘状态
  await outbox.confirm({ actionId: act.actionId }).catch(() => {});
  advance(BRIDGE_LIMITS.actionTtlMs * 3);
  await outbox.sweep();
  const still = await outbox.get({ actionId: act.actionId });
  assert.ok(still, "unknown 不能因为过期就被删，否则防重放失效");
  assert.equal(still.state, "unknown");
});

test('outbox: 当前进程也必须拒绝超过动作上限的 prepare', async () => {
  const { outbox } = await makeOutbox();
  for (let i = 0; i < BRIDGE_LIMITS.outboxMaxActions; i += 1) {
    await outbox.prepare({ targetSessionId: 'sess-1', kind: 'send-text', text: `动作-${i}` });
  }
  await assert.rejects(
    () => outbox.prepare({ targetSessionId: 'sess-1', kind: 'send-text', text: '超出上限' }),
    (err) => err.code === 'outbox_full',
  );
});
