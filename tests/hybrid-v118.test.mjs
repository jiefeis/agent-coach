import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const checker = path.join(repo, '工具', 'coach-check.mjs');
const windows = { skip: process.platform !== 'win32' };
const ticketPath = (n) => `docs/tickets/${n}-样例.md`;
const output = (n) => `work\\${n}-结果.txt`;
const badFile = (n) => `work\\${n}-坏输入\\结果.txt`;
const independent = '旧成品对照：materials\\旧周报_W44.xlsx';

function put(dir, rel, value) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-v118-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function invoke(exe, args, options = {}) {
  const res = spawnSync(exe, args, { encoding: 'utf8', ...options });
  assert.ifError(res.error);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return res.stdout;
}

function check(dir, command, arg, pass, detail, tool = checker) {
  invoke(process.execPath, [tool, command, dir, ...(arg ? [arg] : [])]);
  const report = fs.readFileSync(path.join(dir, 'docs/check', command + '.txt'), 'utf8');
  assert.equal(report.split(/\r?\n/)[0].split('｜').at(-1), pass ? '通过' : '不通过', report);
  if (detail) assert.match(report, detail);
  return report;
}

const header = [
  '## 输入清单',
  '| 输入 N | 放哪 | 文件名规则 | 必须有的栏目（含单位；缺栏目怎么办） | 一次几份 | 样例文件 | 反例文件 |',
  '|---|---|---|---|---|---|---|',
  '| 输入 1 | inputs\\01-认出输入\\ | 周报-<报告周>.csv；本次 W44 | 金额 | 一份 | inputs\\01-认出输入\\周报-W44.csv | — |',
  '## 运行表',
  '| 第几步 | 谁做 | 从哪拿 | 做什么 | 放到哪 | 你要判断什么 |',
  '|---|---|---|---|---|---|',
];
function flow(dir, rows) {
  put(dir, 'docs/run-flow.md', ['本轮图：不画图', ...header, ...rows.map((r) => '| ' + r.join(' | ') + ' |')].join('\n'));
}
const one = ['1', 'AI照规矩', '输入 1', '认出输入：识别。依据：例 1', output('01'), '—'];
const two = ['2', 'AI照规矩', output('01'), '剔除退款：剔除退款后汇总金额。依据：例 2', output('02'), '—'];
const human = ['3', '你', output('02'), '人工核对：判断。依据：例 3', '—', '核金额｜相符｜不对退回第2步'];

function makeTicket(dir, n, opts = {}) {
  const source = opts.source ?? (n === '01' ? '样例清点确认：逐行清点明细' : independent);
  const checks = opts.checks ?? ['- 有 ' + output(n), '- ' + badFile(n) + ' 含 已拦截'];
  const phrase = opts.phrase ?? '就这样跑';
  put(dir, ticketPath(n), [
    '# 票 ' + n + '：样例', '## 这一步（照运行表第 ' + Number(n) + ' 行）',
    '怎么做：写程序（scripts\\' + n + '_样例.js）', '## 验收单（第 1 版）',
    '- 预期值来源：' + source, '### AI 自检', ...checks,
    ...(phrase ? ['## 确认记录', '- 第 1 次确认（第 1 版）：2026-11-12｜' + phrase] : []),
    '## 结果', ...(opts.results ?? []),
  ].join('\n'));
}
function produced(dir, n) {
  put(dir, output(n), '参数｜报告周：W44\n净额：120\n守恒核对：通过\n');
  put(dir, badFile(n), '已拦截\n');
  put(dir, 'scripts/' + n + '_样例.js', '// fixture\n');
}
function batch(dir, scope) {
  put(dir, 'docs/PROJECT_INDEX.md', '当前站：4 一步一票\n## 已确认\n- 快跑批次：2026-11-12｜' + scope + '｜按快跑档推进\n');
}

test('Case 1 · 计算步预期值来源，写代码前预检与实跑验收共用规则', windows, (t) => {
  const dir = workspace(t);
  flow(dir, [one, two, human]);
  for (const source of ['样例清点确认', '样例清点确认：3 行', '旧成品对照：<文件名>', 'AI试算', '']) {
    makeTicket(dir, '02', { source });
    for (const cmd of ['ticket', 'accept']) check(dir, cmd, '02', false, /独立真值来源/);
  }
  makeTicket(dir, '02', { phrase: '' });
  check(dir, 'ticket', '02', true);
  produced(dir, '02');
  for (const source of [independent, 'SOP硬阈值：§4.1', '边界小样核定：第 2–4 行，净额 120',
    'AI同源试算（未做独立口径核验）：学员已选择采用试算值 120']) {
    makeTicket(dir, '02', { source });
    for (const cmd of ['ticket', 'accept']) check(dir, cmd, '02', true);
  }
  makeTicket(dir, '02', { checks: ['- [ ] 有 work\\02-结果.txt'] });
  check(dir, 'ticket', '02', false);
  makeTicket(dir, '01', { checks: ['- 有 ' + output('01')] });
  check(dir, 'ticket', '01', false, /坏输入/);
  makeTicket(dir, '03');
  check(dir, 'ticket', '03', false, /人工步骤/);
});

test('Case 2 · 尾票定稿、异票原话与快跑前缀', windows, (t) => {
  const dir = workspace(t);
  const three = ['3','AI照规矩',output('02'),'排版：生成。依据：例 3',output('03'),'—'];
  flow(dir, [one, two, three]);
  batch(dir, '01@1、02@1、03@1');
  for (const n of ['01','02','03']) { produced(dir,n); makeTicket(dir,n,{ phrase:'按快跑档推进' }); }
  makeTicket(dir, '02', { phrase: '票 02 验收单确认｜[仅定稿·未获准运行]' });
  check(dir, 'accept', '01', true);
  check(dir, 'ticket', '02', true);
  check(dir, 'accept', '02', false, /仅为验收单定稿/);
  check(dir, 'accept', '03', false, /在票 02 前截断/);
  makeTicket(dir, '02', { phrase: '票 02 验收单确认' });
  check(dir, 'accept', '02', false, /未获准运行/);
  for (const phrase of ['票 01 通过，就这样跑', '票０１和票 02，就这样跑']) {
    makeTicket(dir, '02', { phrase });
    check(dir, 'accept', '02', false, /其它票号/);
  }
  makeTicket(dir, '02', { phrase: '票 02，就这样跑' });
  check(dir, 'accept', '02', true);
});

test('Case 3 · 快跑批次不能跨越列为“你”的第 03 步', windows, (t) => {
  const dir = workspace(t);
  flow(dir,[one,two,human,['4','AI照规矩',output('02'),'归档：整理。依据：例 4',output('04'),'—']]);
  batch(dir,'01@1、02@1');
  for (const n of ['01','02','04']) {
    makeTicket(dir,n,{ phrase:'按快跑档推进' });
    produced(dir,n);
  }
  check(dir,'accept','01',true);
  check(dir,'accept','02',true);
  check(dir,'accept','04',false,/确认范围/);
  batch(dir,'01@1、02@1、03@1、04@1');
  check(dir,'accept','04',false,/人工停点/);
});

test('Case 4 · W44 基线与 W45 当期守恒，最新轮次留证', windows, (t) => {
  const dir = workspace(t);
  flow(dir,[one,two,human]);
  const checks=['#### 固定基线断言（绑定参数：W44）','- '+output('02')+' 含 净额：120',
    '#### 当期守恒断言（每次必核）','- '+output('02')+' 含 守恒核对：通过','- '+badFile('02')+' 含 已拦截'];
  const results=['### 第 1 轮｜按第 1 次确认（第 1 版）','固定基线 W44：未跑（本轮代码未改动）'];
  makeTicket(dir,'02',{ checks,results });
  produced(dir,'02');
  check(dir,'ticket','02',true);
  for (const first of ['参数｜报告周：W45','报告周：W45']) {
    put(dir,output('02'),first+'\n净额：135\n守恒核对：通过');
    check(dir,'accept','02',true);
  }
  makeTicket(dir,'02',{ checks,results:[...results,'### 第 2 轮｜按第 1 次确认（第 1 版）','当期运行中'] });
  check(dir,'accept','02',false,/最新一轮/);
  makeTicket(dir,'02',{ checks,results });
  for (const first of ['参数｜报告周：W44','没有参数声明']) {
    put(dir,output('02'),first+'\n净额：150\n守恒核对：通过');
    check(dir,'accept','02',false,/净额：120/);
  }
  put(dir,output('02'),'参数｜报告周：W45\n净额：135\n守恒核对：失败');
  check(dir,'accept','02',false,/守恒核对/);
  produced(dir,'02');
  check(dir,'accept','02',true);
});

test('Case 5 · 材料联接只读，损坏图源单列发现', windows, (t) => {
  const root=workspace(t), dir=path.join(root,'project'), external=path.join(root,'external');
  check(dir,'init','',true);
  put(external,'original.txt','original');
  fs.symlinkSync(external,path.join(dir,'materials','外部参考'),'junction');
  check(dir,'files','1',false,/未读取或登记基线/);
  assert.equal(fs.existsSync(path.join(dir,'docs/check/materials-基线.txt')),false);
  // 只核计划中的产物位置，绝不执行向联接目标写入的程序。
  const protectedPath = 'materials\\外部参考\\计划结果.txt';
  flow(dir, [[...one.slice(0, 4), protectedPath, '—'],
    ['2', '你', protectedPath, '核对：确认。依据：例 2', '—', '核金额｜相符｜不对退回第1步']]);
  check(dir, 'flow', '', false, /只读|要在 work/);
  const linked=path.join(root,'linked-project');
  fs.mkdirSync(linked);
  fs.symlinkSync(external,path.join(linked,'materials'),'junction');
  const denied=spawnSync(process.execPath,[checker,'init',linked],{ encoding:'utf8' });
  assert.equal(denied.status,1);
  assert.match(denied.stderr,/不写|联接/);
  put(dir,'docs/check/run-flow.workflow.json','{unfinished');
  put(dir,'docs/run-flow.html','broken fixture');
  check(path.join(root,'report'),'scan',dir,false,/不是合法的 JSON/);
  const report=fs.readFileSync(path.join(root,'report/docs/check/scan.txt'),'utf8');
  assert.match(report,/run-flow\.html 图源异常/);
  assert.match(report,/## 架构/);
  assert.deepEqual(fs.readdirSync(external),['original.txt']);
  assert.equal(fs.readFileSync(path.join(external,'original.txt'),'utf8'),'original');
});

test('Case 6 · 从安装包实际解压，贯穿五站并校验哈希', windows, (t) => {
  const root=workspace(t), build=path.join(root,'build'), skill=path.join(root,'installed'), dir=path.join(root,'project');
  function copyInput(rel) {
    const source = path.join(repo, rel);
    if (fs.statSync(source).isFile()) return put(build, rel, fs.readFileSync(source));
    for (const name of fs.readdirSync(source)) copyInput(path.join(rel, name));
  }
  for (const name of ['AGENTS.md','CLAUDE.md','SKILL.md','README.md','LICENSE','做法','模板','讲解','工具']) copyInput(name);
  // Windows PowerShell 5.1 needs its own module search path when Node was started by pwsh 7.
  const psEnv = { ...process.env };
  for (const key of Object.keys(psEnv)) if (key.toUpperCase() === 'PSMODULEPATH') delete psEnv[key];
  invoke('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(build,'工具','pack-release.ps1')],{ cwd:root, env:psEnv });
  const release=process.env.AGENT_COACH_TEST_RELEASE || path.join(build,'releases','v1.18');
  const file='agent-coach-v1.18-20261112.zip', zip=path.join(release,file);
  const digest=createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  assert.equal(fs.readFileSync(path.join(release,'SHA256SUMS.txt'),'utf8').trim(),digest+'  '+file);
  invoke('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    'Expand-Archive -LiteralPath $env:COACH_TEST_ZIP -DestinationPath $env:COACH_TEST_DEST -ErrorAction Stop'],
    { env:{...psEnv,COACH_TEST_ZIP:zip,COACH_TEST_DEST:skill} });
  const tool=path.join(skill,'工具','coach-check.mjs');
  assert.equal(fs.existsSync(path.join(skill,'工具','pack-release.ps1')),false);
  const runCheck=(cmd,num)=>check(dir,cmd,num,true,undefined,tool);
  runCheck('init');
  put(dir,'materials/周报-W44.csv','金额\n120');
  runCheck('files','1');
  put(dir,'docs/INTAKE.md','## ⑥ 架构推荐\n信号：固定｜你说："每周重复"\n架构：固定流程（Workflow／编排组织类，单 Agent）\n因为：步骤固定\n第一版：照五站搭\n');
  runCheck('files','2');
  put(dir,'inputs/01-认出输入/周报-W44.csv','金额\n120');
  flow(dir,[one,['2','你',output('01'),'核对：检查。依据：例 2','—','核金额｜相符｜不对退回第1步']]);
  runCheck('inputs'); runCheck('flow'); runCheck('files','3');
  makeTicket(dir,'01');
  fs.renameSync(path.join(dir,ticketPath('01')),path.join(dir,'docs/tickets/01-认出输入.md'));
  runCheck('ticket','01');
  // 真实执行样例脚本两次，再让已解包的检查器读取正常及坏输入证据。
  put(dir, 'scripts/01_样例.js', [
    "const fs = require('node:fs'), path = require('node:path');",
    "const root = path.resolve(__dirname, '..');",
    "const input = process.argv[2] || path.join(root, 'inputs/01-认出输入');",
    "const csv = fs.readFileSync(path.join(input, '周报-W44.csv'), 'utf8');",
    "const target = process.argv[2] ? path.join(input, '结果.txt') : path.join(root, 'work/01-结果.txt');",
    "fs.mkdirSync(path.dirname(target), { recursive: true });",
    "fs.writeFileSync(target, csv.split(/\\r?\\n/)[0] === '金额' ? '认出输入：W44' : '已拦截：缺金额列');",
  ].join('\n'));
  const script = path.join(dir, 'scripts/01_样例.js');
  const invalid = path.join(dir, 'work/01-坏输入');
  put(invalid, '周报-W44.csv', '摘要\n示例');
  invoke(process.execPath, [script]);
  invoke(process.execPath, [script, invalid]);
  assert.match(fs.readFileSync(path.join(dir, output('01')), 'utf8'), /认出输入：W44/);
  runCheck('accept','01'); runCheck('files','4'); runCheck('files','5');
});
