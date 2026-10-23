import { mkdir, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 80;

const FILENAME_PATTERN = /^[A-Za-z0-9_\u4e00-\u9fa5.-]+$/;

const DELIVER_DOCUMENT_TOOL = {
  name: 'deliver_document',
  description: '把一份文档交付到当前会话，用户会直接收到文件。用户要文件时用它，不要用正文代替。',
  parameters: {
    type: 'object',
    properties: {
      filename: { type: 'string', description: '文件名，必须带 .md 后缀，不超过 80 字符' },
      content: { type: 'string', description: 'Markdown 正文，不超过 2MB 字节' }
    },
    required: ['filename', 'content'],
    additionalProperties: false
  }
};

function validateFilename(filename) {
  if (typeof filename !== 'string' || filename.length === 0) {
    return 'filename 必须是非空字符串';
  }
  if (filename.length > MAX_FILENAME_LENGTH) {
    return `filename 长度不能超过 ${MAX_FILENAME_LENGTH} 字符`;
  }
  if (!filename.endsWith('.md')) {
    return 'filename 必须以 .md 结尾';
  }
  if (!FILENAME_PATTERN.test(filename)) {
    return 'filename 只允许中文、字母、数字、下划线、短横线和点';
  }
  return null;
}

function validateContent(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return 'content 必须是非空字符串';
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    return `content 不能超过 ${MAX_DOCUMENT_BYTES} 字节`;
  }
  return null;
}

function createDeliverDocumentExecutor({ dataDir, stageFile, sessionId }) {
  if (typeof stageFile !== 'function') {
    throw new TypeError('createDeliverDocumentExecutor 需要 stageFile 函数');
  }
  if (typeof dataDir !== 'string' || dataDir.length === 0) {
    throw new TypeError('createDeliverDocumentExecutor 需要 dataDir 字符串');
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new TypeError('createDeliverDocumentExecutor 需要 sessionId 字符串');
  }

  return async function deliverDocument({ filename, content } = {}) {
    const filenameError = validateFilename(filename);
    if (filenameError) {
      const error = new Error(filenameError);
      error.code = 'INVALID_FILENAME';
      throw error;
    }

    const contentError = validateContent(content);
    if (contentError) {
      const error = new Error(contentError);
      error.code = 'INVALID_CONTENT';
      throw error;
    }

    const exportDir = path.join(dataDir, 'deliver-export');
    await mkdir(exportDir, { recursive: true, mode: 0o700 });

    const writtenPath = path.join(exportDir, `${randomUUID()}.md`);
    await writeFile(writtenPath, content, { encoding: 'utf8', mode: 0o600 });

    try {
      await stageFile({
        path: writtenPath,
        sessionId,
        scope: 'all',
        name: filename,
        mime: 'text/markdown',
        deliverAs: 'attachment'
      });
    } catch (error) {
      try {
        await unlink(writtenPath);
      } catch {
        // 删除失败时保留磁盘现场，不掩盖 stageFile 的原始错误
      }
      throw error;
    }

    return {
      delivered: true,
      name: filename,
      bytes: Buffer.byteLength(content, 'utf8'),
      path: writtenPath
    };
  };
}

export {
  DELIVER_DOCUMENT_TOOL,
  createDeliverDocumentExecutor,
  MAX_DOCUMENT_BYTES,
  MAX_FILENAME_LENGTH,
};
