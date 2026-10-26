import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HANDOFF_FILE_PREVIEW_CODES,
  HANDOFF_FILE_PREVIEW_LIMITS,
  createHandoffFilePreviewReader,
} from '../lib/handoff-file-preview.js';

// 生产 session-file ResourceIO 的真实形状（bundle resolver/stat/read 已亲核）：
// stat → {resourceKey, resource, exists, isDirectory, version:{mtimeMs,size}, filePath}
// read → {resourceKey, resource, content: Buffer, version, filePath}
// resource 回显输入的 sessionId/fileId，因此 fixture 必须回显，不能用宽松假成功。
const OWNER = JSON.stringify(['timeline-reverser', 'authenticated', 'user-1']);
const SESSION = 'sess_home_1';
const MD_ID = 'sf_md_1';
const TXT_ID = 'sf_txt_1';
const PDF_ID = 'sf_pdf_1';
const MD_TEXT = '# 报告\n\n- 一\n- 二\n\n**粗体**与 `code`。\n';
const TXT_TEXT = '纯文本第一行\n第二行\n';

function resourceOf(ref, displayName = 'file') {
  return {
    kind: 'session-file',
    fileId: ref.fileId,
    ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
    provider: 'session_file',
    filePath: '/home/somebody/.hanako/session-files/payload/file',
    displayName,
  };
}

function filesFixture(overrides = {}) {
  return {
    [MD_ID]: { name: '报告.md', mime: 'text/markdown', bytes: Buffer.from(MD_TEXT, 'utf8'), ...overrides[MD_ID] },
    [TXT_ID]: { name: 'notes.txt', mime: 'text/plain', bytes: Buffer.from(TXT_TEXT, 'utf8'), ...overrides[TXT_ID] },
    [PDF_ID]: { name: 'report.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF-1.4', 'utf8'), ...overrides[PDF_ID] },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => ![MD_ID, TXT_ID, PDF_ID].includes(key))),
  };
}

function fakeResources(files) {
  const calls = { stat: [], read: [] };
  return {
    calls,
    async stat(ref) {
      calls.stat.push(ref);
      const entry = files[ref.fileId];
      if (!entry) {
        const error = new Error('session file not found');
        error.code = 'resource_not_found';
        error.status = 404;
        throw error;
      }
      const base = {
        resourceKey: `session-file:${ref.fileId}`,
        resource: entry.statResource ? entry.statResource(ref) : resourceOf(ref, entry.name),
        exists: entry.exists !== false,
        isDirectory: entry.isDirectory === true,
        version: { mtimeMs: 1700000000000, size: entry.statSize ?? entry.bytes.length },
        filePath: '/home/somebody/.hanako/session-files/payload/file',
      };
      // 可选：整体改写 stat 回执，用于验证元数据不完整时 fail closed
      if (typeof entry.stat === 'function') return entry.stat(base);
      return base;
    },
    async read(ref) {
      calls.read.push(ref);
      const entry = files[ref.fileId];
      if (!entry) {
        const error = new Error('session file not found');
        error.code = 'resource_not_found';
        error.status = 404;
        throw error;
      }
      if (entry.readError) throw entry.readError;
      return {
        resourceKey: `session-file:${ref.fileId}`,
        resource: entry.readResource ? entry.readResource(ref) : resourceOf(ref, entry.name),
        content: entry.readContent ? entry.readContent(entry.bytes) : entry.bytes,
        version: { mtimeMs: 1700000000000, size: entry.bytes.length },
        filePath: '/home/somebody/.hanako/session-files/payload/file',
      };
    },
  };
}

function receiptReader(result) {
  const calls = [];
  return {
    calls,
    async read(input) {
      calls.push(input);
      if (result instanceof Error) throw result;
      return { ...result, files: result.files };
    },
  };
}

function receiptWith(files) {
  return {
    sessionId: SESSION,
    actionId: 'ha_' + 'b'.repeat(32),
    agentId: 'agent-a',
    source: null,
    transcript: '正文',
    files,
  };
}

function makeReader({ files = filesFixture(), receipts } = {}) {
  const resources = fakeResources(files);
  const reader = createHandoffFilePreviewReader({
    sdk: { resources },
    receiptReader: receiptReader(receipts ?? receiptWith([
      { fileId: MD_ID, name: '报告.md', mime: 'text/markdown', kind: 'artifact' },
      { fileId: TXT_ID, name: 'notes.txt', mime: 'text/plain', kind: 'archive' },
      { fileId: PDF_ID, name: 'report.pdf', mime: 'application/pdf', kind: 'artifact' },
    ])),
  });
  return { reader, resources };
}

async function errorOf(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return { code: error?.code, message: String(error?.message || '') };
  }
}

// ---------------------------------------------------------------------------
// 正常读取
// ---------------------------------------------------------------------------

test('markdown files are read through the official ResourceIO with the stable sessionId only', async () => {
  const { reader, resources } = makeReader();
  const preview = await reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });

  assert.equal(preview.fileId, MD_ID);
  assert.equal(preview.name, '报告.md');
  assert.equal(preview.mime, 'text/markdown');
  assert.equal(preview.format, 'markdown');
  assert.equal(preview.text, MD_TEXT, '原文必须完整，不截断');
  assert.match(preview.html, /<h1>报告<\/h1>/);
  assert.match(preview.html, /<li>一<\/li>/);
  assert.match(preview.html, /<strong>粗体<\/strong>/);

  for (const ref of [...resources.calls.stat, ...resources.calls.read]) {
    assert.deepEqual(Object.keys(ref).sort(), ['fileId', 'kind', 'sessionId'], '引用只用 kind/sessionId/fileId');
    assert.equal(ref.kind, 'session-file');
    assert.equal(ref.sessionId, SESSION);
    assert.equal(ref.fileId, MD_ID);
  }
  assert.equal(resources.calls.stat.length, 1);
  assert.equal(resources.calls.read.length, 1);
});

test('plain text previews without html and MIME parameters or case are ignored', async () => {
  const { reader } = makeReader({
    receipts: receiptWith([
      { fileId: TXT_ID, name: 'notes.txt', mime: 'Text/Plain; charset=utf-8', kind: 'archive' },
    ]),
  });
  const preview = await reader.read({ owner: OWNER, sessionId: SESSION, fileId: TXT_ID });
  assert.equal(preview.format, 'text');
  assert.equal(preview.text, TXT_TEXT);
  assert.equal('html' in preview, false);

  const upper = makeReader({
    receipts: receiptWith([{ fileId: MD_ID, name: '报告.md', mime: 'TEXT/MARKDOWN', kind: 'artifact' }]),
  });
  const md = await upper.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });
  assert.equal(md.format, 'markdown');
});

test('an empty markdown file is displayed as empty text instead of failing', async () => {
  const { reader } = makeReader({
    files: filesFixture({ [MD_ID]: { name: '空.md', mime: 'text/markdown', bytes: Buffer.alloc(0) } }),
  });
  const preview = await reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });
  assert.equal(preview.text, '');
  assert.equal(preview.format, 'markdown');
  assert.equal(preview.html, undefined);
});

// ---------------------------------------------------------------------------
// 归属与形态
// ---------------------------------------------------------------------------

test('a fileId outside the receipt is refused before any ResourceIO call', async () => {
  const { reader, resources } = makeReader();
  const error = await errorOf(reader.read({ owner: OWNER, sessionId: SESSION, fileId: 'sf_unknown' }));
  assert.equal(error.code, HANDOFF_FILE_PREVIEW_CODES.NOT_FOUND);
  assert.equal(resources.calls.stat.length, 0);
  assert.equal(resources.calls.read.length, 0);
});

test('an unsupported mime is refused without reading bytes', async () => {
  const { reader, resources } = makeReader();
  const error = await errorOf(reader.read({ owner: OWNER, sessionId: SESSION, fileId: PDF_ID }));
  assert.equal(error.code, HANDOFF_FILE_PREVIEW_CODES.UNSUPPORTED);
  assert.equal(resources.calls.read.length, 0);
  assert.equal(resources.calls.stat.length, 0);
});

test('receipt ownership failures pass through and never touch ResourceIO', async () => {
  const notFound = new Error('该会话没有交接记录');
  notFound.code = 'HANDOFF_RECEIPT_NOT_FOUND';
  const { reader, resources } = makeReader({ receipts: notFound });
  const error = await errorOf(reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(error.code, 'HANDOFF_RECEIPT_NOT_FOUND');
  assert.equal(resources.calls.stat.length, 0);

  const foreign = makeReader({ receipts: receiptWith([{ fileId: MD_ID, name: '报告.md', mime: 'text/markdown', kind: 'artifact' }]) });
  const preview = await foreign.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });
  assert.equal(preview.fileId, MD_ID);
});

// ---------------------------------------------------------------------------
// stat / read 边界
// ---------------------------------------------------------------------------

test('stat decides existence, file kind and the 2 MiB limit before read', async () => {
  const cases = [
    [{ exists: false }, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE],
    [{ isDirectory: true }, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE],
    [{ statSize: HANDOFF_FILE_PREVIEW_LIMITS.maxFileBytes + 1 }, HANDOFF_FILE_PREVIEW_CODES.TOO_LARGE],
  ];
  for (const [override, expected] of cases) {
    const { reader, resources } = makeReader({ files: filesFixture({ [MD_ID]: { name: '报告.md', mime: 'text/markdown', ...override } }) });
    const error = await errorOf(reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
    assert.equal(error.code, expected, JSON.stringify(override));
    assert.equal(resources.calls.read.length, 0, 'stat 拒绝后不得 read');
  }
});

test('a stat resource whose identity does not echo the request is refused', async () => {
  // 让 stat 回显别的会话/别的 kind：生产 _he 会原样回显输入，这里模拟被替换的资源
  const mismatched = makeReader();
  const originalStat = mismatched.resources.stat;
  mismatched.resources.stat = async ref => {
    const result = await originalStat(ref);
    return { ...result, resource: { ...result.resource, sessionId: 'sess_other' } };
  };
  const error = await errorOf(mismatched.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(error.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
  assert.equal(mismatched.resources.calls.read.length, 0);

  const kindMismatch = makeReader();
  const stat = kindMismatch.resources.stat;
  kindMismatch.resources.stat = async ref => {
    const result = await stat(ref);
    return { ...result, resource: { ...result.resource, kind: 'local-file' } };
  };
  const kindError = await errorOf(kindMismatch.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(kindError.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
});

test('incomplete or malformed stat metadata fails closed before any read', async () => {
  const variants = [
    ['missing isDirectory', base => {
      const { isDirectory, ...rest } = base;
      return rest;
    }],
    ['null isDirectory', base => ({ ...base, isDirectory: null })],
    ['string isDirectory', base => ({ ...base, isDirectory: 'false' })],
    ['missing version', base => {
      const { version, ...rest } = base;
      return rest;
    }],
    ['null version', base => ({ ...base, version: null })],
    ['missing size', base => ({ ...base, version: { mtimeMs: base.version.mtimeMs } })],
    ['negative size', base => ({ ...base, version: { ...base.version, size: -1 } })],
    ['fractional size', base => ({ ...base, version: { ...base.version, size: 1.5 } })],
    ['NaN size', base => ({ ...base, version: { ...base.version, size: Number.NaN } })],
    ['string size', base => ({ ...base, version: { ...base.version, size: '12' } })],
    ['missing exists', base => {
      const { exists, ...rest } = base;
      return rest;
    }],
    ['string exists', base => ({ ...base, exists: 'true' })],
    ['missing filePath-free result', () => null],
  ];
  for (const [label, transform] of variants) {
    const { reader, resources } = makeReader({
      files: filesFixture({ [MD_ID]: { name: '报告.md', mime: 'text/markdown', stat: transform } }),
    });
    const error = await errorOf(reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
    assert.equal(error?.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE, `${label} 必须 fail closed`);
    assert.equal(resources.calls.read.length, 0, `${label} 不得继续 read`);
  }
});

test('a stat size exactly at the limit is accepted and one byte more is too large', async () => {
  const atLimit = makeReader({
    files: filesFixture({ [MD_ID]: { name: '报告.md', mime: 'text/markdown', statSize: HANDOFF_FILE_PREVIEW_LIMITS.maxFileBytes } }),
  });
  const preview = await atLimit.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });
  assert.equal(preview.fileId, MD_ID);

  const over = makeReader({
    files: filesFixture({ [MD_ID]: { name: '报告.md', mime: 'text/markdown', statSize: HANDOFF_FILE_PREVIEW_LIMITS.maxFileBytes + 1 } }),
  });
  const tooLarge = await errorOf(over.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(tooLarge.code, HANDOFF_FILE_PREVIEW_CODES.TOO_LARGE);
  assert.equal(over.resources.calls.read.length, 0);
});

test('read content is re-checked for byte size, type and identity', async () => {
  const big = makeReader({
    files: filesFixture({
      [MD_ID]: { name: '报告.md', mime: 'text/markdown', statSize: 4, bytes: Buffer.alloc(HANDOFF_FILE_PREVIEW_LIMITS.maxFileBytes + 1, 0x61) },
    }),
  });
  const tooLarge = await errorOf(big.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(tooLarge.code, HANDOFF_FILE_PREVIEW_CODES.TOO_LARGE);

  const wrongType = makeReader({
    files: filesFixture({
      [MD_ID]: { name: '报告.md', mime: 'text/markdown', readContent: () => 'not bytes' },
    }),
  });
  const notBytes = await errorOf(wrongType.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(notBytes.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);

  const wrongIdentity = makeReader();
  const read = wrongIdentity.resources.read;
  wrongIdentity.resources.read = async ref => {
    const result = await read(ref);
    return { ...result, resource: { ...result.resource, fileId: 'sf_other' } };
  };
  const identity = await errorOf(wrongIdentity.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(identity.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
});

test('stat and read failures never leak host messages or paths', async () => {
  const statFailure = makeReader();
  statFailure.resources.stat = async () => {
    const error = new Error('resource.open could not find /home/x/secret.md in the loaded session registry');
    error.code = 'resource_not_found';
    throw error;
  };
  const statError = await errorOf(statFailure.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(statError.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
  assert.equal(statError.message.includes('/home/'), false);
  assert.equal(statError.message.includes('registry'), false);

  const readFailure = makeReader();
  readFailure.resources.read = async () => {
    const error = new Error('EACCES /home/x/secret.md');
    error.code = 'EACCES';
    throw error;
  };
  const readError = await errorOf(readFailure.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(readError.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
  assert.equal(readError.message.includes('/home/'), false);
});

// ---------------------------------------------------------------------------
// 解码与渲染回退
// ---------------------------------------------------------------------------

test('invalid UTF-8 and NUL bytes are refused instead of being replaced', async () => {
  const invalid = makeReader({
    files: filesFixture({ [MD_ID]: { name: '坏.md', mime: 'text/markdown', bytes: Buffer.from([0x23, 0x20, 0xc3, 0x28]) } }),
  });
  const invalidError = await errorOf(invalid.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(invalidError.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);

  const nul = makeReader({
    files: filesFixture({ [MD_ID]: { name: 'nul.md', mime: 'text/markdown', bytes: Buffer.from('a\u0000b', 'utf8') } }),
  });
  const nulError = await errorOf(nul.reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }));
  assert.equal(nulError.code, HANDOFF_FILE_PREVIEW_CODES.UNAVAILABLE);
});

test('markdown HTML never executes user markup and the raw text stays intact', async () => {
  const raw = '# 标题\n\n<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n[链接](javascript:alert(3))\n';
  const { reader } = makeReader({
    files: filesFixture({ [MD_ID]: { name: 'x.md', mime: 'text/markdown', bytes: Buffer.from(raw, 'utf8') } }),
  });
  const preview = await reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });
  assert.equal(preview.text, raw);
  assert.equal(/<script/i.test(preview.html), false);
  assert.equal(/<img/i.test(preview.html), false);
  const tags = [...preview.html.matchAll(/<\/?([a-zA-Z0-9]+)/g)].map(match => match[1].toLowerCase());
  const allowed = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'pre', 'code', 'strong', 'table', 'tr', 'th', 'td']);
  assert.deepEqual(tags.filter(tag => !allowed.has(tag)), [], '只允许固定标签，不生成任何属性');
  assert.equal(/\s(href|src|on\w+)="/i.test(preview.html), false, '转义后的文本不得变成属性');
  assert.ok(preview.html.includes('&lt;script&gt;'), 'HTML 必须作为文本转义显示');
  assert.ok(preview.html.includes('[链接](javascript:alert(3))'), '链接语法保持纯文本，不变成可点击属性');
});

test('an over-complex markdown falls back to the full raw text', async () => {
  const header = `| ${Array.from({ length: 21 }, (_, index) => `c${index}`).join(' | ')} |`;
  const separator = `| ${Array.from({ length: 21 }, () => '---').join(' | ')} |`;
  const raw = `${header}\n${separator}\n| ${Array.from({ length: 21 }, () => 'v').join(' | ')} |\n`;
  const { reader } = makeReader({
    files: filesFixture({ [MD_ID]: { name: 'wide.md', mime: 'text/markdown', bytes: Buffer.from(raw, 'utf8') } }),
  });
  const preview = await reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });
  assert.equal(preview.text, raw, '回退时原文仍完整');
  assert.equal('html' in preview, false);
});

test('an oversized rendered HTML falls back to the full raw text', async () => {
  // 2 MiB 以内的原文经转义后可膨胀到 4 MiB 以上的 HTML
  const raw = '<'.repeat(HANDOFF_FILE_PREVIEW_LIMITS.maxFileBytes - 16);
  const { reader } = makeReader({
    files: filesFixture({ [MD_ID]: { name: 'big.md', mime: 'text/markdown', bytes: Buffer.from(raw, 'utf8') } }),
  });
  const preview = await reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });
  assert.equal(preview.text.length, raw.length);
  assert.equal('html' in preview, false);
});

// ---------------------------------------------------------------------------
// 并发与无缓存
// ---------------------------------------------------------------------------

test('concurrent reads of the same key are merged and the slot is released afterwards', async () => {
  const { reader, resources } = makeReader();
  const [a, b] = await Promise.all([
    reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }),
    reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID }),
  ]);
  assert.equal(a.text, b.text);
  assert.equal(resources.calls.stat.length, 1, '同键并发只读一次宿主');
  assert.equal(resources.calls.read.length, 1);

  await reader.read({ owner: OWNER, sessionId: SESSION, fileId: MD_ID });
  assert.equal(resources.calls.stat.length, 2, '结束后释放，不缓存文件内容');
  assert.equal(resources.calls.read.length, 2);
});

test('at most four different files are read at once and the fifth is busy', async () => {
  const files = { ...filesFixture() };
  const ids = ['sf_a', 'sf_b', 'sf_c', 'sf_d', 'sf_e'];
  const pending = [];
  const gates = [];
  const releases = [];
  const receipts = [];
  for (const id of ids) {
    files[id] = { name: `${id}.md`, mime: 'text/markdown', bytes: Buffer.from(`# ${id}\n`, 'utf8') };
    receipts.push({ fileId: id, name: `${id}.md`, mime: 'text/markdown', kind: 'artifact' });
  }
  const { reader, resources } = makeReader({ files, receipts: receiptWith(receipts) });
  const originalStat = resources.stat;
  resources.stat = ref => {
    const gate = new Promise(resolve => { releases.push(resolve); });
    return gate.then(() => originalStat(ref));
  };

  const runs = ids.slice(0, 4).map(id => reader.read({ owner: OWNER, sessionId: SESSION, fileId: id }));
  runs.forEach(run => run.catch(() => {}));
  await new Promise(resolve => setImmediate(resolve));
  const busy = await errorOf(reader.read({ owner: OWNER, sessionId: SESSION, fileId: ids[4] }));
  assert.equal(busy.code, HANDOFF_FILE_PREVIEW_CODES.BUSY);

  // 放行前四个，并恢复真实 stat 以便结束后的请求不再被门挡
  releases.forEach(release => release());
  await Promise.all(runs.map(run => run.catch(() => {})));
  assert.equal(resources.calls.stat.length, 4, '繁忙的第五个请求不得触碰宿主');
  resources.stat = originalStat;

  const after = await reader.read({ owner: OWNER, sessionId: SESSION, fileId: ids[4] });
  assert.equal(after.fileId, ids[4], '释放后第五个可以正常读取');
});
