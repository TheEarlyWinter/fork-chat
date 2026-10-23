/** Composition facade for rendering + durable artifact storage + optional HTTP adapter. */
import { renderDocument } from './document-formats.js';
import { createArtifactStore } from './artifact-store.js';
import { registerArtifactRoutes } from './artifact-http.js';
import { documentError } from './document-spec.js';
export { getArtifactOwner } from './artifact-http.js';
export function createArtifactService({ dataDir, renderer = renderDocument }) {
  if (typeof renderer !== 'function') throw new TypeError('artifact renderer must be a function');
  const store = createArtifactStore({ dataDir });
  let running = 0;
  const service = {
    async create({ owner, cardId, requestId, signal, ...input }) {
      if (typeof owner !== 'string' || !owner) throw documentError('ARTIFACT_FORBIDDEN', '缺少文件所有者身份', 403);
      signal?.throwIfAborted();
      if (running >= 2) throw documentError('ARTIFACT_BUSY', '同时生成的文件过多，请稍后重试', 429);
      running++;
      try {
        const rendered = await renderer(input, { signal });
        signal?.throwIfAborted();
        return await store.publish({ owner, cardId, requestId, rendered, signal });
      } finally { running--; }
    },
    read: input => store.read(input),
    async exportFile(input) {
      const { metadata, bytes } = await store.read(input);
      return { artifact: metadata, contentBase64: bytes.toString('base64') };
    },
    async preview(input) {
      const { metadata, previewHtml } = await store.read(input);
      return { artifact: metadata, html: previewHtml };
    },
    register(app) { registerArtifactRoutes(app, service); },
  };
  return service;
}
