import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifactService } from '../lib/document-artifacts.js';
import { REVISE_DOCUMENT_TOOL, createDocumentReviseExecutor } from '../lib/document-revise.js';
import { MAX_REVISION_DEPTH } from '../lib/artifact-revision.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32);
const OWNER = 'synthetic-owner';
const sha = value => createHash('sha256').update(value).digest('hex');
const call = (baseArtifactId, instruction = '把结论改为新版', extra = {}) => ({ name: 'revise_document', arguments: { baseArtifactId, instruction, ...extra } });
async function serviceFor(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-revise-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return { dataDir, artifacts: createArtifactService({ dataDir }) };
}
const root = artifacts => artifacts.create({ owner: OWNER, filename: '报告.md', content: '# 原稿\n\n旧结论' });
function executor(artifacts, rewriteSource = async () => ({ content: '# 修订稿\n\n新结论' }), extra = {}) {
  return createDocumentReviseExecutor({ artifacts, owner: OWNER, cardId: 'card-a', requestId: 'req-a', rewriteSource, ...extra });
}
function fakeRecord(id = A, extra = {}) {
  return { metadata: { artifactId: id, name: '报告.md', format: 'md', status: 'ready', ...extra }, bytes: Buffer.from('# 原稿'), previewHtml: '<h1>原稿</h1>' };
}
function fakeArtifacts(records = new Map([[A, fakeRecord()]])) {
  const reads = [], creates = [];
  return { reads, creates, async read(input) { reads.push(input); if (!records.has(input.artifactId)) throw Object.assign(new Error('不存在'), { code: 'ARTIFACT_NOT_FOUND', status: 404 }); return records.get(input.artifactId); }, async create(input) { creates.push(input); return { artifactId: 'c'.repeat(32) }; } };
}

test('revise: tool contract excludes content/owner/lineage and disclaims Office layout preservation', () => {
  assert.equal(REVISE_DOCUMENT_TOOL.name, 'revise_document');
  assert.deepEqual(REVISE_DOCUMENT_TOOL.parameters.required, ['baseArtifactId', 'instruction']);
  assert.deepEqual(Object.keys(REVISE_DOCUMENT_TOOL.parameters.properties).sort(), ['baseArtifactId', 'filename', 'instruction']);
  assert.equal(REVISE_DOCUMENT_TOOL.parameters.additionalProperties, false);
  assert.match(REVISE_DOCUMENT_TOOL.description, /内容级重写/);
  assert.match(REVISE_DOCUMENT_TOOL.description, /不保留.*版式/);
});

test('revise: required ports are checked without no-op defaults', () => {
  const valid = { artifacts: fakeArtifacts(), owner: OWNER, rewriteSource: async () => ({ content: 'ok' }) };
  for (const value of [undefined, null, {}, { ...valid, artifacts: {} }, { ...valid, artifacts: { read() {} } }, { ...valid, rewriteSource: null }]) {
    assert.throws(() => createDocumentReviseExecutor(value), TypeError);
  }
  for (const owner of ['', ' ', undefined, 'x'.repeat(2001)]) assert.throws(() => createDocumentReviseExecutor({ ...valid, owner }), e => e.code === 'ARTIFACT_FORBIDDEN');
});

test('revise: invalid calls fail before reads, model or publication', async () => {
  const artifacts = fakeArtifacts(); let modelCalls = 0;
  const execute = executor(artifacts, async () => { modelCalls++; return { content: 'x' }; });
  for (const bad of [null, { name: 'other', arguments: {} }, call('../secret'), call(A.toUpperCase()), call(A, ''), call(A, ' '), call(A, '\0'), call(A, '\ud800'), call(A, 'x'.repeat(16385)), call(A, 'ok', { owner: 'other' }), call(A, 'ok', { version: 999 }), call(A, 'ok', { revisedFrom: B }), call(A, 'ok', { filename: '../x.md' }), call(A, 'ok', { filename: 'x.exe' })]) {
    await assert.rejects(execute(bad));
  }
  assert.equal(modelCalls, 0); assert.equal(artifacts.reads.length, 0); assert.equal(artifacts.creates.length, 0);
});

test('revise: creates a durable v2 with derived lineage and leaves old bytes untouched', async t => {
  const { artifacts, dataDir } = await serviceFor(t);
  const original = await root(artifacts), before = await artifacts.read({ owner: OWNER, artifactId: original.artifactId });
  let received;
  const updated = await executor(artifacts, async input => { received = input; return { content: '# 原稿\n\n新结论', title: '新版' }; })(call(original.artifactId));
  assert.notEqual(updated.artifactId, original.artifactId);
  assert.equal(updated.revisedFrom, original.artifactId); assert.equal(updated.revisionRootId, original.artifactId); assert.equal(updated.version, 2);
  assert.equal(updated.name, '报告-v2.md'); assert.equal(updated.revisionSource, 'text');
  assert.equal(received.sourceText, before.bytes.toString('utf8')); assert.equal(received.instruction, '把结论改为新版');
  assert.equal(received.sourceFormat, 'md'); assert.equal(received.targetFormat, 'md');
  for (const key of ['owner', 'baseArtifactId', 'revisionRootId', 'artifacts', 'tools']) assert.equal(Object.hasOwn(received, key), false);
  assert.deepEqual((await artifacts.read({ owner: OWNER, artifactId: original.artifactId })).bytes, before.bytes);
  const fresh = createArtifactService({ dataDir });
  const read = await fresh.read({ owner: OWNER, artifactId: updated.artifactId });
  assert.equal(read.metadata.version, 2); assert.equal(read.metadata.revisionRootId, original.artifactId);
  assert.match(read.bytes.toString(), /新结论/);
  await assert.rejects(fresh.read({ owner: 'other-owner', artifactId: updated.artifactId }), e => e.code === 'ARTIFACT_NOT_FOUND');
});

test('revise: old missing and cross-owner references never reach rewriteSource', async t => {
  const { artifacts } = await serviceFor(t); const original = await root(artifacts); let n = 0;
  const rewriteSource = async () => { n++; return { content: 'bad' }; };
  await assert.rejects(executor(artifacts, rewriteSource, { owner: 'other-owner' })(call(original.artifactId)), e => e.code === 'ARTIFACT_NOT_FOUND');
  await assert.rejects(executor(artifacts, rewriteSource)(call(A)), e => e.code === 'ARTIFACT_NOT_FOUND');
  assert.equal(n, 0);
});

test('revise: v3 default filename and concurrent siblings derive versions from ancestry, not name', async t => {
  const { artifacts } = await serviceFor(t); const original = await root(artifacts); const execute = executor(artifacts);
  const v2 = await execute(call(original.artifactId));
  const [v3a, v3b] = await Promise.all([execute(call(v2.artifactId)), execute(call(v2.artifactId))]);
  for (const version of [v3a, v3b]) {
    assert.equal(version.version, 3); assert.equal(version.name, '报告-v3.md'); assert.equal(version.revisedFrom, v2.artifactId); assert.equal(version.revisionRootId, original.artifactId);
  }
  assert.notEqual(v3a.artifactId, v3b.artifactId);
  const renamed = await execute(call(original.artifactId, '改', { filename: '另一个名字.md' }));
  const next = await execute(call(renamed.artifactId)); assert.equal(next.name, '另一个名字-v3.md');
});

test('revise: total lineage limit is eight versions and stops before calling rewriteSource', async t => {
  assert.equal(MAX_REVISION_DEPTH, 8);
  const { artifacts } = await serviceFor(t); let previous = await root(artifacts), n = 0;
  const execute = executor(artifacts, async () => { n++; return { content: '修订正文' }; });
  for (let version = 2; version <= 8; version++) { previous = await execute(call(previous.artifactId)); assert.equal(previous.version, version); }
  await assert.rejects(execute(call(previous.artifactId)), e => e.code === 'DOCUMENT_REVISION_LIMIT' && /8/.test(e.message));
  assert.equal(n, 7);
});

test('revise: cycles, self-parent, false root/version and broken ancestors are rejected before model', async () => {
  const cases = [
    [fakeRecord(A, { revisedFrom: B, version: 3, revisionRootId: A }), fakeRecord(B, { revisedFrom: A, version: 2, revisionRootId: A })],
    [fakeRecord(A, { revisedFrom: A, version: 2, revisionRootId: B })],
    [fakeRecord(A, { revisedFrom: B, version: 3, revisionRootId: B }), fakeRecord(B)],
    [fakeRecord(A, { revisedFrom: B, version: 2, revisionRootId: 'd'.repeat(32) }), fakeRecord(B)],
    [fakeRecord(A, { revisedFrom: B, version: 2, revisionRootId: B })],
    [fakeRecord(A, { version: 9, revisionRootId: A })],
  ];
  for (const records of cases) {
    const artifacts = fakeArtifacts(new Map(records.map(record => [record.metadata.artifactId, record]))); let n = 0;
    await assert.rejects(executor(artifacts, async () => { n++; return { content: 'x' }; })(call(A)));
    assert.equal(n, 0); assert.equal(artifacts.creates.length, 0);
    assert.ok(artifacts.reads.every(input => input.owner === OWNER));
  }
});

test('revise: create/store derives lineage itself and does not pass internal fields to renderer', async t => {
  const { artifacts, dataDir } = await serviceFor(t); const original = await root(artifacts); let rendered;
  const facade = createArtifactService({ dataDir, renderer: async input => { rendered = input; return { name: 'x.md', format: 'md', mime: 'text/markdown', bytes: Buffer.from('ok'), previewHtml: '<p>ok</p>', preview: 'ok' }; } });
  const result = await facade.create({ owner: OWNER, filename: 'x.md', content: 'ok', revisionParentId: original.artifactId, revisionSource: 'text' });
  assert.equal(result.revisedFrom, original.artifactId); assert.equal(result.version, 2);
  assert.equal(Object.hasOwn(rendered, 'revisionParentId'), false); assert.equal(Object.hasOwn(rendered, 'revisionSource'), false);
  await assert.rejects(facade.create({ owner: 'other', filename: 'x.md', content: 'ok', revisionParentId: original.artifactId }), e => e.code === 'ARTIFACT_NOT_FOUND');
});

test('revise: metadata checksum covers lineage and tampered records are not revised', async t => {
  const { artifacts, dataDir } = await serviceFor(t); const original = await root(artifacts); const updated = await executor(artifacts)(call(original.artifactId));
  const manifest = path.join(dataDir, 'artifacts', sha(OWNER), updated.artifactId, 'manifest.json');
  const record = JSON.parse(await fs.readFile(manifest, 'utf8')); record.metadata.version = 99; await fs.writeFile(manifest, JSON.stringify(record));
  await assert.rejects(executor(artifacts)(call(updated.artifactId)), e => e.code === 'ARTIFACT_CORRUPT');
});

test('revise: real checksum-valid cyclic manifests and cross-owner ancestors fail before rewrite', async t => {
  for (const foreign of [false, true]) {
    const { artifacts, dataDir } = await serviceFor(t); const original = await root(artifacts);
    const v2 = await executor(artifacts)(call(original.artifactId));
    const patch = async (id, fields) => {
      const filename = path.join(dataDir, 'artifacts', sha(OWNER), id, 'manifest.json');
      const record = JSON.parse(await fs.readFile(filename, 'utf8'));
      Object.assign(record.metadata, fields); delete record.recordSha256;
      await fs.writeFile(filename, JSON.stringify({ ...record, recordSha256: sha(JSON.stringify(record)) }));
    };
    if (foreign) {
      const other = await artifacts.create({ owner: 'foreign-owner', filename: 'foreign.md', content: 'private' });
      await patch(v2.artifactId, { revisedFrom: other.artifactId, revisionRootId: other.artifactId, version: 2 });
    } else await patch(original.artifactId, { revisedFrom: v2.artifactId, version: 3, revisionRootId: original.artifactId });
    let n = 0;
    await assert.rejects(executor(artifacts, async () => { n++; return { content: 'bad' }; })(call(v2.artifactId)), e => foreign ? e.code === 'ARTIFACT_NOT_FOUND' : e.code === 'DOCUMENT_REVISION_CORRUPT');
    assert.equal(n, 0);
  }
});

test('revise: explicit output filename selects an existing supported format, not model-provided identity', async () => {
  const artifacts = fakeArtifacts();
  await executor(artifacts, async input => { assert.equal(input.targetFormat, 'pdf'); return { content: '正文' }; })(call(A, '改', { filename: '修订.pdf' }));
  assert.equal(artifacts.creates[0].filename, '修订.pdf'); assert.equal(artifacts.creates[0].format, 'pdf');
  assert.equal(artifacts.creates[0].owner, OWNER); assert.equal(artifacts.creates[0].revisionParentId, A);
});

test('revise: HTML bytes remain untrusted plain text and invalid UTF-8/source size fail closed', async () => {
  const html = '<script>doNotExecute()</script><p>待改正文</p>';
  const record = { ...fakeRecord(A, { name: 'x.html', format: 'html' }), bytes: Buffer.from(html) };
  let source;
  await executor(fakeArtifacts(new Map([[A, record]])), async value => { source = value; return { content: '已改' }; })(call(A));
  assert.equal(source.sourceText, html); assert.equal(source.sourceFormat, 'html');
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.alloc(2 * 1024 * 1024 + 1, 97)]) {
    const artifacts = fakeArtifacts(new Map([[A, { ...fakeRecord(), bytes }]])); let n = 0;
    await assert.rejects(executor(artifacts, async () => { n++; return { content: 'x' }; })(call(A)));
    assert.equal(n, 0); assert.equal(artifacts.creates.length, 0);
  }
});

test('revise: DOCX/PDF use full safe preview text, never binary, and disclose content-only rewrite', async () => {
  for (const format of ['docx', 'pdf']) {
    const longTail = '结尾'.repeat(600);
    const record = { ...fakeRecord(A, { name: `x.${format}`, format, preview: '短预览' }), bytes: Buffer.from([0, 1, 2, 255]), previewHtml: `<h1>标题</h1><p>&lt;script&gt;只是文字&lt;/script&gt;&amp;正文</p><p>${longTail}</p>` };
    const artifacts = fakeArtifacts(new Map([[A, record]])); let received;
    await executor(artifacts, async value => { received = value; return { content: '内容新版本' }; })(call(A));
    assert.match(received.sourceText, /标题/); assert.match(received.sourceText, /只是文字/); assert.ok(received.sourceText.endsWith(longTail));
    assert.equal(received.sourceFidelity, 'preview-text'); assert.equal(artifacts.creates[0].revisionSource, 'preview-text');
    assert.equal(artifacts.creates[0].format, format);
  }
});

test('revise: preview excerpt fallback is explicit; imported Office placeholder/empty preview is not content', async () => {
  const record = { ...fakeRecord(A, { name: 'x.pdf', format: 'pdf', preview: '有限摘要' }), previewHtml: '' };
  const artifacts = fakeArtifacts(new Map([[A, record]]));
  await executor(artifacts, async value => { assert.equal(value.sourceFidelity, 'preview-excerpt'); assert.equal(value.sourceText, '有限摘要'); return { content: '新文' }; })(call(A));
  assert.equal(artifacts.creates[0].revisionSource, 'preview-excerpt');
  for (const metadata of [{ ...record.metadata, origin: 'imported' }, { ...record.metadata, preview: '' }]) {
    const invalid = fakeArtifacts(new Map([[A, { ...record, metadata }]]));
    await assert.rejects(executor(invalid)(call(A)), e => e.code === 'DOCUMENT_REVISION_SOURCE_UNAVAILABLE'); assert.equal(invalid.creates.length, 0);
  }
});

test('revise: model result is content/title only; failures never publish', async () => {
  for (const result of [undefined, null, '', {}, { content: '' }, { content: '\ud800' }, { content: 'x'.repeat(2 * 1024 * 1024 + 1) }, { content: 'x', owner: 'other' }, { content: 'x', revisionRootId: B }, { content: 'x', tools: [] }]) {
    const artifacts = fakeArtifacts(); await assert.rejects(executor(artifacts, async () => result)(call(A))); assert.equal(artifacts.creates.length, 0);
  }
  const artifacts = fakeArtifacts();
  await assert.rejects(executor(artifacts, async () => { throw new Error('private/path/provider-secret'); })(call(A)), e => e.code === 'DOCUMENT_REWRITE_FAILED' && !e.message.includes('private'));
  assert.equal(artifacts.creates.length, 0);
});

test('revise: abort before source read and after rewrite prevents publication', async () => {
  const abort = new AbortController(), reason = new Error('stop'); abort.abort(reason);
  const artifacts = fakeArtifacts(); await assert.rejects(executor(artifacts, undefined, { signal: abort.signal })(call(A)), e => e === reason); assert.equal(artifacts.reads.length, 0);
  const during = new AbortController(); const other = fakeArtifacts();
  await assert.rejects(executor(other, async input => { assert.equal(input.signal, during.signal); during.abort(reason); return { content: '晚到结果' }; }, { signal: during.signal })(call(A)), e => e === reason);
  assert.equal(other.creates.length, 0);
});

test('revise: default Unicode filename stays well formed and within 120 UTF-16 units', async () => {
  const record = fakeRecord(A, { name: `${'😀'.repeat(58)}.md` }); const artifacts = fakeArtifacts(new Map([[A, record]]));
  await executor(artifacts)(call(A));
  const filename = artifacts.creates[0].filename; assert.ok(filename.length <= 120); assert.equal(filename.isWellFormed(), true); assert.match(filename, /-v2\.md$/);
});
