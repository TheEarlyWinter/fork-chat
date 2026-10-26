import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getArtifactOwner, getArtifactAccessContext } from '../lib/artifact-owner.js';

/*
 * 路径 A owner 解析测试（对应 Sol 设计 1.1 / 测试清单 A）。
 * 核心契约：
 * - 只取 principalId，owner 编码与旧实现逐字节一致（不触发迁移）
 * - credentialId/id 兜底删除：有它们没 principalId 就拒绝
 * - 403 分 ARTIFACT_FORBIDDEN（上下文不可信）与 ARTIFACT_STABLE_ID_REQUIRED（可信上下文缺稳定身份）
 * - 合法 principalId 不 trim、不改大小写、不重编码
 */

const ctx = (appId, principal) => ({ get: key => key === 'appRequestContext' ? { appId, principal } : undefined });

test('owner：合法 principalId 的 owner 编码与旧实现逐字节一致', () => {
  const cases = [
    { principal: { principalId: 'app:fork-chat@studio:node-a', kind: 'app' } },
    { principal: { principalId: 'user-123' } },                              // 缺 kind 默认 authenticated
    { principal: { principalId: 'UPPER-case_NoTrim  ' , kind: 'app' } },    // 保留空白与大小写
  ];
  for (const { principal } of cases) {
    const owner = getArtifactOwner(ctx('fork-chat', principal));
    const legacy = JSON.stringify(['fork-chat', principal.kind || 'authenticated', principal.principalId]);
    assert.equal(owner, legacy);
  }
});

test('owner：credentialId/id 变化而 principalId 不变时 owner 不变；只有兜底字段时拒绝', () => {
  const stable = getArtifactOwner(ctx('fork-chat', { principalId: 'p1', kind: 'app', credentialId: 'c1' }));
  const rotated = getArtifactOwner(ctx('fork-chat', { principalId: 'p1', kind: 'app', credentialId: 'c2' }));
  assert.equal(stable, rotated);

  assert.throws(() => getArtifactOwner(ctx('fork-chat', { credentialId: 'c-only' })),
    err => err.code === 'ARTIFACT_STABLE_ID_REQUIRED');
  assert.throws(() => getArtifactOwner(ctx('fork-chat', { id: 'id-only' })),
    err => err.code === 'ARTIFACT_STABLE_ID_REQUIRED');
  assert.throws(() => getArtifactOwner(ctx('fork-chat', { id: 'x', credentialId: 'y', principalId: '   ' })),
    err => err.code === 'ARTIFACT_STABLE_ID_REQUIRED');
});

test('owner：不可信上下文拒绝为 ARTIFACT_FORBIDDEN', () => {
  assert.throws(() => getArtifactOwner(ctx('other-app', { principalId: 'p' })), err => err.code === 'ARTIFACT_FORBIDDEN');
  assert.throws(() => getArtifactOwner(ctx('fork-chat', null)), err => err.code === 'ARTIFACT_FORBIDDEN');
  assert.throws(() => getArtifactOwner({ get: () => undefined }), err => err.code === 'ARTIFACT_FORBIDDEN');
  assert.throws(() => getArtifactOwner(ctx('fork-chat', { principalId: 123 })), err => err.code === 'ARTIFACT_STABLE_ID_REQUIRED');
  assert.throws(() => getArtifactOwner(ctx('fork-chat', { principalId: 'ok', kind: 7 })), err => err.code === 'ARTIFACT_FORBIDDEN');
});

test('owner：错误文案固定且不泄漏身份细节', () => {
  for (const code of ['ARTIFACT_FORBIDDEN', 'ARTIFACT_STABLE_ID_REQUIRED']) {
    try { getArtifactOwner(ctx(code === 'ARTIFACT_FORBIDDEN' ? 'x' : 'fork-chat', code === 'ARTIFACT_FORBIDDEN' ? { principalId: 'secret-value' } : { credentialId: 'secret-cred' })); assert.fail('应当抛出'); }
    catch (error) {
      assert.equal(error.code, code);
      assert.ok(!String(error.message).includes('secret'), `${code} 文案不得包含身份原文`);
      assert.ok(!/principal|credential|path/i.test(String(error.message)), `${code} 文案不得提及内部字段`);
    }
  }
});

test('accessContext：ownerScopeKey 为 owner 的 sha256，仅作分区指纹', () => {
  const { ownerScheme, ownerScopeKey } = getArtifactAccessContext(ctx('fork-chat', { principalId: 'p1', kind: 'app' }));
  assert.equal(ownerScheme, 'principal-v1');
  const owner = getArtifactOwner(ctx('fork-chat', { principalId: 'p1', kind: 'app' }));
  assert.equal(ownerScopeKey, createHash('sha256').update(owner).digest('hex'));
});

test('owner：超长身份拒绝（沿用 store 2000 上限语义）', () => {
  assert.throws(() => getArtifactOwner(ctx('fork-chat', { principalId: 'x'.repeat(2100), kind: 'app' })),
    err => err.code === 'ARTIFACT_FORBIDDEN');
});
