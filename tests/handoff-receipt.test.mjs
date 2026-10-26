import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { HANDOFF_LIMITS } from '../ui/assets/fork-handoff-contract.js';
import {
  HANDOFF_RECEIPT_CODES,
  HANDOFF_VIEW_VERSION,
  createHandoffReceiptReader,
  createHandoffViewDetails,
} from '../lib/handoff-receipt-view.js';

// 交接卡只读投影：宿主 get/entries 的真实 DTO 形状（{session} / {sessionId,entries,leafId}）
// 加当前 owner 的动作记录，作为旧消息的唯一回退依据。
const OWNER = JSON.stringify(['timeline-reverser', 'authenticated', 'user-1']);
const OTHER_OWNER = JSON.stringify(['timeline-reverser', 'authenticated', 'user-2']);
const SESSION = 'sess_home_1';
const CUSTOM_TYPE = 'app:timeline-reverser/branch-handoff';
const ARTIFACT_FILE = { fileId: 'sf_report_1', name: '报告.md', mime: 'text/markdown', kind: 'artifact', artifactId: 'a'.repeat(32) };
const ARCHIVE_FILE = { fileId: 'sf_archive_1', name: 'handoff.md', mime: 'text/markdown', kind: 'archive' };
const SOURCE = { canvasId: 'canvas-1', revision: 'rev-1', targetCardId: 'card-1' };

const ownerScopeKey = owner => createHash('sha256').update(owner).digest('hex');

function viewDetails({ owner = OWNER, agentId = 'agent-a', files = [ARTIFACT_FILE, ARCHIVE_FILE] } = {}) {
  return createHandoffViewDetails({ owner, agentId, files });
}

function entry({ id, parentId = null, content = '交接正文：继续处理。', details, display = true, customType = CUSTOM_TYPE, type = 'custom_message' } = {}) {
  return {
    id,
    parentId,
    timestamp: '2026-10-26T00:00:00.000Z',
    type,
    ...(customType === null ? {} : { customType }),
    ...(type === 'custom_message' ? { content, display, ...(details === undefined ? {} : { details }) } : { message: { role: 'user', content: [] } }),
  };
}

function sessionMeta(overrides = {}) {
  return {
    sessionId: SESSION,
    namespace: 'home',
    visibility: 'public',
    ownerPluginId: 'timeline-reverser',
    lifecycle: 'active',
    archivedAt: null,
    path: 'home',
    ...overrides,
  };
}

function fakeSdk({ session = sessionMeta(), entries = [], leafId, getError = null, entriesError = null } = {}) {
  const calls = { get: 0, entries: 0, inputs: [] };
  return {
    calls,
    sessions: {
      async get(input) {
        calls.get += 1;
        calls.inputs.push(input);
        if (getError) throw getError;
        const value = typeof session === 'function' ? session(input) : session;
        return { session: value ? { ...value } : null };
      },
      async entries(input) {
        calls.entries += 1;
        calls.inputs.push(input);
        if (entriesError) throw entriesError;
        const leaf = leafId === undefined ? (entries.at(-1)?.id ?? null) : leafId;
        return { sessionId: input.sessionId, entries, leafId: leaf };
      },
    },
  };
}

function fakeStore(actions = []) {
  const calls = [];
  return {
    calls,
    async list({ owner }) {
      calls.push(owner);
      return actions;
    },
  };
}

async function errorCodeOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error?.code ?? error?.name ?? 'unknown';
  }
}

// ---------------------------------------------------------------------------
// view 元数据：服务端 owner 指纹 + 安全文件回执
// ---------------------------------------------------------------------------

test('createHandoffViewDetails stamps the server owner hash and only safe file receipts', () => {
  const view = viewDetails();
  assert.equal(view.version, HANDOFF_VIEW_VERSION);
  assert.equal(view.agentId, 'agent-a');
  assert.equal(view.ownerScopeKey, ownerScopeKey(OWNER));
  // 指纹不含 owner 原文，也不含动作标识
  assert.equal(JSON.stringify(view).includes('user-1'), false);
  assert.deepEqual(view.files.map(file => [file.fileId, file.name, file.mime, file.kind]), [
    ['sf_report_1', '报告.md', 'text/markdown', 'artifact'],
    ['sf_archive_1', 'handoff.md', 'text/markdown', 'archive'],
  ]);
  // 产物私有字段（artifactId）不进入给宿主持久化的视图元数据
  assert.equal('artifactId' in view.files[0], false);
});

test('createHandoffViewDetails refuses unsafe receipts, path-like ids and unknown kinds', () => {
  for (const files of [
    [{ fileId: '../escape', name: 'x.md', mime: 'text/markdown', kind: 'artifact' }],
    [{ fileId: 'sf_1', name: 'x.md', mime: 'text/markdown', kind: 'command' }],
    [{ fileId: 'sf_1', name: '', mime: 'text/markdown', kind: 'artifact' }],
    [{ fileId: 'sf_1', name: 'x.md', mime: 'not-a-mime', kind: 'artifact' }],
    [{ fileId: 'sf_1', name: 'x.md', mime: 'text/markdown' }],
    [{ fileId: 'sf_1', name: 'x.md', mime: 'text/markdown', kind: 'archive', artifactId: 'a'.repeat(32) }],
  ]) {
    assert.throws(() => createHandoffViewDetails({ owner: OWNER, agentId: 'agent-a', files }), /文件|回执|kind/i);
  }
  assert.throws(() => createHandoffViewDetails({ owner: '', agentId: 'agent-a', files: [] }));
  assert.throws(() => createHandoffViewDetails({ owner: OWNER, agentId: '', files: [] }));
  // 上限是 16 个原产物 + 1 个 archive；再多一个就拒绝（不截断）
  const tooMany = Array.from({ length: HANDOFF_LIMITS.maxArtifacts + 2 }, (_, index) => ({
    fileId: `sf_${index}`, name: `f${index}.md`, mime: 'text/markdown', kind: 'artifact',
  }));
  assert.throws(() => createHandoffViewDetails({ owner: OWNER, agentId: 'agent-a', files: tooMany }));
});

// ---------------------------------------------------------------------------
// 新消息：正文来自宿主 entry，不依赖动作 payload / Store
// ---------------------------------------------------------------------------

test('a stamped message is readable with an empty store, using only the host entries', async () => {
  const content = '## 交接正文\n\n完整历史与下一步要求。';
  const entries = [
    entry({ id: 'root', type: 'message', customType: null }),
    entry({ id: 'handoff-1', parentId: 'root', content, details: { actionId: 'ha_' + 'b'.repeat(32), source: SOURCE, handoffView: viewDetails() } }),
  ];
  const sdk = fakeSdk({ entries });
  const store = fakeStore([]);
  const reader = createHandoffReceiptReader({ sdk, store });

  const receipt = await reader.read({ owner: OWNER, sessionId: SESSION });
  assert.equal(receipt.sessionId, SESSION);
  assert.equal(receipt.transcript, content);
  assert.equal(receipt.agentId, 'agent-a');
  assert.equal(receipt.actionId, 'ha_' + 'b'.repeat(32));
  assert.deepEqual(receipt.source, SOURCE);
  assert.deepEqual(receipt.files.map(file => [file.fileId, file.name, file.mime, file.kind]), [
    ['sf_report_1', '报告.md', 'text/markdown', 'artifact'],
    ['sf_archive_1', 'handoff.md', 'text/markdown', 'archive'],
  ]);
  assert.equal(store.calls.length, 0, '新元数据不应回查动作记录');
  assert.deepEqual(sdk.calls.inputs, [{ sessionId: SESSION, scope: 'all' }, { sessionId: SESSION, scope: 'all' }]);
});

test('a foreign owner is refused instead of borrowing the stamped message', async () => {
  const entries = [entry({ id: 'h1', content: '私有正文', details: { handoffView: viewDetails() } })];
  const reader = createHandoffReceiptReader({ sdk: fakeSdk({ entries }), store: fakeStore([]) });

  assert.equal(
    await errorCodeOf(reader.read({ owner: OTHER_OWNER, sessionId: SESSION })),
    HANDOFF_RECEIPT_CODES.UNAVAILABLE,
  );
  // 错误信息不得回传正文
  try {
    await reader.read({ owner: OTHER_OWNER, sessionId: SESSION });
  } catch (error) {
    assert.equal(String(error.message).includes('私有正文'), false);
  }
});

test('invalid or downgraded view metadata is refused, never treated as a legacy message', async () => {
  const badViews = [
    { ...viewDetails(), ownerScopeKey: ownerScopeKey(OTHER_OWNER), files: [] },
    { ...viewDetails(), files: [{ fileId: 'sf_1', name: 'x.md', mime: 'text/markdown', kind: 'command' }] },
    { ...viewDetails(), version: 2 },
    { ...viewDetails(), agentId: '' },
    'not-an-object',
  ];
  for (const handoffView of badViews) {
    const entries = [entry({ id: 'h1', details: { handoffView } })];
    const store = fakeStore([]);
    const reader = createHandoffReceiptReader({ sdk: fakeSdk({ entries }), store });
    assert.equal(
      await errorCodeOf(reader.read({ owner: OWNER, sessionId: SESSION })),
      HANDOFF_RECEIPT_CODES.UNAVAILABLE,
      JSON.stringify(handoffView).slice(0, 80),
    );
    assert.equal(store.calls.length, 0, '非法新元数据不得降级成旧回执路径');
  }
});

// ---------------------------------------------------------------------------
// 旧消息：仅凭当前 owner 的动作回执恢复显示
// ---------------------------------------------------------------------------

test('a legacy message without view metadata is readable only through the current owner action receipts', async () => {
  const content = '旧版交接正文';
  const entries = [entry({ id: 'legacy-1', content })];
  const actions = [{
    actionId: 'ha_' + 'c'.repeat(32),
    state: 'ready',
    sessionId: SESSION,
    entryId: 'legacy-1',
    agentId: 'agent-old',
    source: SOURCE,
    files: [{ ...ARTIFACT_FILE }, { ...ARCHIVE_FILE }],
  }];
  const store = fakeStore(actions);
  const reader = createHandoffReceiptReader({ sdk: fakeSdk({ entries }), store });

  const receipt = await reader.read({ owner: OWNER, sessionId: SESSION });
  assert.equal(receipt.transcript, content);
  assert.equal(receipt.actionId, actions[0].actionId);
  assert.equal(receipt.agentId, 'agent-old');
  assert.deepEqual(receipt.source, SOURCE);
  assert.deepEqual(receipt.files.map(file => file.kind), ['artifact', 'archive']);
  assert.deepEqual(store.calls, [OWNER]);

  // 记录已回收时明确不可用，不猜也不放宽
  const emptyReader = createHandoffReceiptReader({ sdk: fakeSdk({ entries }), store: fakeStore([]) });
  assert.equal(
    await errorCodeOf(emptyReader.read({ owner: OWNER, sessionId: SESSION })),
    HANDOFF_RECEIPT_CODES.UNAVAILABLE,
  );
  // 其它 owner 的动作不能授权这条消息
  const foreignReader = createHandoffReceiptReader({ sdk: fakeSdk({ entries }), store: fakeStore([{ ...actions[0], sessionId: 'sess_other' }]) });
  assert.equal(
    await errorCodeOf(foreignReader.read({ owner: OWNER, sessionId: SESSION })),
    HANDOFF_RECEIPT_CODES.UNAVAILABLE,
  );
});

// ---------------------------------------------------------------------------
// 活动分支、消息选择与宿主元数据
// ---------------------------------------------------------------------------

test('only the active leaf branch is projected: off-branch handoff messages are ignored', async () => {
  // root → a1（活动分支） / root → b1（被切走的支线）
  const entries = [
    entry({ id: 'root', type: 'message', customType: null }),
    entry({ id: 'a1', parentId: 'root', content: '活动分支正文', details: { handoffView: viewDetails() } }),
    entry({ id: 'b1', parentId: 'root', content: '支线正文', details: { handoffView: viewDetails() } }),
  ];
  const reader = createHandoffReceiptReader({ sdk: fakeSdk({ entries, leafId: 'a1' }), store: fakeStore([]) });
  const receipt = await reader.read({ owner: OWNER, sessionId: SESSION });
  assert.equal(receipt.transcript, '活动分支正文');

  const offBranchOnly = createHandoffReceiptReader({ sdk: fakeSdk({ entries, leafId: 'root' }), store: fakeStore([]) });
  assert.equal(
    await errorCodeOf(offBranchOnly.read({ owner: OWNER, sessionId: SESSION })),
    HANDOFF_RECEIPT_CODES.NOT_FOUND,
  );
});

test('zero candidates is not found and two authorized candidates are ambiguous', async () => {
  const none = createHandoffReceiptReader({ sdk: fakeSdk({ entries: [entry({ id: 'root', type: 'message' })] }), store: fakeStore([]) });
  assert.equal(await errorCodeOf(none.read({ owner: OWNER, sessionId: SESSION })), HANDOFF_RECEIPT_CODES.NOT_FOUND);

  const two = createHandoffReceiptReader({
    sdk: fakeSdk({
      entries: [
        entry({ id: 'h1', content: '第一次交接', details: { handoffView: viewDetails() } }),
        entry({ id: 'h2', parentId: 'h1', content: '第二次交接', details: { handoffView: viewDetails() } }),
      ],
    }),
    store: fakeStore([]),
  });
  assert.equal(await errorCodeOf(two.read({ owner: OWNER, sessionId: SESSION })), HANDOFF_RECEIPT_CODES.AMBIGUOUS);
});

test('foreign custom types, display=false and non-custom entries are never projected', async () => {
  const entries = [
    entry({ id: 'root', type: 'message', customType: null }),
    entry({ id: 'other-app', parentId: 'root', customType: 'app:someone-else/notice', details: { handoffView: viewDetails() } }),
    entry({ id: 'hidden', parentId: 'root', display: false, details: { handoffView: viewDetails() } }),
    entry({ id: 'append', parentId: 'root', type: 'custom', customType: null }),
  ];
  const reader = createHandoffReceiptReader({ sdk: fakeSdk({ entries, leafId: 'append' }), store: fakeStore([]) });
  assert.equal(await errorCodeOf(reader.read({ owner: OWNER, sessionId: SESSION })), HANDOFF_RECEIPT_CODES.NOT_FOUND);
});

test('the public home session metadata must match the requested session id exactly', async () => {
  const entries = [entry({ id: 'h1', details: { handoffView: viewDetails() } })];
  const cases = [
    sessionMeta({ sessionId: 'sess_other' }),
    sessionMeta({ namespace: 'app' }),
    sessionMeta({ visibility: 'private' }),
    sessionMeta({ ownerPluginId: 'another-app' }),
    null,
  ];
  for (const session of cases) {
    const reader = createHandoffReceiptReader({ sdk: fakeSdk({ session, entries }), store: fakeStore([]) });
    assert.equal(
      await errorCodeOf(reader.read({ owner: OWNER, sessionId: SESSION })),
      HANDOFF_RECEIPT_CODES.UNAVAILABLE,
      JSON.stringify(session),
    );
  }
  // entries 的 sessionId 回显不符同样失败关闭
  const mismatched = {
    sessions: {
      async get() { return { session: sessionMeta() }; },
      async entries() { return { sessionId: 'sess_other', entries, leafId: 'h1' }; },
    },
  };
  const reader = createHandoffReceiptReader({ sdk: mismatched, store: fakeStore([]) });
  assert.equal(await errorCodeOf(reader.read({ owner: OWNER, sessionId: SESSION })), HANDOFF_RECEIPT_CODES.UNAVAILABLE);
});

test('a broken parent chain fails closed instead of guessing the branch', async () => {
  const entries = [entry({ id: 'h1', parentId: 'missing-parent', details: { handoffView: viewDetails() } })];
  const reader = createHandoffReceiptReader({ sdk: fakeSdk({ entries, leafId: 'h1' }), store: fakeStore([]) });
  assert.equal(await errorCodeOf(reader.read({ owner: OWNER, sessionId: SESSION })), HANDOFF_RECEIPT_CODES.UNAVAILABLE);
});

test('an oversized transcript is refused, not truncated', async () => {
  const big = 'x'.repeat(HANDOFF_LIMITS.maxTranscriptBytes + 1);
  const entries = [entry({ id: 'h1', content: big, details: { handoffView: viewDetails() } })];
  const reader = createHandoffReceiptReader({ sdk: fakeSdk({ entries }), store: fakeStore([]) });
  assert.equal(await errorCodeOf(reader.read({ owner: OWNER, sessionId: SESSION })), HANDOFF_RECEIPT_CODES.UNAVAILABLE);
});

// ---------------------------------------------------------------------------
// 缓存与 inflight
// ---------------------------------------------------------------------------

test('successful receipts are cached per owner+session, failures are not', async () => {
  const entries = [entry({ id: 'h1', details: { handoffView: viewDetails() } })];
  const sdk = fakeSdk({ entries, entriesError: new Error('boom') });
  const reader = createHandoffReceiptReader({ sdk, store: fakeStore([]) });

  assert.equal(await errorCodeOf(reader.read({ owner: OWNER, sessionId: SESSION })), HANDOFF_RECEIPT_CODES.UNAVAILABLE);
  assert.equal(sdk.calls.entries, 1, '失败请求确实尝试过宿主');

  // 失败不缓存：同一绑定下一次会重新读取
  sdk.sessions.entries = async input => {
    sdk.calls.entries += 1;
    return { sessionId: input.sessionId, entries, leafId: 'h1' };
  };
  const first = await reader.read({ owner: OWNER, sessionId: SESSION });
  assert.equal(first.transcript, '交接正文：继续处理。');
  const afterSuccess = sdk.calls.entries;
  await reader.read({ owner: OWNER, sessionId: SESSION });
  assert.equal(sdk.calls.entries, afterSuccess, '成功结果必须命中缓存，不再读宿主');

  // 其它 owner 不共享缓存（并因 owner 指纹不符被拒）
  assert.equal(
    await errorCodeOf(reader.read({ owner: OTHER_OWNER, sessionId: SESSION })),
    HANDOFF_RECEIPT_CODES.UNAVAILABLE,
  );
  assert.equal(sdk.calls.entries, afterSuccess + 1, 'owner 不同必须重新计算，不共享投影');
});

test('concurrent reads of the same binding share one host fetch', async () => {
  const entries = [entry({ id: 'h1', details: { handoffView: viewDetails() } })];
  const sdk = fakeSdk({ entries });
  const reader = createHandoffReceiptReader({ sdk, store: fakeStore([]) });
  const [a, b] = await Promise.all([
    reader.read({ owner: OWNER, sessionId: SESSION }),
    reader.read({ owner: OWNER, sessionId: SESSION }),
  ]);
  assert.equal(a.transcript, b.transcript);
  assert.equal(sdk.calls.get, 1, 'inflight 去重后只读一次宿主元数据');
  assert.equal(sdk.calls.entries, 1);
});

test('the cache is bounded by entry count and drops the oldest projection', async () => {
  const sdk = fakeSdk({
    session: input => sessionMeta({ sessionId: input.sessionId }),
    entries: [entry({ id: 'h1', details: { handoffView: viewDetails() } })],
  });
  const reader = createHandoffReceiptReader({ sdk, store: fakeStore([]), maxCacheEntries: 1 });
  await reader.read({ owner: OWNER, sessionId: SESSION });
  await reader.read({ owner: OWNER, sessionId: 'sess_home_2' });
  const before = sdk.calls.entries;
  await reader.read({ owner: OWNER, sessionId: SESSION });
  assert.equal(sdk.calls.entries, before + 1, '超过上限后最旧投影被丢弃并重读');
});
