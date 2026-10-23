import { documentError } from './document-spec.js';

/**
 * 用户导入的字节准备（Sol 设计 3.2 的 prepareArtifactImport）。
 *
 * 只做有界校验与头部初筛，不解压、不执行、不解析内容；
 * 「导入文件未做完整文档结构验证」由调用方如实展示。
 */

const IMPORT_MAX_BYTES = 16 * 1024 * 1024;
const FORMAT_HEADS = {
  docx: [0x50, 0x4b],   // PK (zip)
  pdf: [0x25, 0x50],    // %P
};

export function prepareArtifactImport({ filename, format, bytes }) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw documentError('INVALID_ARTIFACT_REQUEST', '导入文件为空');
  if (bytes.length > IMPORT_MAX_BYTES) throw documentError('DOCUMENT_TOO_LARGE', '导入文件超过 16 MiB 上限', 413);
  if (typeof filename !== 'string' || !filename.trim() || filename.length > 200 || /[\\/]/.test(filename)) {
    throw documentError('INVALID_ARTIFACT_REQUEST', '导入文件名无效');
  }
  if (!['docx', 'pdf', 'html', 'md'].includes(format)) throw documentError('INVALID_ARTIFACT_REQUEST', '导入格式仅支持 docx/pdf/html/md');
  // 扩展名一致性：只做初筛提示，不冒充完整格式校验
  const ext = filename.toLowerCase().split('.').pop();
  if (ext !== format) throw documentError('INVALID_ARTIFACT_REQUEST', '文件后缀与声明格式不一致');
  const head = FORMAT_HEADS[format];
  if (head && (bytes[0] !== head[0] || bytes[1] !== head[1])) {
    throw documentError('INVALID_ARTIFACT_REQUEST', '导入文件头与格式不符；未做完整结构验证，已拒绝头部不符的文件');
  }
  const name = format === 'html' ? 'text/html' : format === 'md' ? 'text/markdown'
    : format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return {
    name: filename,
    format,
    mime: name,
    bytes,
    preview: '该导入文件暂不提供内容预览，可另存为。',
    previewHtml: '<p>该导入文件暂不提供内容预览，可另存为。</p>',
  };
}
