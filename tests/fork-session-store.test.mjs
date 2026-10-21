import test from "node:test";
import assert from "node:assert/strict";
import {
  createForkSessionStore,
  normalizeForkSnapshot,
  generateAutoTitle,
  FORK_SESSION_STORAGE_KEY,
  STORAGE_MAX_SESSIONS,
} from "../ui/assets/fork-session-store.js";

// 辅助创建 Fake Storage
function createFakeStorage(initialData = null) {
  let store = initialData ? JSON.parse(JSON.stringify(initialData)) : null;
  const listeners = new Set();

  return {
    async get(key) {
      if (key !== FORK_SESSION_STORAGE_KEY) return null;
      return store ? { key, value: JSON.parse(JSON.stringify(store)) } : null;
    },
    async set(key, value) {
      if (key === FORK_SESSION_STORAGE_KEY) {
        store = JSON.parse(JSON.stringify(value));
        for (const cb of listeners) {
          try {
            cb([key]);
          } catch {}
        }
      }
      return { ok: true, key };
    },
    onChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    // 测试辅助
    _getRaw() {
      return store;
    },
    _setRaw(val) {
      store = val;
    },
    _emit(keys) {
      for (const cb of listeners) cb(keys);
    },
  };
}

// 辅助创建共享 Fake Web Locks
function createFakeLocks() {
  let queue = Promise.resolve();
  return {
    async request(name, callback) {
      const run = queue.then(async () => {
        return await callback();
      });
      queue = run.catch(() => {});
      return await run;
    },
  };
}

// 辅助生成合法的基础 Snapshot
function createValidSnapshot(overrides = {}) {
  return {
    cards: [
      {
        id: "card-root",
        parentId: null,
        x: 0,
        y: 0,
        width: 320,
        draft: "草稿内容",
        messages: [
          { role: "user", text: "你好，请推荐一本科普书。" },
          { role: "assistant", text: "<mood>开心</mood>\n为你推荐《万物简史》。" },
        ],
      },
    ],
    view: { x: 100, y: -50, scale: 1.0 },
    agent: { id: "agent-1", name: "科普助手", model: "gpt-4o", provider: "openai" },
    ...overrides,
  };
}

test('canvas titles, scroll and valid message request ids survive round-trip; malformed saved DOM ids fail closed', async () => {
  const storage = createFakeStorage(), locks = createFakeLocks();
  const store = createForkSessionStore({ storage: { global: storage } }, { locks });
  const input = createValidSnapshot();
  input.cards[0].title = '完整根卡片'; input.cards[0].savedScrollTop = 47;
  input.cards[0].messages[1].requestId = 'request-valid';
  const record = await store.ensure(input);
  assert.equal(record.snapshot.cards[0].title, '完整根卡片');
  assert.equal(record.snapshot.cards[0].savedScrollTop, 47);
  input.cards[0].messages[1].requestId = 'bad" id';
  assert.throws(() => normalizeForkSnapshot(input), error => error.code === 'INVALID_SESSION_SNAPSHOT');
  const damaged = JSON.parse(JSON.stringify(storage._getRaw()));
  damaged.sessions[0].snapshot.cards[0].id = 'bad" id'; storage._setRaw(damaged);
  await assert.rejects(store.get(record.id), error => error.code === 'SESSION_STORE_CORRUPT');
  assert.deepEqual(storage._getRaw(), damaged);
});

test('quota is measured in UTF-8 bytes, not UTF-16 character count', async () => {
  const storage = createFakeStorage(), locks = createFakeLocks();
  const store = createForkSessionStore({ storage: { global: storage } }, { locks });
  await store.ensure(createValidSnapshot());
  const before = JSON.parse(JSON.stringify(storage._getRaw()));
  const huge = createValidSnapshot(); huge.cards[0].messages[0].text = '汉'.repeat(4 * 1024 * 1024);
  await assert.rejects(store.create(huge), error => error.code === 'STORAGE_QUOTA_EXCEEDED');
  assert.deepEqual(storage._getRaw(), before);
});

// =========================================================================
// 1. normalizeForkSnapshot 纯函数深度校验与白名单克隆
// =========================================================================

test("normalizeForkSnapshot: 深克隆且不修改传入的原生活对象", () => {
  const liveInput = createValidSnapshot({
    cards: [
      {
        id: "c-1",
        parentId: null,
        x: 10,
        y: 20,
        width: 400,
        draft: "test draft",
        messages: [
          {
            role: "assistant",
            text: "正在输出...",
            streaming: true,
            status: "generating",
          },
        ],
      },
    ],
  });

  const normalized = normalizeForkSnapshot(liveInput);

  // 原生入参对象未被就地修改
  assert.equal(liveInput.cards[0].messages[0].streaming, true);
  assert.equal(liveInput.cards[0].messages[0].status, "generating");
  assert.equal(liveInput.cards[0].messages[0].failed, undefined);

  // 归一化后的输出对象已深拷贝并完成中断态固化
  assert.equal(normalized.cards[0].messages[0].streaming, false);
  assert.equal(normalized.cards[0].messages[0].status, "cancelled");
  assert.equal(normalized.cards[0].messages[0].failed, true);
  assert.match(normalized.cards[0].messages[0].error, /REQUEST_INTERRUPTED/);

  // 引用隔离断言
  assert.notEqual(normalized, liveInput);
  assert.notEqual(normalized.cards[0], liveInput.cards[0]);
  assert.notEqual(normalized.cards[0].messages[0], liveInput.cards[0].messages[0]);
});

test("normalizeForkSnapshot: 中断标记将 streaming/waiting/generating 统一转化为已中断终态", () => {
  const input = createValidSnapshot({
    cards: [
      {
        id: "card-main",
        parentId: null,
        x: 0,
        y: 0,
        width: 300,
        draft: "",
        messages: [
          { role: "user", text: "query 1" },
          { role: "assistant", text: "part", streaming: true },
          { role: "assistant", text: "", status: "waiting" },
          { role: "assistant", text: "answering", status: "generating" },
          { role: "assistant", text: "已完成消息", status: "done", failed: false },
          { role: "assistant", text: "欢迎使用！", localOnly: true }, // 无 status 的 localOnly 欢迎语
        ],
      },
    ],
  });

  const res = normalizeForkSnapshot(input);
  const msgs = res.cards[0].messages;

  // 消息 1: 正常 user
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs[0].text, "query 1");

  // 消息 2: streaming=true -> 中断
  assert.equal(msgs[1].status, "cancelled");
  assert.equal(msgs[1].streaming, false);
  assert.equal(msgs[1].failed, true);
  assert.match(msgs[1].error, /REQUEST_INTERRUPTED/);

  // 消息 3: status=waiting -> 中断
  assert.equal(msgs[2].status, "cancelled");
  assert.equal(msgs[2].failed, true);

  // 消息 4: status=generating -> 中断
  assert.equal(msgs[3].status, "cancelled");
  assert.equal(msgs[3].failed, true);

  // 消息 5: 已完成消息保留
  assert.equal(msgs[4].status, "done");
  assert.equal(msgs[4].failed, false);

  // 消息 6: localOnly 欢迎语保留
  assert.equal(msgs[5].localOnly, true);
  assert.equal(msgs[5].status, undefined);
});

test("normalizeForkSnapshot: 原文与 mood/reflect 标签、草稿、视口与 agent 完整保留", () => {
  const originalMarkdown = "# 标题\n```js\nconsole.log(1);\n```\n<mood>😊 开心</mood>\n<reflect>深度思考</reflect>";
  const input = {
    cards: [
      {
        id: "card-root",
        parentId: null,
        requestId: "req-abc-123",
        x: -123.45,
        y: 678.9,
        width: 500,
        draft: "草稿暂存文字",
        messages: [
          { role: "user", text: "请解析" },
          {
            role: "assistant",
            text: originalMarkdown,
            agentId: "ag-1",
            agentName: "测试助手",
            modelRef: "openai/gpt-4o",
            asidesOpen: true,
          },
        ],
      },
    ],
    view: { x: -200, y: 300, scale: 1.5 },
    agent: { id: "ag-1", name: "测试助手", model: "gpt-4o", provider: "openai" },
  };

  const res = normalizeForkSnapshot(input);

  assert.equal(res.cards[0].messages[1].text, originalMarkdown);
  assert.equal(res.cards[0].draft, "草稿暂存文字");
  assert.equal(res.cards[0].requestId, "req-abc-123");
  assert.equal(res.cards[0].messages[1].asidesOpen, true);
  assert.deepEqual(res.view, { x: -200, y: 300, scale: 1.5 });
  assert.deepEqual(res.agent, { id: "ag-1", name: "测试助手", model: "gpt-4o", provider: "openai" });
});

test("normalizeForkSnapshot: 错误边界校验（非法 role、非法卡 ID、环状引用、孤儿父引用、越界坐标等）", () => {
  // 1. cards 缺失或非数组
  assert.throws(() => normalizeForkSnapshot({ view: { x: 0, y: 0, scale: 1 } }), (err) => err.code === "INVALID_SESSION_SNAPSHOT");

  // 2. 视口 scale 越界 (0.4 ~ 2.2)
  assert.throws(
    () => normalizeForkSnapshot(createValidSnapshot({ view: { x: 0, y: 0, scale: 0.1 } })),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );
  assert.throws(
    () => normalizeForkSnapshot(createValidSnapshot({ view: { x: 0, y: 0, scale: 3.0 } })),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );

  // 3. 卡片宽度越界 (220 ~ 2000)
  assert.throws(
    () =>
      normalizeForkSnapshot(
        createValidSnapshot({
          cards: [{ id: "c1", parentId: null, x: 0, y: 0, width: 100, messages: [] }],
        })
      ),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );

  // 4. 卡片 ID 含有非法字符
  assert.throws(
    () =>
      normalizeForkSnapshot(
        createValidSnapshot({
          cards: [{ id: "bad id with spaces", parentId: null, x: 0, y: 0, width: 300, messages: [] }],
        })
      ),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );

  // 5. 消息 role 非法
  assert.throws(
    () =>
      normalizeForkSnapshot(
        createValidSnapshot({
          cards: [
            {
              id: "c1",
              parentId: null,
              x: 0,
              y: 0,
              width: 300,
              messages: [{ role: "system", text: "illegal role" }],
            },
          ],
        })
      ),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );

  // 6. 重复卡片 ID
  assert.throws(
    () =>
      normalizeForkSnapshot(
        createValidSnapshot({
          cards: [
            { id: "c1", parentId: null, x: 0, y: 0, width: 300, messages: [] },
            { id: "c1", parentId: null, x: 0, y: 0, width: 300, messages: [] },
          ],
        })
      ),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );

  // 7. 父引用不存在（孤儿引用）
  assert.throws(
    () =>
      normalizeForkSnapshot(
        createValidSnapshot({
          cards: [{ id: "c1", parentId: "non-existent-parent", x: 0, y: 0, width: 300, messages: [] }],
        })
      ),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );

  // 8. 自环引用
  assert.throws(
    () =>
      normalizeForkSnapshot(
        createValidSnapshot({
          cards: [{ id: "c1", parentId: "c1", x: 0, y: 0, width: 300, messages: [] }],
        })
      ),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );

  // 9. 多节点环状依赖 (c1 -> c2 -> c3 -> c1)
  assert.throws(
    () =>
      normalizeForkSnapshot(
        createValidSnapshot({
          cards: [
            { id: "c1", parentId: "c3", x: 0, y: 0, width: 300, messages: [] },
            { id: "c2", parentId: "c1", x: 0, y: 0, width: 300, messages: [] },
            { id: "c3", parentId: "c2", x: 0, y: 0, width: 300, messages: [] },
          ],
        })
      ),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );
});

// =========================================================================
// 2. 自动标题与自定义标题保护
// =========================================================================

test("generateAutoTitle: 提取第一条 user 文本，压缩空白并截断至 40 字符，无文本回退新会话", () => {
  const snap1 = createValidSnapshot({
    cards: [
      {
        id: "c1",
        parentId: null,
        x: 0,
        y: 0,
        width: 300,
        messages: [
          { role: "assistant", text: "你好！" },
          {
            role: "user",
            text: "   请问   量子力学中  薛定谔的猫   究竟代表了什么物理佯谬？这是一段非常长的提问...   ",
          },
        ],
      },
    ],
  });

  const title1 = generateAutoTitle(snap1);
  assert.equal(title1, "请问 量子力学中 薛定谔的猫 究竟代表了什么物理佯谬？这是一段非常长的提问...");
  assert.equal(title1.length, 40);

  // 无 user 文本回退
  const snapEmpty = createValidSnapshot({
    cards: [{ id: "c1", parentId: null, x: 0, y: 0, width: 300, messages: [] }],
  });
  assert.equal(generateAutoTitle(snapEmpty), "新会话");
});

// =========================================================================
// 3. createForkSessionStore: 基础生命周期、版本锁与一致性
// =========================================================================

test("createForkSessionStore: locks 缺失时写入操作显式抛出 STORAGE_LOCK_UNAVAILABLE，只读允许执行", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };

  // 注入 null locks
  const store = createForkSessionStore(hana, { locks: null });

  // 1. 只读操作无需 lock 即可正常执行
  const listRes = await store.list();
  assert.deepEqual(listRes, { activeId: null, sessions: [] });

  // 2. 写入操作必须拦截并显式报错
  const snap = createValidSnapshot();
  await assert.rejects(() => store.ensure(snap), (err) => err.code === "STORAGE_LOCK_UNAVAILABLE");
  await assert.rejects(() => store.create(snap), (err) => err.code === "STORAGE_LOCK_UNAVAILABLE");
  await assert.rejects(() => store.activate("some-id"), (err) => err.code === "STORAGE_LOCK_UNAVAILABLE");
  await assert.rejects(() => store.save("some-id", 1, snap), (err) => err.code === "STORAGE_LOCK_UNAVAILABLE");
});

test("createForkSessionStore: ensure 首次并发双窗口原子竞争不产生重复会话", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const sharedLocks = createFakeLocks();

  let idCounter = 0;
  const storeA = createForkSessionStore(hana, { locks: sharedLocks, idFactory: () => `sess-${++idCounter}` });
  const storeB = createForkSessionStore(hana, { locks: sharedLocks, idFactory: () => `sess-${++idCounter}` });

  const snapA = createValidSnapshot({ cards: [{ id: "c-a", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "窗口A首问" }] }] });
  const snapB = createValidSnapshot({ cards: [{ id: "c-b", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "窗口B首问" }] }] });

  // 模拟两个独立窗口同时调用 ensure
  const [recA, recB] = await Promise.all([storeA.ensure(snapA), storeB.ensure(snapB)]);

  // 两个窗口获得的是同一个被激活的会话，且底层集合只新增了 1 条
  assert.equal(recA.id, recB.id);
  assert.equal(recA.id, "sess-1");

  const list = await storeA.list();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.activeId, "sess-1");
});

test("createForkSessionStore: 跨实例共享锁读-修订-写无丢更新与 revision 冲突拒绝", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const sharedLocks = createFakeLocks();

  const store = createForkSessionStore(hana, { locks: sharedLocks, idFactory: () => "sess-1" });

  const snap = createValidSnapshot();
  const created = await store.create(snap, { title: "我的会话" });
  assert.equal(created.revision, 1);
  assert.equal(created.title, "我的会话");

  // 1. revision 匹配时保存成功，revision 递增且 updatedAt 刷新
  const snapV2 = createValidSnapshot({
    cards: [
      {
        id: "card-root",
        parentId: null,
        x: 10,
        y: 20,
        width: 320,
        draft: "更新草稿",
        messages: [{ role: "user", text: "修改后的问题" }],
      },
    ],
  });

  const saved1 = await store.save("sess-1", 1, snapV2);
  assert.equal(saved1.revision, 2);
  // manualTitle 保护：自定义 title 不被覆盖
  assert.equal(saved1.title, "我的会话");
  assert.equal(saved1.snapshot.cards[0].draft, "更新草稿");

  // 2. 模拟陈旧视图使用旧 revision (1) 提交，抛出 SESSION_CONFLICT
  await assert.rejects(
    () => store.save("sess-1", 1, snapV2),
    (err) => err.code === "SESSION_CONFLICT"
  );

  // 3. 使用最新 revision (2) 成功递增至 3
  const saved2 = await store.save("sess-1", 2, snapV2);
  assert.equal(saved2.revision, 3);
});

test("createForkSessionStore: 保存失败、未知会话 ID 与已损坏文件拒绝覆盖", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const sharedLocks = createFakeLocks();
  const store = createForkSessionStore(hana, { locks: sharedLocks });

  // 1. 获取与激活不存在的会话报 SESSION_NOT_FOUND
  await assert.rejects(() => store.get("non-existent"), (err) => err.code === "SESSION_NOT_FOUND");
  await assert.rejects(() => store.activate("non-existent"), (err) => err.code === "SESSION_NOT_FOUND");
  await assert.rejects(() => store.save("non-existent", 1, createValidSnapshot()), (err) => err.code === "SESSION_NOT_FOUND");

  // 2. 损坏文件拒绝覆盖保护：存储中写入版本不合法的数据
  storage._setRaw({ version: 999, corrupted: true });
  await assert.rejects(() => store.list(), (err) => err.code === "SESSION_STORE_CORRUPT");
  await assert.rejects(() => store.create(createValidSnapshot()), (err) => err.code === "SESSION_STORE_CORRUPT");
  // 确保存储依然保留受损数据原貌，未被静默覆盖或清空
  assert.equal(storage._getRaw().corrupted, true);
});

test("createForkSessionStore: 会话数量上限 (100) 与整文档 12MB 配额限制，绝不删除旧会话", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const sharedLocks = createFakeLocks();

  let id = 0;
  const store = createForkSessionStore(hana, {
    locks: sharedLocks,
    idFactory: () => `s-${++id}`,
  });

  const snap = createValidSnapshot();

  // 批量填充至 100 个会话
  for (let i = 0; i < STORAGE_MAX_SESSIONS; i++) {
    await store.create(snap);
  }

  const listBefore = await store.list();
  assert.equal(listBefore.sessions.length, 100);

  // 第 101 个会话创建时拒绝并抛出配额超限错误
  await assert.rejects(() => store.create(snap), (err) => err.code === "STORAGE_QUOTA_EXCEEDED");

  // 验证绝不删除旧会话
  const listAfter = await store.list();
  assert.equal(listAfter.sessions.length, 100);
  assert.equal(listAfter.sessions[0].id, "s-1");

  // 验证单文档 12MB 超限保护
  const hugeText = "X".repeat(13 * 1024 * 1024); // 13MB 文本
  const hugeSnapshot = createValidSnapshot({
    cards: [
      {
        id: "c-huge",
        parentId: null,
        x: 0,
        y: 0,
        width: 300,
        draft: "",
        messages: [{ role: "user", text: hugeText }],
      },
    ],
  });

  await assert.rejects(() => store.save("s-1", 1, hugeSnapshot), (err) => err.code === "STORAGE_QUOTA_EXCEEDED");
});

test("createForkSessionStore: watch 机制精准筛选根键并提供 unsubscribe", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const store = createForkSessionStore(hana, { locks: createFakeLocks() });

  let callCount = 0;
  const unsub = store.watch(() => {
    callCount++;
  });

  // 1. 非相关键变化被过滤
  storage._emit(["other-app.config", "unrelated-key"]);
  assert.equal(callCount, 0);

  // 2. 匹配键触发
  storage._emit(["fork-chat.sessions.v1"]);
  assert.equal(callCount, 1);

  // 3. 取消监听后不再触发
  unsub();
  storage._emit(["fork-chat.sessions.v1"]);
  assert.equal(callCount, 1);
});

// =========================================================================
// 4. 会话重命名 (rename) 与标题保护机制
// =========================================================================

test("rename: 空白、超长、非法控制字符拒绝并抛 INVALID_SESSION_TITLE，HTML 安全原文保留，空白压缩正常", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const locks = createFakeLocks();
  const store = createForkSessionStore(hana, { locks });

  const record = await store.ensure(createValidSnapshot());
  const initialData = JSON.parse(JSON.stringify(storage._getRaw()));

  // 1. 空白拒绝（空字符串、全空格、换行与制表符空白）
  await assert.rejects(
    () => store.rename(record.id, ""),
    (err) => err.code === "INVALID_SESSION_TITLE"
  );
  await assert.rejects(
    () => store.rename(record.id, "   \t\n  \r "),
    (err) => err.code === "INVALID_SESSION_TITLE"
  );
  assert.deepEqual(storage._getRaw(), initialData);

  // 2. 超长拒绝（>80 UTF-16 字符）
  await assert.rejects(
    () => store.rename(record.id, "a".repeat(81)),
    (err) => err.code === "INVALID_SESSION_TITLE"
  );
  assert.deepEqual(storage._getRaw(), initialData);

  // 恰好 80 UTF-16 字符成功
  const exact80 = "字".repeat(80);
  const renamed80 = await store.rename(record.id, exact80);
  assert.equal(renamed80.title, exact80);
  assert.equal(renamed80.revision, 2);

  // 3. 拒绝剩余控制字符（\x00, \x07, \x1b, \x7f 等）
  await assert.rejects(
    () => store.rename(record.id, "标题\x00含空字符"),
    (err) => err.code === "INVALID_SESSION_TITLE"
  );
  await assert.rejects(
    () => store.rename(record.id, "标题\x07含响铃"),
    (err) => err.code === "INVALID_SESSION_TITLE"
  );
  await assert.rejects(
    () => store.rename(record.id, "标题\x1b含ESC"),
    (err) => err.code === "INVALID_SESSION_TITLE"
  );
  await assert.rejects(
    () => store.rename(record.id, "标题\x7f含DEL"),
    (err) => err.code === "INVALID_SESSION_TITLE"
  );

  // 4. HTML 安全原文完整保留（UI 会 textContent 渲染），多余空白压缩与两端 trim
  const htmlRaw = "   <script>alert('xss')</script>  &  <b>加粗文本</b>   ";
  const renamedHtml = await store.rename(record.id, htmlRaw);
  assert.equal(renamedHtml.title, "<script>alert('xss')</script> & <b>加粗文本</b>");
  assert.equal(renamedHtml.revision, 3);
  assert.equal(renamedHtml.manualTitle, true);
});

test("rename: expectedTitle 并发冲突校验，内容自动保存 revision 变化不应阻碍 rename，且不影响 snapshot/activeId", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const locks = createFakeLocks();
  let time = 1000;
  const store = createForkSessionStore(hana, { locks, now: () => ++time });

  const record = await store.ensure(createValidSnapshot());
  assert.equal(record.revision, 1);
  const originalTitle = record.title;

  // 1. 若 expectedTitle 与当前 title 不匹配，抛 SESSION_CONFLICT
  await assert.rejects(
    () => store.rename(record.id, "新标题", "错误的旧标题"),
    (err) => err.code === "SESSION_CONFLICT"
  );

  // 2. 模拟内容自动保存使得 revision 从 1 变到 2，但 title 保持不变
  const snapUpdated = createValidSnapshot({
    cards: [
      {
        id: "card-root",
        parentId: null,
        x: 50,
        y: 60,
        width: 320,
        draft: "自动保存草稿",
        messages: [{ role: "user", text: originalTitle }],
      },
    ],
  });
  const saved = await store.save(record.id, 1, snapUpdated);
  assert.equal(saved.revision, 2);
  assert.equal(saved.title, originalTitle);

  // 3. 内容自动保存 revision 变化不应阻碍 rename：传入原 expectedTitle，成功完成重命名
  const renamed = await store.rename(record.id, "已确认的自定义标题", originalTitle);
  assert.equal(renamed.title, "已确认的自定义标题");
  assert.equal(renamed.manualTitle, true);
  assert.equal(renamed.revision, 3);
  assert.equal(renamed.updatedAt, time);
  // snapshot 与 activeId 纹丝不动
  assert.deepEqual(renamed.snapshot, saved.snapshot);
  const list = await store.list();
  assert.equal(list.activeId, record.id);
});

test("rename 与 save 协同：改名后 save 不恢复自动标题且消息/草稿正常保存", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const locks = createFakeLocks();
  const store = createForkSessionStore(hana, { locks });

  const record = await store.ensure(createValidSnapshot());
  assert.equal(record.manualTitle, false);

  // 改名设为自定义标题
  const renamed = await store.rename(record.id, "我的重要研究会话");
  assert.equal(renamed.manualTitle, true);
  assert.equal(renamed.title, "我的重要研究会话");
  assert.equal(renamed.revision, 2);

  // 之后用户在会话中发送新消息并修改草稿，触发 save
  const newSnapshot = createValidSnapshot({
    cards: [
      {
        id: "card-root",
        parentId: null,
        x: 0,
        y: 0,
        width: 320,
        draft: "最新编写的草稿内容",
        messages: [
          { role: "user", text: "完全不同的第一问，本应自动生成标题" },
          { role: "assistant", text: "好的，为您解答。" },
        ],
      },
    ],
  });

  const saved = await store.save(record.id, 2, newSnapshot);
  // 必须保留手动标题，不得自动覆盖
  assert.equal(saved.title, "我的重要研究会话");
  assert.equal(saved.manualTitle, true);
  assert.equal(saved.revision, 3);
  // 卡片消息与草稿准确持久化
  assert.equal(saved.snapshot.cards[0].draft, "最新编写的草稿内容");
  assert.equal(saved.snapshot.cards[0].messages[0].text, "完全不同的第一问，本应自动生成标题");

  // get 验证落盘结果
  const fetched = await store.get(record.id);
  assert.equal(fetched.title, "我的重要研究会话");
  assert.equal(fetched.snapshot.cards[0].draft, "最新编写的草稿内容");
});

// =========================================================================
// 5. 会话删除 (remove) 与原子替换机制
// =========================================================================

test("remove: 删除非 active 会话，保持 activeId 且返回完整 session 克隆", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const locks = createFakeLocks();
  let idGen = 0;
  const store = createForkSessionStore(hana, { locks, idFactory: () => `s-${++idGen}` });

  const snapA = createValidSnapshot({ cards: [{ id: "c-a", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话A" }] }] });
  const snapB = createValidSnapshot({ cards: [{ id: "c-b", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话B" }] }] });
  const snapC = createValidSnapshot({ cards: [{ id: "c-c", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话C" }] }] });

  const recA = await store.ensure(snapA);
  const recB = await store.create(snapB);
  const recC = await store.create(snapC);

  // 将 active 切换为 A
  await store.activate(recA.id);
  let list = await store.list();
  assert.equal(list.activeId, recA.id);
  assert.equal(list.sessions.length, 3);

  // 删除非 active 的会话 B
  const removeRes = await store.remove(recB.id, recB.revision);
  assert.equal(removeRes.deletedId, recB.id);
  assert.equal(removeRes.activeId, recA.id);
  assert.equal(removeRes.session.id, recA.id);
  // 深克隆隔离断言
  removeRes.session.title = "被篡改的标题";
  const refA = await store.get(recA.id);
  assert.equal(refA.title, recA.title);

  // 验证列表中只剩 A 和 C，B 已移除，且 activeId 保持 A
  list = await store.list();
  assert.equal(list.activeId, recA.id);
  assert.equal(list.sessions.length, 2);
  assert.deepEqual(list.sessions.map((s) => s.id), [recA.id, recC.id]);
});

test("remove: 删除全局 active 会话，自动选择剩余中最近 updatedAt 记录", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const locks = createFakeLocks();
  let time = 100;
  let idGen = 0;
  const store = createForkSessionStore(hana, {
    locks,
    now: () => ++time,
    idFactory: () => `s-${++idGen}`,
  });

  const snapA = createValidSnapshot({ cards: [{ id: "c-a", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话A" }] }] });
  const snapB = createValidSnapshot({ cards: [{ id: "c-b", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话B" }] }] });
  const snapC = createValidSnapshot({ cards: [{ id: "c-c", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话C" }] }] });

  const recA = await store.ensure(snapA);
  const recB = await store.create(snapB);
  const recC = await store.create(snapC);

  // 更新会话 B，使其 updatedAt 最新
  time = 500;
  const savedB = await store.save(recB.id, recB.revision, snapB);

  // 此时将 active 设为 A
  await store.activate(recA.id);
  let list = await store.list();
  assert.equal(list.activeId, recA.id);

  // 删除当前处于 active 状态的会话 A
  const removeRes = await store.remove(recA.id, recA.revision);
  assert.equal(removeRes.deletedId, recA.id);
  // 在剩余的 B 和 C 中，B 的 updatedAt(501) > C 的 updatedAt(103)，所以应自动选 B
  assert.equal(removeRes.activeId, recB.id);
  assert.equal(removeRes.session.id, recB.id);
  assert.equal(removeRes.session.updatedAt, savedB.updatedAt);

  list = await store.list();
  assert.equal(list.activeId, recB.id);
  assert.equal(list.sessions.length, 2);
  assert.deepEqual(list.sessions.map((s) => s.id), [recB.id, recC.id]);
});

test("remove: 删除最后一个会话原子替换新建空白会话，同一事务无中间空库，异常不破坏旧数据", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const locks = createFakeLocks();
  let idGen = 0;
  const store = createForkSessionStore(hana, { locks, idFactory: () => `s-${++idGen}` });

  const snapOnly = createValidSnapshot({ cards: [{ id: "c-1", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "唯一会话" }] }] });
  const rec = await store.ensure(snapOnly);
  const dataBefore = JSON.parse(JSON.stringify(storage._getRaw()));

  // 1. fallbackSnapshot 损坏或非法时抛出 INVALID_SESSION_SNAPSHOT，旧会话不落盘不删除
  await assert.rejects(
    () => store.remove(rec.id, rec.revision, { invalid: "broken snapshot" }),
    (err) => err.code === "INVALID_SESSION_SNAPSHOT"
  );
  assert.deepEqual(storage._getRaw(), dataBefore);

  // 2. 传入合法 fallbackSnapshot 执行原子删除与替换新建
  const fallback = createValidSnapshot({
    cards: [
      {
        id: "c-fallback",
        parentId: null,
        x: 0,
        y: 0,
        width: 320,
        draft: "",
        messages: [{ role: "user", text: "新空白画布首问" }],
      },
    ],
  });

  const removeRes = await store.remove(rec.id, rec.revision, fallback);
  assert.equal(removeRes.deletedId, rec.id);
  assert.notEqual(removeRes.activeId, rec.id);
  assert.equal(removeRes.session.id, removeRes.activeId);
  assert.equal(removeRes.session.title, "新空白画布首问");
  assert.equal(removeRes.session.revision, 1);
  assert.equal(removeRes.session.manualTitle, false);

  // 验证当前库中恰有 1 条新会话，且 activeId 严密一致
  const list = await store.list();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.activeId, removeRes.activeId);
  assert.equal(list.sessions[0].id, removeRes.activeId);
});

test("remove: 旧 revision 不能删抛 SESSION_CONFLICT，不存在会话抛 SESSION_NOT_FOUND", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const locks = createFakeLocks();
  const store = createForkSessionStore(hana, { locks });

  const snap = createValidSnapshot();
  const rec = await store.ensure(snap);
  const saved = await store.save(rec.id, 1, snap);
  assert.equal(saved.revision, 2);

  // 1. 使用旧 revision (1) 尝试删除，被 SESSION_CONFLICT 拦截
  await assert.rejects(
    () => store.remove(rec.id, 1, snap),
    (err) => err.code === "SESSION_CONFLICT"
  );

  // 2. 尝试删除不存在的 session ID，抛 SESSION_NOT_FOUND
  await assert.rejects(
    () => store.remove("non-existent-sess", 1, snap),
    (err) => err.code === "SESSION_NOT_FOUND"
  );

  // 验证会话依然完好保留
  const fetched = await store.get(rec.id);
  assert.equal(fetched.revision, 2);
});

test("remove: storage.set 失败不丢失原库数据", async () => {
  const storage = createFakeStorage();
  let failWrite = false;
  const wrappedStorage = {
    ...storage,
    async set(key, value) {
      if (failWrite) {
        throw new Error("DISK_WRITE_FAILED");
      }
      return await storage.set(key, value);
    },
  };

  const hana = { storage: { global: wrappedStorage } };
  const locks = createFakeLocks();
  const store = createForkSessionStore(hana, { locks });

  const snapA = createValidSnapshot({ cards: [{ id: "c-a", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话A" }] }] });
  const snapB = createValidSnapshot({ cards: [{ id: "c-b", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话B" }] }] });

  const recA = await store.ensure(snapA);
  const recB = await store.create(snapB);

  const rawBefore = JSON.parse(JSON.stringify(storage._getRaw()));

  // 注入 set 失败
  failWrite = true;
  await assert.rejects(
    () => store.remove(recA.id, recA.revision),
    (err) => err.message === "DISK_WRITE_FAILED"
  );

  // 恢复并检查原库数据完全未受损
  failWrite = false;
  assert.deepEqual(storage._getRaw(), rawBefore);
  const list = await store.list();
  assert.equal(list.sessions.length, 2);
  assert.deepEqual(list.sessions.map((s) => s.id), [recA.id, recB.id]);
});

test("remove 与 save 协同：删除后 save 不能复活", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const locks = createFakeLocks();
  const store = createForkSessionStore(hana, { locks });

  const snapA = createValidSnapshot({ cards: [{ id: "c-a", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话A" }] }] });
  const snapB = createValidSnapshot({ cards: [{ id: "c-b", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "会话B" }] }] });

  const recA = await store.ensure(snapA);
  const recB = await store.create(snapB);

  // 删除会话 B
  await store.remove(recB.id, recB.revision);

  // 尝试对其执行 save
  await assert.rejects(
    () => store.save(recB.id, recB.revision, snapB),
    (err) => err.code === "SESSION_NOT_FOUND"
  );

  // 验证列表中依然只有 A，B 绝未复活
  const list = await store.list();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].id, recA.id);
});

test("并发一致性：create 与 remove 并发排队执行不覆盖，状态最终一致", async () => {
  const storage = createFakeStorage();
  const hana = { storage: { global: storage } };
  const sharedLocks = createFakeLocks();
  let idGen = 0;
  const store1 = createForkSessionStore(hana, { locks: sharedLocks, idFactory: () => `sess-${++idGen}` });
  const store2 = createForkSessionStore(hana, { locks: sharedLocks, idFactory: () => `sess-${++idGen}` });

  const snap1 = createValidSnapshot({ cards: [{ id: "c-1", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "初始会话1" }] }] });
  const snap2 = createValidSnapshot({ cards: [{ id: "c-2", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "初始会话2" }] }] });
  const rec1 = await store1.ensure(snap1);
  const rec2 = await store1.create(snap2);

  const snap3 = createValidSnapshot({ cards: [{ id: "c-3", parentId: null, x: 0, y: 0, width: 300, messages: [{ role: "user", text: "并发创建会话3" }] }] });

  // 模拟并发调用：窗口1删除 rec1，窗口2同时创建新会话 snap3
  const [delRes, createRes] = await Promise.all([
    store1.remove(rec1.id, rec1.revision),
    store2.create(snap3),
  ]);

  assert.equal(delRes.deletedId, rec1.id);
  assert.ok(createRes.id);

  // 最终状态验证：rec1 必被成功删除，snap3 必已存在，rec2 完好无损
  const list = await store1.list();
  const ids = list.sessions.map((s) => s.id);
  assert.equal(ids.includes(rec1.id), false);
  assert.equal(ids.includes(rec2.id), true);
  assert.equal(ids.includes(createRes.id), true);
  assert.equal(list.sessions.length, 2);
  // activeId 必须是合法且现存的会话
  assert.equal(ids.includes(list.activeId), true);
});
