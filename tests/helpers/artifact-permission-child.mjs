// 真实 Node Permission Model 子进程执行器：只做“调用真实服务并如实报告结果”，
// 不做任何权限旁路（不关闭 PM、不开 worker/child、不写非授权目录）。
// 父测试用 process.execPath 启动它，因此同一份代码在 Node 24 / Node 26 下都按各自运行时行为验证。
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifactService } from '../../lib/document-artifacts.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

const report = {
  ok: false,
  permissionModel: Boolean(process.permission),
  steps: {},
  error: null,
};

async function findFiles(root, name) {
  const found = [];
  async function visit(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await visit(full);
      else if (entry.name === name) found.push(full);
    }
  }
  await visit(root);
  return found;
}

// 越权写入探测：数据目录的父目录必须被 PM 拒绝。
async function probeEscapingWrite(dataDir) {
  const target = path.join(dataDir, '..', 'escape.txt');
  try {
    await fs.writeFile(target, 'must not be written');
    report.steps.escapeWrite = 'allowed';
  } catch (error) {
    report.steps.escapeWrite = error?.code || error?.name || 'error';
  }
}

async function runPublish({ dataDir, owner, content, name = 'pm.md' }) {
  const expected = Buffer.from(content, 'utf8');
  const service = createArtifactService({ dataDir });
  const metadata = await service.create({ owner, cardId: 'card-pm', requestId: 'req-pm', filename: name, content });
  report.steps.published = true;
  report.steps.metadata = metadata;

  const read = await service.read({ owner, artifactId: metadata.artifactId });
  report.steps.readBytes = read.bytes.toString('utf8');
  report.steps.readMatches = read.bytes.equals(expected);
  report.steps.readHashMatches = metadata.sha256 === sha256(expected) && metadata.bytes === expected.length;
  report.steps.metadataStable = JSON.stringify(read.metadata) === JSON.stringify(metadata);

  const exported = await service.exportFile({ owner, artifactId: metadata.artifactId });
  report.steps.exportBase64Matches = exported.contentBase64 === expected.toString('base64');
  const preview = await service.preview({ owner, artifactId: metadata.artifactId });
  report.steps.previewMatches = preview.html === read.previewHtml;

  const manifests = await findFiles(dataDir, 'manifest.json');
  report.steps.manifestCount = manifests.length;
  if (manifests.length === 1) {
    const record = JSON.parse(await fs.readFile(manifests[0], 'utf8'));
    report.steps.manifestSchema = record.schemaVersion;
    report.steps.manifestStatus = record.metadata?.status;
    report.steps.manifestBytes = record.metadata?.bytes;
    report.steps.manifestShaMatches = record.metadata?.sha256 === sha256(expected);
    const { recordSha256, ...payload } = record;
    report.steps.manifestRecordHashMatches = recordSha256 === sha256(Buffer.from(JSON.stringify(payload)));
  }

  // 重建 service（模拟进程重启后的读取），必须仍可读取同一产物。
  const restarted = createArtifactService({ dataDir });
  const again = await restarted.read({ owner, artifactId: metadata.artifactId });
  report.steps.restartReadMatches = again.bytes.equals(expected);

  try {
    await restarted.read({ owner: `${owner}-foreign`, artifactId: metadata.artifactId });
    report.steps.foreignOwner = 'allowed';
  } catch (error) {
    report.steps.foreignOwner = error?.code || error?.name || 'error';
  }
}

async function main() {
  const config = JSON.parse(process.argv[2] || '{}');
  const { dataDir, mode = 'publish', owner = 'pm-owner-a', content = '# 标题\n\nPermission Model 正文\n' } = config;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new Error('child requires absolute dataDir');
  // 大文件写入会超过 RLIMIT_FSIZE；装处理器让 write 以 EFBIG 返回而不是被信号杀死，
  // 这样“真实写失败”能以普通 IO 错误形式到达生产代码。
  process.on('SIGXFSZ', () => {});
  try {
    if (mode === 'escape-write') {
      await probeEscapingWrite(dataDir);
      report.ok = true;
    } else {
      await probeEscapingWrite(dataDir);
      await runPublish({ dataDir, owner, content });
      report.ok = true;
    }
  } catch (error) {
    report.error = { code: error?.code || null, name: error?.name || null, message: error?.message || String(error) };
    report.steps.manifestCountAfterFailure = (await findFiles(dataDir, 'manifest.json')).length;
    report.steps.publishedFilesAfterFailure = (await findFiles(dataDir, 'manifest.pending')).length;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

await main();
