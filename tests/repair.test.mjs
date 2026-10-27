// 定向检查：只用合成文件。未知失败保留临时根及各次子进程回执；全部断言通过才清理。
// 从实际新解压包读工具：COACH_PRODUCT=<解压目录> node --test tests/repair.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PRODUCT = path.resolve(process.env.COACH_PRODUCT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const TOOL = path.join(PRODUCT, '工具', 'coach-check.mjs');
const hash = (b) => createHash('sha256').update(b).digest('hex');
console.log(`实际定向工具：${TOOL}｜SHA-256：${hash(fs.readFileSync(TOOL))}`);
const OLD = '- work\\01-检查结果.md 有 状态：合成完成';
const NEW = '- work\\01-检查结果.md 含 状态：合成完成';
const SOURCE = '\uFEFF合成字符样本：‘原样’、“双引号”、e\u0301与空格  。\r\n## 验收单（第 900 版）\n![合成图](https://example.invalid/image.png)\n[合成链接](https://example.invalid/)\n```\n纯数据，非授权证明。\r\n';
const FLOW = '# 合成运行表\n\n## 运行表\n| 第几步 | 谁做 | 从哪拿 | 做什么 | 放到哪 | 你要判断什么 |\n|---|---|---|---|---|---|\n| 1 | AI照规矩 | materials\\输入.txt | 保留现有结果 | work\\01-检查结果.md | 核对状态 |\n';
const ticket = (newline = '\n', bom = '') => bom + ['# 票 01：合成检查', '', '## 验收单（第 1 版）', '### AI 自检', OLD, '',
  '## 确认记录', '- 第 1 次确认（第 1 版）：2026-10-01｜就这样跑', '', '## 结果', '### 第 1 轮｜按第 1 次确认（第 1 版）的验收单',
  '旧轮次保留。', '', '## 后续', '现有内容保留。', ''].join(newline);
const put = (root, rel, body) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body); return f; };

function fixture(body = ticket()) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coach-repair-')));
  const coach = path.join(root, '合成工具'), project = path.join(root, '合成项目');
  for (const rel of ['工具/coach-check.mjs', 'AGENTS.md', '模板/AGENTS.模板.md', '模板/CLAUDE.模板.md', '模板/README.模板.md', '模板/docs/PROJECT_INDEX.模板.md'])
    put(coach, rel, fs.readFileSync(path.join(PRODUCT, rel)));
  const target = put(project, 'docs/tickets/01-合成检查.md', body);
  const source = put(project, 'docs/check/repair-source-synthetic.txt', SOURCE);
  put(project, 'docs/tickets/02-下一票.md', '# 尚未执行的下一票\n');
  put(project, 'materials/输入.txt', '合成输入保持原样\n');
  put(project, 'work/01-检查结果.md', '状态：合成完成\n');
  put(project, 'scripts/business.mjs', 'throw new Error("这个合成业务程序不应运行");\n');
  put(project, 'docs/run-flow.md', FLOW);
  return { root, coach, project, target, source, count: 0, request: { ticket_sha256: hash(fs.readFileSync(target)), version: 1,
    source_path: 'docs/check/repair-source-synthetic.txt', source_sha256: hash(fs.readFileSync(source)), old_line: OLD, new_line: NEW } };
}
function clean(f) {
  const parent = fs.realpathSync.native(os.tmpdir()), relative = path.relative(parent, f.root);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(f.root).startsWith('coach-repair-'));
  assert.equal(fs.realpathSync.native(f.root), f.root);
  fs.rmSync(f.root, { recursive: true, force: true });
}
function check(name, fn, body) {
  test(name, async () => {
    const f = fixture(body);
    try { await fn(f); clean(f); }
    catch (e) { console.error(`保留失败夹具与首错回执：${f.root}`); throw e; }
  });
}
function unchangedFiles(f) {
  return Object.fromEntries(['materials/输入.txt', 'work/01-检查结果.md', 'scripts/business.mjs', 'docs/run-flow.md', 'docs/tickets/02-下一票.md']
    .map((rel) => [rel, fs.readFileSync(path.join(f.project, rel))]));
}

// 故障和I/O观测只在测试子进程的预加载层；产品没有环境变量或开关后门。
function injector(f, mode) {
  const log = path.join(f.root, `io-${++f.count}.jsonl`), preload = path.join(f.root, `inject-${f.count}.cjs`);
  const source = `const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const mode = ${JSON.stringify(mode)}, log = ${JSON.stringify(log)}, target = ${JSON.stringify(f.target)};
if (mode === 'fixed-id') require('node:crypto').randomUUID = () => '00000000-0000-4000-8000-000000000000';
const original = { read: fs.readFileSync, write: fs.writeFileSync, rename: fs.renameSync, append: fs.appendFileSync };
const norm = p => String(p).replaceAll('\\\\', '/');
const isReceipt = p => norm(p).includes('/docs/check/repair-01-') && norm(p).endsWith('.json');
const isTemp = p => norm(p).includes('/docs/check/repair-ticket-') && norm(p).endsWith('.tmp');
const isReport = p => norm(p).includes('/docs/check/repair-report-') && norm(p).endsWith('.tmp');
const emit = (op, p) => original.append(log, JSON.stringify({ op, path: norm(p) }) + '\\n');
const fail = () => { const e = new Error('synthetic I/O failure'); e.code = 'EACCES'; throw e; };
let committed = false;
if (mode === 'stdout-pipe') process.stdout.write = function() {
  process.nextTick(() => { const e = new Error('synthetic pipe failure'); e.code = 'EPIPE'; process.stdout.emit('error', e); });
  return false;
};
fs.writeFileSync = function(p, data, ...args) {
  if ((mode === 'receipt-write' && isReceipt(p)) || (mode === 'temp-write' && isTemp(p)) || (mode === 'report-write' && isReport(p))) fail();
  const result = original.write.call(this, p, data, ...args); emit('write', p); return result;
};
fs.readFileSync = function(p, ...args) {
  if ((mode === 'receipt-read' && isReceipt(p)) || (mode === 'post-read' && committed && norm(p) === norm(target))) fail();
  const result = original.read.call(this, p, ...args); emit('read', p);
  if (mode === 'pre-stdout-pipe' && isReceipt(p)) {
    const e = new Error('synthetic precommit pipe failure'); e.code = 'EPIPE'; process.stdout.emit('error', e);
  }
  if (mode === 'receipt-quotes' && isReceipt(p)) return Buffer.from(result.toString('utf8').replaceAll('‘', "'"), 'utf8');
  return result;
};
fs.renameSync = function(from, to) {
  if (mode === 'rename' && norm(to) === norm(target)) fail();
  const result = original.rename.call(this, from, to);
  if (norm(to) === norm(target)) committed = true;
  emit('rename', to); return result;
};
syncBuiltinESMExports();
`;
  fs.writeFileSync(preload, source, 'utf8');
  return { preload, log };
}
function run(f, { cmd = 'repair', request = f.request, input, project = f.project, mode, extra = cmd === 'init' ? undefined : '1' } = {}) {
  const injected = mode && injector(f, mode);
  const args = [...(injected ? ['--require', injected.preload] : []), path.join(f.coach, '工具', 'coach-check.mjs'), cmd, project, ...(extra === undefined ? [] : [extra])];
  const r = spawnSync(process.execPath, args, { input: input ?? (cmd === 'repair' ? JSON.stringify(request) : undefined), encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const evidence = { args, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, error: r.error?.message };
  fs.writeFileSync(path.join(f.root, `attempt-${++f.count}.json`), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  assert.ifError(r.error);
  assert.equal(r.signal, null, JSON.stringify(evidence));
  const events = injected && fs.existsSync(injected.log) ? fs.readFileSync(injected.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  return { ...r, events };
}
function reject(f, options = {}) {
  const before = fs.readFileSync(f.target), others = unchangedFiles(f), r = run(f, options);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /提交前失败，票未改/);
  assert.deepEqual(fs.readFileSync(f.target), before);
  assert.deepEqual(unchangedFiles(f), others);
  assert.ok(!r.events.some((e) => e.op === 'rename' && e.path.endsWith('/docs/tickets/01-合成检查.md')));
}
function receiptOf(f) {
  const dir = path.join(f.project, 'docs/check');
  const names = fs.readdirSync(dir).filter((n) => /^repair-01-[a-f0-9-]+\.json$/.test(n));
  assert.equal(names.length, 1);
  return JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8'));
}
function assertSuccess(f, r, before, others) {
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const after = fs.readFileSync(f.target), receipt = receiptOf(f), text = after.toString('utf8');
  const added = text.match(/(?:\r?\n)### 自检语法修复记录\r?\n[\s\S]*?```json\r?\n([^\r\n]+)\r?\n```\r?\n\r?\n/);
  assert.ok(added, text);
  assert.equal(JSON.parse(added[1]), SOURCE);
  assert.equal(receipt.source_text, SOURCE);
  assert.deepEqual(Buffer.from(receipt.source_text), fs.readFileSync(f.source));
  assert.equal(receipt.ticket_before_sha256, hash(before));
  assert.equal(receipt.ticket_after_sha256, hash(after));
  assert.equal(text.replace(added[0], '').replace(NEW, OLD), before.toString('utf8'));
  assert.equal((text.match(/^## 验收单/gm) || []).length, 1, '来源标题不得成为新验收版');
  assert.equal((text.match(/^### 第 1 轮/gm) || []).length, 1, '不得新增业务轮次');
  assert.equal((text.match(/^- 第 1 次确认/gm) || []).length, 1, '不得新增业务确认');
  assert.deepEqual(unchangedFiles(f), others);
  assert.match(fs.readFileSync(path.join(f.project, 'docs/check/repair.txt'), 'utf8'), /来源回执已写入并读回核同，之后才提交票/);
  assert.match(text, /来源文件核同不证明宿主原话，也不授予用户授权/);
  const write = r.events.findIndex((e) => e.op === 'write' && /\/repair-01-.*\.json$/.test(e.path));
  const read = r.events.findIndex((e, i) => i > write && e.op === 'read' && /\/repair-01-.*\.json$/.test(e.path));
  const rename = r.events.findIndex((e) => e.op === 'rename' && e.path.endsWith('/docs/tickets/01-合成检查.md'));
  assert.ok(write >= 0 && read > write && rename > read, JSON.stringify(r.events));
}

for (const [name, body] of [['LF', ticket()], ['BOM与CRLF', ticket('\r\n', '\uFEFF')], ['混合换行', ticket('\r\n', '\uFEFF').replace('旧轮次保留。\r\n', '旧轮次保留。\n')]]) {
  check(`成功保留${name}、原文与全部非修复字节，先读回再提交`, (f) => {
    const before = fs.readFileSync(f.target), others = unchangedFiles(f);
    assertSuccess(f, run(f, { mode: 'observe' }), before, others);
    const t = run(f, { cmd: 'ticket' });
    assert.equal(t.status, 0, t.stderr);
    assert.match(fs.readFileSync(path.join(f.project, 'docs/check/ticket.txt'), 'utf8'), /第 1 版｜语法预检｜通过/);
    const a = run(f, { cmd: 'accept' });
    assert.equal(a.status, 0, a.stderr);
    assert.match(fs.readFileSync(path.join(f.project, 'docs/check/accept.txt'), 'utf8'), /第 1 次确认（第 1 版）｜通过/);
    reject(f); // 同请求重放因票身份变化拒绝，不把旧回执当许可。
  }, body);
}

const badRequests = [
  ['旧票SHA', (r) => ({ ...r, ticket_sha256: '0'.repeat(64) })],
  ['错版', (r) => ({ ...r, version: 2 })],
  ['错来源SHA', (r) => ({ ...r, source_sha256: '0'.repeat(64) })],
  ['改应得文本', (r) => ({ ...r, new_line: NEW + '改变标准' })],
  ['改路径', (r) => ({ ...r, new_line: NEW.replace('01-', '02-') })],
  ['多行补丁', (r) => ({ ...r, old_line: OLD + '\n' })],
  ['未知quote', (r) => ({ ...r, quote: SOURCE })],
  ['自称trusted', (r) => ({ ...r, trusted: true })],
  ['缺字段', ({ source_sha256, ...r }) => r],
  ['路径越界', (r) => ({ ...r, source_path: '../repair-source-test.txt' })],
  ['平台目录', (r) => ({ ...r, source_path: '.workbuddy/repair-source-test.txt' })],
  ['以票充来源', (r) => ({ ...r, source_path: 'docs/tickets/01-合成检查.md' })],
];
for (const [name, change] of badRequests) check(`提交前拒绝：${name}`, (f) => reject(f, { request: change(f.request) }));
check('过大请求拒绝，未结束stdin有固定10秒上限', async (f) => {
  reject(f, { input: ' '.repeat(65537) });
  const before = fs.readFileSync(f.target), started = Date.now();
  const result = await new Promise((resolve) => {
    const args = [path.join(f.coach, '工具', 'coach-check.mjs'), 'repair', f.project, '1'];
    const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', error;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (e) => { error = e.message; });
    child.stdin.on('error', () => {});
    const deadline = setTimeout(() => child.kill(), 15000);
    child.on('close', (status, signal) => {
      clearTimeout(deadline);
      const evidence = { args, status, signal, stdout, stderr, error, elapsed_ms: Date.now() - started };
      fs.writeFileSync(path.join(f.root, `attempt-${++f.count}.json`), JSON.stringify(evidence, null, 2) + '\n');
      resolve(evidence);
    });
    child.stdin.write(JSON.stringify(f.request)); // 故意不结束输入。
  });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.status, 1, JSON.stringify(result));
  assert.equal(result.signal, null, JSON.stringify(result));
  assert.match(result.stderr, /标准输入10秒未结束/);
  assert.deepEqual(fs.readFileSync(f.target), before);
});
check('来源是非法UTF-8，即使其SHA匹配仍拒绝', (f) => {
  fs.writeFileSync(f.source, Buffer.from([0xc3, 0x28]));
  f.request.source_sha256 = hash(fs.readFileSync(f.source));
  reject(f);
});
check('旧行重复或只在旧版，均不改票', (f) => {
  fs.writeFileSync(f.target, ticket().replace('旧轮次保留。', OLD));
  f.request.ticket_sha256 = hash(fs.readFileSync(f.target));
  reject(f);
  fs.writeFileSync(f.target, ticket().replace('## 确认记录', '## 验收单（第 2 版）\n### AI 自检\n- 有 work\\01-检查结果.md\n\n## 确认记录'));
  f.request.ticket_sha256 = hash(fs.readFileSync(f.target)); f.request.version = 2;
  reject(f);
});
check('缺票或多票拒绝', (f) => {
  const contents = fs.readFileSync(f.target);
  fs.renameSync(f.target, path.join(f.root, '暂存票.md'));
  const r = run(f);
  assert.equal(r.status, 1); assert.match(r.stderr, /没有票/);
  assert.ok(!fs.existsSync(f.target));
  fs.writeFileSync(f.target, contents);
  put(f.project, 'docs/tickets/01-第二份.md', contents);
  reject(f);
});
for (const mode of ['receipt-write', 'receipt-read', 'receipt-quotes', 'temp-write', 'rename', 'pre-stdout-pipe'])
  check(`I/O故障${mode}不提交票`, (f) => reject(f, { mode }));
for (const mode of ['report-write', 'post-read', 'stdout-pipe']) check(`提交后故障${mode}报2，承认已经提交`, (f) => {
  const before = fs.readFileSync(f.target), others = unchangedFiles(f), r = run(f, { mode });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /已提交，后续回执未核/);
  assert.doesNotMatch(r.stderr, /票未改/);
  assert.notDeepEqual(fs.readFileSync(f.target), before);
  assert.match(fs.readFileSync(f.target, 'utf8'), /自检语法修复记录/);
  assert.deepEqual(unchangedFiles(f), others);
});
check('硬链接来源和硬链接目标均拒绝，外侧文件不变', (f) => {
  const outside = path.join(f.root, 'source-copy.txt');
  fs.linkSync(f.source, outside);
  reject(f);
  assert.deepEqual(fs.readFileSync(outside), Buffer.from(SOURCE));
  fs.unlinkSync(outside);
  const targetLink = path.join(f.root, 'ticket-copy.md');
  fs.linkSync(f.target, targetLink);
  const before = fs.readFileSync(targetLink);
  reject(f);
  assert.deepEqual(fs.readFileSync(targetLink), before);
});
check('docs/check目录联接拒绝，不写联接外侧', (f) => {
  const inside = path.join(f.project, 'docs/check'), outside = path.join(f.root, 'check-outside');
  fs.renameSync(inside, outside);
  fs.symlinkSync(outside, inside, 'junction');
  reject(f);
  assert.deepEqual(fs.readdirSync(outside), ['repair-source-synthetic.txt']);
});
check('来源目录假装文件和报告硬链接均拒绝', (f) => {
  fs.unlinkSync(f.source); fs.mkdirSync(f.source);
  reject(f);
  fs.rmdirSync(f.source); fs.writeFileSync(f.source, SOURCE);
  const report = put(f.project, 'docs/check/repair.txt', '旧报告\n');
  const outside = path.join(f.root, 'report-copy.txt'); fs.linkSync(report, outside);
  reject(f);
  assert.equal(fs.readFileSync(outside, 'utf8'), '旧报告\n');
});
for (const name of ['repair-01-00000000-0000-4000-8000-000000000000.json', 'repair-ticket-00000000-0000-4000-8000-000000000000.tmp'])
  check(`排他新建冲突不覆盖：${name}`, (f) => {
    const prior = put(f.project, `docs/check/${name}`, '已有证据保持原样\n');
    reject(f, { mode: 'fixed-id' });
    assert.equal(fs.readFileSync(prior, 'utf8'), '已有证据保持原样\n');
  });
check('init生成更新后的项目规则；六字段、来源边界、退出2与字数合同一致', (f) => {
  const project = path.join(f.root, '新建项目'), r = run(f, { cmd: 'init', project, extra: undefined });
  assert.equal(r.status, 0, r.stderr);
  const generated = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
  const template = fs.readFileSync(path.join(PRODUCT, '模板/AGENTS.模板.md'), 'utf8');
  for (const field of ['ticket_sha256', 'version', 'source_path', 'source_sha256', 'old_line', 'new_line']) assert.ok(generated.includes(field), field);
  for (const word of ['来源文件核同不认证宿主/授权', '围栏代码块内JSON字符串', '2已提交后续未核', '旧业务确认', '不作新业务确认/验收版']) {
    assert.ok(template.includes(word), word); assert.ok(generated.includes(word), word);
  }
  const way = fs.readFileSync(path.join(PRODUCT, '做法/4-一步一票.md'), 'utf8');
  const rules = fs.readFileSync(path.join(PRODUCT, 'AGENTS.md'), 'utf8');
  assert.ok([...way].length <= 2400); assert.ok([...rules].length <= 1800);
  for (const word of ['只查模板\\AGENTS.模板.md修复段用repair', '来源回执读回成功才改票结果段', '来源文件核同不认证宿主/授权', '2已提交未核', '修复不增业务K/验收版']) assert.ok(way.includes(word), word);
  assert.match(rules, /repair的1是提交前失败、票未改，2是已提交\/后续未核/);
  const opening = rules.match(/^# (.+)$/m)[1];
  assert.ok(rules.includes(`我是 ${opening}。`));
  assert.ok(fs.readFileSync(path.join(PRODUCT, '做法/1-建项目.md'), 'utf8').includes(`我是 ${opening}。`));
});
