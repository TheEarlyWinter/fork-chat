import { documentError } from './document-spec.js';
/** Model-facing capability. No host session lookup, implicit delivery or arbitrary paths. */
export const CREATE_DOCUMENT_TOOL = Object.freeze({
  name: 'create_document',
  description: '生成真实的 Word(DOCX)、PDF、HTML 或 Markdown 文件并保存在本画布。用户要文档或文件时调用，文件卡提供预览和另存为；不需要绑定宿主会话，不会向其他会话发送文件。content 使用 Markdown 编写标题、段落、列表和表格；不是直接给二进制文件改后缀。',
  parameters: { type: 'object', properties: {
    filename: { type: 'string', description: '普通文件名，必须带 .docx/.pdf/.html/.md 后缀，不含路径，最长120字符' },
    format: { type: 'string', enum: ['docx', 'pdf', 'html', 'md'], description: '可选；须与文件后缀一致' },
    title: { type: 'string', description: '文档标题' },
    content: { type: 'string', description: '完整Markdown源文，支持标题、段落、列表、表格、代码块，最多2 MiB；原始HTML会作为文本，不执行脚本或联网取图片' },
  }, required: ['filename', 'content'], additionalProperties: false },
});
export function createArtifactToolExecutor({ artifacts, owner, cardId, requestId, signal }) {
  return async call => {
    if (!['create_document', 'deliver_document'].includes(call?.name)) throw documentError('UNKNOWN_TOOL', '不支持的文件工具');
    signal?.throwIfAborted();
    const input = call.arguments;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['filename', 'format', 'title', 'content'].includes(key))) throw documentError('INVALID_DOCUMENT', '文件参数含未知字段或路径');
    return artifacts.create({ ...input, owner, cardId, requestId, signal });
  };
}
