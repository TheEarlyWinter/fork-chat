import { normalizeArtifactList } from './artifact-contract.js';
import { escapeHtml, formatFileSize } from './panel-format.js';
/** File cards are App-owned views, not fake host SessionFiles or download URLs. */
export function artifactFilesHtml(message) {
  return normalizeArtifactList(message?.artifacts).map(file => `<section class="artifact-file-card">
    <div class="artifact-file-heading"><span class="artifact-file-badge">${file.format.toUpperCase()}</span><strong>${escapeHtml(file.name)}</strong></div>
    <p class="artifact-file-meta">${formatFileSize(file.bytes)} · 已生成并保存在本应用</p>
    <div class="artifact-file-actions">
      <button type="button" data-artifact-action="preview" data-artifact-id="${file.artifactId}">内容预览</button>
      <button type="button" data-artifact-action="save" data-artifact-id="${file.artifactId}">另存为</button>
    </div>
  </section>`).join('');
}
