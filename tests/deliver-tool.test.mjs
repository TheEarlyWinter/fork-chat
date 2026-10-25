import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DELIVER_DOCUMENT_TOOL, createDeliverDocumentExecutor, MAX_DOCUMENT_BYTES, MAX_FILENAME_LENGTH,
} from '../lib/deliver-tool.js';
import { runToolLoop } from '../lib/tool-loop.js';

async function sandbox() {
  const dir = await mkdtemp(path.join(tmpdir(), 'deliver-tool-'));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

async function rejectsWithCode(fn, code) {
  try {
    await fn();
  } catch (error) {
    assert.equal(error.code, code, `期望 ${code}，实际 ${error.code || error.message}`);
    return error;
  }
  throw new Error(`本该抛 ${code}，却成功了`);
}

test('the tool declares both arguments as required', () => {
  assert.equal(DELIVER_DOCUMENT_TOOL.name, 'deliver_document');
  assert.deepEqual(DELIVER_DOCUMENT_TOOL.parameters.required, ['filename', 'content']);
  assert.equal(DELIVER_DOCUMENT_TOOL.parameters.properties.filename.type, 'string');
  assert.equal(DELIVER_DOCUMENT_TOOL.parameters.properties.content.type, 'string');
});

test('a valid document is written and staged into the session', async () => {
  const box = await sandbox();
  const staged = [];
  const deliver = createDeliverDocumentExecutor({
    dataDir: box.dir, sessionId: 'sess-1',
    stageFile: async args => { staged.push(args); return { ok: true }; },
  });
  try {
    const result = await deliver({ filename: '备忘.md', content: '# 标题\n\n正文' });
    assert.equal(result.delivered, true);
    assert.equal(result.name, '备忘.md');
    assert.equal(result.bytes, Buffer.byteLength('# 标题\n\n正文', 'utf8'));
    assert.equal(await readFile(result.path, 'utf8'), '# 标题\n\n正文');

    assert.equal(staged.length, 1);
    assert.equal(staged[0].path, result.path);
    assert.equal(staged[0].sessionId, 'sess-1');
    assert.equal(staged[0].name, '备忘.md');
    assert.equal(staged[0].mime, 'text/markdown');
    assert.equal(staged[0].deliverAs, 'attachment');
    assert.equal(staged[0].scope, 'all');
  } finally {
    await box.done();
  }
});

test('the written file stays inside the app data directory', async () => {
  const box = await sandbox();
  const deliver = createDeliverDocumentExecutor({
    dataDir: box.dir, sessionId: 'sess-1', stageFile: async () => ({}),
  });
  try {
    const result = await deliver({ filename: 'a.md', content: 'x' });
    assert.equal(path.dirname(path.dirname(result.path)), box.dir);
    const mode = (await stat(result.path)).mode & 0o777;
    assert.equal(mode, 0o600, '交付文件不该对同组其他用户可读');
  } finally {
    await box.done();
  }
});

test('bad file names are refused before anything touches disk', async () => {
  const box = await sandbox();
  const deliver = createDeliverDocumentExecutor({
    dataDir: box.dir, sessionId: 'sess-1', stageFile: async () => ({}),
  });
  try {
    await rejectsWithCode(() => deliver({ content: 'x' }), 'INVALID_FILENAME');
    await rejectsWithCode(() => deliver({ filename: '', content: 'x' }), 'INVALID_FILENAME');
    await rejectsWithCode(() => deliver({ filename: 'a.txt', content: 'x' }), 'INVALID_FILENAME');
    await rejectsWithCode(() => deliver({ filename: 'x'.repeat(MAX_FILENAME_LENGTH) + '.md', content: 'x' }), 'INVALID_FILENAME');
    await rejectsWithCode(() => deliver({ filename: 'a/b.md', content: 'x' }), 'INVALID_FILENAME');
    await rejectsWithCode(() => deliver({ filename: 'a b.md', content: 'x' }), 'INVALID_FILENAME');
    // 目录不该被创建
    await assert.rejects(() => readdir(path.join(box.dir, 'deliver-export')));
  } finally {
    await box.done();
  }
});

test('empty or oversized content is refused', async () => {
  const box = await sandbox();
  const deliver = createDeliverDocumentExecutor({
    dataDir: box.dir, sessionId: 'sess-1', stageFile: async () => ({}),
  });
  try {
    await rejectsWithCode(() => deliver({ filename: 'a.md' }), 'INVALID_CONTENT');
    await rejectsWithCode(() => deliver({ filename: 'a.md', content: '' }), 'INVALID_CONTENT');
    await rejectsWithCode(() => deliver({ filename: 'a.md', content: 42 }), 'INVALID_CONTENT');
    await rejectsWithCode(
      () => deliver({ filename: 'a.md', content: 'x'.repeat(MAX_DOCUMENT_BYTES + 1) }),
      'INVALID_CONTENT',
    );
  } finally {
    await box.done();
  }
});

test('a failed staging call cleans up the temporary file', async () => {
  const box = await sandbox();
  const deliver = createDeliverDocumentExecutor({
    dataDir: box.dir, sessionId: 'sess-1',
    stageFile: async () => { throw new Error('宿主拒绝'); },
  });
  try {
    await assert.rejects(() => deliver({ filename: 'a.md', content: 'x' }), /宿主拒绝/);
    const left = await readdir(path.join(box.dir, 'deliver-export'));
    assert.deepEqual(left, [], '投递失败后不该留下孤儿文件');
  } finally {
    await box.done();
  }
});

test('a missing stageFile is refused at construction time', () => {
  assert.throws(() => createDeliverDocumentExecutor({ dataDir: '/tmp', sessionId: 's' }), TypeError);
  assert.throws(() => createDeliverDocumentExecutor({ dataDir: '/tmp', sessionId: 's', stageFile: 'nope' }), TypeError);
});

test('a missing dataDir is refused at construction time', () => {
  const stageFile = async () => ({});
  assert.throws(() => createDeliverDocumentExecutor({ stageFile }), TypeError);
  assert.throws(() => createDeliverDocumentExecutor({ dataDir: '', stageFile }), TypeError);
});

test('without a session id the host picks the calling session', async () => {
  const box = await sandbox();
  const staged = [];
  const deliver = createDeliverDocumentExecutor({
    dataDir: box.dir, stageFile: async args => { staged.push(args); return {}; },
  });
  try {
    await deliver({ filename: 'a.md', content: 'x' });
    assert.equal('sessionId' in staged[0], false, '不该凭空塞一个宿主不认识的身份');
  } finally {
    await box.done();
  }
});

// 这条是给那个真机上翻过的坑上的锁：循环交过来的是完整调用记录，
// 执行器只认工具参数，中间的适配层一旦漏了，filename 永远是 undefined。
test('the loop hands tool arguments through to the executor unchanged', async () => {
  const box = await sandbox();
  const deliver = createDeliverDocumentExecutor({
    dataDir: box.dir, sessionId: 'sess-1', stageFile: async () => ({}),
  });
  const models = {
    streamEvents() {
      let round = 0;
      return (async function* () {
        round += 1;
        if (round === 1) {
          yield {
            type: 'tool-call', id: 't1', name: 'deliver_document',
            arguments: { filename: '链路.md', content: '从模型到磁盘' },
          };
          yield { type: 'done', stopReason: 'toolUse', assistant: { role: 'assistant', content: [] } };
        } else {
          yield { type: 'text-delta', delta: '好了' };
          yield { type: 'done', stopReason: 'stop', assistant: { role: 'assistant', content: [{ type: 'text', text: '好了' }] } };
        }
      })();
    },
  };
  const events = [];
  try {
    for await (const event of runToolLoop({
      models,
      input: { messages: [{ role: 'user', content: '给我个文件' }] },
      tools: [DELIVER_DOCUMENT_TOOL],
      // 与 chat.js 里一模一样的适配方式
      executeTool: call => deliver(call?.arguments || {}),
      signal: new AbortController().signal,
    })) events.push(event);

    const result = events.find(e => e.type === 'tool-result');
    assert.equal(result.ok, true, `交付应当成功，实际：${JSON.stringify(result.result)}`);
    assert.equal(result.result.name, '链路.md');
    assert.equal(await readFile(result.result.path, 'utf8'), '从模型到磁盘');
  } finally {
    await box.done();
  }
});
