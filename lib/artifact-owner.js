import { createHash } from 'node:crypto';
import { documentError } from './document-spec.js';

/**
 * 唯一的持久产物身份解析器（路径 A）。
 *
 * 只信任宿主盖戳的 appRequestContext.principal.principalId；
 * principal.id / credentialId 是临时 surface 字段，一律不作为兜底。
 * owner 编码与旧实现逐字节一致，路径 A 不触发任何数据迁移。
 * 无磁盘、模型或 UI 操作。
 */

const OWNER_MAX_CHARS = 2000;

export function getArtifactOwner(context) {
  const request = typeof context?.get === 'function' ? context.get('appRequestContext') : null;
  const principal = request?.principal;
  const principalId = principal?.principalId;
  const kind = principal?.kind;
  if (request?.appId !== 'timeline-reverser' || !principal || typeof principal !== 'object' || typeof request !== 'object'
    || (kind !== undefined && typeof kind !== 'string')) {
    throw documentError('ARTIFACT_FORBIDDEN', '本次文件操作未获授权；已有文件未删除。', 403);
  }
  if (typeof principalId !== 'string' || !principalId.trim()) {
    // 可信请求但缺稳定身份：即使携带 id/credentialId 也不兜底
    throw documentError('ARTIFACT_STABLE_ID_REQUIRED', '当前宿主未提供文档所需的稳定身份，本次文件操作未执行；已有文件未删除。', 403);
  }
  const owner = JSON.stringify([request.appId, kind || 'authenticated', principalId]);
  if (owner.length > OWNER_MAX_CHARS) throw documentError('ARTIFACT_FORBIDDEN', '本次文件操作未获授权；已有文件未删除。', 403);
  return owner;
}

/** 分区指纹，仅供前端索引分区与脱敏诊断；持有它不授予任何读取权。 */
export function getArtifactAccessContext(context) {
  const owner = getArtifactOwner(context);
  return { ownerScheme: 'principal-v1', ownerScopeKey: createHash('sha256').update(owner).digest('hex') };
}
