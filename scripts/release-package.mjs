#!/usr/bin/env node
/** Stage tracked runtime files; delegate all App/ZIP validation to Hana. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function parseArgs(argv = process.argv.slice(2)) {
  const result = {};
  const keys = { '--out': 'out', '--tools-root': 'toolsRoot', '--tag': 'tag', '--repo-root': 'repoRoot' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--prepare-only') { result.prepareOnly = true; continue; }
    const [flag, ...tail] = argv[i].split('=');
    if (!keys[flag]) throw new Error(`Unknown option: ${flag}`);
    const value = tail.length ? tail.join('=') : argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${flag}`);
    result[keys[flag]] = value;
  }
  return result;
}

export function isExcludedFile(p) {
  const base = path.posix.basename(p);
  return /^(docs|tests|scripts|\.github|\.hana|\.cache|node_modules|dist|build|out)(\/|$)/.test(p)
    || ['REPAIR-NOTES.md', '.gitignore', '.gitattributes', '.DS_Store', 'Thumbs.db'].includes(base)
    || /(^|\/)\.env(?:\.|$)/.test(p)
    || /\.(pem|key|pfx|p12|pkcs12|cert|crt|log|tmp|swp)$/i.test(base)
    || /^(id_rsa|id_ed25519)$/.test(base);
}
const runtime = p => !isExcludedFile(p) && !/^(README|CHANGELOG|LICENSE)(\.[\w-]+)?$/i.test(p);
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function regularFile(root, relative) {
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i] || parts[i] === '.' || parts[i] === '..') throw new Error(`Unsafe tracked path: ${relative}`);
    current = path.join(current, parts[i]);
    let stat;
    try { stat = fs.lstatSync(current); } catch { throw new Error(`Tracked missing file: ${relative}`); }
    if (stat.isSymbolicLink()) throw new Error(`Symbolic link not allowed: ${relative}`);
    if (i === parts.length - 1 && !stat.isFile()) throw new Error(`Non-regular file: ${relative}`);
  }
  return current;
}

export function collectRuntimeFiles(repoRoot) {
  const root = fs.realpathSync(repoRoot);
  const files = git(root, ['ls-files', '-z']).split('\0').filter(p => p && !isExcludedFile(p));
  for (const file of files) regularFile(root, file);
  for (const file of git(root, ['diff', '--name-only', '-z', 'HEAD', '--']).split('\0').filter(Boolean)) {
    if (runtime(file)) throw new Error(`Dirty tracked runtime file: ${file}`);
  }
  return { repoRoot: root, sourceCommit: git(root, ['rev-parse', 'HEAD']).trim(), files };
}

export async function prepareStage(repoRoot, stageDir) {
  const source = collectRuntimeFiles(repoRoot);
  for (const file of source.files) {
    const input = regularFile(source.repoRoot, file);
    const output = path.join(stageDir, file);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(input, output);
    fs.chmodSync(output, fs.statSync(input).mode & 0o777);
  }
  // The vendored KaTeX CSS retains legacy .woff/.ttf fallbacks, while this
  // Electron App ships .woff2 only. Remove absent fallbacks only when the
  // matching primary .woff2 exists; leave genuine missing resources to Hana.
  const cssFile = path.join(stageDir, 'ui/vendor/katex/katex.min.css');
  let normalizedFallbacks = 0;
  if (fs.existsSync(cssFile)) {
    const css = fs.readFileSync(cssFile, 'utf8').replace(/,url\(["']?(fonts\/[^)"']+\.(?:woff|ttf))["']?\)\s*format\([^)]+\)/g, (match, font) => {
      const directory = path.dirname(cssFile);
      const primary = font.replace(/\.(woff|ttf)$/, '.woff2');
      if (!fs.existsSync(path.join(directory, font)) && fs.existsSync(path.join(directory, primary))) {
        normalizedFallbacks++; return '';
      }
      return match;
    });
    fs.writeFileSync(cssFile, css);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(stageDir, 'manifest.json'), 'utf8'));
  const metadata = { id: manifest.id, version: manifest.version, sourceCommit: source.sourceCommit, fileCount: source.files.length, normalizedFallbacks };
  return { stageDir, manifest, metadata, ...source, fileCount: source.files.length };
}

function runTool(script, args, root) {
  const text = execFileSync(process.execPath, [script, ...args], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  if (args.includes('--json')) {
    let report;
    try { report = JSON.parse(text); } catch { throw new Error('Official validator returned malformed JSON'); }
    if (report.ok !== true) throw new Error(`Official validation failed: ${JSON.stringify(report.issues || report)}`);
  }
}

export async function buildPackage(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
  // Safety checks for temporary paths and tag matching; Hana owns manifest validation.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id || '')) throw new Error('Unsafe App id');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version || '')) throw new Error('Invalid semver version');
  if (options.tag && options.tag !== `v${manifest.version}`) throw new Error(`Tag mismatch: expected v${manifest.version}`);
  if (!(options.out || options.outDir)) throw new Error('--out is required');
  const out = path.resolve(options.out || options.outDir);
  if (fs.existsSync(out) && (!fs.lstatSync(out).isDirectory() || fs.readdirSync(out).length)) throw new Error('Output directory is not empty or not a directory');
  const tools = options.toolsRoot || process.env.HANA_APP_TOOLS_ROOT;
  if (!options.prepareOnly && !tools) throw new Error('Set HANA_APP_TOOLS_ROOT or --tools-root');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(out), '.fork-chat-package-'));
  const spool = path.join(temporary, 'output');
  try {
    const staged = await prepareStage(repoRoot, path.join(temporary, manifest.id));
    fs.mkdirSync(spool);
    if (options.prepareOnly) {
      fs.renameSync(staged.stageDir, path.join(spool, 'stage'));
      fs.writeFileSync(path.join(spool, 'metadata.json'), `${JSON.stringify(staged.metadata, null, 2)}\n`);
    } else {
      const validate = path.join(tools, 'scripts', 'validate-app.mjs');
      runTool(validate, ['--dir', staged.stageDir, '--json'], repoRoot);
      runTool(path.join(tools, 'scripts', 'extension-pack.mjs'), [
        '--kind', 'app', '--dir', staged.stageDir, '--publisher', 'TheEarlyWinter', '--out', spool,
      ], repoRoot);
      const base = `app-${manifest.id}-${manifest.version}`;
      const zip = path.join(spool, `${base}.zip`);
      const entryFile = path.join(spool, `${base}.entry.json`);
      runTool(validate, ['--archive', zip, '--json'], repoRoot);
      const entry = JSON.parse(fs.readFileSync(entryFile, 'utf8'));
      if (entry.kind !== 'app' || entry.id !== manifest.id || entry.version !== manifest.version
        || entry.archive?.sha256 !== hash(zip) || entry.archive?.size !== fs.statSync(zip).size) {
        throw new Error('Official entry identity/archive digest mismatch');
      }
      entry.archive.url = `https://github.com/TheEarlyWinter/fork-chat/releases/download/v${manifest.version}/${base}.zip`;
      fs.writeFileSync(entryFile, `${JSON.stringify(entry, null, 2)}\n`);
      fs.writeFileSync(path.join(spool, 'build-info.json'), `${JSON.stringify(staged.metadata, null, 2)}\n`);
      const sums = [`${base}.zip`, `${base}.entry.json`, 'build-info.json'].map(file => `${hash(path.join(spool, file))}  ${file}\n`).join('');
      fs.writeFileSync(path.join(spool, 'SHA256SUMS'), sums);
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (fs.existsSync(out)) fs.rmdirSync(out); // Fails on concurrent/nonempty changes; never deletes other files.
    fs.renameSync(spool, out);
    return { ...staged.metadata, outDir: out, prepareOnly: !!options.prepareOnly };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPackage(parseArgs()).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`Package failed: ${error.message}`);
    if (error.stdout) console.error(String(error.stdout));
    if (error.stderr) console.error(String(error.stderr));
    process.exitCode = 1;
  });
}
