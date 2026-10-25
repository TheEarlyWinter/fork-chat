/**
 * 交接的宿主/产物复核：权限、目标 Agent、真实 artifact metadata。
 *
 * 这里只做校验和五字段 descriptor 投影；完整公共 receipt 规则复用
 * ui/assets/artifact-contract.js 的 normalizeArtifactMetadata，不复制第二份 schema。
 */
import { createHash } from 'node:crypto';

import { HANDOFF_LIMITS } from '../ui/assets/fork-handoff-contract.js';
import { normalizeArtifactMetadata } from '../ui/assets/artifact-contract.js';
import { httpError } from './handoff-http.js';

const DESCRIPTOR_KEYS = ['artifactId', 'name', 'mime', 'bytes', 'sha256'];

export async function verifyCapabilities(host) {
  let caps;
  try {
    caps = await host.capabilities();
  } catch {
    throw httpError('HANDOFF_HOST_ERROR', '无法确认宿主能力，本次操作未执行', 502);
  }
  if (!caps?.supported) throw httpError('HANDOFF_UNSUPPORTED', '当前宿主不支持分支交接', 409);
  if (!caps.available) {
    throw httpError('HANDOFF_PERMISSION_MISSING', '缺少分支交接所需授权', 403);
  }
  return caps;
}

export async function requireActiveAgent(sdk, agentId) {
  let result;
  try {
    // 缺省 scope 只列本 App 的 Agent，会误拒主页助手；也不传 ownerPluginId
    result = await sdk.agents.list({ scope: 'all', lifecycle: 'active' });
  } catch {
    throw httpError('HANDOFF_HOST_ERROR', '无法确认目标助手，本次操作未执行', 502);
  }
  const agents = Array.isArray(result?.agents) ? result.agents : [];
  const matched = agents.some(row => row && row.id === agentId && row.state === 'active');
  if (!matched) throw httpError('HANDOFF_INVALID_AGENT', '目标助手不存在或已停用', 400);
}

function descriptorOf(metadata) {
  return {
    artifactId: metadata.artifactId,
    name: metadata.name,
    mime: metadata.mime,
    bytes: metadata.bytes,
    sha256: metadata.sha256,
  };
}

export function sameDescriptor(a, b) {
  return Boolean(a && b) && DESCRIPTOR_KEYS.every(key => a[key] === b[key]);
}

/**
 * 读取并校验真实产物：规范 metadata、ID、字节长度与 SHA256，返回五字段 descriptor。
 * 可选 frozen 用于确认时核对客户端不可见的冻结值。
 */
export async function readArtifactDescriptor({ artifacts, owner, artifactId, frozen = null }) {
  let entry;
  try {
    entry = await artifacts.read({ owner, artifactId });
  } catch {
    throw httpError('HANDOFF_ARTIFACT_UNAVAILABLE', '产物不可读取，本次操作未执行', 409);
  }
  const metadata = normalizeArtifactMetadata(entry?.metadata);
  if (!metadata || metadata.artifactId !== artifactId) {
    throw httpError('HANDOFF_INVALID_ARTIFACT', '产物元数据不完整或不可信', 400);
  }
  const bytes = entry?.bytes;
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw httpError('HANDOFF_INVALID_ARTIFACT', '产物内容不可读取', 400);
  }
  const buffer = Buffer.from(bytes);
  if (buffer.length !== metadata.bytes || buffer.length > HANDOFF_LIMITS.maxArtifactBytes) {
    throw httpError('HANDOFF_INVALID_ARTIFACT', '产物字节数与元数据不一致', 400);
  }
  if (createHash('sha256').update(buffer).digest('hex') !== metadata.sha256) {
    throw httpError('HANDOFF_INVALID_ARTIFACT', '产物摘要校验失败', 400);
  }
  const descriptor = descriptorOf(metadata);
  if (frozen && !sameDescriptor(descriptor, frozen)) {
    throw httpError('HANDOFF_INVALID_ARTIFACT', '产物在准备后发生变化', 409);
  }
  return { descriptor, bytes: buffer, metadata };
}

export function verifyFrozenSet(descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length > HANDOFF_LIMITS.maxArtifacts) {
    throw httpError('HANDOFF_INVALID_ARTIFACT', '产物数量超过上限', 400);
  }
  let total = 0;
  const seen = new Set();
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor.artifactId !== 'string' || seen.has(descriptor.artifactId)) {
      throw httpError('HANDOFF_INVALID_ARTIFACT', '产物集合无效', 400);
    }
    seen.add(descriptor.artifactId);
    total += descriptor.bytes;
  }
  if (total > HANDOFF_LIMITS.maxArtifactsTotalBytes) {
    throw httpError('HANDOFF_INVALID_ARTIFACT', '产物总量超过上限', 413);
  }
  return total;
}
