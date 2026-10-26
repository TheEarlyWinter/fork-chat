import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { buildPackage, prepareStage, collectRuntimeFiles, parseArgs } from './release-package.mjs';

function fixture(t, variant = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'package-unit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'pipe' });
  const write = (name, text) => { const p = path.join(repo, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  git(['init']); git(['config', 'user.name', 'Package test']); git(['config', 'user.email', 'test@example.invalid']);
  for (const name of ['index.js', 'sdk/client.js', 'runtime/parser.mjs', 'lib/vendor/demo/dist/runtime.js', 'ui/fonts/example.woff2', 'README.md', 'docs/internal.md', 'scripts/development.mjs']) write(name, 'synthetic');
  write('manifest.json', JSON.stringify({ id: 'fork-chat', version: '2.2.0', entry: 'index.js' }));
  const commit = () => { git(['add', '.']); git(['commit', '-m', 'synthetic fixture']); };
  commit();
  const tools = path.join(dir, 'tools'); fs.mkdirSync(path.join(tools, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(tools, 'scripts/validate-app.mjs'), `const v=${JSON.stringify(variant)}; if(v==='malformed') console.log('not-json'); else console.log(JSON.stringify({ok:v!=='false'}));`);
  fs.writeFileSync(path.join(tools, 'scripts/extension-pack.mjs'), `
    import fs from 'node:fs'; import path from 'node:path'; import {createHash} from 'node:crypto';
    if(${JSON.stringify(variant)}==='pack-failure') process.exit(1);
    const args=process.argv.slice(2), out=args[args.indexOf('--out')+1];
    const bytes=Buffer.from('UNIT-FAKE-ZIP-NOT-A-REAL-ARCHIVE');
    fs.writeFileSync(path.join(out,'app-fork-chat-2.2.0.zip'),bytes);
    fs.writeFileSync(path.join(out,'app-fork-chat-2.2.0.entry.json'),JSON.stringify({kind:'app',id:${variant === 'badentry' ? "'wrong-id'" : "'fork-chat'"},version:'2.2.0',archive:{url:'https://example.invalid/file.zip',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}}));
  `);
  return { dir, repo, tools, git, write, commit, out: path.join(dir, 'output'), build: opts => buildPackage({ repoRoot: repo, toolsRoot: tools, out: path.join(dir, 'output'), tag: 'v2.2.0', ...opts }) };
}

test('CLI accepts known options and rejects unknown/missing values', () => {
  assert.equal(parseArgs(['--out=dist', '--tag', 'v2.2.0']).out, 'dist');
  assert.throws(() => parseArgs(['--unknown'])); assert.throws(() => parseArgs(['--out']));
});
test('tag mismatch fails before tools or output publication', async t => {
  const f = fixture(t); await assert.rejects(f.build({ tag: 'v2.2.1' }), /Tag mismatch/); assert.equal(fs.existsSync(f.out), false);
});
test('unsafe id is rejected before creating staging paths', async t => {
  const f = fixture(t); f.write('manifest.json', JSON.stringify({id:'../../escape',version:'2.2.0'}));
  await assert.rejects(f.build(), /Unsafe App id/);
});
test('tracked runtime closure keeps SDK/runtime/vendor-dist/fonts, excludes untracked and internal docs', async t => {
  const f = fixture(t); f.write('private-untracked.txt', 'not for release');
  const result = await prepareStage(f.repo, path.join(f.dir, 'stage'));
  for (const file of ['sdk/client.js', 'runtime/parser.mjs', 'lib/vendor/demo/dist/runtime.js', 'ui/fonts/example.woff2']) assert.ok(result.files.includes(file));
  for (const file of ['private-untracked.txt','docs/internal.md','scripts/development.mjs']) assert.ok(!result.files.includes(file));
});
test('staging drops absent KaTeX legacy fallbacks only when a bundled woff2 exists', async t => {
  const f = fixture(t);
  f.write('ui/vendor/katex/fonts/Example.woff2', 'font');
  f.write('ui/vendor/katex/katex.min.css', '@font-face{src:url(fonts/Example.woff2) format("woff2"),url(fonts/Example.woff) format("woff"),url(fonts/Example.ttf) format("truetype")}');
  f.commit();
  const stage = path.join(f.dir, 'stage'); const result = await prepareStage(f.repo, stage);
  const css = fs.readFileSync(path.join(stage,'ui/vendor/katex/katex.min.css'),'utf8');
  assert.equal(result.metadata.normalizedFallbacks,2); assert.ok(css.includes('Example.woff2')); assert.ok(!css.includes('Example.ttf'));
});
test('dirty runtime is rejected; dirty README is allowed', t => {
  const f = fixture(t); f.write('README.md', 'installation notes'); assert.doesNotThrow(() => collectRuntimeFiles(f.repo));
  f.write('index.js', 'dirty'); assert.throws(() => collectRuntimeFiles(f.repo), /Dirty tracked runtime/);
});
test('missing tracked runtime is rejected', t => {
  const f = fixture(t); fs.unlinkSync(path.join(f.repo, 'runtime/parser.mjs')); assert.throws(() => collectRuntimeFiles(f.repo), /Tracked missing/);
});
test('leaf symbolic links are rejected', t => {
  const f = fixture(t); fs.symlinkSync('index.js', path.join(f.repo, 'alias.js')); f.commit(); assert.throws(() => collectRuntimeFiles(f.repo), /Symbolic link/);
});
test('symbolic-link ancestor cannot copy external files', t => {
  const f = fixture(t); fs.renameSync(path.join(f.repo,'runtime'),path.join(f.dir,'external'));
  fs.symlinkSync(path.join(f.dir,'external'),path.join(f.repo,'runtime')); assert.throws(() => collectRuntimeFiles(f.repo), /Symbolic link/);
});
test('ordinary executable bits survive staging', async t => {
  const f = fixture(t); fs.chmodSync(path.join(f.repo,'runtime/parser.mjs'),0o755); f.commit();
  await prepareStage(f.repo,path.join(f.dir,'stage')); assert.equal(fs.statSync(path.join(f.dir,'stage/runtime/parser.mjs')).mode & 0o111,0o111);
});
for (const variant of ['malformed','false','badentry','pack-failure']) test(`unit fake-tool orchestration fails closed: ${variant}`, async t => {
  const f = fixture(t, variant); await assert.rejects(f.build()); assert.equal(fs.existsSync(f.out),false);
});
test('unit fake-tool success keeps official entry schema and writes separate provenance/checksums', async t => {
  const f = fixture(t); const result = await f.build(); assert.equal(result.version,'2.2.0');
  const entry = JSON.parse(fs.readFileSync(path.join(f.out,'app-fork-chat-2.2.0.entry.json')));
  assert.equal(entry.sourceCommit,undefined); assert.ok(entry.archive.url.startsWith('https://github.com/TheEarlyWinter/fork-chat/releases/download/v2.2.0/'));
  const metadata = JSON.parse(fs.readFileSync(path.join(f.out,'build-info.json'))); assert.match(metadata.sourceCommit,/^[a-f0-9]{40}$/);
  for (const line of fs.readFileSync(path.join(f.out,'SHA256SUMS'),'utf8').trim().split('\n')) {
    const [expected,file] = line.split('  '); assert.equal(createHash('sha256').update(fs.readFileSync(path.join(f.out,file))).digest('hex'),expected);
  }
});
test('nonempty user output is never removed or overwritten', async t => {
  const f = fixture(t); fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out,'keep'),'keep');
  await assert.rejects(f.build(),/not empty/); assert.equal(fs.readFileSync(path.join(f.out,'keep'),'utf8'),'keep');
});
