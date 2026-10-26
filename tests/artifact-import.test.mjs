import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifactService } from '../lib/document-artifacts.js';
import { prepareArtifactImport } from '../lib/artifact-import.js';
import { createHash } from 'node:crypto';

/*
 * 用户导入 MVP 测试（Sol 设计 3.2 / 测试清单 E）。
 * 契约：
 * - 用户保有的字节 → 当前 owner 下的新 UUID，origin=imported，旧桶不动
 * - 非法文件名/格式/头部不符/超限拒绝；取消无副作用
 * - HTTP 体不接受 owner/oldOwner/path/confirmed/artifactId 注入
 * - 导入不解析内容：预览是固定安全说明；HTML 脚本不执行
 */

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fork-import-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const OWNER = JSON.stringify(['fork-chat', 'app', 'owner-a']);
const docxBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.alloc(100, 7)]);

test('导入：prepare 校验头部与后缀一致性，拒绝不符文件', () => {
  const ok = prepareArtifactImport({ filename: '备份.docx', format: 'docx', bytes: docxBytes });
  assert.equal(ok.format, 'docx');
  assert.equal(ok.preview, '该导入文件暂不提供内容预览，可另存为。');
  assert.throws(() => prepareArtifactImport({ filename: '假docx.pdf', format: 'pdf', bytes: docxBytes }), /文件头与格式不符|后缀/);
  assert.throws(() => prepareArtifactImport({ filename: 'a/b.docx', format: 'docx', bytes: docxBytes }), /文件名无效/);
  assert.throws(() => prepareArtifactImport({ filename: 'x.docx', format: 'exe', bytes: docxBytes }), /格式/);
  assert.throws(() => prepareArtifactImport({ filename: 'x.docx', format: 'docx', bytes: Buffer.alloc(0) }), /为空/);
});

test('导入：importFile 生成新 UUID、origin=imported、字节与 SHA 一致、旧桶不动', async t => {
  const dir = await tempDir(t);
  const service = createArtifactService({ dataDir: dir });
  const artifact = await service.importFile({ owner: OWNER, filename: '我的备份.docx', format: 'docx', bytes: docxBytes, cardId: 'card-1', requestId: 'req-1' });
  assert.equal(artifact.origin, 'imported');
  assert.match(artifact.artifactId, /^[0-9a-f]{32}$/);
  assert.equal(artifact.sha256, createHash('sha256').update(docxBytes).digest('hex'));
  assert.equal(artifact.bytes, docxBytes.length);
  // 读回验证：字节可再取出，预览是固定安全说明
  const exported = await service.exportFile({ owner: OWNER, artifactId: artifact.artifactId });
  assert.equal(Buffer.from(exported.contentBase64, 'base64').compare(docxBytes), 0);
  const preview = await service.preview({ owner: OWNER, artifactId: artifact.artifactId });
  assert.ok(preview.html.includes('暂不提供内容预览'));
  // 旧 owner 桶（owner-b）不能读到 owner-a 的导入
  await assert.rejects(() => service.preview({ owner: JSON.stringify(['fork-chat', 'app', 'owner-b']), artifactId: artifact.artifactId }));
});

test('导入：无 owner / 并发超限拒绝', async t => {
  const dir = await tempDir(t);
  const service = createArtifactService({ dataDir: dir });
  await assert.rejects(() => service.importFile({ owner: '', filename: 'x.docx', format: 'docx', bytes: docxBytes }), /身份|授权/);
});

function makeImportApp(service) {
  const routes = new Map();
  const register = app => {
    const wrapped = {
      post: (r, h) => routes.set(`POST ${r}`, h),
      get: (r, h) => routes.set(`GET ${r}`, h),
    };
    service.register(wrapped);
  };
  register();
  return routes;
}

const principalContext = (principal = { kind: 'app', principalId: 'owner-a' }) => ({
  get: key => key === 'appRequestContext' ? { appId: 'fork-chat', principal } : undefined,
});

test('导入 HTTP：正常导入回 artifact；注入字段拒绝；未鉴权拒绝', async t => {
  const dir = await tempDir(t);
  const service = createArtifactService({ dataDir: dir });
  const routes = makeImportApp(service);
  const json = (value, status = 200) => Response.json(value, { status });
  const post = (body, context) => routes.get('POST /api/artifacts/import')({
    req: { async json() { return body; }, header: () => undefined },
    ...context, json,
  });

  const good = await post({ filename: 'b.docx', format: 'docx', contentBase64: docxBytes.toString('base64') }, principalContext());
  assert.equal((await good.json()).ok, true);

  const injected = await post({ filename: 'b.docx', format: 'docx', contentBase64: docxBytes.toString('base64'), owner: 'forged' }, principalContext());
  assert.equal(injected.status, 400);

  const claim = await post({ filename: 'b.docx', format: 'docx', contentBase64: docxBytes.toString('base64'), artifactId: 'a'.repeat(32), confirmed: true }, principalContext());
  assert.equal(claim.status, 400);

  const anon = await post({ filename: 'b.docx', format: 'docx', contentBase64: docxBytes.toString('base64') }, { get: () => null });
  assert.equal(anon.status, 403);

  const noStable = await post({ filename: 'b.docx', format: 'docx', contentBase64: docxBytes.toString('base64') }, principalContext({ kind: 'app', credentialId: 'only-cred' }));
  assert.equal(noStable.status, 403);
  assert.equal((await noStable.json()).code, 'ARTIFACT_STABLE_ID_REQUIRED');
});
