import { normalizeArtifactMetadata } from './artifact-contract.js';
/** User-initiated file operations. No DOM, filesystem, automatic staging or raw fetch. */
export function createArtifactActions({ hana, requestHost, flashMessage, isActive = () => true, showPreview = () => {} }) {
  const busy = new Set();
  const run = async (artifactId, method) => {
    if (!isActive() || busy.has(artifactId)) return;
    if (typeof artifactId !== 'string' || !/^[a-f0-9]{32}$/.test(artifactId)) { flashMessage('文件标识无效'); return; }
    busy.add(artifactId);
    try {
      if (method === 'export' && typeof hana?.resources?.saveFile !== 'function') throw new Error('当前宿主不支持文件另存为，请更新宿主后重试');
      const response = await requestHost(hana, `/api/artifacts/${method}`, { method: 'POST', body: JSON.stringify({ artifactId }) });
      const result = await response.json();
      if (!isActive()) return;
      const artifact = normalizeArtifactMetadata(result?.artifact);
      if (result?.ok !== true || !artifact || artifact.artifactId !== artifactId) throw new Error(result?.error || '文件回执无效');
      if (method === 'preview') {
        if (typeof result.html !== 'string' || result.html.length > 24 * 1024 * 1024) throw new Error('预览内容无效');
        showPreview(result.html, artifact);
        return { kind: 'previewed', artifact };
      }
      const base64 = result.contentBase64;
      if (typeof base64 !== 'string' || base64.length > Math.ceil(16 * 1024 * 1024 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('文件内容编码无效');
      const saved = await hana.resources.saveFile({ suggestedName: artifact.name, mimeType: artifact.mime, contentBase64: base64 });
      if (!isActive()) return saved;
      if (saved?.kind === 'saved') flashMessage(`已保存：${artifact.name}`);
      else if (saved?.kind === 'download-started') flashMessage(`已发起下载：${artifact.name}；请在下载列表确认完成`);
      else if (saved?.kind === 'conflict') flashMessage('保存发生冲突，请核对目标文件后重新另存');
      else if (saved?.kind !== 'canceled') throw new Error('宿主未返回有效的保存回执，不能确认已保存');
      return saved;
    } catch (error) {
      if (isActive()) flashMessage(`文件${method === 'preview' ? '预览' : '另存为'}失败：${String(error?.message || error).slice(0, 300)}`);
      return { kind: 'error' };
    } finally { busy.delete(artifactId); }
  };
  return { save: artifactId => run(artifactId, 'export'), preview: artifactId => run(artifactId, 'preview') };
}
