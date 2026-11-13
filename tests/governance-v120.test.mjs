import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const coachCheck = path.join(root, '工具', 'coach-check.mjs');
const windows = { skip: process.platform !== 'win32' };
const ALLOWED_LIST_NOTES = new Set(['至少一份文件', '可有可无', '表头写了"不画图"时可有可无']);

test('v1.20 跨文件静态契约：版本号、五站总览口令、完成清单修饰词、数据治理与体检修复规矩对齐', () => {
  const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const overview = fs.readFileSync(path.join(root, '讲解', '五站总览.html'), 'utf8');
  const packScript = fs.readFileSync(path.join(root, '工具', 'pack-release.ps1'), 'utf8');
  const check0 = fs.readFileSync(path.join(root, '做法', '0-体检.md'), 'utf8');
  const repair0 = fs.readFileSync(path.join(root, '做法', '0-修复复诊.md'), 'utf8');

  assert.match(agents.split(/\r?\n/)[0], /v1\.20/);
  assert.match(readme, /当前版本：\*\*v1\.20\*\*/);
  assert.match(readme, /releases\/v1\.20\/agent-coach-v1\.20-20261112\.zip/);
  assert.match(readme, /仅定稿尾票.*接班后须说 `就这样跑`/);
  assert.match(overview, /Agent 搭建教练 v1\.20：五站总览/);
  assert.match(packScript, /releases\\v1\.20/);

  // 确保五站总览图已清除旧版废弃口令并对齐现行口令（含体检批量修复口令）
  for (const stale of ['这套做法行得通', '流程排好了', '第 N 票验收通过', '收尾通过']) {
    assert.ok(!overview.includes(stale), `五站总览.html 仍残留废弃口令: ${stale}`);
  }
  for (const active of ['项目建好了', '任务单确认', '拆解确认', '流程就这样', '就这样跑', '按快跑档推进', '票 N 通过', '采用', '停止', '修复全部硬伤']) {
    assert.ok(overview.includes(active), `五站总览.html 缺少现行口令: ${active}`);
  }

  // 确保体检与修复复诊规范已清除电报体英文乱码并包含五维诊断、P01三色分级、外置目录树与两轮熔断
  assert.doesNotMatch(check0, /Wait work|一次只问.*请直接打字回答/);
  assert.match(check0, /五维/);
  assert.match(check0, /P01/);
  assert.match(check0, /修复全部硬伤/);
  assert.match(repair0, /初诊\\docs\\check\\scan\.txt/);
  assert.match(repair0, /复诊-1\\docs\\check\\scan\.txt/);
  assert.match(repair0, /连续两轮复诊无实质进展立即熔断/);

  // 确保做法 1..5 末尾「本站完成清单」括号修饰词 100% 符合 coach-check NOTES 白名单
  const practicesDir = path.join(root, '做法');
  for (const file of fs.readdirSync(practicesDir)) {
    if (!/^[1-5]-.*\.md$/.test(file)) continue;
    const text = fs.readFileSync(path.join(practicesDir, file), 'utf8');
    const sec = text.split(/^## 本站完成清单\s*$/m)[1];
    assert.ok(sec, `${file} 缺少 ## 本站完成清单`);
    for (const line of sec.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('- ')) continue;
      const m = trimmed.slice(2).trim().match(/^(.*?)([\(（][^()（）]*[\)）])?$/);
      assert.ok(m, `${file} 清单行格式异常: ${trimmed}`);
      const mark = (m[2] ?? '').replace(/[()（）]/g, '');
      if (mark) {
        assert.ok(ALLOWED_LIST_NOTES.has(mark), `${file} 清单项括号修饰词非法: "${mark}"`);
      }
    }
  }

  // 验证三级数据治理、三级回退路由与持续运行枚举防漂移均已写入规范与模板
  const sop2 = fs.readFileSync(path.join(root, '做法', '2-SOP-拆开SOP.md'), 'utf8');
  const flow3 = fs.readFileSync(path.join(root, '做法', '3-排表画图.md'), 'utf8');
  const shared = fs.readFileSync(path.join(root, '做法', '共用.md'), 'utf8');
  const tplAgents = fs.readFileSync(path.join(root, '模板', 'AGENTS.模板.md'), 'utf8');
  assert.match(sop2, /数据清理对照单\.md/);
  assert.match(flow3, /最多 \*\*7 步\*\*/);
  assert.match(shared, /三级回退路由/);
  assert.match(tplAgents, /已知枚举白名单/);
});


function runCheck(dir, command, arg, verdict, reason) {
  execFileSync(process.execPath, [coachCheck, command, dir, ...(arg ? [arg] : [])], { stdio: 'pipe' });
  const report = fs.readFileSync(path.join(dir, 'docs', 'check', command + '.txt'), 'utf8');
  assert.equal(report.split(/\r?\n/, 1)[0].split('｜').at(-1), verdict, report);
  if (reason) assert.match(report, reason);
  return report;
}

function write(dir, rel, value) {
  const dest = path.join(dir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, value, 'utf8');
}

function project(t) {
  const base = fs.mkdtempSync(path.join(root, '..', 'temp-v120-gov-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const proj = path.join(base, 'target-proj');
  runCheck(proj, 'init', null, '通过');
  return proj;
}

const doc = (name) => fs.readFileSync(path.join(root, name), 'utf8');
const sourceDir = 'inputs\\01-认出输入\\';
const sample = 'raw_W44.csv';
const recognition = 'work\\01-认出结果.md';
const cleaned = 'work\\02-清洗数据.csv';

function runFlow(stepCount) {
  const template = doc('模板/docs/run-flow.模板.md');
  const inputLine = template.split(/\r?\n/).find((line) => line.startsWith('| 输入 1 |'));
  const stepLine = template.split(/\r?\n/).find((line) => line.startsWith('| <N> |'));
  function emptyValue(line) {
    const match = line.match(/没有写([^>\s]+)>/);
    assert.ok(match, '运行表模板应给出没有值时的填法');
    return match[1];
  }
  const empty = emptyValue(stepLine);
  const rows = [
    ['1','AI照规矩','输入 1','认出输入：核对文件名及必填列。依据：样例 1',recognition,empty],
    ['2','AI照规矩',recognition+'、输入 1','清洗数据：去重并转换金额单位。依据：样例 1',cleaned,empty],
    ['3','AI照规矩',cleaned,'计数：数行数。依据：样例 1','work\\03-行数.md',empty],
    ['4','AI看情况','work\\03-行数.md','提炼摘要：按说明判断。依据：样例 2','work\\04-摘要.md',empty],
  ];
  for (let number=5; number<stepCount; number++) {
    const out = number === stepCount-1 ? 'output\\周报.md' : 'work\\'+String(number).padStart(2,'0')+'-记录.md';
    rows.push([String(number),'AI照规矩',rows.at(-1)[4],'复核：按清单查。依据：样例 2',out,empty]);
  }
  rows.push([String(stepCount),'你',rows.at(-1)[4],'人工终核：核对后交付。依据：样例 3',empty,'看净额｜相符｜不对退回第 2 步']);
  const input = ['输入 1',sourceDir,'raw_<周次>.csv；本次 W44','状态、金额（元）','一份',sourceDir+sample,emptyValue(inputLine)];
  const tableRow = (cells) => '| '+cells.join(' | ')+' |';
  return template.replace(/^# .*/,'# 运行表：周期周报\n本轮图：不画图')
    .replace(inputLine,tableRow(input)).replace(stepLine,rows.map(tableRow).join('\n'));
}

test('v1.20 按实际模板识别输入、确认架构并校验 6/7/8 步上限', windows, (t) => {
  const proj = project(t);
  write(proj,'materials/'+sample,'状态,金额\n已完成,120');
  runCheck(proj,'files','1','通过');
  for (const route of ['新做','SOP']) {
    const template = doc('模板/docs/INTAKE-'+route+'.模板.md');
    const signal = template.split(/\r?\n/).find((line) => line.startsWith('信号：'));
    write(proj,'docs/INTAKE.md',['## ⑥ 架构推荐',signal.replace('<推荐表里的信号名>','固定').replace('<原话>','步骤固定'),
      '架构：固定流程（Workflow／编排组织类，单 Agent）','因为：每周重复','第一版：照五站搭'].join('\n'));
    runCheck(proj,'files','2','通过');
  }
  write(proj,sourceDir+sample,'状态,金额\n已完成,120');
  for (const count of [6,7,8]) {
    write(proj,'docs/run-flow.md',runFlow(count));
    runCheck(proj,'inputs',null,'通过');
    runCheck(proj,'flow',null,count === 8 ? '不通过' : '通过',count === 8 ? /不超过 7 步/ : /运行表 \d 步，规则都过了/);
  }
});

test('v1.20 清洗票需要独立真值，只点收其产物不升级成计算票', windows, (t) => {
  const proj = project(t);
  write(proj,'docs/run-flow.md',runFlow(6));
  function checkWith(n, source, verdict) {
    const out = n === '02' ? cleaned : 'work\\03-行数.md';
    write(proj,'docs/tickets/'+n+'-样例.md',['# 票 '+n+'：样例','## 这一步','## 验收单（第 1 版）',
      '- 预期值来源：'+source,'### AI 自检','- 有 '+out,'## 确认记录','- 第 1 次确认（第 1 版）：2026-11-12｜就这样跑'].join('\n'));
    write(proj,out,'120\n');
    for (const cmd of ['ticket','accept']) runCheck(proj,cmd,n,verdict,verdict==='不通过' ? /独立真值来源/ : undefined);
  }
  checkWith('02','样例清点确认：首行有金额', '不通过');
  checkWith('02','边界小样核定：第 2–4 行重复，只计一次，净额 120','通过');
  checkWith('03','样例清点确认：原样例清点 1 行','通过');
});

test('v1.20 使用做法中的快跑批次；换期结果占位模板不能代表基线状态', windows, (t) => {
  const proj = project(t);
  write(proj,'docs/run-flow.md',runFlow(6));
  const guide = doc('做法/4-一步一票.md');
  const example = guide.match(/`(- 快跑批次：[^`]+)`/);
  assert.ok(example,'第 4 站文档缺快跑批次示例');
  write(proj,'docs/PROJECT_INDEX.md','当前站：4 一步一票\n## 已确认\n'+example[1]+'\n');
  write(proj,'docs/tickets/01-认出输入.md',['# 票 01：认出输入','## 这一步','怎么做：写程序（scripts\\01_认出输入.js）',
    '## 验收单（第 1 版）','- 预期值来源：样例清点确认：识别 1 份','### AI 自检','- 有 '+recognition,
    '- work\\01-坏输入\\结果.txt 含 已拦截','## 确认记录','- 第 1 次确认（第 1 版）：2026-11-12｜按快跑档推进'].join('\n'));
  write(proj,recognition,'1 份输入');
  write(proj,'scripts/01_认出输入.js','// Fixture');
  write(proj,'work/01-坏输入/结果.txt','已拦截');
  runCheck(proj,'accept','01','通过');

  const ticket = ['# 票 02：清洗数据','## 这一步','## 验收单（第 1 版）','- 预期值来源：边界小样核定：3 行，净额 120',
    '### AI 自检','#### 固定基线断言（绑定参数：W44）','- '+cleaned+' 含 120','#### 当期守恒断言（每次必核）',
    '- '+cleaned+' 含 当期核对通过','- work\\02-坏输入\\结果.txt 含 已拦截','## 确认记录',
    '- 第 1 次确认（第 1 版）：2026-11-12｜就这样跑','## 结果','### 第 1 轮｜按第 1 次确认（第 1 版）的验收单'].join('\n');
  write(proj,cleaned,'参数｜报告周：W45\n135\n当期核对通过');
  write(proj,'work/02-坏输入/结果.txt','已拦截');
  const ticketPath = 'docs/tickets/02-清洗数据.md';
  const placeholder = doc('模板/docs/票.模板.md').match(/^.*写明.*固定基线.*$/m)?.[0];
  assert.ok(placeholder,'票模板应提示本轮基线状态');
  for (const text of new Set([placeholder, placeholder.replaceAll('［','[').replaceAll('］',']'), placeholder.replaceAll('[','［').replaceAll(']','］')])) {
    write(proj,ticketPath,ticket+'\n'+text);
    runCheck(proj,'accept','02','不通过',/固定基线状态/);
  }
  write(proj,ticketPath,ticket.replace('第 1 轮｜按第 1 次确认（第 1 版）','第 1 轮｜按第 K 次确认（第 V 版）')+'\n固定基线 W44：未跑（本轮代码未改动）');
  runCheck(proj,'accept','02','不通过',/固定基线状态/);
  write(proj,ticketPath,ticket+'\n固定基线 W44：未跑（本轮代码未改动）');
  runCheck(proj,'accept','02','通过');
});

test('v1.20 外置初诊和复诊分别生成，目标项目不变', windows, (t) => {
  const proj = project(t);
  const bundle = path.join(path.dirname(proj),'周报-体检报告','20261112-01');
  write(bundle,'体检记录.md','# 体检记录\n');
  function projectFiles() {
    return fs.readdirSync(proj,{recursive:true,withFileTypes:true}).filter(e=>e.isFile())
      .map(e=>{const f=path.join(e.parentPath,e.name);return [path.relative(proj,f),fs.readFileSync(f,'utf8')];})
      .sort(([a],[b])=>a.localeCompare(b));
  }
  const before = projectFiles();
  for (const round of ['初诊','复诊-1']) {
    const dir = path.join(bundle,round);
    const report = runCheck(dir,'scan',proj,'通过',/## 架构/);
    assert.match(report,/## 完成度/);
    assert.deepEqual(fs.readdirSync(path.join(dir,'docs/check')),['scan.txt']);
  }
  assert.deepEqual(projectFiles(),before);
});
