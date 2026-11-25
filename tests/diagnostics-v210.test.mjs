import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const product = process.env.COACH_PRODUCT || repo;
const checker = path.join(product, '工具/coach-check.mjs');
const renderer = path.join(product, '工具/eli5-report.mjs');
const windows = { skip: process.platform !== 'win32' };
function requireFixture(t, name) {
  const value=process.env[name];
  if (value) return value;
  assert.ok(!process.env.AGENT_COACH_DIAG_EVIDENCE &&
    !(name==='AGENT_COACH_TEST_PLAYWRIGHT' && (process.env.AGENT_COACH_TEST_RELEASE || process.env.CI)),
  '正式验收必须设置 '+name);
  t.skip('未设置 '+name);
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-diag-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const runTable = 'docs/run-flow.md', index = 'docs/PROJECT_INDEX.md', projectMap = 'docs/run-flow.html';
const sourceMap = 'docs/check/run-flow.workflow.json', sidecar = 'docs/run-flow.delivery.json';
const first = 'work\\01-输入.txt', captured = 'work\\02-当批\\', final = 'output\\03-清单.csv';
const handover = '被点名调用 agent-coach 体检或升级时，本轮回复格式与停点先听教练的';
const followUp = '换对话时说：直接对项目 AI 说：接着做';
const nextLine = '未通过：禁止报修好/已通过';
const scanMap = 'docs/check/scan-map.html', snapshot = 'docs/check/snapshot.json', scanText = 'docs/check/scan.txt';
const reportDefinition = {
  batch: { 报告日: '2026-11-25' }, date: '2026-11-25', title: '选题日报', audience: '内容负责人',
  conclusion: '一条可用，一条拦回，一条等补证。',
  stats: [{label:'实见零项',value:0,unit:'条'}, {label:'来源缺数',value:null,unit:'条'}],
  items: [
    {label:'春季选题',state:'正常',input:'本批记录',rule:'来源日期等于报告日',basis:'清单第 2 行',action:'交编辑核选',exception:'退回采集'},
    {label:'旧批条目',state:'异常',input:'上期记录',rule:'来源日期等于报告日',basis:'清单第 3 行',action:'暂缓采用',exception:'退回补当批记录'},
    {label:'待补出处',state:'正常',input:'新条目',rule:'须有可核出处',basis:null,action:null,exception:'请采集人补出处'},
  ],
  decisions: [{question:'是否采用春季选题？',proposal:'先核已证的一条'}],
  evidence: [{label:'当批清单',source:'work/02-清单.csv 第 2–4 行'}],
  terms: [{term:'当批',meaning:'这次使用的那批记录'}],
};
const approvedMembers = [
  'AGENTS.md','CLAUDE.md','README.md','SKILL.md','LICENSE.md','做法/0-体检.md','做法/0-修复复诊.md',
  '做法/1-建项目.md','做法/2-SOP-拆开SOP.md','做法/2-新做-说清需求.md','做法/3-排表画图.md',
  '做法/4-一步一票.md','做法/5-收尾交接.md','做法/共用.md','做法/架构推荐表.md','做法/业务网页-ELI5.md',
  '工具/coach-check.mjs','工具/eli5-report.mjs','模板/AGENTS.模板.md','模板/CLAUDE.模板.md','模板/README.模板.md',
  '模板/docs/INTAKE-SOP.模板.md','模板/docs/INTAKE-新做.模板.md','模板/docs/PROJECT_INDEX.模板.md',
  '模板/docs/run-flow.模板.md','模板/docs/票.模板.md','讲解/五站总览.html',
].sort();
const sha = b => createHash('sha256').update(b).digest('hex');
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const put = (dir, rel, value) => {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
const fresh = name => fs.mkdtempSync(path.join(temp, name + '-'));
const files = dir => fs.readdirSync(dir, {recursive:true,withFileTypes:true})
  .filter(e => e.isFile()).map(e => path.relative(dir,path.join(e.parentPath ?? e.path,e.name)).replaceAll('\\','/')).sort();
const fingerprint = dir => Object.fromEntries(files(dir).map(rel => {
  const file = path.join(dir, rel);
  return [rel, [sha(fs.readFileSync(file)), fs.statSync(file).mtimeMs]];
}));
function run(script, args, options = {}) {
  const {preload, ...rest} = options;
  const argv = [...(preload ? ['--require',preload] : []),script,...args];
  const r = spawnSync(process.execPath, argv, { encoding:'utf8', timeout:50000, ...rest });
  if (process.env.AGENT_COACH_DIAG_RAW) fs.appendFileSync(process.env.AGENT_COACH_DIAG_RAW,
    '\n' + JSON.stringify({exe:process.execPath,version:process.version,argv,exit:r.status}) +
    '\nstdout:\n' + r.stdout + '\nstderr:\n' + r.stderr + '\n');
  assert.ifError(r.error);
  return r;
}
const tool = (cmd, dir, args = [], options) => run(checker, [cmd,dir,...args], options);
const verdict = s => s.split(/\r?\n/,1)[0].split('｜').at(-1);
function scan(dir, dest = fresh('外置'), options) {
  const r = tool('scan', dest, [dir], options);
  assert.equal(r.status, 0, r.stderr);
  const report=read(dest,scanText);
  if(process.env.AGENT_COACH_DIAG_RAW) fs.appendFileSync(process.env.AGENT_COACH_DIAG_RAW,'scan.txt:\n'+report);
  return {dest,report,r};
}
function mapPage(dest) {
  assert.ok(exists(dest,scanMap), '有运行表的体检缺少外置 scan-map.html');
  const html = read(dest,scanMap);
  assert.match(html, /<meta name="coach-generator" content="scan-map\/1">/);
  return html;
}
const mapData = html => JSON.parse(/<script type="application\/json" id="scan-data">([^\n]+)<\/script>/.exec(html)[1]);
function flowFile(dir, rows, {draw = false, param = ''} = {}) {
  const pattern = param ? '当批-<报告日>.csv' + (param === '未定' ? '' : '；本次 ' + param) : '当批.csv';
  const sample = 'inputs\\01-来源\\当批' + (param && param !== '未定' ? '-' + param : '') + '.csv';
  put(dir, runTable, ['# 运行表：内容生产', '本轮图：' + (draw ? '出图' : '不画图'), '流程就这样：2026-11-24',
    '## 输入清单',
    '| 输入 N | 放哪 | 文件名规则 | 必须有的栏目（含单位；缺栏目怎么办） | 一次几份 | 样例文件 | 反例文件 |',
    '|---|---|---|---|---|---|---|', '| 输入 1 | inputs\\01-来源\\ | ' + pattern + ' | 业务键 | 一份 | ' + sample + ' | — |',
    '## 运行表','| 第几步 | 谁做 | 从哪拿 | 做什么 | 放到哪 | 你要判断什么 |','|---|---|---|---|---|---|',
    ...rows.map(r => '| ' + r.join(' | ') + ' |'),''].join('\n'));
  put(dir,sample,'业务键,金额\n甲,12\n');
  return sample;
}
function fixture(name = 'FDE 合成', opt = {}) {
  const dir = fresh(name);
  const rows = [
    ['1','AI照规矩','输入 1','认出输入：读取业务键。依据：例 1',first,'—'],
    ['2','AI照规矩',first,'采集当批：取值。依据：例 1',captured,'—'],
    ['3','AI照规矩',captured,'治理填表：按批去重。依据：例 2',final,'—'],
    ['4','你',final,'人工核对：查看交付。依据：例 3','—','查看业务键｜人工列一致｜不同退回第3步'],
  ];
  const result = tool('init',dir);
  assert.equal(result.status,0,result.stderr);
  put(dir, index, '当前站：' + (opt.station ?? '4 一步一票') + '\n搭建教练版本：v1.17\n## 下一步\n' + followUp + '\n## 已确认\n');
  put(dir,'AGENTS.md','# 项目规矩\n## 开工\n先打开运行表。\n共 4 步。\n');
  put(dir,'README.md','# 项目\n先读运行表。\n');
  put(dir,'docs/INTAKE.md','## ⑥ 架构推荐\n信号：固定\n架构：固定流程（Workflow／编排组织类，单 Agent）\n因为：四步固定\n第一版：按表执行\n');
  const sample = flowFile(dir,rows,opt);
  return {dir,rows,sample};
}
function writeTicket(dir,row,{from=row[2],to=row[4],acceptance=[]}={}) {
  const num = row[0].padStart(2,'0'), rel = 'docs/tickets/' + num + '-样例.md';
  put(dir,rel,['# 票 ' + num + '：样例','## 这一步（照运行表第 ' + row[0] + ' 行）','从哪拿：'+from,'做什么：'+row[3],
    '放到哪：'+to,...acceptance,''].join('\n'));
  return rel;
}
function runFlow(dir, flag) {
  const r = tool('flow',dir,flag ? [flag] : []);
  assert.equal(r.status,0,r.stderr);
  return read(dir,'docs/check/flow.txt');
}
function prepareCard() {
  const {dir,rows} = fixture('诊断台',{draw:true});
  assert.equal(verdict(runFlow(dir)),'通过');
  const oldMap = fingerprint(dir)[projectMap];
  rows[2][2] += '、work\\未交接\\';
  rows[2][3] = '去重填表：整理并写入飞书竞品表。依据：例 2';
  rows[3][5] = '查看业务键｜人工列一致｜不同退回第2步';
  flowFile(dir,rows,{draw:true});
  writeTicket(dir,rows[2],{to:'output\\另一个清单.csv'});
  return {dir,rows,oldMap};
}
function archifyFixture(from=path.join(repo,'tests/fixtures/archify')) {
  const dir = fresh('旧 Archify');
  for (const rel of [runTable,projectMap,sourceMap,sidecar]) put(dir,rel,fs.readFileSync(path.join(from,rel.slice(5))));
  return dir;
}
function generate(dir, data = reportDefinition, output = '日报.html', input = '日报.json') {
  put(dir,input,typeof data === 'string' ? data : JSON.stringify(data));
  return run(renderer,[path.join(dir,input),path.join(dir,output)]);
}
function requireRenderer() {
  assert.ok(fs.existsSync(renderer),'包内没有可独立运行的业务网页生成器');
}
const verifyPage = (dir, rel='日报.html') => run(renderer,['--check',path.join(dir,rel)]);

const delivery = '- 外部交付｜第3步｜飞书竞品表｜标题｜2026-11-25｜单次｜';
const receipt = 'docs/check/回读.txt';
const receiptText = ['工作表：飞书竞品表','批次：2026-11-25','允许列：标题','结果：通过','执行时间：2026-11-25 09:00',
  '写前：2 行','本次新增：1 行','写后：3 行','实见业务键：甲','人工列：前后逐值一致（人工内容甲）','授权：同意写标题，仅本批单次'].join('\n');
function deliveryProject() {
  const {dir}=fixture('采用中',{station:'已结束（采用）'});
  put(dir,'materials/原件.txt','样例');
  put(dir,'work/01-输入.txt','实物');
  put(dir,'docs/check/run-flow.txt','四步表');
  put(dir,'docs/check/materials-基线.txt','materials 基线｜2026-11-25｜文件｜字节｜SHA-256\nmaterials\\原件.txt｜6｜'+sha('样例')+'\n');
  return dir;
}
function stationFive(dir) {
  const r=tool('files',dir,['5']);
  assert.equal(r.status,0,r.stderr);
  return read(dir,'docs/check/files.txt');
}

test('A3-01 拒绝、撤回与已变更的人工列都阻止采用',windows,async t=>{
  for (const [name,field,body,result] of [
    ['拒绝','授权','不同意写标题，本批单次亦未获准','失败'],
    ['撤回','授权','同意写标题，现撤销本批单次授权','失败'],
    ['不明确','授权','标题，本批单次','失败'],
    ['缺授权','授权','','待核'],
    ['变更','人工列','未能证明前后一致，发现人工值已改变','失败'],
    ['只剩空值','人工列','前后一致，均空','待核'],
  ]) await t.test(name,()=>{
    const dir=deliveryProject();
    put(dir,index,read(dir,index).replace('## 已确认',delivery+'已读回｜docs\\check\\回读.txt\n## 已确认'));
    put(dir,receipt,receiptText.replace(new RegExp('^'+field+'：.*$','m'),body?field+'：'+body:''));
    const report=stationFive(dir);
    assert.equal(verdict(report),'不通过',report);
    assert.match(report,new RegExp('✗ 外部交付 第 3 步「飞书竞品表」'+result));
    assert.match(scan(dir).report,new RegExp('✗ 外部交付 第 3 步「飞书竞品表」'+result));
  });
});

test('A3-02 拒绝缩范围就保留交付；确认可在后续活动节',windows,async t=>{
  for (const [decision,want] of [
    ['不同意缩小采用范围，飞书竞品表必须交付。','待核'],
    ['同意缩小采用范围，飞书竞品表。','已排除本次'],
  ]) await t.test(want,()=>{
    const dir=deliveryProject();
    put(dir,index,read(dir,index).replace('## 已确认',delivery+'已排除本次｜稍后补证\n## 已确认\n- 另事已经确认\n## 已确认\n- '+decision+'\n'));
    const report=stationFive(dir);
    assert.match(report,new RegExp('外部交付 第 3 步「飞书竞品表」'+want),report);
    if(want==='待核') assert.equal(verdict(report),'不通过',report);
  });
  await t.test('单一确认节也不能把不同意读作同意',()=>{
    const dir=deliveryProject();
    put(dir,index,read(dir,index).replace('## 已确认',delivery+'已排除本次｜稍后补证\n## 已确认\n- 不同意缩小采用范围，飞书竞品表必须交付。'));
    assert.match(stationFive(dir),/✗ 外部交付 第 3 步「飞书竞品表」待核/);
  });
});

test('A3-03 当批只交外部回执时整步保持未核',windows,()=>{
  const dir=deliveryProject();
  put(dir,index,read(dir,index).replace('## 已确认',delivery+'已读回｜docs\\check\\回读.txt\n## 已确认'));
  put(dir,receipt,receiptText);
  const got=scan(dir), step=mapData(mapPage(got.dest)).find(s=>s.num===3);
  assert.match(got.report,/✓ 外部交付 第 3 步「飞书竞品表」本地回执已核/);
  assert.ok(step.facts.some(f=>f.title==='本地回执已核'));
  assert.notEqual(step.state,'green');
});

test('A3-04 运行表里的平台记忆不进入诊断文字、图和复制指令',windows,()=>{
  const {dir,rows}=fixture('私有路径');
  const secret='只留元数据 隐名.md', filename='.WorkBuddy/MeMoRy/一层/二层/'+secret;
  put(dir,filename,'不读取这句合成私有正文');
  rows[1][2]=first+'、'+filename;
  rows[1][3]='采集当批：依据：'+filename.replaceAll('/','\\');
  rows[1][5]='核对本批｜看来源｜来自 '+filename;
  flowFile(dir,rows);
  const got=scan(dir), html=mapPage(got.dest);
  const step=mapData(html).find(s=>s.num===2);
  for (const text of [got.report,html,step.command]) {
    assert.doesNotMatch(text,/隐名|不读取这句合成私有正文/i);
    assert.match(text,/\[平台记忆路径已隐藏\]/);
  }
  assert.equal(step.state,'red');
  assert.ok(step.facts.some(f=>f.state==='red'&&/平台记忆/.test(f.actual+' '+f.title)));
  const own=JSON.parse(read(got.dest,snapshot)).entries.find(e=>e.path.endsWith(secret));
  assert.deepEqual(Object.keys(own).sort(),['bytes','mtimeMs','path']);
});

async function checkStaleArchify(t,from) {
  for (const mode of ['旧源矛盾','可信源而旧网页落后','无图源不知道从哪来']) await t.test(mode,()=>{
    const dir=archifyFixture(from), original=fs.readFileSync(path.join(dir,projectMap));
    const backup='docs/check/历史/run-flow-'+sha(original)+'.html';
    const past='算铜均价环比', current='铜价核算';
    put(dir,runTable,read(dir,runTable).replace(past,current));
    if (mode==='可信源而旧网页落后') put(dir,sourceMap,read(dir,sourceMap).replaceAll(past,current));
    if (mode==='无图源不知道从哪来') fs.unlinkSync(path.join(dir,sourceMap));
    const other=exists(dir,sourceMap)?read(dir,sourceMap):null;
    const detail=runFlow(dir,'--upgrade-map');
    if (mode==='可信源而旧网页落后') {
      assert.equal(verdict(detail),'通过',detail);
      assert.match(detail,/旧图落后|旧图滞后/);
      assert.deepEqual(fs.readFileSync(path.join(dir,backup)),original);
      assert.notDeepEqual(fs.readFileSync(path.join(dir,projectMap)),original);
    } else {
      assert.equal(verdict(detail),'不通过',detail);
      assert.match(detail,mode==='旧源矛盾'?/图源与当前运行表不一致.*第 2 步|图源与当前运行表不一致.*a2/:/保留原件/);
      assert.equal(exists(dir,backup),false);
      assert.deepEqual(fs.readFileSync(path.join(dir,projectMap)),original);
    }
    assert.equal(exists(dir,sourceMap)?read(dir,sourceMap):null,other);
  });
}

test('A3-05 升级时先用现表核 Archify 图源',windows,t=>checkStaleArchify(t));

test('A3-06 暂存清理失败可回滚，同源孤儿可重试',windows,async t=>{
  const {dir}=fixture('初诊中断'), probe=fresh('暂存故障'), preload=path.join(probe,'fault.cjs');
  put(probe,'fault.cjs',[
    "const fs=require('node:fs'); const unlink=fs.unlinkSync; let fired=false;",
    "fs.unlinkSync=function(p,...args){",
    "if(!fired && /snapshot\\.json\\.\\d+\\.tmp$/.test(p)){fired=true; throw Object.assign(new Error('注入暂存清理失败'),{code:'EBUSY'});}",
    "return unlink.call(this,p,...args);};",
  ].join('\n'));
  await t.test('落盘后第一次清理失败仍回滚',()=>{
    const dest=fresh('初诊失败'), r=tool('scan',dest,[dir],{preload});
    assert.equal(r.status,1,r.stdout+r.stderr);
    assert.match(r.stderr,/注入暂存清理失败/);
    assert.deepEqual(files(dest),[]);
    assert.deepEqual(files(scan(dir,dest).dest),[scanMap,scanText,snapshot].sort());
  });
  await t.test('同源无锁孤儿以本次完整报告覆盖',()=>{
    const dest=fresh('待恢复'), old=scan(dir).dest;
    for (const rel of [snapshot,scanMap]) put(dest,rel,read(old,rel));
    put(dir,'work/重试新材料.txt','只属于成功的这一轮');
    const recovered=scan(dir,dest);
    assert.deepEqual(files(dest),[scanMap,scanText,snapshot].sort());
    assert.match(read(dest,snapshot),/重试新材料/);
    for (const [label,rel] of [['本轮快照',snapshot],['外置诊断图',scanMap]])
      assert.ok(recovered.report.includes(label+' SHA-256：'+sha(read(dest,rel))));
  });
  await t.test('异源、坏格式、未知网页及他人锁都不覆盖',()=>{
    const own=scan(dir).dest, alien=scan(fresh('异源')).dest;
    for (const [rel,bytes] of [[snapshot,read(alien,snapshot)],[snapshot,'坏 JSON'],
      [scanMap,'<title>手稿</title>'],['docs/check/scan.lock','他人的锁']]) {
      const dest=fresh('不可恢复');
      put(dest,snapshot,read(own,snapshot)); put(dest,rel,bytes);
      const before=fingerprint(dest), r=tool('scan',dest,[dir]);
      assert.equal(r.status,1,r.stdout+r.stderr);
      assert.deepEqual(fingerprint(dest),before);
    }
  });
});

test('A3-07 缺浏览器或真实夹具时测试入口按模式失败或明示跳过',windows,async t=>{
  const env={...process.env};
  // A child runner needs TAP rather than the parent node:test IPC protocol.
  delete env.NODE_TEST_CONTEXT;
  for (const variable of ['CI','AGENT_COACH_TEST_RELEASE','AGENT_COACH_DIAG_EVIDENCE','AGENT_COACH_TEST_PLAYWRIGHT',
    'AGENT_COACH_TEST_ARCHIFY_DOCS','AGENT_COACH_TEST_V121_ZIP']) delete env[variable];
  const diagnostics=path.join(repo,'tests/diagnostics-v210.test.mjs'), rescue=path.join(repo,'tests/rescue-v200.test.mjs');
  const release=path.join(repo,'releases/v2.1.0'), evidence=fresh('仅设置证据门');
  for (const [script,needle] of [[diagnostics,'T15 双页离线'],[rescue,'13.58.2 离线双主题']]) {
    for (const [key,value] of [['AGENT_COACH_TEST_RELEASE',release],['CI','true'],['AGENT_COACH_DIAG_EVIDENCE',evidence],['','']]) {
      await t.test(path.basename(script)+' '+(key||'本地'),()=>{
        const r=run('--test',['--test-reporter=tap','--test-name-pattern='+needle,script],
          {env:key?{...env,[key]:value}:env});
        assert.equal(r.status,key?1:0,r.stdout+r.stderr);
        assert.match(r.stdout,key?/AGENT_COACH_TEST_PLAYWRIGHT/:/# SKIP 未设置 AGENT_COACH_TEST_PLAYWRIGHT/);
      });
    }
  }
  for (const [script,needle,name] of [[diagnostics,'本机历史实物 · Archify','AGENT_COACH_TEST_ARCHIFY_DOCS'],
    [rescue,'本机历史实物 · v1.21','AGENT_COACH_TEST_V121_ZIP']]) {
    for (const [label,settings] of [['缺路径',{AGENT_COACH_DIAG_EVIDENCE:evidence}],['缺件',{[name]:path.join(evidence,'不存在')}]]) {
      await t.test(name+' '+label,()=>{
        const r=run('--test',['--test-reporter=tap','--test-name-pattern='+needle,script],{env:{...env,...settings}});
        assert.equal(r.status,1,r.stdout+r.stderr);
        assert.match(r.stdout,new RegExp(name),r.stdout);
      });
    }
  }
});

test('A3-08 活动下一步必须唯一并清点每节的外部交付',windows,async t=>{
  for (const extra of ['换对话时说：调用教练继续',delivery+'待核｜未接']) await t.test(extra,()=>{
    const dir=deliveryProject();
    put(dir,index,read(dir,index)+'\n## 下一步\n'+extra+'\n');
    const report=stationFive(dir), diag=scan(dir).report;
    assert.equal(verdict(report),'不通过',report);
    for (const body of [report,diag]) {
      assert.match(body,/✗ 内容④.*下一步.*唯一/);
      assert.doesNotMatch(body,/✓ 内容④/);
      if(extra.startsWith(delivery)) assert.match(body,/✗ 外部交付 第 3 步「飞书竞品表」待核/);
    }
  });
});

function batchAcceptance(text, batch='Café') {
  const {dir,rows}=fixture('批次识别',{param:batch});
  const target='work\\01-结果.html', bad='work\\01-坏输入\\结果.txt';
  rows[0][4]=target; rows[1][2]=target;
  flowFile(dir,rows,{param:batch});
  put(dir,runTable,read(dir,runTable).replaceAll('报告日','客户代号'));
  put(dir,target,text); put(dir,bad,'已拦截');
  writeTicket(dir,rows[0],{acceptance:['## 验收单（第 1 版）','- 预期值来源：样例清点确认：输入金额 12','### AI 自检',
    '#### 固定基线断言（绑定参数：2026-11-24）','- '+target+' 含 999',
    '#### 当期守恒断言（每次必核）','- '+target+' 含 金额：12','- '+bad+' 含 已拦截',
    '## 确认记录','- 第 1 次确认（第 1 版）：2026-11-24｜就这样跑','## 结果','### 第 1 轮｜按第 1 次确认（第 1 版）',
    '固定基线：代码未变未跑']});
  const r=tool('accept',dir,['01']);
  assert.equal(r.status,0,r.stderr);
  return read(dir,'docs/check/accept.txt');
}

test('A3-09 隐式正文里的 HTML 元标记没有头部证明力',windows,async t=>{
  const head='<!doctype html><title>手写页</title>';
  await t.test('手写生成器字样',()=>{
    const dir=fresh('隐式正文'), file='日报.html';
    const handWritten=head+'<main><meta name="coach-generator" content="eli5-report/1">手工内容</main>';
    put(dir,file,handWritten);
    const r=verifyPage(dir);
    assert.equal(r.status,0,r.stdout+r.stderr);
    assert.match(r.stdout,/跳过：非本生成器网页/);
    assert.equal(read(dir,file),handWritten);
  });
  await t.test('手写批次字样',()=>{
    const r=batchAcceptance(head+'<main><meta name="coach-batch" content="参数｜客户代号：Café">金额：12</main>');
    assert.equal(verdict(r),'不通过',r);
    assert.match(r,/批次|参数/);
  });
});

test('A3-10 标准命名实体、数字实体及原字符表示同一批',windows,async t=>{
  for(const value of ['Café','Caf&#233;','Caf&#xe9;','Caf&eacute;']) await t.test(value,()=>{
    const r=batchAcceptance('<!doctype html><title>真实头部</title><meta name="coach-batch" content="参数｜客户代号：'+value+'"><main>金额：12</main>');
    assert.equal(verdict(r),'通过',r);
  });
  const wrongCase=batchAcceptance('<head><meta name="coach-batch" content="参数｜客户代号：Caf&Eacute;"></head>金额：12');
  assert.equal(verdict(wrongCase),'不通过',wrongCase);
  assert.match(wrongCase,/实见 CafÉ/);
});

test('A3-11 / R2-09 实物目录枚举最多读 20001 项且关闭句柄',windows,()=>{
  const dir=fresh('枚举实物'), probe=fresh('枚举次数'), log=path.join(probe,'次数.json');
  for(let i=0;i<20001;i++) put(dir,'枚举'+String(i).padStart(5,'0')+'.tmp','');
  put(probe,'enumerate.cjs',[
    "const fs=require('node:fs'), path=require('node:path');",
    "const dir=path.resolve(process.env.A3_ENUM_SOURCE), count={readdirCalls:0,readdirEntries:0,opens:0,reads:0,closes:0};",
    "const readdir=fs.readdirSync, open=fs.opendirSync;",
    "fs.readdirSync=function(name,opts){const got=readdir.call(this,name,opts);if(path.resolve(name)===dir){count.readdirCalls++;count.readdirEntries+=got.length;}return got;};",
    "fs.opendirSync=function(name,...args){const got=open.call(this,name,...args);if(path.resolve(name)!==dir)return got;count.opens++;",
    "const read=got.readSync, close=got.closeSync;",
    "got.readSync=function(){count.reads++;return read.call(this);};",
    "got.closeSync=function(){count.closes++;return close.call(this);};return got;};",
    "process.on('exit',()=>fs.writeFileSync(process.env.A3_ENUM_LOG,JSON.stringify(count)));",
  ].join('\n'));
  for (const hasTable of [false,true]) {
    if (hasTable) put(dir,runTable,read(fixture('枚举运行表').dir,runTable));
    const result=scan(dir,fresh('稍后报告'),{preload:path.join(probe,'enumerate.cjs'),env:{...process.env,A3_ENUM_SOURCE:dir,A3_ENUM_LOG:log}});
    assert.match(result.report,/枚举超过 20000 项/);
    const counts=JSON.parse(fs.readFileSync(log));
    console.log('项目根枚举',hasTable?'含运行表':'仅散件',counts);
    assert.deepEqual(counts,{readdirCalls:0,readdirEntries:0,opens:1,reads:20001,closes:1});
    if (!hasTable) assert.equal(JSON.parse(read(result.dest,snapshot)).entries.length,0);
  }
});

test('A3-15 / R2-07 三泳道的业务节点也要与运行表同名并可升级',windows,t=>{
  const dir=archifyFixture(), source=JSON.parse(read(dir,sourceMap));
  source.lanes=source.lanes.filter(l=>l.id!=='prog');
  for (const n of source.nodes) if (n.lane==='prog') n.lane='ai';
  const attr=(key,value)=>' '+key+'="'+String(value??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;')+'"';
  function writeArchify() {
    put(dir,sourceMap,JSON.stringify(source));
    put(dir,projectMap,'<svg>'+source.nodes.map(n=>'<g'+attr('id','node-'+n.id)+attr('data-node-id',n.id)+attr('data-node-label',n.label)+
      attr('data-node-sublabel',n.sublabel)+attr('data-node-kind',n.type)+
      attr('data-node-context',source.lanes.find(l=>l.id===n.lane).label+' › '+source.phases[n.col].label)+'></g>').join('')+
      source.edges.map(e=>'<path'+attr('data-edge-id',e.id)+attr('data-edge-from',e.from)+attr('data-edge-to',e.to)+
        attr('data-edge-label',e.label)+attr('class',e.variant==='dashed'?'a-dashed':'')+'/>').join('')+
      Object.entries(source.meta.legend.entries).map(([k,v])=>'<g'+attr('data-legend-kind',k)+attr('data-legend-label',v.label)+'></g>').join('')+'</svg>');
  }
  writeArchify();
  assert.match(scan(dir).report,/✓ 图源与运行表一致：3 步/);
  source.nodes.find(n=>n.id==='a2').label='核对库存';
  writeArchify();
  const report=scan(dir).report;
  assert.match(report,/✓ 图和图源一致/);
  assert.match(report,/图已过期，第 2 步/);
  assert.doesNotMatch(report,/✓ 图源与运行表一致/);
  assert.equal(verdict(runFlow(dir,'--upgrade-map')),'不通过');
  source.nodes.find(n=>n.id==='a2').label=source.phases[2].label.replace(/^第2步\s*/,'');
  writeArchify();
  const original=read(dir,projectMap), detail=runFlow(dir,'--upgrade-map');
  assert.equal(verdict(detail),'通过',detail);
  assert.equal(read(dir,'docs/check/历史/run-flow-'+sha(original)+'.html'),original);
});

test('T01 正式件名、换行、说明和新项目创建版本',windows,async t => {
  await t.test('首行及创建版本有本版日期', () => {
    const dir=fresh('版本'), r=tool('init',dir);
    assert.equal(r.status,0,r.stderr);
    assert.match(read(dir,index), /搭建教练版本：v2\.1\.0/);
    assert.match(read(product,'AGENTS.md').split('\n')[0],/v2\.1\.0 \(2026-11-25\)/);
  });
  await t.test('精确 27 件与 README 下载', () => {
    if (process.env.COACH_PRODUCT && process.env.COACH_PRODUCT !== repo) assert.deepEqual(files(product),approvedMembers);
    assert.match(read(product,'README.md'),/releases\/v2\.1\.0\/agent-coach-v2\.1\.0-20261125\.zip/);
  });
  await t.test('纯 CRLF 检查器及第 5 站第 19 行坏路径', () => {
    assert.doesNotMatch(read(product,'工具/coach-check.mjs').replaceAll('\r\n',''),/[\r\n]/);
    const line = read(product,'做法/5-收尾交接.md').split('\n')[18];
    assert.doesNotMatch(line,/\r/);
    assert.ok(line.includes('docs\\run-flow.html') && line.includes('docs\\check\\run-flow.txt'),line);
  });
});

test('T02 不同身份只读出图、无图及损坏表',windows,async t => {
  for (const [name,station] of [['构建中','4 一步一票'],['已采用','已结束（采用）'],['已停止','已结束（停止）'],['外部项目',null]]) {
    await t.test(name,() => {
      const {dir} = fixture(name, {station});
      if (!station) fs.unlinkSync(path.join(dir,index));
      const before = fingerprint(dir);
      const a = scan(dir), b = scan(dir);
      assert.deepEqual(fingerprint(dir),before);
      assert.deepEqual(files(a.dest),[scanMap,scanText,snapshot].sort());
      assert.match(a.report,/scan-map\.html/);
      assert.equal(mapPage(a.dest),mapPage(b.dest));
    });
  }
  await t.test('无表仅快照与文本',() => {
    const got = scan(fresh('空白'));
    assert.deepEqual(files(got.dest),[scanText,snapshot].sort());
  });
  await t.test('损坏表仍有待核入口',() => {
    const dir = fresh('坏表');
    put(dir,runTable,Buffer.from([255,0,255]));
    assert.match(mapPage(scan(dir).dest),/运行表待核/);
  });
  await t.test('真实旧图外置体检保全原件',() => {
    const dir=archifyFixture(), before=fingerprint(dir), scanned=scan(dir);
    assert.deepEqual(fingerprint(dir),before);
    assert.match(scanned.report,/图和图源一致/);
    mapPage(scanned.dest);
  });
});

test('T03 流程断点、票差、过期图和外部承诺独立可见',windows,async t => {
  const {dir,oldMap} = prepareCard(), got = scan(dir);
  assert.deepEqual(fingerprint(dir)[projectMap],oldMap);
  await t.test('原检查器仍执行并发现断边及票差',() => {
    assert.match(got.report,/第 3 步.*未交接/);
    assert.match(got.report,/票 03.*另一个清单/);
  });
  await t.test('另查了旧图及回读待核',() => {
    assert.match(got.report,/图已过期/);
    assert.match(got.report,/飞书竞品表.*待核|待核.*飞书竞品表/);
    const html = mapPage(got.dest);
    for (const phrase of ['断在这里','读写不符','图已过期','交付待核']) assert.ok(html.includes(phrase),phrase);
  });
  await t.test('读回要核真实批次和人工列',() => {
    const receipt='docs/check/回读.txt';
    put(dir,index,read(dir,index).replace('## 已确认','- 外部交付｜第3步｜飞书竞品表｜标题｜2026-11-25｜单次｜已读回｜docs\\check\\回读.txt\n## 已确认'));
    const verified=['工作表：飞书竞品表','批次：2026-11-25','允许列：标题','结果：通过','执行时间：2026-11-25 09:00',
      '写前：2 行','本次新增：1 行','写后：3 行','实见业务键：甲','人工列：前后一致（人工内容甲）','授权：可以写标题，仅本批单次'].join('\n');
    for (const [contents, status] of [
      ['模拟读回：飞书竞品表，2026-11-25，标题，实见 0 行','待核'],
      [verified.replace('批次：2026-11-25','批次：2026-11-24'),'待核'],
      [verified,'本地回执已核'],
      ['工作表：飞书竞品表\n批次：2026-11-25\n结果：失败\n回读：业务键缺失','失败'],
    ]) {
      put(dir,receipt,contents);
      const report=scan(dir).report;
      assert.ok(report.split('\n').some(l=>l.includes('飞书竞品表')&&l.includes(status)),report);
    }
  });
});

test('T04 局部断边不吞内置图及真实旧图的可判差异',windows,async t => {
  for (const real of [false,true]) await t.test(real?'旧图和源一致仍看现表':'内置图多处差异',t => {
    const dir = real ? archifyFixture() : prepareCard().dir;
    if (real) {
      const lines=read(dir,runTable).split('\n');
      const rows=lines.map((l,i)=>[/^\|\s*[123]\s*\|/.test(l),i]).filter(([hit])=>hit).map(([,i])=>i);
      const cells=lines[rows[1]].split('|');
      cells[3] += '、work\\无来源.txt';
      cells[4] = '改过短名：依据：小样';
      lines[rows[1]]=cells.join('|');
      put(dir,runTable,lines.join('\n'));
    }
    const before = fingerprint(dir)[projectMap], r = scan(dir);
    assert.match(r.report,/图已过期/);
    assert.doesNotMatch(r.report,/接不上的步，图源不比/);
    assert.match(r.report,/短名|去重填表|改过短名/);
    if (!real) assert.match(r.report,/退回|人工关口/);
    assert.equal(verdict(runFlow(dir)),'不通过');
    assert.deepEqual(fingerprint(dir)[projectMap],before);
  });
});

test('T05 每步都有带证据和权限边界的项目 AI 指令',windows,() => {
  const {dir} = prepareCard(), {dest} = scan(dir);
  const html = mapPage(dest);
  for (const expected of ['复制给项目 AI','本批：','实际：','验收：','未通过：禁止报修好/已通过','人工列','单次或长期','docs\\run-flow.md','未交接']) {
    assert.ok(html.includes(expected) || html.includes(expected.replaceAll('\\','\\\\')),expected);
  }
  assert.match(html,/第 ?3 ?步/);
  assert.doesNotMatch(html,/\{步号\}|\{症状\}/);
});

if (process.env.AGENT_COACH_TEST_ARCHIFY_DOCS || process.env.AGENT_COACH_DIAG_EVIDENCE) {
  test('本机历史实物 · Archify 原始网页、现表冲突与损坏保护',windows,async t=>{
    const from=process.env.AGENT_COACH_TEST_ARCHIFY_DOCS;
    assert.ok(from && fs.existsSync(path.join(from,'run-flow.html')),'缺 AGENT_COACH_TEST_ARCHIFY_DOCS 原件');
    const dir=archifyFixture(from), original=fs.readFileSync(path.join(dir,projectMap));
    assert.deepEqual([original.length,sha(original)],[759913,'12d3189d76bc6157348bc27b8d331b15aa2e4731c57f3c81d069a3429e3ad01f']);
    assert.match(scan(dir).report,/图和图源一致：7 框、12 线/);
    assert.equal(verdict(runFlow(dir,'--upgrade-map')),'通过');
    assert.deepEqual(fs.readFileSync(path.join(dir,'docs/check/历史/run-flow-'+sha(original)+'.html')),original);
    await checkStaleArchify(t,from);
    await checkBrokenArchify(t,from);
  });
}

test('T06 普通刷新保护旧图，明示升级才备份原字节',windows,async t => {
  await t.test('老行为控制和显式可复算升级',() => {
    const dir=archifyFixture(), old=fs.readFileSync(path.join(dir,projectMap)), other=fingerprint(dir)[sidecar];
    for(const flag of [undefined,'--refresh']) assert.equal(verdict(runFlow(dir,flag)),'通过');
    assert.deepEqual(fs.readFileSync(path.join(dir,projectMap)),old);
    const backup='docs/check/历史/run-flow-'+sha(old)+'.html';
    assert.equal(verdict(runFlow(dir,'--upgrade-map')),'通过');
    assert.deepEqual(fs.readFileSync(path.join(dir,backup)),old);
    assert.notDeepEqual(fs.readFileSync(path.join(dir,projectMap)),old);
    assert.equal(verdict(runFlow(dir,'--upgrade-map')),'通过');
    assert.deepEqual(fingerprint(dir)[sidecar],other);
    assert.equal(files(path.join(dir,'docs/check/历史')).length,1);
    assert.equal(verdict(runFlow(dir)),'通过');
  });
  for(const mode of ['同名冲突','手写图','另有交付锁','不画图','硬链接备份']) await t.test(mode,() => {
    const dir=archifyFixture(), original=fs.readFileSync(path.join(dir,projectMap));
    const backup=path.join(dir,'docs/check/历史/run-flow-'+sha(original)+'.html');
    if (mode==='同名冲突') put(dir,path.relative(dir,backup),'他人的文件');
    if (mode==='手写图') put(dir,projectMap,'<!doctype html><title>手稿</title>');
    if (mode==='另有交付锁') put(dir,'docs/run-flow.delivery-lock.json','他人的锁');
    if (mode==='不画图') put(dir,runTable,read(dir,runTable).replace(/^本轮图：出图$/m,'本轮图：不画图'));
    if (mode==='硬链接备份') {
      fs.mkdirSync(path.dirname(backup),{recursive:true});
      fs.linkSync(path.join(dir,projectMap),backup);
    }
    const before=fingerprint(dir)[projectMap];
    const r=tool('flow',dir,['--upgrade-map']);
    const detail = r.status===0 ? read(dir,'docs/check/flow.txt') : r.stderr;
    assert.match(detail,/备份|可信|交付|不画图|链接/,detail);
    assert.deepEqual(fingerprint(dir)[projectMap],before);
  });
});

test('T07 注释不当路径，真正读写不同仍报错',windows,async t => {
  for (const [name,from,to,expected] of [
    ['说明','work\\01-输入.txt（本批 / 计数、筛选 + 样例*）',captured+' (采集/去重说明)',/✓ 内容①/],
    ['混合承诺',first,captured+'（另写 output\\可选.csv）',/内容①.*待核/],
    ['真实差异',first,'output\\下一批.csv',/✗ 内容①.*票 02/],
    ['真正非法',first,'output\\..\\CON.txt（说明）',/✗ 内容①.*非法/],
  ]) await t.test(name,() => {
    const {dir,rows}=fixture();
    writeTicket(dir,rows[1],{from,to});
    const {report}=scan(dir);
    assert.match(report,expected,report);
  });
  await t.test('合法字面括号和加号保持真实文件名',() => {
    const {dir,rows}=fixture();
    rows[1][4]='work\\02-结果+(终稿).csv';
    rows[2][2]=rows[1][4];
    flowFile(dir,rows);
    put(dir,rows[1][4],'键,值\n甲,12\n');
    writeTicket(dir,rows[1]);
    assert.match(scan(dir).report,/✓ 内容①/);
    assert.equal(verdict(runFlow(dir)),'通过');
  });
});

test('T08 上游目录、同一步自读、未来产物和已声明批次目录',windows,async t => {
  for (const [name,from,produced,expected] of [
    ['合法前置采集',first,captured,'通过'],
    ['自产自读',captured,captured,'不通过'],
    ['未来产物',final,captured,'不通过'],
    ['批次目录',first,'output\\日报\\<报告日>\\','通过'],
    ['未知变量',first,'output\\日报\\<别的日期>\\','不通过'],
    ['非法值',first,'output\\日报\\<报告日>\\','不通过'],
  ]) await t.test(name,() => {
    const {dir,rows}=fixture();
    rows[1][2]=from; rows[1][4]=produced; rows[2][2]=produced;
    flowFile(dir,rows,{param:name==='非法值'?'CON':'2026-11-25'});
    const report=runFlow(dir);
    assert.equal(verdict(report),expected,report);
  });
});

test('T09 HTML 真实 head 批次和旧文本首行统一进验收',windows,async t => {
  for (const [name,ext,text,want] of [
    ['旧文本','txt','参数｜报告日：2026-11-25\n金额：12','通过'],
    ['合法 HTML','html','<!doctype html><html><head><META content=\'参数&#65372;报告日&#65306;2026-11-25\' NAME="coach-BATCH" /></head><body>金额：12</body></html>','通过'],
    ['错批 HTML','html','<head><meta name="coach-batch" content="参数｜报告日：2026-11-24"></head>金额：12','不通过'],
    ['重复 HTML','html','<head>'+('<meta name="coach-batch" content="参数｜报告日：2026-11-25">').repeat(2)+'</head>金额：12','不通过'],
    ['假标记','html','<head><!-- <meta name="coach-batch" content="参数｜报告日：2026-11-25"> --></head><body>金额：12</body>','不通过'],
  ]) await t.test(name,() => {
    const {dir,rows}=fixture();
    const target='work\\01-结果.'+ext, bad='work\\01-坏输入\\结果.txt';
    rows[0][4]=target; rows[1][2]=target;
    flowFile(dir,rows,{param:'2026-11-25'});
    put(dir,target,text); put(dir,bad,'已拦截');
    writeTicket(dir,rows[0],{acceptance:['## 验收单（第 1 版）','- 预期值来源：样例清点确认：输入金额 12','### AI 自检',
      '#### 固定基线断言（绑定参数：2026-11-24）','- '+target+' 含 999','#### 当期守恒断言（每次必核）',
      '- '+target+' 含 金额：12','- '+bad+' 含 已拦截','## 确认记录','- 第 1 次确认（第 1 版）：2026-11-24｜就这样跑',
      '## 结果','### 第 1 轮｜按第 1 次确认（第 1 版）','固定基线：代码未变未跑']});
    const rep=tool('accept',dir,['01']);
    assert.equal(rep.status,0,rep.stderr);
    const body=read(dir,'docs/check/accept.txt');
    if(process.env.AGENT_COACH_DIAG_RAW) fs.appendFileSync(process.env.AGENT_COACH_DIAG_RAW,'accept.txt:\n'+body);
    assert.equal(verdict(body),want,body);
    if (name==='合法 HTML') assert.match(body,/主产物参数 2026-11-25/);
    if (name==='重复 HTML') assert.match(body,/重复|冲突/,body);
    if (name==='假标记') assert.match(body,/批次|参数/,body);
  });
});

test('T10 初诊冻结，复诊只比较同集合初诊',windows,async t => {
  const dir=fresh('改前项目'), rounds=fresh('集合'), a=path.join(rounds,'初诊');
  put(dir,'work/改.txt','同长甲'); put(dir,'work/时间.txt','同内容'); put(dir,'work/删.txt','旧');
  put(dir,'.workbuddy/memory/私有.md','合成平台文本');
  const old=scan(dir,a);
  await t.test('快照结构、等长内容、增删和记忆元数据',() => {
    assert.ok(exists(old.dest,snapshot),'缺初诊快照');
    const before=read(a,snapshot), base=JSON.parse(before);
    assert.equal(base.schema,'coach-snapshot/1'); assert.equal(base.comparison,null);
    put(dir,'work/改.txt','同长乙'); put(dir,'work/新增.txt','新'); fs.unlinkSync(path.join(dir,'work/删.txt'));
    fs.utimesSync(path.join(dir,'work/时间.txt'),100,100);
    fs.utimesSync(path.join(dir,'.workbuddy/memory/私有.md'),100,100);
    for (const n of [1,2]) {
      const dest=scan(dir,path.join(rounds,'复诊-'+n)).dest, next=JSON.parse(read(dest,snapshot));
      assert.equal(next.comparison.status,'完整');
      const actual=Object.fromEntries(next.comparison.changes.map(c=>[c.path,c.kind]));
      assert.deepEqual(actual,{'work\\改.txt':'内容修改','work\\新增.txt':'新增','work\\删.txt':'删除','.workbuddy\\memory\\私有.md':'元数据变化'});
    }
    scan(dir,a);
    assert.equal(read(a,snapshot),before);
  });
  await t.test('无基线、异项目、篡改都不能声称零改',() => {
    const absent=scan(dir,path.join(fresh('无基线'),'复诊-1'));
    assert.match(absent.report,/改前快照未核/);
    const alien=scan(fresh('异项目'),path.join(rounds,'复诊-3'));
    assert.match(alien.report,/改前快照未核/);
    if (exists(a,snapshot)) {
      put(a,snapshot,read(a,snapshot)+' ');
      assert.match(scan(dir,path.join(rounds,'复诊-4')).report,/改前快照未核/);
    }
  });
});

test('T11 记忆正文零读取，普通文件同句仍引用，超限件不打开',windows,async t => {
  const dir=fresh('权限探针'), secret='这个合成记忆独有句子足够长且不该进入项目引用';
  put(dir,'.WorkBuddy/Memory/嵌套/只记录元数据.md',secret);
  const orig=path.join(dir,'.WorkBuddy/Memory/嵌套/只记录元数据.md');
  fs.linkSync(orig,path.join(dir,'硬链接.md'));
  const big=path.join(dir,'大采集.bin');
  fs.closeSync(fs.openSync(big,'w'));
  fs.truncateSync(big,16*1024*1024+1);
  const probe=fresh('探针路径'), log=path.join(probe,'reads.jsonl'), preload=path.join(probe,'io.cjs');
  put(probe,'io.cjs',[
    "const fs=require('node:fs'); const path=require('node:path');",
    "const original=fs.appendFileSync; const own=path.resolve(process.env.DIAG_PROBE_LOG).toLowerCase();",
    "for(const name of ['openSync','readFileSync','createReadStream']) { const f=fs[name]; fs[name]=function(p,...args) {",
    "if(typeof p==='string'&&path.resolve(p).toLowerCase()!==own&&/memory|大采集|硬链接/i.test(p)) original(own,JSON.stringify([name,p])+'\\n');",
    "return f.call(this,p,...args); }; }",
  ].join('\n'));
  const options={preload,env:{...process.env,DIAG_PROBE_LOG:log}};
  await t.test('quote 隔离完整扫描与普通来源',() => {
    const draft='这是草稿。\n'+secret;
    const first=tool('quote',dir,[],{...options,input:draft});
    assert.equal(first.status,0,first.stderr);
    assert.match(first.stdout,/引号外原文：0 处/);
    assert.match(first.stdout,/平台记忆未读取/);
    put(dir,'普通文件.md',secret);
    assert.match(tool('quote',dir,[],{...options,input:draft}).stdout,/普通文件\.md 第 1 行/);
    assert.notEqual(tool('quote',path.dirname(orig),[],{...options,input:draft}).status,0);
  });
  await t.test('scan 不打开超限件或记忆别名',() => {
    if (fs.existsSync(log)) fs.unlinkSync(log);
    const got=scan(dir,fresh('本轮报告'),options);
    assert.equal(fs.existsSync(log)?read(probe,'reads.jsonl'):'','');
    const body=JSON.parse(read(got.dest,snapshot));
    const privateEntry=body.entries.find(x=>x.path.endsWith('只记录元数据.md'));
    assert.deepEqual(Object.keys(privateEntry).sort(),['bytes','mtimeMs','path']);
    assert.doesNotMatch(got.report,/只记录元数据|合成记忆独有句子/);
    assert.ok(body.skipped.some(e=>e.path==='大采集.bin'));
  });
});

test('T12 四命令失败固定末三行并保留退出契约',windows,async t => {
  for (const [cmd,args,route] of [
    ['scan',[],'项目体检'],['files',['5'],'第 5 站'],['accept',['01'],'票 01'],['flow',[],'排表画图'],
  ]) await t.test(cmd,() => {
    const p=fresh('业务失败'), report=fresh('报告'), base=cmd==='scan'?report:p;
    if (cmd==='scan') put(p,'AGENTS.md','读 C:\\另一个项目\\原件.md\n');
    const validArgs=cmd==='scan'?[p]:args;
    const r=tool(cmd,base,validArgs);
    assert.equal(r.status,0,r.stderr);
    assert.equal(verdict(read(base,'docs/check/'+cmd+'.txt')),'不通过');
    const tail=r.stdout.trimEnd().split(/\r?\n/).slice(-3);
    assert.equal(tail[2],nextLine);
    assert.match(tail[0],/📍 当前进度/); assert.ok(tail[0].includes(route),tail[0]);
    assert.match(tail[1],/👉 你现在只需要回/);
    assert.equal(r.stdout.split(nextLine).length,2);
    const wrong=tool(cmd,'相对路径',validArgs);
    assert.notEqual(wrong.status,0);
    assert.match(wrong.stderr,/没跑成/);
    assert.equal(wrong.stdout.trimEnd().split(/\r?\n/).at(-1),nextLine);
    assert.match(wrong.stdout,/项目检查/);
  });
});

test('T13 只复制生成器即可离线复现，坏请求保护已有网页',windows,async t => {
  await t.test('复制进学员工程可从任意位置运行',() => {
    requireRenderer();
    const dir=fresh('独立项目'), copied=path.join(dir,'scripts/eli5-report.mjs');
    put(dir,'scripts/eli5-report.mjs',fs.readFileSync(renderer));
    put(dir,'当批.json',JSON.stringify(reportDefinition));
    for (const [i,cwd] of [temp,dir].entries()) {
      const r=run(copied,[path.join(dir,'当批.json'),path.join(dir,'交付'+i+'.html')],{cwd});
      assert.equal(r.status,0,r.stdout+r.stderr);
    }
    assert.equal(read(dir,'交付0.html'),read(dir,'交付1.html'));
    assert.match(read(dir,'交付0.html'),/<meta name="coach-batch" content="参数｜报告日：2026-11-25">/);
    assert.match(run(copied,['--check',path.join(dir,'交付0.html')]).stdout,/通过：ELI5 业务网页/);
  });
  await t.test('坏输入及危险覆盖保留原件',() => {
    requireRenderer();
    const dir=fresh('文件保护');
    assert.equal(generate(dir).status,0);
    const before=read(dir,'日报.html');
    const raw=JSON.stringify(reportDefinition);
    for (const data of ['{',raw.replace('"batch":','"date":"2026-11-24","batch":'),
      {...reportDefinition,date:'2026-02-30'},{...reportDefinition,items:'非数组'},
      {...reportDefinition,unapproved:true},' '.repeat(1024*1024+1)]) {
      assert.notEqual(generate(dir,data).status,0);
      assert.equal(read(dir,'日报.html'),before);
    }
    put(dir,'手工.html','<html><title>手工旧页</title></html>');
    assert.notEqual(generate(dir,reportDefinition,'手工.html').status,0);
    assert.match(read(dir,'手工.html'),/手工旧页/);
    fs.linkSync(path.join(dir,'日报.html'),path.join(dir,'副本.html'));
    assert.notEqual(generate(dir,reportDefinition,'副本.html').status,0);
  });
});

test('T14 真标记静检、缺数及惰性文字',windows,async t => {
  await t.test('旧页现物不可充作 A1',() => {
    const dir=fresh('旧业务页');
    put(dir,'日报.html','<!doctype html><head><title>旧日报</title></head><body>手工旧页</body>');
    assert.match(verifyPage(dir).stdout,/跳过：非本生成器网页/);
  });
  await t.test('显示待核、保留 0、转义和改动拒绝',() => {
    requireRenderer();
    const dir=fresh('转义'), data=structuredClone(reportDefinition);
    data.title='方案 & <示例> "双引" \'单引\'\n下一行';
    data.items[2].label='待核 & <标签>';
    assert.equal(generate(dir,data).status,0);
    const html=read(dir,'日报.html');
    assert.match(html,/&amp; &lt;示例&gt; &quot;双引&quot; &#39;单引&#39;/);
    assert.doesNotMatch(html,/<示例>|<标签>/);
    assert.match(html,/待核/);
    assert.equal(verifyPage(dir).status,0);
    for(const edited of [html.replace('eli5-report/1','eli5-report/99'),html.replace('2026-11-25','2026-11-26'),
      html.replace('</svg>',''),html.replace('id="eli5-data"','id="另一个岛"')]) {
      put(dir,'日报.html',edited);
      const verified=verifyPage(dir);
      assert.equal(verified.status,1,verified.stdout+verified.stderr);
      assert.match(verified.stdout,/未通过：ELI5 业务网页/);
    }
    assert.equal(generate(dir,{...data,items:[],stats:[]},'空批.html').status,0);
    assert.match(read(dir,'空批.html'),/本批没有逐项记录/);
  });
});

const scanGeometry = (svg, allEdges = false) => svg.evaluate((scene, allEdges) => {
  const narrow=scene.classList.contains('narrow'), bounds=scene.getBoundingClientRect();
  const nodes=[...scene.querySelectorAll('[data-node]')];
  const cards=new Map(nodes.map(n=>[n.dataset.node,n.getBoundingClientRect()]));
  const overlap=(a,b)=>a.left<b.right&&b.left<a.right&&a.top<b.bottom&&b.top<a.bottom;
  const inside=(p,r)=>p.x>r.left&&p.x<r.right&&p.y>r.top&&p.y<r.bottom;
  const sample=(path,inset=0)=>{
    const last=path.getTotalLength()-inset, matrix=path.getScreenCTM();
    const segments=Math.ceil((last-inset)/2);
    if(segments<1) return [];
    return Array.from({length:segments+1},(_,i)=>
      path.getPointAtLength(inset+(last-inset)*i/segments).matrixTransform(matrix));
  };
  const edges=[...scene.querySelectorAll('[data-edge]')].map(path=>({
    path, from:path.dataset.from, to:path.dataset.to, points:sample(path),
    text:path.nextElementSibling.getBoundingClientRect(),
    name:path.classList[1]+' '+path.dataset.from+'→'+path.dataset.to,
  }));
  const broken=edges.filter(e=>e.path.matches('.broken'));
  const back=edges.filter(e=>e.path.matches('.back'));
  const positive=edges.filter(e=>e.path.matches('.read,.deliver'));
  const vertical=narrow?positive.filter(e=>e.points[0].x===e.points.at(-1).x):[];
  const spanning=narrow?[]:positive.filter(e=>
    cards.get(e.from).top===cards.get(e.to).top&&Math.abs(cards.get(e.from).left-cards.get(e.to).left)>300);
  const throughCards=routes=>routes.flatMap(e=>{
    const points=sample(e.path,8);
    return [...cards].filter(([id,box])=>id!==e.from&&id!==e.to&&points.some(p=>inside(p,box)))
      .map(([id])=>e.name+' / 步 '+id);
  });
  const errors=[];
  for(const [i,e] of edges.entries()){
    if([...cards.values()].some(box=>overlap(e.text,box))) errors.push(e.name+' 标签压卡');
    for(const other of edges.slice(i+1)) if(overlap(e.text,other.text)) errors.push(e.name+' 标签压 '+other.name);
    if(e.text.left<bounds.left||e.text.right>bounds.right||e.text.top<bounds.top||e.text.bottom>bounds.bottom)
      errors.push(e.name+' 标签出界');
  }
  for(const e of vertical) if(e.text.left<=e.points[0].x) errors.push(e.name+' 标签压竖箭');
  if(allEdges) errors.push(...throughCards(edges).map(e=>e+' 线路穿卡'));
  if(!narrow) {
    if(!allEdges) errors.push(...throughCards([...back,...spanning]).map(e=>e+' 线路穿卡'));
    for(const e of broken) for(const other of edges) {
      if(e===other) continue;
      if(e.points.some(p=>inside(p,other.text)||other.points.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<3))||
        other.points.some(p=>inside(p,e.text))) errors.push(e.name+' 断边或字碰 '+other.name);
    }
  }
  const border=getComputedStyle(scene.querySelector('.dot')).fill;
  const states=nodes.filter(n=>n.matches('.red,.yellow,.green')).map(n=>{
    const hit=getComputedStyle(n.querySelector('.hit'));
    if(hit.stroke===border||hit.stroke!==hit.color) errors.push('步 '+n.dataset.node+' 缺语义边框');
    return {id:n.dataset.node,stroke:hit.stroke};
  });
  const panel=document.querySelector('[data-panel]:not([hidden])');
  return {errors,broken:broken.length,back:back.length,vertical:vertical.length,spanning:spanning.length,
    selected:panel?.dataset.panel,copy:panel?.querySelector('[data-copy]').dataset.copy,states};
}, allEdges);

test('T15 双页离线四档真实互动、复制和截图',windows,async t => {
  const browserPath=requireFixture(t,'AGENT_COACH_TEST_PLAYWRIGHT');
  if (!browserPath) return;
  const {dir}=prepareCard(), got=scan(dir), home=fresh('业务页');
  const rendered=generate(home);
  await t.test('两个独立产品入口生成真实页面',() => {
    mapPage(got.dest);
    assert.equal(rendered.status,0,rendered.stdout+rendered.stderr);
  });
  if (!exists(got.dest,scanMap) || rendered.status!==0) return;
  const {chromium}=await import(pathToFileURL(browserPath).href);
  const browser=await chromium.launch({executablePath:chromium.executablePath(),headless:true});
  t.after(()=>browser.close());
  t.diagnostic('Chromium '+browser.version());
  const evidence=process.env.AGENT_COACH_DIAG_EVIDENCE || path.join(temp,'网页证据');
  fs.mkdirSync(evidence,{recursive:true});
  const entries=[];
  for (const [kind,file,change,copy] of [
    ['scan-map',path.join(got.dest,scanMap),'本次卡点','复制给项目 AI'],
    ['eli5-report',path.join(home,'日报.html'),'异常','复制给 AI'],
  ]) {
    fs.copyFileSync(file,path.join(evidence,kind+'-样本.html'));
    for (const width of [728,390]) for (const theme of ['light','dark']) {
      const name=kind+'-'+width+'-'+theme;
      await t.test(name,async () => {
        const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,offline:true,serviceWorkers:'block'});
        try {
          const page=await context.newPage(), remote=[], errors=[];
          page.setDefaultTimeout(5000);
          await context.route(/^https?:\/\//,route=>{remote.push(route.request().url());return route.abort();});
          page.on('websocket',ws=>remote.push(ws.url()));
          page.on('pageerror',e=>errors.push(e.message));
          page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
          const granted=theme==='light';
          if(granted) await context.grantPermissions(['clipboard-read','clipboard-write']);
          else await context.addInitScript(()=>{
            Object.defineProperty(navigator,'clipboard',{value:{writeText(){
              return Promise.reject(new DOMException('拒绝','NotAllowedError'));
            }}});
          });
          await page.goto(pathToFileURL(file).href);
          const picture=async()=>page.evaluate(()=>{
            const region=document.querySelector('[data-visual]');
            const svg=[...region.querySelectorAll('svg')].find(x=>x.getBoundingClientRect().width);
            const scene=svg.getBoundingClientRect();
            const detail=[...document.querySelectorAll('.detail')].filter(n=>!n.hidden).reduce((h,n)=>h+n.clientHeight-
              [...n.querySelectorAll('details')].reduce((d,a)=>d+a.offsetHeight,0),0);
            const cards=[...svg.querySelectorAll('[data-node]')].map(n=>n.getBoundingClientRect());
            const overlaps=cards.some((a,i)=>cards.slice(i+1).some(b=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top));
            return {width:document.documentElement.clientWidth, scroll:document.documentElement.scrollWidth,
              share:scene.height/(scene.height+detail), overlaps, nodes:[...svg.querySelectorAll('[data-node]')].map(x=>x.className.baseVal),
              edges:[...svg.querySelectorAll('[data-edge]')].map(x=>x.className.baseVal),
              count:document.querySelector('[data-visible-count]').textContent};
          });
          const before=await picture();
          assert.ok(before.share>=.7 && !before.overlaps,JSON.stringify(before));
          const actualSvg=page.locator('[data-visual] svg').filter({visible:true});
          let geometry;
          if(kind==='scan-map') {
            geometry=await scanGeometry(actualSvg);
            assert.equal(await page.locator('[data-visual]').getAttribute('data-mode'),'normal');
            assert.deepEqual({errors:geometry.errors,panel:geometry.selected,copy:geometry.copy},
              {errors:[],panel:'2',copy:'2'});
            assert.deepEqual([geometry.broken,geometry.back,geometry.vertical],[1,1,width===390?5:0]);
            assert.deepEqual(geometry.states.map(n=>n.id),['2','3']);
          }
          const initialSvg=await actualSvg.screenshot();
          assert.ok(before.scroll<=before.width,JSON.stringify(before));
          const initial=await page.screenshot({fullPage:true,path:path.join(evidence,name+'-前.png')});
          await page.getByRole('button',{name:change,exact:true}).click();
          const after=await picture();
          assert.notDeepEqual(before.nodes,after.nodes);
          assert.notDeepEqual(before.edges,after.edges);
          assert.notEqual(before.count,after.count);
          assert.ok(after.share>=.7 && after.scroll<=after.width && !after.overlaps,JSON.stringify(after));
          const changedSvg=await actualSvg.screenshot();
          assert.notEqual(sha(initialSvg),sha(changedSvg));
          const changed=await page.screenshot({fullPage:true,path:path.join(evidence,name+'-后.png')});
          assert.notEqual(sha(initial),sha(changed));
          const hidden=await page.addStyleTag({content:'main .detail, main details, main .feedback, main .conclusion {visibility:hidden}'});
          const covered=await page.screenshot({fullPage:true,path:path.join(evidence,name+'-遮字.png')});
          await hidden.evaluate(n=>n.remove());
          const evidenceDrawer=page.locator('summary').filter({hasText:/证据/,visible:true}).first();
          await evidenceDrawer.focus();
          await page.keyboard.press('Enter');
          assert.ok(await evidenceDrawer.evaluate(n=>n.parentElement.open));
          if(kind==='eli5-report') await page.locator('summary').filter({hasText:'待拍板'}).first().click();
          const button=page.getByRole('button',{name:copy,exact:true}).filter({visible:true}).first();
          const expected=kind==='scan-map'
            ? await button.evaluate(node=>JSON.parse(document.querySelector('#scan-data').textContent).find(s=>s.id===Number(node.dataset.copy)).command)
            : '请按「选题日报」的批次「参数｜报告日：2026-11-25」和我核对「是否采用春季选题？」。建议：先核已证的一条。请列依据和影响，等我确认再执行。';
          await button.focus();
          await page.keyboard.press('Enter');
          if (!granted) {
            await page.getByText('已全选，请复制',{exact:true}).waitFor();
            const field=page.locator('textarea:visible');
            assert.deepEqual(await field.evaluate(n=>[n===document.activeElement,n.selectionStart,n.selectionEnd,n.value]),[true,0,expected.length,expected]);
          } else {
            await page.getByText('已复制',{exact:true}).waitFor();
            const clipboard=await page.evaluate(()=>navigator.clipboard.readText());
            // Chromium converts LF to CRLF when writing the native Windows clipboard.
            assert.equal(clipboard.replace(/\r\n/g,'\n'),expected);
          }
          assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),before.width);
          assert.deepEqual(remote,[]); assert.deepEqual(errors,[]);
          entries.push({kind,width,theme,before,after,geometry,screenshots:[sha(initial),sha(changed),sha(covered)],svg:[sha(initialSvg),sha(changedSvg)],remote,errors,clipboard:granted?'成功':'拒绝时选中'});
          t.diagnostic(JSON.stringify(entries.at(-1)));
        } finally { await context.close(); }
      });
    }
  }
  await t.test('scan-map 首屏红优先、再到黄或首步，脚本关闭时亦一致',async()=>{
    const {dir,rows}=fixture('初看卡点');
    rows[3]=['4','AI照规矩',final,'汇总结果：依据：本批清单','—','—'];
    flowFile(dir,rows);
    const plain=scan(dir).dest;
    rows[1][2]+='（参考样例）';
    flowFile(dir,rows);
    const yellow=scan(dir).dest;
    rows[2][2]+='、work\\未交接\\';
    flowFile(dir,rows);
    const red=scan(dir).dest;
    for(const javaScriptEnabled of [true,false]){
      const context=await browser.newContext({viewport:{width:728,height:900},offline:true,javaScriptEnabled});
      try {
        const page=await context.newPage(), picked=[];
        for(const dest of [plain,yellow,red]){
          await page.goto(pathToFileURL(path.join(dest,scanMap)).href);
          const layout=await scanGeometry(page.locator('svg.wide'));
          picked.push([layout.selected,layout.copy,layout.states.map(n=>n.id),layout.errors]);
        }
        assert.deepEqual(picked,[['0','0',[],[]],['1','1',['1'],[]],['2','2',['1','2'],[]]]);
      } finally { await context.close(); }
    }
  });
  await t.test('scan-map 宽屏首行缺料、同行跨卡与两条退回通道',async()=>{
    const {dir,rows}=fixture('绕卡路线');
    rows[0][2]+='、work\\未交接\\';
    const intermediate='work\\04-核对.txt';
    rows.splice(3,1,
      ['4','AI照规矩',final,'核对样本：依据：清单',intermediate,'—'],
      ['5','你',final+'、'+intermediate,'人工签收：依据：票据','—','核样本｜看证据｜少字段退回第4步；缺原件退回第1步']);
    flowFile(dir,rows);
    const context=await browser.newContext({viewport:{width:728,height:900},offline:true});
    try {
      const page=await context.newPage();
      await page.goto(pathToFileURL(path.join(scan(dir).dest,scanMap)).href);
      const layout=await scanGeometry(page.locator('svg.wide'));
      assert.deepEqual([layout.broken,layout.back,layout.spanning],[1,2,1]);
      assert.deepEqual(layout.errors,[]);
    } finally { await context.close(); }
  });
  await t.test('A3-12 残表按真实步号读与退回',async()=>{
    const {dir,rows}=fixture('残表步号');
    rows[2][2]=first;
    rows[3][5]='核结果｜查业务键｜找不到就退回第2步';
    flowFile(dir,rows);
    put(dir,runTable,read(dir,runTable).replace(/^\| 2 \|.+$/m,'| 2 | AI照规矩 |'));
    const dest=scan(dir).dest, data=mapData(mapPage(dest));
    assert.deepEqual(data.filter(s=>s.num!==null).map(s=>s.num),[1,3,4]);
    assert.deepEqual(data[1].refs,[{ref:first,source:0}]);
    assert.deepEqual(data[2].retreat,[]);
    assert.ok(data[2].facts.some(f=>f.state==='yellow'&&f.title==='退回待核'&&/第 2 步/.test(f.actual)));
    const page=await browser.newPage();
    try {
      await page.goto(pathToFileURL(path.join(dest,scanMap)).href);
      assert.equal(await page.locator('.back[data-from="2"]').count(),0);
      assert.equal(await page.locator('.read[data-from="0"][data-to="1"]').count(),2);
    } finally { await page.close(); }
  });
  await t.test('A3-12 空表占位显示共零步',async()=>{
    const dir=fresh('空步数');
    put(dir,runTable,'# 当前没有表\n');
    const page=await browser.newPage();
    try {
      await page.goto(pathToFileURL(path.join(scan(dir).dest,scanMap)).href);
      assert.equal(await page.locator('[data-visible-count]').textContent(),'共 0 步');
      await page.getByRole('button',{name:'本次卡点',exact:true}).click();
      assert.equal(await page.locator('[data-visible-count]').textContent(),'卡点 1 处');
    } finally { await page.close(); }
  });
  await t.test('A3-13 七步四条退回及跨步依赖在双宽内不穿卡不卡字',async t=>{
    const {dir,rows}=fixture('七步多退回');
    const mid='work\\04-核样.txt', checked='work\\05-确认.txt', delivered='output\\06-交付.csv';
    rows[2][2]=first+'、'+captured;
    rows.splice(3,1,
      ['4','AI照规矩',final,'核对样本：依据：清单',mid,'核样本｜对明细｜缺明细退回第3步'],
      ['5','AI照规矩',final+'、'+mid,'复核清单：依据：规则',checked,'核清单｜验日期｜缺日期退回第4步'],
      ['6','AI照规矩',checked,'准备交付：依据：确认',delivered,'核总数｜对依据｜缺依据退回第3步'],
      ['7','你',delivered+'、'+first,'人工签收：依据：票据','—','验交付｜查原件｜少字段退回第2步']);
    flowFile(dir,rows);
    const flow=runFlow(dir);
    assert.equal(verdict(flow),'通过',flow);
    const dest=scan(dir).dest, html=mapPage(dest), file=path.join(dest,scanMap);
    assert.deepEqual(mapData(html).map(s=>s.num),[1,2,3,4,5,6,7]);
    fs.copyFileSync(file,path.join(evidence,'scan-map-七步-样本.html'));
    for (const width of [728,390]) for (const theme of ['light','dark']) await t.test(width+' '+theme,async()=>{
      const name='scan-map-七步-'+width+'-'+theme;
      const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,offline:true,serviceWorkers:'block'});
      try {
        const page=await context.newPage(), remote=[], errors=[];
        await context.route(/^https?:\/\//,route=>{remote.push(route.request().url());return route.abort();});
        page.on('pageerror',e=>errors.push(e.message));
        page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
        await page.goto(pathToFileURL(file).href);
        const svg=page.locator('[data-visual] svg:visible'), layout=await scanGeometry(svg,true);
        assert.equal(layout.back,4);
        assert.deepEqual(layout.errors,[],name);
        for (const [a,b] of [[0,2],[2,4],[0,6]]) assert.equal(await svg.locator('.read[data-from="'+a+'"][data-to="'+b+'"]').count(),1);
        for (const [a,b] of [[5,2],[6,1]]) assert.equal(await svg.locator('.back[data-from="'+a+'"][data-to="'+b+'"]').count(),1);
        const visual=await svg.evaluate(svg=>{
          const picture=svg.getBoundingClientRect().height;
          const panels=[...document.querySelectorAll('.detail:not([hidden])')].reduce((sum,node)=>sum+node.clientHeight-
            [...node.querySelectorAll('details')].reduce((h,n)=>h+n.offsetHeight,0),0);
          return {width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,share:picture/(picture+panels)};
        });
        assert.ok(visual.scroll<=visual.width && visual.share>=.7,JSON.stringify(visual));
        const initial=await page.screenshot({fullPage:true,path:path.join(evidence,name+'-前.png')});
        await page.getByRole('button',{name:'本次卡点',exact:true}).click();
        const changed=await page.screenshot({fullPage:true,path:path.join(evidence,name+'-后.png')});
        assert.notEqual(sha(initial),sha(changed));
        assert.deepEqual(remote,[]); assert.deepEqual(errors,[]);
        entries.push({kind:'scan-map-七步',width,theme,visual,geometry:layout,screenshots:[sha(initial),sha(changed)],remote,errors});
        t.diagnostic(JSON.stringify(entries.at(-1)));
      } finally { await context.close(); }
    });
  });
  await t.test('A3-14 业务页空分类清除其它分类的原明细',async t=>{
    const dir=fresh('只有一条正常日报'), data=structuredClone(reportDefinition);
    data.items=[{...data.items[0],label:'仅有正常样本'}];
    const rendered=generate(dir,data);
    assert.equal(rendered.status,0,rendered.stdout+rendered.stderr);
    for (const width of [728,390]) await t.test(width+'px',async()=>{
      const page=await browser.newPage({viewport:{width,height:900},offline:true});
      try {
        await page.goto(pathToFileURL(path.join(dir,'日报.html')).href);
        const panel=page.locator('[data-item-panel]');
        assert.equal(await panel.isVisible(),true);
        await page.getByRole('button',{name:'异常',exact:true}).click();
        assert.equal(await page.locator('[data-visible-count]').textContent(),'可见 0 / 全批 1 条');
        assert.equal(await panel.evaluate(n=>n.hidden),true);
        assert.equal(await panel.locator('#item-title').textContent(),'');
        assert.ok((await panel.locator('[data-item-field]').allTextContents()).every(x=>x===''));
        await page.getByRole('button',{name:'正常',exact:true}).click();
        assert.equal(await panel.isVisible(),true);
        assert.match(await panel.locator('#item-title').textContent(),/仅有正常样本/);
      } finally { await page.close(); }
    });
  });
  put(evidence,'离线浏览器实测.json',JSON.stringify({chromium:browser.version(),entries},null,2)+'\n');
});

test('T16 点名入口和业务授权收窄，只有项目 AI 接回定制需求',windows,async t => {
  await t.test('首三条铁律在通用技能入口',() => {
    const skill=read(product,'SKILL.md');
    assert.match(skill,/📍 当前进度：[^\n]+v2\.1\.0 \(2026-11-25\)/);
    assert.match(skill,/目标表.*允许列.*适用批次.*单次或长期/);
    assert.match(skill,/长对话|定时跑批/);
    assert.doesNotMatch(skill.split('---')[1],/^slug:|^version:/m);
  });
  await t.test('README 首句、让位原句和结构修范围',() => {
    assert.equal(read(product,'README.md').split('\n')[2],'让 Agent 搭建可控制、可解释。你能看懂每一步怎样运行、哪里出了问题，也能把这一步的修改指令交给自己的 AI。');
    assert.ok(read(product,'模板/AGENTS.模板.md').split('\n').includes(handover));
    const repair=read(product,'做法/0-修复复诊.md');
    assert.match(repair,/定制.*项目 AI/);
    assert.match(repair,/--upgrade-map/);
  });
});

test('T17 交接活动字段、让位句和外部清点守住采用',windows,async t => {
  const {dir}=fixture('交接',{station:'已结束（采用）'});
  const stored=read(dir,index);
  put(dir,'AGENTS.md','# 项目规矩\n## 开工\n'+handover+'\n');
  await t.test('允许准确的让位句但不能默认回教练',() => {
    assert.doesNotMatch(scan(dir).report,/✗ 内容④/);
    put(dir,index,stored.replace(followUp,'换对话时说：调用教练')+'- 历史引语：直接对项目 AI 说：接着做\n');
    assert.match(scan(dir).report,/✗ 内容④.*PROJECT_INDEX\.md/);
  });
  await t.test('无外部回读，站 5 不能拿采用',() => {
    put(dir,index,stored.replace('## 已确认','- 外部交付｜第3步｜竞品表｜标题｜2026-11-25｜单次｜待核｜未接\n## 已确认'));
    assert.match(scan(dir).report,/✗ .*外部交付|✗ .*竞品表/);
    assert.match(read(product,'做法/5-收尾交接.md'),/外部线上交付与未闭环承诺清点/);
  });
  await t.test('使用者停止后不推回采用',() => {
    put(dir,index,stored.replace('已结束（采用）','已结束（停止）').replace(followUp,'换对话时说：调用教练'));
    assert.doesNotMatch(scan(dir).report,/✗ 内容④.*PROJECT_INDEX\.md/);
  });
});

test('T20 齐齐脱敏链：定位回退、只改副本、本批复诊与业务日报',windows,async t => {
  const {dir,rows}=prepareCard(), rounds=fresh('齐齐外置');
  put(dir,'output/飞书只读样本.csv','日期,业务键,人工列\n2026-11-23,旧,人填\n\n2026-11-24,新,"一行\n二行"\n');
  const before=read(dir,'output/飞书只读样本.csv');
  const initial=scan(dir,path.join(rounds,'初诊')), sim=path.join(dir,'work','本地模拟.txt');
  const sampleKeys=new Set(['2026-11-23/旧','2026-11-24/新']);
  const duplicate='2026-11-24/新';
  assert.equal([...new Set([duplicate])].filter(k=>!sampleKeys.has(k)).length,0);
  await t.test('体检给可复制的真实问题和只读边界',() => {
    const html=mapPage(initial.dest);
    assert.match(html,/未交接/);
    assert.match(html,/人工列/);
    assert.match(html,/线上写入另等我确认/);
  });
  await t.test('新一轮只比较改过的业务文件，原表样本不动',() => {
    rows[2][2]=captured;
    flowFile(dir,rows,{draw:true});
    fs.mkdirSync(path.dirname(sim),{recursive:true});
    fs.writeFileSync(sim,'输入 4 是例子；缺当批采集时停止。\n');
    const {dest}=scan(dir,path.join(rounds,'复诊-1'));
    const result=JSON.parse(read(dest,snapshot));
    assert.ok(result.comparison.changes.some(x=>x.path==='docs\\run-flow.md'&&x.kind==='内容修改'));
    assert.equal(read(dir,'output/飞书只读样本.csv'),before);
    const r=generate(dir);
    assert.equal(r.status,0,r.stderr+r.stdout);
    assert.equal(verifyPage(dir).status,0);
  });
});

test('T05 七步同名也有各自的双端位置与复制验收',windows,() => {
  const {dir,rows}=fixture("中文 项目 '带空格'");
  rows.splice(3,1,
    ['4','AI看情况',final,'核对样本：依据：清单','work\\04-清单.txt','—'],
    ['5','AI照规矩','work\\04-清单.txt','核对样本：依据：规则','work\\05-核对.txt','—'],
    ['6','AI照规矩','work\\05-核对.txt','准备交付：依据：规则','output\\06-交付.csv','—'],
    ['7','你','output\\06-交付.csv','人工签收：依据：票据','—','核样本｜看证据｜不对退回第6步']);
  flowFile(dir,rows);
  writeTicket(dir,rows[3]);
  writeTicket(dir,rows[4]);
  const html=mapPage(scan(dir).dest);
  const data=JSON.parse(/<script type="application\/json" id="scan-data">([^\n]+)<\/script>/.exec(html)[1]);
  assert.equal(data.length,7);
  assert.equal(new Set(data.map(d=>d.command)).size,7);
  for(const s of data) {
    const lines=s.command.split('\n');
    assert.equal(lines.length,5);
    assert.equal(lines[0],'请在「'+dir+'」核查第'+s.num+'步「'+s.name+'」。本批：待核。');
    assert.ok(lines[2].includes(path.join(dir,'docs','run-flow.md')));
    assert.ok(lines[2].includes('等我确认后只改这一步获准的范围'));
    assert.match(lines[3],/^验收：.+未通过：禁止报修好\/已通过。$/);
    assert.match(lines[4],/人工列。禁止自行补真人确认、改定时任务、回填历史或写外部表/);
  }
  assert.equal(data[3].name,data[4].name);
  assert.match(data[3].command,/04-样例\.md/);
  assert.match(data[4].command,/05-样例\.md/);
  assert.match(data[6].command,/尚无票|PROJECT_INDEX/);
});

test('T06 写前错误、现表变化和两进程竞争保住旧图',windows,async t => {
  const inject=fresh('隔离故障'), script=path.join(inject,'map-fault.cjs');
  put(inject,'map-fault.cjs',[
    "const fs=require('node:fs');const path=require('node:path');const open=fs.openSync;let fired=false;",
    "fs.openSync=function(p,...args){",
    "if(typeof p==='string'&&args[0]==='wx'&&!fired){",
    "if(process.env.MAP_FAULT==='permission'&&p.includes('历史')){fired=true;const e=new Error('备份不可写');e.code='EACCES';throw e;}",
    "if(process.env.MAP_FAULT==='source'&&/run-flow\\.html\\.\\d+\\.tmp$/.test(p)){fired=true;fs.appendFileSync(path.join(process.env.MAP_TEST_PROJECT,'docs/run-flow.md'),'\\n并发改动。\\n');}",
    "}",
    "return open.call(this,p,...args);};",
  ].join('\n'));
  for(const fault of ['permission','source']) await t.test(fault,()=>{
    const dir=archifyFixture(), initial=fs.readFileSync(path.join(dir,projectMap));
    const result=tool('flow',dir,['--upgrade-map'],{preload:script,env:{...process.env,MAP_FAULT:fault,MAP_TEST_PROJECT:dir}});
    assert.equal(result.status,1,result.stdout+result.stderr);
    assert.match(result.stderr,/EACCES|变动|备份/);
    assert.deepEqual(fs.readFileSync(path.join(dir,projectMap)),initial);
    assert.ok(!exists(dir,'docs/check/run-flow.html.lock'));
    assert.equal(files(dir).filter(s=>s.endsWith('.tmp')).length,0);
  });
  await t.test('并发后唯一备份仍为原字节',async ()=>{
    const dir=archifyFixture(), original=fs.readFileSync(path.join(dir,projectMap));
    async function start() {
      const child=spawn(process.execPath,[checker,'flow',dir,'--upgrade-map'],{encoding:'utf8'});
      let text='';
      for(const stream of [child.stdout,child.stderr]) {stream.setEncoding('utf8');stream.on('data',d=>text+=d);}
      const code=await new Promise((yes,no)=>{child.on('error',no);child.on('close',yes);});
      return {code,text};
    }
    const done=await Promise.all([start(),start()]);
    assert.ok(done.some(r=>r.code===0&&/已升级|已是当前版/.test(r.text)||r.code===0&&/｜通过/.test(r.text)),JSON.stringify(done));
    const backs=files(path.join(dir,'docs/check/历史'));
    assert.deepEqual(backs,['run-flow-'+sha(original)+'.html']);
    assert.deepEqual(fs.readFileSync(path.join(dir,'docs/check/历史',backs[0])),original);
    assert.equal(verdict(runFlow(dir)),'通过');
  });
});

test('T10 复诊目录冲突不覆盖旧证，未遍历范围不计删除',windows,()=>{
  const dir=fresh('对照项目'), rounds=fresh('复诊集合');
  const from=path.join(rounds,'初诊'), dest=path.join(rounds,'复诊-1');
  put(dir,'work/已知.txt','一');
  scan(dir,from);
  put(dir,'work/已知.txt','二');
  scan(dir,dest);
  const frozen=fingerprint(dest);
  put(dir,'work/已知.txt','三');
  assert.notEqual(tool('scan',dest,[dir]).status,0);
  assert.deepEqual(fingerprint(dest),frozen);
  const wrong=fresh('陌生文件');
  put(wrong,scanMap,'不是本轮生成的页');
  assert.notEqual(tool('scan',wrong,[dir]).status,0);
  assert.equal(read(wrong,scanMap),'不是本轮生成的页');
  const real=path.join(dir,'work/已知.txt');
  fs.truncateSync(real,16*1024*1024+1);
  const next=scan(dir,path.join(rounds,'复诊-2'));
  const s=JSON.parse(read(next.dest,snapshot));
  assert.equal(s.comparison.status,'部分未核');
  assert.equal(s.comparison.changes.find(x=>x.path==='work\\已知.txt').kind,'未核');
});

test('T11 哈希额度边界和可见范围真的受限',windows,async t=>{
  const MiB=1024*1024;
  await t.test('单件 16 MiB、总量 256 MiB 与 256 KiB 文本各自封顶',()=>{
    const dir=fresh('字节额度');
    for(let i=0;i<16;i++){
      const file=path.join(dir,'采集'+String(i).padStart(2,'0')+'.bin');
      fs.closeSync(fs.openSync(file,'w'));fs.truncateSync(file,16*MiB);
    }
    put(dir,'采集尾.bin','多一项');
    const s=JSON.parse(read(scan(dir).dest,snapshot));
    assert.equal(s.entries.length,16);
    assert.equal(s.entries.reduce((n,x)=>n+x.bytes,0),256*MiB);
    assert.ok(s.skipped.some(x=>x.path==='采集尾.bin'&&/256 MiB/.test(x.reason)));
    const text=fresh('文本额度');
    put(text,'A.md','x'.repeat(256*1024));
    put(text,'B.md','x'.repeat(256*1024+1));
    const r=scan(text);
    assert.doesNotMatch(r.report,/A\.md：超过 256/);
    assert.match(r.report,/B\.md：超过 256/);
    assert.equal(JSON.parse(read(r.dest,snapshot)).entries.length,2,'文字不展开时仍核当件原字节');
  });
  await t.test('枚举两侧边界含记忆目录，不为这些条目打开正文',()=>{
    const dir=fresh('元数据额度'), probe=fresh('元数据探针'), mem=path.join(dir,'.workbuddy/memory');
    put(dir,'.workbuddy/memory/实物.md','合成夹具');
    put(probe,'enum.cjs',[
      "const fs=require('node:fs'),path=require('node:path');",
      "const list=fs.opendirSync,stat=fs.lstatSync,open=fs.openSync;const root=path.resolve(process.env.ENUM_ROOT);",
      "fs.opendirSync=function(p,...args){if(path.resolve(p)!==root) return list.call(this,p,...args);",
      "let i=0;return {readSync(){return i<Number(process.env.ENUM_COUNT)?",
      "    {name:'枚举'+String(i++).padStart(5,'0')+'.md',isFile(){return true;},isDirectory(){return false;}}:null;},closeSync(){}};};",
      "fs.lstatSync=function(p,o){if(path.dirname(path.resolve(p))===root&&path.basename(p).startsWith('枚举')) return stat.call(this,path.join(root,'实物.md'),o);return stat.call(this,p,o);};",
      "fs.openSync=function(p,...a){if(typeof p==='string'&&path.dirname(path.resolve(p))===root) throw new Error('不许打开记忆正文');return open.call(this,p,...a);};",
    ].join('\n'));
    for(const count of [19997,19998,19999]){
      const r=scan(dir,fresh('枚举输出'),{preload:path.join(probe,'enum.cjs'),env:{...process.env,ENUM_ROOT:mem,ENUM_COUNT:String(count)}});
      const s=JSON.parse(read(r.dest,snapshot));
      assert.equal(s.entries.length,count<=19998?count:0);
      assert.equal(s.skipped.some(x=>/超过 20000/.test(x.reason)),count>19998);
      assert.ok(s.entries.every(e=>e.mtimeMs!==undefined && e.sha256===undefined));
      assert.doesNotMatch(r.report,/枚举00000|合成夹具/);
    }
  });
});

// Each case uses an offline project. Both commands must classify the same evidence.
function checkDelivery(text, decision, status, reason, {target='飞书竞品表',columns='标题',other}={}) {
  const dir=deliveryProject();
  put(dir,'docs/tickets/01-认出输入.md','# 认出输入');
  put(dir,'scripts/01_认出输入.js','// 清点用');
  const entry=decision ? '已排除本次｜稍后补证' : '已读回｜docs\\check\\回读.txt';
  const row=delivery.replace('｜飞书竞品表｜标题｜',()=> '｜'+target+'｜'+columns+'｜');
  let entries=row+entry;
  if (other) {
    put(dir,'docs/check/另一回执.txt',receiptText.replace('工作表：飞书竞品表','工作表：'+other));
    entries+='\n'+delivery.replace('｜飞书竞品表｜','｜'+other+'｜')+'已读回｜docs\\check\\另一回执.txt';
  }
  put(dir,index,read(dir,index).replace('## 已确认',()=>entries+'\n## 已确认\n'+decision));
  if (text) put(dir,receipt,text);
  const station=stationFive(dir), diagnostic=scan(dir).report;
  for (const body of [station,diagnostic]) {
    assert.ok(body.includes('外部交付 第 3 步「'+target+'」'+status+'：'),body);
    if (reason) assert.ok(body.includes(reason),body);
  }
  assert.equal(verdict(station),['已排除本次','本地回执已核'].includes(status)?'通过':'不通过',station);
}

test('R4 写入授权只豁免已知保护列，独立自定义列留待核实',windows,async t=>{
  const text=receiptText.replace('允许列：标题','允许列：金额');
  for (const [restriction,status] of [
    ['不得修改状态列','待核'],['不得修改人工列和状态列','待核'],
    ['禁止修改人工列','本地回执已核'],['禁止修改备注列','本地回执已核'],
    ['不得修改状态列和金额列','失败'],['不得修改账单表金额列','失败'],
    ['不得修改任何列','失败'],['不得修改原有状态列','失败'],['保护金额列','失败'],
  ]) await t.test(restriction,()=>checkDelivery(text.replace(/^授权：.*$/m,'授权：我同意写入金额，单次，'+restriction),
    '',status,undefined,{columns:'金额'}));
});

test('R4 缩范围必须明确排除，撤回与交付按完整表名生效',windows,async t=>{
  const target='飞书竞品表', other='飞书明细表', yes='同意本次排除 '+target;
  const withdrawals=[
    '飞书竞品表，撤回之前决定。','飞书竞品表，不同意缩小采用范围。','飞书竞品表，恢复纳入本次。',
    '飞书竞品表，必须交付。','关于飞书竞品表，不同意本次排除。','飞书竞品表，是否同意本次排除？',
    '恢复纳入飞书竞品表','必须交付飞书竞品表','照常交付飞书竞品表','继续交付飞书竞品表',
    '飞书竞品表不排除','飞书竞品表不再排除','飞书竞品表不要排除','飞书竞品表恢复交付',
    '飞书竞品表需要交付','飞书竞品表排除决定已撤回','撤回对飞书竞品表之前的排除决定',
  ];
  for (const line of withdrawals) await t.test('有日期 '+line,()=>
    checkDelivery('','- 2026-11-24：'+yes+'\n- 2026-11-25：'+line,'待核'));
  for (const line of [...withdrawals.slice(0,6),'恢复纳入飞书竞品表','飞书竞品表不排除']) {
    await t.test('无日期 '+line,()=>checkDelivery('',yes+'\n'+line,'待核'));
  }
  for (const [line,status] of [
    ['学员同意只采用：'+target,'待核'],[yes+'\n学员同意只采用：'+target,'待核'],
    ['同意只采用本地部分，本次不纳入'+target,'已排除本次'],
    ['是否同意只采用本地部分，本次不纳入'+target,'待核'],
    [target+'，同意本次排除','已排除本次'],
    [target+'。同意本次排除','待核'],[yes+'\n'+target+'，'+other+'不排除','已排除本次'],
    [yes+'，恢复纳入'+other,'已排除本次'],
    ...['必须交付飞书竞品表归档表','恢复纳入另一飞书竞品表','飞书竞品表（归档）需要交付',
      '飞书竞品表(测试)需要交付','恢复纳入X飞书竞品表','飞书竞品表_2026需要交付','飞书竞品表：不同意更换表头颜色']
      .map(value=>[yes+'\n'+value,'已排除本次']),
    [yes+'\n飞书竞品表归档表排除决定已撤回，飞书竞品表也需要交付','待核'],
    [yes+'\n恢复纳入飞书竞品表归档表和飞书竞品表','待核'],
  ]) await t.test(line.replace('\n',' / '),()=>checkDelivery('',line,status,undefined,{target,other}));
  const longer='周报飞书竞品表快照';
  await t.test('登记长表名中的短名不接收长表的撤回',()=>
    checkDelivery('',yes+'\n必须交付'+longer,'已排除本次',undefined,{target,other:longer}));
  await t.test('缺目标的排除登记留待核实',()=>{
    const dir=deliveryProject();
    put(dir,index,read(dir,index).replace('## 已确认',delivery.replace(target,'')+'已排除本次｜待办\n## 已确认\n'+yes));
    for (const body of [stationFive(dir),scan(dir).report]) assert.match(body,/「交付位置待核」待核：登记缺少/);
  });
});

test('R3 授权的保护对象不能包含允许列，范围和决定必须完整',windows,async t=>{
  for (const [value,columns,status] of [
    ['同意写飞书竞品表的标题列，仅本批单次，禁止修改飞书竞品表的标题列','标题列','失败'],
    ['同意写标题，仅本批单次，禁止修改原有标题列','标题','失败'],
    ['同意写标题，仅本批单次，禁止修改整张表的列','标题','失败'],
    ['同意写标题，仅本批单次，不能修改工作表每一列','标题','失败'],
    ['同意写人工备注，仅本批单次，禁止修改人工备注列','人工备注','失败'],
    ['同意写标题，仅本批单次，禁止修改备注列和该标题列','标题','失败'],
    ['同意写标题，仅本批单次，禁止修改保留列和预留列','标题','本地回执已核'],
    ['同意写飞书竞品表的标题列，仅本批单次，禁止修改备注列','标题列','本地回执已核'],
    ['同意写标题，仅本批单次吗','标题','待核'],
    ['同意写标题？仅本批单次','标题','待核'],
    ['同意写标题，仅本批单次，须另议','标题','待核'],
    ['同单次意写标题','标题','待核'],
  ]) await t.test(value,()=>checkDelivery(receiptText.replace('允许列：标题','允许列：'+columns)
    .replace(/^授权：.*$/m,'授权：'+value),'',status,undefined,{columns}));
});

test('R3 人工列回读要有完整肯定分句，异常优先于待核',windows,async t=>{
  for (const [want,values] of [
    ['待核',['前后逐值一致待核','待核，应前后一致','前后一致？','前后逐值一致吗','预计前后一致',
      '抽查前后逐值一致','部分前后逐值一致','前后逐值一致，明日另议','前后逐值一致尚待签字','据说前后一致']],
    ['失败',['人工列没有前后逐值一致','不能证明前后逐值一致','无法确认前后逐值一致',
      '前后逐值一致，并非无异常','前后逐值一致，不是未发现异常','前后一致？人工列已改变']],
    ['本地回执已核',['前后逐值一致','前后逐值一致，未发现异常','前后一致，无变动',
      '各人工列均前后逐值相同！人工列均未被清空','逐值一致，各人工列保持原样']],
  ]) for (const value of values) await t.test(value,()=>
    checkDelivery(receiptText.replace(/^人工列：.*$/m,'人工列：'+value),'',want));
});

test('R3 缩范围逐目标逐分句核对，撤回和问句不能被旧日期复活',windows,async t=>{
  const main='飞书竞品表', detail='飞书明细表', yes='同意本次排除 '+main;
  const mixed='- 2026-11-25：'+yes+'，'+detail+' 照常交付。';
  for (const [label,target,lines,want] of [
    ['别表的同意不能串过逗号',detail,[mixed],'待核'],
    ['同句另一目标的交付仍然独立',main,[mixed],'已排除本次'],
    ...['撤回对飞书竞品表的排除决定','撤回对飞书竞品表的本次排除','取消对飞书竞品表的排除'].map(value=>
      [value,main,['- 2026-11-24：'+yes,'- 2026-11-25：'+value],'待核']),
    ...['|',',','，'].map(sep=>['日期分隔符 '+sep,main,['- 2026-11-25'+sep+'拒绝本次排除 '+main,'- 2026-11-24：'+yes],'待核']),
    ['无日期撤回后重复同日同意',main,['- 2026-11-25：'+yes,'- '+main+'恢复纳入本次','- 2026-11-25：'+yes],'待核'],
    ['无日期撤回后日期向前或向后',main,['2026-11-24：'+yes,main+'恢复纳入本次','2026-11-23：'+yes,'2026-11-25：'+yes],'已排除本次'],
    ['无问号的问句',main,['- 2026-11-25：你同意本次排除 飞书竞品表 吗'],'待核'],
    ['分句间的问号',main,['同意缩小采用范围？飞书竞品表。'],'待核'],
    ['纯目标紧邻肯定决定',main,['同意缩小采用范围，针对「飞书竞品表」。'],'已排除本次'],
    ['第二个裸名不得借用前一目标的同意',detail,[yes+'，'+detail+'。'],'待核'],
    ['未知条件不可消失',main,[yes+'，预算通过后生效。'],'待核'],
    ['全表交付不能当成另一目标',main,[yes+'，整张表照常交付。'],'待核'],
    ['明确问句更新先前同意',main,[yes,'你同意本次排除飞书竞品表吗'],'待核'],
    ['引用更换表头的决定不产生缩范围授权',main,['听说同意本次排除 飞书竞品表'],'待核'],
  ]) await t.test(label,()=>checkDelivery('',lines.join('\n'),want,undefined,{target,other:lines[0]===mixed?(target===main?detail:main):undefined}));
});

test('R3 列表字段参与回执核对',windows,async t=>{
  for(const line of ['- 人工列：已改变','* 结果：失败']) await t.test(line,()=>
    checkDelivery(receiptText+'\n'+line,'','失败','回执同一字段存在冲突记录'));
  await t.test('整份列表仍是有效回执',()=>checkDelivery(receiptText.replace(/^/gm,'- '),'','本地回执已核'));
});

test('R3 同行各自表态与带介词撤回仍绑定原目标',windows,async t=>{
  const target='飞书竞品表', other='飞书明细表', yes='同意本次排除'+target;
  for (const [value,want] of [
    [yes+'，拒绝本次排除'+other,'已排除本次'],
    ['取消对'+other+'的本次排除，'+yes,'已排除本次'],
    [yes+'\n撤回对'+target+'的缩范围决定','待核'],
    [yes+'\n撤回了对'+target+'的本次排除','待核'],
    [yes+'\n同意缩小采用范围？'+target,'待核'],
  ]) await t.test(value.replace('\n',' / '),()=>checkDelivery('',value,want,undefined,{target,other}));
});

test('R3 坏泳道和重复框的旧图逐字节保留',windows,async t=>{
  for (const lanes of [{id:'prog'},[null]]) await t.test(JSON.stringify(lanes),()=>{
    const dir=archifyFixture(), source=JSON.parse(read(dir,sourceMap));
    const original=fs.readFileSync(path.join(dir,projectMap));
    put(dir,sourceMap,JSON.stringify({...source,lanes}));
    assert.match(scan(dir).report,/图源.*结构不对/);
    assert.equal(verdict(runFlow(dir,'--upgrade-map')),'不通过');
    assert.deepEqual(fs.readFileSync(path.join(dir,projectMap)),original);
  });
  await t.test('普通 flow 遇到重复框',()=>{
    const dir=archifyFixture(), html=read(dir,projectMap);
    const node=html.match(/<g\b[^>]*\bdata-node-id="[^"]+"[^>]*>/u)[0];
    const original=Buffer.from(html.replace(node,node+node+'</g>'));
    put(dir,projectMap,original);
    assert.equal(verdict(runFlow(dir)),'不通过');
    assert.deepEqual(fs.readFileSync(path.join(dir,projectMap)),original);
  });
});

test('R2-01 授权取肯定决定、允许列与范围，分开核保护条件',windows,async t=>{
  for (const [value,status] of [
    ['请确认是否可以写标题，本批单次仍待审批','待核'],
    ['同意写标题，仅本批单次，禁止修改人工列','本地回执已核'],
    ['同意写标题，本批单次，禁止修改人工列和备注列','本地回执已核'],
    ['同意写标题，长期，不改其他列；本批单次仍待确认','待核'],
    ['同意写标题，仅本批单次；禁止写标题','失败'],
    ['同意写标题，仅本批单次，禁止修改人工列和标题','失败'],
    ['同意写备注，本批单次，保留标题','待核'],
    ['同意写标题，本批单次仍在审核中','待核'],
    ['同意写标题，本批单次，不动人工列，不改其他列，禁止覆盖历史','本地回执已核'],
  ]) await t.test(value,()=>checkDelivery(receiptText.replace(/^授权：.*$/m,'授权：'+value),'',status));
});

test('R2-02 同一目标只采最终无冲突的缩范围决定',windows,async t=>{
  const yes='同意缩小采用范围，飞书竞品表。', no='不同意缩小采用范围，飞书竞品表必须交付。';
  for (const [label,lines,want] of [
    ['先准后撤',['2026-11-24：'+yes,'2026-11-25：'+no],'待核'],
    ['先撤后准',['2026-11-24：'+no,'2026-11-25：'+yes],'已排除本次'],
    ['同日冲突',['2026-11-25：'+no,'2026-11-25：'+yes],'待核'],
    ['旧日期后补',['2026-11-25：'+no,'2026-11-24：'+yes],'待核'],
    ['无日期撤回',[yes,'飞书竞品表恢复纳入本次。'],'待核'],
    ['撤销之前的决定',[yes,'飞书竞品表：撤回之前决定。'],'待核'],
    ['同条冲突',[yes+'飞书竞品表必须交付。'],'待核'],
    ['其他目标',[yes,no.replace('飞书竞品表','飞书库存表')],'已排除本次'],
    ['目标是另一个同前缀的表',[yes.replace('飞书竞品表','飞书竞品表归档表')],'待核'],
    ['目标是另一个同后缀的表',[yes.replace('飞书竞品表','另一飞书竞品表')],'待核'],
    ['带括注的归档表撤回不改变主表',[yes,no.replace('飞书竞品表','飞书竞品表（归档）')],'已排除本次'],
    ['明确点名并紧接决定',['飞书竞品表同意缩小采用范围。'],'已排除本次'],
    ['同一目标的其他决定',[yes,'飞书竞品表：不同意更换表头颜色。'],'已排除本次'],
  ]) await t.test(label,()=>checkDelivery('',lines.join('\n'),want));
});

test('R2-03 全文所有回执字段按别名唯一，任何相抵均失败',windows,async t=>{
  const aliases={'工作表':'目标系统','实见业务键':'业务键','人工列':'人工列核对','授权':'学员授权','结果':'读回结果'};
  for (const line of receiptText.split('\n')) {
    const i=line.indexOf('：'), key=line.slice(0,i), alias=aliases[key]??key;
    const other=alias+'：'+(key==='结果'?'失败，最终读回不符':'不同的记录');
    await t.test(key,()=>checkDelivery(receiptText+'\n'+other,'','失败','回执同一字段存在冲突记录'));
  }
  await t.test('有模拟标记仍先报字段冲突',()=>checkDelivery(receiptText+'\n工作表：模拟表','','失败','回执同一字段存在冲突记录'));
  await t.test('倒序也报冲突',()=>checkDelivery('读回结果：失败\n'+receiptText,'','失败','回执同一字段存在冲突记录'));
  await t.test('同值别名',()=>checkDelivery(receiptText+'\n目标：飞书竞品表\n读回结果：通过','','本地回执已核'));
});

test('R2-06 分句辨认一致、未发现异常与实际变更',windows,async t=>{
  for(const [value,want] of [
    ['前后逐值一致，未发现异常','本地回执已核'],['无变动，前后逐值一致，未被修改','本地回执已核'],
    ['未能证明前后一致，发现人工值已改变','失败'],['前后逐值一致，未发现异常；仍有异常','失败'],
    ['未见异常','待核'],['前后逐值一致，均空','待核'],
  ]) await t.test(value,()=>checkDelivery(receiptText.replace(/^人工列：.*$/m,'人工列：'+value),'',want));
});

async function checkBrokenArchify(t,from) {
  for (const which of ['from','to','空号','重号']) await t.test(which,()=>{
    const dir=archifyFixture(from), html=read(dir,projectMap);
    let changed;
    if (which==='空号' || which==='重号') {
      const names=[...html.matchAll(/<g\b[^>]*\bid="node-[^"]*"[^>]*>/g)];
      const [a,b]=names.map(m=>m[0]).filter(s=>s.includes('data-node-id='));
      const id=a.match(/data-node-id="([^"]+)"/)[1];
      changed=html.replace(b,b.replace(/data-node-id="[^"]+"/,'data-node-id="'+(which==='重号'?id:'')+'"'));
    } else {
      changed=html.replace(/<path\b[^>]*\bdata-edge-id="input-invalid"[^>]*>/,tag=>
        tag.replace(new RegExp('data-edge-'+which+'="[^"]+"'),'data-edge-'+which+'="缺失节点"'));
    }
    assert.notEqual(changed,html);
    put(dir,projectMap,changed);
    const detail=runFlow(dir,'--upgrade-map');
    assert.equal(verdict(detail),'不通过',detail);
    assert.equal(read(dir,projectMap),changed);
    assert.equal(exists(dir,'docs/check/历史/run-flow-'+sha(changed)+'.html'),false);
  });
}

test('R2-04 原图端点及节点完整才可升级',windows,t=>checkBrokenArchify(t));

test('R2-05 无锁初诊先验证每一步归属和数据岛，错误时保留原件',windows,async t=>{
  const {dir}=fixture('来源甲'), other=fixture('来源乙').dir;
  const own=scan(dir).dest, foreign=scan(other).dest, html=mapPage(own);
  const island=/<script type="application\/json" id="scan-data">([^\n]+)<\/script>/;
  const replaceData=fn=>html.replace(island,(full,json)=>full.replace(json,JSON.stringify(fn(JSON.parse(json)))));
  for (const [label,page,withSnapshot] of [
    ['真实异源图',mapPage(foreign),true],['无快照的本地图',html,false],
    ['只有末步异源',replaceData(steps=>{steps.at(-1).command=steps.at(-1).command.replace(dir,other);return steps;}),true],
    ['空岛',replaceData(()=>[]),true],['缺证据结构',replaceData(steps=>{delete steps[0].refs;return steps;}),true],
    ['损坏JSON',html.replace(island,'<script type="application/json" id="scan-data">[</script>'),true],
    ['重复岛',html.replace(island,'$&$&'),true],
  ]) await t.test(label,()=>{
    const dest=fresh('恢复边界');
    if(withSnapshot) put(dest,snapshot,read(own,snapshot));
    put(dest,scanMap,page);
    const before=fingerprint(dest);
    // The preflight must reject before opening a lock or writing any evidence.
    const probe=fresh('只读观测');
    put(probe,'guard.cjs',"const fs=require('node:fs'),open=fs.openSync;fs.openSync=function(p,f,...a){if(f==='wx')throw Error('预检已越过只读阶段');return open.call(this,p,f,...a);};");
    const r=tool('scan',dest,[dir],{preload:path.join(probe,'guard.cjs')});
    assert.equal(r.status,1,r.stdout+r.stderr);
    assert.match(r.stderr,/诊断图.*(?:归属|快照|数据)/);
    assert.deepEqual(fingerprint(dest),before);
  });
});

test('R2-08 标准命名实体按大小写和多码点解码一次',windows,async t=>{
  for (const [encoded,value] of [['R&AMP;D','R&D'],['A&plus;B','A+B'],['x&NotEqualTilde;y','x≂̸y'],
    ['Caf&Eacute;','CafÉ'],['A&amp;plus;B','A&plus;B'],['A&Unlisted;B','A&Unlisted;B']]) await t.test(encoded,()=>{
    const r=batchAcceptance('<meta name="coach-batch" content="参数｜客户代号：'+encoded+'"><main>金额：12</main>',value);
    assert.equal(verdict(r),'通过',r);
  });
  await t.test('单文件生成器也识别编码的标记名和值',()=>{
    const dir=fresh('生成器实体');
    const html='<meta name="coach-generator" content="eli5-report&sol;1"><main>缺少业务数据</main>';
    put(dir,'日报.html',html);
    const result=verifyPage(dir);
    assert.equal(result.status,1,result.stdout+result.stderr);
    assert.doesNotMatch(result.stdout,/跳过/);
  });
});

test('R2-10 正式 CI 缺桌面历史档案仍然执行核心兼容断言',windows,async t=>{
  const env={...process.env,CI:'true'};
  for (const key of ['NODE_TEST_CONTEXT','AGENT_COACH_TEST_V121_ZIP','AGENT_COACH_TEST_ARCHIFY_DOCS','AGENT_COACH_DIAG_EVIDENCE']) delete env[key];
  for (const [file,pattern] of [['diagnostics-v210','T06 普通刷新'],['rescue-v200','F1 · v1.21 材料底账|13.58 旧 Archify|I4 11 · 原包']]) {
    await t.test(file,()=>{
      const r=run('--test',['--test-reporter=tap','--test-name-pattern='+pattern,path.join(repo,'tests/'+file+'.test.mjs')],{env,timeout:150000});
      assert.equal(r.status,0,r.stdout+r.stderr);
      assert.match(r.stdout,/# skipped 0\b/,r.stdout);
      assert.match(r.stdout,/# pass [1-9]\d*\b/,r.stdout);
    });
  }
});


test('R2-09 文件名逐段核真实拼写，缺件、联接和硬链接都不读入',windows,async t=>{
  const dir=deliveryProject(), safe=fresh('独立对照');
  put(dir,'docs/check/Receipt.TXT',receiptText);
  put(safe,'Receipt.TXT',receiptText);
  fs.linkSync(path.join(dir,'docs/check/Receipt.TXT'),path.join(dir,'docs/check/副本.txt'));
  fs.symlinkSync(safe,path.join(dir,'docs/check/联接'),'junction');
  const base=read(dir,index);
  for (const [rel,why] of [['不存在.txt','本地回执缺失'],['联接\\Receipt.TXT','联接'],['副本.txt','硬链接']]) {
    await t.test(rel,()=>{
      put(dir,index,base.replace('## 已确认',delivery+'已读回｜docs\\check\\'+rel+'\n## 已确认'));
      assert.ok(stationFive(dir).includes(why));
    });
  }
  fs.unlinkSync(path.join(dir,'docs/check/副本.txt'));
  for (const [name,why] of [['receipt.txt','大小写'],['Receipt.TXT','本地回执已核']]) {
    put(dir,index,base.replace('## 已确认',delivery+'已读回｜docs\\check\\'+name+'\n## 已确认'));
    const report=stationFive(dir);
    assert.ok(report.includes(why),report);
  }
});
