import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-rescue-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const release = process.env.AGENT_COACH_TEST_RELEASE || path.join(repo, 'releases/v2.1.0');
const zipName = 'agent-coach-v2.1.0-20261125.zip';
const windows = { skip: process.platform !== 'win32' };
function requireFixture(t, name) {
  const value=process.env[name];
  if (value) return value;
  assert.ok(!process.env.AGENT_COACH_DIAG_EVIDENCE &&
    !(name==='AGENT_COACH_TEST_PLAYWRIGHT' && (process.env.AGENT_COACH_TEST_RELEASE || process.env.CI)),
  '正式验收必须设置 '+name);
  t.skip('未设置 '+name);
}
const psEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toUpperCase() !== 'PSMODULEPATH'));
function unpack(zip, dest) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:RESCUE_ZIP,$env:RESCUE_DEST)'],
    { env: { ...psEnv, RESCUE_ZIP: zip, RESCUE_DEST: dest } });
}
const skill = process.env.COACH_PRODUCT || (process.env.AGENT_COACH_TEST_RELEASE ? path.join(tmp,'安装包') : repo);
if (process.env.AGENT_COACH_TEST_RELEASE && !process.env.COACH_PRODUCT && process.platform==='win32') unpack(path.join(release,zipName),skill);
const checker = path.join(skill, '工具/coach-check.mjs');
function put(dir, rel, bytes) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
function files(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter(r => fs.statSync(path.join(dir, r)).isFile()).sort();
}
function hashes(dir, paths = files(dir)) {
  return Object.fromEntries(paths.map(r => [r, createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex')]));
}
function report(dir, cmd, arg, verdict, script = checker) {
  execFileSync(process.execPath, [script, cmd, dir, ...(arg === undefined ? [] : [arg])]);
  const body = read(dir, 'docs/check/' + cmd + '.txt');
  if (verdict) assert.equal(body.split(/\r?\n/, 1)[0].split('｜').at(-1), verdict, body);
  return body;
}
const idx = 'docs/PROJECT_INDEX.md';
const base = 'docs/check/materials-基线.txt';
const upgrade = '最近体检升级：v2.0.0｜2026-11-20';
const history = upgrade + '｜历史票：01@1、02@1、03@1';
const oldQuote = '先这样跑（意同口令“就这样跑”，当时没写标准口令）';
const output = n => `work\\${n}-结果.txt`;
const ticketPath = n => 'docs/tickets/' + (n === '01' ? '01-认出输入' : n + '-样例') + '.md';
const src = n => n === '01' ? '样例清点确认：有两条' : '边界小样核定：两条合计十二';
function project(name, version = 'v1.17', upgraded = '') {
  const dir = path.join(tmp, name);
  report(dir, 'init', undefined, '通过');
  put(dir, idx, `当前站：4 一步一票\n搭建教练版本：${version}\n${upgraded}\n`);
  const rows = ['01','02','03','04'].map((n,i) =>
    `| ${i+1} | AI照规矩 | ${i ? output('0' + i) : '输入 1'} | ${i ? '汇总' : '认出输入'} | ${output(n)} | — |`);
  put(dir, 'docs/run-flow.md', ['本轮图：不画图', '## 输入清单',
    '| 输入 N | 放哪 | 文件名规则 | 必须有的栏目（含单位；缺栏目怎么办） | 一次几份 | 样例文件 | 反例文件 |',
    '|---|---|---|---|---|---|---|', '| 输入 1 | inputs\\01-样本\\ | 数字.csv | 金额 | 一份 | inputs\\01-样本\\数字.csv | — |',
    '## 运行表', '| 第几步 | 谁做 | 从哪拿 | 做什么 | 放到哪 | 你要判断什么 |', '|---|---|---|---|---|---|', ...rows].join('\n'));
  put(dir, 'docs/INTAKE.md', '## ⑥ 架构推荐\n信号：固定\n架构：固定流程（Workflow／编排组织类，单 Agent）\n因为：四步固定\n第一版：按表执行');
  return dir;
}
function ticket(dir, n, { v = 1, quote = '就这样跑', date = '2026-11-19', source = src(n), round = true } = {}) {
  const before = Number(n) - 1;
  put(dir, ticketPath(n), [`# 票 ${n}：样例`, `## 这一步（照运行表第 ${Number(n)} 行）`,
    '从哪拿：' + (before ? output('0' + before) : '输入 1'), '做什么：' + (before ? '汇总' : '认出输入'), '放到哪：' + output(n),
    `## 验收单（第 ${v} 版）`, ...(source ? ['- 预期值来源：' + source] : []), '### AI 自检',
    '- ' + output(n) + ' 含 12', `- work\\${n}-坏输入\\结果.txt 含 已拦截`, '## 确认记录',
    ...(quote ? [`- 第 1 次确认（第 ${v} 版）：${date}｜${quote}`] : []), '## 结果',
    round ? `### 第 1 轮｜按第 1 次确认（第 ${v} 版）` : '### 第 1 轮｜按第 K 次确认（第 V 版）',
  ].join('\n'));
}
function products(dir, n) {
  put(dir, output(n), '12\n');
  put(dir, `work/${n}-坏输入/结果.txt`, '已拦截');
  put(dir, `scripts/${n}_样例.js`, '// 已实跑的样例\n');
}
function clues(dir, name) {
  const body = report(path.join(tmp, name), 'scan', dir);
  assert.ok(body.trimEnd().split(/\r?\n/).length <= 120, body);
  const section = /## 架构[\s\S]*?\n## 卡站与升级线索\n([\s\S]*?)\n## 请 AI 读/.exec(body)?.[1];
  assert.ok(section, body);
  assert.ok(section.split('\n').every(l => l.startsWith('· ')), section);
  return section;
}

test('A · v1.17 原地续接：只读诊断、备份底账、已过三票及产物逐字节保留', windows, () => {
  const dir = project('旧项目');
  for (const n of ['01','02','03']) {
    ticket(dir, n, { quote: n === '02' ? '就这样改（意同「就这样跑」）' : oldQuote, source: n === '03' ? '' : src(n) });
    products(dir, n);
  }
  put(dir, 'scripts/辅助.mjs', '// 共用计算');
  put(dir, 'scripts/07_整理.cjs', '// 收尾');
  put(dir, 'work/过程笔记.md', '已核');
  put(dir, 'work/辅助/核对.txt', '保留');
  put(dir, 'materials/现件.csv', '金额\n12');
  put(dir, 'inputs/01-样本/数字.csv', '金额\n12');
  const oldBase = '历史材料基线\nmaterials\\旧件.csv｜5｜' + '1'.repeat(64) + '\nmaterials\\现件.csv｜5｜' + '2'.repeat(64) + '\n';
  put(dir, base, oldBase);
  for (const lock of ['.archify-delivery-lock.json','docs/run-flow.delivery-lock.json','docs/RUN-FLOW.DELIVERY-PENDING.JSON']) put(dir, lock, '{}');
  const beforeScan = hashes(dir);
  const found = clues(dir, '初诊');
  assert.deepEqual(hashes(dir), beforeScan);
  assert.match(found, /\[基线:差异\] materials\\旧件\.csv（已删除）/);
  assert.match(found, /\[基线:差异\] materials\\现件\.csv（已修改）/);
  for (const n of ['01','02','03']) assert.match(found, new RegExp('\\[旧票:兼容\\] 票 ' + n));
  assert.match(found, /\[旧票:建议补真值\] 票 03/);
  assert.equal(found.match(/\[残留锁\]/g)?.length, 3);
  assert.doesNotMatch(found, /\[卡站:多出\]|\[票据:待修\]/);
  const blocked = report(dir, 'files', '4', '不通过');
  assert.equal(blocked.split('\n').filter(l => l.startsWith('✗')).length, 2, blocked);
  const kept = files(dir).filter(r => /^(docs\\tickets|scripts|work|inputs|materials)\\/.test(r));
  const original = hashes(dir, kept);
  // 模拟已获准使用现件：旧底账归档，按现件新建；学员的运行许可和产物保持原字节。
  const backup = 'docs/check/历史/materials-原基线.txt';
  put(dir, backup, read(dir, base));
  fs.unlinkSync(path.join(dir, base));
  report(dir, 'files', '4', '不通过');
  put(dir, idx, read(dir, idx) + history + '\n');
  assert.doesNotMatch(clues(dir, '复诊-1'), /\[基线:差异\]|\[票据:待修\]/);
  report(dir, 'files', '4', '通过');
  for (const n of ['01','02','03']) {
    const accepted = report(dir, 'accept', n, '通过');
    assert.match(accepted, /旧版确认记录（括注写法）/);
    if (n === '03') assert.match(accepted, /旧版票据未写预期值来源/);
  }
  report(dir, 'files', '5', '通过');
  assert.equal(read(dir, backup), oldBase);
  assert.match(read(dir, idx), /^搭建教练版本：v1\.17$/m);
  assert.deepEqual(hashes(dir, kept), original);
});

test('B · 新票、新版和未实跑票不能借用历史确认、预期值或指纹豁免', windows, () => {
  const dir = project('已升级', 'v1.17', history);
  for (const [n, v] of [['04', 1], ['03', 2]]) {
    products(dir, n);
    ticket(dir, n, { v, quote: '' });
    report(dir, 'ticket', n, '通过');
    for (const quote of [oldQuote, '就这样改', '开始吧']) {
      ticket(dir, n, { v, quote });
      assert.match(report(dir, 'accept', n, '不通过'), /运行许可/);
    }
    ticket(dir, n, { v, source: '' });
    assert.match(report(dir, 'ticket', n, '不通过'), /独立真值来源/);
    ticket(dir, n, { v });
    fs.unlinkSync(path.join(dir, `docs/check/ticket-${n}-v${v}.sha256`));
    for (const cmd of ['ticket','accept']) assert.match(report(dir, cmd, n, '不通过'), /已确认但缺预检指纹/);
    assert.match(clues(dir, '升级复核-' + n), new RegExp('\\[票据:待修\\] 票 ' + n));
  }
  const n = '03';
  for (const [ver, suffix, date, round, pass] of [
    ['v1.17', upgrade, '２０２６／１１／２０', true, true], ['v1.17', upgrade, '2026年11月21日', true, false],
    ['v1.17', upgrade, '2025-02-31', true, false],
    ['v1.17', history, '2026-11-19', false, false], ['v1.17', upgrade + '｜历史票：', '2026-11-19', true, false],
    ['v1.18', history, '2026-11-19', true, false], ['', history, '2026-11-19', true, false],
    ['未登记，参考 v1.17', history, '2026-11-19', true, false],
  ]) {
    put(dir, idx, `搭建教练版本：${ver}\n当前站：4 一步一票\n${suffix}`);
    ticket(dir, n, { quote: oldQuote, date, round, source: '样例清点确认：两条' });
    assert.match(report(dir, 'accept', n, pass ? '通过' : '不通过'), pass ? /旧版票据/ : /独立真值来源/);
  }
});

test('C · 本票自然开跑，否定、推迟、假设、修票、仅定稿与跨票确认均拦截', windows, () => {
  const dir = project('许可', 'v2.0.0');
  const n = '01';
  products(dir, n);
  ticket(dir, n, { quote: '' });
  report(dir, 'ticket', n, '通过');
  for (const quote of ['就这样跑','先这样跑','按这个跑','好的，开始跑','可以，跑吧','票 01，先这样跑！',
    '票 01 验收单确认｜照这个跑','OK，就按这个跑吧。','嗯，可以跑了']) {
    ticket(dir, n, { quote });
    report(dir, 'accept', n, '通过');
  }
  for (const quote of ['不要就这样跑','别开始跑','勿跑','没说就这样跑','暂时先这样跑','等会再跑','如果就这样跑',
    '假如就这样跑','要是按这个跑','开始跑再说','票 02，先这样跑','票 01 验收单确认','先这样跑｜[仅定稿·未获准运行]',
    '就这样改','开始吧','通过','继续',oldQuote]) {
    ticket(dir, n, { quote });
    assert.match(report(dir, 'accept', n, '不通过'), /未获准运行|运行许可|其它票号/);
  }
  put(dir, idx, '当前站：4 一步一票\n搭建教练版本：v1.17\n' + history);
  fs.unlinkSync(path.join(dir, 'docs/check/ticket-01-v1.sha256'));
  ticket(dir, n, { quote: '暂时不跑（意同“就这样跑”）' });
  assert.match(report(dir, 'accept', n, '不通过'), /运行许可/);
});

test('D · 精确忽略瞬态文件，保留业务同后缀输入、首票必需产物与脚本目录边界', windows, () => {
  const dir = project('边界');
  const business = '样本.delivery-lock.json';
  for (const p of ['materials','inputs/01-样本']) put(dir, path.join(p, business), '{}');
  for (const p of ['Thumbs.DB','Desktop.INI','.DS_STORE','~$工作表.xlsx','run-flow.delivery-lock.json']) put(dir, p, '');
  products(dir, '01');
  ticket(dir, '01');
  report(dir, 'files', '4', '不通过'); // 缺底账时首次从现件建立
  assert.match(read(dir, base), /materials\\样本\.delivery-lock\.json/);
  report(dir, 'files', '4', '通过');
  put(dir, 'docs/run-flow.md', read(dir, 'docs/run-flow.md').replaceAll('数字.csv', business));
  assert.match(report(dir, 'inputs', undefined, '通过'), /样本\.delivery-lock\.json/);
  put(dir, 'scripts/node_modules/x.js', '');
  put(dir, 'work/其它.txt', '保留');
  fs.rmSync(path.join(dir, output('01')));
  fs.rmSync(path.join(dir, 'work/01-坏输入'), { recursive: true });
  const blocked = report(dir, 'files', '4', '不通过');
  assert.match(blocked, /多出 scripts\\node_modules\\/);
  assert.match(blocked, /缺 work\\01-\*/);
  assert.match(clues(dir, '目录诊断'), /\[卡站:多出\] scripts\\node_modules\\/);
  const empty = path.join(tmp, '新起步');
  report(empty, 'init', undefined, '通过');
  assert.match(clues(empty, '未完站'), /\[卡站:无\]/); // 尚未准备材料，不催补本站缺项
  const outside = path.join(tmp, '非教练');
  put(outside, '笔记.txt', '内容');
  assert.match(clues(outside, '外部体检'), /非教练五站项目，不核五站卡站清单/);
  for (let i = 0; i < 140; i++) put(dir, `散件${i}.txt`, '现件');
  clues(dir, '大量线索');
});

function historicalMaterials(dir, script) {
  report(dir, 'init', undefined, '通过', script);
  const sample = 'materials\\run-flow.delivery-lock.json\\样本.csv';
  const samples = [['materials\\.DS_Store', 'legacy metadata'], [sample, '金额\n12\n']];
  for (const [rel, bytes] of samples) put(dir, rel, bytes);
  return sample;
}

const v121Baseline=path.join(repo,'tests/fixtures/v121-materials.txt');
test('F1 · v1.21 材料底账忽略瞬态文件，核对锁同名目录中的业务样本', windows, () => {
  const dir=path.join(tmp,'v1.21 材料项目'), oldSkill=path.join(tmp,'仓内 v2.0.0');
  unpack(path.join(repo,'releases/v2.0.0/agent-coach-v2.0.0-20261120.zip'),oldSkill);
  const sample=historicalMaterials(dir,path.join(oldSkill,'工具/coach-check.mjs'));
  put(dir,base,fs.readFileSync(v121Baseline));
  const baseline = path.join(dir, base), original = fs.readFileSync(baseline);
  assert.match(original.toString('utf8'), /^materials\\\.DS_Store｜\d+｜[0-9a-f]{64}$/m);
  assert.match(report(dir, 'files', '1', '通过'), /✓ materials 基线里的 1 份文件都没变/);
  assert.match(clues(dir, 'v1.21 材料复诊'), /\[卡站:无\]/);
  assert.deepEqual(fs.readFileSync(baseline), original);
  put(dir, sample, '金额\n25\n');
  assert.ok(report(dir, 'files', '1', '不通过').includes('✗ ' + sample + ' 被改了'));
  assert.ok(clues(dir, 'v1.21 材料已修改').includes('[基线:差异] ' + sample + '（已修改）'));
  fs.unlinkSync(path.join(dir, sample));
  assert.ok(report(dir, 'files', '1', '不通过').includes('✗ ' + sample + ' 被删了'));
  assert.ok(clues(dir, 'v1.21 材料已删除').includes('[基线:差异] ' + sample + '（已删除）'));
  assert.deepEqual(fs.readFileSync(baseline), original);
});

if (process.env.AGENT_COACH_TEST_V121_ZIP || process.env.AGENT_COACH_DIAG_EVIDENCE) {
  test('本机历史实物 · v1.21 原包签发的底账和旧票逐字复核',windows,()=>{
    const zip=process.env.AGENT_COACH_TEST_V121_ZIP;
    assert.ok(zip && fs.existsSync(zip),'缺 AGENT_COACH_TEST_V121_ZIP 原件');
    assert.equal(sha(fs.readFileSync(zip)),'f85a911ca8a587c49f20114483c64999313be8432da4f61dff8bc50dfa3bd11c');
    const dir=path.join(tmp,'历史底账实算'), script=oldTicketChecker();
    historicalMaterials(dir,script);
    report(dir,'files','1','通过',script);
    assert.match(report(dir,'files','1','通过',script),/✓ materials 基线里的 2 份文件都没变/);
    // The first line carries the creation date. The actual file rows are immutable.
    assert.deepEqual(read(dir,base).split(/\r?\n/).slice(1),fs.readFileSync(v121Baseline,'utf8').split(/\r?\n/).slice(1));
    assert.match(report(dir,'files','1','通过'),/✓ materials 基线里的 1 份文件都没变/);
    const [,draft,expected]=oldExamples[0], project=oldProject('历史签发样本');
    put(project,ticketPath('02'),draft);
    report(project,'ticket','02','通过',script);
    assert.equal(read(project,fingerprint('02')),expected+'\n');
  });
}

for (const linked of [idx, 'docs']) {
  test('F2 · 票据预检与快跑验收拒绝外联 ' + linked + '，各只报一次', windows, () => {
    const dir = project('外联索引-' + (linked === 'docs' ? '父目录' : '索引项'), 'v2.0.0');
    const n = '01', date = '2026-11-19', rel = ticketPath(n);
    put(dir, idx, read(dir, idx) + '## 已确认\n- 快跑批次：' + date + '｜01@1、02@1｜按快跑档推进\n');
    products(dir, n);
    ticket(dir, n, { quote: '' });
    put(dir, rel, read(dir, rel).replace('\n从哪拿：', '\n怎么做：写程序（scripts\\01_样例.js）\n从哪拿：'));
    report(dir, 'ticket', n, '通过');
    put(dir, rel, read(dir, rel).replace('## 确认记录\n', '## 确认记录\n- 第 1 次确认（第 1 版）：' + date + '｜按快跑档推进\n'));
    report(dir, 'accept', n, '通过');
    const external = path.join(tmp, path.basename(dir) + '-外部目录'), link = path.join(dir, linked);
    if (linked === 'docs') {
      // 让报告写回项目内，以单独核对父目录外联时的索引诊断。
      const check = path.join(link, 'check'), reports = path.join(dir, '核对报告');
      fs.renameSync(check, reports);
      fs.symlinkSync(reports, check, 'junction');
      fs.renameSync(link, external);
    } else {
      fs.mkdirSync(external);
      fs.unlinkSync(link);
    }
    fs.symlinkSync(external, link, 'junction');
    for (const cmd of ['ticket', 'accept']) {
      const result = report(dir, cmd, n, '不通过');
      assert.equal(result.split(/\r?\n/).filter(l => l === '✗ docs\\PROJECT_INDEX.md 不是项目内的普通文件').length, 1, result);
    }
  });
}

for (const [name, note] of [
  ['普通说明', '最近体检升级说明：本次保留原有票据。'],
  ['列表说明', '- 最近体检升级说明：同上'],
]) {
  test('F3 · 登记后的' + name + '不影响已预检票和体检', windows, () => {
    const dir = project('登记与说明-' + name, 'v1.17', upgrade + '｜历史票：01@1'), n = '01';
    products(dir, n);
    ticket(dir, n, { quote: '' });
    report(dir, 'ticket', n, '通过');
    ticket(dir, n);
    report(dir, 'accept', n, '通过');
    put(dir, idx, read(dir, idx).trimEnd() + '\n' + note + '\n');
    report(dir, 'ticket', n, '通过');
    report(dir, 'accept', n, '通过');
    assert.doesNotMatch(clues(dir, '说明复诊-' + name), /最近体检升级记录格式或日期无效/);
  });
}

for (const [name, mark] of [
  ['坏格式', upgrade + '\n最近体检升级：坏格式'],
  ['非法日期', upgrade + '\n最近体检升级：v2.0.0｜2026-02-30'],
  ['缺冒号', '最近体检升级 v2.0.0｜2026-11-01'],
  ['冒号错位', '最近体检升级 ：v2.0.0｜2026-11-01'],
  ['列表登记', '- 最近体检升级：v2.0.0｜2026-11-01'],
  ['缩进登记', '  最近体检升级：v2.0.0｜2026-11-01'],
  ['引用登记', '> 最近体检升级：v2.0.0｜2026-11-01'],
  ['加粗登记', '**最近体检升级**：v2.0.0｜2026-11-01'],
]) {
  test('F3 · 最新升级登记' + name + '时取消旧票豁免并提示待修', windows, () => {
    const dir = project('升级登记-' + name, 'v1.17', mark);
    const n = '01';
    products(dir, n);
    ticket(dir, n, { date: '2026-02-28', source: '' });
    for (const cmd of ['ticket', 'accept']) {
      const result = report(dir, cmd, n, '不通过');
      assert.match(result, /最近体检升级：".*格式或日期无效/);
      assert.match(result, /独立真值来源/);
    }
    const found = clues(dir, '登记复诊-' + name);
    assert.match(found, /\[票据:待修\] docs\\PROJECT_INDEX\.md：最近体检升级记录格式或日期无效/);
    assert.match(found, /\[票据:待修\] 票 01 第 1 版：缺预检指纹/);
    assert.doesNotMatch(found, /\[旧票:/);
  });
}

for (const [name, v, heading] of [
  ['异版', 1, '### 第 1 轮｜按第 1 次确认（第 2 版）'],
  ['版号占位', 1, '### 第 1 轮 | 按第 1 次确认（第 V 版）的验收单'],
  ['尾注待跑', 2, '### 第 1 轮｜按第 1 次确认（第 1 版），第 2 版待跑'],
  ['缩进第 1 版示例', 1, '    ### 第 1 轮'],
  ['缩进第 2 版示例', 2, '    ### 第 2 轮｜按第 2 次确认（第 2 版）'],
  ['围栏代码示例', 2, '```markdown\n### 第 2 轮｜按第 2 次确认（第 2 版）\n```'],
  ['反引号含结果标题围栏示例', 2, '```markdown\n## 结果\n### 第 2 轮｜按第 1 次确认（第 2 版）\n```'],
  ['波浪号含结果标题围栏示例', 2, '~~~markdown\n## 结果\n### 第 2 轮｜按第 1 次确认（第 2 版）\n~~~'],
]) {
  test('F3 · ' + name + '的轮次不能为历史票取得豁免', windows, () => {
    const dir = project('轮次-' + name, 'v1.17', upgrade), n = '01', rel = ticketPath(n);
    products(dir, n);
    ticket(dir, n, { v, source: '' });
    put(dir, rel, read(dir, rel).replace(/^### 第 1 轮.*$/m, heading));
    assert.match(report(dir, 'ticket', n, '不通过'), /独立真值来源/);
    assert.match(report(dir, 'accept', n, '不通过'), /独立真值来源/);
    const found = clues(dir, '轮次复诊-' + name);
    assert.ok(found.includes('[票据:待修] 票 01 第 ' + v + ' 版：缺预检指纹'), found);
    assert.doesNotMatch(found, /\[旧票:/);
  });
}

test('F3 · 已跑第 1 版不能替代第 2 版结果，实跑第 2 版仍可兼容', windows, () => {
  const dir = project('旧票升版', 'v1.17', upgrade), n = '01', rel = ticketPath(n);
  products(dir, n);
  ticket(dir, n, { source: '' });
  const v1 = read(dir, rel).replace('### 第 1 轮｜按第 1 次确认（第 1 版）', '### 第 1 轮');
  put(dir, rel, v1);
  assert.match(report(dir, 'accept', n, '通过'), /旧版票据未写预期值来源/);
  assert.match(clues(dir, '无后缀第 1 轮'), /\[旧票:兼容\] 票 01 第 1 版/);

  const v2 = v1.replace('## 确认记录', [
    '## 验收单（第 2 版）', '### AI 自检', '- work\\01-结果.txt 含 12',
    '- work\\01-坏输入\\结果.txt 含 已拦截', '## 确认记录',
  ].join('\n')).replace('## 结果', '- 第 2 次确认（第 2 版）：2026-11-20｜就这样跑\n## 结果');
  put(dir, rel, v2);
  assert.match(report(dir, 'accept', n, '不通过'), /独立真值来源/);
  assert.match(clues(dir, '未跑第 2 版'), /\[票据:待修\] 票 01 第 2 版：缺预检指纹/);

  const sourced = v2.replace('## 验收单（第 2 版）\n', '## 验收单（第 2 版）\n- 预期值来源：' + src(n) + '\n');
  put(dir, rel, sourced + '\n### 第 2 轮｜按第 K 次确认（第 2 版）\n### 第 3 轮｜按第 2 次确认（第 2 版）<待实跑>');
  assert.match(report(dir, 'accept', n, '不通过'), /已确认但缺预检指纹/);
  for (const [i, suffix] of ['（第 2 版）', '（第  2  版）', '（第 2 版）的验收单'].entries()) {
    put(dir, rel, v2 + '\n### 第 2 轮｜按第 2 次确认' + suffix);
    assert.match(report(dir, 'accept', n, '通过'), /旧版票据未写预期值来源/);
    assert.match(clues(dir, '第 2 版实跑-' + i), /\[旧票:兼容\] 票 01 第 2 版/);
  }
  for (const [i, [stepExtra, prefix]] of [
    ['', '```运行摘要```'],
    ['', '```markdown\n## 示例说明\n```'],
    ['- ```text\n  样例\n  ```', '- ```text\n  样例\n  ```'],
    ['- ~~~text\n  样例\n  ~~~', '- ~~~text\n  样例\n  ~~~'],
    ['- - -\n  ```text\n样例\n  ```', ''],
    ['说明如下。\n2. 输出样例\n   ~~~text\n样例\n   ~~~', ''],
  ].entries()) {
    const withStepFence = stepExtra ? v2.replace('\n## 验收单（第 1 版）', '\n' + stepExtra + '\n## 验收单（第 1 版）') : v2;
    put(dir, rel, withStepFence + (prefix ? '\n' + prefix : '') + '\n### 第 2 轮｜按第 2 次确认（第 2 版）');
    assert.match(report(dir, 'ticket', n, '通过'), /旧版票据未写预期值来源/);
    assert.match(report(dir, 'accept', n, '通过'), /旧版票据未写预期值来源/);
    const scanOut = clues(dir, '第 2 版前置片段-' + i);
    assert.match(scanOut, /\[旧票:兼容\] 票 01 第 2 版/);
    const fullScan = read(path.join(tmp, '第 2 版前置片段-' + i), 'docs/check/scan.txt');
    assert.match(fullScan, /✓ 内容③：有结果的票 01 都有确认记录/);
    assert.doesNotMatch(fullScan, /还没有跑过的票/);
  }

  put(dir, rel, v1.replace('### 第 1 轮', '### 第 1 轮 ###'));
  assert.match(report(dir, 'ticket', n, '通过'), /旧版票据未写预期值来源/);
  assert.match(report(dir, 'accept', n, '通过'), /旧版票据未写预期值来源/);
  assert.match(clues(dir, '第 1 版闭合井号'), /\[旧票:兼容\] 票 01 第 1 版/);

  put(dir, rel, v2 + '\n### 第 2 轮｜按第 2 次确认（第 2 版） ###');
  assert.match(report(dir, 'ticket', n, '通过'), /旧版票据未写预期值来源/);
  assert.match(report(dir, 'accept', n, '通过'), /旧版票据未写预期值来源/);
  assert.match(clues(dir, '第 2 版闭合井号'), /\[旧票:兼容\] 票 01 第 2 版/);

  put(dir, rel, v2.replace(/## 结果[\s\S]*$/, '## 结果\n\n##\t附注\n### 第 2 轮｜按第 2 次确认（第 2 版）\n'));
  assert.match(report(dir, 'accept', n, '不通过'), /独立真值来源/);
  clues(dir, '附注轮次不计已跑');
  const noteScan = read(path.join(tmp, '附注轮次不计已跑'), 'docs/check/scan.txt');
  assert.match(noteScan, /· 内容③：还没有跑过的票，不核/);
  assert.doesNotMatch(noteScan, /✓ 内容③：有结果的票 01 都有确认记录/);

  put(dir, rel, v2.replace('2026-11-20｜就这样跑', '2026-11-20｜仅定稿·未获准运行'));
  const draft = clues(dir, '第 2 版仅定稿');
  assert.match(draft, /\[票据:待修\] 票 01 第 2 版：缺预检指纹/);
  assert.doesNotMatch(draft, /确认原话不能授权本票/);
});

test('F5 · 换参票遵守 CommonMark 标题、分隔线、段落序号与围栏边界', windows, () => {
  const dir = project('换参标题缩进', 'v2.0.0'), n = '01', rel = ticketPath(n);
  put(dir, 'docs/run-flow.md', read(dir, 'docs/run-flow.md').replace('inputs\\01-样本\\', 'inputs\\01-样本\\｜参数：<报告周>'));
  products(dir, n);
  put(dir, 'work/01-结果.txt', '参数｜报告周：W45\n金额：12\n');
  const dualSheet = [
    '## 验收单（第 1 版）',
    '- 预期值来源：样例清点确认：inputs\\01-样本\\样本.csv 第 2 行金额 12',
    '### AI 自检',
    '#### 固定基线断言（绑定参数：W44）',
    '- work\\01-结果.txt 含 999',
    '#### 当期守恒断言（每次必核）',
    '- work\\01-结果.txt 含 12',
    '- work\\01-坏输入\\结果.txt 含 已拦截',
  ].join('\n');
  ticket(dir, n, { quote: '' });
  const draft = read(dir, rel).replace(/## 验收单（第 1 版）[\s\S]*?(?=## 确认记录)/, dualSheet + '\n');
  put(dir, rel, draft);
  report(dir, 'ticket', n, '通过');
  const confirmed = draft.replace('## 确认记录\n', '## 确认记录\n- 第 1 次确认（第 1 版）：2026-11-19｜就这样跑\n\n以上为学员确认原话。\n\n');
  const withResult = (resBlock) => confirmed.replace(/## 结果[\s\S]*$/, resBlock);
  for (const sp of ['', ' ', '  ', '   ']) {
    put(dir, rel, withResult(sp + '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n固定基线 W44：未跑（本轮代码未改动）\n'));
    report(dir, 'accept', n, '通过');
  }
  for (const goodBlock of [
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n固定基线 W44：未跑（本轮代码未改动）\n\n###第 2 轮格式示例\n',
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n核对说明。\n    延续说明。\n    固定基线 W44：未跑（本轮代码未改动）\n',
  ]) {
    put(dir, rel, withResult(goodBlock));
    report(dir, 'accept', n, '通过');
  }
  for (const badBlock of [
    '    ## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n固定基线 W44：未跑（本轮代码未改动）\n',
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n```text\n固定基线 W44：未跑（本轮代码未改动）\n```\n',
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n- - -\n  ```text\n固定基线 W44：未跑（本轮代码未改动）\n  ```\n',
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n说明如下。\n2. 输出样例\n   ~~~text\n固定基线 W44：未跑（本轮代码未改动）\n   ~~~\n',
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n核对说明。\n    延续说明。\n2. 输出样例\n   ~~~text\n固定基线 W44：未跑（本轮代码未改动）\n   ~~~\n',
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n核对说明。\n\n    延续说明。\n    固定基线 W44：未跑（本轮代码未改动）\n',
    '## 结果\n###第 1 轮｜按第 1 次确认（第 1 版）\n固定基线 W44：未跑（本轮代码未改动）\n',
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n##\t附注\n固定基线 W44：未跑（本轮代码未改动）\n',
    '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n##\n固定基线 W44：未跑（本轮代码未改动）\n',
  ]) {
    put(dir, rel, withResult(badBlock));
    assert.match(report(dir, 'accept', n, '不通过'), /固定基线状态/);
  }
  for (const [i, fencedHdr] of ['##', '##\t附注'].entries()) {
    const withConfirmFence = confirmed
      .replace('## 确认记录\n', `## 确认记录\n示例：\n\`\`\`markdown\n${fencedHdr}\n\`\`\`\n\n`)
      .replace(/## 结果[\s\S]*$/, '## 结果\n### 第 1 轮｜按第 1 次确认（第 1 版）\n固定基线 W44：未跑（本轮代码未改动）\n');
    put(dir, rel, withConfirmFence);
    report(dir, 'ticket', n, '通过');
    report(dir, 'accept', n, '通过');
    clues(dir, '确认区围栏不截断-' + i);
    const cfScan = read(path.join(tmp, '确认区围栏不截断-' + i), 'docs/check/scan.txt');
    assert.match(cfScan, /✓ 内容③：有结果的票 01 都有确认记录/);
  }
  const sheetFenceDir = project('验收单围栏不截断', 'v2.0.0');
  products(sheetFenceDir, n);
  ticket(sheetFenceDir, n, { quote: '' });
  const sfDraft = read(sheetFenceDir, rel).replace('### AI 自检', '```markdown\n##\n##\t附注\n```\n\n### AI 自检');
  put(sheetFenceDir, rel, sfDraft);
  report(sheetFenceDir, 'ticket', n, '通过');
  put(sheetFenceDir, rel, sfDraft.replace('## 确认记录\n', '## 确认记录\n- 第 1 次确认（第 1 版）：2026-11-19｜就这样跑\n'));
  report(sheetFenceDir, 'accept', n, '通过');
});
test('F4 · 附件目录仅有锁同名目录联接时判空拒绝，补入真实普通附件后通过', windows, () => {
  const dir = project('附件目录联接', 'v2.0.0'), n = '01', rel = ticketPath(n);
  put(dir, 'docs/run-flow.md', read(dir, 'docs/run-flow.md').replace('work\\01-结果.txt', 'work\\01-结果.txt、work\\01-附件\\'));
  products(dir, n);
  const attachDir = path.join(dir, 'work/01-附件'), emptyTarget = path.join(dir, 'work/空联接目标');
  fs.mkdirSync(attachDir, { recursive: true });
  fs.mkdirSync(emptyTarget, { recursive: true });
  fs.symlinkSync(emptyTarget, path.join(attachDir, 'run-flow.delivery-lock.json'), 'junction');
  const writeAttachTicket = opts => {
    ticket(dir,n,opts);
    put(dir,rel,read(dir,rel).replace('放到哪：'+output(n),'放到哪：'+output(n)+'、work\\01-附件\\'));
  };
  writeAttachTicket({quote:''});
  report(dir, 'ticket', n, '通过');
  writeAttachTicket();
  assert.match(report(dir, 'accept', n, '不通过'), /✗ 放到哪 work\\01-附件\\ 是空文件夹或不是文件夹/);
  put(dir, 'work/01-附件/明细.csv', '编号\n1\n');
  assert.match(report(dir, 'accept', n, '通过'), /✓ 放到哪 work\\01-附件\\ 在/);
});

test('T2 · 仅确认日期无效时，有真值来源和预检指纹的单票仍不通过', windows, () => {
  const dir = project('确认日期', 'v2.0.0'), n = '01';
  products(dir, n);
  ticket(dir, n, { quote: '' });
  report(dir, 'ticket', n, '通过');
  ticket(dir, n);
  report(dir, 'accept', n, '通过');
  put(dir, ticketPath(n), read(dir, ticketPath(n)).replace('2026-11-19', '2025-02-31'));
  assert.match(report(dir, 'accept', n, '不通过'), /确认记录须写日期和真实原话/);
});

test('E · 三段式初始化、版本阈值与发布入口一致，两个 autocrlf 克隆各重建 27 个成员', windows, t => {
  const title = '# Agent 搭建教练 v2.1.0 (2026-11-25)';
  assert.equal(read(skill, 'AGENTS.md').split(/\r?\n/)[0], title);
  for (const [p,line] of [['AGENTS.md',7],['做法/1-建项目.md',4]]) assert.ok(read(skill,p).split(/\r?\n/)[line-1].includes('v2.1.0 (2026-11-25)'));
  const overview = read(skill, '讲解/五站总览.html');
  for (const tag of ['title','h1']) assert.ok(overview.includes(`<${tag}>Agent 搭建教练 v2.1.0：五站总览</${tag}>`));
  const checkBox = overview.split('<g id="check">')[1].split('</g>')[0];
  for (const word of ['项目建好了','任务单确认','拆解确认','流程就这样','就这样跑','按快跑档推进','票 N 通过','采用','停止','修复全部硬伤','按建议修好并接着做']) assert.ok(checkBox.includes(word), word);
  const dir = path.join(tmp, '新建');
  report(dir, 'init', undefined, '通过');
  assert.match(read(dir, idx), /^搭建教练版本：v2\.1\.0$/m);
  const fake = path.join(tmp, '坏包');
  put(fake, '工具/coach-check.mjs', fs.readFileSync(checker));
  put(fake, 'AGENTS.md', '# Agent 搭建教练 v2.0 (2026-11-20)');
  const fail = spawnSync(process.execPath,[path.join(fake,'工具/coach-check.mjs'),'init',path.join(tmp,'拒建')],{ encoding:'utf8' });
  assert.equal(fail.status, 1);
  assert.match(fail.stderr, /版本|三段/);
  assert.equal(fs.existsSync(path.join(tmp,'拒建',idx)), false);
  // 生产门槛都以 .0 结尾；在临时副本内直接核非零修订号，不为测试给 CLI 加入口。
  const probe = path.join(fake, '工具/coach-check.mjs');
  fs.appendFileSync(probe, `\nconsole.log(JSON.stringify([parseVer('无版号'), parseVer('v1.21'), parseVer('v2.10.12'),
    verAtLeast(parseVer('v2.10.12'), [2, 10, 3]), verAtLeast(parseVer('v2.10.3'), [2, 10, 12])]));\n`);
  const probed = execFileSync(process.execPath, [probe,'quote',dir], { encoding:'utf8', input:'核验版本' });
  assert.deepEqual(JSON.parse(probed.trimEnd().split('\n').at(-1)), [null,[1,21,0],[2,10,12],true,false]);
  ticket(dir, '01');
  const template = project('排序样例');
  put(dir, 'docs/run-flow.md', read(template, 'docs/run-flow.md'));
  products(dir, '01');
  for (const [v, strict] of [['v1.20.99',false],['v1.21.0',true],['v1.100.2',true],['v2.0',true],['v0.99.9',false]]) {
    put(dir, idx, '搭建教练版本：' + v);
    const body = report(dir, 'accept', '01', strict ? '不通过' : '通过');
    assert.match(body, strict ? /已确认但缺预检指纹/ : /没有预检指纹/);
  }

  const installed = path.join(tmp, '候选原包');
  unpack(path.join(release, zipName), installed);
  const names = files(installed);
  assert.deepEqual(names,[
    'AGENTS.md','CLAUDE.md','LICENSE.md','README.md','SKILL.md','做法/0-体检.md','做法/0-修复复诊.md',
    '做法/1-建项目.md','做法/2-SOP-拆开SOP.md','做法/2-新做-说清需求.md','做法/3-排表画图.md','做法/4-一步一票.md',
    '做法/5-收尾交接.md','做法/业务网页-ELI5.md','做法/共用.md','做法/架构推荐表.md','工具/coach-check.mjs',
    '工具/eli5-report.mjs','模板/AGENTS.模板.md','模板/CLAUDE.模板.md','模板/README.模板.md',
    '模板/docs/INTAKE-SOP.模板.md','模板/docs/INTAKE-新做.模板.md','模板/docs/PROJECT_INDEX.模板.md',
    '模板/docs/run-flow.模板.md','模板/docs/票.模板.md','讲解/五站总览.html',
  ].map(name=>name.replaceAll('/','\\')).sort());
  const head = execFileSync('git', ['-C',repo,'rev-parse','HEAD'], { encoding:'utf8' }).trim();
  const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-dual-'));
  try {
    for (const autocrlf of ['true','false']) {
      const clone = path.join(clean, autocrlf);
      execFileSync('git', ['-c','protocol.allow=never','-c','protocol.file.allow=always','-c','core.autocrlf='+autocrlf,'clone','--quiet','--no-hardlinks',repo,clone]);
      assert.equal(execFileSync('git',['-C',clone,'rev-parse','HEAD'],{ encoding:'utf8' }).trim(), head);
      execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-File',path.join(clone,'工具/pack-release.ps1')],{ cwd:clone, env:psEnv });
      const extracted = path.join(clean, '解包-' + autocrlf);
      unpack(path.join(clone,'releases/v2.1.0',zipName), extracted);
      assert.deepEqual(files(extracted), names);
      for (const name of names) assert.ok(fs.readFileSync(path.join(installed,name)).equals(fs.readFileSync(path.join(extracted,name))), name);
      if (autocrlf === 'false') {
        // 下一次发版只改首行，日期和名称也必须跟着变。
        put(clone, 'AGENTS.md', read(clone,'AGENTS.md').replace(title, '# Agent 搭建教练 v12.10.3 (2031-02-04)'));
        execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-File',path.join(clone,'工具/pack-release.ps1')], { env:psEnv });
        const nextDir = path.join(clone, 'releases/v12.10.3'), next = 'agent-coach-v12.10.3-20310204.zip';
        assert.equal(read(nextDir, 'SHA256SUMS.txt'), hashes(nextDir, [next])[next] + '  ' + next + '\n');
      }
      t.diagnostic(`autocrlf=${autocrlf} HEAD=${head} 成员集合相同，解压字节 27/27 完全相等`);
    }
  } finally { fs.rmSync(clean, { recursive:true, force:true }); }
  assert.equal(fs.existsSync(clean), false);
});


// I4 的失败彼此隔离，旧包也能把所有对照跑完并留下首个报告差异。
function ticketMatrix(t, cases, check) {
  let failed = 0;
  for (const [name, sample, expected] of cases) {
    try {
      check(sample, expected, name);
      t.diagnostic('通过 ' + name);
    } catch (error) {
      failed++;
      t.diagnostic('失败 ' + name + '\n' + error.message);
    }
  }
  assert.equal(failed, 0, '失败用例 / ' + cases.length);
}
const fingerprint = (n, v = 1) => `docs/check/ticket-${n}-v${v}.sha256`;
const sha = text => createHash('sha256').update(text).digest('hex');
const sheetDigest = text => sha(text.replace(/^\uFEFF/, '').split(/\r\n?|\n/).map(l => l.trimEnd()).join('\n').trimEnd()) + '\n';
const realConfirmation = '- 第 1 次确认（第 1 版）：2026-11-19｜就这样跑';
const confirmedTicket = draft => draft.replace('## 确认记录\n', '## 确认记录\n' + realConfirmation + '\n');
const inResults = (text, body) => text.replace(/^## 结果[\s\S]*$/m, '## 结果\n' + body);
const scanTicket = (dir, name) => report(path.join(tmp, name), 'scan', dir);
const ranLine = /✓ 内容③：有结果的票/;
const idleLine = /· 内容③：还没有跑过的票，不核/;
function bothTicketReports(dir, n, expected, detail) {
  const reports = ['ticket', 'accept'].map(cmd => report(dir, cmd, n));
  const verdicts = reports.map(body => body.split('\n', 1)[0].split('｜').at(-1));
  assert.deepEqual(verdicts, expected, reports.join('\n'));
  if (detail) {
    detail.forEach((pattern, i) => { if (pattern) assert.match(reports[i], pattern); });
  }
}

test('I4 01–04 · 历史轮次在真实结果区，容器与代码不授予豁免', windows, t => {
  const n = '01', rel = ticketPath(n);
  const blocks = [
    ['顶格', r => r, true],
    ...[' ', '  ', '   ', '    ', '\t'].map((s, i) => ['缩进-' + i, r => s + r, i < 3]),
    ['反引号围栏', r => '```text\n' + r + '\n```', false],
    ['波浪围栏含二级标题', r => '~~~text\n## 结果\n' + r + '\n~~~', false],
    ['闭栏外', r => '```text\n## 示例说明\n' + r + '\n```\n' + r, true],
    ['单反引号行内', r => '`运行摘要`\n' + r, true],
    ['三反引号行内', r => '```运行摘要```\n' + r, true],
    ['列表栏内空二级标题', r => '- ~~~text\n  ##\n  ' + r + '\n  ~~~', false],
    ['有序项栏闭合', r => '2. ```text\n   ##\t附注\n   ```\n' + r, true],
    ['引号套列表栏自然闭合', r => '> - ```text\n>   ' + r + '\n' + r, true],
    ['列表套引号栏自然闭合', r => '- > ~~~text\n  >   ' + r + '\n' + r, true],
    ['引用内缩进标题', r => '>   ' + r, false],
    ['列表内缩进标题', r => '- 示例\n  ' + r, false],
    ['断开引用后有序项与栏', r => '> 说明\n2. 输出样例\n   ~~~text\n   ' + r + '\n   ~~~\n' + r, true],
    ['段落中的序号续行后围栏', r => '说明\n    续行甲\n\t续行乙\n2) 输出样例\n   ~~~text\n' + r + '\n   ~~~', false],
    ['主题分隔线与正常外层轮次', r => '- - -\n***\n___\n' + r, true],
    ['结果外轮次', r => '##\t附注\n' + r, false],
    ['最后结果节无轮次', r => r + '\n## 结果\n###第 2 轮', false],
  ];
  ticketMatrix(t, [1, 2].flatMap(v => blocks.map(([name, wrap, want]) =>
    ['v' + v + ' ' + name, [v, wrap], want])), ([v, wrap], want, name) => {
    const dir = project('历史-' + name, 'v1.17', upgrade + '｜历史票：01@1、01@2');
    products(dir, n);
    ticket(dir, n, { v });
    const round = v === 1 ? '### 第 1 轮' : '### 第 2 轮｜按第 2 次确认（第 2 版）';
    put(dir, rel, inResults(read(dir, rel), wrap(round)));
    const expected = want ? '通过' : '不通过';
    bothTicketReports(dir, n, [expected, expected], want ? [] : [/缺预检指纹/, /缺预检指纹/]);
    assert.match(scanTicket(dir, '扫描-' + name), want ? ranLine : idleLine);
    assert.equal(fs.existsSync(path.join(dir, fingerprint(n, v))), false);
  });
});

test('I4 06–07 · Setext 起点、真实终点与反向块', windows, t => {
  const n = '01', rel = ticketPath(n), round = '### 第 2 轮｜第 2 版';
  const heading = [
    ['H2 直邻', '附注\n----'],
    ['H1 隔行', '\n附注\n===='],
    ['多行 H2', '普通文字\n附注甲\n附注乙\n---'],
    ['三行 H1 单等号', '前文\n\n附注甲\n附注乙\n附注丙\n='],
    ['缩进三列单横线', '\n   附注\n   - \t'],
    ['缩进一列单等号', '\n 附注\n =\t'],
    ['实际 Tab 尾', '附注\n ----\t'],
    ['引用定义后的 H2', '[ref]: /x\n附注\n---'],
    ['段落四列续行成为多行 H2', '附注甲\n    附注乙\n\t附注丙\n---'],
    ['ATX 对照', '## 附注'],
  ];
  const nonHeading = [
    ['独立分隔线', '----'], ['独立等号', '='], ['空行隔段', '说明\n\n---'],
    ['空格分隔线', '说明\n- - -'], ['混标记', '说明\n--='], ['四列下划线', '说明\n    ---'],
    ['Tab 下划线', '说明\n\t==='], ['转义下划线', '说明\n\\---'],
    ['围栏内 Setext', '~~~text\n说明\n====\n~~~'], ['注释内 Setext', '<!--\n说明\n----\n-->'],
    ['列表内 Setext', '- 附注\n  ----'], ['引用内 Setext', '> 附注\n> ----'],
    ['缺引用标记等号', '> 附注\n===='], ['缺引用标记横线', '> 附注\n----'],
    ['延迟文字加显式下划线', '> 甲\n乙\n> ==='], ['合法引用定义加独立线', '[ref]: /x\n----'],
  ];
  ticketMatrix(t, [
    ...heading.flatMap(([name, section]) => [false, true].map(list => ['节外 ' + name + ' 清单=' + list, [section, true, list], false])),
    ...nonHeading.map(([name, section]) => ['结果内 ' + name, [section, false, true], true]),
  ], ([section, isHeading, list], want, name) => {
    const upgraded = list ? upgrade + '｜历史票：01@2' : upgrade;
    const dir = project('Setext-' + name, 'v1.17', upgraded);
    products(dir, n);
    ticket(dir, n, { v: 2 });
    const text = inResults(read(dir, rel), section + '\n' + round);
    put(dir, rel, text);
    const verdict = want ? '通过' : '不通过';
    bothTicketReports(dir, n, [verdict, verdict], want ? [] : [/缺预检指纹/, /缺预检指纹/]);
    assert.match(scanTicket(dir, 'Setext扫描-' + name), want ? ranLine : idleLine);
    if (isHeading) {
      put(dir, rel, text.replace(/^-\s*第 .*确认.*\n/m, ''));
      report(dir, 'ticket', n, '通过');
      assert.match(scanTicket(dir, 'Setext草稿-' + name), idleLine);
    }
  });

});

test('I4 06 · Setext 标题从首行截断规范摘要', windows, t => {
  const n = '01', rel = ticketPath(n);
  const heading = [
    ['附注\n----', ''], ['附注\n====', ''], ['附注甲\n附注乙\n-', ''],
    ['前文\n\n附注甲\n附注乙\n=', '前文\n\n'], ['[ref]: /x\n附注\n---', '[ref]: /x\n'],
    ['   附注\n   - \t', ''], ['附注\n ----\t', ''], ['## 附注', ''],
  ];
  const dir = project('Setext原文指纹', 'v2.0.0');
  ticket(dir, n, { quote: '', round: false });
  const draft = read(dir, rel).replace('## 确认记录', '### 阅读提示\n## 确认记录');
  const sheet = draft.slice(draft.indexOf('## 验收单'), draft.indexOf('## 确认记录'));
  ticketMatrix(t, heading.map(([section, before], i) => ['原文切片 ' + i, section, sheetDigest(sheet + '\n' + before)]), (section, wanted) => {
    put(dir, rel, draft.replace('## 确认记录', '\n' + section + '\n## 确认记录'));
    report(dir, 'ticket', n, '通过');
    assert.equal(read(dir, fingerprint(n)), wanted);
  });
});

const goodRounds = [
  '第 1 轮', '第 8 轮', '第 2 轮（第 2 版）', '第 2 轮(第 2 版）', '第 2 轮（第 2 版)',
  '第 2 轮｜第 2 版', '第 2 轮|第 2 版的验收单', '第 2 轮｜（第 2 版）',
  '第 2 轮 | 按第 3 次确认 (第 2 版)的验收单', '第 2 轮 ｜ 按第 3 次确认（第 2 版）的验收单',
  '第\t2 \t轮|按第  3 次确认第\t2 版', '第 9007199254740993 轮（第 2 版）',
  '第 2 轮（第 2 版） ###', '第 2 轮（第 2 版）\t###',
  '第 2 轮（第 2 版） <!--补注--> ###',
];
const badRounds = [
  '第 1 轮###', '第 1 轮填写示例', '第 0 轮', '第 01 轮', '第 １ 轮',
  '第 K 轮', '第 2 轮｜按第 K 次确认（第 2 版）', '第 2 轮｜按第 1 次确认（第 V 版）',
  '第 2 轮｜按第 0 次确认（第 2 版）', '第 2 轮｜按第 01 次确认（第 2 版）',
  '第 2 轮｜第 0 版', '第 2 轮｜第 02 版', '第 2 轮｜第 ２ 版',
  '第 2 轮｜第 2 版<待实跑>', '第 2 轮｜第 2 版<…>', '第 2 轮｜第 2 版待跑',
  '第 2 轮｜第 2 版待实跑', '第 2 轮｜第 2 版未跑', '第 2 轮｜第 2 版未实跑',
  '第 2 轮｜按第 3 次确认第 2 版）', '第 2 轮｜按第 3 次确认（第 2 版',
  '第 2 轮（第 2 版）的验收单', '第 2 轮（第 2 版） 尾注', '第 2 轮 ### <!--尾注-->',
];
test('I4 08 · 扫描与历史豁免共用轮次语法，保留原行和超大正整数', windows, t => {
  const n = '01', rel = ticketPath(n);
  const cases = [
    ...goodRounds.map((label, i) => ['合法 ' + i, ['### ' + label, i < 2 ? 1 : 2], true]),
    ...badRounds.map((label, i) => ['非法 ' + i, ['### ' + label, 2], false]),
    ['无空白井号', ['###第 2 轮（第 2 版）', 2], false],
    ['七个井号', ['####### 第 2 轮（第 2 版）', 2], false],
    ['确实跑了别版', ['### 第 1 轮', 2], true],
    ['超大版号精确匹配', ['### 第 2 轮（第 9007199254740993 版）', '9007199254740993'], true],
  ];
  ticketMatrix(t, cases, ([header, v], ran, name) => {
    const dir = project('轮次-' + name, 'v1.17', upgrade);
    products(dir, n);
    ticket(dir, n, { v });
    const text = inResults(read(dir, rel), header), match = ran && name !== '确实跑了别版';
    put(dir, rel, text);
    const wanted = match ? '通过' : '不通过';
    bothTicketReports(dir, n, [wanted, wanted], match ? [] : [/缺预检指纹/, /缺预检指纹/]);
    assert.match(scanTicket(dir, '轮次扫描-' + name), ran ? ranLine : idleLine);
  });

});

test('I4 08 · 草稿扫描取首个合法轮次的原文行号', windows, () => {
  const n = '01', rel = ticketPath(n);
  const dir = project('先见真实轮次行号', 'v2.0.0');
  ticket(dir, n, { quote: '', round: false });
  const text = inResults(read(dir, rel), [
    '### 第 1 轮填写示例', '<!--', '### 第 3 轮', '-->',
    ' \t缩进示例', '### 第 9007199254740993 轮 ###', '### 第 2 轮',
  ].join('\n'));
  put(dir, rel, text);
  report(dir, 'ticket', n, '通过');
  const i = text.split('\n').findIndex(l => l.includes('9007199254740993')) + 1;
  assert.match(scanTicket(dir, '第一条真实轮次'), new RegExp('第 9007199254740993 轮结果.*第 ' + i + ' 行'));
});

function changedParameterTicket(name) {
  const dir = project(name, 'v2.0.0'), n = '01';
  put(dir, 'docs/run-flow.md', read(dir, 'docs/run-flow.md').replace('inputs\\01-样本\\', 'inputs\\01-样本\\｜参数：<报告周>'));
  products(dir, n);
  put(dir, output(n), '参数｜报告周：W45\n金额：12\n');
  ticket(dir, n, { quote: '', round: false });
  const draft = read(dir, ticketPath(n)).replace('### AI 自检\n', [
    '### AI 自检', '#### 固定基线断言（绑定参数：W44）', '- work\\01-结果.txt 含 999',
    '#### 当期守恒断言（每次必核）', '',
  ].join('\n'));
  put(dir, ticketPath(n), draft);
  report(dir, 'ticket', n, '通过');
  return { dir, draft };
}

test('I4 02–10 · 换参只读最后真实轮次中可见的基线状态', windows, t => {
  const n = '01', r1 = '### 第 1 轮\n', r2 = '### 第 2 轮｜按第 2 次确认（第 2 版）\n';
  const status = '固定基线 W44：未跑（本轮代码未改动）';
  const cases = [
    ['Setext H2 节外状态', r1 + '\n附注\n----\n' + status, false],
    ['Setext H1 多行节外状态', r1 + '\n附注甲\n附注乙\n=\n' + status, false],
    ['仅非法轮次和状态', '### 第 1 轮###\n' + status, false],
    ['真后伪示例', r1 + status + '\n### 第 2 轮填写示例\n说明', true],
    ['真前伪示例', '### 第 2 轮填写示例\n说明\n' + r1 + status, true],
    ['仅伪标题节里有状态', r1 + '说明\n### 第 2 轮填写示例\n' + status, false],
    ['两轮间伪示例，最新无状态', r1 + status + '\n### 第 9 轮填写示例\n示例\n' + r2, false],
    ['按先后取最后，非最大轮号', r2 + '说明\n' + r1 + status, true],
    ['仅之前的结果节', r1 + status + '\n## 结果\n' + r2, false],
    ['栏外二级空标题', r1 + '##\n' + status, false],
    ['栏外二级 Tab 标题', r1 + '##\t附注\n' + status, false],
    ['列表中的二级标题', r1 + '- 说明\n  ## 附注\n' + status, true],
    ['引用列表内唯一基线', r1 + '> - ```text\n>   ' + status + '\n>   ```', false],
    ['列表引用自然闭栏后基线', r1 + '- > ~~~text\n  > 无状态\n' + status, true],
    ['有序项空行后可开栏', r1 + '说明\n\n2. 样例\n   ~~~text\n   ' + status + '\n   ~~~', false],
    ['有序项 1 中断段落', r1 + '说明\n1. 样例\n   ~~~text\n   ' + status + '\n   ~~~', false],
    ['空标记不打断段落', r1 + '说明\n+\n   ~~~text\n' + status + '\n   ~~~', false],
    ['引用退出后外层状态', r1 + '> 说明\n2. 输出样例\n   ~~~text\n' + status + '\n   ~~~', true],
    ['引用退出后仍在围栏', r1 + '> 说明\n2. 输出样例\n   ~~~text\n   ' + status + '\n   ~~~', false],
    ['普通续段 Tab', r1 + '说明\n    续行\n\t' + status, true],
    ['独立缩进 Tab', r1 + '说明\n\n\t' + status, false],
    ['注释多行内唯一状态', r1 + '<!--\n\n' + status + '\n-->', false],
    ['注释一行闭合后余文隐藏', r1 + '<!-- 留言 --> ' + status, false],
    ['注释块下一行可见', r1 + '<!--\n## 附注\n--> 伪文\n' + status, true],
    ['行内多注仅隐藏假状态', r1 + '附言 <!--混合--> 前 <!-- ' + status + ' --> 后', false],
    ['行内去注释保留两端', r1 + '固定基线 W44：<!-- <待实跑> -->未跑<!-- 尾注 -->', true],
    ['行内注释跨连续物理行', r1 + '说明 <!-- 注释\n' + status + '\n--> 可见尾巴', false],
    ['行内未闭注释不能吃二级标题', r1 + '说明 <!-- 注释\n## 附注\n-->\n' + status, false],
    ['代码跨度保留注释原字面', r1 + '固定基线 W44：`<!-- <待实跑> -->`未跑', false],
    ['转义的注释开头保留尖括号', r1 + '固定基线 W44：\\<!-- <待实跑> -->未跑', false],
    ['无闭符的注释开头保留', r1 + '固定基线 W44：<!-- <待实跑> 未跑', false],
    ['真实标签属性中的注释开头原样', r1 + '固定基线 W44：<a title="<!-- x -->">未跑', false],
    ['未闭块到 EOF', r1 + '<!--\n' + status, false],
    ['未闭容器注释退出后状态', r1 + '> <!--\n> ## 附注\n' + status, true],
    ['类型 1 原始标签闭合后状态', r1 + '<pre>\n## 附注\n</pre>\n' + status, true],
    ['类型 3 处理指令中假状态', r1 + '<?x\n' + status + '\n?>', false],
    ['类型 4 声明内假状态', r1 + '<!X\n' + status + '\n>', false],
    ['类型 5 CDATA 中假状态', r1 + '<![CDATA[\n' + status + '\n]]>', false],
    ['类型 6 块标签空行后状态', r1 + '<div>\n## 附注\n\n' + status, true],
    ['类型 7 独立标签内假状态', r1 + '<x title=">">\n' + status + '\n\n', false],
    ['类型 7 不能中断段落', r1 + '说明\n<x title=">">\n' + status, true],
    ['方括号模板说明', r1 + '固定基线 W44：［未跑］', false],
    ['尖括号模板说明', r1 + '固定基线 W44：<待实跑> 未跑', false],
  ];
  ticketMatrix(t, cases, (body, wanted, name) => {
    const { dir, draft } = changedParameterTicket('换参-' + name.replace(/[:：]/g, '-'));
    const confirmed = inResults(confirmedTicket(draft), body);
    put(dir, ticketPath(n), confirmed);
    const saved = read(dir, fingerprint(n));
    const result = report(dir, 'accept', n, wanted ? '通过' : '不通过');
    if (!wanted) assert.match(result, /固定基线状态/);
    assert.equal(read(dir, ticketPath(n)), confirmed);
    assert.equal(read(dir, fingerprint(n)), saved);
  });
});

test('I4 09–10 · 块与行内注释不能授予确认或真值，注释仍受规范摘要保护', windows, t => {
  const n = '01', rel = ticketPath(n);
  const notes = '<!--\n## 附注\n##\n##\t附注\n### AI 自检\n- 预期值来源：伪真值\n- work\\01-结果.txt 含 999\n-->';
  const cases = [
    ['真确认跟在注释下一行', draft => draft.replace('## 确认记录\n', '## 确认记录\n' + notes + '\n' + realConfirmation + '\n'), true],
    ['确认只在注释内', draft => draft.replace('## 确认记录\n', '## 确认记录\n<!--\n' + realConfirmation + '\n-->\n'), false],
    ['行尾注释不污染原话', draft => confirmedTicket(draft).replace(realConfirmation, realConfirmation + ' <!--仅备注-->'), true],
    ['确认占位尖括号保留', draft => confirmedTicket(draft).replace('就这样跑', '<…>'), false],
    ['行内注释掩住真值占位后仍无有效来源', draft => confirmedTicket(draft).replace(src(n), '<报告周><!-- 只留占位 -->'), false],
  ];
  ticketMatrix(t, cases, (transform, want, name) => {
    const dir = project('可见性-' + name, 'v2.0.0');
    products(dir, n);
    ticket(dir, n, { quote: '' });
    const draft = read(dir, rel);
    report(dir, 'ticket', n, '通过');
    const saved = read(dir, fingerprint(n)), text = transform(draft);
    put(dir, rel, text);
    const result = report(dir, 'accept', n, want ? '通过' : '不通过');
    const scan = scanTicket(dir, '可见性扫描-' + name);
    if (want) assert.match(scan, ranLine);
    else if (name === '确认只在注释内') {
      assert.match(result, /没有有效的本票确认记录/);
      assert.match(scan, /✗ 内容③：.*真人门/);
    }
    assert.equal(read(dir, rel), text);
    assert.equal(read(dir, fingerprint(n)), saved);
  });

});

test('I4 09–10 · 节内注释参加全文指纹，行内只去注释字符', windows, () => {
  const n = '01', rel = ticketPath(n);
  const notes = '<!--\n## 附注\n### AI 自检\n- 预期值来源：伪真值\n-->';
  const dir = project('规范注释原文入签', 'v2.0.0');
  products(dir, n);
  ticket(dir, n, { quote: '' });
  const draft = read(dir, rel).replace('### AI 自检', notes + '\n### AI 自检 <!-- 标题内 --> ###')
    .replace(' 含 12', ' 含 <!-- 前注 -->12<!-- 后注 -->');
  put(dir, rel, draft);
  report(dir, 'ticket', n, '通过');
  assert.equal(read(dir, fingerprint(n)), sheetDigest(draft.slice(draft.indexOf('## 验收单'), draft.indexOf('## 确认记录'))));
  const saved = read(dir, fingerprint(n));
  put(dir, rel, confirmedTicket(draft));
  bothTicketReports(dir, n, ['通过', '通过']);
  put(dir, rel, confirmedTicket(draft).replace('伪真值', '修改说明'));
  bothTicketReports(dir, n, ['不通过', '不通过'], [/已确认/, /在确认\/预检后被改过/]);
  assert.equal(read(dir, fingerprint(n)), saved);
});


const oldA = [
  '# 票 02：核对金额', '## 这一步（照运行表第 2 行）', '从哪拿：work\\01-清点.txt', '做什么：汇总', '放到哪：work\\02-汇总.txt', '',
  '## 验收单（第 1 版）', '- 预期值来源：边界小样核定：金额 60 和 75，两笔合计 135', '### AI 自检',
  '- work\\02-汇总.txt 含 净额：135', '- work\\02-坏输入\\结果.txt 含 已拦截', '### 阅读提示', '格式见下例。',
  '~~~markdown', '## 附注', '~~~', '', '## 确认记录', '', '## 结果', '### 第 1 轮｜按第 1 次确认（第 1 版）', '',
].join('\n');
const oldExamples = [
  ['A 围栏中截断', oldA, '488ee3d96c3700154d88961386b724833b02f1de0139109e14b37260f83d1207', '2428d5dc6001414d36cf73f951b68950a409511fc7721b95f68258d21f6f0c54'],
  ['B 真空二级标题', oldA.replace('~~~markdown\n## 附注\n~~~', '##\n随附说明。'), '08efad5f4e2d04b0c3cffbab0e4ba5436715fcc459685f157dfad7584a11d4f5', '85c2ef18f0854389947c509986c71b8ee31bbfede58ae5512b538a0842336012'],
  ['B 真 Tab 标题', oldA.replace('~~~markdown\n## 附注\n~~~', '##\t附注\n随附说明。'), '5d337f58fb0bae783aeff91d495f999a16aa9f0558e236c35f6e299be7363c7c', '85c2ef18f0854389947c509986c71b8ee31bbfede58ae5512b538a0842336012'],
];
const oldMain = '- work\\02-汇总.txt 含 净额：135';
const oldBad = '- work\\02-坏输入\\结果.txt 含 已拦截';
const beforeConfirmation = text => text.slice(text.indexOf('## 验收单'), text.indexOf('## 确认记录'));
function oldProject(name, version = 'v1.21', marker = upgrade) {
  const dir = project(name, version, marker);
  put(dir, 'docs/run-flow.md', read(dir, 'docs/run-flow.md').replaceAll(output('01'), 'work\\01-清点.txt').replaceAll(output('02'), 'work\\02-汇总.txt'));
  put(dir, 'work/02-汇总.txt', '净额：135\n');
  put(dir, 'work/02-坏输入/结果.txt', '已拦截\n');
  return dir;
}

test('13.57.11 1.1 · 无效链接引用定义与附录同属 Setext 标题', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const definition = '[资料]: docs\\ "本地目录"';
  const draft = oldA.replace('格式见下例。\n~~~markdown\n## 附注\n~~~', '格式举例。\n\n' + definition + '\n附录\n----');
  const editAppendix = text => text.replace('"本地目录"', '"培训资料"');
  const original = confirmedTicket(draft), edited = editAppendix(original);
  assert.equal(Buffer.byteLength(original), 564);
  assert.equal(Buffer.byteLength(edited), 564);
  assert.equal(sha(original), 'd50e86e3bd2f4a94c41499ed960a5acda8f7c3b58df4ab081e82273d71589954');
  assert.equal(sha(edited), '39af17943ded340e2549d02f57a20de94ddfa4e43ec7d47f3e4cd1b4f367f31f');
  const canonical = 'ab52f193cfbdbb47829b2e0b19dbbfa672953a7b14185b7de0c46ceae3ab5021\n';
  const forward = draft.replace('docs\\', 'docs/');
  const forwardStamp = sheetDigest(forward.slice(forward.indexOf('## 验收单'), forward.indexOf('\n附录\n----')));
  const atLineEnd = draft.replace(definition, '[资料]: docs\\\n"本地目录"');
  const atLineEndStamp = sheetDigest(atLineEnd.slice(atLineEnd.indexOf('## 验收单'), atLineEnd.indexOf('\n"本地目录"')));
  ticketMatrix(t, [
    ['反斜杠接空格', draft, [canonical, '通过']],
    ['正斜杠引用定义', forward, [forwardStamp, '不通过']],
    ['显式二级标题', draft.replace(definition, '## 附录\n' + definition), [canonical, '通过']],
    ['行尾反斜杠后不读取下一行标题', atLineEnd, [atLineEndStamp, '通过']],
  ], (candidate, [expectedStamp, verdict], name) => {
    const dir = oldProject('附录边界-' + name, 'v2.0.0', '');
    put(dir, rel, candidate);
    report(dir, 'ticket', n, '通过');
    const initial = fs.readFileSync(path.join(dir, stamp));
    assert.equal(initial.length, 65);
    put(dir, rel, confirmedTicket(candidate));
    bothTicketReports(dir, n, ['通过', '通过']);
    put(dir, rel, editAppendix(confirmedTicket(candidate)));
    const reports = ['ticket', 'accept'].map(cmd => report(dir, cmd, n));
    const outcomes = reports.map(body => body.split('\n', 1)[0].split('｜').at(-1));
    assert.deepEqual(fs.readFileSync(path.join(dir, stamp)), initial);
    assert.deepEqual([initial.toString('ascii'), ...outcomes], [expectedStamp, verdict, verdict], reports.join('\n'));
    if (verdict === '不通过') {
      assert.match(reports[0], /已确认，改验收单须升为第 2 版/);
      assert.match(reports[1], /在确认\/预检后被改过/);
    }
  });
});

test('13.57.11 1.2 · 内层链接外的真实注释剥离，合法链接和图片标题保留', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const note = '<!-- 备注 -->';
  const nested = '[外层 [内](a)](b "' + note + '")';
  const using = inline => oldA.replace('金额 60 和 75，两笔合计 135', '见 ' + inline);
  const original = using(nested), without = original.replace(note, '');
  assert.equal(Buffer.byteLength(original), 495);
  assert.equal(Buffer.byteLength(without), 480);
  assert.equal(sha(original), '7d64d86b34dd40ae3a1cb463f31fc3d0ad632af1ff5df07182014501a3da7119');
  assert.equal(sha(without), 'feae1812d86bbfb459424c06a0315f3247662af8415eca8c44d55c0295e0a9b6');
  const withInner = inline => using(nested.replace('[内](a)', inline));
  const refs = text => text.replace('## 确认记录', '[r]: a\n[内]: a\n\n## 确认记录');
  ticketMatrix(t, [
    ['行内链接', original, true],
    ['去注释单变量对照', without, true],
    ['完整引用链接', refs(withInner('[内][r]')), true],
    ['折叠引用链接', refs(withInner('[内][]')), true],
    ['简式引用链接', refs(withInner('[内]')), true],
    ['未定义的完整引用不退简式', refs(withInner('[内][缺]')), false],
    ['嵌套方括号的未定义引用不退简式', refs(withInner('[内][[缺]]')), false],
    ['引用后缀码跨度内的右括号不闭合引用',
      refs(withInner('[内][`x]缺`]')).replace('[r]: a', '[`x]: a'), false],
    ['内层转义感叹号', withInner('\\![内](a)'), true],
    ['外层转义感叹号', using('\\!' + nested), true],
    ['不成图时简式链接仍成立', refs(withInner('![内](a b)')), true],
    ['链接内嵌图片', using('[![图](a)](b "' + note + '")'), false],
    ['链接内嵌图片无注释', using('[![图](a)](b "")'), true],
    ['外层是包含链接的图片', using('!' + nested), false],
    ['图片描述的链接不越出图片', withInner('![图 [内](a)](c)'), false],
    ['普通链接标题', using('[资料](b "' + note + '")'), false],
    ['普通链接标题无注释', using('[资料](b "")'), true],
  ], (candidate, want, name) => {
    const dir = oldProject('链接注释-' + name, 'v2.0.0', '');
    put(dir, rel, candidate);
    const result = report(dir, 'ticket', n, want ? '通过' : '不通过');
    assert.equal(fs.existsSync(path.join(dir, stamp)), want, result);
    if (!want) assert.match(result, /缺少独立真值来源/);
  });
});

test('13.57.12 1 · 自动链接内的方括号和圆括号不影响确认票验收', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const cases = ['report[1](copy).pdf', 'report1(copy).pdf', 'report].pdf'];
  ticketMatrix(t, cases.map((file, i) => [file, file, i === 0]), (file, original, name) => {
    const dir = oldProject('自动链接验收-' + name, 'v2.0.0', '');
    const assertion = `[资料 <https://example.invalid/${file}>](本地说明 "<!-- 备注 -->")`;
    const draft = oldA.replace(oldMain, '- work\\02-汇总.txt 含 ' + assertion);
    const signed = confirmedTicket(draft);
    const product = '净额：135\n' + assertion + '\n';
    if (original) {
      assert.equal(Buffer.byteLength(signed), 623);
      assert.equal(sha(signed), '941eee04ad1e700f3f89c13685a5f7e2edae4011283804c4b4cce68bbaf4acc9');
      assert.equal(Buffer.byteLength(product), 100);
      assert.equal(sha(product), 'e1f0778468611a7c40f7afe23745e73b61ffb04c135537949e7dcc8ccd690d65');
    }
    put(dir, 'work/02-汇总.txt', product);
    put(dir, rel, draft);
    report(dir, 'ticket', n, '通过');
    const saved = fs.readFileSync(path.join(dir, stamp));
    assert.equal(saved.length, 65);
    assert.equal(saved.toString('ascii'), sheetDigest(beforeConfirmation(draft)));
    if (original) assert.equal(sha(saved), 'bca2df4b3acac0bafe3c39ba94d02a60622219ac3daebb1b92c228df4da91a6a');
    put(dir, rel, signed);
    for (const cmd of ['ticket', 'accept']) {
      report(dir, cmd, n, '通过');
      assert.deepEqual(fs.readFileSync(path.join(dir, stamp)), saved);
    }
  });
});

function packagedMarkdownParser() {
  const source = fs.readFileSync(checker, 'utf8');
  const start = source.indexOf('const mdSpace = ');
  const end = source.indexOf('function sheetFacts(', start);
  assert.ok(start >= 0 && end > start, '在实际解包脚本中找不到票据 Markdown 解析器');
  return new Function(source.slice(start, end) + '\nreturn { mdTicket, mdInlineRanges };')();
}

test('13.57.12 2 · 自动链接保护外层标题，代码和真正注释按原坐标处理', windows, t => {
  const { mdTicket } = packagedMarkdownParser();
  const note = '<!-- 备注 -->';
  const cases = [
    ...['a[示例](b)', 'a]', 'a[1](b)/资料', 'a]b[c]'].map(p =>
      [p, `材料 [内 <https://example.invalid/${p}>](b "${note}")`, false]),
    ['最小外层标题', '[<ab:x[y](z)>](b "<!--n-->")', false],
    ['邮箱里的反引号', '<a`b@example.com> ' + note + ' `', true],
    ['URI 里的反引号', '<https://example.invalid/a`b> ' + note + ' `', true],
    ['外层链接内的邮箱反引号', '[a <u`v@ex.com> ' + note + ' `](d)', true],
    ['真实嵌套链接旁的注释', `[外层 [内](a)](b "${note}")`, true],
    ['嵌入图片保留外层标题', `[![图](a)](b "${note}")`, false],
  ];
  ticketMatrix(t, cases, (line, hidden) => {
    const doc = mdTicket('[r]: doc\n\n## 资料\n\n' + line + '\n');
    const from = line.indexOf(note), to = from + note.length;
    assert.equal(doc.rows[4].visible, hidden ? line.replace(note, '') : line);
    assert.deepEqual(doc.rows[4].mask, hidden ? [[from, to]] : []);
    const comments = doc.inlineRanges.filter(range => range.kind === 'comment');
    assert.deepEqual(comments, hidden ? [{ start: 4, after: 5, kind: 'comment', from, to }] : []);
  });
});

test('13.57.12 3 · URI 和邮箱范围、链接目标限制与引用标签边界', windows, t => {
  const { mdInlineRanges } = packagedMarkdownParser();
  const references = new Set(['A', 'R <HTTPS://X/Y]Z>']);
  const cases = [
    ['两字符协议', '<ab:x[y](z)>', true],
    ['三十二字符协议', '<' + 'a'.repeat(32) + ':payload>', true],
    ['单字符协议', '<a:x[y](z)>', false],
    ['三十三字符协议', '<' + 'a'.repeat(33) + ':payload>', false],
    ['邮件协议', '<mailto:user@example.com>', true],
    ['允许的图像数据', '<data:image/png;base64,YQ==>', true],
    ['JavaScript 协议', '<javascript:literal>', false],
    ['VBScript 协议', '<vbscript:literal>', false],
    ['file 协议', '<file:///literal>', false],
    ['HTML 数据', '<data:text/html,literal>', false],
    ['图像数据类型中的实体仍是字面文本', '<data:image&#47;png;base64,YQ==>', false],
    ['邮箱地址', '<a`b@example.com>', true],
    ['邮箱标签首字符', '<a`b@-example.com>', false],
    ['内层左尖括号打断候选', '<ab:x<y>', false],
    ['无右尖括号', '<ab:x', false],
    ['参考解析器允许紧邻闭符的单个 LF', '<ab:payload\n>', true],
    ['URI 内部的 LF', '<ab:pay\nload>', false],
  ];
  ticketMatrix(t, cases, (text, accepted) => {
    assert.deepEqual(mdInlineRanges(text, references).filter(range => range.kind === 'autolink'),
      accepted ? [{ from: 0, to: text.length, kind: 'autolink' }] : []);
  });
  const label = '[a][r <https://x/y]z>]';
  assert.equal(mdInlineRanges(label, references, 3), label.length - 1);
  assert.deepEqual(mdInlineRanges(label, references), [{ from: 2, to: label.length, kind: 'destination' }]);
});

test('13.57.12 4 · 链接左圆括号后仅剩空白时不回退到简式引用', windows, t => {
  const { mdInlineRanges } = packagedMarkdownParser();
  const references = new Set(['A']);
  ticketMatrix(t, [
    ['串尾', '[a](', []],
    ['空白后串尾', '[a]( \t\n ', []],
    ['坏目标可回退', '[a]( x', [{ from: 2, to: 3, kind: 'reference' }]],
    ['闭合空目标仍成立', '[a]( )', [{ from: 2, to: 6, kind: 'destination' }]],
  ], (text, expected) => assert.deepEqual(mdInlineRanges(text, references), expected));
});

test('13.57.13 四张既有确认票与 PNG、成对反引号和图片对照逐一验收', windows, t => {
  const link = '[资料 `<!--校注--> <https://example.invalid/图`v>`](本地说明)';
  const mini = '[`<!--n-->`x`](b)';
  const png = '![图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGOoBwAAgQCA05RTSgAAAABJRU5ErkJggg== "<!--备注-->")';
  const photo = png.replace('/png', '&sol;png');
  const image = '![x](data:image&sol;png;x "<!--n-->")';
  // 确认票、产物、预检指纹三份实物的散列均来自独立复核回执。
  const originals = [
    ['资料链接', link, link.replace('<!--校注-->', ''), 607, 71,
      '1d203c35c41ae1a905ec1e215ea55a1f3f69d4caa4dab41db98de0da05ecfe96',
      '64325dc03d72e8d1e5e8df284c0622c8e9bacedbe7379405fd71b74ebbb5d807',
      'f8be4af60908a98448b50c1697dfb0e6541aca23b973aaf2bbe305bdeb3c7bcd'],
    ['最小链接', mini, mini.replace('<!--n-->', ''), 554, 23,
      'd2bcc039df37f9d20304e88325a0389bc86db29b8544243db4096485b40ec191',
      '9fc57934de2ed9c674cded2255425220e901c757d03808159e096e69e3579666',
      'c78543b56b1b90783ad5cc9ac79107dbc4b768bb20703386f42ac2d069bc7246'],
    ['PNG 命名斜杠', photo, photo, 679, 156,
      'b722d17d4441b7bff865a0b0355d3c6987691d33ceffbbf7e0e46f02e2b749c2',
      '7619bb61d47c3a9f719cc8acf451b0d6681a9ba11a3f99ef8c1f801d01f80b3e',
      'f5d701dc70dfacb115bf733a5889fd94651e74408eedbcd2f5b65ee7866afd93'],
    ['最小图片', image, image, 574, 51,
      '9b84e06ffcca014cf795da0dff82b90e06c7d8afddd2942c3364f26ee993212b',
      '2d74bfc6ae921fc77abd63be3212d442a0903f32872ef1f9e669fd10bae18977',
      '9015ae01cd98397e39f1a8ac297b8462b0331b17d70634ad929b37cccb1361ae'],
  ];
  const controls = [mini.replace('x`', 'x'), '!' + link, png, png.replace('/png', '&#47;png'),
    png.replace('png;', 'png&semi;'), png.replace('/png', '\\/png')];
  const cases = [...originals, ...controls.map((value, i) => ['对照 ' + (i + 1), value, value])];
  ticketMatrix(t, cases.map(row => [row[0], row]), ([name, assertion, visible, ticketBytes, productBytes, ticketSha, productSha, stampSha]) => {
    const dir = oldProject('两遍扫描-' + name, 'v2.0.0', '');
    const draft = oldA.replace(oldMain, '- work\\02-汇总.txt 含 ' + assertion);
    const signed = confirmedTicket(draft), product = '净额：135\n' + visible + '\n';
    const saved = Buffer.from(sheetDigest(beforeConfirmation(draft)), 'ascii');
    if (ticketSha) {
      assert.deepEqual([Buffer.byteLength(signed), sha(signed)], [ticketBytes, ticketSha]);
      assert.deepEqual([Buffer.byteLength(product), sha(product)], [productBytes, productSha]);
      assert.deepEqual([saved.length, sha(saved)], [65, stampSha]);
    }
    put(dir, 'work/02-汇总.txt', product);
    put(dir, ticketPath('02'), draft);
    report(dir, 'ticket', '02', '通过');
    const stamp = path.join(dir, fingerprint('02'));
    assert.deepEqual(fs.readFileSync(stamp), saved);
    put(dir, ticketPath('02'), signed);
    for (const cmd of ['ticket', 'accept']) {
      report(dir, cmd, '02', '通过');
      assert.deepEqual(fs.readFileSync(stamp), saved);
    }
  });
});

test('13.57.13 反引号缓存区分试读、链接正文与图片正文', windows, () => {
  const { mdInlineRanges } = packagedMarkdownParser(), refs = new Set();
  const note = '<!--n-->';
  for (const width of [1, 2, 3, 7, 12, 32]) {
    const q = '`'.repeat(width), odd = q + note + q + 'x' + q;
    for (const [text, real] of [
      ['[' + odd + '](d)', true], ['![' + odd + '](d)', false],
      ['[外 ![' + odd + '](i)](d)', false], ['![外 [' + odd + '](i)](d)', true],
      ['[' + q + note + q + 'x](d)', false], ['[' + odd, true],
    ]) {
      const at = text.indexOf(note);
      assert.deepEqual(mdInlineRanges(text, refs).filter(r => r.kind === 'comment'),
        real ? [{ from: at, to: at + note.length, kind: 'comment' }] : [], text);
    }
  }
  for (const [depth, count] of [[19, 19], [20, 20], [21, 0], [22, 1]]) {
    const text = '!['.repeat(depth) + '<ab:x> ' + note + '](i)'.repeat(depth);
    const ranges = mdInlineRanges(text, refs);
    assert.deepEqual(['destination', 'autolink', 'comment'].map(k => ranges.filter(r => r.kind === k).length),
      [count, 1, 1], text);
  }
  const text = '[资料 `<!--校注--> <https://example.invalid/图`v>`](本地说明)';
  for (const [input, kinds] of [[text, ['comment', 'autolink']], ['!' + text, []]]) {
    assert.deepEqual(mdInlineRanges(input, refs).filter(r => ['autolink', 'comment'].includes(r.kind)).map(r => r.kind), kinds);
  }
});

test('13.57.13 普通目标与引用定义共用解码，角括号自动链接按字面判断', windows, t => {
  const { mdTicket, mdInlineRanges } = packagedMarkdownParser(), refs = new Set(), title = '<!--题-->';
  const cases = [
    ['data:image/png;x', true, true], ['data:image&sol;png;x', true, false],
    ['data:image/png&semi;x', true, false], ['data:image\\/png\\;x', true, false],
    ['data\\:image&#x2F;png&#59;x', true, false], ['data&colon;image&#47;png;x', true, false],
    ['data:image&SOL;png;x', false, false], ['data:image\\&sol;png;x', false, false],
    ['data:image&amp;sol;png;x', false, false], ['data:image&solpng;x', false, false],
    ['file\\:x', false, false], ['file&colon;x', false, false], ['file\\&colon;x', true, false],
    ['&Tab;file:x', false, false], ['&NewLine;file:x', false, false], ['&ThickSpace;file:x', false, false],
    ['&#x00000066;ile:x', false, false], ['&#000000102;ile:x', true, false], ['&#x0b;file:x', true, false],
    ['data:@image/png;x', true, true], ['data:[image]/png;x', true, true],
  ];
  ticketMatrix(t, cases.map(row => [row[0], row]), ([value, ordinary, literal]) => {
    const auto = '<' + value + '>';
    assert.equal(mdInlineRanges(auto, refs).some(r => r.kind === 'autolink'), literal, auto);
    for (const dest of [value, '<' + value + '>']) {
      for (const prefix of ['[x](', '![x](']) {
        const line = prefix + dest + ' "' + title + '")';
        const ranges = mdInlineRanges(line, refs);
        assert.equal(ranges.some(r => r.kind === 'destination'), ordinary, line);
        assert.equal(ranges.some(r => r.kind === 'comment'), !ordinary, line);
      }
      const doc = mdTicket('[r]: ' + dest + '\n\n材料 [外 [内][r]](d "' + title + '")\n');
      assert.equal(doc.blocks[0].kind === 'reference', ordinary, dest);
      assert.equal(doc.rows[2].visible.includes(title), !ordinary, dest);
    }
  });
});

test('13.57.13 跨行标题按同一个行内输入剥除注释，坐标仍指向原票', windows, () => {
  const { mdTicket } = packagedMarkdownParser();
  const plain = mdTicket('起 <!--首\n续--> 尾\n---\n');
  assert.equal(plain.headings[0].label, '起  尾');
  const listed = mdTicket('- 起\n\t续 <!--甲\n\t乙--> 尾\n  ===\n');
  assert.equal(listed.headings[0].label, '起\n  续  尾');
  assert.deepEqual(listed.rows.map(r => r.mask), [[], [[3, 8]], [[0, 5]], []]);
  assert.deepEqual(listed.rows.map(r => r.visible), ['- 起', '\t续 ', ' 尾', '  ===']);
  assert.equal(mdTicket('> 起\n>\t续\n> ===\n').headings[0].label, '起\n\t续');
});

test('13.57.13 上轮 35 份偏差原文逐份核对注释和自动链接坐标', windows, t => {
  const { mdTicket } = packagedMarkdownParser();
  const note = '<!--甲-->', inner = '<!--乙-->', outer = '<!--丙-->';
  const cases = [];
  const schemes = ['https://资料.example/', 'mailto:', 'ab:', 'X+.-55:', 'L'.repeat(32) + ':',
    'data:image/png;name=i,', 'data:image/webp;base64,'];
  const urls = [...schemes.map(s => s + '图`v'), ...['ex.invalid', 'a-b.utf8', 'x', 'x'.repeat(63) + '.invalid'].map(s => 'a`b@' + s)];
  for (const url of urls) {
    const auto = '<' + url + '>', line = '[手记 `' + auto + '`](页 "' + inner + '") ' + note;
    cases.push([url, { text: '[档]: /目标\n\n## 核对\n\n' + line + '\n', row: 4, marks: [note], auto }]);
  }
  for (const target of ['data:image&sol;png;base64,YQ==', 'data:image/png&semi;base64,YQ==',
    'data:image\\/png;base64,YQ==', '<data:image&sol;png;base64,YQ==>']) {
    for (const image of [false, true]) {
      const part = (image ? '!' : '') + '[图](' + target + ' "' + inner + '")';
      const wrapped = '[外 ' + part + '](档案 "' + outer + '")';
      for (const form of [part, wrapped, '!' + wrapped]) {
        const line = '## 资料 ' + form + ' ' + note;
        cases.push([form, { text: '## 图册\n\n' + line + '\n', row: 2, marks: form === wrapped && !image ? [outer, note] : [note] }]);
      }
    }
  }
  const frames = cases.map(([, { text }]) => {
    const bytes = Buffer.from(text), length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    return Buffer.concat([length, bytes]);
  });
  const input = Buffer.concat(frames);
  assert.deepEqual([cases.length, input.length, sha(input)], [35, 3613, 'a845b97d00a8595c5f594bde9a2f8e0f18982c6a473d2f525c92b424d5304a1b']);
  ticketMatrix(t, cases, ({ text, row, marks, auto }) => {
    const doc = mdTicket(text), line = text.split('\n')[row];
    const coords = (value, kind) => ({ start: row, after: row + 1, from: line.indexOf(value), to: line.indexOf(value) + value.length, kind });
    const comments = marks.map(mark => coords(mark, 'comment'));
    assert.deepEqual(doc.inlineRanges.filter(r => r.kind === 'comment'), comments);
    assert.deepEqual(doc.inlineRanges.filter(r => r.kind === 'autolink'), auto ? [coords(auto, 'autolink')] : []);
    const visible = marks.reduce((s, mark) => s.replace(mark, ''), line);
    assert.equal(doc.rows[row].visible, visible);
    assert.deepEqual(doc.rows[row].mask, comments.map(r => [r.from, r.to]));
    if (row === 2) assert.equal(doc.headings.at(-1).label, visible.slice(3).trim());
  });
});

let v121Checker;
function oldTicketChecker() {
  if (!v121Checker) {
    const oldSkill=path.join(tmp,'签发用 v1.21 原包');
    unpack(process.env.AGENT_COACH_TEST_V121_ZIP,oldSkill);
    v121Checker=path.join(oldSkill,'工具/coach-check.mjs');
  }
  return v121Checker;
}
function signWithV121(t,dir,draft,expected) {
  const rel=ticketPath('02'), stamp=fingerprint('02');
  put(dir,rel,draft);
  assert.equal(fs.existsSync(path.join(dir,stamp)),false);
  if (process.env.AGENT_COACH_TEST_V121_ZIP) {
    report(dir,'ticket','02','通过',oldTicketChecker());
    t.diagnostic('旧指纹由 v1.21 原包 ticket 签发');
  } else {
    put(dir,stamp,expected);
    t.diagnostic('用已归档的 v1.21 格式指纹检验当前读者');
  }
  assert.equal(read(dir, stamp), expected);
  assert.match(expected, /^[a-f0-9]{64}\n$/);
}

test('I4 11 · 原包 A/B 两种方向和无歧义旧票保留既有指纹', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const literal = confirmedTicket(oldA);
  assert.equal(Buffer.byteLength(literal), 549);
  assert.equal(sha(literal), 'a3d2b2a48c9df9c723830a8daa4d123403b28270b440a40b5cab24925c03cbb5');
  const h3 = oldA.replace('## 附注', '### 附注');
  const h2 = oldA.replace('~~~markdown\n## 附注\n~~~', '## 附注\n随附说明。');
  const setext = oldA.replace('~~~markdown\n## 附注\n~~~', '\n附注甲\n附注乙\n----\n随附说明。');
  ticketMatrix(t, [
    ...oldExamples.map(([name, draft, old]) => [name, draft, old + '\n']),
    ['栏内 H3 对照', h3, sheetDigest(beforeConfirmation(h3))],
    ['栏外普通 H2 对照', h2, sheetDigest(beforeConfirmation(h2).split('## 附注')[0])],
    ['B 完整多行 Setext 终点', setext, sheetDigest(beforeConfirmation(setext))],
  ], (draft, old, name) => {
    const dir = oldProject('旧签-' + name);
    signWithV121(t, dir, draft, old);
    const signed = confirmedTicket(draft);
    put(dir, rel, signed);
    bothTicketReports(dir, n, ['通过', '通过']);
    assert.match(scanTicket(dir, '旧签扫描-' + name), ranLine);
    assert.equal(read(dir, rel), signed);
    assert.equal(read(dir, stamp), old);
    assert.equal(Buffer.byteLength(read(dir, stamp)), 65);
  });
});

test('I4 12 · A/B 已覆盖合同每组八种更动均拒签并保留字节', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const changes = [
    ['来源全文', s => s.replace('金额 60 和 75', '金额 61 和 74')],
    ['预期和产物同步', s => s.replace(oldMain, oldMain.replace('135', '136'))],
    ['路径', s => s.replace(oldMain, '- work\\02-替代.txt 含 净额：135')],
    ['操作符', s => s.replace(oldMain, oldMain.replace(' 含 ', ' 不含 '))],
    ['增项', s => s.replace(oldMain, oldMain + '\n- 有 work\\02-汇总.txt')],
    ['删项', s => s.replace(oldBad + '\n', '')],
    ['重复一次', s => s.replace(oldMain, oldMain + '\n' + oldMain)],
    ['顺序', s => s.replace(oldMain + '\n' + oldBad, oldBad + '\n' + oldMain)],
  ];
  const cases = [];
  for (const [name, draft, old] of oldExamples) {
    const dir = oldProject('旧签更动-' + name);
    signWithV121(t, dir, draft, old + '\n');
    put(dir, 'work/02-替代.txt', '净额：135\n');
    for (const [change, edit] of changes) cases.push([name + ' ' + change, [dir, draft, edit, old + '\n', change]]);
  }
  ticketMatrix(t, cases, ([dir, draft, edit, old, change]) => {
    put(dir, 'work/02-汇总.txt', change === '预期和产物同步' ? '净额：136\n' : change === '操作符' ? '净额：12\n' : '净额：135\n');
    const edited = edit(confirmedTicket(draft));
    put(dir, rel, edited);
    bothTicketReports(dir, n, ['不通过', '不通过'], [/改验收单须升/, /在确认\/预检后被改过/]);
    assert.equal(read(dir, rel), edited);
    assert.equal(read(dir, stamp), old);
  });

});

test('I4 12 · 旧签双轨组、坏输入与未签尾段的事实边界', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const dir = oldProject('旧签双轨组与坏输入');
  const draft = oldA.replace(oldMain, '#### 固定基线断言（绑定参数：W44）\n' + oldMain + '\n#### 当期守恒断言（每次必核）');
  const old = sheetDigest(beforeConfirmation(draft).split('\n## 附注\n')[0]);
  signWithV121(t, dir, draft, old);
  const signed = confirmedTicket(draft);
  put(dir, rel, signed);
  bothTicketReports(dir, n, ['通过', '通过']);
  ticketMatrix(t, [
    ['绑定参数', signed.replace('绑定参数：W44', '绑定参数：W45')],
    ['组归属', signed.replace(oldMain + '\n#### 当期守恒断言（每次必核）\n' + oldBad, oldBad + '\n#### 当期守恒断言（每次必核）\n' + oldMain)],
    ['坏输入期望', signed.replace('含 已拦截', '不含 已拦截')],
    ['来源丢失', signed.replace(/^- 预期值来源.*\n/m, '')],
    ['第二条来源', signed.replace('### AI 自检', '- 预期值来源：SOP硬阈值：135\n### AI 自检')],
    ['删闭栏使合同外露', signed.replace('~~~markdown', '说明文字')],
    ['未签尾段新增第二个真实自检', signed.replace('~~~\n\n## 确认记录', '~~~\n### AI 自检\n' + oldMain + '\n\n## 确认记录')],
  ], edited => {
    put(dir, rel, edited);
    bothTicketReports(dir, n, ['不通过', '不通过']);
    assert.equal(read(dir, stamp), old);
  });
  const noteOnly = signed.replace('~~~\n\n## 确认记录', '~~~\n' + oldMain + '\n- 预期值来源：阅读提示中的例子\n\n## 确认记录');
  put(dir, rel, noteOnly);
  bothTicketReports(dir, n, ['通过', '通过']);
  assert.equal(read(dir, stamp), old);
});

test('I4 13 · 开放旧签无法证明历史，v2.0.0+ 与异常索引零回退', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const part = '\n\n        ### 代码示例\n        ## 附注\n\n';
  const open = extra => oldA.replace(/\n### 阅读提示[\s\S]*?(?=## 确认记录)/, part + extra);
  const openHead = beforeConfirmation(open('')).split('\n        ## 附注')[0];
  const oldOpen = sheetDigest(openHead);
  const extras = [[], [oldMain], [oldBad], [oldMain, oldMain], [oldBad, oldBad], [oldMain, oldBad], [oldBad, oldMain]];
  const variants = extras.map(lines => open(lines.length ? lines.join('\n') + '\n\n' : ''));
  assert.equal(new Set(variants.map(draft => sheetDigest(beforeConfirmation(draft)))).size, 7);
  ticketMatrix(t, variants.map((draft, i) => ['七份原签稿 ' + i, draft, i]), (draft, i, name) => {
    const dir = oldProject('开放窗口-' + name);
    signWithV121(t, dir, draft, oldOpen);
    for (const [j, text] of [draft, variants[(i + 1) % variants.length], variants[0]].entries()) {
      put(dir, rel, confirmedTicket(text));
      bothTicketReports(dir, n, ['不通过', '不通过'], [
        /第 1 版已确认且旧预检指纹覆盖不足，续用或修改须升为第 2 版/,
        /历史旧预检指纹覆盖不足，无法证明后续内容未改，请升为第 2 版重新请学员确认/,
      ]);
      assert.equal(read(dir, stamp), oldOpen, '开放窗口 ' + j);
    }
  });
});

test('I4 13 · 新项目零旧式回退，早期缺创建版本仍可核旧签', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const [name, draft, old, canonical] = oldExamples[0];
  ticketMatrix(t, [
    ['新项目', 'v2.0.0', upgrade], ['未来版', 'v2.1.0', upgrade],
    ['升级损坏', 'v1.21', '最近体检升级：v2.0.0｜2026-02-31'],
    ['未标创建版本可核旧签', '', upgrade],
  ], (v, marker, testName) => {
    const dir = oldProject('零回退-' + testName, v, marker);
    const text = confirmedTicket(draft);
    put(dir, rel, text);
    put(dir, stamp, old + '\n');
    assert.notEqual(old, canonical, name);
    const want = testName === '未标创建版本可核旧签' ? '通过' : '不通过';
    bothTicketReports(dir, n, [want, want], testName === '升级损坏' ? [/最近体检升级/, /最近体检升级/] : []);
    assert.equal(read(dir, stamp), old + '\n');
    if (v === 'v2.0.0') {
      put(dir, stamp, canonical + '\n');
      bothTicketReports(dir, n, ['通过', '通过']);
      put(dir, rel, text.replace('~~~\n\n## 确认记录', '~~~\n本版确认后改的尾段说明。\n\n## 确认记录'));
      bothTicketReports(dir, n, ['不通过', '不通过'], [/已确认/, /在确认\/预检后被改过/]);
      assert.equal(read(dir, stamp), canonical + '\n');
    }
  });
});

test('I4 14 · 新签/升版规范全文，失败及旧确认锁定均不改写', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  ticketMatrix(t, oldExamples.map(([name, draft, old, canonical]) => [name, draft, canonical + '\n']), (draft, expected, name) => {
    const dir = oldProject('新签-' + name, 'v2.0.0');
    put(dir, rel, draft);
    report(dir, 'ticket', n, '通过');
    assert.equal(read(dir, stamp), expected);
    const text = confirmedTicket(draft);
    put(dir, rel, '\uFEFF' + text.replaceAll('\n', ' \t\r\n') + '\r\n\r\n');
    bothTicketReports(dir, n, ['通过', '通过']);
    assert.equal(read(dir, stamp), expected);
    for (const malformed of [expected.toUpperCase(), expected.trimEnd(), expected.replace('\n','\r\n'), expected + '\n']) {
      put(dir, stamp, malformed);
      put(dir, rel, text);
      bothTicketReports(dir, n, ['不通过', '不通过']);
      assert.equal(read(dir, stamp), malformed);
    }
    put(dir, stamp, expected);
    let next = draft.replace('## 验收单（第 1 版）', '## 验收单（第 2 版）');
    const invalid = next.replace('### AI 自检', '### 自检示例');
    put(dir, rel, invalid);
    report(dir, 'ticket', n, '不通过');
    assert.equal(fs.existsSync(path.join(dir, fingerprint(n, 2))), false);
    put(dir, rel, next);
    report(dir, 'ticket', n, '通过');
    const nextHash = read(dir, fingerprint(n, 2));
    assert.equal(nextHash, sheetDigest(name.startsWith('A') ? beforeConfirmation(next) : beforeConfirmation(next).split(/\n##(?:\t.*)?\n/)[0]));
    next = next.replace('## 确认记录\n', '## 确认记录\n- 第 K 次确认（第 V 版）：<日期>｜<学员原话>\n').replace('金额 60 和 75', '金额 61 和 74');
    put(dir, rel, next);
    report(dir, 'ticket', n, '通过');
    assert.notEqual(read(dir, fingerprint(n, 2)), nextHash);
    assert.equal(read(dir, stamp), expected);
    const updated = read(dir, fingerprint(n, 2));
    put(dir, rel, next.replace('### AI 自检', '### 自检示例'));
    report(dir, 'ticket', n, '不通过');
    assert.equal(read(dir, fingerprint(n, 2)), updated);
  });

});

test('I4 14 · 旧签法曾确认的票只锁旧指纹，遮罩内行不能授权', windows, t => {
  const n = '02', rel = ticketPath(n), stamp = fingerprint(n);
  const [, draft, old] = oldExamples[0];
  ticketMatrix(t, [['块注释', ['<!--', '-->']], ['已闭围栏', ['~~~text', '~~~']]], ([begin, end], _, name) => {
    const dir = oldProject('旧确认锁定-' + name);
    signWithV121(t, dir, draft, old + '\n');
    const hidden = draft.replace('## 确认记录\n', ['## 确认记录', begin, realConfirmation, end, ''].join('\n'));
    put(dir, rel, hidden);
    if (v121Checker) report(dir, 'ticket', n, '通过', v121Checker);
    assert.equal(read(dir, stamp), old + '\n');
    put(dir, rel, hidden.replace(oldMain, oldMain.replace('135', '136')));
    bothTicketReports(dir, n, ['不通过', '不通过'], [/已确认/, /没有有效的本票确认记录/]);
    assert.match(scanTicket(dir, '旧确认无真人许可-' + name), /✗ 内容③：.*真人门/);
    assert.equal(read(dir, stamp), old + '\n');
  });
});

test('I4 15 · 真实三格、最新版和快跑前序共享结构，非票据旧边界保留', windows, () => {
  const dir = project('前序共享块');
  const n = '02', rel = ticketPath(n);
  put(dir, idx, read(dir, idx) + '## 已确认\n批次补记\n----\n- 快跑批次：2026-11-19｜01@1、02@1｜按快跑档推进\n## 待确认\n');
  products(dir, n);
  ticket(dir, '01', { quote: '按快跑档推进' });
  put(dir, ticketPath('01'), read(dir, ticketPath('01'))
    .replace('## 确认记录\n', '## 确认记录\n<!--\n## 附注\n- 第 4 次确认（第 2 版）：2026-11-19｜仅定稿\n-->\n')
    .replace('## 结果\n', '## 结果\n<!--\n## 验收单（第 2 版）\n## 结果\n-->\n'));
  ticket(dir, n, { quote: '按快跑档推进' });
  const text = read(dir, rel).replace('## 这一步', '~~~text\n## 这一步（照运行表第 9 行）\n从哪拿：伪输入\n~~~\n## 这一步')
    .replace('做什么：汇总', '做什么：汇总\n怎么做：写程序（scripts\\02_样例.js）')
    .replace('## 验收单', '<!--\n## 结果\n-->\n## 验收单');
  put(dir, rel, text);
  bothTicketReports(dir, n, ['通过', '通过']);
  const scan = scanTicket(dir, '三格从真实标题定位');
  assert.doesNotMatch(scan, /票 02.*伪输入|票 02.*缺必要值|票 02.*没有"## 这一步"/);
  assert.match(scan, ranLine);

  const noStep = text.replace('## 这一步（照运行表第 2 行）', '## 其他步骤');
  put(dir, rel, noStep);
  bothTicketReports(dir, n, ['不通过', '不通过'], [/缺少对应运行表步号/, /缺少对应运行表步号/]);
  const duplicate = text.replace('## 确认记录', '### AI 自检\n- 有 work\\02-结果.txt\n## 确认记录');
  put(dir, rel, duplicate);
  bothTicketReports(dir, n, ['不通过', '不通过'], [/需要一节/, /需要一节/]);
  put(dir, rel, text.replace('## 确认记录', '## 验收单（第 V 版）\n## 确认记录'));
  bothTicketReports(dir, n, ['不通过', '不通过'], [/缺少有效的最新版/, /缺少有效的最新版/]);

});

test('I4 15 · 历史任务单无空格标题和 Setext 不改变原边界', windows, () => {
  const dir = project('非票据原边界');
  const intake = read(dir, 'docs/INTAKE.md').replace('## ⑥', '##⑥').replace('因为：', '\n附注\n----\n因为：');
  put(dir, 'docs/INTAKE.md', intake + '\n## ⑨ 待确认\n- 样本甲\n\n附注\n----\n- 样本乙\n');
  assert.match(report(dir, 'files', '4'), /✓ ⑥ 信号"固定"/);
  assert.match(scanTicket(dir, '非票据旧段'), /任务单⑨待确认 2 条（docs\\INTAKE\.md 第 \d+ 行起）/);
  assert.match(report(dir, 'flow'), /运行表/);
});


test('I4 14 · 预检报告写入失败时保护上一次完好的指纹', windows, () => {
  const dir = project('预检报告写入失败', 'v2.0.0'), n = '01';
  ticket(dir, n, { quote: '' });
  report(dir, 'ticket', n, '通过');
  const stamp = fingerprint(n), previous = read(dir, stamp);
  const outputReport = path.join(dir, 'docs/check/ticket.txt');
  fs.unlinkSync(outputReport);
  fs.mkdirSync(outputReport);
  ticket(dir, n, { quote: '', source: '样例清点确认：重新核定的两条' });
  const failed = spawnSync(process.execPath, [checker, 'ticket', dir, n], { encoding: 'utf8' });
  assert.equal(failed.status, 1, failed.stdout + failed.stderr);
  assert.match(failed.stderr, /没跑成/);
  assert.equal(read(dir, stamp), previous);
  fs.rmdirSync(outputReport);
  report(dir, 'ticket', n, '通过');
  assert.notEqual(read(dir, stamp), previous);
});

const liveHtml = 'docs/run-flow.html', liveTable = 'docs/run-flow.md', liveSource = 'docs/check/run-flow.workflow.json';
const liveOriginal = 'materials\\练习日报.csv', liveRule = 'docs\\rules\\日报口径.md';
const liveGood = week => 'inputs\\01-日报\\价格' + week + '.csv';
const liveBad = n => 'work\\' + n + '-坏输入\\缺列.csv';
const liveStop = n => 'work\\' + n + '-坏输入\\结果.txt';
const island = /<script type="application\/json" id="coach-live-map-meta">([^\r\n]+)<\/script>/;
const receiptTag = '本批核验 ';
const liveReceipt = text => text.split('\n').find(line => line.startsWith(receiptTag));
const fileState = (dir, name = liveHtml) => {
  const f = path.join(dir, name);
  return [fs.readFileSync(f), fs.statSync(f, { bigint: true }).mtimeNs];
};
function liveRead(dir) {
  const text = read(dir, liveHtml);
  const meta = island.exec(text);
  assert.ok(meta, '应有固定的活地图数据岛');
  return JSON.parse(meta[1]);
}
function liveFlow(dir, arg) {
  return report(dir, 'flow', arg, '通过');
}
function liveScan(dir, name) {
  const target = path.join(tmp, '活图-体检-' + name);
  const initial = hashes(dir);
  const result = report(target, 'scan', dir);
  assert.deepEqual(hashes(dir), initial);
  assert.deepEqual(files(target), ['docs\\check\\scan-map.html','docs\\check\\scan.txt','docs\\check\\snapshot.json']);
  return result;
}
function liveProject(name, { week = '', wide = false, title = '价格日报小练习' } = {}) {
  const dir = path.join(tmp, '活图-' + name);
  report(dir, 'init', undefined, '通过');
  put(dir, liveOriginal, '价格\n16200\n17000\n16900\n17200\n—\n');
  report(dir, 'files', '1', '通过');
  const names = ['认出输入', '算有效价', '核对口径', '整理表格', '查异常值', '交出周报', '签收周报'];
  const file = ['work\\01-认出的四条有效价格及来源说明.txt', 'output\\02-有效报价平均值与计算过程逐项核对说明.txt', 'work\\03-口径核对记录.txt',
    'work\\04-整理表格.csv', 'work\\05-异常值复核.txt', 'output\\06-价格周报与原始记录核对.txt'];
  const who = ['AI照规矩', 'AI照规矩', '你', 'AI照规矩', 'AI看情况', 'AI照规矩', '你'];
  const W = wide ? 7 : 3;
  const rows = names.slice(0, W).map((label, i) => [String(i + 1), who[i], i ? file[i - 1] : '输入 1',
    label + '：' + (i < 2 ? '按练习日报操作。依据：' + liveRule : '按已确认的交付要求操作。依据：任务单例 1'),
    i === W - 1 ? '—' : file[i], who[i] === '你' ? '核对这次交付｜对照练习日报｜不符退回第 ' + (i === 2 ? 2 : 5) + ' 步' : '—']);
  put(dir, liveTable, ['# 运行表：' + title, '本轮图：出图', '流程就这样：2026-11-23', '## 输入清单',
    '| 输入 N | 放哪 | 文件名规则 | 必须有的栏目（含单位；缺栏目怎么办） | 一次几份 | 样例文件 | 反例文件 |',
    '|---|---|---|---|---|---|---|',
    '| 输入 1 | inputs\\01-日报\\ | ' + (week ? '价格<报告周>.csv；本次 ' + week : '价格.csv') + ' | 价格（元/吨），缺列就停 | 一份 | ' + liveGood(week) + ' | — |',
    '## 运行表', '| 第几步 | 谁做 | 从哪拿 | 做什么 | 放到哪 | 你要判断什么 |',
    '|---|---|---|---|---|---|', ...rows.map(row => '| ' + row.join(' | ') + ' | '), ''].join('\n'));
  const intake = '## ⑥ 架构推荐\n信号：固定\n架构：固定流程（Workflow／编排组织类，单 Agent）\n因为：步骤固定\n第一版：先做小样\n';
  put(dir, 'docs/INTAKE.md', intake);
  put(dir, liveRule, '有效价只认数字，坏表缺价格列就停。四份价格求平均。\n');
  put(dir, liveGood(week), read(dir, liveOriginal));
  put(dir, idx, ['当前站：4 一步一票', '搭建教练版本：v2.0.0', '## 文件地图',
    '| 文件 | 放什么 | 谁用 |', '|---|---|---|', '| ' + liveRule + ' | 日报缺列与均价规则 | 第 1、2 步 |', '## 已确认', ''].join('\n'));
  put(dir, 'AGENTS.md', '# 项目规矩\n先读 docs\\run-flow.md 与 docs\\rules\\日报口径.md。\n共 ' + W + ' 步。\n');
  put(dir, 'README.md', '# 价格日报练习\n先打开 docs\\run-flow.md 查看接下来到哪一步。\n');
  return { dir, rows, week };
}
function liveTicket({ dir, rows, week }, n, { confirm = '就这样跑', sameSource = false, periodic = false,
  value = n === '01' ? '有效行：4' : '平均价：16,825' } = {}) {
  const row = rows[Number(n) - 1], target = row[4];
  const script = 'scripts\\' + n + '_日报.js', badSample = liveBad(n), stopped = liveStop(n), goodSample = liveGood(week);
  const badWhy = '已拦截：缺价格列';
  const source = sameSource ? 'AI同源试算（未做独立口径核验）：只按这份日报先算' : '边界小样核定：手对四个有价日，第五天缺价';
  const tests = ['- ' + target + ' 含 ' + value, '- ' + stopped + ' 含 ' + badWhy];
  if (periodic) tests.unshift('#### 固定基线断言（绑定参数：W44）', '- ' + target + ' 含 固定结果',
    '#### 当期守恒断言（每次必核）', '- ' + target + ' 含 拆开加回对得上');
  const lines = ['# 票 ' + n + '：' + row[3].split('：')[0], '## 这一步（照运行表第 ' + row[0] + ' 行）',
    '从哪拿：' + row[2], '做什么：' + row[3], '怎么做：写程序（' + script + '）', '放到哪：' + target, '## 验收单（第 1 版）',
    '- 用哪份样例：' + goodSample, '- 应得结果：' + value, '- 预期值来源：' + source,
    '- 应判错的例子：' + badSample + '｜' + badWhy,
    '### AI 自检', ...tests, '', '## 确认记录', '', '## 结果', ''];
  put(dir, ticketPath(n), lines.join('\n'));
  report(dir, 'ticket', n, '通过');
  if (confirm) put(dir, ticketPath(n), lines.join('\n').replace('## 确认记录\n',
    '## 确认记录\n- 第 1 次确认（第 1 版）：2026-11-23｜' + confirm + '\n'));
  return { n, target, value, script, goodSample, badSample, stopped, badWhy };
}
function liveRun({ dir, week }, take, { wrong = false, onlyFixed = false } = {}) {
  const { n, target, value, script, goodSample, badSample, stopped, badWhy } = take;
  put(dir, badSample, '单位\n元\n');
  const source = [
    "const { readFileSync, writeFileSync } = require('node:fs');",
    'const [input, output, mode] = process.argv.slice(2);',
    "const [header, ...prices] = readFileSync(input, 'utf8').trimEnd().split(/\\r?\\n/);",
    'if (header !== "价格") { writeFileSync(output, ' + JSON.stringify(wrong ? '误放行' : badWhy) + '); process.exitCode = 2; }',
    'else { const days = prices.map(Number).filter(Number.isFinite);',
    '  const line = mode === "01" ? "有效行：" + days.length : "平均价：" + (days.reduce((a,b) => a+b, 0) / days.length).toLocaleString("en-US");',
    '  writeFileSync(output, ' + JSON.stringify((week ? '参数｜报告周：' + week + '\n' : '') + '固定结果\n拆开加回对得上\n') + ' + line + "\\n"); }',
  ].join('\n');
  put(dir, script, source);
  fs.mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
  execFileSync(process.execPath, [script, goodSample, target, n], { cwd: dir });
  const invalid = spawnSync(process.execPath, [script, badSample, stopped, n], { cwd: dir });
  assert.equal(invalid.status, 2, invalid.stderr?.toString());
  put(dir, ticketPath(n), read(dir, ticketPath(n)) + '### 第 1 轮｜按第 1 次确认（第 1 版）\n' +
    (week ? '固定基线：' + (onlyFixed ? '实跑通过' : '本轮代码未变未跑') + '\n' : '') +
    (onlyFixed ? '' : '实跑取样 ' + JSON.stringify([goodSample, target, value, badSample, stopped, badWhy]) + '\n'));
}
function liveAccept(dir, n, keep = true) {
  const body = report(dir, 'accept', n, '通过');
  const receipt = liveReceipt(body);
  assert.ok(receipt, '本批同票同轮且有好坏实物时应在验收正文追加核验行\n' + body);
  if (keep) put(dir, ticketPath(n), read(dir, ticketPath(n)) + body.split('\n', 1)[0] + '\n' + receipt + '\n');
  return JSON.parse(receipt.slice(receiptTag.length));
}

test('13.58 HTML 块四个边界与四个大小写、闭合对照', windows, t => {
  const { mdTicket } = packagedMarkdownParser();
  const examples = [
    ['BOM', '<div\uFEFF札>\n甲\n----\n', [['heading',0,3]], [[2,0,3,'<div\uFEFF札>\n甲']]],
    ['NEL', '<div\u0085札>\n甲\n----\n', [['html',0,3]], []],
    ['PRE NEL', '<pre\u0085札>\n甲\n----\n', [['html',0,3]], []],
    ['长 s', '<\u017Fection\t札>\n甲\n----\n', [['html',0,3]], []],
    ['点 I', '<DİV\x1c札>\n甲\n----\n', [['html',0,3]], []],
    ['开尔文 K', '<blocKquote\t札>\n甲\n----\n', [['html',0,3]], []],
    ['开启长 s', '<ſTYLE>\n甲\n----\n', [['html',0,3]], []],
    ['闭合长 s', '<script>\n</ſCRİPT>\n甲\n----\n', [['html',0,2],['heading',2,4]], [[2,2,4,'甲']]],
  ];
  ticketMatrix(t, examples.map(([label, source, blocks, titles]) => [label, source, [blocks, titles]]), (source, expected) => {
    const doc = mdTicket(source);
    assert.deepEqual([doc.blocks.map(b => [b.kind,b.start,b.after]), doc.top.map(h => [h.level,h.start,h.after,h.label])], expected);
  });
});

test('13.58 实票签发后只改 Setext 附录仍可验收，改正文须升版', windows, () => {
  const dir = oldProject('HTML块附录', 'v2.0.0', ''), rel = ticketPath('02'), stamp = fingerprint('02');
  const draft = oldA.replace('核对金额', '核对归档').replace('### 阅读提示\n格式见下例。\n~~~markdown\n## 附注\n~~~\n',
    '\n<div\uFEFF札>\n附件版本甲\n----\n');
  const signed = confirmedTicket(draft), edited = signed.replace('附件版本甲', '附件版本乙');
  assert.equal(Buffer.byteLength(signed), 521);
  put(dir, rel, draft);
  report(dir, 'ticket', '02', '通过');
  const bytes = read(dir, stamp);
  put(dir, rel, signed);
  bothTicketReports(dir, '02', ['通过', '通过']);
  put(dir, rel, edited);
  bothTicketReports(dir, '02', ['通过', '通过']);
  assert.equal(bytes, '3447ed3c9c816174d2dd1b0319aa1cb7c9ed65420d7400b1efbb1ee5962a53c6\n');
  put(dir, rel, edited.replace('净额：135', '净额：136'));
  put(dir, 'work/02-汇总.txt', '净额：136\n');
  bothTicketReports(dir, '02', ['不通过', '不通过'], [/已确认/, /在确认\/预检后被改过/]);
  assert.equal(read(dir, stamp), bytes);
});

test('13.58 解包后直接出图，站 3、4、5 清单过关，其他入口保持图字节和时间', windows, () => {
  const p = liveProject('完整五站', { wide: true }), { dir } = p;
  liveFlow(dir);
  assert.ok(fs.existsSync(path.join(dir, liveHtml)), '原包只有图源与文字流程，应直接生成 run-flow.html');
  const original = fileState(dir);
  const meta = liveRead(dir);
  assert.deepEqual(Object.keys(meta), ['format','version','flow','steps']);
  assert.equal(meta.flow[2].length, 7);
  assert.deepEqual(meta.steps.slice(0,3).map(s => s[2]), ['pending','pending','waiting']);
  assert.match(liveScan(dir, '五站'), /项目活地图与现有文件一致/);
  liveFlow(dir);
  liveFlow(dir, '--refresh');
  assert.deepEqual(fileState(dir), original);
  report(dir, 'files', '3', '通过');
  const take = liveTicket(p, '01');
  liveRun(p, take);
  liveAccept(dir, '01');
  report(dir, 'files', '4', '通过');
  put(dir, idx, read(dir, idx).replace('4 一步一票', '5 收尾交接'));
  report(dir, 'files', '5', '通过');
  liveScan(dir, '只读命令');
  execFileSync(process.execPath, [checker, 'quote', dir], { input: '请核对交付文件。' });
  assert.deepEqual(fileState(dir), original);
  const invalid = spawnSync(process.execPath, [checker, 'flow', dir, '--refresh', '多余'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
  assert.deepEqual(fileState(dir), original);
  liveFlow(dir, '--refresh');
  assert.equal(liveRead(dir).steps[0][2], 'verified');
});

test('13.58 改角色、读写边、人工退回、票况须显式刷新自洽旧图', windows, t => {
  const p = liveProject('快照'), { dir } = p;
  liveFlow(dir);
  let tableText = read(dir, liveTable);
  const changes = [
    ['角色', text => text.replace('2 | AI照规矩', '2 | AI看情况'), /第 2 步.*你判断|第 2 步.*AI 判断/],
    ['读写边', text => text.replaceAll('02-有效报价', '02-本周报价'), /第 2 步/],
    ['退回', text => text.replace('不符退回第 2 步', '不符退回第 1 步'), /第 3 步/],
    ['票况', text => { liveTicket(p, '01', { confirm: '票 01 验收单确认' }); return text; }, /票 01/],
  ];
  for (const [label, rewrite, changed] of changes) {
    const old = fileState(dir);
    tableText = rewrite(tableText);
    put(dir, liveTable, tableText);
    const flow = report(dir, 'flow', undefined, '不通过');
    assert.match(flow, /地图已过期/);
    assert.match(liveScan(dir, '过期-' + label), changed);
    assert.deepEqual(fileState(dir), old);
    liveFlow(dir, '--refresh');
    assert.notDeepEqual(fileState(dir)[0], old[0]);
    assert.match(liveScan(dir, '已刷-' + label), /项目活地图与现有文件一致/);
    t.diagnostic(label + '：' + flow.split('\n').find(l => l.includes('地图已过期')));
  }
  const beforeDate = fileState(dir);
  put(dir, liveTable, tableText.replace('流程就这样：2026-11-23', '流程就这样：2026-11-24'));
  liveFlow(dir);
  assert.deepEqual(fileState(dir), beforeDate);
});

test('13.58 HTML 篡改和坏图不能用刷新掩盖，坏 JSON 与后续体检同存', windows, t => {
  const { dir } = liveProject('图损坏');
  liveFlow(dir);
  const html = read(dir, liveHtml);
  for (let i = 0; i < 11; i++) put(dir, '00-外来' + i + '.html', '<p>外来页面</p>');
  const variants = [
    ['SVG', html.replace('<svg ', '<svg aria-hidden="true" ')],
    ['CSS', html.replace('<style>', '<style>svg{display:none}')],
    ['脚本', html.replace('</body>', '<script>/* changed */</script></body>')],
    ['数据岛', html.replace('"version":1', '"version":2')],
    ['数据变更未同步', html.replace(island, (tag, meta) => tag.replace(meta, meta.replace('价格日报小练习', '旧名字')))],
    ['重复岛', html + island.exec(html)[0]],
    ['破损岛', html.replace('id="coach-live-map-meta"', 'data-id="coach-live-map-meta"')],
    ['混合', html + '<g id="node-a1" data-node-id="a1"></g>'],
    ['占位', '<!doctype html><p>只是普通网页</p>'],
    ['非 UTF-8', Buffer.from([0xff, 0x80])],
    ['超限', Buffer.alloc(8 * 1024 * 1024 + 1, 97)],
  ];
  ticketMatrix(t, variants.map(([label, value]) => [label, value]), (value, _, label) => {
    assert.notDeepEqual(value, html);
    put(dir, liveHtml, value);
    const before = fileState(dir);
    for (const flag of [undefined, '--refresh']) assert.match(report(dir, 'flow', flag, '不通过'), /run-flow\.html 图源异常/);
    assert.match(liveScan(dir, '坏图-' + label), /run-flow\.html 图源异常/);
    assert.deepEqual(fileState(dir), before);
  });
  fs.unlinkSync(path.join(dir, liveHtml)); fs.mkdirSync(path.join(dir, liveHtml));
  assert.match(report(dir, 'flow', '--refresh', '不通过'), /run-flow\.html 图源异常/);
  put(dir, liveSource, '{坏内容');
  const scan = liveScan(dir, '坏源加坏图');
  assert.match(scan, /run-flow\.html 图源异常/);
  assert.match(scan, /不是合法的 JSON/);
  assert.match(scan, /## 架构[\s\S]*## 卡站与升级线索/);
  put(dir, liveTable, '坏表\n');
  assert.match(report(dir, 'flow', undefined, '不通过'), /run-flow\.html 图源异常[\s\S]*运行表/);
});

test('13.58 文字选择免图，旧图留原样，现行决定优先，冲突和坏图仍逐项报', windows, () => {
  const { dir } = liveProject('文字图');
  const table = read(dir, liveTable);
  put(dir, liveTable, table.replace('本轮图：出图', '本轮图: 不画图'));
  liveFlow(dir, '--refresh');
  assert.equal(fs.existsSync(path.join(dir, liveHtml)), false);
  assert.match(read(dir, 'docs/check/run-flow.txt'), /这次不画图/);
  const textScan = liveScan(dir, '文字无图');
  assert.match(textScan, /· 本范围没有可查看的流程图.*不画图.*不要求可查看图/);
  assert.doesNotMatch(textScan, /✗ .*没有可查看的流程图/);
  put(dir, liveTable, table.replace('本轮图：出图', '不画图（历史选择）\n本轮图：出图'));
  liveFlow(dir);
  const prior = fileState(dir);
  put(dir, liveTable, table.replace('本轮图：出图', '不画图（历史选择）').replace('算有效价', '重算有效价'));
  assert.match(liveFlow(dir, '--refresh'), /当旧图，不比/);
  assert.match(liveScan(dir, '文字含图'), /当旧图，不比/);
  assert.deepEqual(fileState(dir), prior);
  put(dir, liveTable, table.replace('本轮图：出图', '本轮图：不画图\n本轮图：出图'));
  assert.match(report(dir, 'flow', '--refresh', '不通过'), /本轮图决定冲突/);
  assert.deepEqual(fileState(dir), prior);
  put(dir, liveTable, table.replace('本轮图：出图', '本轮图：不画图'));
  put(dir, liveHtml, '<p>空白替身</p>');
  assert.match(report(dir, 'flow', '--refresh', '不通过'), /run-flow\.html 图源异常/);
  assert.match(liveScan(dir, '文字坏图'), /run-flow\.html 图源异常/);
});

function archifyMarkup(source) {
  const attr = (k,v) => ' ' + k + '="' + String(v ?? '').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;') + '"';
  const tags = source.nodes.map(n => '<g' + attr('id','node-' + n.id) + attr('data-node-id',n.id) +
    attr('data-node-label',n.label) + attr('data-node-sublabel',n.sublabel) + attr('data-node-kind',n.type) +
    attr('data-node-context',source.lanes.find(l => l.id === n.lane).label + ' › ' + source.phases[n.col].label) + '></g>');
  for (const e of source.edges) tags.push('<path' + attr('data-edge-id',e.id) + attr('data-edge-from',e.from) +
    attr('data-edge-to',e.to) + attr('data-edge-label',e.label) + attr('class',e.variant === 'dashed' ? 'a-dashed' : '') + '></path>');
  for (const [id, v] of Object.entries(source.meta.legend.entries)) tags.push('<g' + attr('data-legend-kind',id) +
    attr('data-legend-label',v.label) + '></g>');
  return '<svg><text>coach-live-map-meta 只是普通文字</text>' + tags.join('\n') + '</svg>';
}

test('13.58 旧 Archify 图照原结构核对，刷新保留原页与交付旁件', windows, t => {
  const from=path.join(repo,'tests/fixtures/archify');
  const { dir } = liveProject('真实旧图');
  const sidecar = 'docs/run-flow.delivery.json';
  for (const rel of [liveHtml, liveTable, liveSource, sidecar]) {
    put(dir, rel, fs.readFileSync(path.join(from, rel.slice(5))));
  }
  const kept = [fileState(dir), fileState(dir, sidecar)];
  const originalSource = read(dir, liveSource);
  for (const flag of [undefined, '--refresh']) assert.match(liveFlow(dir, flag), /图和图源一致：\d+ 框、\d+ 线/);
  const scan = liveScan(dir, '真旧图');
  assert.match(scan, /图源与运行表一致：3 步/);
  assert.match(scan, /图和图源一致：7 框、12 线/);
  assert.deepEqual([fileState(dir), fileState(dir, sidecar)], kept);
  const html = kept[0][0].toString('utf8');
  put(dir, liveHtml, html.replace(/(<g\b[^>]*\bid="node-[^"]*"[^>]*>)/, '$1$1'));
  assert.match(report(dir, 'flow', '--refresh', '不通过'), /图和图源不一致/);
  assert.equal(read(dir, liveSource), originalSource);
  t.diagnostic('已经核对仓内独立留存的真实三步旧图结构');

  const { dir: legacy } = liveProject('三道旧图');
  liveFlow(legacy);
  const four = JSON.parse(read(legacy, liveSource)), src4 = read(legacy, liveSource);
  put(legacy, liveHtml, archifyMarkup(four));
  fs.unlinkSync(path.join(legacy, liveSource));
  assert.match(liveFlow(legacy), /图和图源一致/);
  assert.equal(read(legacy, liveSource), src4);
  const historical = JSON.parse(src4);
  historical.lanes = historical.lanes.filter(l => l.id !== 'prog');
  for (const n of historical.nodes) if (n.lane === 'prog') n.lane = 'ai';
  const encoded = JSON.stringify(historical,null,2);
  put(legacy, liveSource, encoded);
  const oldPage = archifyMarkup(historical);
  put(legacy, liveHtml, oldPage);
  put(legacy, sidecar, '旧交付旁件');
  const versionGrip = [fileState(legacy),fileState(legacy,liveSource),fileState(legacy,sidecar)];
  assert.match(liveFlow(legacy,'--refresh'), /图源与运行表一致：3 步/);
  assert.match(liveScan(legacy,'三道旧图'), /图源与运行表一致：3 步/);
  assert.deepEqual([fileState(legacy),fileState(legacy,liveSource),fileState(legacy,sidecar)], versionGrip);
  for (const [label,page] of [
    ['图例', oldPage.replace('data-legend-label="你判断"','data-legend-label="乱改"')],
    ['退回', oldPage.replace('data-edge-id="r3-back2" data-edge-from="you3" data-edge-to="a2"',
      'data-edge-id="r3-back2" data-edge-from="you3" data-edge-to="a1"')],
  ]) {
    assert.notEqual(page,oldPage,label);
    put(legacy,liveHtml,page);
    assert.match(report(legacy,'flow','--refresh','不通过'), /图和图源不一致/);
    assert.match(liveScan(legacy,'旧图错' + label), /图和图源不一致/);
    assert.equal(read(legacy,liveHtml),page);
    assert.equal(read(legacy,liveSource),encoded);
  }
  put(legacy,liveHtml,oldPage);
  const savedPage = fileState(legacy);
  fs.unlinkSync(path.join(legacy,liveSource));
  put(legacy,liveTable,read(legacy,liveTable).replace('本轮图：出图','本轮图：不画图'));
  assert.match(liveFlow(legacy,'--refresh'),/当旧图，不比/);
  assert.ok(fs.existsSync(path.join(legacy,liveSource)), '文字版缺图源时应补出文字所用的图源');
  assert.deepEqual(fileState(legacy),savedPage);
  t.diagnostic('三道、四道、缺源复建及旧图错线/图例均实跑');
});

test('13.58 仅定稿、预检、人工、跨票、跨项目、跨轮不得借绿', windows, t => {
  const p = liveProject('批次身份'), { dir } = p;
  liveFlow(dir);
  const n1 = liveTicket(p, '01'), n2 = liveTicket(p, '02', { confirm: '票 02 验收单确认' });
  liveFlow(dir, '--refresh');
  assert.deepEqual(liveRead(dir).steps.map(s => [s[2],s[9]]), [['pending',null],['locked',null],['waiting',null]]);
  liveRun(p, n1);
  const key = liveAccept(dir, '01');
  assert.deepEqual(key.slice(0, 6), [1,'01','1','1','1',[]]);
  assert.match(key[6], /^[0-9a-f]{64}$/);
  liveFlow(dir, '--refresh');
  assert.deepEqual(liveRead(dir).steps.map(s => s[2]), ['verified','locked','waiting']);
  assert.deepEqual(liveRead(dir).steps[0][9], [n1.goodSample,n1.target,n1.value,n1.badSample,n1.stopped,n1.badWhy]);
  const document = read(dir, ticketPath('01')), accept1 = read(dir, 'docs/check/accept.txt');
  liveTicket(p, '02');
  liveRun(p, n2);
  put(dir, ticketPath('02'), read(dir, ticketPath('02')) + accept1.split('\n', 1)[0] + '\n' + liveReceipt(accept1) + '\n');
  liveFlow(dir, '--refresh');
  assert.notEqual(liveRead(dir).steps[1][2], 'verified');
  // 正确第二票先留足本轮原件，第一张旧回执不会被全局报告轮转抹掉。
  put(dir, ticketPath('02'), read(dir, ticketPath('02')).split(accept1.split('\n', 1)[0])[0]);
  liveAccept(dir, '02');
  liveFlow(dir, '--refresh');
  assert.deepEqual(liveRead(dir).steps.map(s => s[2]), ['verified','verified','waiting']);
  const beforeUnused = fileState(dir);
  const unused = 'scripts\\01_未用草稿.js';
  put(dir,unused,'// 这一份草稿没有参与本次运行');
  liveFlow(dir);
  assert.deepEqual(fileState(dir),beforeUnused);
  fs.unlinkSync(path.join(dir,unused));
  const n2Report = read(dir, 'docs/check/accept.txt'), n2Receipt = JSON.parse(liveReceipt(n2Report).slice(receiptTag.length));
  const other = liveProject('不同目录');
  for (const f of [liveTable, idx, liveRule, n1.script, n1.goodSample, n1.target, n1.badSample, n1.stopped, ticketPath('01'), fingerprint('01')]) {
    put(other.dir, f, read(dir, f));
  }
  put(other.dir, ticketPath('01'), document.replaceAll(dir, other.dir));
  put(other.dir, 'docs/check/accept.txt', accept1.replaceAll(dir, other.dir));
  liveFlow(other.dir);
  assert.notEqual(liveRead(other.dir).steps[0][2], 'verified');
  const checks = [
    ['换轮', () => document.replace('第 1 轮', '第 2 轮')],
    ['换确认', () => document.replaceAll('第 1 次确认', '第 2 次确认')],
    ['换版', () => document.replaceAll('第 1 版', '第 2 版')],
    ['重复轮', () => document + '### 第 1 轮｜按第 1 次确认（第 1 版）\n' + document.split('实跑取样 ')[1].replace(/^/, '实跑取样 ')],
    ['仅定稿覆盖', () => document.replace('## 结果', '- 第 2 次确认（第 1 版）：2026-11-23｜票 01 验收单确认\n## 结果')],
    ['引用遮住证据', () => document.split('\n').map(l => l.startsWith('实跑取样 ') ? '> ' + l : l).join('\n')],
    ['围栏遮住证据', () => document.replace('实跑取样 ', '~~~text\n实跑取样 ') + '\n~~~\n'],
    ['坏样本未拦', () => { put(dir, n1.stopped, '误放行'); return document; }],
    ['缺实物', () => { fs.unlinkSync(path.join(dir, n1.target)); return document; }],
    ['同名同长改样本', () => { put(dir, n1.goodSample, read(dir,n1.goodSample).replace('16200','16201')); return document; }],
    ['脚本被换', () => { put(dir, n1.script, read(dir,n1.script) + '\n// 已改变'); return document; }],
  ];
  const saved = [n1.goodSample, n1.script, n1.target, n1.stopped].map(f => [f, read(dir, f)]);
  ticketMatrix(t, checks.map(([label, edit]) => [label, edit]), edit => {
    try {
      put(dir, ticketPath('01'), edit());
      liveFlow(dir, '--refresh');
      assert.notEqual(liveRead(dir).steps[0][2], 'verified');
    } finally { put(dir, ticketPath('01'), document); for (const [f, s] of saved) put(dir, f, s); }
  });
  put(dir, ticketPath('01'), document + '\n' + accept1.split('\n',1)[0].replace(/通过$/, '不通过') + '\n');
  liveFlow(dir, '--refresh');
  assert.equal(liveRead(dir).steps[0][2], 'blocked');
  put(dir, ticketPath('01'), document);
  put(dir, idx, read(dir, idx) + '- 2026-11-23｜第 3 步｜批次：02@1/1/1｜核对：' + n2.target + '｜你说：“我核对通过，可以交付”\n');
  liveFlow(dir, '--refresh');
  assert.deepEqual(liveRead(dir).steps[2].slice(2,4), ['verified','你已核对']);
  assert.equal(liveRead(dir).steps[2][9], null);
  assert.equal(liveRead(dir).steps[2][10][1], '我核对通过，可以交付');
  assert.equal(n2Receipt[1], '02');
});

test('13.58 周期双轨只按当期实跑亮灯，同源试算仍等人，停止不恢复执行', windows, () => {
  const p = liveProject('周次', { week: 'W45' }), { dir } = p;
  const n1 = liveTicket(p, '01', { periodic: true }), n2 = liveTicket(p, '02', { sameSource: true, periodic: true });
  liveRun(p, n1);
  assert.deepEqual(liveAccept(dir, '01').slice(0,6), [1,'01','1','1','1',[['输入 1','报告周','W45']]]);
  liveRun(p, n2, { onlyFixed: true });
  const old = report(dir, 'accept', '02', '通过');
  assert.equal(liveReceipt(old), undefined);
  liveFlow(dir);
  assert.equal(liveRead(dir).steps[0][2], 'verified');
  assert.notEqual(liveRead(dir).steps[1][2], 'verified');
  liveTicket(p, '02', { sameSource: true, periodic: true });
  liveRun(p, n2);
  liveAccept(dir, '02');
  liveFlow(dir, '--refresh');
  assert.equal(liveRead(dir).steps[1][2], 'waiting');
  assert.ok(liveRead(dir).steps[1][9]);
  const extra = liveGood('W44');
  put(dir, extra, read(dir, n1.goodSample));
  liveFlow(dir,'--refresh');
  assert.match(liveRead(dir).steps[0][3], /混入其他批次/);
  assert.notEqual(liveRead(dir).steps[0][2], 'verified');
  fs.unlinkSync(path.join(dir,extra));
  put(dir, n1.target, read(dir,n1.target).replace('W45','W44'));
  liveFlow(dir, '--refresh');
  assert.notEqual(liveRead(dir).steps[0][2], 'verified');
  put(dir, liveTable, read(dir, liveTable).replaceAll('W45','W46'));
  put(dir, liveGood('W46'), read(dir, liveGood('W45')));
  liveFlow(dir, '--refresh');
  assert.notEqual(liveRead(dir).steps[1][2], 'verified');
  put(dir, idx, read(dir, idx).replace('当前站：4 一步一票', '当前站：已结束（停止）'));
  liveFlow(dir, '--refresh');
  assert.match(read(dir, liveHtml), /项目已停止/);
});

test('13.58 同日快跑留证后换站和登记新批次仍能核回已完成票', windows, () => {
  const p = liveProject('真实快跑', { wide:true }), { dir } = p;
  put(dir,idx,read(dir,idx) + '- 快跑批次：2026-11-23｜01@1、02@1｜按快跑档推进\n');
  const n1 = liveTicket(p,'01',{confirm:'按快跑档推进'}), n2 = liveTicket(p,'02',{confirm:'按快跑档推进'});
  liveRun(p,n1);
  liveAccept(dir,'01');
  liveRun(p,n2);
  liveAccept(dir,'02');
  liveFlow(dir);
  assert.deepEqual(liveRead(dir).steps.slice(0,3).map(s => s[2]), ['verified','verified','waiting']);
  const original = fileState(dir);
  put(dir,idx,read(dir,idx).replace('当前站：4 一步一票','当前站：5 收尾交接') +
    '- 快跑批次：2026-11-24｜01@1｜按快跑档推进\n' +
    '- 2026-11-24｜第 7 步｜批次：02@1/1/1｜核对：价格周报｜你说：“我核对通过，可以交付”\n');
  liveFlow(dir);
  assert.match(liveScan(dir,'快跑留证'), /项目活地图与现有文件一致/);
  assert.deepEqual(fileState(dir), original);
});

test('13.58 项目文字原样显示为数据，危险路径与越界联接不读不写', windows, t => {
  const dangerousText = '<script>alert("预览")</script><!-- \' & \u2028 \u2029';
  const { dir } = liveProject('文字转义', { title: dangerousText });
  liveFlow(dir);
  const html = read(dir, liveHtml);
  assert.equal(liveRead(dir).flow[0], dangerousText);
  assert.doesNotMatch(island.exec(html)[1], /[<>&'\u2028\u2029]/);
  assert.match(html, /&lt;script&gt;alert\(&quot;预览&quot;\)&lt;\/script&gt;&lt;!-- &#39; &amp;/);
  assert.doesNotMatch(html, /<script>alert/);
  const original = fileState(dir), table = read(dir, liveTable);
  const badPaths = ['..\\外部.txt','inputs/01-日报\\外部.txt','C:\\外部.txt','C:外部.txt','\\\\host\\share\\外部.txt',
    'file:外部.txt','javascript:外部.txt','data:外部.txt','materials\\NUL.txt','materials\\.\\外部.txt',
    'materials\\file.\\外部.txt','materials\\file \\外部.txt','materials\\%2e%2e\\外部.txt','materials\\a.txt:ADS'];
  ticketMatrix(t, badPaths.map(f => [f,f]), f => {
    put(dir, liveTable, table.replace(liveGood(''), f));
    assert.match(report(dir, 'flow', '--refresh', '不通过'), /路径|范围/);
    assert.deepEqual(fileState(dir), original);
  });
  put(dir, liveTable, table);
  const outside = path.join(tmp, '哨兵');
  put(outside, '文字.txt', '只读哨兵');
  const before = fileState(outside, '文字.txt');
  const junction = path.join(dir, 'inputs', '02-外部');
  fs.symlinkSync(outside, junction, 'junction');
  put(dir, liveTable, table.replace(liveGood(''), 'inputs\\02-外部\\不存在.txt'));
  assert.match(report(dir, 'flow', '--refresh', '不通过'), /路径|联接/);
  assert.deepEqual(fileState(dir), original);
  fs.unlinkSync(junction);
  put(dir, liveTable, table);
  fs.unlinkSync(path.join(dir, liveGood('')));
  fs.linkSync(path.join(outside, '文字.txt'), path.join(dir, liveGood('')));
  assert.match(report(dir, 'flow', '--refresh', '不通过'), /硬链接|路径/);
  assert.deepEqual(fileState(outside, '文字.txt'), before);
  assert.deepEqual(fileState(dir), original);
});

test('13.58 地图临时写失败、原子提交失败及竞争首发保留原件和哨兵', windows, t => {
  const { dir } = liveProject('写盘失败');
  liveFlow(dir);
  const initial = fileState(dir);
  put(dir, liveTable, read(dir, liveTable).replace('算有效价','核有效价'));
  const lock = 'docs/check/run-flow.html.lock';
  put(dir,lock,'正在写图的另一进程');
  const competing = spawnSync(process.execPath,[checker,'flow',dir,'--refresh'],{encoding:'utf8'});
  assert.equal(competing.status,1,competing.stdout + competing.stderr);
  assert.match(competing.stderr,/正在更新，请重试/);
  assert.equal(read(dir,lock),'正在写图的另一进程');
  assert.deepEqual(fileState(dir),initial);
  fs.unlinkSync(path.join(dir,lock));
  const patch = path.join(tmp, '地图故障注入.mjs');
  const hooks = {
    partial: String.raw`const open = fs.openSync, write = fs.writeFileSync; let fd;
fs.openSync = (p,flag,...args) => { const n = open(p,flag,...args); if (flag === 'wx' && /run-flow\.html\.\d+\.tmp$/u.test(String(p))) fd = n; return n; };
fs.writeFileSync = (target, data, ...args) => { if (typeof target === 'number' && target === fd) { write(target,'partial'); throw Object.assign(new Error('injected partial write'),{code:'ENOSPC'}); } return write(target,data,...args); };`,
    replace: String.raw`const rename = fs.renameSync;
fs.renameSync = (p,d,...args) => { if (/[\\/]run-flow\.html$/u.test(String(d))) throw Object.assign(new Error('injected locked file'),{code:'EPERM'}); return rename(p,d,...args); };`,
    race: String.raw`const link = fs.linkSync;
fs.linkSync = (p,d,...args) => { if (/[\\/]run-flow\.html$/u.test(String(d))) fs.writeFileSync(d,'<p>竞争者保留原页</p>',{flag:'wx'}); return link(p,d,...args); };`,
  };
  for (const [mode, body] of Object.entries(hooks)) {
    if (mode === 'race') fs.unlinkSync(path.join(dir, liveHtml));
    fs.writeFileSync(patch, "import fs from 'node:fs';\n" + body, 'utf8');
    const result = spawnSync(process.execPath, ['--import',pathToFileURL(patch).href,checker,'flow',dir,'--refresh'], { encoding: 'utf8' });
    assert.equal(result.status, 1, mode + '\n' + result.stdout + result.stderr);
    assert.match(result.stderr, /地图.*(?:刷新|保留)|正在更新/);
    if (mode === 'race') assert.equal(read(dir, liveHtml), '<p>竞争者保留原页</p>');
    else assert.deepEqual(fileState(dir), initial);
    assert.ok(!fs.readdirSync(path.join(dir,'docs/check')).some(f => /^run-flow\.html\./.test(f)));
    t.diagnostic(mode + '：' + result.stderr.trim());
  }
});

const humanLine = (date, step, scope, target, quote) =>
  '- ' + (date ? date + '｜' : '') + '第 ' + step + ' 步｜批次：' + scope + '｜核对：' + target + '｜你说：“' + quote + '”\n';

test('13.58.1 人审只认本步实物或明确目标，提问和附条件须等待', windows, t => {
  const p = liveProject('人审对象'), { dir } = p;
  for (const n of ['01','02']) {
    liveRun(p, liveTicket(p, n));
    liveAccept(dir, n);
  }
  const index = read(dir, idx), target = p.rows[1][4], yes = '我核对通过，可以交付';
  const wait = ['waiting','等你点头',null];
  const approved = quote => ['verified','你已核对',quote];
  ticketMatrix(t, [
    ['同批尚无拍板', null, wait],
    ['问号', [target,'现在可以交付吗？'], wait],
    ['全半角问法', [target,'可以交付?'], wait],
    ['没有标点的疑问', [target,'是否能不能签收，可以交付'], wait],
    ['附条件的退回', [target,'先退回重做；核对通过后再交。'], wait],
    ['改完才交', [target,'退回重做，改完再确认'], wait],
    ['暂缓拒绝', [target,'待确认，暂不同意交付'], wait],
    ['转述不是决定', [target,'同事说可以交付'], wait],
    ['错核对象', ['午餐人数',yes], wait],
    ['同名前缀的文件不算本步对象', [target + '.bak',yes], wait],
    ['退回有明确决定', [target,'退回重做'], ['blocked','核对未放行','退回重做']],
    ['按规范路径明确拒绝', [target.replaceAll('\\','/'),'不同意交付'], ['blocked','核对未放行','不同意交付']],
    ['核对步骤明确目标', ['核对这次交付',yes], approved(yes)],
    ['规范相对路径同一文件', [target.replaceAll('\\','/').toUpperCase(),yes], approved(yes)],
  ], (record, expected) => {
    put(dir, idx, index + (record ? humanLine('2026-11-23', 3, '02@1/1/1', ...record) : ''));
    liveFlow(dir, '--refresh');
    const s = liveRead(dir).steps[2];
    assert.deepEqual([s[2],s[3],s[10]?.[1] ?? null], expected);
  });
});

test('13.58.1 票内与进度按明确决定的日期仲裁，冲突或日期不明须等待', windows, t => {
  const p = liveProject('人审日期'), { dir } = p;
  liveRun(p, liveTicket(p, '01'));
  liveAccept(dir, '01');
  liveRun(p, liveTicket(p, '02', { sameSource: true }));
  liveAccept(dir, '02');
  const rel = ticketPath('02'), index = read(dir, idx), ticketText = read(dir, rel);
  const yes = '我核对通过，可以交付', no = '不同意交付', target = p.rows[1][4];
  const line = (date, word, scope = '02@1/1/1') => humanLine(date, 2, scope, target, word);
  const passed = ['verified','程序已核，你已核对',yes];
  const rejected = ['blocked','核对未放行',no];
  const waiting = ['waiting','程序已核，等你点头',null];
  const earlyYes = line('2026-11-23', yes), lateNo = line('2026-11-24', no);
  ticketMatrix(t, [
    ['票内单独肯定', ['',earlyYes], passed],
    ['进度次日拒绝盖过票内前日同意', [lateNo,earlyYes], rejected],
    ['票内次日拒绝盖过进度前日同意', [earlyYes,lateNo], rejected],
    ['写在后面的旧行不能盖过新决定', [lateNo + line('2026-11-22', yes),earlyYes], rejected],
    ['同日两处冲突', [line('2026-11-23', no),earlyYes], waiting],
    ['同日同处冲突', ['',earlyYes + line('2026-11-23', no)], waiting],
    ['同日同意可以放行', [earlyYes,earlyYes], passed],
    ['同批缺日期无法排先后', [line('', no),earlyYes], waiting],
    ['同批不合法日期无法排先后', [line('2026-11-31', no),earlyYes], waiting],
    ['另一批次的拒绝不参与仲裁', [line('2026-11-24', no,'02@1/1/2'),earlyYes], passed],
    ['直接读取的实际输入可核对', ['',humanLine('2026-11-23', 2, '02@1/1/1', p.rows[1][2], yes)], passed],
  ], ([indexRecords, ticketRecords], expected) => {
    put(dir, idx, index + indexRecords);
    put(dir, rel, ticketText + ticketRecords);
    liveFlow(dir, '--refresh');
    const s = liveRead(dir).steps[1];
    assert.deepEqual([s[2],s[3],s[10]?.[1] ?? null], expected);
  });
});

test('13.58.1 本批核验按完整数值和词匹配，旧的含断言照常通过', windows, t => {
  ticketMatrix(t, [
    ['四行实跑通过', ['有效行：4','有效行：4','有效行：4'], true],
    ['真实四十行不可当四行', ['有效行：4','有效行：40','有效行：40'], false],
    ['小数不可当整数', ['有效行：4','有效行：4.5','有效行：4.5'], false],
    ['分组大数不可当四行', ['有效行：4','有效行：4,000','有效行：4,000'], false],
    ['十四不可摘取末位当四', ['4','有效行：14','有效行：14'], false],
    ['负四不可当四', ['4','有效行：-4','有效行：-4'], false],
    ['缺前导零的小数可完整核同', ['.4','实测：.4','实测：.4'], true],
    ['不能把一又十分之四截成十分之四', ['.4','实测：1.4','实测：1.4'], false],
    ['完整百分比可核同', ['4%','比例：4%','比例：4%'], true],
    ['百分比不能当相同数字的整数', ['4','比例：4%','比例：4%'], false],
    ['非正常不可当正常', ['正常','检测：非正常','检测：非正常'], false],
    ['摘值写四但实物写四十', ['有效行：4','有效行：40','有效行：4'], false],
    ['实物写四但摘值写四十', ['有效行：4','有效行：4','有效行：40'], false],
    ['合法千分位完整相等', ['16,825','均价：16,825','均价：16,825'], true],
    ['千分位后面还有小数', ['16,825','均价：16,825.4','均价：16,825.4'], false],
  ], ([expected, product, picked], shouldSign, label) => {
    const p = liveProject('完整值-' + label), { dir } = p;
    const take = liveTicket(p, '01', { value: expected });
    if (product === '有效行：40') put(dir, take.goodSample, '价格\n' + '16200\n'.repeat(40));
    liveRun(p, { ...take, value: picked });
    const raw = read(dir, take.target);
    if (product === '有效行：40') assert.match(raw, /^有效行：40$/m, '四十行取自脚本真的计数');
    else put(dir, take.target, raw.replace('有效行：4', product));
    const body = report(dir, 'accept', '01', '通过');
    liveFlow(dir);
    const s = liveRead(dir).steps[0];
    assert.deepEqual([!!liveReceipt(body),s[2] === 'verified'], [shouldSign,shouldSign], s[3] + '\n' + body);
  });
});

test('13.59 主产物同名冲突时验收和地图都拒绝，旧含断言仍实跑', windows, t => {
  const p = liveProject('参数双向冲突', { week:'W45' }), { dir } = p;
  const take = liveTicket(p, '01', { periodic: true });
  liveRun(p, take);
  const normal = read(dir, take.target);
  ticketMatrix(t, [
    ['当期正确', '参数｜报告周：W45', true],
    ['旧式当期首行正确', '报告周：W45', true],
    ['同名同值不冲突', '参数｜报告周：W45｜报告周：W45', true],
    ['旧值在前', '参数｜报告周：W44｜报告周：W45', false],
    ['旧值在后', '参数｜报告周：W45｜报告周：W44', false],
  ], (head, shouldSign) => {
    put(dir, take.target, normal.replace(/^[^\n]+/, head));
    const body = report(dir,'accept','01',shouldSign?'通过':'不通过');
    liveFlow(dir,'--refresh');
    const s=liveRead(dir).steps[0];
    assert.deepEqual([!!liveReceipt(body),s[2]],shouldSign?[true,'verified']:[false,'blocked'],body);
    if (!shouldSign) {
      assert.match(body,/主产物同名参数重复或冲突/);
      assert.match(s[3],/主产物同名参数重复或冲突/);
      assert.match(body,/✓ .*含 有效行：4/);
    }
  });
});

test('13.58.1 数据岛单字节损坏不是可刷新的合法旧快照', windows, t => {
  const { dir } = liveProject('数据岛独立核对');
  put(dir, liveTable, read(dir, liveTable).replace('缺列就停','缺列就停A'));
  liveFlow(dir);
  const original = fileState(dir), page = original[0].toString('utf8');
  const body = island.exec(page)[1];
  const tampered = page.replace(island, tag => tag.replace('缺列就停A','缺列就停B'));
  const bytes = Buffer.from(tampered);
  assert.equal(bytes.length, original[0].length);
  assert.equal(bytes.reduce((n, byte, i) => n + Number(byte !== original[0][i]), 0), 1);
  put(dir, liveTable, read(dir, liveTable).replace('缺列就停A','缺列就停B'));
  assert.match(report(dir, 'flow', undefined, '不通过'), /地图已过期/);
  assert.match(liveScan(dir, '岛-合法旧图'), /地图已过期/);
  assert.deepEqual(fileState(dir), original);
  assert.match(liveFlow(dir, '--refresh'), /刷新项目活地图/);
  const fresh = read(dir, liveHtml);
  assert.equal(island.exec(fresh)[1], island.exec(tampered)[1], '改动未投影字段得到同一份数据岛');
  const expectedTag = '<meta name="coach-map-sha" content="' + createHash('sha256').update(body).digest('hex') + '">';
  const badTag = expectedTag.replace(/(content=")[a-f0-9]/, (_, lead) => lead + (expectedTag.includes(lead + '0') ? '1' : '0'));
  ticketMatrix(t, [
    ['岛内单字节',tampered],
    ['校验标签缺失',page.replace(expectedTag,'')],
    ['校验标签有两枚',page.replace(expectedTag,expectedTag + expectedTag)],
    ['校验标签一位不同',page.replace(expectedTag,badTag)],
    ['岛外单字节',page.replace('width=device-width','width=Device-width')],
  ], (html, _, label) => {
    put(dir, liveHtml, html);
    const written = fileState(dir);
    const reports = [report(dir, 'flow'), report(dir, 'flow', '--refresh'), liveScan(dir, '岛-' + label)];
    assert.deepEqual(reports.map(s => /图源异常/.test(s)), [true,true,true], reports.join('\n'));
    assert.deepEqual(fileState(dir), written);
  });
  assert.equal(page.split(expectedTag).length - 1, 1);
  assert.ok(page.indexOf(expectedTag) < page.indexOf('</head>'));
  put(dir, liveHtml, fresh);
  assert.match(liveFlow(dir), /与现有文件一致/);
});

test('13.58.1 短流程两档首屏为 SVG 留足面积并保住所有步骤', windows, t => {
  ticketMatrix(t, [
    ['三步未建票', [false,false]],
    ['三步已核第一步', [false,true]],
    ['七步已核第一步', [true,true]],
  ], ([wide, run], _, label) => {
    const p = liveProject('首屏-' + label, { wide }), { dir } = p;
    if (run) {
      liveRun(p, liveTicket(p, '01'));
      liveAccept(dir, '01');
    }
    liveFlow(dir);
    assert.equal(liveRead(dir).steps[0][2], run ? 'verified' : 'pending');
    const html = read(dir, liveHtml);
    for (const [scene, width, height] of [['wide',728,900],['narrow',390,844]]) {
      const svg = new RegExp('<svg class="scene ' + scene + '" viewBox="0 0 (\\d+) (\\d+)"[^>]*>([\\s\\S]*?)</svg>').exec(html);
      assert.ok(svg, scene);
      const [, viewWidth, viewHeight, drawing] = svg;
      const hitBoxes = [...drawing.matchAll(/class="hit" x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"/g)];
      assert.equal(hitBoxes.length, wide ? 7 : 3);
      assert.ok(hitBoxes.every(([,x,y,w,h]) => +x + +w <= +viewWidth && +y + +h <= +viewHeight), scene);
      // CI has no browser dependency. Reserve 100px for the header and count the entire viewport in the denominator.
      // The release's separate offline Chromium check measures the actual visible rectangles and both themes.
      const area = Math.min(width * viewHeight / viewWidth, height - 100) / height;
      assert.ok(area >= .72, label + ' ' + width + '×' + height + '，保守占比 ' + (area * 100).toFixed(2) + '%');
    }
  });
});


test('13.58.2 人审时间线收齐每条本批记录，再按最新日期与同日共识决定', windows, t => {
  const p = liveProject('最新人工决定'), { dir } = p;
  for (const n of ['01','02']) {
    liveRun(p, liveTicket(p, n, { sameSource: n === '02' }));
    liveAccept(dir, n);
  }
  const file = ticketPath('02'), ticket = read(dir,file), index = read(dir,idx), target = p.rows[1][4];
  const yes = '我核对通过，可以交付', no = '票 2 不通过：均价算错了。', hold = '先退回重做；核对通过后再交。';
  const follow = '不同意交付，等我确认。';
  const line = (day, q, step = 2, obj = target) => humanLine(day && '2026-11-' + day,step,'02@1/1/1',obj,q);
  const early = line(23,yes), later = line(24,hold), last = line(25,yes);
  // 先后、位置、对象和原话独立变动；有决定时连出处一起核。
  ticketMatrix(t, [
    ['只有前日同意', ['',early], ['verified',yes,file]],
    ['单独使用产品口令', [line(24,no),''], ['blocked',no,idx]],
    ['产品口令撤回昨天的同意', [line(24,no),early], ['blocked',no,idx]],
    ['无日期的产品口令', [line('',no),early], ['waiting']],
    ['次日纯拒绝', [line(24,'不同意交付'),early], ['blocked','不同意交付',idx]],
    ['同日冲突', [line(23,no),early], ['waiting']],
    ['无日期的拒绝', [line('','不同意交付'),early], ['waiting']],
    ['无前情的条件退回', [later,''], ['waiting']],
    ['次日条件退回', [later,early], ['waiting']],
    ['次日拒绝后交代等待', [line(24,follow),early], ['blocked',follow,idx]],
    ['两处交换', [early,later], ['waiting']],
    ['次日无关对象', [line(24,no,2,'午餐人数') + line(24,no,2,target+'.bak'),early], ['verified',yes,file]],
    ['撤回后重新同意', [line(24,no),early+last], ['verified',yes,file]],
    ['纯人工步在同处撤回', [line(23,yes,3)+line(24,hold,3),'',3], ['waiting']],
    ['同日疑问也要入时间线', [line(23,'核对通过吗'),early], ['waiting']],
    ['次日未知原话', [line(24,'这批我还要看'),early], ['waiting']],
    ['次日仅问另一票', [line(24,'票 09 通过'),early], ['waiting']],
    ['日期非法且有非肯定', [line(31,hold),early], ['waiting']],
    ['日期不全而全为同意，引用有日期的决定', [line('',yes),early], ['verified',yes,file]],
    ['只有无日期的同意', [line('',yes),''], ['waiting']],
    ['最新同日全拒绝', [line(24,no),early+line(24,no)], ['blocked',no]],
    ['不同日期以最后的提问为准', [line(25,'现在可以交付？'),early+line(24,no)], ['waiting']],
  ], ([inIndex,inTicket,step = 2], [state,quote,source]) => {
    put(dir,idx,index + inIndex);
    put(dir,file,ticket + inTicket);
    liveFlow(dir,'--refresh');
    const s = liveRead(dir).steps[step-1];
    assert.equal(s[2],state);
    assert.equal(s[10]?.[1] ?? null,quote ?? null);
    if (source) assert.ok(s[10][2].replaceAll('\\','/').startsWith(source.replaceAll('\\','/') + ' 第 '),s[10][2]);
  });

});

test('13.58.2 单条人工记录只认本步对象、无条件拒绝或明确放行', windows, t => {
  const p = liveProject('单条人工判票'), { dir } = p;
  for (const n of ['01','02']) {
    liveRun(p,liveTicket(p,n));
    liveAccept(dir,n);
  }
  const index = read(dir,idx), target = p.rows[1][4], yes = '我核对通过，可以交付';
  const hold = '先退回重做；核对通过后再交。';
  const line = (q,obj) => humanLine('2026-11-24',3,'02@1/1/1',obj,q);
  ticketMatrix(t, [
    ['无记录',null,'waiting'], ['疑问',[target,'这批能否交付'],'waiting'],
    ['附条件退回',[target,hold],'waiting'], ['无关核对对象',['午餐人数',yes],'waiting'],
    ['核对实物',[target,yes],'verified'], ['核对明确目标',['核对这次交付',yes],'verified'],
    ['同一实物拒绝',[target,'退回重做'],'blocked'],
    ['第几步拒绝及原因',[target,'第 3 步不通过：价格不符。'],'blocked'],
    ['不同票的拒绝',[target,'票 4 不通过'],'waiting'],
    ['如果不通过',[target,'如果总数不对，就不通过。'],'waiting'],
    ['把假设写在拒绝后面',[target,'不通过，如果均价还没核清。'],'waiting'],
    ['拒绝后补例外条件',[target,'不同意交付，除非重新核对。'],'waiting'],
    ['明确拒绝并要求等下一次核对',[target,'不同意交付，等我确认。'],'blocked'],
    ...['不通过','没通过','未通过','不同意','拒绝放行','不能交付','不可以交付','不放行','不予放行','退回第 2 步修改'].map(word =>
      ['明确拒绝并指明原因：'+word,[target,'票 3 '+word+'：均价有误。'],'blocked']),
    ['人工步复制的通过原话',[target,'第 3 步我核对通过，可以交付。'],'verified'],
    ['已检查但没有放行',[target,'我已经核对过，对得上。'],'waiting'],
    ['核对无误后连写放行',[target,'我核对无误可以交付。'],'verified'],
    ['暂缓',[target,'待确认，暂不同意交付'],'waiting'],
  ], (record,state) => {
    put(dir,idx,index + (record ? line(record[1],record[0]) : ''));
    liveFlow(dir,'--refresh');
    assert.equal(liveRead(dir).steps[2][2],state);
  });
});

test('13.58.2 实物、摘值与约定必须匹配整个数，中文单位和分组的完整值可签', windows, t => {
  const groups = [',','，',"'",'’','_','\u00a0','\u202f','\u2009',' '];
  const cases = [
    ...groups.flatMap((mark,i) => [
      ['分组前半 '+i, ['4','4'+mark+'000','4'+mark+'000'],false],
      ['分组后半 '+i, ['000','4'+mark+'000','000'],false],
    ]),
    ...['百','千','万','萬','亿','億','兆','%','％','‰','e3','px','x','.5','．３'].map(s =>
      ['不得截短 4'+s,['4','4'+s,'4'],false]),
    ['千位连单位',['16,825','均价16,825元/吨','16,825'],true],
    ['紧邻中文前后',['4','共4行','4'],true], ['天',['3','共3天','3'],true], ['份',['5','共5份','5'],true],
    ['独立数字用空格列出',['4','共4 20份','4'],true],
    ['普通空格后不是三位组',['12','数值 4 12','12'],true],
    ['普通空格可隔开小数',['0.125','共4 0.125元','0.125'],true],
    ['完整窄分组',['4\u202f000','共4\u202f000行','4\u202f000'],true],
    ['完整符号百分比',['−4％','占比−4％','−4％'],true],
    ['中文结论要完整',['正常','非正常','正常'],false],
    ['字母编号要完整',['W4','W45','W4'],false],
    ['编号仍有中文词界',['W4','W4版','W4'],false],
    ['前面有拉丁标识',['4','x4行','4'],false],
    ['前面有符号',['4','共−4行','4'],false],
  ];
  ticketMatrix(t, cases, ([expected,product,picked], shouldSign, label) => {
    const p = liveProject('单位矩阵-' + cases.findIndex(c => c[0] === label)), { dir } = p;
    const take = liveTicket(p,'01',{ value:expected });
    liveRun(p,{ ...take,value:picked });
    put(dir,take.target,product+'\n');
    const body = report(dir,'accept','01','通过');
    liveFlow(dir);
    assert.deepEqual([!!liveReceipt(body),liveRead(dir).steps[0][2] === 'verified'],[shouldSign,shouldSign],label);
  });
});

test('13.58.2 活地图从当前卡点拆开进门、实跑与去向，证据折叠，复制只取本步', windows, t => {
  const p = liveProject('四层地图',{title:'日报 <样例> & "甲"'}), { dir } = p;
  const take = liveTicket(p,'01');
  liveRun(p,take);
  liveAccept(dir,'01');
  const second = liveTicket(p,'02',{ sameSource:true });
  liveRun(p,second);
  liveAccept(dir,'02');
  const index = read(dir,idx), target = second.target;
  const record = (n,q) => humanLine('2026-11-23',n,'02@1/1/1',target,q);
  const yes = '我核对通过，可以交付';
  const snapshots = [
    ['待核时先看第二步','',2,'waiting'],
    ['第三步明确拒绝优先',record(3,'第 3 步不通过：<金额> & "单位"'),3,'blocked'],
    ['全绿停在末步',record(2,yes)+record(3,yes),3,'verified'],
  ];
  ticketMatrix(t,snapshots.map(row => [row[0],row]), ([,extra,N,state]) => {
    put(dir,idx,index+extra);
    liveFlow(dir,'--refresh');
    const html = read(dir,liveHtml), meta = liveRead(dir);
    const current = html.match(/<section class="card" data-card="(\d+)"[^>]*>/g);
    assert.ok(current);
    assert.deepEqual(current.filter(tag => !tag.includes(' hidden')).map(tag => /data-card="(\d+)"/.exec(tag)[1]),[String(N)]);
    assert.equal(meta.steps[N-1][2],state);
    assert.equal((html.match(new RegExp('data-step="'+N+'"[^>]*aria-pressed="true"','g')) ?? []).length,2);
    for (const text of ['共 3 步','上一步','下一步','按序走一遍','进门拿什么','站内怎么干','出门去哪','正常件跑通',
      '坏样本拦截','开工前约好','这批实跑出','名词人话解释','展开核对与排错细节','复制给 AI 的下一句话']) assert.ok(html.includes(text),text);
    assert.doesNotMatch(html,/<details\b[^>]*\bopen\b|\.innerHTML\b/);
    assert.ok(html.includes('&lt;样例&gt; &amp; &quot;甲&quot;'));
    const card = html.slice(html.indexOf('<section class="card" data-card="2"'),html.indexOf('<section class="card" data-card="3"'));
    assert.match(card,/data-view="normal"[^>]*>/);
    assert.match(card,/data-view="bad"[^>]*hidden/);
    const drawer = card.match(/<details[^>]*><summary>展开核对与排错细节<\/summary>([\s\S]*?)<\/details>/)?.[1];
    assert.ok(drawer?.includes(second.target) && drawer.includes(second.badSample) && drawer.includes(second.stopped));
    assert.ok(card.includes(second.value) && card.includes(second.badWhy));
    if (!extra) {
      assert.ok(card.includes('票 2 通过，我核对通过，可以交付。'));
      assert.ok(card.includes('票 2 不通过：'));
      assert.ok(html.includes('data-jump="2"'));
    }
    if (state === 'blocked') assert.ok(html.includes('&lt;金额&gt; &amp; &quot;单位&quot;'));
    assert.equal(sha(island.exec(html)[1]),html.match(/<meta name="coach-map-sha" content="([a-f0-9]+)">/)[1]);
  });
});


test('13.58.2 法式分组的四千条实跑记录不能签成四条', windows, () => {
  const p = liveProject('四千条真实计数'), { dir } = p, take = liveTicket(p,'01');
  put(dir,take.goodSample,'价格\n'+'16200\n'.repeat(4000));
  liveRun(p,{ ...take,value:'有效行：4\u202f000' });
  const script = read(dir,take.script).replace('+ days.length', '+ days.length.toLocaleString("fr-FR")');
  put(dir,take.script,script);
  execFileSync(process.execPath,[take.script,take.goodSample,take.target,'01'],{cwd:dir});
  assert.equal(spawnSync(process.execPath,[take.script,take.badSample,take.stopped,'01'],{cwd:dir}).status,2);
  assert.match(read(dir,take.target),/^有效行：4\u202f000$/m);
  const body = report(dir,'accept','01','通过');
  assert.equal(liveReceipt(body),undefined);
  liveFlow(dir);
  assert.equal(liveRead(dir).steps[0][2],'blocked');
});


test('13.58.2 有摘要的上一版真图逐字验真后才准刷新', windows, () => {
  const { dir } = liveProject('兼容旧页');
  liveFlow(dir);
  const meta = liveRead(dir);
  // 从原正式包独立生成的无票三步页。即使浅克隆没有父提交，也必须重现同一串字节。
  const probe = path.join(tmp,'旧页渲染','工具','coach-check.mjs');
  put(path.dirname(path.dirname(probe)),'AGENTS.md',read(skill,'AGENTS.md'));
  const data = path.join(tmp,'旧页数据.json'), prior = path.join(tmp,'旧页.html');
  fs.writeFileSync(data,JSON.stringify(meta));
  put(path.dirname(probe),path.basename(probe),read(skill,'工具/coach-check.mjs') + '\n' +
    'fs.writeFileSync(' + JSON.stringify(prior) + ',renderLiveMap(JSON.parse(fs.readFileSync(' +
    JSON.stringify(data) + ',"utf8")),true));\n');
  execFileSync(process.execPath,[probe,'quote',dir],{input:'旧页核对'});
  const old = fs.readFileSync(prior,'utf8');
  assert.equal(sha(old),'2f60ee67bea47956a98bc203e3adb7d59b374b78a3d5f29e6720c2ffa3d1b140');
  put(dir,liveHtml,old);
  const kept = fileState(dir);
  assert.match(report(dir,'flow',undefined,'不通过'),/地图已过期/);
  assert.deepEqual(fileState(dir),kept);
  assert.match(liveFlow(dir,'--refresh'),/刷新项目活地图/);
  assert.deepEqual(liveRead(dir),meta);
  assert.notEqual(read(dir,liveHtml),old);
  put(dir,liveHtml,old.replace('width=device-width','width=Device-width'));
  const changed = fileState(dir);
  assert.match(report(dir,'flow','--refresh','不通过'),/图源异常/);
  assert.deepEqual(fileState(dir),changed);
});

test('13.58.2 无人工卡点时聚焦下一张待跑或锁住的票，停止项目只给保存指令', windows, () => {
  const p = liveProject('两步推进'), { dir } = p;
  const earlier = p.rows[0][4];
  put(dir,liveTable,read(dir,liveTable).replace('| 3 | 你 | ' + p.rows[2][2], '| 3 | 你 | ' + earlier));
  put(dir,idx,read(dir,idx) + humanLine('2026-11-23',3,'01@1/1/1',earlier,'我核对通过，可以交付'));
  liveRun(p,liveTicket(p,'01'));
  liveAccept(dir,'01');
  for (const state of ['pending','locked']) {
    if (state === 'locked') liveTicket(p,'02',{confirm:'票 02 验收单确认'});
    liveFlow(dir,'--refresh');
    const html = read(dir,liveHtml);
    assert.equal(liveRead(dir).steps[1][2],state);
    assert.match(html,/<section class="card" data-card="2"[^>]*(?<! hidden)>/);
    const action = html.slice(html.indexOf('<section class="card" data-card="2"'));
    assert.match(action,state === 'locked' ? /票 2 就这样跑/ : /为第 2 步准备任务单/);
  }
  put(dir,idx,read(dir,idx).replace('当前站：4 一步一票','当前站：已结束（停止）'));
  liveFlow(dir,'--refresh');
  const commands = [...read(dir,liveHtml).matchAll(/data-copy="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(commands.length,3);
  assert.ok(commands.every(c => c.includes('已停止') && !c.includes('就这样跑')));
});


test('13.58.3 分组数须从头取到尾，尾随符号和异文标识不能签成数量', windows, t =>
  checkNumericEvidence(t, '取完整值', [
    ['825.50', ['均价16 825.50元/吨'], ['均价825.50元/吨']],
    ['800 000', ['总产量2 800 000吨'], ['共800 000吨']],
    ['800,000', ['总量2 800,000吨'], ['共800,000吨']],
    ['825%', ['比例16 825%'], ['比例825%']],
    ['234', ['共1 234 567吨'], ['共234吨']],
    ['567', ['共1 234 567吨'], ['共567吨']],
    ['1 234', ['共1 234 567吨'], ['共1 234吨']],
    ['234 567', ['共1 234 567吨'], ['共234 567吨']],
    ['４５６.７', ['均价１ ４５６.７元'], ['均价４５６.７元']],
    ['4', [
      ...['-', '−', '+', '＋', '－', '-5', 'e3', 'px'].map(s => '报表结余：4' + s), 'ね4カ',
      ...['é', 'Ж', 'Ω', '\u0301', '\u203f'].flatMap(s => [s + '4', '4' + s]),
    ], ['共4行', '4 - 通过', '4——正常']],
    ['2 800 000', [], ['共2 800 000吨']], ['16 825.50', [], ['均价16 825.50元/吨']],
    ['2_800_000', [], ['共2_800_000吨']], ['é4', ['é4版'], ['编号：é4。']],
    ['16,825', [], ['均价16,825元/吨']], ['4\u202f000', [], ['共4\u202f000行']],
    ['4%', [], ['占比4%']], ['.4', [], ['均价.4元']],
  ]));

test('13.58.4 汉字单位可紧贴完整数，异文编号和数字空格分组不可截取', windows, t =>
  checkNumericEvidence(t, '单位与编号', [
    ['4', [
      ...['é', 'e\u0301', 'Ж', 'Ω', 'x', '_'].flatMap(s => [s + '4', '4' + s]), '4\u2007000',
      '件数：4건', '총4', 'メニュー4', '4び', '4ひ\u3099', 'ひ\u30994',
    ], ['4々']],
    ['000', ['4\u2007000'], []],
    ['4\u2007000', [], ['共4\u2007000行']],
    ['16,825', [], ['均价16,825元/吨']],
  ]));

test('13.58.5 只有汉字单位可紧贴数值，汉字倍词仍不可截取', windows, t =>
  checkNumericEvidence(t, '汉字数值边界', [
    ['4', [
      '件数：4만건', '4건', '총4', 'メニュー4', '4é', 'é4', '4e\u0301',
      ...[...'百千万萬亿億兆'].map(unit => '共4' + unit),
    ], ['4行', '共4行']],
    ['16,825', [], ['16,825元/吨', '均价16,825']],
  ]));

function checkNumericEvidence(t, projectName, groups) {
  const cases = [];
  for (const [value, invalid, valid] of groups) {
    const p = liveProject(projectName + '-' + value), take = liveTicket(p, '01', { value });
    liveRun(p, take);
    for (const [lines, sign] of [[invalid, false], [valid, true]]) {
      for (const line of lines) cases.push([line + ' 摘 ' + value, [p.dir, take.target, line], sign]);
    }
  }
  ticketMatrix(t, cases, ([dir, target, line], sign) => {
    put(dir, target, line + '\n');
    const body = report(dir, 'accept', '01', '通过');
    liveFlow(dir, '--refresh');
    assert.deepEqual([!!liveReceipt(body), liveRead(dir).steps[0][2]], [sign, sign ? 'verified' : 'blocked']);
  });
}

test('13.58.3 明确拒绝允许理由提上游或反问，准许交付须整句核对', windows, t =>
  checkReviewDecisions(t, '口令与理由', [
    ['票 2 不通过：和票 1 的汇总对不上。', 'blocked'],
    ['第 2 步不通过：均价怎么是 40？', 'blocked'],
    ['票 2 不通过：如果按旧表算错了。', 'blocked'],
    ['不同意交付：怎么少了一行？', 'blocked'], ['不同意交付，等我确认。', 'blocked'],
    ['票 2 不通过:原因：票 1 金额对不上？', 'blocked'],
    ['票 1 不通过：错', 'waiting'], ['票 2 不通过吗？', 'waiting'],
    ['如果错了，票 2 不通过', 'waiting'], ['待确认，暂不同意交付', 'waiting'],
    ['先退回重做；核对通过后再交。', 'waiting'], ['退回重做：改完再确认', 'blocked'],
    ['退回重做，改完再确认', 'waiting'], ['我已核对：票 2 不通过', 'waiting'],
    ['退回重做，不同意交付，等我确认。', 'blocked'],
    ['票 2 通过：票 1 通过', 'waiting'], ['票 2 通过：可以交付吗？', 'waiting'],
    ['票 2 通过：如果核对无误', 'waiting'], ['票 2 通过：等我确认', 'waiting'],
    ['票 2 通过：不同意交付', 'waiting'], ['票 2 通过：均价正确', 'waiting'],
    ['我已核对：对得上', 'waiting'], ['我已核对：票 2 通过。', 'verified'],
  ]));

test('13.58.4 核对只认本步主语，退回理由里的业务用词与暂缓分开判', windows, t =>
  checkReviewDecisions(t, '本步核对', [
    ['第 1 步，不通过：合计怎么是 40？', 'waiting'],
    ['第 2 步，不通过：合计怎么是 40？', 'blocked'],
    ['退回第 1 步重做', 'blocked'], ['第 1 步退回重做', 'waiting'], ['第 1 步通过', 'waiting'],
    ['票 2 不通过：和第 1 步结果对不上。', 'blocked'], ['我核对通过：顺便看了第 1 步', 'waiting'],
    ['第 2 步，我核对通过', 'verified'], ['第 2 步，不通过', 'blocked'],
    ['退回重做：两列合计不相等。', 'blocked'], ['退回重做：等号写错了。', 'blocked'],
    ['退回重做：待摊费用漏算了。', 'blocked'], ['退回重做：暂估金额算错了。', 'blocked'],
    ['先退回重做；核对通过后再交。', 'waiting'], ['退回重做，改完再确认', 'waiting'],
    ['退回重做：改完再确认', 'blocked'], ['待确认，暂不同意交付', 'waiting'],
    ['我核对通过：等确认', 'waiting'], ['我核对通过，稍等。', 'waiting'],
    ['不同意交付，等我确认。', 'blocked'],
  ]));

test('13.58.5 退回由冒号前的决定判定，核对票号和步号也识别中文一至十', windows, t =>
  checkReviewDecisions(t, '退回理由与中文编号', [
    ['退回重做：等待时长算错了。', 'blocked'],
    ['退回重做：待处理订单漏算了。', 'blocked'],
    ['退回重做：两列合计不相等。', 'blocked'],
    ['退回重做：改完再确认', 'blocked'],
    ['退回重做，等一等。', 'waiting'], ['退回重做，等下。', 'waiting'],
    ['退回重做，等一下。', 'waiting'], ['退回重做，改完再确认', 'waiting'],
    ['先退回重做；核对通过后再交。', 'waiting'], ['待确认，暂不同意交付', 'waiting'],
    ['不同意交付，等我确认。', 'blocked'],
    ['第一步，不通过：合计怎么是 40？', 'waiting'],
    ['第二步，不通过：合计怎么是 40？', 'blocked'],
    ['第二步，我核对通过', 'verified'],
    ['票二，不通过', 'blocked'], ['票二，我核对通过', 'verified'],
    ['退回第一步重做', 'blocked'],
    ['第二步，我核对通过：等一等。', 'waiting'],
    ['我核对通过：第二步通过', 'verified'],
    ...[...'一三四五六七八九十'].flatMap(n => [
      ['第 ' + n + ' 步，不通过', 'waiting'], ['票' + n + '，不通过', 'waiting'],
    ]),
  ]));

function checkReviewDecisions(t, projectName, cases) {
  const p = liveProject(projectName), { dir } = p;
  for (const n of ['01', '02']) {
    liveRun(p, liveTicket(p, n, { sameSource: n === '02' }));
    liveAccept(dir, n);
  }
  const index = read(dir, idx), target = p.rows[1][4];
  const record = (date, quote) => humanLine(date, 2, '02@1/1/1', target, quote);
  const file = ticketPath('02');
  put(dir, file, read(dir, file) + record('2026-11-23', '我核对通过，可以交付。'));
  ticketMatrix(t, cases.map(([quote, state]) => [quote, quote, state]), (quote, state) => {
    put(dir, idx, index + record('2026-11-24', quote));
    liveFlow(dir, '--refresh');
    const step = liveRead(dir).steps[1];
    assert.deepEqual([step[2], step[10]?.[1] ?? null], [state, state === 'waiting' ? null : quote]);
    const card = read(dir, liveHtml).match(/<section class="card" data-card="2"[^>]*>[\s\S]*?<\/section>/)[0];
    assert.equal(card.includes('复制：我核对通过'), state === 'waiting');
    if (state === 'blocked') assert.ok(card.includes(quote) && card.includes('复制：打开证据排查'));
  });
}

test('13.58.2 离线双主题实图可走、可切样本、可退回、可复制', windows, async t => {
  const browserPath = requireFixture(t,'AGENT_COACH_TEST_PLAYWRIGHT');
  if (!browserPath) return;
  const { chromium } = await import(pathToFileURL(browserPath).href);
  const browser = await chromium.launch({ executablePath:chromium.executablePath(),headless:true });
  const evidence = process.env.AGENT_COACH_TEST_MAP_EVIDENCE;
  try {
    t.diagnostic('Chromium ' + browser.version());
    for (const wide of [false,true]) {
      const p = liveProject(wide ? '实图七步' : '实图三步',{wide,week:'W45'}), { dir } = p;
      const first = liveTicket(p,'01',{periodic:true}), second = liveTicket(p,'02',{periodic:true,sameSource:true});
      for (const take of [first,second]) { liveRun(p,take); liveAccept(dir,take.n); }
      const quote = '票 2 不通过：请核对均价的单位。';
      if (wide) put(dir,idx,read(dir,idx)+humanLine('2026-11-24',2,'02@1/1/1；输入 1 报告周=W45',second.target,quote));
      liveFlow(dir);
      const count = wide ? 7 : 3, map = path.join(dir,liveHtml);
      if (evidence) fs.copyFileSync(map,path.join(evidence,count+'步.html'));
      for (const [width,height] of [[728,900],[390,844]]) for (const theme of ['light','dark']) {
        const reduced = width === 390, state = wide ? 'blocked' : 'waiting';
        const context = await browser.newContext({viewport:{width,height},colorScheme:theme,offline:true,
          serviceWorkers:'block',reducedMotion: reduced ? 'reduce' : 'no-preference'});
        try {
          const granted = theme === 'light';
          await context.grantPermissions(granted ? ['clipboard-read','clipboard-write'] : []);
          const page = await context.newPage();
          page.setDefaultTimeout(5000);
          const requests = [], messages = [], errors = [];
          page.on('request',req => requests.push(req.url()));
          page.on('console',msg => messages.push(msg.type() + ': ' + msg.text()));
          page.on('pageerror',err => errors.push(err.message));
          const url = pathToFileURL(map).href;
          await page.goto(url);
          const scene = page.locator('.scene:visible'), card = page.locator('.card:visible');
          const selected = async () => Number(await scene.locator('.picked').getAttribute('data-step'));
          const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
          assert.equal(await selected(),2);
          assert.equal(await card.getAttribute('data-state'),state);
          assert.equal(await scene.locator('[data-step]').count(),count);
          assert.equal(await page.locator('details[open]').count(),0);
          const rect = await scene.boundingBox();
          const visibleArea = (Math.min(width,rect.x+rect.width)-Math.max(0,rect.x)) *
            (Math.min(height,rect.y+rect.height)-Math.max(0,rect.y)) / (width*height);
          assert.ok(visibleArea >= .70,'首屏图占比 '+visibleArea);
          await noOverflow();
          if (evidence) await page.screenshot({path:path.join(evidence,[count,width,theme].join('-')+'.png')});
          await page.getByRole('button',{name:'下一步',exact:true}).click();
          assert.equal(await selected(),3);
          await card.locator('[data-jump="2"]').click();
          assert.equal(await selected(),2);
          await page.getByRole('button',{name:'上一步',exact:true}).click();
          assert.equal(await selected(),1);
          await scene.locator('[data-step="2"]').click();
          await scene.locator('[data-step="2"]').press('End');
          assert.equal(await selected(),count);
          await scene.locator('[data-step="1"]').focus();
          await scene.locator('[data-step="1"]').press('Space');
          assert.equal(await selected(),1);
          await scene.locator('[data-step="2"]').focus();
          await scene.locator('[data-step="2"]').press('Enter');
          assert.equal(await selected(),2);
          await page.getByRole('button',{name:'按序走一遍'}).click();
          assert.equal(await selected(),1);
          await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('停在第 2 步'));
          assert.equal(await selected(),2);
          assert.ok((await page.locator('#notice').textContent()).includes(wide ? '核对未放行' : '等你点头'));
          await card.getByRole('button',{name:'坏样本拦截'}).click();
          assert.equal(await scene.locator('.picked .sample-stop').isVisible(),true);
          assert.ok(await scene.locator('.wire.at-stop').count() > 0);
          const bad = card.locator('[data-view="bad"]');
          for (const word of [path.win32.basename(second.badSample),second.badWhy,'本站已拦停']) assert.ok((await bad.innerText()).includes(word));
          assert.equal(await card.locator('[data-view="normal"]').isVisible(),false);
          await card.getByRole('button',{name:'正常件跑通'}).click();
          assert.equal(await scene.locator('.picked .sample-stop').isVisible(),false);
          assert.ok((await card.locator('[data-view="normal"]').innerText()).includes('16,825'));
          await card.getByText('名词人话解释',{exact:true}).click();
          assert.deepEqual(await page.locator('#terms dt').allTextContents(),['原件只读','写死程序','AI 判断','你拍板','坏样本拦截']);
          await card.getByText('展开核对与排错细节',{exact:true}).click();
          const trace = await card.locator('.evidence dl').innerText();
          for (const word of [second.goodSample,second.badSample,second.target,second.stopped,'W45','出错先开这份',...(wide ? [quote,'PROJECT_INDEX.md'] : [])])
            assert.ok(trace.includes(word),word);
          await noOverflow();
          const copies = card.locator('[data-copy]');
          const sentences = await copies.evaluateAll(nodes => nodes.map(n => n.dataset.copy));
          if (wide) assert.ok(sentences[0].includes(second.target) && sentences[0].includes('排查'));
          else assert.deepEqual(sentences,['票 2 通过，我核对通过，可以交付。','票 2 不通过：<写明哪一项不对>']);
          for (const [j,expected] of sentences.entries()) {
            await copies.nth(j).click();
            const feedback = granted ? '已复制' : '请按 Ctrl+C';
            await card.getByText(feedback,{exact:true}).waitFor();
            if (granted) assert.equal(await page.evaluate(() => navigator.clipboard.readText()),expected);
            else assert.deepEqual(await card.locator('textarea').evaluate(f => [f.readOnly,f.value,f.selectionStart,f.selectionEnd]),[true,expected,0,expected.length]);
          }
          await noOverflow();
          assert.deepEqual(requests,[url]); assert.deepEqual(messages,[]); assert.deepEqual(errors,[]);
          t.diagnostic('实图 ' + JSON.stringify({count,width,height,theme,reduced,state,rect,visibleArea,
            externalRequests:0,consoleMessages:0,pageErrors:0,overflow:0,clipboard:granted?'已复制':'请按 Ctrl+C',commands:sentences}));
        } finally { await context.close(); }
      }
    }
  } finally { await browser.close(); }
});
