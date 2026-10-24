import { groupArtifactVersions } from './artifact-versions.js';
import { escapeHtml, formatFileSize } from './panel-format.js';
const actions = file => `<div class="artifact-file-actions">
      <button type="button" data-artifact-action="preview" data-artifact-id="${file.artifactId}">内容预览</button>
      <button type="button" data-artifact-action="save" data-artifact-id="${file.artifactId}">另存为</button>
    </div>`;
const versionLabel = file => file.revisedFrom ? `v${file.version} · 基于 v${file.version - 1} 修订` : 'v1 · 初始版本';
/** File cards are App-owned views, not fake host SessionFiles or download URLs. */
export function artifactFilesHtml(message) {
  return groupArtifactVersions(message?.artifacts).map(group => {
    const file = group.current;
    return `<section class="artifact-file-card" data-artifact-root-id="${group.rootId}">
    <div class="artifact-file-heading"><span class="artifact-file-badge">${file.format.toUpperCase()}</span><strong>${escapeHtml(file.name)}</strong></div>
    <p class="artifact-file-meta">${formatFileSize(file.bytes)} · ${file.origin === 'imported' ? '用户导入' : '已生成并保存在本应用'} · ${versionLabel(file)}</p>
    ${file.revisionNotice ? `<p class="artifact-file-meta">${escapeHtml(file.revisionNotice)}</p>` : ''}
    ${actions(file)}
    ${group.versions.length > 1 ? `<details class="artifact-file-versions"><summary>版本记录（${group.versions.length}）</summary>${group.versions.map(version => `<div class="artifact-file-version"><p class="artifact-file-meta">${versionLabel(version)} · ${escapeHtml(version.name)} · ${formatFileSize(version.bytes)}</p>${version.revisionNotice ? `<p class="artifact-file-meta">${escapeHtml(version.revisionNotice)}</p>` : ''}${actions(version)}</div>`).join('')}</details>` : ''}
  </section>`;
  }).join('');
}

/*
 * 本轮修订引用卡：修订版已归入原消息的版本组，本轮消息只留定位引用。
 * 数据形状沿用 artifactRefs（normalize 白名单后的 ArtifactMetadata），
 * 不复制成新文件卡、不另建版本；与本消息完整文件卡同 ID 的引用不再重复显示。
 * 入口先过 normalizeArtifactList：非法 ID/字段不得进入 HTML（引擎写入已归一，
 * 这里是渲染层自己的哨兵，防旧快照/异常路径携带脏 refs）。
 */
import { normalizeArtifactList } from './artifact-contract.js';
export function artifactRefsHtml(message) {
  const refs = normalizeArtifactList(Array.isArray(message?.artifactRefs) ? message.artifactRefs : []);
  const ownIds = new Set(normalizeArtifactList(Array.isArray(message?.artifacts) ? message.artifacts : []).map(file => file.artifactId));
  return refs.filter(file => !ownIds.has(file.artifactId)).map(file => `<section class="artifact-ref-card" data-artifact-ref-id="${file.artifactId}">
    <div class="artifact-file-heading"><span class="artifact-file-badge artifact-ref-badge">↺</span><strong>${escapeHtml(file.name)}</strong><span class="artifact-ref-version">${file.revisedFrom ? `已更新到 v${file.version}` : '引用'}</span></div>
    <p class="artifact-file-meta">${file.revisionNotice ? `${escapeHtml(file.revisionNotice)} · ` : ''}版本组在原消息上，此处可直接预览或另存此版本</p>
    ${actions(file)}
  </section>`).join('');
}
