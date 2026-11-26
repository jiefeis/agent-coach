#!/usr/bin/env node
// Agent 搭建教练的检查脚本。零依赖，Node 22 能跑。
// 用法：node coach-check.mjs init <学员项目完整路径>
//       node coach-check.mjs files <学员项目完整路径> <站号 1-5>
//       node coach-check.mjs inputs <学员项目完整路径>
//       node coach-check.mjs flow <学员项目完整路径> [--refresh 或 --upgrade-map]
//       node coach-check.mjs ticket <学员项目完整路径> <票号>（语法预检与验收单指纹）
//       node coach-check.mjs accept <学员项目完整路径> <票号>
//       node coach-check.mjs scan <报告文件夹完整路径> <被体检文件夹完整路径>（只读目标，外置生成 scan.txt、快照及有运行表时的诊断图）
//       node coach-check.mjs quote <被体检文件夹完整路径>（草稿从标准输入读；只读被体检文件夹，不写任何文件，结果只打在屏幕上）
// 模板\、做法\ 按本脚本的位置找；学员项目只认命令里给的完整路径。
// 只往学员项目里写，结果写进 docs\check\<命令>.txt，第一行：项目完整路径｜命令｜站号或票号｜总结果。
// 退出码：结果文件写成就是 0（通过、不通过都是 0；缺运行表、表的格式错都算不通过）；拒绝执行、写不成是 1。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const COACH = fs.realpathSync.native(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const PLATFORM = new Set(['.workbuddy', '.claude', '.codex', '.git']); // 平台自建，不算
const NOTES = ['（至少一份文件）', '（可有可无）', '（表头写了"不画图"时可有可无）'];
const CODEBUDDY = '本课程不用这个配置；其中的 CODEBUDDY.md 会让 WorkBuddy 跳过 AGENTS.md，rules 会另外注入规矩';
const BASE = 'docs\\check\\materials-基线.txt';

class Stop extends Error {}
const stop = (m) => { throw new Stop(m); };
const lexists = (p) => !!fs.lstatSync(p, { throwIfNoEntry: false });
const inside = (base, p) => { const r = path.relative(base, p); return r === '' || !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r)); };
const pad = (n) => String(n).padStart(2, '0');
const d = new Date(), TODAY = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// 真实路径：最深的已有那一级解开联接，再接上还没建的部分
function real(p) {
  const rest = [];
  while (!lexists(p)) { const up = path.dirname(p); if (up === p) break; rest.unshift(path.basename(p)); p = up; }
  return path.join(fs.realpathSync.native(p), ...rest);
}
// ponytail: 瞬态锁只认全名；shortcut: 出现新工具锁时逐名补，保留业务同后缀文件。
const deliveryLocks = ['.archify-delivery-lock.json', 'run-flow.delivery-lock.json', 'run-flow.delivery-pending.json'];
const junkNames = new Set(['thumbs.db', 'desktop.ini', '.ds_store', ...deliveryLocks]);
const JUNK = (n) => n.startsWith('~$') || junkNames.has(n.toLowerCase());
const isJunkFile = (e) => e.isFile() && JUNK(e.name);
// 所有文件（不跟联接，不算 JUNK）
const filesUnder = (abs) => fs.readdirSync(abs, { withFileTypes: true }).filter((e) => !isJunkFile(e))
  .flatMap((e) => (e.isDirectory() ? filesUnder(path.join(abs, e.name)) : [path.join(abs, e.name)]));
// 文件名规则里的 * 表示任意字符
const glob = (s, flags = '') => new RegExp('^' + s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', flags);

const [cmd, arg, extra, ...more] = process.argv.slice(2);
const out = [];
const scanFacts = [];
let PROJ = '', SRC = '', label = '—', bad = 0, canReport = false; // SRC：scan 的被体检文件夹
const ok = (m) => out.push('✓ ' + m);
const no = (m) => { bad++; out.push('✗ ' + m); };
const note = (m) => out.push('· ' + m);

// 目标和材料根都解开已有联接；每次重算，只守串行写入边界。
function inMaterials(target, root = PROJ) {
  const mat = real(path.join(root, 'materials'));
  if (inside(mat, target)) return true;
  if (!inside(root, mat) || !fs.statSync(mat, { throwIfNoEntry: false })?.isDirectory()) return false;
  return filesUnder(mat).some((file) => {
    if (!fs.lstatSync(file).isSymbolicLink()) return false;
    let destination;
    try { destination = real(file); } catch { return false; } // 断链没有可写目标
    return inside(destination, target);
  });
}
// 只写进学员项目，不写进 materials，不写进教练文件夹；先核后写
function guard(rel, isMaterials = false) {
  const t = real(path.join(PROJ, rel));
  if (!inside(PROJ, t)) stop(`不写：${t} 在学员项目外面`);
  if (inside(COACH, t)) stop(`不写：${t} 在教练文件夹里面`);
  if (SRC && inside(SRC, t)) stop(`不写：${t} 在被体检文件夹里面`);
  if (!isMaterials && (inside(path.join(PROJ, 'materials'), path.join(PROJ, rel)) || inMaterials(t))) stop(`不写：${t} 在 materials 里，materials 只读`);
  return t;
}
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function writeIn(rel, text, { atomic = false } = {}) {
  guard(rel);
  const target = path.join(PROJ, rel), tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 先写新文件再换名：目标要是材料的硬链接，换名只换掉这个目录项，材料原件不动
  guard(path.relative(PROJ, tmp));
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, target); return; } catch (e) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        if (i < 5) { nap(60 * (i + 1)); continue; }
        // 别的程序一直开着这份文件，换名不成：它不是硬链接，就直接写；是硬链接就不写，免得改到材料
        if (atomic || (fs.statSync(target, { throwIfNoEntry: false })?.nlink ?? 1) !== 1) throw e;
        fs.writeFileSync(target, text);
        return;
      }
    }
  } finally { fs.rmSync(tmp, { force: true }); }
}
function reportFailure(unlocated) {
  const places={
    scan:['项目体检','给我看本次卡点'],
    files:['第 '+extra+' 站「'+['','建项目','说清／拆开需求','排表画图','一步一票','收尾交接'][Number(extra)]+'」','给我看第 '+extra+' 站缺项'],
    flow:['第 3 站「排表画图」','给我看运行表断在哪'],
    accept:['第 4 站「一步一票」票 '+pad(Number(extra)),'给我看这张票的差异'],
  };
  if (!Object.hasOwn(places,cmd)) return;
  const [where,action]=unlocated ? ['项目检查','帮我核对项目和报告位置'] : places[cmd];
  console.log('📍 当前进度：'+where+'｜正在做：核对未通过项');
  console.log('👉 你现在只需要回：「'+action+'」');
  console.log('未通过：禁止报修好/已通过');
}
function finish(verdict, saveFingerprint) {
  const lines = [`${PROJ}｜${cmd}｜${label}｜${verdict}`, ...out];
  const text = (cmd==='scan' ? lines.map(redactMemoryText) : lines).join('\n') + '\n';
  if (cmd==='scan') publishScan(text);
  else writeIn(`docs\\check\\${cmd}.txt`, text);
  saveFingerprint?.();
  console.log(text.split('\n')[0]);
  console.log(`全文在 ${path.join(PROJ, 'docs', 'check', cmd + '.txt')}`);
  if (verdict!=='通过') reportFailure(verdict==='没跑成');
}

function init() {
  label = '第 1 站';
  const ver = fs.readFileSync(path.join(COACH, 'AGENTS.md'), 'utf8').split(/\r?\n/)[0].match(/v\d+\.\d+\.\d+/)?.[0] ?? stop('教练 AGENTS.md 第 1 行须有三段版本号 vX.Y.Z');
  const tpl = [['AGENTS.模板.md', 'AGENTS.md'], ['CLAUDE.模板.md', 'CLAUDE.md'], ['README.模板.md', 'README.md'], ['docs\\PROJECT_INDEX.模板.md', 'docs\\PROJECT_INDEX.md']]
    .map(([from, to]) => [to, fs.readFileSync(path.join(COACH, '模板', from), 'utf8')]);
  guard('materials', true);
  if (lexists(PROJ)) {
    if (!fs.statSync(PROJ).isDirectory()) stop(`${PROJ} 是一个文件，不是文件夹`);
    // 判空：不算平台文件夹、docs\check（脚本自己写的）、materials\ 里的原件和 JUNK
    const own = filesUnder(PROJ).map((f) => path.relative(PROJ, f))
      .filter((r) => !PLATFORM.has(r.split(path.sep)[0].toLowerCase()) && !r.toLowerCase().startsWith('docs\\check\\') && !r.toLowerCase().startsWith('materials\\'));
    if (own.length && !lexists(path.join(PROJ, 'docs', 'PROJECT_INDEX.md')))
      stop(`${PROJ} 里已经有东西，又没有 docs\\PROJECT_INDEX.md，不当新项目建。里面有：${[...new Set(own.map((r) => r.split(path.sep)[0]))].join('、')}。请问学员怎么处理`);
    // 旧网页等别的做法也有进度记录，但没有"当前站"：不是本教练的项目，一个字节都不补
    const idx = path.join(PROJ, 'docs', 'PROJECT_INDEX.md');
    if (lexists(idx) && !/^当前站：/m.test(fs.readFileSync(idx, 'utf8')))
      stop(`${idx} 里没有"当前站："这一行，不是本教练建的项目，不往里补文件。请问学员：体检这个文件夹，还是另建一个新项目`);
  }
  // 先把要写的位置全核一遍，有一处不行就一个文件都不写
  for (const [to] of tpl) guard(to);
  guard('docs\\check\\init.txt');
  const fill = (t) => t.replaceAll('{{项目名}}', path.basename(PROJ)).replaceAll('{{日期}}', TODAY).replaceAll('{{教练版本}}', ver);
  fs.mkdirSync(PROJ, { recursive: true });
  for (const [to, t] of tpl) {
    if (lexists(path.join(PROJ, to))) note(`已有 ${to}，没动`);
    else { writeIn(to, fill(t)); ok(`建了 ${to}`); }
  }
  if (lexists(path.join(PROJ, 'materials'))) note('已有 materials\\，没动');
  else { fs.mkdirSync(path.join(PROJ, 'materials')); ok('建了空的 materials\\'); }
}

// 读做法\<站号>-*.md 的"## 本站完成清单"，同站几份必须逐字相同
function readList(n) {
  const dir = path.join(COACH, '做法');
  const names = fs.readdirSync(dir).filter((f) => f.startsWith(n + '-') && f.endsWith('.md'));
  if (!names.length) stop(`做法 里没有 ${n}-*.md`);
  const lists = names.map((f) => {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
    const i = lines.findIndex((l) => l.trim() === '## 本站完成清单');
    if (i < 0) stop(`做法\\${f} 里没有"## 本站完成清单"`);
    const end = lines.findIndex((l, k) => k > i && l.startsWith('## '));
    return lines.slice(i + 1, end < 0 ? undefined : end).map((l) => l.trim()).filter((l) => l.startsWith('- '));
  });
  if (lists.some((l) => l.join('\n') !== lists[0].join('\n'))) stop(`${names.join('、')} 的本站完成清单不一样，要逐字相同`);
  return lists[0].map((l) => {
    const [, raw, n0 = ''] = l.slice(2).trim().match(/^(.*?)(（[^（）]*）)?$/);
    const p = raw.trim().replaceAll('/', '\\'), mark = n0.replace(/[“”]/g, '"');
    if (mark && !NOTES.includes(mark)) stop(`清单项"${l}"的括号不认识，只认：${NOTES.join('、')}`);
    const segs = p.replace(/\\$/, '').split('\\');
    return { p, mark, folder: p.endsWith('\\'), segs: segs.map((s) => glob(s)), dirs: 0, files: 0 };
  });
}

// 读 做法\架构推荐表.md 的表：信号 → 架构。表头不逐字相同、信号重复，算没跑成（教练包坏了，不是学员的错）
const REC_HEAD = ['信号', '学员常这样说', '架构（白话名＋六类叫法）', '第一版', '停不停'];
const PLUS = '＋做完按清单查';
function readRec() {
  const f = path.join(COACH, '做法', '架构推荐表.md');
  const lines = fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  const k = lines.findIndex((l) => l.startsWith('|')), rows = [];
  for (let j = k; k >= 0 && j < lines.length && lines[j].startsWith('|'); j++) rows.push(lines[j].replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  if (rows[0]?.join('｜') !== REC_HEAD.join('｜') || !rows[1]?.every((c) => /^:?-{3,}:?$/.test(c)))
    stop(`做法\\架构推荐表.md 的表头要逐字是：｜${REC_HEAD.join('｜')}｜，下面一行是分隔行`);
  const rec = new Map();
  for (const r of rows.slice(2)) {
    if (r.length !== REC_HEAD.length || rec.has(r[0])) stop(`做法\\架构推荐表.md 的"${r[0]}"这一行${rec.has(r[0]) ? '信号重复' : `有 ${r.length} 格，要 ${REC_HEAD.length} 格`}`);
    rec.set(r[0], r[2]);
  }
  return rec;
}

const noPlus = (a) => (a.endsWith(PLUS) ? a.slice(0, -PLUS.length).trim() : a);
// 任务单⑥这一节：sec 是节内各行，get(键) 取"键：值"的值，line(正则) 取第一处匹配的行号（没有回 0）；没有这一节回 null（files、scan 共用）
function sixOf(lines) {
  const i = lines.findIndex((l) => /^##\s*⑥/.test(l));
  if (i < 0) return null;
  const sec = below(lines, i);
  const get = (k) => sec.map((l) => l.match(new RegExp(`^\\s*${k}\\s*[：:](.*)$`))).find(Boolean)?.[1].trim() ?? null;
  const line = (re) => { const k = sec.findIndex((l) => re.test(l)); return k < 0 ? 0 : i + k + 2; };
  return { sec, get, line };
}

// 任务单⑥（第 2 站起每站核）：旧写法只记一行；新写法照推荐表核信号、架构或你改成、因为、第一版
function six(rec) {
  const f = path.join(PROJ, 'docs', 'INTAKE.md');
  if (!lexists(f)) return; // 缺任务单，清单那里已点名
  const x = sixOf(fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split(/\r?\n/));
  if (!x) return no('docs\\INTAKE.md 里没有"## ⑥"这一节');
  const { sec, get } = x;
  const sig = get('信号');
  if (sig === null) {
    if (sec.some((l) => /第\s*\d\s*种/.test(l))) return note('⑥ 旧写法，不核架构');
    return no('⑥ 缺"信号："一行（新写法四行：信号、架构、因为、第一版，格式见 做法\\架构推荐表.md）');
  }
  const before = bad, s = sig.split('｜')[0].trim(), changed = get('你改成')?.split('｜')[0].trim() ?? null;
  const plusOk = (a) => !a.endsWith(PLUS) || [rec.get('分类'), rec.get('固定')].includes(noPlus(a));
  const arch = changed ?? get('架构') ?? '';
  if (!rec.has(s)) no(`⑥ 信号"${s}"不在推荐表里，只认：${[...rec.keys()].join('、')}`);
  if (changed !== null) { // 学员改了推荐：改核他定的，要是表里的某个架构名
    if (![...rec.values()].includes(noPlus(arch))) no(`⑥ 你改成"${arch}"不是推荐表里的架构名`);
    else if (!plusOk(arch)) no(`⑥ 你改成"${arch}"：${PLUS}只准跟在"分类""固定"的架构后面`);
  } else if (rec.has(s)) {
    if (noPlus(arch) !== rec.get(s)) no(`⑥ 架构写的是"${arch}"，信号"${s}"按推荐表应是 ${rec.get(s)}`);
    else if (!plusOk(arch)) no(`⑥ 架构"${arch}"：${PLUS}只准跟在"分类""固定"的架构后面`);
  }
  for (const key of ['因为', '第一版']) if (!get(key)) no(`⑥ "${key}"是空的`);
  if (bad === before) ok(`⑥ 信号"${s}"，架构 ${arch}${changed !== null ? '（你改成）' : ''}`);
}

// 按清单清点 dir（只读）：给每项数 dirs、files，回不在清单里的多出项。files 和 scan 共用
function tally(dir, items) {
  const extras = [];
  const visit = (segs) => {
    for (const e of fs.readdirSync(path.join(dir, ...segs), { withFileTypes: true })) {
      const s = [...segs, e.name], rel = s.join('\\') + (e.isDirectory() ? '\\' : '');
      if (isJunkFile(e) || (s.length === 1 && PLATFORM.has(e.name.toLowerCase())) || s.join('\\').toLowerCase() === 'docs\\check') continue;
      if (s.length === 1 && /^(codebuddy\.md|\.codebuddy)$/i.test(e.name)) { extras.push(`${rel}：${CODEBUDDY}`); continue; }
      // 清单项带 \ 的是文件夹；不带的是文件（"至少一份文件"的项可以是文件夹，数里面的文件）
      const hits = items.filter((it) => it.segs.length === s.length && it.segs.every((g, i) => g.test(s[i])) && (it.folder ? e.isDirectory() : it.mark === NOTES[0] || e.isFile()));
      if (hits.length) {
        const n = e.isDirectory() ? filesUnder(path.join(dir, ...s)).filter((f) => fs.lstatSync(f).isFile()).length : e.isFile() ? 1 : 0;
        for (const it of hits) { it.dirs++; it.files += n; }
      } else if (e.isDirectory() && items.some((it) => it.segs.length > s.length && s.every((x, i) => it.segs[i].test(x)))) visit(s);
      else extras.push(`多出 ${rel}：不在本站清单里`);
    }
  };
  visit([]);
  return extras;
}
// tally 之后：清单里还缺的项（completion 两种类型共用）
const lacking = (items) => items.filter((it) => it.mark !== NOTES[1] && !(it.folder && it.mark !== NOTES[0] ? it.dirs : it.files));

const baselineRows = (text) => text.split(/\r?\n/).slice(1).filter(Boolean)
  .map((l) => { const [file, ...value] = l.split('｜'); return [file, value.join('｜')]; })
  .filter(([file]) => !JUNK(path.win32.basename(file)));

function files() {
  if (!/^[1-5]$/.test(extra ?? '')) stop(`站号要写 1 到 5，现在是"${extra ?? ''}"`);
  label = `第 ${extra} 站`;
  const items = readList(extra), rec = extra === '1' ? null : readRec();
  const rf = path.join(PROJ, 'docs', 'run-flow.md');
  const rfLines = lexists(rf) ? fs.readFileSync(rf, 'utf8').split(/\r?\n/) : [];
  const noDraw = noDrawOf(rfLines); // 只看第一张表之前的表头
  const extras = tally(PROJ, items);

  for (const it of items) {
    const have = it.folder && it.mark !== NOTES[0] ? it.dirs : it.files;
    if (have) ok(it.p);
    else if (it.mark === NOTES[1] || (it.mark === NOTES[2] && noDraw)) note(`没有 ${it.p}，本站可有可无`);
    else if (it.folder && it.dirs) no(it.p === 'materials\\' ? 'materials 里还没有样例' : `${it.p} 里还没有文件`);
    else no(`缺 ${it.p}`);
  }
  extras.forEach((m) => no(m));
  const idx = path.join(PROJ, 'docs', 'PROJECT_INDEX.md');
  if (lexists(path.join(PROJ, 'docs', 'rules')) || (lexists(idx) && /docs[\\/]rules/i.test(fs.readFileSync(idx, 'utf8')))) ruleFiles(readTree(PROJ,'references'), PROJ);
  if (rec) six(rec);
  if (extra==='5') {
    const indexText=safelyRead(PROJ,'docs\\PROJECT_INDEX.md') ?? '';
    const mode=adoption(indexText);
    if (mode!=='stopped') {
      if (mode==='adopted') checkHandover(indexText,safelyRead(PROJ,'AGENTS.md'),safelyRead(PROJ,'README.md'),true);
      else if (mode==='handover') note('内容④：采用前更新 docs\\PROJECT_INDEX.md 的换对话活动字段');
      const saved=[bad,out.length];
      let rows;
      try { rows=table(rfLines,'运行表',FLOW_HEAD); } finally { [bad,out.length]=saved; }
      const base=mapEntry(PROJ,'docs\\tickets');
      const tickets=(base.st?.isDirectory()?fs.readdirSync(base.abs):[]).filter(name=>/^\d\d-.*\.md$/i.test(name)).map(name=>{
        const rel='docs\\tickets\\'+name, text=safelyRead(PROJ,rel);
        return {N:Number(name.slice(0,2)),f:{rel},doc:text===null?null:ticketDocument(text)};
      }).filter(x=>x.doc);
      externalDeliveries(PROJ,indexText,{rows},tickets,safelyRead(PROJ,'docs\\INTAKE.md'),mode);
    }
  }

  // materials 基线：第一次通过时写，以后比对。新增只列出；改了、删了判不通过
  const mat = path.join(PROJ, 'materials');
  const cur = new Map();
  const matStat = fs.lstatSync(mat, { throwIfNoEntry: false });
  if (matStat?.isSymbolicLink()) no('材料目录是联接，不能建立或核对材料基线');
  let materialSnapshotValid = !matStat?.isSymbolicLink();
  if (matStat?.isDirectory() && !matStat.isSymbolicLink()) for (const f of filesUnder(mat)) {
    const rel = path.relative(PROJ, f);
    if (!fs.lstatSync(f).isFile() || !inside(mat, real(f))) {
      no(`${rel} 不是材料目录内的普通文件，未读取或登记基线`);
      materialSnapshotValid = false;
      continue;
    }
    const bytes = fs.readFileSync(f);
    cur.set(rel, `${bytes.length}｜${createHash('sha256').update(bytes).digest('hex')}`);
  }
  if (!materialSnapshotValid) return;
  if (lexists(path.join(PROJ, BASE))) {
    const base = new Map(baselineRows(fs.readFileSync(path.join(PROJ, BASE), 'utf8')));
    let same = 0;
    for (const [f, v] of base) {
      if (!cur.has(f)) no(`${f} 被删了（materials 基线里有它）`);
      else if (cur.get(f) !== v) no(`${f} 被改了（和 materials 基线不一样）`);
      else same++;
    }
    if (same === base.size) ok(`materials 基线里的 ${same} 份文件都没变`);
    for (const f of cur.keys()) if (!base.has(f)) note(`新增 ${f}（基线里没有，不算错）`);
  } else {
    const baseText = (how) => [`materials 基线｜${TODAY}｜第 ${extra} 站 ${how}｜文件｜字节｜SHA-256`, ...[...cur].map(([f, v]) => `${f}｜${v}`)].join('\n') + '\n';
    if (extra !== '1') {
      // 基线丢了（样例换了时是教练删的）：补建，但这次判不通过，让学员先确认文件都对；下次再跑才通过
      writeIn(BASE, baseText('基线丢了，按当时的 materials 补建'));
      no(`materials 基线丢了，已按现在的 materials 补建（${cur.size} 份文件）。请学员确认 materials 里的文件都是他要用的（换过样例的，只换了他说的那几份），再跑一次`);
    } else if (!bad) {
      writeIn(BASE, baseText('files 第一次通过时写，以后只比对'));
      ok(`写好 materials 基线 ${BASE}（${cur.size} 份文件）`);
    }
  }
}

// ---------- 读 docs\run-flow.md（格式照 模板\docs\run-flow.模板.md） ----------
const INPUT_HEAD = ['输入 N', '放哪', '文件名规则', '必须有的栏目（含单位；缺栏目怎么办）', '一次几份', '样例文件', '反例文件'];
const FLOW_HEAD = ['第几步', '谁做', '从哪拿', '做什么', '放到哪', '你要判断什么'];
const WHO = ['AI照规矩', 'AI看情况', '你'];
const items = (s) => (s === '—' ? [] : s.split('、').map((x) => x.trim()).filter(Boolean));
// 编号后面可以带括号说明，如"输入 1（本周日报）"
const inputId = (s) => { const m = s.match(/^输入\s*(\d+)\s*(?:[（(][^（()）]*[）)])?$/); return m ? `输入 ${Number(m[1])}` : null; };
// 第一张表之前的文字，就是表头状态行（流程就这样、不画图）
const headOf = (lines) => { const k = lines.findIndex((l) => l.trim().startsWith('|')); return (k < 0 ? lines : lines.slice(0, k)).join('\n'); };
// 已确认的本轮图决定单独记表头；历史不画图保留，不能盖过当前要求。
function noDrawOf(lines) {
  const head = headOf(lines), choices = new Set([...head.matchAll(/^本轮图[：:]\s*(出图|不画图)\s*$/gm)].map((m) => m[1]));
  if (choices.size > 1) { no('本轮图决定冲突，图要求未核，请澄清确认记录'); return null; }
  return choices.size ? choices.has('不画图') : head.includes('不画图');
}

// 没有运行表：判不通过，回 null。dir 默认学员项目；scan 传被体检文件夹（只读）
function flowLines(dir = PROJ) {
  const f = path.join(dir, 'docs', 'run-flow.md');
  let text;
  try { text = cmd === 'flow' || cmd === 'scan' ? mapText(dir, RUN_MD) : lexists(f) ? fs.readFileSync(f, 'utf8') : null; }
  catch (error) { no(RUN_MD + ' 未核：' + (error.code ?? error.message)); return null; }
  if (text === null) { no('缺 ' + RUN_MD); return null; }
  return text.replace(/^\uFEFF/, '').split(/\r?\n/);
}
// "## <名字>"下面的第一张表，只回数据行。
// 格式错（缺这一节、表头不逐字相同、第二行不是分隔行、某行格数不对）逐条点名，回 null：算不通过，不算没跑成
function table(lines, name, head) {
  if (!lines) return null;
  const i = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (i < 0) { no(`docs\\run-flow.md 里没有"## ${name}"`); return null; }
  let k = i + 1;
  while (k < lines.length && !lines[k].trim().startsWith('|') && !lines[k].startsWith('## ')) k++;
  const rows = [];
  for (; k < lines.length && lines[k].trim().startsWith('|'); k++) rows.push(lines[k].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const before = bad;
  if (rows[0]?.join('｜') !== head.join('｜')) no(`"${name}"表头要逐字是：｜${head.join('｜')}｜，现在是：${rows[0] ? `｜${rows[0].join('｜')}｜` : '没有表'}`);
  else if (rows[1]?.length !== head.length || !rows[1].every((c) => /^:?-{3,}:?$/.test(c))) no(`"${name}"表头下面一行要是 |---|---|…这样的分隔行，一栏一个 ---`);
  else rows.slice(2).forEach((r, j) => { if (r.length !== head.length) no(`"${name}"第 ${j + 1} 行有 ${r.length} 格，要 ${head.length} 格`); });
  return bad > before ? null : rows.slice(2);
}

// 认出输入演习：输入清单的每个输入在"放哪"里找到了哪几份
function inputs() {
  label = '第 3 站';
  const seen = new Set();
  const rows = table(flowLines(), '输入清单', INPUT_HEAD);
  if (!rows) return;
  const ins = rows.map(([id, dir, rule, , many, sample, counter], j) => {
    const name = inputId(id) ?? id;
    if (!inputId(id)) no(`输入清单第 ${j + 1} 行的编号写的是"${id}"，要写成"输入 1"这样`);
    else if (seen.has(name)) no(`${name} 写了两次，输入编号不能重复`);
    seen.add(name);
    const at = dir.replace(/\\?$/, '\\');
    const badDir = !/^(inputs\\\d\d-[^\\]+\\|materials\\)/i.test(at) || at.split('\\').includes('..');
    if (badDir) no(`${name} 的"放哪"要是 inputs\\<两位步号>-<短名>\\（旧项目 materials\\）或它里面的文件夹，现在是"${dir}"`);
    // 文件名规则：第一个"；"之前是带 <参数> 的文件名，<…> 都换成同一格"本次 <值>"的值
    let pat = rule.split('；')[0].trim();
    if (/<[^<>]+>/.test(pat)) {
      const now = rule.match(/本次\s*([^；]+)/)?.[1].trim();
      if (now) pat = pat.replace(/<[^<>]+>/g, now);
      else no(`${name} 的文件名规则里有 <…>，同一格要写"本次 <值>"`);
    }
    if (!['一份', '一组'].includes(many)) no(`${name} 的"一次几份"只许写"一份"或"一组"，现在是"${many}"`);
    return { name, dir: at, badDir, pat, re: glob(pat, 'i'), many, sample, counter, found: [] };
  });
  if (!ins.length) no('输入清单一行都没有');
  // 一个文件认成哪几个输入：在它的"放哪"文件夹里（不含子文件夹），文件名合规则
  const who = (rel) => ins.filter((i) => (path.dirname(rel) + '\\').toLowerCase() === i.dir.toLowerCase() && i.re.test(path.basename(rel)));
  // 两行"放哪"只差大小写时按小写去重，不然同一份文件会列两次、误报"找到 2 份"
  const dirs = [...new Map(ins.filter((i) => !i.badDir).map((i) => [i.dir.toLowerCase(), i.dir])).values()];
  const all = [...new Map(dirs.flatMap((d) => { const a = path.join(PROJ, d); let t; try { t = real(a); } catch { return []; } return inside(PROJ, t) && fs.statSync(t, { throwIfNoEntry: false })?.isDirectory() ? filesUnder(a).map((f) => path.relative(PROJ, f)) : []; }).map((f) => [f.toLowerCase(), f])).values()].sort();
  for (const f of all) {
    const hit = who(f);
    hit.forEach((i) => i.found.push(f));
    if (hit.length > 1) no(`${f} 同时被认成 ${hit.map((i) => i.name).join('、')}，每个文件最多认成一个输入，要改文件名规则`);
  }
  // 样例、反例先换成规范路径（解开 .. 和联接）再比，写成 materials\..\materials\x 的也认得出是同一份
  const canon = (s) => { try { return path.relative(PROJ, real(path.join(PROJ, s.replaceAll('/', '\\')))); } catch { return s; } };
  for (const i of ins) {
    if (!i.found.length) no(`${i.name}（${i.many}）一份都没找到：${i.dir} 里没有文件名像"${i.pat}"的文件`);
    else if (i.many === '一份' && i.found.length > 1) no(`${i.name}（一份）应该一份，找到 ${i.found.length} 份：${i.found.join('、')}。停下问学员用哪份`);
    else ok(`${i.name}（${i.many}）认出 ${i.found.length} 份：${i.found.join('、')}`);
    // 样例可以写几份，用"、"隔开；斜杠统一成反斜杠、不分大小写再比
    const low = (s) => s.replaceAll('/', '\\').toLowerCase(), samples = items(i.sample);
    if (!samples.length) no(`${i.name} 没写样例文件`);
    for (const s of samples) if (!i.found.some((f) => low(f) === low(canon(s)))) no(`${i.name} 的样例 ${s} ${lexists(path.join(PROJ, s)) ? `没被认成 ${i.name}` : '不在'}`);
    if (i.counter === '—' || !i.counter) { note(`${i.name} 反例未测（反例文件写的是"${i.counter || '空的'}"），不算验过`); continue; }
    // 反例只在被认成它自己这个输入时算错；被认成别的输入常常是对的（上周日报最像本周日报）
    const cr = canon(i.counter);
    const hit = inside(PROJ, path.join(PROJ, cr)) && fs.statSync(path.join(PROJ, cr), { throwIfNoEntry: false })?.isFile() ? who(cr) : null;
    if (!hit) no(`${i.name} 的反例 ${i.counter} 不在`);
    else if (hit.includes(i)) no(`${i.name} 的反例 ${i.counter} 被认成了 ${i.name}`);
    else if (hit.length) ok(`${i.name} 的反例 ${i.counter} 没被认成 ${i.name}（它被认成了 ${hit.map((x) => x.name).join('、')}）`);
    else ok(`${i.name} 的反例 ${i.counter} 没被认走`);
  }
  const counters = new Set(ins.filter((i) => i.counter && i.counter !== '—').map((i) => canon(i.counter).toLowerCase()));
  for (const f of all) if (!who(f).length && !counters.has(f.toLowerCase())) note(`${f} 没被认成任何输入`);
}

// 输入清单各行"放哪"去重（flow 的图源和文字版共用）
const dirsOf = (inRows) => [...new Set(inRows.map((r) => r[1].trim()))];
// 运行表的数据行 → 步（flow、scan 共用）
const stepsOf = (rows, root = SRC || PROJ, literal = false) => {
  const declared = new Set();
  for (const r of rows) for (const x of splitIO(r[4]).tokens) {
    if (x && !/[（）()]/.test(x)) declared.add(ioKey(x));
  }
  return rows.map(([n, who, from, what, to, judge]) => {
  const tail = judge === '—' ? '' : (judge.split('｜')[2] ?? '');
  // ponytail: 按“退回第K步”拆分句；shortcut: 只认明写的步号，并列条件无法对应目标时交人工核，需自动判定时再扩展语法。
  const returns = [...tail.matchAll(/([^]*?)退回第\s*(\d+)\s*步/g)].map((m) =>
    ({ to: Number(m[2]), label: m[0].replace(/^[，,；;。\s]+/, '').trim() }));
  const unclear = returns.length > 1 && returns.some((r) => /^(?:退回|[或和及、]\s*(?:退回)?)/.test(r.label));
    const input = literal ? {refs:items(from),pending:[]} : ioRefs(from,root,declared);
    const output = literal ? {refs:items(to),pending:[]} : ioRefs(to,root,declared);
    return { n, who, from: input.refs, what, short: what.split(/[：:]/)[0].trim(), to: output.refs, judge,
      pendingIO: [...input.pending,...output.pending], back: [...new Set(returns.map((r) => r.to))], returns, unclear };
  });
};
// 读写栏只拆括号外的列表。其它字段和签名仍用原字节。
const bareInput = s => {
  const m = /^输入\s*(\d+)$/.exec(s);
  return m ? '输入 ' + Number(m[1]) : null;
};
const ioKey = s => bareInput(s) ?? path.win32.normalize(s).toLowerCase();
const pathLike = s => /^[a-z]:|^[\\/]|^\.\.?[\\/]|[\\]/i.test(s) ||
  /^(?:materials|inputs|work|output|docs|scripts)\//i.test(s) || /^[^\\/\r\n]{1,120}\.[\p{L}\p{N}]{1,12}$/u.test(s);
function splitIO(value) {
  const spans = [], stack = [], tokens = [];
  let start = 0, off = 0, balanced = true;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '(' || ch === '（') {
      if (!stack.length) off = i;
      stack.push(ch === '(' ? ')' : '）');
    } else if (ch === ')' || ch === '）') {
      if (stack.pop() !== ch) balanced = false;
      if (!stack.length) spans.push([off, i + 1]);
    } else if (!stack.length && (ch === '、' ||
      ((ch === '+' || ch === '＋') && /\s/.test(value[i - 1] ?? '') && /\s/.test(value[i + 1] ?? '')))) {
      tokens.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  tokens.push(value.slice(start).trim());
  return { tokens, spans, balanced: balanced && !stack.length };
}

function ioRefs(value, root, declared = new Set()) {
  const refs = [], pending = [];
  if (!value || value.trim() === '—') return { refs, pending };
  const literal = ref => {
    if (!pathLike(ref) || /[<>]/.test(ref)) return false;
    try { return !!mapEntry(root, ref).st || declared.has(ioKey(ref)); }
    catch (error) {
      return /联接|硬链接|有别名/.test(error.message);
    }
  };
  const {tokens} = splitIO(value);
  if (tokens.length > 1 && literal(value)) return { refs: [value], pending };
  for (const term of tokens) {
    if (!term) { pending.push('列表有空项'); continue; }
    const parsed = splitIO(term);
    let cut = term.length;
    for (const [start, end] of parsed.spans.toReversed()) {
      if (term.slice(end, cut).trim()) break;
      cut = start;
    }
    const head = term.slice(0, cut).trim(), annotation = term.slice(cut);
    const full = literal(term), simple = bareInput(head) || pathLike(head);
    if (full && annotation && literal(head)) {
      pending.push('整项和去说明后都能指到文件：' + term);
    } else if (full) refs.push(term);
    else if (!parsed.balanced || !simple) {
      if (pathLike(term) && /^(?:[a-z]:|[\\/])|\\\.\.?(?:\\|$)/i.test(term)) refs.push(term);
      else pending.push('引用未能唯一判定：' + term);
    } else {
      refs.push(bareInput(head) ?? head);
      if (annotation && /(?:或|另产|另写|改写|可选|参考(?:案例|样例))/.test(annotation))
        pending.push('说明可能另有输入或交付：' + annotation);
    }
  }
  return { refs, pending };
}

function stepRefs(steps, N, ids) {
  return steps[N - 1].from.map(ref => {
    const input = inputId(ref);
    if (input) return { ref, source: ids.includes(input) ? 0 : null, reason: '不在输入清单里' };
    const made = steps.flatMap((s, i) => s.to.some(x => ioKey(x) === ioKey(ref)) ? [i + 1] : []);
    const K = made[0];
    return { ref, source: made.length === 1 && K < N ? K : null,
      reason: made.length > 1 ? '有多个生产步' : K === N ? '和本步的产物相同，不许自产自读' :
        K > N ? '是第 ' + K + ' 步才放的，不许引用后面的步' : '不是输入清单里的输入，也不是前面哪步的"放到哪"' };
  });
}
const fromErrs = (steps,N,ids) => stepRefs(steps,N,ids)
  .filter(r => r.source === null).map(r => '第 ' + N + ' 步"从哪拿"的 ' + r.ref + ' ' + r.reason);

function bindingsOf(inRows) {
  const values = new Map();
  for (const r of inRows) {
    const {keys,value} = inputPattern(r[2]);
    for (const key of keys) {
      if (!values.has(key)) values.set(key,value);
      else if (values.get(key) !== value) values.set(key,null);
    }
  }
  return values;
}

function physicalIO(rel, bindings) {
  if (!/[<>]/.test(rel)) return rel;
  const parts = rel.split('\\'), dynamic = parts.filter(p => /[<>]/.test(p));
  if (!rel.startsWith('output\\') || !rel.endsWith('\\') || dynamic.length !== 1 || !/^<[^<>\\]+>$/.test(dynamic[0]))
    badPath(rel, '不是安全的批次目录声明');
  mapParts(rel.replace(dynamic[0],'批次'));
  const name = dynamic[0].slice(1,-1);
  if (!bindings.has(name)) badPath(rel,'的参数未声明，待核');
  const value = bindings.get(name);
  if (value === null) badPath(rel,'的本批参数有不同取值');
  if (!value) return null;
  if (mapParts(value).length !== 1 || /[\\/]/.test(value)) badPath(rel,'的本批参数不是一个安全目录段');
  return parts.map(p => p === dynamic[0] ? value : p).join('\\');
}

function compareIO(root, step, field, actual, bindings, steps, ids, N) {
  const expected = field === '从哪拿' ? step.from : step.to;
  const wanted = new Set(expected.map(ioKey));
  const {refs,pending} = ioRefs(actual,root,wanted);
  const problems = [];
  for (const ref of refs) {
    const input = bareInput(ref);
    try {
      if (field === '放到哪' && !/^(work|output)\\[^\\]/.test(ref)) badPath(ref,'不在产物目录');
      if (!input) {
        const rel = physicalIO(ref,bindings);
        if (rel) mapEntry(root,rel);
        else pending.push('本批目录待核：' + ref);
      }
    } catch (error) { problems.push('有非法路径或范围：' + (error.code ?? error.message)); }
  }
  let comparable=refs;
  if (field==='从哪拿') {
    const possibleInput=expected.some(bareInput);
    const uncertain=possibleInput ? refs.filter(ref=>/^(?:materials|inputs)\\/i.test(ref) && !wanted.has(ioKey(ref))) : [];
    if (uncertain.length) pending.push('输入编号与这些具体文件是否同一来源待核：'+uncertain.join('、'));
    comparable=refs.filter(ref=>!uncertain.includes(ref));
    const withTicket=steps.map((s,i)=>i===N-1?{...s,from:comparable}:s);
    problems.push(...fromErrs(withTicket,N,ids));
  }
  const keys = comparable.map(ioKey);
  if (field==='放到哪' && new Set(keys).size<keys.length) problems.push('同一产物写了两次');
  const differ = keys.some(k => !wanted.has(k)) || (field === '放到哪' && keys.length && keys[0] !== ioKey(expected[0] ?? '—')) ||
    (new Set(keys).size !== wanted.size && !pending.length);
  return { problems, pending, differ };
}

// 同一张运行表，出图、刷新和只读核对都守原有步号及产物规则。
function validateFlow(root, inRows, flowRows) {
  const before = bad, ids = inRows.map((r) => inputId(r[0])).filter(Boolean);
  const steps = stepsOf(flowRows,root), W = steps.length, bindings = bindingsOf(inRows);
  if (!W) no('运行表一行都没有：第 1 步要是"认出输入"，最后一步要是"你"');
  if (W > 7) no(`运行表有 ${W} 步，第一版不超过 7 步（含认出输入、可选清洗与人工核对），先切一小块`);
  if (W && steps[0].short !== '认出输入') no(`第 1 步要是"认出输入"，现在是"${steps[0].short}"`);
  if (W && steps[W - 1].who !== '你') no(`最后一步要是"你"，现在第 ${W} 步是"${steps[W - 1].who}"`);
  const outs = []; // 每个"放到哪"的真实位置，最后比有没有两步写到同一处
  steps.forEach((s, j) => {
    const N = j + 1;
    if (s.n !== String(N)) no(`运行表第 ${N} 行的"第几步"写的是"${s.n}"，要从 1 起连着编`);
    if (!WHO.includes(s.who)) no(`第 ${N} 步"谁做"写的是"${s.who}"，只许 ${WHO.join('、')}`);
    if (!/[：:]/.test(s.what) || !s.short || [...s.short].length > 8) no(`第 ${N} 步"做什么"开头要是 8 字内的短名加"："，现在短名是"${s.short}"`);
    if (!/依据[：:]/.test(s.what)) no(`第 ${N} 步"做什么"里没有"依据："`);
    fromErrs(steps, N, ids).forEach(no);
    s.pendingIO.forEach(m => no('第 ' + N + ' 步读写待核：' + m));
    if (s.who !== '你' && !s.to.length) no(`第 ${N} 步是 AI 做的，"放到哪"不能写"—"`);
    for (const x of s.to) {
      if (x.includes('/') || !/^(work|output)\\[^\\]/.test(x)) {
        no(`第 ${N} 步"放到哪"的 ${x} 要在 work\\ 或 output\\ 下（用反斜杠；materials 只读）`);
        continue;
      }
      let t;
      try {
        const rel = physicalIO(x,bindings);
        t = rel ? mapEntry(root,rel).abs : path.join(root,x);
        if (!rel) note('第 ' + N + ' 步本批目录待核：' + x);
      } catch (e) { no('第 ' + N + ' 步"放到哪"的' + (e.code ?? e.message)); continue; }
      const top = path.relative(root,t).split(path.sep)[0].toLowerCase();
      if (!['work','output'].includes(top) || inMaterials(t, root)) no(`第 ${N} 步"放到哪"的 ${x} 落在材料或项目范围以外（materials 只读）`);
      else if (x.startsWith('work\\') && !x.startsWith(`work\\${pad(N)}-`)) no(`第 ${N} 步"放到哪"的 ${x} 在 work\\ 下，文件名要以步号开头：work\\${pad(N)}-…`);
      else outs.push({ N, x, k: t.replace(/\\+$/, '').toLowerCase(), dir: x.endsWith('\\') });
      if (!x.startsWith('output\\') && !steps.slice(N).some((p) => p.from.some(y => ioKey(y) === ioKey(x)))) no(`第 ${N} 步"放到哪"的 ${x} 后面没有哪步用上，也不在 output\\ 下（不是最终结果）`);
    }
    if (s.judge === '—') { if (s.who === '你') no(`第 ${N} 步是"你"，"你要判断什么"不能写"—"`); return; }
    const parts = s.judge.split('｜').map((x) => x.trim());
    if (parts.length !== 3 || parts.some((x) => !x)) no(`第 ${N} 步"你要判断什么"要写成：看什么｜按什么判｜不对退回第几步`);
    else if (!s.back.length || s.back.some((b) => b < 1 || b > N)) no(`第 ${N} 步"不对退回第几步"要写"退回第 K 步"，K 在 1 到 ${N} 之间`);
  });
  // 一处只能由一步写：同一处，或一步写进另一步的"放到哪"文件夹里，后写的会盖掉或冒充前一步的产出
  outs.forEach((a, i) => outs.slice(i + 1).forEach((b) => {
    if (a.k === b.k) no(a.N === b.N ? `第 ${a.N} 步"放到哪"把 ${b.x} 写了两次` : `第 ${a.N} 步和第 ${b.N} 步都写 ${b.x}：一步要写自己的新文件`);
    else if ((a.dir && b.k.startsWith(a.k + '\\')) || (b.dir && a.k.startsWith(b.k + '\\'))) no(`第 ${a.N} 步的 ${a.x} 和第 ${b.N} 步的 ${b.x} 一个在另一个的文件夹里：一步要写自己的新位置`);
  }));
  if (bad !== before) return null;
  steps.filter(s => s.unclear).forEach(s => note(`第 ${s.n} 步退回条件与目标无法唯一对应，图分支未核，请先澄清`));
  return { ids, steps };
}
function flow() {
  label = '第 3 站';
  const old = readProjectMap(PROJ);
  if (old.kind === 'bad') no(badMapMessage(old) + '；保留原件，请恢复可信原图或请学员移存后重画');
  const source = readFlowSource(PROJ), lines = flowLines();
  if (!lines) return;
  const noDraw = noDrawOf(lines), inRows = table(lines,'输入清单',INPUT_HEAD), rows = table(lines,'运行表',FLOW_HEAD);
  if (!inRows || !rows) { note('运行表格式没过，本次保留上一轮文件'); return; }
  const valid = validateFlow(PROJ,inRows,rows);
  if (!valid) { note('运行表没过，本次保留上一轮文件'); return; }
  const { steps, ids } = valid, title = mapTitle(lines);
  if (noDraw === null) return;
  ok(`运行表 ${steps.length} 步，规则都过了`);
  const dirs = dirsOf(inRows), json = swimlane(title,ids,steps,dirs), fl = { rows,inRows };
  if (extra==='--upgrade-map') return upgradeProjectMap(PROJ,old,source,lines,fl,noDraw,json);
  let makeSource = !source.broken && old.kind !== 'bad' && old.kind !== 'archify';
  if (old.kind === 'archify') {
    makeSource = checkArchifyMap(old,source,fl,noDraw,json) || (noDraw && !source.broken && !source.json);
  }
  if (makeSource) {
    mapEntry(PROJ, SELF);
    writeIn(SELF, JSON.stringify(json,null,2) + '\n', { atomic:true });
    ok(`写好 ${SELF}（由运行表生成）`);
  }
  mapEntry(PROJ, RUN_TXT);
  writeIn(RUN_TXT, [
    `运行表：${title}（由 docs\\run-flow.md 生成${noDraw ? '；这次不画图' : ''}）`,
    `开始：你把 ${ids.join('、')} 放进 ${dirs.join('、')}`, '',
    ...steps.flatMap((s,j) => [`第 ${j+1} 步 ${s.short}｜${s.who}`, `  读：${s.from.join('、') || '—'}`,
      `  写：${s.to.join('、') || '—'}`, ...(s.judge === '—' ? [] : [`  【你判断】${s.judge}`])]),
  ].join('\n') + '\n', { atomic:true });
  ok('写好文字版 ' + RUN_TXT);
  if (noDraw) note('运行表表头写了"不画图"，看文字版 ' + RUN_TXT);
  // 图源、 HTML 以及表互不掩盖错误。坏源未修前不发表新图。
  if (source.broken && !noDraw) return;
  verifyProjectMap(PROJ,old,lines,fl,extra === '--refresh',noDraw);
}

// ---------- 当前这张单、这次确认、这一轮、这批料 ----------
const MAP_FORMAT = 'agent-coach-live-map', VERIFY_ROW = '本批核验 ', SAMPLE_ROW = '实跑取样 ';
const MAP_ROLES = ['写死程序', 'AI 判断', '你拍板'];
const MAP_STATES = ['pending', 'locked', 'waiting', 'verified', 'blocked'];
const containsLocation = /(?:^|[^a-z0-9])[a-z]:[\\/]|\\\\[^\\]|(?:^|[\s（(])\/(?:[^/\s]+\/)+|file:\//i;
const validMapText = x => typeof x === 'string' && x.length > 0 && x.length <= 8192 && !containsLocation.test(x);
const mapTitle = lines => lines?.[0]?.match(/^#[ \t]*运行表[：:][ \t]*([\s\S]+)$/)?.[1].replace(/[ \t]+$/,'') || '项目活地图';
const mapPathKey = p => mapParts(p).join('\\').toLowerCase();
function mapPathsIn(text) {
  return [...text.matchAll(/(?:docs[\\/]rules|materials|inputs|scripts|work|output)[\\/][^、，。；：｜"'`<>\r\n]*?\.(?:md|txt|csv|json|[cm]?js|py|ps1|xlsx?|docx?|pdf)(?![a-z0-9.])/gi)].map(m => m[0].trim());
}
function inputPattern(rule) {
  const name = rule.split('；')[0].trim(), keys = [...new Set([...name.matchAll(/<([^<>]+)>/g)].map(m => m[1]))].sort();
  const value = keys.length ? rule.match(/本次\s*([^；]+)/)?.[1].trim() : '';
  return { keys, value, family: name.replace(/<[^<>]+>/g,'*'), name: name.replace(/<[^<>]+>/g, () => value || '_') };
}
function mapPlan(root, lines, inRows, rows) {
  const flow = [mapTitle(lines), inRows, rows], steps = stepsOf(rows,root), bindings = bindingsOf(inRows);
  for (const text of [flow[0], ...inRows.flat(), ...rows.flat()]) {
    if (text && !validMapText(text)) throw new MapPathError('运行表有绝对路径或文字超出检查范围');
  }
  const inputs = new Map();
  for (const row of inRows) {
    const [id, dir, rule, , count, sample, counter] = row, key = inputId(id);
    if (!key || inputs.has(key)) throw new Error('输入编号缺失或重复，请核运行表');
    const loc = mapEntry(root, dir);
    if (!/^(?:inputs|materials)(?:[\\/]|$)/i.test(dir) || (loc.st && !loc.st.isDirectory())) badPath(dir, '不在输入目录');
    const pattern = inputPattern(rule);
    if (mapParts(pattern.name.replaceAll('*', '_')).length !== 1) badPath(rule, '文件名规则不能含目录');
    for (const file of [...items(sample), ...items(counter)]) mapEntry(root, file);
    inputs.set(key, { loc, count, ...pattern, row });
  }
  for (const step of steps) {
    for (const out of step.to) { const rel = physicalIO(out,bindings); if (rel) mapEntry(root,rel); }
    for (const rel of [...mapPathsIn(step.what), ...mapPathsIn(step.judge)]) mapEntry(root,rel);
  }
  const indexRel = 'docs\\PROJECT_INDEX.md', index = mapText(root, indexRel) ?? '', indexDoc = mdTicket(index);
  const indexHead = indexDoc.top.find(h => isAtx(h, 2) && h.label === '已确认');
  const ticketDir = mapEntry(root, 'docs\\tickets');
  if (ticketDir.st && !ticketDir.st.isDirectory()) badPath(ticketDir.rel, '不是目录');
  const tickets = ticketDir.st ? fs.readdirSync(ticketDir.abs).sort() : [];
  return { root, flow, steps, inputs, bindings, index, indexRel, confirmed: indexedLines(indexDoc, indexHead, true), tickets, history: projectVersions(index) };
}
function indexedLines(doc, head, list = false) {
  if (!head) return [];
  return doc.rows.slice(head.after, head.end).flatMap((row, i) =>
    row.visible && !row.lazy && (!row.owner.length || (list && /^- /.test(row.visible)))
      ? [[row.visible, head.after + i + 1]] : []);
}
function fieldLines(lines, name) {
  const re = new RegExp('^-?\\s*' + name + '[：:]\\s*(.+)$');
  return lines.map(([text]) => re.exec(text)?.[1].trim()).filter(Boolean);
}
function uniqueField(lines, name) {
  const xs = fieldLines(lines, name);
  return xs.length === 1 && validMapText(xs[0]) && !/^<[^<>]*>$|^\.{3}$|^…$|^待填$/.test(xs[0]) ? xs[0] : null;
}
const unquotePath = x => {
  const p = x?.replace(/^`([^`]+)`$/, '$1');
  return p && /[\\/:]/.test(p) ? p : null;
};
const splitPathNote = x => (x ?? '').split(/\s*｜\s*/, 2);
const expectedSample = doc => {
  if (!doc.sheet) return null;
  const fields = indexedLines(doc, { after: doc.sheet.after, end: doc.self[0]?.start ?? doc.sheet.end }, true);
  const [good] = splitPathNote(uniqueField(fields, '用哪份样例'));
  const [bad, why] = splitPathNote(uniqueField(fields, '应判错的例子'));
  const value = uniqueField(fields, '应得结果'), source = uniqueField(fields, '预期值来源');
  return good || bad || value || source ? [unquotePath(good) || null, value, unquotePath(bad) || null, why || null, source] : null;
};
const tuple = (x, n) => Array.isArray(x) && x.length === n;
const positive = x => typeof x === 'string' && /^[1-9]\d*$/.test(x);
const golden = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const sampleShape = x => tuple(x, 6) && x.every(validMapText) && [0,1,3,4].every(i => { mapParts(x[i]); return true; });
const parameterShape = x => Array.isArray(x) && x.length <= 256 && x.every(p => tuple(p, 3) && p.every(validMapText) && inputId(p[0]) === p[0]);
function rowJson(lines, prefix) {
  const values = lines.filter(([line]) => line.startsWith(prefix));
  if (values.length !== 1) return null;
  try { return JSON.parse(values[0][0].slice(prefix.length)); } catch { return null; }
}
function mapFileSet(root) {
  const entries = new Map();
  const add = (rel, directory = false, nested = false) => {
    const entry = mapEntry(root, rel);
    if (!entry.st) throw new Error('应有文件不在：' + rel);
    if (directory) {
      if (!entry.st.isDirectory()) throw new Error('应是文件夹：' + rel);
      const first = entries.size;
      if (root===SRC && scanTree) {
        const prefix=entry.rel.toLowerCase()+'\\';
        if (scanTree.coverage.some(e=>e.path==='.\\' || e.path.toLowerCase().startsWith(prefix)))
          throw new Error('产物目录扫描范围不完整：'+rel);
        for (const f of scanTree.files) if (f.rel.toLowerCase().startsWith(prefix)) add(f.rel,false,true);
      } else {
        for (const item of fs.readdirSync(entry.abs,{withFileTypes:true}).filter(e=>!isJunkFile(e)))
          add(entry.rel+'\\'+item.name,item.isDirectory(),true);
      }
      if (!nested && entries.size === first && ![...entries.keys()].some(p => p.startsWith(entry.rel + '\\')))
        throw new Error('文件夹没有实物：' + rel);
    } else if (!entries.has(entry.rel)) {
      if (entries.size >= MAX_FILES) throw new Error('本批文件过多，未核');
      const cached=root===SRC ? scanTree?.byPath.get(entry.rel.toLowerCase()) : null;
      if (root===SRC && scanTree && (!cached?.sha || !unchangedEntry(cached.st,entry.st)))
        throw new Error('本轮快照未核文件：'+rel);
      const record=cached?.sha ? [entry.rel,cached.size,cached.sha] : mapRead(root,rel,(fd,file)=>[file.rel,Number(file.st.size),hashFile(fd)]);
      if (!record) throw new Error('应有文件不在：' + rel);
      entries.set(entry.rel, record);
    }
    return entry.rel;
  };
  return { add, rows: () => [...entries.keys()].sort().map(p => entries.get(p)) };
}
function mapInputs(plan, N, collect) {
  const { steps, inputs, root } = plan, traced = new Set(), ids = new Set(), fromFiles = new Set();
  const walk = i => {
    if (traced.has(i)) return;
    traced.add(i);
    for (const ref of steps[i].from) {
      const key = inputId(ref);
      if (key) ids.add(key);
      else {
        const parent = steps.findIndex(s => s.to.some(p => ioKey(p) === ioKey(ref)));
        if (parent < 0 || parent >= i) throw new Error('运行表读向未核');
        walk(parent);
        fromFiles.add(ref);
      }
    }
  };
  walk(N - 1);
  const active = [], P = [], names = new Map();
  for (const key of [...ids].sort((a,b) => Number(a.slice(3)) - Number(b.slice(3)))) {
    const input = inputs.get(key);
    if (!input) throw new Error('缺 ' + key);
    if (input.keys.length && !input.value) throw new Error(key + ' 尚未确认本批参数');
    for (const name of input.keys) {
      if (names.has(name) && names.get(name) !== input.value) throw new Error('同名参数本批取值不同');
      names.set(name, input.value);
      P.push([key, name, input.value]);
    }
    const match = glob(input.name, 'i'), all = input.loc.st ? fs.readdirSync(input.loc.abs).filter(f => !JUNK(f)) : [];
    const files = all.filter(f => match.test(f)).sort();
    if (!files.length || (input.count === '一份' ? files.length !== 1 : input.count !== '一组')) throw new Error(key + ' 的本批份数对不上');
    if (input.keys.length) {
      const family = glob(input.family, 'i');
      const alternatives = [...ids].filter(id => id !== key).map(id => inputs.get(id)).filter(i =>
        i && i.loc.rel.toLowerCase() === input.loc.rel.toLowerCase() && (!i.keys.length || i.value)).map(i => glob(i.name,'i'));
      if (all.some(f => family.test(f) && !match.test(f) && !alternatives.some(other => other.test(f))))
        throw new Error(key + ' 混入其他批次的文件');
    }
    const joined = files.map(f => input.loc.rel + '\\' + f);
    for (const f of joined) {
      const matched = mapPathKey(collect(f));
      if (active.includes(matched)) throw new Error('同一份文件属于多项输入');
      active.push(matched);
    }
  }
  for (const f of fromFiles) {
    const rel = physicalIO(f,plan.bindings);
    if (!rel) throw new Error('生产目录的本批参数待核');
    active.push(mapPathKey(collect(rel, rel.endsWith('\\'))));
  }
  const related = [...traced].sort((a,b) => a - b);
  for (const j of related) {
    const { what, judge } = steps[j];
    for (const f of [...mapPathsIn(what), ...mapPathsIn(judge)]) collect(f);
    if (j !== N - 1) {
      const names = mapTicketNames(plan, pad(j + 1));
      if (names.length > 1) throw new Error('实际读取的上游有两张同号单');
      if (names.length) {
        const text = mapText(root, 'docs\\tickets\\' + names[0]);
        if (text === null) throw new Error('实际读取的上游单不在');
        const doc = ticketDocument(text), how = uniqueField(indexedLines(doc,doc.step),'怎么做');
        for (const f of mapPathsIn(how ?? '').filter(p => /^scripts[\\/]/i.test(p))) collect(f);
      }
    }
  }
  return { P, names, active, flow: [plan.flow[1].filter(row => ids.has(inputId(row[0]))), related.map(i => plan.flow[2][i])] };
}
const mapTicketNames = (plan,NN) => plan.tickets.filter(f => f.startsWith(NN + '-') && /\.md$/i.test(f));
function mapPermission(plan, { N, NN, doc, version, legacyRun, hasBad }) {
  const last = doc.confirms.at(-1) ?? '', match = CONFIRM.exec(last);
  if (!match || !version || match[2] !== version || !positive(match[1])) return { state: 'pending' };
  const [date, ...words] = last.slice(match[0].length).trim().split(/\s*[｜|]\s*/);
  const quote = quoteDigits(words.join('｜'));
  if (!isoDate(date) || /<[^<>]*>/.test(quote) || otherTicket(quote, N) || doc.confirms.some(l => !CONFIRM.test(l)))
    return { state: 'pending' };
  const single = singlePermit(quote, legacyRun);
  if (quote.includes('仅定稿·未获准运行') || (/票\s*\d+\s*验收单确认/.test(quote) && !single && quote !== '按快跑档推进'))
    return { state: 'locked' };
  const batches = plan.confirmed.map(([line]) => [line, FAST_BATCH.exec(line)]).filter(([,b]) => b?.[1] === date && b[2].split('、').includes(NN + '@' + version));
  const batch = quote === '按快跑档推进' && hasBad && batches.length === 1 && batches[0][1][2].split('、').every((key,i,scope) => {
    const n = Number(key.slice(0,2)), step = plan.steps[n - 1];
    return (!i || n === Number(scope[i - 1].slice(0,2)) + 1) && step?.who === 'AI照规矩' && step.judge === '—';
  }) ? batches[0][0] : null;
  return { state: single || batch ? 'allowed' : 'pending', K: match[1], binding: [last, batch], date, fast: !!batch };
}
function mapSigned(plan, data) {
  const { root, history, index } = plan, { doc, rel, groups, hasBad } = data;
  const stamp = mapText(root, rel);
  if (stamp === null) return data.requireFingerprint ? null : '旧票缺签';
  if (!/^[a-f0-9]{64}\n$/.test(stamp)) return null;
  if (stamp === fingerprintOf(doc.raw.slice(doc.sheet.start, doc.sheet.end)) ||
      (!history.upgradeBroken && !verAtLeast(history.createdVer, [2,0,0]) &&
       oldFingerprint({ ...data, groups, hasBad, indexText: index }, stamp, doc.text.split(/\r?\n/)) === 'match')) return stamp;
  return null;
}
function containsFullValue(text, value) {
  const word = '[\\p{L}\\p{M}\\p{N}\\p{Pc}]';
  const nonCjkWord = /[[\p{L}\p{M}\p{Pc}]--[\p{scx=Han}]]/v.source;
  const numericStart = /^[+\-−＋－]?[.．]?\p{Nd}/u.test(value);
  const numericEnd = /\p{Nd}[%％‰]?$/u.test(value);
  let before = '', after = '';
  if (numericStart) {
    before = "(?<!" + nonCjkWord + "|[\\p{Nd}+\\-−＋－.．])(?<!\\p{Nd}[,，'’_\\u00a0\\u202f\\u2009\\u2007])";
    if (/^\p{Nd}{3}(?!\p{Nd})/u.test(value)) before += '(?<!\\p{Nd} )';
  } else if (/^[\p{L}\p{M}\p{N}\p{Pc}]/u.test(value)) before = '(?<!' + word + ')';
  if (numericEnd) {
    after = "(?!" + nonCjkWord + "|[\\p{Nd}百千万萬亿億兆+\\-−＋－]|[.,．，'’_\\u00a0\\u202f\\u2009\\u2007]\\p{Nd}| \\p{Nd}{3}(?!\\p{Nd}))";
    // W4、é4 等编号仍有词界；数字之间的分组下划线本身不构成编号。
    const identifierEnd = new RegExp(nonCjkWord + '(?<!\\p{Nd}_)[_\\p{Nd}]*$', 'v');
    if (identifierEnd.test(value)) after += '(?!' + word + ')';
    if (!/[%％‰]$/.test(value)) after += '(?![%％‰])';
  } else if (/[\p{L}\p{M}\p{N}\p{Pc}]$/u.test(value)) after = '(?!' + word + ')';
  const literal = value.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&');
  return new RegExp(before + literal + after, 'v').test(text ?? '');
}
function mapEvidence(plan, data, permission, round, expected, sample) {
  const { root, steps } = plan, { N, NN, doc, version, groups } = data;
  const step = steps[N - 1], { K } = permission;
  if (!expected?.every(validMapText) || !sampleShape(sample)) return null;
  const outputs = step.to.map(rel=>physicalIO(rel,plan.bindings));
  if (outputs.some(x=>!x)) throw new Error('产物目录的本批参数待核');
  const [good, product, value, bad, stopped, why] = sample, badRoot = 'work\\' + NN + '-坏输入\\';
  const key = mapPathKey, goodKey = key(good), badKey = key(bad), outKey = key(product), stopKey = key(stopped);
  if (goodKey !== key(expected[0]) || badKey !== key(expected[2]) || new Set([goodKey,badKey,outKey,stopKey]).size !== 4 ||
      !stopKey.startsWith(badRoot) || !why.includes(expected[3]) ||
      !outputs.some(f => f.endsWith('\\') ? outKey.startsWith(key(f) + '\\') : outKey === key(f))) throw new Error('好坏小样和运行表约定对不上');
  const fsset = mapFileSet(root), { add } = fsset;
  const input = mapInputs(plan, N, add);
  if (!input.active.some(p => goodKey === p || goodKey.startsWith(p + '\\'))) throw new Error('正常样本不是本批实际取用的文件');
  for (const f of outputs) add(f, f.endsWith('\\'));
  const how = uniqueField(indexedLines(doc, doc.step), '怎么做');
  if (how) for (const script of mapPathsIn(how)) add(script);
  if (permission.fast && (!how || !/^写程序（scripts\\\d{2}_[^\\]+\.js）$/.test(how) || !how.startsWith('写程序（scripts\\' + NN + '_')))
    throw new Error('快跑票的独立脚本缺证');
  const sampleFiles = [good, product, bad, stopped].map(f => add(f));
  const files = fsset.rows();
  if (files.find(f => f[0] === sampleFiles[0])[2] === files.find(f => f[0] === sampleFiles[2])[2])
    throw new Error('好坏样本是同一份内容');
  const productText = mapText(root, product), stoppedText = mapText(root, stopped);
  if (!containsFullValue(productText, value) || !stoppedText?.includes(why)) throw new Error('实测摘值或拦截原因在实物中找不到');
  const actual = primaryBatch(root,outputs,sample,input.names);
  if (groups.baseline && actual.size>1) throw new Error('多个当批参数不能绑定同一固定基线');
  const activeFixed = !groups.baseline || !actual.size || [...actual.values()].every(v=>v===groups.baseline);
  if (activeFixed && !containsFullValue(value, expected[1])) throw new Error('实测摘值没有达到约定值');
  if (groups.baseline && !activeFixed && !baselineStatus(doc)) throw new Error('结果缺旧样本本轮说明');
  const current = groups.current;
  if (!current.some(c => key(c.rel) === stopKey && c.verb === '含') ||
      !current.some(c => key(c.rel) === outKey && c.verb === '含' && (containsFullValue(value, c.text) || containsFullValue(c.text, value))))
    throw new Error('当期自检没有对上好坏实物');
  for (const c of [...groups.fixed, ...current]) {
    const needed = activeFixed || current.includes(c);
    const entry = mapEntry(root, c.p);
    if (!needed && !entry.st) continue;
    add(c.rel, entry.st?.isDirectory());
    if (!needed || c.verb === '有') continue;
    const text = mapText(root,c.rel);
    const claimed = c.verb === '含';
    if (!!text?.split(/\r?\n/).some(line => claimed ? containsFullValue(line, c.text) : line.includes(c.text)) !== claimed)
      throw new Error('当期自检与现物不同');
  }
  const stamp = mapSigned(plan, data);
  if (!stamp) throw new Error('验收单签发记录未核同');
  const binding = digest(path.normalize(root).toLowerCase());
  const F = digest(JSON.stringify([binding, NN, version, K, round.number, input.P, input.flow,
    fingerprintOf(doc.raw.slice(doc.sheet.start, doc.sheet.end)).trimEnd(), stamp, permission.binding, sample, fsset.rows()]));
  return [1, NN, version, K, round.number, input.P, F];
}
function receiptMatches(plan, docs, wanted, identity) {
  const prefix = `${plan.root}｜accept｜票 ${identity[1]}｜第 ${identity[3]} 次确认（第 ${identity[2]} 版）｜`;
  const global = (mapText(plan.root, 'docs\\check\\accept.txt') ?? '').split(/\r?\n/).map((l,i) => [l,i+1]);
  const local = docs.map(([line]) => line);
  if (local.includes(prefix + '不通过')) return { failed: '本批验收未过' };
  if (global[0][0] === prefix + '不通过') return { failed: '最近验收未过，本批待核' };
  const same = rows => !!wanted && JSON.stringify(rowJson(rows, VERIFY_ROW)) === JSON.stringify(wanted);
  const recorded = local.some(l => l.startsWith(VERIFY_ROW) || l.includes('｜accept｜票 '));
  if (recorded) {
    if (local.filter(l => l.includes('｜accept｜票 ')).length === 1 && local.includes(prefix + '通过') && same(docs))
      return { verified:true };
    return { verified:false };
  }
  return { verified: global[0][0] === prefix + '通过' && same(global) };
}
function humanTarget(plan, N, object) {
  const { from, to, judge } = plan.steps[Number(N) - 1];
  const goal = judge.split('｜',1)[0].trim();
  if (goal !== '—' && (object === goal || object === goal.replace(/^(?:核对|检查|确认)\s*/,''))) return true;
  const rel = unquotePath(object);
  if (!rel) return false;
  try {
    const parts = mapParts(rel), key = parts.join('\\').toLowerCase();
    const direct = [...from.filter(f => !inputId(f)), ...to].some(f => {
      const actual = physicalIO(f,plan.bindings);
      if (!actual) return false;
      const declared = mapPathKey(actual);
      return key === declared || (/[\\/]$/.test(f) && key.startsWith(declared + '\\'));
    });
    const inputFile = !direct && from.some(ref => {
      const input = plan.inputs.get(inputId(ref));
      return input && parts.slice(0,-1).join('\\').toLowerCase() === mapPathKey(input.loc.rel) && glob(input.name,'i').test(parts.at(-1));
    });
    // A learner can name the same declared object using Windows case conventions.
    return (direct || inputFile) && !!mapEntry(plan.root,rel,{humanMention:true}).st;
  } catch (e) {
    if (!(e instanceof MapPathError)) throw e;
    return false;
  }
}
function humanDecision(raw, N) {
  const quote = quoteDigits(raw);
  const question = /[?？]|吗|是否|能不能|可不可以|行不行|是不是|能否|可否|要不要|对不对|有没有/;
  const hypothesis = /如果|要是|假如|若|除非|只要/;
  const colon = quote.search(/[:：]/);
  const head = colon < 0 ? quote : quote.slice(0, colon);
  const tail = colon < 0 ? '' : quote.slice(colon + 1);
  const cnNum = s =>
    ({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[s] ?? Number(s));
  const otherTarget = text =>
    [...text.matchAll(/票\s*(\d+|[一二三四五六七八九十])|(?<!退回\s*)第\s*(\d+|[一二三四五六七八九十])\s*步/g)]
      .some(([, ticket, step]) => cnNum(ticket ?? step) !== Number(N));
  const ambiguous = text => otherTarget(text) || question.test(text) || hypothesis.test(text);
  if (ambiguous(head)) return 'waiting';
  const clauses = text => text.split(/[，,。.！!；;：:]/).map(s =>
    s.trim().replace(/^(?:票\s*(\d+|[一二三四五六七八九十])|第\s*(\d+|[一二三四五六七八九十])\s*步)\s*/, (prefix, ticket, step) =>
      cnNum(ticket ?? step) === Number(N) ? '' : prefix)).filter(Boolean);
  const deferred = /先退回|改完|改好后|后[，,\s]*(?:再|才)|等待|等等|等一等|等下|稍等|先等|再等|等(?:我|你|他|她|它|一下|一会|会儿|确认|核对|复核|修改|重做|改|完|再|后|到|看)|待(?:确认|核对|复核|修改|重做|定|查|审|处理|补)|暂(?:不|未|停|缓|时|且|留|待)/;
  const refused = /^(?:我\s*|请\s*)?(?:(?:本次|这次|本批)\s*)?(?:拒绝(?:交付|放行)?|不同意(?:交付|放行)?|(?:核对|验收)?(?:不|没|未)通过|(?:不能|不可以)交付|不(?:予)?放行|退回(?:第\s*(?:\d+|[一二三四五六七八九十])\s*步)?(?:重做|修改)?)$/;
  const headClauses = clauses(head);
  for (const clause of headClauses) {
    if (deferred.test(clause)) break;
    if (refused.test(clause) && !(clause.includes('退回') && deferred.test(head))) return 'blocked';
  }
  if (ambiguous(tail) || deferred.test(quote)) return 'waiting';
  const release = /^(?:我\s*)?(?:(?:已(?:经)?|确认|现在|本次|这次|本批)\s*)*(?:通过|核对(?:通过(?:\s*可以交付)?|无误\s*可以交付)|同意(?:交付|放行)?|(?:可以|允许|批准)(?:交付|放行)|全部通过)$/;
  const checked = /^(?:我\s*)?(?:已(?:经)?核对(?:过|完成)?|(?:已(?:经)?)?核对无误|对得上)$/;
  const all = headClauses.concat(clauses(tail));
  return all.some(s => release.test(s)) && all.every(s => release.test(s) || checked.test(s)) ? 'verified' : 'waiting';
}
function humanRecord(plan, N, scopes, rel, docs) {
  if (!scopes.length) return null;
  const scope = scopes.map(p => p[1] + '@' + p.slice(2,5).join('/') + (p[5].length ? '；' + p[5].map(([id,k,v]) => id + ' ' + k + '=' + v).join('、') : '')).join('、');
  const matches = (lines, p) => lines.flatMap(([line,i]) => {
    const m = /^- (?:([^｜]*)｜)?第 ([1-9]\d*) 步｜批次：([^｜]+)｜核对：([^｜]+)｜你说：(“.*”|「.*」)$/.exec(line);
    if (!m || m[2] !== N || m[3] !== scope || !validMapText(m[4]) || !humanTarget(plan,N,m[4].trim())) return [];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(m[1] ?? '') ? isoDate(m[1]) : '';
    const quote = m[5].slice(1,-1);
    const decision = validMapText(quote) ? humanDecision(quote,N) : 'waiting';
    return [{ date, decision, record: [N + ' 步｜' + scope + '｜' + m[4], quote, p + ' 第 ' + i + ' 行'] }];
  });
  const records = [...matches(plan.confirmed,plan.indexRel), ...matches(docs,rel)];
  if (!records.length) return null;
  const latest = records.reduce((a,b) => a.date >= b.date ? a : b);
  if (!latest.date || latest.decision === 'waiting' ||
      (records.some(r => !r.date) && records.some(r => r.decision !== 'verified')) ||
      records.some(r => r.date === latest.date && r.decision !== latest.decision)) return { decision:'waiting' };
  return latest;
}
function mapStep(plan, i, upstream, signing = false) {
  const { root, flow, steps } = plan, step = steps[i], N = step.n, NN = pad(i + 1);
  const names = mapTicketNames(plan,NN);
  let rel = null, V = null, K = null, R = null, P = null, expected = null, human = null, current = null;
  const state = (status, why, sample = null, F = null) => ({ step: [N,rel,status,why,V,K,R,P,expected,sample,human,sample?.[1] ?? rel ?? RUN_MD,F], current });
  if (names.length > 1) return state('blocked', '同一步有两张单');
  if (step.who === '你') {
    if (names.length) return state('blocked', '人工步不应有任务票');
    // 直接交给人的文件须有本批依据。不得跳过未跑的步、向更早的票借凭据。
    const sources = [...new Set(step.from.filter(ref => !inputId(ref)).map(ref => steps.findIndex(s => s.to.some(p => ioKey(p) === ioKey(ref)))))].sort((a,b) => a-b);
    const upstreamProofs = sources.map(j => upstream[j]);
    const review = upstreamProofs.every(p => p?.current && p.step[12])
      ? humanRecord(plan,N,upstreamProofs.map(p => p.current),plan.indexRel,[]) : null;
    human = review?.record ?? null;
    const decision = review?.decision ?? 'waiting';
    const result = state(decision, decision === 'verified' ? '你已核对' : decision === 'blocked' ? '核对未放行' : '等你点头');
    if (human) result.step[11] = plan.indexRel;
    return result;
  }
  if (!names.length) return state('pending', '未建票');
  rel = 'docs\\tickets\\' + names[0];
  const text = mapText(root, rel);
  if (text === null) return state('pending', '这张单还没有读到');
  const doc = ticketDocument(text);
  V = doc.version ?? null;
  expected = expectedSample(doc);
  for (const p of [expected?.[0], expected?.[2]]) if (p) mapEntry(root, p);
  if (!V || !doc.step || doc.self.length !== 1) return state('pending', '验收单待补齐');
  const fields = indexedLines(doc, doc.step);
  const row = flow[2][i], short = Number(doc.raw[0].match(/^# 票\s*(\d+)\s*[：:]/)?.[1]);
  if (short !== i + 1 || (doc.step.label.match(/第\s*(\d+)\s*行/)?.[1] ?? N) !== N ||
      uniqueField(fields,'做什么') !== row[3] || ['从哪拿','放到哪'].some(name => {
        const value = uniqueField(fields,name);
        if (value === undefined || value === null) return true;
        const {problems,pending,differ} = compareIO(root,step,name,value,plan.bindings,steps,[...plan.inputs.keys()],i+1);
        return problems.length || pending.length || differ;
      }))
    return state('blocked', '这张单和运行表对不上');
  const errors = [];
  const groups = assertionGroups(doc, doc.self[0], issue => errors.push(issue)), hasBad = hasBadInput(groups, NN);
  const stampPath = `docs\\check\\ticket-${NN}-v${V}.sha256`;
  mapEntry(root, stampPath);
  const data = { N: i+1, NN, doc, ...sheetFacts(root, NN, doc, plan.history), groups, hasBad };
  const permit = mapPermission(plan, data);
  K = permit.K ?? null;
  if (permit.state === 'locked') return state('locked', '标准定好了，还没准开跑');
  const round = doc.rounds.at(-1);
  if (permit.state !== 'allowed') return state('pending', round ? '有历史记录，本批待核' : '等本批实跑');
  if (!round) return state('pending', '已获准，待实跑');
  R = round.number;
  if (!round.explicitVersion || round.version !== V || round.confirmNo !== K ||
      doc.rounds.filter(r => r.number === R && r.version === V && r.confirmNo === K).length !== 1)
    return state('pending', '本批待核，结果轮次对不上');
  const docs = indexedLines(doc, round.heading), sample = rowJson(docs, SAMPLE_ROW);
  if (errors.length || (i === 0 && !hasBad) || plan.history.upgradeBroken ||
      (!validValueSource(i + 1, row, sourcesOf(doc)) && !data.legacyValue)) return state('blocked', '验收单有待核项');
  if (sampleShape(sample)) for (const j of [0,1,3,4]) mapEntry(root, sample[j]);
  let problem;
  try { current = mapEvidence(plan, data, permit, round, expected, sample); }
  catch (e) { if (e instanceof MapPathError) throw e; problem = e.code ?? e.message; }
  P = current?.[5] ?? null;
  if (signing) return state('pending', '本批待核');
  const proof = receiptMatches(plan, docs, current, [1,NN,V,K,R]);
  if (proof.failed || problem) return state('blocked', problem ? '本批待核：'+problem : proof.failed);
  if (!proof.verified) return state('pending', '有历史记录，本批待核');
  const needsHuman = step.judge !== '—' || /^AI同源试算/.test(expected[4]) ||
    indexedLines(doc, doc.sheet, true).some(([l]) => /^#{3,4}\s*(?:人工|学员|你来)核/.test(l));
  const review = humanRecord(plan, N, [current], rel, indexedLines(doc, round.heading, true));
  human = review?.record ?? null;
  if (review?.decision === 'blocked') return state('blocked', '核对未放行', sample, current[6]);
  if ((needsHuman || review) && !human) return state('waiting', '程序已核，等你点头', sample, current[6]);
  return state('verified', human ? '程序已核，你已核对' : '本批已实跑核过', sample, current[6]);
}
function mapSnapshot(plan) {
  const seen = [];
  for (let i = 0; i < plan.steps.length; i++) seen.push(mapStep(plan, i, seen));
  const steps = seen.map(s => s.step);
  if (steps.length && /^当前站：(?:已结束（停止）|已停止|停止)\s*$/m.test(plan.index))
    steps[0][3] += '；项目已停止';
  const [title,inputs,rows]=plan.flow;
  const normalized=rows.map((row,i)=>row.map((x,j)=>j===2 ? (plan.steps[i].from.join('、') || '—') :
    j===4 ? (plan.steps[i].to.join('、') || '—') : x));
  return { format: MAP_FORMAT, version: 1, flow: [title,inputs,normalized], steps };
}

// ---------- 一份离线页面，两次用同一个渲染器 ----------
function liveShape(m) {
  const strings = (x,n,empty = false) => tuple(x,n) && x.every(s => (empty && s === '') || validMapText(s));
  const safe = p => { mapParts(p); return true; };
  if (!m || typeof m !== 'object' || Object.keys(m).join() !== 'format,version,flow,steps' ||
      m.format !== MAP_FORMAT || m.version !== 1 || !tuple(m.flow,3)) return false;
  const [title, ins, rows] = m.flow;
  if (!validMapText(title) || !Array.isArray(ins) || ins.length > 256 ||
      !ins.every(r => strings(r,7,true) && inputId(r[0]) && safe(r[1]) && [...items(r[5]),...items(r[6])].every(safe)) ||
      new Set(ins.map(r => inputId(r[0]))).size !== ins.length || !Array.isArray(rows) || rows.length < 1 || rows.length > 7 ||
      !rows.every((r,i) => strings(r,6,true) && r[0] === String(i+1) && WHO.includes(r[1])) ||
      !tuple(m.steps, rows.length)) return false;
  const ids = ins.map(r => inputId(r[0]));
  const steps = stepsOf(rows,null,true), bindings=bindingsOf(ins);
  if (steps.some((s,i) => !s.short || !s.to.every(p=>safe(physicalIO(p,bindings) ?? p.replace(/<[^<>]+>/,'批次'))) ||
      fromErrs(steps,i+1,ids).length ||
      (s.who !== '你' && !s.to.length) || s.back.some(n => n < 1 || n > i+1))) return false;
  return m.steps.every((s,i) => tuple(s,13) && s[0] === rows[i][0] &&
    (s[1] === null || (validMapText(s[1]) && safe(s[1]) && s[1].startsWith('docs\\tickets\\' + pad(i+1) + '-'))) &&
    MAP_STATES.includes(s[2]) && validMapText(s[3]) && s.slice(4,7).every(v => v === null || positive(v)) &&
    (s[7] === null || (parameterShape(s[7]) && new Set(s[7].map(p => p.slice(0,2).join('\0'))).size === s[7].length)) &&
    (s[8] === null || (tuple(s[8],5) && s[8].every(v => v === null || validMapText(v)) && [0,2].every(j => s[8][j] === null || safe(s[8][j])))) &&
    (s[9] === null || (sampleShape(s[9]) && golden(s[12]) && s.slice(4,7).every(positive) && parameterShape(s[7]))) &&
    (s[10] === null || strings(s[10],3)) && validMapText(s[11]) && safe(s[11]) &&
    (s[12] === null || (golden(s[12]) && s[9] !== null)) &&
    (s[2] !== 'verified' || s[12] !== null || s[10] !== null));
}
const esc = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const islandJson = data => JSON.stringify(data).replace(/[<>&'\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4,'0'));
const mapShaTag = raw => '<meta name="coach-map-sha" content="' + digest(raw) + '">';
const shortMapLabel = s => [...s].length > 6 ? [...s].slice(0,5).join('') + '…' : s;
const MAP_ART = {
  cabinet: '<path class="shell" d="M-38-25l9-9h69v57l-9 9h-69z"/><path class="face" d="M-38-25h69v57h-69z"/><path class="detail" d="M31-25l9-9m-66 24h42m-42 16h42m-42 16h42"/><rect class="accent" x="-8" y="-2" width="17" height="15" rx="3"/><path class="detail" d="M-4-2v-5a5 5 0 0 1 10 0v5m-5 6v3"/>',
  tray: '<path class="face" d="M-21 7v-42h26l11 11v31z"/><path class="detail" d="M5-35v11h11m-28 5h14m-14 8h18"/><path class="shell" d="M-38-7h76l-5 33h-66z"/><path class="face" d="M-38-7h23l4 8h22l4-8h23l-5 33h-66z"/><path class="detail" d="M-16 16h32"/>',
  gear: '<path class="shell" d="M-7-30h14l2 7 6 3 7-3 9 10-4 6 1 6 6 4-3 13-7 1-4 4v7l-13 5-5-5h-7l-5 5-13-5v-7l-4-4-7-1-3-13 6-4 1-6-4-6 9-10 7 3 6-3z"/><circle class="face" cx="0" cy="1" r="17"/><circle class="accent" cx="0" cy="1" r="8"/>',
  forks: '<path class="face" d="M-34 28q2-35 24-40l8-1 0-15 25 23-25 23V4q-16 1-23 24z"/><path class="accent" d="M-8 29q14-24 30-23v-11l17 16-17 16v-9q-10 1-18 11z"/><path class="detail" d="M-29 30h35"/>',
  gate: '<path class="shell" d="M-34-26h8v54h-8zm60 0h8v54h-8zM-37 28h14m46 0h14"/><path class="face" d="M-6 18l-9-13q-3-7 4-7l5 4v-23q0-6 6-5 5 0 5 5v14q7-5 8 2 7-3 8 3 6-1 7 5l-4 12-6 7H-3z"/><path class="detail" d="M-24 21h16m30 0h4"/>',
  folder: '<path class="shell" d="M-37-20h24l7 8h43v36h-74z"/><path class="face" d="M-33-7h73l-8 31h-69z"/><path class="detail" d="M-21 6h31m-31 7h23"/>',
  sheet: '<path class="shell" d="M-28-27h48l9 9v43h-57z"/><path class="face" d="M-22-33h39l12 13v44h-51zm39 0v13h12"/><path class="detail" d="M-12-13h23m-23 8h29m-29 8h29m-29 8h15"/>',
};
const MAP_MARK = [
  'M-7-5h14v10H-7zM-4 1H4', 'M-6-1H6V8H-6zM-3-1v-3a3 3 0 0 1 6 0v3',
  'M-6 3v-3l3 1v-7q2-3 4 0v4q5-2 6 2v3l-4 5h-5z', 'M-7 0l4 4 10-10', 'M-7-4H7V4H-7zM-4 0H4',
];
function mapScene(meta, narrow, focus) {
  const steps = stepsOf(meta.flow[2],null,true), prefix = narrow ? 'phone' : 'desk';
  const width = narrow ? 384 : 720, center = narrow ? 140 : 245, right = narrow ? 291 : 536;
  const short = steps.length <= 4;
  const pitch = short ? 420 / Math.max(steps.length - 1, 1) : narrow ? 88 : 84;
  const first = short ? (steps.length === 1 ? 335 : 169) : 151;
  const y = i => first + i * pitch;
  const height = short ? 661 : focus ? Math.max(661,y(steps.length-1)+45) : 145 + steps.length * pitch;
  const inputRows = new Map(meta.flow[1].map(r => [inputId(r[0]), /^materials(?:[\\/]|$)/i.test(r[1]) ? 'cabinet' : 'tray']));
  const singleInput = focus && new Set(inputRows.values()).size === 1;
  const cabinetX = singleInput ? center : narrow ? 105 : 225, trayX = singleInput ? center : narrow ? 275 : 500;
  const links = [], arts = [], nodes = [], made = new Map();
  const icon = (name, x, yy, scale = 1) =>
    `<g class="drawing" transform="translate(${x} ${yy}) scale(${scale})">${MAP_ART[name]}</g>`;
  const label = (text,x,yy) => `<text x="${x}" y="${yy}" text-anchor="middle">${esc(text)}</text>`;
  const related = xs => [...new Set(xs)].filter(Boolean).join(' ');
  const edge = (d, xs, back = false, out = '') => {
    const tone = focus ? ' ' + meta.steps[Number(xs.at(-1))-1][2] : '';
    return `<path class="wire${back ? ' return' : ''}${tone}" data-related="${related(xs)}"${focus && out ? ' data-out="' + out + '"' : ''} d="${d}" marker-end="url(#${prefix}-end)"/>`;
  };
  for (const [shape,x,text] of [['cabinet',cabinetX,'原件只读'],['tray',trayX,'放新文件']]) {
    const readers = steps.filter(s => s.from.some(f => inputRows.get(inputId(f)) === shape)).map(s => s.n);
    if (focus && ![...inputRows.values()].includes(shape)) continue;
    arts.push(`<g class="file" data-related="${related(readers)}">${icon(shape,x,49)}${singleInput ? label(text,x+85,55) : label(text,x,106)}</g>`);
  }
  for (const [i,s] of steps.entries()) {
    const cy = y(i), N = s.n, role = WHO.indexOf(s.who), [, , state, why, , , , , , , human] = meta.steps[i];
    const status = MAP_STATES.indexOf(state);
    const statusLabel = ['待实跑','等开跑','等你核','已核过','被拦住'][status];
    const box = narrow ? 77 : 96, left = center - box, span = box * 2;
    const objectX = narrow ? center - 43 : center - 53, printX = narrow ? center + 20 : center + 24;
    const picked = focus ? N === focus : i === 0;
    const badge = focus ? `<g transform="translate(${left+9} ${cy-23})"><circle class="seq" r="10"/><text class="num" y="4" text-anchor="middle">${N}</text></g>` : '';
    const sample = meta.steps[i][9], hasBad = sample || meta.steps[i][8]?.[2];
    const stop = focus && hasBad ? `<g class="sample-stop" transform="translate(${center+box+3} ${cy-13})"><rect width="52" height="23" rx="4"/><text x="26" y="16" text-anchor="middle">${sample ? '已拦停' : '应拦停'}</text></g>` : '';
    nodes.push(`<g class="step ${state}${picked ? ' picked' : ''}" data-step="${N}" tabindex="0" role="button" aria-pressed="${picked}" aria-label="${esc('第 ' + N + ' 步 ' + s.short + '，' + MAP_ROLES[role] + '，' + why)}">
<rect class="hit" x="${left}" y="${cy-34}" width="${span}" height="71" rx="15"/>${icon(['gear','forks','gate'][role], objectX, cy, narrow ? .77 : .95)}${badge}${focus ? `<text class="state-name" x="${center+box-23}" y="${cy-20}" text-anchor="end">${statusLabel}</text>` : ''}
${label(shortMapLabel(s.short),printX,cy)}<text class="role" x="${printX}" y="${cy+21}" text-anchor="middle">${MAP_ROLES[role]}</text>
<g class="stamp" transform="translate(${center+box-8} ${cy-24})"><circle r="11"/><path d="${MAP_MARK[role === 2 && human && state === 'verified' ? 2 : status]}"/></g><title>${esc(role === 2 && state === 'verified' ? '你已核对' : statusLabel)}</title>${stop}</g>`);
    for (const [j,group] of [s.to.filter(x => /^work\\/i.test(x)),s.to.filter(x => /^output\\/i.test(x))].entries()) {
      if (!group.length) continue;
      const yy = cy + (s.to.some(f => /^work\\/i.test(f)) && s.to.some(f => /^output\\/i.test(f)) ? (j ? 23 : -22) : 0);
      const readers = steps.filter(x => x.from.some(f => group.includes(f))).map(x => x.n);
      for (const f of group) made.set(f,[right,yy,N]);
      arts.push(`<g class="file" data-related="${related([N,...readers])}">${icon(j ? 'sheet' : 'folder',right,yy,.69)}${label(j ? '拿成品' : '中间稿',right,yy+33)}</g>`);
      links.push(edge(`M${center+box+2} ${cy}H${right-33}L${right-26} ${yy}`,[N],false,N));
    }
    const sources = new Map(s.from.map(f => [inputId(f) ? inputRows.get(inputId(f)) : f, made.get(f)]));
    for (const [src, xy] of sources) {
      if (src === 'cabinet' || src === 'tray') {
        const x = src === 'cabinet' ? cabinetX : trayX, rail = src === 'cabinet' ? 38 : 48;
        if (singleInput && i === 0) links.push(edge(`M${x} 80V${cy-38}`,[N]));
        else links.push(edge(`M${x-43} 65V${src === 'cabinet' ? 112 : 118}H${rail}V${cy}H${left-4}`,[N]));
      } else if (xy) {
        const rail = width - 15 - (Number(xy[2])-1)*4;
        links.push(edge(`M${xy[0]+29} ${xy[1]-5}H${rail}V${cy-26}H${center+box+3}`,[xy[2],N],false,xy[2]));
      }
    }
    if (s.judge !== '—' && role !== 2) {
      const gx = left + 4;
      arts.push(`<g class="file gate" data-related="${N}">${icon('gate',gx+16,cy+45,.35)}${label('等你核',gx+46,cy+50)}</g>`);
    }
    for (const target of s.unclear ? [] : s.back) {
      const rail = 12 + (target-1)*4, end = y(target-1) + 28;
      links.push(edge(`M${left-2} ${cy+18}H${rail}V${end}H${left-4}`,[N,String(target)],true));
    }
    if (s.unclear) arts.push(label('退回待核',left+37,cy+52));
  }
  return `<svg class="scene ${narrow ? 'narrow' : 'wide'}" viewBox="0 0 ${width} ${height}" aria-label="项目的文件、做法、交付和退回" role="group">
<defs><marker id="${prefix}-end" orient="auto" markerUnits="userSpaceOnUse" refX="8" refY="5" markerWidth="10" markerHeight="10"><path d="M1 1L8 5 1 9" fill="none" stroke="context-stroke" stroke-width="1.6" stroke-linejoin="round"/></marker></defs>
${links.join('\n')}
${arts.join('\n')}
${nodes.join('\n')}
</svg>`;
}
function priorMapCard(meta, row, i) {
  const [N, rel, , why, , , round, P, planned, ran, human, first] = meta.steps[i];
  const [, who, from, what, to, judge] = row, [good, value, bad, stop, source] = planned ?? [];
  const [seenGood, result, actual, seenBad, intercept, reason] = ran ?? [];
  const locations = new Map(meta.flow[1].map(r => [inputId(r[0]),r[1]]));
  const reads = from === '—' ? ['无上游文件'] : items(from).map(f =>
    locations.has(inputId(f)) ? f + '（' + locations.get(inputId(f)) + '）' : f);
  const line = (term, content) => `<div><dt>${term}</dt><dd>${esc(content)}</dd></div>`;
  return `<section class="card" data-card="${N}" aria-label="第 ${N} 步排错"${i ? ' hidden' : ''}>
<h2>第 ${N} 步 · ${esc(shortMapLabel(what.split(/[：:]/)[0].trim()))}</h2><p class="why">${esc(why)}</p>
<dl>${line('放哪／读谁', [...reads.map(f => '读：' + f), '产：' + (to === '—' ? '核对后交付' : to)].join('\n'))}
${line('怎么做／依据', what + (judge === '—' ? '' : '\n' + judge))}</dl>
<dl class="samples">${line('开工前约好', planned ? [good && '好样本 ' + good,value,bad && '坏样本 ' + bad,stop,source].filter(Boolean).join('\n') : '还没约好小样')}
${line('这批实际跑出', ran ? [seenGood,result + ' · ' + actual,seenBad,intercept + ' · ' + reason,
  '第 ' + round + ' 轮' + (P.length ? ' · ' + P.map(([id,k,v]) => id + ' ' + k + ' ' + v).join('、') : '')].join('\n') : why.includes('待核') || why.includes('未过') ? '本批待核' : '待实跑')}</dl>
<dl>${human ? line('你核对的结果', human.join('\n')) : ''}${line('出错先开这份', first + (rel ? '' : who === '你' ? '（先看本步和退回目标）' : '（缺这一步的任务单）'))}</dl></section>`;
}
const PRIOR_MAP_STYLE = `
@layer offline {
 :root{color-scheme:light dark;--foreground:#172c34;--muted-foreground:#405c64;--card:#f6f9f4;--secondary:#e2ece4;--border:#648080;--primary:#075e7a;--primary-foreground:#fff;--accent-surface:#d9edf4;--success:#156246;--warning:#895009;--destructive:#9c332c;--radius:12px;--font-sans:system-ui,"Microsoft YaHei",sans-serif}
 @media(prefers-color-scheme:dark){:root{--foreground:#ecf4ef;--muted-foreground:#b0c6c9;--card:#182930;--secondary:#233d44;--border:#82a2a5;--primary:#7ed7ed;--primary-foreground:#102930;--accent-surface:#203e49;--success:#8fe1b3;--warning:#ffcb78;--destructive:#ffada5}}
}
*{box-sizing:border-box}body{margin:0;color:var(--foreground);font:16px/1.45 var(--font-sans)}main{max-width:875px;margin:auto}
header{margin:8px 12px 0}h1,h2,p{margin:0}h1{font-size:clamp(1.25rem,4vw,1.75rem);line-height:1.25;overflow-wrap:anywhere}header p,.why{color:var(--muted-foreground);font-size:14px}
.scene{display:block;width:100%;height:auto;isolation:isolate}.narrow{display:none}.scene text{fill:var(--foreground);font-size:16px;font-weight:650}.scene text.role{font-size:14px;fill:var(--muted-foreground);font-weight:500}
.scene{--ink:var(--muted-foreground);--wire:var(--muted-foreground);--slab:var(--secondary)}
@supports (color:color-mix(in srgb, red, transparent)){
 .scene{--ink:color-mix(in srgb,var(--foreground) 62%,transparent);--wire:color-mix(in srgb,var(--foreground) 48%,transparent);--slab:color-mix(in srgb,var(--foreground) 12%,var(--card))}
}
.shell,.face,.accent,.detail{stroke:var(--ink);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.shell{fill:var(--slab)}.face{fill:var(--card)}.accent{fill:var(--accent-surface)}.detail{fill:none}
.hit{fill:transparent;stroke:transparent;stroke-width:2.5}.step{cursor:pointer;outline:none}.step.picked .hit{fill:var(--accent-surface);stroke:var(--primary)}.step:focus-visible .hit{stroke:var(--primary);stroke-dasharray:5 3}
.wire{fill:none;stroke:var(--wire);stroke-width:1.7;stroke-linejoin:round}.wire.return{stroke-dasharray:5 5}.wire.related{stroke:var(--primary);stroke-width:3}
.file.related .face,.file.related .shell{stroke:var(--primary);stroke-width:3}.has-pick .wire:not(.related),.has-pick .file:not(.related){opacity:.80}.file.related text{fill:var(--primary)}
.stamp{color:var(--muted-foreground)}.stamp circle{fill:var(--card);stroke:currentColor;stroke-width:1.4}.stamp path{fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}.waiting .stamp{color:var(--warning)}.verified .stamp{color:var(--success)}.blocked .stamp{color:var(--destructive)}
.card{margin:0 12px 18px;padding:10px 13px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow-wrap:anywhere}
.card h2{font-size:17px}.card dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px 20px;margin:8px 0}.card dt{font-size:14px;font-weight:700}.card dd{margin:2px 0 0;font-size:14px;white-space:pre-wrap}
@media(max-width:520px){.wide{display:none}.narrow{display:block}.card dl{grid-template-columns:minmax(0,1fr)}}
@media(prefers-reduced-motion:no-preference){.wire,.file,.hit{transition:opacity .14s,stroke .14s,fill .14s}}
`;
const PRIOR_MAP_JS = `
const nodes = [...document.querySelectorAll('[data-step]')];
const related = [...document.querySelectorAll('[data-related]')];
const cards = [...document.querySelectorAll('[data-card]')];
function select(step) {
 for (const n of nodes) {
   const match = n.dataset.step === step;
   n.classList.toggle('picked', match);
   n.setAttribute('aria-pressed', String(match));
 }
 for (const object of related) object.classList.toggle('related', object.dataset.related.split(' ').includes(step));
 for (const card of cards) card.hidden = card.dataset.card !== step;
}
for (const n of nodes) {
 n.addEventListener('click', () => select(n.dataset.step));
 n.addEventListener('keydown', event => {
   if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(n.dataset.step); }
 });
}
for (const svg of document.querySelectorAll('.scene')) svg.classList.add('has-pick');
select('1');
`;
const MAP_GLOSSARY = `<details id="terms"><summary>名词人话解释</summary><dl>
<div><dt>原件只读</dt><dd>只看原文件，保留收到时的样子。</dd></div>
<div><dt>写死程序</dt><dd>照约好的规则，重复做同一件事。</dd></div>
<div><dt>AI 判断</dt><dd>由 AI 按本步的依据判断该怎么做。</dd></div>
<div><dt>你拍板</dt><dd>你核对结果，决定交付还是退回。</dd></div>
<div><dt>坏样本拦截</dt><dd>故意送入一份有问题的小样，看它能否在本站被拦住。</dd></div>
</dl></details>`;
function mapCommands(step, who, count, stopped) {
  const [N, rel, state, why] = step;
  if (stopped) return [['复制：查看快照','项目已停止，请只说明这份快照的结果和遗留问题。']];
  switch (state) {
    case 'waiting': {
      const subject = who === '你' ? '第 ' + N + ' 步' : '票 ' + N;
      return [['复制：我核对通过', subject + (who === '你' ? '我核对通过，可以交付。' : ' 通过，我核对通过，可以交付。')],
        ['复制：这里不对，退回改', subject + ' 不通过：<写明哪一项不对>']];
    }
    case 'blocked': return [['复制：打开证据排查', '请打开 ' + step[11] + '，排查第 ' + N + ' 步的「' + why + '」，告诉我哪里需要改。']];
    case 'locked': return [['复制：准许本票开跑', '票 ' + N + ' 就这样跑。']];
    case 'verified': return Number(N) < count
      ? [['复制：看下一步','请查看第 ' + (Number(N)+1) + ' 步，告诉我它读哪份文件、还缺什么。']]
      : [['复制：做最终体检','请做最终体检，逐步核对交付物和待办，给我核对结果。']];
    default: return [['复制：推进这一步', !rel ? '请按运行表为第 ' + N + ' 步准备任务单，列出好坏样本让我确认。' :
      why === '已获准，待实跑' ? '请按票 ' + N + ' 已获准的范围实跑好坏样本，给我看本批结果。' :
      '请核对票 ' + N + ' 的运行许可和本批记录，告诉我下一步需要什么。']];
  }
}
function mapCard(meta, step, i, focus, stopped) {
  const [N, rel, state, why, version, confirmation, round, params, planned, ran, human, first] = meta.steps[i];
  const [good, value, bad, limit, source] = planned ?? [];
  const [actualGood, product, actual, actualBad, intercepted, reason] = ran ?? [];
  const { who, from, what, to, judge, returns, unclear } = step;
  const role = MAP_ROLES[WHO.indexOf(who)], manual = who === '你';
  const name = f => path.win32.basename(f);
  const reads = [], inputs = from.map(f => {
    const input = meta.flow[1].find(row => inputId(row[0]) === inputId(f));
    if (input) {
      reads.push(f + '（' + input[1] + '）');
      return (/^materials[\\/]/i.test(input[1]) ? '原件只读' : '放新文件') + ' · ' + inputPattern(input[2]).name;
    }
    reads.push(f);
    const producer = meta.flow[2].find(row => items(row[4]).includes(f));
    return producer ? '第 ' + producer[0] + ' 步' + (/^work[\\/]/i.test(f) ? '中间稿' : '产出') + ' · ' + producer[3].split(/[：:]/)[0] : name(f);
  });
  const outputs = to.map(f => {
    const readers = meta.flow[2].filter(row => items(row[2]).includes(f)).map(row => '第 ' + row[0] + ' 步');
    return name(f) + (readers.length ? ' → ' + readers.join('、') : '');
  });
  const action = what.split(/依据[：:]/,1)[0].replace(/[。；;\s]+$/,'');
  const line = (term,content) => `<div><dt>${term}</dt><dd>${esc(content)}</dd></div>`;
  const list = values => values.map(text => `<li>${esc(text)}</li>`).join('');
  const command = (label,text) => `<button type="button" data-copy="${esc(text)}">${label}</button>`;
  const verdict = ran ? '程序已核 · ' + why.replace(/^程序已核，/,'') : why;
  const badSample = actualBad ?? bad, badRule = reason ?? limit;
  return `<section class="card" data-card="${N}" data-state="${state}" data-why="${esc(why)}" aria-label="第 ${N} 步拆解"${N === focus ? '' : ' hidden'}>
<div class="station-head"><h2 tabindex="-1">第 ${N} 步 · ${esc(step.short)}</h2><span class="status ${state}">${esc(why)}</span></div>
<div class="stages"><div class="stage"><h3>进门拿什么</h3><ul>${list(inputs.length ? inputs : ['本步没有上游文件'])}</ul>
<p>${manual ? '对照实物，决定交付还是退回。' : who === 'AI看情况' ? '用它对照依据作判断。' : '用作本步程序的输入。'}</p></div>
<div class="stage operation"><h3>站内怎么干</h3><strong class="role-tag">${role}</strong><p>${esc(action || step.short)}</p>
<div class="switch" role="group" aria-label="本步样本"><button type="button" data-mode="normal" aria-pressed="true">正常件跑通</button><button type="button" data-mode="bad" aria-pressed="false">坏样本拦截</button></div>
<div data-view="normal" class="comparison"><div><h4>开工前约好</h4><p>${esc(good ? name(good) : manual ? '由你核对交付' : '还没约好小样')}</p>${value ? '<strong>' + esc(value) + '</strong>' : ''}</div>
<div><h4>这批实跑出</h4><p>${esc(ran ? name(actualGood) : manual ? why : '尚无本批核验记录')}</p>${ran ? '<strong>' + esc(actual) + '</strong><small>' + esc(verdict) + '</small>' : ''}</div></div>
<div data-view="bad" hidden>${badSample ? `<ol class="intercept"><li><small>故意喂入</small>${esc(name(badSample))}</li><li><small>防错红线</small>${esc(badRule || '尚未约好拦截原因')}</li><li><small>拦截去向</small>${ran ? '本站已拦停，没有交到下一站。' : '约定在本站拦停，尚无本批实跑记录。'}</li></ol>` :
  '<p>' + (manual ? '这一步由你核对。请看本步判断和退回条件。' : '这一步尚未约好坏样本。') + '</p>'}</div></div>
<div class="stage"><h3>出门去哪</h3><ul>${list(outputs.length ? outputs : [manual ? '按核对结果决定交付' : '本步没有登记产出'])}</ul>
${judge !== '—' ? '<p>' + esc(judge.split('｜')[0]) + '</p>' : ''}
${returns.length ? '<h4>不对退回哪</h4>' + (unclear ? '<p>退回条件待核对</p>' : returns.map(r =>
  `<button type="button" class="rollback" data-jump="${r.to}">↶ ${esc(r.label)}</button>`).join('')) : ''}</div></div>
${N === focus ? MAP_GLOSSARY : ''}
<details class="evidence"><summary>展开核对与排错细节</summary><dl>
${line('放哪／读谁',[...reads.map(f => '读：' + f),'产：' + (to.join('、') || '本步未列文件')].join('\n'))}
${line('怎么做／依据',what + (judge === '—' ? '' : '\n' + judge))}${rel ? line('本步任务单',rel) : ''}
${line('开工前约好',[good,value,bad,limit,source].filter(Boolean).join('\n') || (manual ? '人工核对' : '还没约好小样'))}
${line('这批实际跑出',ran ? [actualGood,product,actual,actualBad,intercepted,reason].join('\n') : why)}
${line('版本与批次',[version && '验收单第 ' + version + ' 版',confirmation && '第 ' + confirmation + ' 次确认',round && '第 ' + round + ' 轮',
  ...(params ?? []).map(([id,k,v]) => id + ' · ' + k + '=' + v)].filter(Boolean).join('\n') || '本步没有登记批次')}
${human ? line('你核对的结果',human.join('\n')) : ''}${line('出错先开这份',first)}</dl></details>
<div class="actions"><h3>复制给 AI 的下一句话</h3><div>${mapCommands(meta.steps[i],who,meta.steps.length,stopped).map(([label,text]) => command(label,text)).join('')}</div>
<p class="copy-status" role="status"></p><textarea readonly hidden aria-label="选中后复制给 AI 的原话"></textarea></div></section>`;
}
const MAP_STYLE = PRIOR_MAP_STYLE + `
@layer offline {
 :root{--foreground:#172d38;--muted-foreground:#47606e;--card:#fafcfd;--secondary:#e9eef1;--border:#728894;--primary:#17516e;--accent-surface:#e4eff5;--success:#176544;--warning:#805000;--destructive:#a72f31}
 @media(prefers-color-scheme:dark){:root{--foreground:#edf5f8;--muted-foreground:#c1d0d8;--card:#18262f;--secondary:#263843;--border:#7b929e;--primary:#94d4ed;--accent-surface:#243d4d;--success:#92dfb1;--warning:#ffd087;--destructive:#ffacac}}
}
[hidden]{display:none!important}
.mast{display:grid;grid-template-columns:1fr auto;align-items:center;gap:3px 14px;margin:12px 14px 3px}
.mast h1{font-size:clamp(20px,3.8vw,28px);letter-spacing:-.035em}.mast .summary{grid-column:1;line-height:1.3}
.mast nav{grid-column:2;grid-row:1 / 3;display:flex;gap:4px}.meter{display:flex;gap:3px;grid-column:1 / -1;margin-top:5px}
.meter i{height:4px;border-radius:3px;flex:1;background:var(--tone,var(--border))}
.verified{--tone:var(--success)}.waiting{--tone:var(--warning)}.blocked{--tone:var(--destructive)}.pending,.locked{--tone:var(--border)}
#notice{grid-column:1 / -1;color:var(--foreground)}#notice:empty,.copy-status:empty{display:none}
button,textarea{color:inherit;font:inherit}button{border:1px solid var(--border);border-radius:7px;background:var(--card);padding:5px 10px;cursor:pointer;font-size:14px;line-height:1.45}
button:hover{border-color:var(--primary)}button:focus-visible,summary:focus-visible,.station-head h2:focus-visible,textarea:focus-visible{outline:3px solid var(--primary);outline-offset:3px}
button:disabled{opacity:.55;cursor:default}.mast [data-walk],.actions button:first-child{color:var(--primary-foreground);background:var(--primary);border-color:var(--primary)}
.scene .hit{fill:var(--card);stroke:var(--tone);stroke-width:1.4}.scene .step{--ink:var(--tone);--slab:var(--secondary)}
.scene .step .shell,.scene .step .face,.scene .step .accent{stroke:var(--tone);fill:var(--card)}
.scene .verified .hit,.scene .waiting .hit,.scene .blocked .hit{fill:color-mix(in srgb,var(--tone) 9%,var(--card))}
.scene .step .shell,.scene .step .accent{fill:color-mix(in srgb,var(--tone) 22%,var(--card))}
.scene .step.picked .hit{stroke:var(--tone);stroke-width:4;fill:color-mix(in srgb,var(--tone) 19%,var(--card))}
.scene .pending .detail,.scene .locked .detail{stroke:var(--muted-foreground)}
.scene .wire,.scene .wire.related{stroke:var(--tone,var(--wire));stroke-width:2}.scene .wire.related{stroke-width:3.6}
.scene .wire.return{stroke-dasharray:5 5}.scene .step:focus-visible .hit{stroke:var(--primary);stroke-dasharray:5 3}
.scene .state-name{font-size:12px;fill:var(--foreground);font-weight:600}.scene .seq{fill:var(--card);stroke:var(--tone);stroke-width:1.4}.scene .num{font:700 12px var(--font-sans);fill:var(--foreground)}
.scene .sample-stop{display:none}.scene.bad-view .step.picked .sample-stop{display:inline}.sample-stop rect{fill:var(--card);stroke:var(--destructive);stroke-width:2}
.scene .sample-stop text{font-size:12px;fill:var(--destructive)}.scene.bad-view .wire.at-stop{stroke-opacity:.2;marker-end:none}
.card{border:0;border-top:2px solid var(--border);border-radius:0;margin:0 14px 24px;padding:14px 0 0;background:transparent}
.station-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 12px}.station-head h2{font-size:20px;letter-spacing:-.02em}
.status{color:var(--muted-foreground);font-size:14px}.status.verified,.status.waiting,.status.blocked{color:var(--tone)}
.stages{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) minmax(0,1fr);gap:18px;margin:14px 0}
.stage{min-width:0;position:relative;padding:7px 0;border-top:1px solid var(--border)}
.stage+.stage:before{content:'→';position:absolute;left:-16px;top:5px;color:var(--muted-foreground)}
.card h3,.card h4{margin:0;font-size:15px;font-weight:700}.card h4{font-size:13px}.card li,.card .stage p,.card dd,.card small,.role-tag{font-size:14px}
.card .stage p{margin:4px 0;color:var(--muted-foreground)}.stage ul{list-style:none;margin:6px 0;padding:0}.stage li+li{margin-top:4px}
.role-tag{display:inline-block;margin-top:5px;color:var(--primary)}.switch{display:flex;flex-wrap:wrap;gap:3px;margin:10px 0 6px}
.switch button[aria-pressed=true]{background:var(--accent-surface);border-color:var(--primary);color:var(--primary);font-weight:700}
.switch button[data-mode=bad][aria-pressed=true]{color:var(--destructive);border-color:var(--destructive)}
.comparison{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.comparison>div{padding:6px;border-left:3px solid var(--border);background:var(--card)}
.comparison>div+div{border-color:var(--primary)}.comparison strong,.comparison small,.intercept small{display:block;overflow-wrap:anywhere}
.intercept{list-style:none;margin:0;padding:0 0 0 11px;border-left:3px dashed var(--destructive)}
.intercept li{padding:1px 0 3px}.intercept small{color:var(--muted-foreground);font-size:12px}.intercept li:last-child{font-weight:700}
.rollback{margin-top:4px;color:var(--primary)}details{margin:0;border-top:1px solid var(--border);padding:8px 0}
summary{width:fit-content;cursor:pointer;font-weight:650;font-size:15px}.card details dl{margin:8px 2px}.card details dd{color:var(--muted-foreground)}
.actions{border-top:1px solid var(--border);padding-top:10px}.actions button{margin:6px 5px 0 0}
.actions textarea{display:block;width:100%;min-height:60px;margin-top:5px;border:1px solid var(--border);background:var(--card)}.copy-status{font-size:14px}
@media(max-width:600px){.mast{grid-template-columns:1fr;gap:3px;margin:8px 10px 2px}.mast nav{grid-column:1;grid-row:auto}.meter{margin-top:2px}
 .stages{grid-template-columns:minmax(0,1fr);gap:8px}.stage+.stage:before{display:none}.card{margin-inline:10px}.stage{padding:7px 0}.stage ul{margin:4px 0}}
@media(prefers-reduced-motion:no-preference){.walking .wire.related:not(.return){stroke-dasharray:9 3;animation:trace .84s linear infinite}@keyframes trace{to{stroke-dashoffset:-24}}}
`;
const MAP_JS = `
const main = document.querySelector('main'), cards = [...main.querySelectorAll('[data-card]')];
const nodes = [...main.querySelectorAll('[data-step]')], edges = [...main.querySelectorAll('[data-related]')];
const terms = document.getElementById('terms'), notice = document.getElementById('notice');
const prev = main.querySelector('[data-prev]'), next = main.querySelector('[data-next]'), walk = main.querySelector('[data-walk]');
const focusStep = Number(main.dataset.focus);
let current = 0, timer = 0, copyJob = 0;
function stopWalk() {
 clearTimeout(timer);
 main.classList.remove('walking');
 walk.setAttribute('aria-pressed','false');
 walk.textContent = '按序走一遍';
}
function showMode(mode) {
 const card = cards[current-1];
 for (const button of card.querySelectorAll('[data-mode]')) button.setAttribute('aria-pressed',String(button.dataset.mode === mode));
 for (const panel of card.querySelectorAll('[data-view]')) panel.hidden = panel.dataset.view !== mode;
 for (const scene of main.querySelectorAll('.scene')) scene.classList.toggle('bad-view',mode === 'bad' && !!card.querySelector('.intercept'));
}
function select(step) {
 current = step;
 const id = String(step), card = cards[step-1];
 for (const node of nodes) {
   const picked = node.dataset.step === id;
   node.classList.toggle('picked',picked);
   node.setAttribute('aria-pressed',String(picked));
 }
 for (const edge of edges) {
   edge.classList.toggle('related',edge.dataset.related.split(' ').includes(id));
   edge.classList.toggle('at-stop',edge.dataset.out === id);
 }
 for (const c of cards) c.hidden = c !== card;
 card.querySelector('.evidence').before(terms);
 card.querySelector('.copy-status').textContent = '';
 card.querySelector('textarea').hidden = true;
 copyJob++;
 showMode('normal');
 prev.disabled = step === 1;
 next.disabled = step === cards.length;
 notice.textContent = '';
}
function play(step) {
 select(step);
 if (step === focusStep) {
   stopWalk();
   notice.textContent = (main.dataset.complete === 'true' ? '全部已核，最后一步' : '停在第 ' + step + ' 步') + ' · ' + cards[step-1].dataset.why;
   return;
 }
 timer = setTimeout(() => play(step+1),matchMedia('(prefers-reduced-motion: reduce)').matches ? 1000 : 720);
}
async function copy(text) {
 const card = cards[current-1], feedback = card.querySelector('.copy-status'), field = card.querySelector('textarea'), job = ++copyJob;
 feedback.textContent = '';
 field.hidden = true;
 try {
   await navigator.clipboard.writeText(text);
   if (job === copyJob) { field.hidden = true; feedback.textContent = '已复制'; }
 } catch {
   if (job !== copyJob) return;
   field.value = text;
   field.hidden = false;
   field.focus();
   field.select();
   feedback.textContent = '请按 Ctrl+C';
 }
}
main.addEventListener('click',event => {
 const target = event.target.closest('button,[data-step]');
 if (!target) return;
 if (target === walk) {
   const playing = main.classList.contains('walking');
   stopWalk();
   if (!playing) {
     main.classList.add('walking');
     walk.setAttribute('aria-pressed','true');
     walk.textContent = '停止演示';
     play(1);
   }
   return;
 }
 stopWalk();
 if (target === prev) select(current-1);
 else if (target === next) select(current+1);
 else if (target.dataset.step) select(Number(target.dataset.step));
 else if (target.dataset.jump) { select(Number(target.dataset.jump)); cards[current-1].querySelector('h2').focus(); }
 else if (target.dataset.mode) showMode(target.dataset.mode);
 else if (target.dataset.copy) copy(target.dataset.copy);
});
main.addEventListener('keydown',event => {
 const node = event.target.closest('[data-step]');
 if (!node) return;
 let step = Number(node.dataset.step);
 switch (event.key) {
   case ' ': case 'Enter': break;
   case 'ArrowUp': case 'ArrowLeft': step = Math.max(1,step-1); break;
   case 'ArrowDown': case 'ArrowRight': step = Math.min(cards.length,step+1); break;
   case 'Home': step = 1; break;
   case 'End': step = cards.length; break;
   default: return;
 }
 event.preventDefault();
 stopWalk();
 select(step);
 node.closest('.scene').querySelector('[data-step="'+step+'"]').focus();
});
for (const svg of main.querySelectorAll('.scene')) svg.classList.add('has-pick');
select(focusStep);
`;
function renderLiveMap(meta, previous = false, script = previous ? PRIOR_MAP_JS : MAP_JS) {
  const style = previous ? PRIOR_MAP_STYLE : MAP_STYLE;
  const CSP = createHash('sha256').update(script).digest('base64');
  const stopped = meta.steps.some(s => s[3].includes('项目已停止'));
  const raw = islandJson(meta), count = meta.steps.length, verified = meta.steps.filter(s => s[2] === 'verified').length;
  const focus = (meta.steps.find(s => s[2] === 'blocked') ?? meta.steps.find(s => s[2] === 'waiting') ??
    meta.steps.find(s => s[2] !== 'verified') ?? meta.steps[count-1])[0];
  let body;
  if (previous) {
    // 上一版带摘要的原页也要整页逐字重算，才准显式刷新。
    body = `<main><header><h1>${esc(meta.flow[0])}</h1><p>${stopped ? '项目已停止，保留当时快照' : '这是上次刷新的项目快照'}</p></header>
${mapScene(meta,false)}
${mapScene(meta,true)}
<div aria-live="polite">${meta.flow[2].map((r,i) => priorMapCard(meta,r,i)).join('\n')}</div></main>`;
  } else {
    const description = stopped ? '项目已停止，保留当时快照' : verified === count ? '全部已核' : '当前停在第 ' + focus + ' 步';
    body = `<main data-focus="${focus}" data-complete="${verified === count}"><header class="mast"><h1>${esc(meta.flow[0])}</h1>
<p class="summary">共 ${count} 步 · 已核 ${verified} 步 · ${description}</p>
<nav aria-label="查看项目步骤"><button type="button" data-prev>上一步</button><button type="button" data-next>下一步</button><button type="button" data-walk aria-pressed="false">按序走一遍</button></nav>
<div class="meter" aria-hidden="true">${meta.steps.map(s => '<i class="' + s[2] + '"></i>').join('')}</div><p id="notice" role="status"></p></header>
${mapScene(meta,false,focus)}
${mapScene(meta,true,focus)}
${stepsOf(meta.flow[2],null,true).map((s,i) => mapCard(meta,s,i,focus,stopped)).join('\n')}</main>`;
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${CSP}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
${mapShaTag(raw)}
<title>${esc(meta.flow[0])}</title><style>${style}</style></head>
<body>${body}
${MAP_ISLAND}${raw}</script>
<script>${script}</script></body></html>
`;
}
// 仅显式升级会替换旧 Archify；普通刷新仍走它原先的核对路径。
function upgradeProjectMap(root, old, source, lines, fl, draw, generated) {
  if (draw !== false) { no('图的选择需明确为出图；不画图时保留原件'); return; }
  if (old.kind === 'missing') { no('未找到项目原图，请用普通 flow 首次出图'); return; }
  if (old.kind === 'bad' || source.broken) { no('没有可信的原图或图源，保留原件'); return; }
  const pendingDelivery = () => ['','docs\\','docs\\check\\'].some(prefix =>
    deliveryLocks.some(file=>mapEntry(root,prefix+file).st));
  if (pendingDelivery()) { no('原图的交付正在进行，保留原件'); return; }
  if (old.kind==='archify') {
    const expected=toPic(generated), actual=source.json ? toPic(source.json) : expected;
    if (source.json) {
      const graph=source.json;
      const fourLanes=Array.isArray(graph.lanes) && graph.lanes.some(l=>l?.id==='prog');
      const sourceDiff=fourLanes ? picDiff(actual,expected)
        : legacySourceDiff(graph,stepsOf(fl.rows),fl.inRows.map(r=>inputId(r[0])).filter(Boolean),generated)[0]?.[1];
      if (sourceDiff) { no(fourLanes ? '图源与当前运行表不一致，保留原件：'+sourceDiff : sourceDiff+'，保留原件'); return; }
    }
    const htmlDiff=picDiff(old.pic,actual);
    if (htmlDiff) {
      if (!source.json) { no('旧图缺图源，现表不能核回旧图，保留原件：'+htmlDiff); return; }
      note('旧图落后于当前运行表及一致图源，列明差异后备份并升级：'+htmlDiff);
    }
  }
  const meta=mapSnapshot(mapPlan(root,lines,fl.inRows,fl.rows));
  if (!liveShape(meta)) { no('项目活地图取数未核，保留原件'); return; }
  const page=Buffer.from(renderLiveMap(meta));
  if (page.length>MAX_HTML || Buffer.byteLength(islandJson(meta))>1024*1024) { no('项目活地图超过大小上限'); return; }
  if (old.kind==='live' && old.bytes.equals(page)) { ok('项目活地图已是当前版，原件保留'); return; }
  const table=mapEntry(root,RUN_MD), graph=mapEntry(root,SELF), expected=lines.join('\n');
  const inputsUnchanged=()=> !pendingDelivery()
    && unchangedEntry(table.st,mapEntry(root,RUN_MD).st)
    && mapText(root,RUN_MD)?.split(/\r?\n/).join('\n')===expected
    && (graph.st ? unchangedEntry(graph.st,mapEntry(root,SELF).st) : !mapEntry(root,SELF).st)
    && mapText(root,SELF)===(source.text ?? null);
  const backup='docs\\check\\历史\\run-flow-'+digest(old.bytes)+'.html';
  mapPublish(root,old,page,{backup,inputsUnchanged});
  const current=readProjectMap(root);
  if (current.kind!=='live' || !current.bytes.equals(page)) { no('已提交的新图未能读回复算，请用备份复核'); return; }
  ok('已升级项目活地图并复算，原图备份 '+backup);
}

function readProjectMap(root) {
  try {
    return mapRead(root, RUN_HTML, (fd, file) => {
      if (file.st.size > MAX_HTML) throw new Error('超过 8 MiB');
      const bytes = readBytes(fd,file.st.size), html = new TextDecoder('utf-8', { fatal:true }).decode(bytes);
      const islands = [...html.matchAll(/<script\b[^>]*\bid\s*=\s*(?:"coach-live-map-meta"|'coach-live-map-meta'|coach-live-map-meta(?=[\s>]))[^>]*>/gi)];
      const sums = [...html.matchAll(/<meta\b[^>]*\sname\s*=\s*(?:"coach-map-sha"|'coach-map-sha'|coach-map-sha(?=[\s>]))[^>]*>/gi)];
      const arch = /<g\b[^>]*\b(?:data-node-id|data-legend-kind)\s*=/i.test(html);
      if (islands.length || sums.length || html.includes(MAP_ISLAND)) {
        if (arch || islands.length !== 1 || islands[0][0] !== MAP_ISLAND) throw new Error('活地图标记破损、重复或混入旧图');
        const at = islands[0].index + MAP_ISLAND.length, end = html.indexOf('</script>',at);
        const raw = html.slice(at,end), head = html.indexOf('<head>');
        if (end < at || Buffer.byteLength(raw) > 1024 * 1024) throw new Error('活地图数据岛缺失或超限');
        if (sums.length !== 1 || head < 0 || sums[0].index < head + 6 || sums[0].index >= html.indexOf('</head>',head) ||
            sums[0][0] !== mapShaTag(raw)) throw new Error('活地图数据岛与页头校验不一致');
        const meta = JSON.parse(raw);
        const matches=(previous,script)=>Buffer.from(renderLiveMap(meta,previous,script)).equals(bytes);
        if (!liveShape(meta)) throw new Error('活地图整页复算不一致');
        if (!matches(false) && !matches(true)) {
          // 公开 v2.0.0 和修复前候选使用相同脚本；正文、按钮、CSP 和数据仍须逐字重算。
          const script=html.slice(html.lastIndexOf('<script>')+8,html.lastIndexOf('</script>'));
          if (digest(script)!=='4c2e1cc5384f71db896362c2a55d9816ba2e0abeb34660fc61e70a6e2a4615d8' ||
              !matches(false,script)) throw new Error('活地图整页复算不一致');
        }
        return { kind:'live', meta, bytes, st:file.st };
      }
      const pic = arch ? picFromHtml(html) : null;
      if (pic?.mismatch) return {kind:'bad',reason:pic.err,mismatch:true};
      if (!pic?.nodes?.length || pic.nodes.some(n => !n.id || !n.kind || !n.label || !n.lane || !n.phase))
        throw new Error(pic?.err ?? '读不出可信的流程图节点');
      return { kind:'archify', pic, bytes, st:file.st };
    }) ?? { kind:'missing' };
  } catch (e) {
    return { kind:'bad', reason: e.code === 'ERR_ENCODING_INVALID_ENCODED_DATA' ? '不是 UTF-8' : (e.code ?? e.message) };
  }
}
function badMapMessage(old) {
  return old.mismatch ? '图和图源不一致：'+old.reason+'（'+RUN_HTML+' 图源异常）' : RUN_HTML+' 图源异常：'+old.reason;
}
function mapDifference(before, after) {
  const [name, inputs, rows] = after.flow;
  if (before.flow[0] !== name) return '项目名称已变';
  if (JSON.stringify(before.flow[1]) !== JSON.stringify(inputs)) return '输入或本批参数已变';
  for (const [i,row] of rows.entries()) {
    const old = before.flow[2][i];
    if (old?.[1] !== row[1]) return `第 ${row[0]} 步已改为${row[1] === '你' ? '你判断' : MAP_ROLES[WHO.indexOf(row[1])]}`;
    if (JSON.stringify(old) !== JSON.stringify(row)) return `第 ${row[0]} 步的读写、依据或退回已变`;
  }
  if (before.flow[2].length !== rows.length) return '运行表步数已变';
  const i = after.steps.findIndex((s,i) => JSON.stringify(s) !== JSON.stringify(before.steps[i]));
  if (i < 0) return '';
  if (after.steps[i][7] && JSON.stringify(after.steps[i][7]) !== JSON.stringify(before.steps[i][7]))
    return `票 ${pad(i+1)} 已换批次`;
  return `票 ${pad(i+1)} 的状态、批次或实物已变`;
}
function verifyProjectMap(root, old, lines, fl, refresh, draw) {
  if (old.kind === 'bad' || old.kind === 'archify') return;
  if (draw === true) {
    if (old.kind === 'live') note(RUN_HTML + ' 当旧图，不比');
    return;
  }
  if (draw === null || !fl?.rows || !fl?.inRows || !fl.rows.length) return;
  try {
    const meta = mapSnapshot(mapPlan(root, lines, fl.inRows, fl.rows));
    if (!liveShape(meta)) { no('项目活地图取数未核，检查运行表和任务单'); return; }
    const page = Buffer.from(renderLiveMap(meta));
    if (page.length > MAX_HTML || Buffer.byteLength(islandJson(meta)) > 1024 * 1024) { no('项目活地图超过大小上限'); return; }
    const change = old.kind === 'live' ? mapDifference(old.meta,meta) : '';
    if (old.kind === 'live' && !change && page.equals(old.bytes)) ok('项目活地图与现有文件一致');
    else if (cmd === 'flow' && (old.kind === 'missing' || refresh)) {
      mapPublish(root,old,page);
      ok((old.kind === 'missing' ? '写好' : '刷新') + '项目活地图 ' + RUN_HTML);
    } else if (old.kind === 'live') no('地图已过期，请让 AI 按现有文件刷新：' + (change || '活地图版式已升级'));
  } catch (e) {
    if (e instanceof Stop) throw e;
    no('项目活地图未核：' + (e.code ?? e.message));
  }
}

// ---------- 学员画的图：只认 Archify html 的数据属性（专用读法，不进 readTree 的 TEXT）；图源先转成同一形状，只有一个比较器 ----------
const MAX_HTML = 8 * 1024 * 1024, RUN_HTML = 'docs\\run-flow.html';
const SELF = 'docs\\check\\run-flow.workflow.json';

// ---------- 安全取件与地图提交 ----------
class MapPathError extends Error {}
const MAP_SCRIPT_ID = 'coach-live-map-meta';
const MAP_ISLAND = '<script type="application/json" id="' + MAP_SCRIPT_ID + '">';
const MAP_LOCK = 'docs\\check\\run-flow.html.lock';
const RUN_MD = 'docs\\run-flow.md', RUN_TXT = 'docs\\check\\run-flow.txt';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sameEntry = (a, b) => a?.ino === b?.ino && a?.dev === b?.dev;
function readBytes(fd, size) {
  const bytes=Buffer.alloc(Number(size));
  let offset=0;
  while (offset<bytes.length) {
    const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);
    if (!n) throw new Error('读取时文件缩短');
    offset+=n;
  }
  return bytes;
}
const unchangedEntry = (a, b) => sameEntry(a, b) && a?.size === b?.size && a?.mtimeNs === b?.mtimeNs && a?.ctimeNs === b?.ctimeNs;
const entryStat = abs => fs.lstatSync(abs, { bigint: true, throwIfNoEntry: false });
const badPath = (rel, why) => { throw new MapPathError(`路径 ${rel} ${why}`); };
function mapParts(rel) {
  if (!rel || /^[\\/]/.test(rel) || /[:*?"<>|\p{Cc}]|%(?:25|2e|2f|3a|5c|[01][0-9a-f]|7f)/iu.test(rel) ||
      (rel.includes('/') && rel.includes('\\'))) badPath(rel, '不是安全的项目相对路径');
  const parts = rel.replace(/[\\/]$/, '').split(/[\\/]/);
  if (parts.some(s => !s || /[ .]$/.test(s) ||
      /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/i.test(s.split('.')[0].trimEnd())))
    badPath(rel, '含非法文件名或目录段');
  return parts;
}
function mapEntry(root, rel, {humanMention=false} = {}) {
  if (memoryPath(rel) || memoryPath(root)) badPath('平台记忆目录','不读取正文');
  const parts = mapParts(rel);
  let abs = root, st = entryStat(root);
  if (!st?.isDirectory() || st.isSymbolicLink() || path.relative(root, real(root))) badPath(rel, '的项目根无法核实');
  for (const [i, part] of parts.entries()) {
    abs = path.join(abs, part);
    st = entryStat(abs);
    if (!st) return { abs: path.join(abs, ...parts.slice(i + 1)), rel: parts.join('\\') };
    if (st.isSymbolicLink()) badPath(rel, '含联接或断链，未跟随');
    if (!st.isDirectory() && (!st.isFile() || i < parts.length - 1)) badPath(rel, '不是普通文件或目录');
    if (st.isFile() && st.nlink !== 1n) badPath(rel, '是硬链接，未读取');
    const realAbs = fs.realpathSync.native(abs);
    if (!inside(root, realAbs) || path.relative(abs, realAbs) || inside(COACH, realAbs)) badPath(rel, '越出项目范围或有别名');
    const name=path.basename(realAbs);
    if (name!==part && !(humanMention && name.toLowerCase()===part.toLowerCase())) badPath(rel, '文件名大小写与实物不一致');
  }
  return { abs, st, rel: path.relative(root, fs.realpathSync.native(abs)) };
}
function mapRead(root, rel, read) {
  const file = mapEntry(root, rel);
  if (!file.st) return null;
  if (!file.st.isFile()) badPath(rel, '不是文件');
  const fd = fs.openSync(file.abs, 'r');
  try {
    const now = fs.fstatSync(fd, { bigint: true });
    if (!unchangedEntry(file.st, now) || now.nlink !== 1n || !unchangedEntry(now, mapEntry(root, rel).st))
      badPath(rel, '读取前发生变化');
    const value = read(fd, file);
    if (!unchangedEntry(now, fs.fstatSync(fd, { bigint: true }))) badPath(rel, '读取时发生变化');
    return value;
  } finally { fs.closeSync(fd); }
}
function mapText(root, rel, max = MAX_TEXT) {
  if (root===SRC && scanTree && max===MAX_TEXT) {
    const cached=scanTree.byPath.get(rel.replaceAll('/','\\').toLowerCase());
    if (cached?.text!==undefined) {
      const current=mapEntry(root,rel).st;
      if (current && unchangedEntry(cached.st,current)) return cached.text;
      badPath(rel,'缓存的文件已变动');
    }
  }
  return mapRead(root, rel, (fd, file) => {
    if (file.st.size > BigInt(max)) throw new Error(`${rel} 超过读取上限`);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(readBytes(fd,file.st.size)); }
    catch (e) { if (e.code !== 'ERR_ENCODING_INVALID_ENCODED_DATA') throw e; throw new Error(`${rel} 不是 UTF-8`); }
  });
}
function mapPublish(root, before, page, {backup,inputsUnchanged} = {}) {
  const tmpRel = `docs\\check\\run-flow.html.${process.pid}.tmp`;
  const owned = [];
  let parents;
  const sameParents = () => {
    try { return parents.every(p => sameEntry(p.st, mapEntry(root, p.rel).st)); } catch { return false; }
  };
  function create(abs) {
    if (!sameParents()) throw new Error('目录在写入前已变动');
    const fd = fs.openSync(abs, 'wx');
    try { owned.push([abs, fs.fstatSync(fd, { bigint: true })]); }
    catch (e) { fs.closeSync(fd); throw e; }
    return fd;
  }
  try {
    const [dest, lock, tmp] = [RUN_HTML, MAP_LOCK, tmpRel].map(rel => { mapEntry(root, rel); return guard(rel); });
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    parents = ['docs', 'docs\\check'].map(rel => mapEntry(root, rel));
    try { fs.closeSync(create(lock)); }
    catch (e) { if (e.code === 'EEXIST') stop('项目地图正在更新，请重试'); throw e; }
    if (backup) {
      const where=mapEntry(root,backup);
      fs.mkdirSync(path.dirname(where.abs),{recursive:true});
      if (!sameParents()) throw new Error('备份目录的上一级已变动');
      parents.push(mapEntry(root,'docs\\check\\历史'));
      if (!where.st) {
        const fd=create(guard(backup));
        try { fs.writeFileSync(fd,before.bytes); fs.fsyncSync(fd); }
        finally { fs.closeSync(fd); }
      }
      if (!mapRead(root,backup,fd=>fs.readFileSync(fd))?.equals(before.bytes))
        throw new Error('同名备份不同或未能读回来');
      if (owned.at(-1)[0]===where.abs) owned.pop();
    }
    const fd = create(tmp);
    try { fs.writeFileSync(fd, page); } finally { fs.closeSync(fd); }
    if (!mapRead(root, tmpRel, fd => fs.readFileSync(fd)).equals(page)) throw new Error('临时文件未写全');
    const current = readProjectMap(root);
    if (!sameParents() || !sameEntry(owned[0][1],entryStat(lock)) || !sameEntry(owned[1][1],entryStat(tmp)) || parents[0].st.dev !== parents[1].st.dev ||
        (backup && (!inputsUnchanged() || !mapRead(root,backup,fd=>fs.readFileSync(fd))?.equals(before.bytes))) ||
        (before.kind === 'missing' ? current.kind !== 'missing' :
          current.kind !== before.kind || !unchangedEntry(before.st, current.st) || !before.bytes.equals(current.bytes)))
      throw new Error('目标或目录在提交前已变动');
    // 硬链接只在首发成功后保留目标目录项，竞争者先落盘时 EEXIST 不覆盖。
    if (before.kind === 'missing') fs.linkSync(tmp, dest);
    else fs.renameSync(tmp, dest);
  } catch (e) {
    if (e instanceof Stop) throw e;
    stop('地图未刷新，保留原图：' + (e.code ?? e.message));
  } finally {
    if (sameParents()) for (const [abs, st] of owned.reverse()) {
      if (sameEntry(st, entryStat(abs))) fs.unlinkSync(abs);
    }
  }
}

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', '#39': "'" };
const unent = (s) => s.replace(/&(lt|gt|amp|quot|#39|#(\d+));/g, (m, k, n) => (n ? String.fromCodePoint(n > 0 && (n < 0xD800 || n > 0xDFFF) ? Number(n) : NaN) : ENT[k])); // &#0;、代理区、超出 Unicode：浏览器都显示成 �，这里抛 RangeError，picOf 记没读
// 读一张 html：{ nodes:[{id,label,sublabel,kind,lane,phase,col}], edges:[{id,from,to,label,dashed}], legend:{kind:label} }；超限、解不开回 { err }；读不出框回 null
// html 没有列号，col 一律 undefined，不从列头或节点顺序猜
function picOf(abs) {
  const st = fs.statSync(abs);
  if (!st.isFile()) return { err: '不是文件' };
  if (st.size > MAX_HTML) return { err: '超过 8 MB' };
  let s;
  try { s = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(abs)); } catch { return { err: '不是 UTF-8' }; }
  return picFromHtml(s);
}
function picFromHtml(s) {
  const tags = (re) => [...s.matchAll(re)].map(([t]) => Object.fromEntries([...t.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [k, unent(v)])));
  try { // unent 碰到不合法的 &#数字; 抛 RangeError：这张图记没读（不 ✓ 不 ✗），别的检查照常
    const nodes = tags(/<g\b[^>]*\bid="node-[^"]*"[^>]*>/g).filter((a) => a['data-node-id'] !== undefined).map((a) => {
      const [lane, ...ph] = (a['data-node-context'] ?? '').split('›'); // "<道> › <列头>"
      return { id: a['data-node-id'], label: a['data-node-label'] ?? '', sublabel: a['data-node-sublabel'] ?? '', kind: a['data-node-kind'] ?? '',
        lane: lane.trim() || undefined, phase: ph.length ? ph.join('›').trim() : undefined, col: undefined };
    });
    if (!nodes.length) return null;
    const edges = tags(/<path\b[^>]*\bdata-edge-id="[^"]*"[^>]*>/g).map((a) => ({ id: a['data-edge-id'], from: a['data-edge-from'], to: a['data-edge-to'], label: a['data-edge-label'] ?? '', dashed: /\ba-dashed\b/.test(a.class ?? '') })); // 一条边只一个 <path>（另一处在 <g data-detail>，不抽）；同 id 两条由 picDiff 报
    const ids=new Set(), edgeIds=new Set();
    for (const n of nodes) {
      if (!n.id.trim()) return {err:'旧图有空的节点编号',mismatch:true};
      if (ids.has(n.id)) return {err:'多框 '+n.id+'（'+n.label+'）',mismatch:true};
      ids.add(n.id);
    }
    for (const e of edges) {
      if (!e.id.trim()) return {err:'旧图有空的连线编号',mismatch:true};
      if (edgeIds.has(e.id)) return {err:'多线 '+e.id+'（'+e.label+'）',mismatch:true};
      if (!ids.has(e.from) || !ids.has(e.to)) return {err:'线 '+e.id+' 的起点或终点不存在',mismatch:true};
      edgeIds.add(e.id);
    }
    const legend = {}; // 同一 kind 两项文字不同就连起来，比的时候必不等
    for (const a of tags(/<g\b[^>]*\bdata-legend-kind="[^"]*"[^>]*>/g)) { const k = a['data-legend-kind'], v = a['data-legend-label'] ?? ''; legend[k] = legend[k] === undefined || legend[k] === v ? v : `${legend[k]}、${v}`; }
    return { nodes, edges, legend };
  } catch (e) { if (e instanceof RangeError) return { err: '有不合法的字符编号 &#…;' }; throw e; }
}
// 图源 JSON → 和 picOf 同一形状：道、列头换成 label，type 换成 kind，variant 换成虚实，图例只取节点用到的 type；缺了不抛错
function toPic(j) {
  const arr = (x) => (Array.isArray(x) ? x.filter((y) => y && typeof y === 'object') : []), lanes = arr(j?.lanes), phases = arr(j?.phases), entries = j?.meta?.legend?.entries ?? {};
  const nodes = arr(j?.nodes).map((n) => ({ id: n.id, label: String(n.label ?? ''), sublabel: String(n.sublabel ?? ''), kind: n.type ?? '',
    lane: lanes.find((l) => l.id === n.lane)?.label ?? '读不出', phase: phases[n.col]?.label, col: n.col }));
  const legend = Object.fromEntries([...new Set(nodes.map((n) => n.kind))].filter((k) => entries[k]?.label !== undefined).map((k) => [k, entries[k].label]));
  return { nodes, edges: arr(j?.edges).map((e) => ({ id: e.id, from: e.from, to: e.to, label: String(e.label ?? ''), dashed: e.variant === 'dashed' })), legend };
}
// 比两张同一形状的图（a 是画出来的，b 是该有的）：框、线按 id 比，图例比 b 用到的每种 kind；回第一处不同的句子，没有回 null
function picDiff(a, b) {
  const tell = (v) => (v === true ? '虚线' : v === false ? '实线' : v ?? '没有');
  for (const [what, xs, ys, keys] of [['框', a.nodes, b.nodes, { label: '文字', sublabel: '小字', kind: '类别', lane: '道', phase: '列头' }],
    ['线', a.edges, b.edges, { from: '起点', to: '终点', label: '文字', dashed: '虚实' }]]) {
    const mx = new Map(xs.map((x) => [x.id, x])), my = new Map(ys.map((y) => [y.id, y]));
    for (const y of ys) {
      const x = mx.get(y.id);
      if (!x) return `缺${what} ${y.id}（${y.label}）`;
      for (const [k, name] of Object.entries(keys)) if (x[k] !== y[k]) return `${what} ${y.id} 的${name}不一致（图上"${tell(x[k])}"，图源"${tell(y[k])}"）`;
    }
    const extra = xs.find((x) => !my.has(x.id) || mx.get(x.id) !== x); // 同 id 两个：Map 只留最后一个，前面那个也算多出来的
    if (extra) return `多${what} ${extra.id}（${extra.label}）`;
  }
  for (const k of new Set(b.nodes.map((n) => n.kind))) if (a.legend[k] !== b.legend[k])
    return a.legend[k] === undefined ? `图例缺 ${b.legend[k]}` : `图例 ${k} 不一致（图上"${a.legend[k]}"，图源"${tell(b.legend[k])}"）`;
  return null;
}
function readFlowSource(root) {
  try {
    const text = mapText(root,SELF);
    if (text === null) return {};
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object' || Array.isArray(json) || ['nodes','edges','lanes','phases'].some(k =>
        json[k] !== undefined && (!Array.isArray(json[k]) || json[k].some(v => !v || typeof v !== 'object' || Array.isArray(v))))) {
      no('自家图源 ' + SELF + ' 结构不对，未核');
      return { broken:true };
    }
    return { text,json };
  } catch (e) {
    no('自家图源 ' + SELF + ' ' + (e instanceof SyntaxError ? '不是合法的 JSON' : '未核：' + (e.code ?? e.message)));
    return { broken:true };
  }
}
function checkArchifyMap(old, source, fl, noDraw, generated) {
  const { pic } = old;
  if (noDraw === null || source.broken) return false;
  if (noDraw) {
    note(RUN_HTML + ' 当旧图，不比');
    return false;
  }
  const compare = source.json ?? generated;
  if (!compare) { note('旧图缺原图源，未核；请沿原画图办法找回旧图源'); return false; }
  const difference = picDiff(pic, toPic(compare));
  if (!source.json && difference) {
    no('旧图缺原图源，现表不能核回旧图：' + difference + '；请沿原画图办法恢复');
    return false;
  }
  if (difference) no('图和图源不一致：' + difference + '；请按原画图办法更新');
  else ok(`图和图源一致：${pic.nodes.length} 框、${pic.edges.length} 线（${RUN_HTML}）`);
  if (source.json) selfPic(source,fl);
  return !source.json && !difference;
}

// 运行表 → Archify workflow JSON。四道：你、AI（看情况）、程序（AI照规矩）、文件；列＝步号；读写连线、下一步、退回；你的判断画红框、列头变色
function swimlane(title, ids, steps, dirs) {
  const nodes = [], edges = [], used = new Set(), made = new Map(); // made：路径 → [文件节点, 写它的那步的节点]
  // ponytail: 四泳道短表预留桌面宽度；shortcut: 最多 3 步按 1200 像素估宽，实测仍溢出时再调布局。
  const minWidth = steps.length <= 3 ? Math.ceil(1200 / (steps.length + 1)) : 96;
  // 宽度照 archify 的算法估：全角字算 2 份、半角算 1 份。估宽了图会太宽，1440 屏上字小到判不过
  const units = (t) => [...t].reduce((n, ch) => n + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  const node = (id, lane, col, type, label, sublabel, tag) => nodes.push({ id, lane, col, type, label, ...(sublabel ? { sublabel } : {}), ...(tag ? { tag } : {}),
    width: Math.max(minWidth, ...[label, sublabel ?? ''].map((t) => units(t) * 7 + 28)) });
  const edge = (base, from, to, label, variant, role) => { let id = base, k = 1; while (used.has(id)) id = base + ++k; used.add(id); edges.push({ id, from, to, label, variant, ...(role ? { role } : {}) }); };
  const actor = (K) => (steps[K - 1]?.who === '你' ? 'you' : 'a') + K; // 第 K 步做事的框
  // 红框写"你核第 N 步：<你要判断什么的第一段>"，太长就截短加"…"
  // 同步回路实测：标题限50份宽，完整退回条件仍在箭头，避免1440屏文字投影小于6px。
  const box = (N, judge) => {
    const t = `你核第 ${N} 步：${judge.split('｜')[0].trim()}`;
    if (units(t) <= 50) return t;
    let s = '';
    for (const ch of t) { if (units(s + ch) > 48) break; s += ch; }
    return s + '…';
  };
  const phases = [{ id: 'p0', label: '开始：放输入', fromCol: 0, toCol: 0 }];
  node('you0', 'you', 0, 'external', '放入或补换输入', '照输入清单；补齐不代批准');
  node('f0', 'files', 0, 'database', `${dirs.join('、')}（每次放）`, ids.join('｜'));
  edge('r0-put', 'you0', 'f0', '放入', 'emphasis');
  steps.forEach((s, j) => {
    const N = j + 1, me = s.who === '你', a = (me ? 'you' : 'a') + N, gate = s.judge !== '—';
    const back = s.returns.length ? (s.unclear ? '退回条件未核' : '条件、动作见退回箭头') : ''; 
    const ruleNames = [...new Set([...s.what.matchAll(/docs[\\/]rules[\\/]([^\\/\r\n]*?\.md)(?=$|[^A-Za-z0-9_.-])/gi)].map((m) => m[1]))];
    const readRules = ruleNames.length ? `先读规则：${ruleNames.join('、')}` : '';
    phases.push({ id: `p${N}`, label: `第${N}步 ${s.short}`, fromCol: N, toCol: N, ...(gate ? { variant: 'emphasis' } : {}) });
    if (me) node(a, 'you', N, 'security', box(N, s.judge), [back, readRules].filter(Boolean).join('；'), '你判断');
    else if (s.who === 'AI照规矩') node(a, 'prog', N, 'backend', s.short, readRules);
    else node(a, 'ai', N, 'cloud', s.short, readRules);
    // 读：输入从 f0（"放哪"的文件夹）连过来；"你"那一步读前面的产出，画成"那一步 → 你"交你看
    const src = new Map(stepRefs(steps,N,ids).flatMap(({ref,source}) => {
      if (source === null) return [];
      if (!source) return [['f0','读']];
      const maker = made.get(ioKey(ref));
      return maker ? [me ? [maker[1],'交你看'] : [maker[0],'读']] : [];
    }));
    for (const [from, label] of src) edge(`r${N}-in`, from, a, label, label === '读' ? 'dashed' : 'emphasis');
    // 写：一步一个文件框（同一格放两个框会叠在一起），第一个路径当标题，其余写在下面
    if (s.to.length) {
      node(`f${N}`, 'files', N, 'database', s.to[0], s.to.slice(1).join('、'));
      for (const x of s.to) made.set(ioKey(x), [`f${N}`, a]);
      edge(`r${N}-out`, a, `f${N}`, '写', 'dashed');
    }
    if (gate && !me) { node(`you${N}`, 'you', N, 'security', box(N, s.judge), back, '你判断'); edge(`r${N}-gate`, a, `you${N}`, '交你看', 'emphasis'); }
    if (!s.unclear) for (const r of s.returns) edge(`r${N}-back${r.to}`, `you${N}`, actor(r.to), r.label, 'dashed', 'return');
    if (gate && steps[N]) edge(`r${N}-ok`, `you${N}`, actor(N + 1), '对了', 'emphasis');
  });
  // 没有判断的第 N 步，它的框 → 第 N+1 步的框画"下一步"；两框之间已有边（如"交你看"）的不加
  if (ids.length && steps[0]?.short === '认出输入') {
    edge('input-invalid', actor(1), 'you0', '输入不合格，停下问你补换', 'dashed', 'return');
    edge('input-retry', 'you0', actor(1), '补换后核原确认，有效才重新识别', 'dashed', 'return');
  }
  steps.forEach((s, j) => {
    const A = actor(j + 1), B = actor(j + 2);
    if (steps[j + 1] && s.judge === '—' && !edges.some((e) => (e.from === A && e.to === B) || (e.from === B && e.to === A))) edge(`r${j + 1}-next`, A, B, '下一步', 'emphasis');
  });
  return {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: `${title}：谁做、从哪拿、放到哪、你在哪判断`, locale: 'zh-CN', animation: 'none', quality_profile: 'standard', output: 'run-flow.html',
      legend: { mode: 'auto', entries: { security: { label: '你判断' }, external: { label: '你放入' }, cloud: { label: 'AI看情况' }, backend: { label: '程序（AI照规矩）' }, database: { label: '文件' } } } },
    lanes: [{ id: 'you', label: '你' }, { id: 'ai', label: 'AI（看情况）' }, { id: 'prog', label: '程序（AI照规矩）' }, { id: 'files', label: '文件' }],
    phases, nodes, edges,
  };
}

// 第 i 行标题下面的内容，到同级或更高级的下一个标题为止
function below(lines, i, until) {
  if (!Array.isArray(lines)) return i ? lines.rows.slice(i.after, until ?? i.end).map(row => row.visible) : [];
  // 非票据文档仍沿用原来的两参数边界。
  const masked = unfence(lines);
  const lv = lines[i].trimStart().match(/^#+/)[0].length;
  let k = i + 1;
  while (k < masked.length && !((masked[k].match(/^[ ]{0,3}(#{1,6})(?:[ \t]|$)/)?.[1].length ?? 9) <= lv)) k++;
  return lines.slice(i + 1, k);
}
// 确认记录的一行必须保留模板约定的原话和版号。预检锁定和运行许可分别检查。
const CONFIRM = /^- 第\s*(\d+)\s*次确认\s*(?:[（(]\s*第\s*(\d+)\s*版\s*[）)])?\s*[：:]/;
const hold = (l) => /第\s*K\s*次/.test(l) || /[：:]\s*<[^<>]*>\s*(?:[｜|]\s*<[^<>]*>\s*)?$/.test(l);
const confirmationRows = lines => lines.map(l => l.trim()).filter(l => l.startsWith('- 第') && !hold(l));
const ROUND = /^第\s*([1-9]\d*)\s*轮(?:\s*(?:[|｜]\s*(?:按第\s*([1-9]\d*)\s*次确认\s*)?(?:[（(]第\s*([1-9]\d*)\s*版[）)]|第\s*([1-9]\d*)\s*版)(?:的验收单)?|[（(]第\s*([1-9]\d*)\s*版[）)]))?$/u;
const SHEET = /^验收单[（(]第\s*([1-9]\d*)\s*版[）)]$/;
const OLD_SHEET = /^## 验收单[（(]第\s*([1-9]\d*)\s*版[）)]\s*$/;
const isAtx = (h, level) => h.level === level && h.style === 'atx';
const inSection = (doc, h) => h ? doc.top.filter(k => k.start >= h.after && k.start < h.end) : [];
function parseRound(h) {
  const match = ROUND.exec(h.label);
  if (!match) return null;
  const version = match[3] ?? match[4] ?? match[5];
  return { start: h.start, heading: h, number: match[1], confirmNo: match[2], version: version ?? '1', explicitVersion: version !== undefined };
}
function ticketDocument(text) {
  const doc = mdTicket(text);
  const head = (level, label) => h => isAtx(h, level) && h.label === label;
  const sheet = doc.top.findLast(h => isAtx(h, 2) && h.label.startsWith('验收单'));
  const result = doc.top.findLast(head(2, '结果'));
  const self = inSection(doc, sheet).filter(head(3, 'AI 自检'));
  const step = doc.top.find(h => isAtx(h, 2) && /^这一步(?:$|[（( ])/.test(h.label));
  const confirms = confirmationRows(below(doc, doc.top.find(head(2, '确认记录'))));
  const rounds = inSection(doc, result).filter(h => isAtx(h, 3)).map(parseRound).filter(Boolean);
  return Object.assign(doc, { sheet, version: SHEET.exec(sheet?.label)?.[1], self, step, confirms, rounds });
}
const roundAt = doc => doc.rounds[0]?.start ?? -1;
const hasVersionRound = (doc, version) => doc.rounds.some(round => round.version === version);
const confirmationFor = (confirms, version) => confirms.findLast(l => {
  const m = CONFIRM.exec(l), value = m && l.slice(m[0].length).trim();
  return m && m[2] === version && !/<[^<>]*>/.test(value) && /^[^｜|]+[｜|]\s*\S/.test(value);
});

function readTicket(number = extra) {
  if (!/^\d{1,2}$/.test(number ?? '')) stop(`票号要写 1 到 2 位数字，现在是"${number ?? ''}"`);
  const N = Number(number), NN = pad(N);
  const dir = path.join(PROJ, 'docs', 'tickets');
  const names = lexists(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(NN + '-') && f.endsWith('.md')) : [];
  if (names.length !== 1) {
    no(names.length ? `票 ${NN} 有 ${names.length} 份（${names.join('、')}），只能有一份` : `docs\\tickets 里没有票 ${NN}（${NN}-*.md）`);
    return null;
  }
  const text = fs.readFileSync(path.join(dir, names[0]), 'utf8');
  return { N, NN, doc: ticketDocument(text) };
}
function readProjectIndex(dir = PROJ) {
  const idx = path.join(dir, 'docs', 'PROJECT_INDEX.md');
  const st = fs.lstatSync(idx, { throwIfNoEntry: false });
  if (!st) return '';
  if (!st.isSymbolicLink() && st.isFile()) {
    const target = real(idx);
    if (inside(dir, target) && (dir !== PROJ || !inMaterials(target))) return fs.readFileSync(target, 'utf8');
  }
  no('docs\\PROJECT_INDEX.md 不是项目内的普通文件');
  return null;
}

// 快跑只认进度记录中最新批次；每张票仍用自己的确认行和最新版验收单。
const FAST_BATCH = /^- 快跑批次：(\d{4}-\d{2}-\d{2})｜(\d{2}@[1-9]\d*(?:、\d{2}@[1-9]\d*)*)｜按快跑档推进$/;
function checkFastBatch({ N, rows, doc, indexText }, version, date) {
  if (indexText === null) return; // ticketContract 已报告索引路径错误
  const lines = indexText.split(/\r?\n/);
  if (!lines.some((l) => /^当前站：4 一步一票\s*$/.test(l))) return no('快跑只在第 4 站生效');
  const i = lines.findIndex((l) => l.trim() === '## 已确认');
  const last = i < 0 ? '' : below(lines, i).map((l) => l.trim()).filter((l) => l.startsWith('- 快跑批次')).at(-1);
  const batch = FAST_BATCH.exec(last ?? '');
  if (!batch || batch[1] !== date) return no('最新快跑批次缺失、格式不符或日期与本票确认不一致');
  const scope = batch[2].split('、').map((item) => item.split('@'));
  if (!scope.some(([id, v]) => id === pad(N) && v === version)) return no('本票或本版验收单不在最新快跑确认范围内');
  for (const [j, [id]] of scope.entries()) {
    const num = Number(id), row = rows?.[num - 1];
    if ((j && num !== Number(scope[j - 1][0]) + 1) || row?.[0] !== String(num) || row[1] !== 'AI照规矩' || row[5] !== '—')
      return no('快跑批次必须是连续的 AI照规矩 步骤，每一步都不能有人工停点');
  }
  for (const [id, v] of scope) {
    if (Number(id) >= N) break;
    const previous = readTicket(id);
    if (!previous) return;
    const confirmation = previous.doc.confirms.at(-1) ?? '';
    const previousVersion = previous.doc.version;
    const match = confirmation.match(CONFIRM);
    const permission = match && confirmation.slice(match[0].length).trim().replace(/\s*[|｜]\s*/, '｜');
    if (v !== previousVersion || match?.[2] !== v || permission !== date + '｜按快跑档推进') {
      return no(`快跑在票 ${id} 前截断：前序票缺本批次运行授权或仅定稿`);
    }
  }
  const how = below(doc, doc.step).filter(l => l.startsWith('怎么做：'));
  const script = how.length === 1 && /^怎么做：写程序（(scripts\\\d{2}_[^\\/:*?"<>|]+\.js)）\s*$/.exec(how[0]);
  if (!script || !script[1].startsWith('scripts\\' + pad(N) + '_')) return no('快跑票的“怎么做”须只列本票的独立脚本：写程序（scripts\\NN_短名.js）');
  const abs = path.join(PROJ, script[1]);
  if (!inside(PROJ, real(abs)) || !fs.lstatSync(abs, { throwIfNoEntry: false })?.isFile()) no('快跑票的独立脚本缺失或不是项目内普通文件');
}

// 验收单只有两种格式：全量平铺，或两个非空的顶层四级断言块。
function assertionGroups(doc, self, reject = no) {
  const flat = [], fixed = [], current = [], facts = [];
  let target = flat, baseline = '', sawFixed = false, sawCurrent = false;
  for (const [k, visible] of below(doc, self).entries()) {
    const line = visible.trim();
    if (!line) continue;
    const at = self.after + k, h = doc.rows[at].block;
    const group = h?.kind === 'heading' && h.level === 4 && !h.owner.length ? h.label : '';
    const bound = /^固定基线断言（绑定参数：([^<>（）]+)）$/.exec(group);
    if (bound) {
      if (sawFixed) reject('固定基线断言重复');
      sawFixed = true;
      baseline = bound[1].trim();
      if (!baseline || /\.{3}|…|待填/.test(baseline)) reject('绑定参数须填写真实基线值');
      target = fixed;
      facts.push([at, 'fixed', group]);
    } else if (group === '当期守恒断言（每次必核）') {
      if (sawCurrent) reject('当期守恒断言重复');
      sawCurrent = true;
      target = current;
      facts.push([at, 'current', group]);
    } else {
      const assertion = parseSelfCheck(line, reject);
      if (assertion) {
        target.push(assertion);
        facts.push([at, target === flat ? 'flat' : target === fixed ? 'fixed' : 'current', assertion]);
      }
    }
  }
  if (sawFixed || sawCurrent) {
    if (!sawFixed || !sawCurrent || !fixed.length || !current.length || flat.length)
      reject('双轨验收须各有一块非空的固定基线断言和当期守恒断言，不能混用平铺断言');
  } else if (!flat.length) reject('AI 自检缺少有效断言');
  return { baseline, fixed, current: sawFixed || sawCurrent ? current : flat, facts };
}

function parseVer(s) {
  const m = /v(\d+)\.(\d+)(?:\.(\d+))?/.exec(s);
  return m && [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}
function verAtLeast(a, b) {
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
function projectVersions(text) {
  const createdVer = parseVer(/^搭建教练版本：[ \t]*(v\d+\.\d+(?:\.\d+)?)\b/m.exec(text)?.[1]);
  const marks = text.match(/^[ \t\u3000]*(?:>[ \t]*)*(?:[-*+][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]+)?(?:\*\*|__)?最近体检升级(?![\p{Script=Han}])[^\r\n]*/gmu);
  const upgrade = marks?.at(-1)?.match(/^最近体检升级[：:][ \t]*(v\d+\.\d+(?:\.\d+)?)[ \t]*[｜|][ \t]*(\d{4}-\d{2}-\d{2})(?:[ \t]*[｜|][ \t]*历史票[：:][ \t]*(.*))?[ \t]*$/);
  const upgradeDate = upgrade && isoDate(upgrade[2]);
  return { createdVer, upgradeVer: parseVer(upgrade?.[1]), upgradeDate, upgradeBroken: !!marks && !upgradeDate,
    legacySet: upgrade?.[3] === undefined ? null : new Set(upgrade[3].split('、').map(s => s.trim())) };
}
function isoDate(raw) {
  const date = raw.trim().replace(/[０-９－／．]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  const m = /^(\d{4})(?:[-/.](\d{1,2})[-/.](\d{1,2})|年(\d{1,2})月(\d{1,2})日)$/.exec(date);
  if (!m) return '';
  const iso = `${m[1]}-${pad(m[2] ?? m[4])}-${pad(m[3] ?? m[5])}`, ms = Date.parse(iso);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(iso + 'T') ? iso : '';
}
function unfence(lines) {
  const stack = [];
  let ch = '', len = 0, fDepth = 0, inPara = false;
  const tab = (s) => { let col = 0, out = ''; for (const c of s) if (c === '\t') { const n = 4 - (col % 4); col += n; out += ' '.repeat(n); } else { col++; out += c; } return out; };
  const isHr = (s) => /^[ ]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(s);
  const isAtx = (s) => /^[ ]{0,3}#{1,6}(?:[ \t]|$)/.test(s);
  const fenceOpen = (s) => { const m = /^[ ]{0,3}(`{3,}|~{3,})(.*)$/.exec(s); return m && (m[1][0] === '~' || !m[2].includes('`')) ? m : null; };
  return lines.map((raw) => {
    let s = tab(raw), k = 0;
    while (k < stack.length) {
      const c = stack[k];
      if (c.t === 'q') {
        const m = /^[ ]{0,3}> ?/.exec(s);
        if (!m) break;
        s = s.slice(m[0].length); k++;
      } else if (s.trim() === '') {
        if (c.empty) break;
        s = ''; k++;
      } else {
        const sp = /^ */.exec(s)[0].length;
        if (sp < c.w) break;
        c.empty = false; s = s.slice(c.w); k++;
      }
    }
    const lazy = inPara && !ch && k < stack.length && s.trim() !== '' && !/^[ ]{0,3}>/.test(s) && !isHr(s) && !isAtx(s)
      && !fenceOpen(s) && !/^[ ]{0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(s);
    if (!lazy && k < stack.length) { stack.length = k; inPara = false; if (ch && fDepth > k) ch = ''; }
    if (ch) { if (new RegExp(`^[ ]{0,3}${ch}{${len},}[ \\t]*$`).test(s)) ch = ''; inPara = false; return ''; }
    if (lazy) return raw;
    if (s.trim() === '') { inPara = false; return raw; }
    for (;;) {
      if (/^ {4}/.test(s)) { if (!inPara) return ''; break; }
      const qm = /^[ ]{0,3}> ?/.exec(s);
      if (qm) { stack.push({ t: 'q' }); s = s.slice(qm[0].length); inPara = false; continue; }
      if (isHr(s)) { inPara = false; return raw; }
      if (inPara && /^[ ]{0,3}(?:=+|-+)[ \t]*$/.test(s)) { inPara = false; return raw; }
      const lm = /^([ ]{0,3}(?:([-*+])|(\d{1,9})[.)]))(?:([ ]+)(?=\S)|[ ]*$)/.exec(s);
      if (lm) {
        if (inPara && (!lm[4] || (lm[3] && Number(lm[3]) !== 1))) break;
        const w = lm[1].length + (!lm[4] || lm[4].length >= 5 ? 1 : lm[4].length);
        s = lm[4] ? s.slice(lm[1].length + (lm[4].length >= 5 ? 1 : lm[4].length)) : '';
        stack.push({ t: 'l', w, empty: s.trim() === '' });
        inPara = false;
        continue;
      }
      break;
    }
    const fm = fenceOpen(s);
    if (fm) { ch = fm[1][0]; len = fm[1].length; fDepth = stack.length; inPara = false; return ''; }
    if (isAtx(s) || isHr(s) || s.trim() === '') { inPara = false; return stack.length && /^[ ]{0,3}#/.test(raw) ? '    ' + raw : raw; }
    inPara = true;
    return stack.length && /^[ ]{0,3}#/.test(raw) ? '    ' + raw : raw;
  });
}
// 票据的块边界按物理行定位，原文和给业务看的文字各自保留。
const mdSpace = (line, { pos, col }, limit = Infinity) => {
  while (col < limit && (line[pos] === ' ' || line[pos] === '\t')) {
    const next = col + (line[pos] === '\t' ? 4 - col % 4 : 1);
    if (next > limit) return { pos, col: limit, tabLeft: next - limit };
    col = next; pos++;
  }
  return { pos, col };
};
const mdStart = { pos: 0, col: 0 };
const mdView = (line, base) => {
  const at = mdSpace(line, base);
  return { at, indent: at.col - base.col, text: line.slice(at.pos) };
};
const mdHr = /^(?:\*(?:[ \t]*\*){2,}|-(?:[ \t]*-){2,}|_(?:[ \t]*_){2,})[ \t]*$/;
const mdSetext = /^(=+|-+)[ \t]*$/;
const mdAtx = /^(#{1,6})(?=[ \t]|$)/;
const mdList = /^(?:([-+*])|([0-9]{1,9})[.)])(?=[ \t]|$)/;
const mdFence = /^(\x60{3,}|~{3,})([\s\S]*)$/;
const mdFenceStart = text => {
  const m = mdFence.exec(text);
  return m && (m[1][0] === '~' || !m[2].includes('\x60')) ? m[1] : '';
};

// Python 的空白集合含 NEL 和 1C–1F，不含 BOM。
const mdWhite = String.raw`[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]`;
const mdTrim = new RegExp(`^${mdWhite}+|${mdWhite}+$`, 'g');
const mdAttribute = String.raw`(?:${mdWhite}+[A-Za-z_:][A-Za-z0-9:._-]*(?:${mdWhite}*=${mdWhite}*(?:"[^"]*"|'[^']*'|[^"'=<>\x60\x00-\x20]+))?)`;
const mdTag = String.raw`(?:<[A-Za-z][A-Za-z0-9-]*${mdAttribute}*${mdWhite}*/?>|</[A-Za-z][A-Za-z0-9-]*${mdWhite}*>)`;
const mdComment = String.raw`(?:<!---?>|<!--(?:[^-]|-[^-]|--[^>])*-->)`;
const mdInlineHtml = new RegExp(String.raw`(?:${mdTag}|${mdComment}|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>)`, 'y');
const mdBlockCase = names => names.replace(/[a-z]/g, c =>
  ({ i: '[iIİı]', k: '[kKK]', s: '[sSſ]' }[c] ?? '[' + c + c.toUpperCase() + ']'));
const mdRawBlock = mdBlockCase('script|pre|style|textarea');
const mdBlockNames = mdBlockCase('address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul');
const mdHtmlBlocks = [
  [new RegExp('^<(?:' + mdRawBlock + ')(?=' + mdWhite + '|>|$)'), new RegExp('</(?:' + mdRawBlock + ')>')],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<![A-Z]/, />/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [new RegExp('^</?(?:' + mdBlockNames + ')(?=' + mdWhite + '|/?>|$)'), null],
  [new RegExp('^' + mdTag + mdWhite + '*$'), null],
];
const mdHtml = (text, inParagraph) => text[0] === '<'
  ? mdHtmlBlocks.find(([start], i) => (!inParagraph || i < 6) && start.test(text)) : null;

const mdInlineText = /[^\n!#$%&*+:\-<=>@\[\]\\^_\x60{}~]+/y;
const mdInlineEntity = /&(?:#(?:x[0-9a-f]{1,6}|[0-9]{1,7})|([a-z][a-z0-9]{1,31}));/iy;
const mdRefSpaces = new RegExp(mdWhite + '+', 'g');
const mdRefKey = label => label.replace(mdTrim, '').replace(mdRefSpaces, ' ').toLowerCase().toUpperCase();
const mdSpaceEnd = (source, i, max = source.length) => {
  while (i < max && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n')) i++;
  return i;
};
function mdDestination(source, from, max = source.length) {
  if (source[from] === '<') {
    const wrapped = /^<(?:\\[\s\S]|[^\\<>\n])*>/.exec(source.slice(from, max));
    return wrapped ? from + wrapped[0].length : -1;
  }
  let depth = 0, i = from;
  for (; i < max && !/[\x00-\x20\x7F]/.test(source[i]); i++) {
    if (source[i] === '\\' && i + 1 < max) {
      if (source[i + 1] === ' ') break;
      i++;
    } else if (source[i] === '(') {
      if (++depth > 32) return -1;
    } else if (source[i] === ')') {
      if (!depth) break;
      depth--;
    }
  }
  return i > from && depth === 0 ? i : -1;
}
function mdTitle(source, from, max = source.length) {
  const quote = source[from];
  if (quote !== '"' && quote !== "'" && quote !== '(') return undefined;
  const close = quote === '(' ? ')' : quote;
  for (let i = from + 1; i < max; i++) {
    if (source[i] === '\\') i++;
    else if (source[i] === close) return i + 1;
    else if (quote === '(' && source[i] === '(') return undefined;
  }
  return -1;
}
// HTML5 命名实体取自标准表，名称区分大小写。普通目标一次解码，断言和指纹继续使用源码。
const mdEntities = {
  AElig: "\u00c6", AMP: "&", Aacute: "\u00c1", Abreve: "\u0102", Acirc: "\u00c2", Acy: "\u0410",
  Afr: "\ud835\udd04", Agrave: "\u00c0", Alpha: "\u0391", Amacr: "\u0100", And: "\u2a53", Aogon: "\u0104",
  Aopf: "\ud835\udd38", ApplyFunction: "\u2061", Aring: "\u00c5", Ascr: "\ud835\udc9c", Assign: "\u2254",
  Atilde: "\u00c3", Auml: "\u00c4", Backslash: "\u2216", Barv: "\u2ae7", Barwed: "\u2306", Bcy: "\u0411",
  Because: "\u2235", Bernoullis: "\u212c", Beta: "\u0392", Bfr: "\ud835\udd05", Bopf: "\ud835\udd39",
  Breve: "\u02d8", Bscr: "\u212c", Bumpeq: "\u224e", CHcy: "\u0427", COPY: "\u00a9", Cacute: "\u0106",
  Cap: "\u22d2", CapitalDifferentialD: "\u2145", Cayleys: "\u212d", Ccaron: "\u010c", Ccedil: "\u00c7",
  Ccirc: "\u0108", Cconint: "\u2230", Cdot: "\u010a", Cedilla: "\u00b8", CenterDot: "\u00b7", Cfr: "\u212d",
  Chi: "\u03a7", CircleDot: "\u2299", CircleMinus: "\u2296", CirclePlus: "\u2295", CircleTimes: "\u2297",
  ClockwiseContourIntegral: "\u2232", CloseCurlyDoubleQuote: "\u201d", CloseCurlyQuote: "\u2019",
  Colon: "\u2237", Colone: "\u2a74", Congruent: "\u2261", Conint: "\u222f", ContourIntegral: "\u222e",
  Copf: "\u2102", Coproduct: "\u2210", CounterClockwiseContourIntegral: "\u2233", Cross: "\u2a2f",
  Cscr: "\ud835\udc9e", Cup: "\u22d3", CupCap: "\u224d", DD: "\u2145", DDotrahd: "\u2911", DJcy: "\u0402",
  DScy: "\u0405", DZcy: "\u040f", Dagger: "\u2021", Darr: "\u21a1", Dashv: "\u2ae4", Dcaron: "\u010e",
  Dcy: "\u0414", Del: "\u2207", Delta: "\u0394", Dfr: "\ud835\udd07", DiacriticalAcute: "\u00b4",
  DiacriticalDot: "\u02d9", DiacriticalDoubleAcute: "\u02dd", DiacriticalGrave: "`", DiacriticalTilde: "\u02dc",
  Diamond: "\u22c4", DifferentialD: "\u2146", Dopf: "\ud835\udd3b", Dot: "\u00a8", DotDot: "\u20dc",
  DotEqual: "\u2250", DoubleContourIntegral: "\u222f", DoubleDot: "\u00a8", DoubleDownArrow: "\u21d3",
  DoubleLeftArrow: "\u21d0", DoubleLeftRightArrow: "\u21d4", DoubleLeftTee: "\u2ae4",
  DoubleLongLeftArrow: "\u27f8", DoubleLongLeftRightArrow: "\u27fa", DoubleLongRightArrow: "\u27f9",
  DoubleRightArrow: "\u21d2", DoubleRightTee: "\u22a8", DoubleUpArrow: "\u21d1", DoubleUpDownArrow: "\u21d5",
  DoubleVerticalBar: "\u2225", DownArrow: "\u2193", DownArrowBar: "\u2913", DownArrowUpArrow: "\u21f5",
  DownBreve: "\u0311", DownLeftRightVector: "\u2950", DownLeftTeeVector: "\u295e", DownLeftVector: "\u21bd",
  DownLeftVectorBar: "\u2956", DownRightTeeVector: "\u295f", DownRightVector: "\u21c1",
  DownRightVectorBar: "\u2957", DownTee: "\u22a4", DownTeeArrow: "\u21a7", Downarrow: "\u21d3",
  Dscr: "\ud835\udc9f", Dstrok: "\u0110", ENG: "\u014a", ETH: "\u00d0", Eacute: "\u00c9", Ecaron: "\u011a",
  Ecirc: "\u00ca", Ecy: "\u042d", Edot: "\u0116", Efr: "\ud835\udd08", Egrave: "\u00c8", Element: "\u2208",
  Emacr: "\u0112", EmptySmallSquare: "\u25fb", EmptyVerySmallSquare: "\u25ab", Eogon: "\u0118",
  Eopf: "\ud835\udd3c", Epsilon: "\u0395", Equal: "\u2a75", EqualTilde: "\u2242", Equilibrium: "\u21cc",
  Escr: "\u2130", Esim: "\u2a73", Eta: "\u0397", Euml: "\u00cb", Exists: "\u2203", ExponentialE: "\u2147",
  Fcy: "\u0424", Ffr: "\ud835\udd09", FilledSmallSquare: "\u25fc", FilledVerySmallSquare: "\u25aa",
  Fopf: "\ud835\udd3d", ForAll: "\u2200", Fouriertrf: "\u2131", Fscr: "\u2131", GJcy: "\u0403", GT: ">",
  Gamma: "\u0393", Gammad: "\u03dc", Gbreve: "\u011e", Gcedil: "\u0122", Gcirc: "\u011c", Gcy: "\u0413",
  Gdot: "\u0120", Gfr: "\ud835\udd0a", Gg: "\u22d9", Gopf: "\ud835\udd3e", GreaterEqual: "\u2265",
  GreaterEqualLess: "\u22db", GreaterFullEqual: "\u2267", GreaterGreater: "\u2aa2", GreaterLess: "\u2277",
  GreaterSlantEqual: "\u2a7e", GreaterTilde: "\u2273", Gscr: "\ud835\udca2", Gt: "\u226b", HARDcy: "\u042a",
  Hacek: "\u02c7", Hat: "^", Hcirc: "\u0124", Hfr: "\u210c", HilbertSpace: "\u210b", Hopf: "\u210d",
  HorizontalLine: "\u2500", Hscr: "\u210b", Hstrok: "\u0126", HumpDownHump: "\u224e", HumpEqual: "\u224f",
  IEcy: "\u0415", IJlig: "\u0132", IOcy: "\u0401", Iacute: "\u00cd", Icirc: "\u00ce", Icy: "\u0418",
  Idot: "\u0130", Ifr: "\u2111", Igrave: "\u00cc", Im: "\u2111", Imacr: "\u012a", ImaginaryI: "\u2148",
  Implies: "\u21d2", Int: "\u222c", Integral: "\u222b", Intersection: "\u22c2", InvisibleComma: "\u2063",
  InvisibleTimes: "\u2062", Iogon: "\u012e", Iopf: "\ud835\udd40", Iota: "\u0399", Iscr: "\u2110",
  Itilde: "\u0128", Iukcy: "\u0406", Iuml: "\u00cf", Jcirc: "\u0134", Jcy: "\u0419", Jfr: "\ud835\udd0d",
  Jopf: "\ud835\udd41", Jscr: "\ud835\udca5", Jsercy: "\u0408", Jukcy: "\u0404", KHcy: "\u0425", KJcy: "\u040c",
  Kappa: "\u039a", Kcedil: "\u0136", Kcy: "\u041a", Kfr: "\ud835\udd0e", Kopf: "\ud835\udd42",
  Kscr: "\ud835\udca6", LJcy: "\u0409", LT: "<", Lacute: "\u0139", Lambda: "\u039b", Lang: "\u27ea",
  Laplacetrf: "\u2112", Larr: "\u219e", Lcaron: "\u013d", Lcedil: "\u013b", Lcy: "\u041b",
  LeftAngleBracket: "\u27e8", LeftArrow: "\u2190", LeftArrowBar: "\u21e4", LeftArrowRightArrow: "\u21c6",
  LeftCeiling: "\u2308", LeftDoubleBracket: "\u27e6", LeftDownTeeVector: "\u2961", LeftDownVector: "\u21c3",
  LeftDownVectorBar: "\u2959", LeftFloor: "\u230a", LeftRightArrow: "\u2194", LeftRightVector: "\u294e",
  LeftTee: "\u22a3", LeftTeeArrow: "\u21a4", LeftTeeVector: "\u295a", LeftTriangle: "\u22b2",
  LeftTriangleBar: "\u29cf", LeftTriangleEqual: "\u22b4", LeftUpDownVector: "\u2951", LeftUpTeeVector: "\u2960",
  LeftUpVector: "\u21bf", LeftUpVectorBar: "\u2958", LeftVector: "\u21bc", LeftVectorBar: "\u2952",
  Leftarrow: "\u21d0", Leftrightarrow: "\u21d4", LessEqualGreater: "\u22da", LessFullEqual: "\u2266",
  LessGreater: "\u2276", LessLess: "\u2aa1", LessSlantEqual: "\u2a7d", LessTilde: "\u2272", Lfr: "\ud835\udd0f",
  Ll: "\u22d8", Lleftarrow: "\u21da", Lmidot: "\u013f", LongLeftArrow: "\u27f5", LongLeftRightArrow: "\u27f7",
  LongRightArrow: "\u27f6", Longleftarrow: "\u27f8", Longleftrightarrow: "\u27fa", Longrightarrow: "\u27f9",
  Lopf: "\ud835\udd43", LowerLeftArrow: "\u2199", LowerRightArrow: "\u2198", Lscr: "\u2112", Lsh: "\u21b0",
  Lstrok: "\u0141", Lt: "\u226a", Map: "\u2905", Mcy: "\u041c", MediumSpace: "\u205f", Mellintrf: "\u2133",
  Mfr: "\ud835\udd10", MinusPlus: "\u2213", Mopf: "\ud835\udd44", Mscr: "\u2133", Mu: "\u039c", NJcy: "\u040a",
  Nacute: "\u0143", Ncaron: "\u0147", Ncedil: "\u0145", Ncy: "\u041d", NegativeMediumSpace: "\u200b",
  NegativeThickSpace: "\u200b", NegativeThinSpace: "\u200b", NegativeVeryThinSpace: "\u200b",
  NestedGreaterGreater: "\u226b", NestedLessLess: "\u226a", NewLine: "\n", Nfr: "\ud835\udd11",
  NoBreak: "\u2060", NonBreakingSpace: "\u00a0", Nopf: "\u2115", Not: "\u2aec", NotCongruent: "\u2262",
  NotCupCap: "\u226d", NotDoubleVerticalBar: "\u2226", NotElement: "\u2209", NotEqual: "\u2260",
  NotEqualTilde: "\u2242\u0338", NotExists: "\u2204", NotGreater: "\u226f", NotGreaterEqual: "\u2271",
  NotGreaterFullEqual: "\u2267\u0338", NotGreaterGreater: "\u226b\u0338", NotGreaterLess: "\u2279",
  NotGreaterSlantEqual: "\u2a7e\u0338", NotGreaterTilde: "\u2275", NotHumpDownHump: "\u224e\u0338",
  NotHumpEqual: "\u224f\u0338", NotLeftTriangle: "\u22ea", NotLeftTriangleBar: "\u29cf\u0338",
  NotLeftTriangleEqual: "\u22ec", NotLess: "\u226e", NotLessEqual: "\u2270", NotLessGreater: "\u2278",
  NotLessLess: "\u226a\u0338", NotLessSlantEqual: "\u2a7d\u0338", NotLessTilde: "\u2274",
  NotNestedGreaterGreater: "\u2aa2\u0338", NotNestedLessLess: "\u2aa1\u0338", NotPrecedes: "\u2280",
  NotPrecedesEqual: "\u2aaf\u0338", NotPrecedesSlantEqual: "\u22e0", NotReverseElement: "\u220c",
  NotRightTriangle: "\u22eb", NotRightTriangleBar: "\u29d0\u0338", NotRightTriangleEqual: "\u22ed",
  NotSquareSubset: "\u228f\u0338", NotSquareSubsetEqual: "\u22e2", NotSquareSuperset: "\u2290\u0338",
  NotSquareSupersetEqual: "\u22e3", NotSubset: "\u2282\u20d2", NotSubsetEqual: "\u2288", NotSucceeds: "\u2281",
  NotSucceedsEqual: "\u2ab0\u0338", NotSucceedsSlantEqual: "\u22e1", NotSucceedsTilde: "\u227f\u0338",
  NotSuperset: "\u2283\u20d2", NotSupersetEqual: "\u2289", NotTilde: "\u2241", NotTildeEqual: "\u2244",
  NotTildeFullEqual: "\u2247", NotTildeTilde: "\u2249", NotVerticalBar: "\u2224", Nscr: "\ud835\udca9",
  Ntilde: "\u00d1", Nu: "\u039d", OElig: "\u0152", Oacute: "\u00d3", Ocirc: "\u00d4", Ocy: "\u041e",
  Odblac: "\u0150", Ofr: "\ud835\udd12", Ograve: "\u00d2", Omacr: "\u014c", Omega: "\u03a9", Omicron: "\u039f",
  Oopf: "\ud835\udd46", OpenCurlyDoubleQuote: "\u201c", OpenCurlyQuote: "\u2018", Or: "\u2a54",
  Oscr: "\ud835\udcaa", Oslash: "\u00d8", Otilde: "\u00d5", Otimes: "\u2a37", Ouml: "\u00d6", OverBar: "\u203e",
  OverBrace: "\u23de", OverBracket: "\u23b4", OverParenthesis: "\u23dc", PartialD: "\u2202", Pcy: "\u041f",
  Pfr: "\ud835\udd13", Phi: "\u03a6", Pi: "\u03a0", PlusMinus: "\u00b1", Poincareplane: "\u210c",
  Popf: "\u2119", Pr: "\u2abb", Precedes: "\u227a", PrecedesEqual: "\u2aaf", PrecedesSlantEqual: "\u227c",
  PrecedesTilde: "\u227e", Prime: "\u2033", Product: "\u220f", Proportion: "\u2237", Proportional: "\u221d",
  Pscr: "\ud835\udcab", Psi: "\u03a8", QUOT: "\"", Qfr: "\ud835\udd14", Qopf: "\u211a", Qscr: "\ud835\udcac",
  RBarr: "\u2910", REG: "\u00ae", Racute: "\u0154", Rang: "\u27eb", Rarr: "\u21a0", Rarrtl: "\u2916",
  Rcaron: "\u0158", Rcedil: "\u0156", Rcy: "\u0420", Re: "\u211c", ReverseElement: "\u220b",
  ReverseEquilibrium: "\u21cb", ReverseUpEquilibrium: "\u296f", Rfr: "\u211c", Rho: "\u03a1",
  RightAngleBracket: "\u27e9", RightArrow: "\u2192", RightArrowBar: "\u21e5", RightArrowLeftArrow: "\u21c4",
  RightCeiling: "\u2309", RightDoubleBracket: "\u27e7", RightDownTeeVector: "\u295d", RightDownVector: "\u21c2",
  RightDownVectorBar: "\u2955", RightFloor: "\u230b", RightTee: "\u22a2", RightTeeArrow: "\u21a6",
  RightTeeVector: "\u295b", RightTriangle: "\u22b3", RightTriangleBar: "\u29d0", RightTriangleEqual: "\u22b5",
  RightUpDownVector: "\u294f", RightUpTeeVector: "\u295c", RightUpVector: "\u21be", RightUpVectorBar: "\u2954",
  RightVector: "\u21c0", RightVectorBar: "\u2953", Rightarrow: "\u21d2", Ropf: "\u211d", RoundImplies: "\u2970",
  Rrightarrow: "\u21db", Rscr: "\u211b", Rsh: "\u21b1", RuleDelayed: "\u29f4", SHCHcy: "\u0429", SHcy: "\u0428",
  SOFTcy: "\u042c", Sacute: "\u015a", Sc: "\u2abc", Scaron: "\u0160", Scedil: "\u015e", Scirc: "\u015c",
  Scy: "\u0421", Sfr: "\ud835\udd16", ShortDownArrow: "\u2193", ShortLeftArrow: "\u2190",
  ShortRightArrow: "\u2192", ShortUpArrow: "\u2191", Sigma: "\u03a3", SmallCircle: "\u2218",
  Sopf: "\ud835\udd4a", Sqrt: "\u221a", Square: "\u25a1", SquareIntersection: "\u2293", SquareSubset: "\u228f",
  SquareSubsetEqual: "\u2291", SquareSuperset: "\u2290", SquareSupersetEqual: "\u2292", SquareUnion: "\u2294",
  Sscr: "\ud835\udcae", Star: "\u22c6", Sub: "\u22d0", Subset: "\u22d0", SubsetEqual: "\u2286",
  Succeeds: "\u227b", SucceedsEqual: "\u2ab0", SucceedsSlantEqual: "\u227d", SucceedsTilde: "\u227f",
  SuchThat: "\u220b", Sum: "\u2211", Sup: "\u22d1", Superset: "\u2283", SupersetEqual: "\u2287",
  Supset: "\u22d1", THORN: "\u00de", TRADE: "\u2122", TSHcy: "\u040b", TScy: "\u0426", Tab: "\t", Tau: "\u03a4",
  Tcaron: "\u0164", Tcedil: "\u0162", Tcy: "\u0422", Tfr: "\ud835\udd17", Therefore: "\u2234", Theta: "\u0398",
  ThickSpace: "\u205f\u200a", ThinSpace: "\u2009", Tilde: "\u223c", TildeEqual: "\u2243",
  TildeFullEqual: "\u2245", TildeTilde: "\u2248", Topf: "\ud835\udd4b", TripleDot: "\u20db",
  Tscr: "\ud835\udcaf", Tstrok: "\u0166", Uacute: "\u00da", Uarr: "\u219f", Uarrocir: "\u2949", Ubrcy: "\u040e",
  Ubreve: "\u016c", Ucirc: "\u00db", Ucy: "\u0423", Udblac: "\u0170", Ufr: "\ud835\udd18", Ugrave: "\u00d9",
  Umacr: "\u016a", UnderBar: "_", UnderBrace: "\u23df", UnderBracket: "\u23b5", UnderParenthesis: "\u23dd",
  Union: "\u22c3", UnionPlus: "\u228e", Uogon: "\u0172", Uopf: "\ud835\udd4c", UpArrow: "\u2191",
  UpArrowBar: "\u2912", UpArrowDownArrow: "\u21c5", UpDownArrow: "\u2195", UpEquilibrium: "\u296e",
  UpTee: "\u22a5", UpTeeArrow: "\u21a5", Uparrow: "\u21d1", Updownarrow: "\u21d5", UpperLeftArrow: "\u2196",
  UpperRightArrow: "\u2197", Upsi: "\u03d2", Upsilon: "\u03a5", Uring: "\u016e", Uscr: "\ud835\udcb0",
  Utilde: "\u0168", Uuml: "\u00dc", VDash: "\u22ab", Vbar: "\u2aeb", Vcy: "\u0412", Vdash: "\u22a9",
  Vdashl: "\u2ae6", Vee: "\u22c1", Verbar: "\u2016", Vert: "\u2016", VerticalBar: "\u2223", VerticalLine: "|",
  VerticalSeparator: "\u2758", VerticalTilde: "\u2240", VeryThinSpace: "\u200a", Vfr: "\ud835\udd19",
  Vopf: "\ud835\udd4d", Vscr: "\ud835\udcb1", Vvdash: "\u22aa", Wcirc: "\u0174", Wedge: "\u22c0",
  Wfr: "\ud835\udd1a", Wopf: "\ud835\udd4e", Wscr: "\ud835\udcb2", Xfr: "\ud835\udd1b", Xi: "\u039e",
  Xopf: "\ud835\udd4f", Xscr: "\ud835\udcb3", YAcy: "\u042f", YIcy: "\u0407", YUcy: "\u042e", Yacute: "\u00dd",
  Ycirc: "\u0176", Ycy: "\u042b", Yfr: "\ud835\udd1c", Yopf: "\ud835\udd50", Yscr: "\ud835\udcb4",
  Yuml: "\u0178", ZHcy: "\u0416", Zacute: "\u0179", Zcaron: "\u017d", Zcy: "\u0417", Zdot: "\u017b",
  ZeroWidthSpace: "\u200b", Zeta: "\u0396", Zfr: "\u2128", Zopf: "\u2124", Zscr: "\ud835\udcb5",
  aacute: "\u00e1", abreve: "\u0103", ac: "\u223e", acE: "\u223e\u0333", acd: "\u223f", acirc: "\u00e2",
  acute: "\u00b4", acy: "\u0430", aelig: "\u00e6", af: "\u2061", afr: "\ud835\udd1e", agrave: "\u00e0",
  alefsym: "\u2135", aleph: "\u2135", alpha: "\u03b1", amacr: "\u0101", amalg: "\u2a3f", amp: "&",
  and: "\u2227", andand: "\u2a55", andd: "\u2a5c", andslope: "\u2a58", andv: "\u2a5a", ang: "\u2220",
  ange: "\u29a4", angle: "\u2220", angmsd: "\u2221", angmsdaa: "\u29a8", angmsdab: "\u29a9", angmsdac: "\u29aa",
  angmsdad: "\u29ab", angmsdae: "\u29ac", angmsdaf: "\u29ad", angmsdag: "\u29ae", angmsdah: "\u29af",
  angrt: "\u221f", angrtvb: "\u22be", angrtvbd: "\u299d", angsph: "\u2222", angst: "\u00c5", angzarr: "\u237c",
  aogon: "\u0105", aopf: "\ud835\udd52", ap: "\u2248", apE: "\u2a70", apacir: "\u2a6f", ape: "\u224a",
  apid: "\u224b", apos: "'", approx: "\u2248", approxeq: "\u224a", aring: "\u00e5", ascr: "\ud835\udcb6",
  ast: "*", asymp: "\u2248", asympeq: "\u224d", atilde: "\u00e3", auml: "\u00e4", awconint: "\u2233",
  awint: "\u2a11", bNot: "\u2aed", backcong: "\u224c", backepsilon: "\u03f6", backprime: "\u2035",
  backsim: "\u223d", backsimeq: "\u22cd", barvee: "\u22bd", barwed: "\u2305", barwedge: "\u2305",
  bbrk: "\u23b5", bbrktbrk: "\u23b6", bcong: "\u224c", bcy: "\u0431", bdquo: "\u201e", becaus: "\u2235",
  because: "\u2235", bemptyv: "\u29b0", bepsi: "\u03f6", bernou: "\u212c", beta: "\u03b2", beth: "\u2136",
  between: "\u226c", bfr: "\ud835\udd1f", bigcap: "\u22c2", bigcirc: "\u25ef", bigcup: "\u22c3",
  bigodot: "\u2a00", bigoplus: "\u2a01", bigotimes: "\u2a02", bigsqcup: "\u2a06", bigstar: "\u2605",
  bigtriangledown: "\u25bd", bigtriangleup: "\u25b3", biguplus: "\u2a04", bigvee: "\u22c1", bigwedge: "\u22c0",
  bkarow: "\u290d", blacklozenge: "\u29eb", blacksquare: "\u25aa", blacktriangle: "\u25b4",
  blacktriangledown: "\u25be", blacktriangleleft: "\u25c2", blacktriangleright: "\u25b8", blank: "\u2423",
  blk12: "\u2592", blk14: "\u2591", blk34: "\u2593", block: "\u2588", bne: "=\u20e5", bnequiv: "\u2261\u20e5",
  bnot: "\u2310", bopf: "\ud835\udd53", bot: "\u22a5", bottom: "\u22a5", bowtie: "\u22c8", boxDL: "\u2557",
  boxDR: "\u2554", boxDl: "\u2556", boxDr: "\u2553", boxH: "\u2550", boxHD: "\u2566", boxHU: "\u2569",
  boxHd: "\u2564", boxHu: "\u2567", boxUL: "\u255d", boxUR: "\u255a", boxUl: "\u255c", boxUr: "\u2559",
  boxV: "\u2551", boxVH: "\u256c", boxVL: "\u2563", boxVR: "\u2560", boxVh: "\u256b", boxVl: "\u2562",
  boxVr: "\u255f", boxbox: "\u29c9", boxdL: "\u2555", boxdR: "\u2552", boxdl: "\u2510", boxdr: "\u250c",
  boxh: "\u2500", boxhD: "\u2565", boxhU: "\u2568", boxhd: "\u252c", boxhu: "\u2534", boxminus: "\u229f",
  boxplus: "\u229e", boxtimes: "\u22a0", boxuL: "\u255b", boxuR: "\u2558", boxul: "\u2518", boxur: "\u2514",
  boxv: "\u2502", boxvH: "\u256a", boxvL: "\u2561", boxvR: "\u255e", boxvh: "\u253c", boxvl: "\u2524",
  boxvr: "\u251c", bprime: "\u2035", breve: "\u02d8", brvbar: "\u00a6", bscr: "\ud835\udcb7", bsemi: "\u204f",
  bsim: "\u223d", bsime: "\u22cd", bsol: "\\", bsolb: "\u29c5", bsolhsub: "\u27c8", bull: "\u2022",
  bullet: "\u2022", bump: "\u224e", bumpE: "\u2aae", bumpe: "\u224f", bumpeq: "\u224f", cacute: "\u0107",
  cap: "\u2229", capand: "\u2a44", capbrcup: "\u2a49", capcap: "\u2a4b", capcup: "\u2a47", capdot: "\u2a40",
  caps: "\u2229\ufe00", caret: "\u2041", caron: "\u02c7", ccaps: "\u2a4d", ccaron: "\u010d", ccedil: "\u00e7",
  ccirc: "\u0109", ccups: "\u2a4c", ccupssm: "\u2a50", cdot: "\u010b", cedil: "\u00b8", cemptyv: "\u29b2",
  cent: "\u00a2", centerdot: "\u00b7", cfr: "\ud835\udd20", chcy: "\u0447", check: "\u2713",
  checkmark: "\u2713", chi: "\u03c7", cir: "\u25cb", cirE: "\u29c3", circ: "\u02c6", circeq: "\u2257",
  circlearrowleft: "\u21ba", circlearrowright: "\u21bb", circledR: "\u00ae", circledS: "\u24c8",
  circledast: "\u229b", circledcirc: "\u229a", circleddash: "\u229d", cire: "\u2257", cirfnint: "\u2a10",
  cirmid: "\u2aef", cirscir: "\u29c2", clubs: "\u2663", clubsuit: "\u2663", colon: ":", colone: "\u2254",
  coloneq: "\u2254", comma: ",", commat: "@", comp: "\u2201", compfn: "\u2218", complement: "\u2201",
  complexes: "\u2102", cong: "\u2245", congdot: "\u2a6d", conint: "\u222e", copf: "\ud835\udd54",
  coprod: "\u2210", copy: "\u00a9", copysr: "\u2117", crarr: "\u21b5", cross: "\u2717", cscr: "\ud835\udcb8",
  csub: "\u2acf", csube: "\u2ad1", csup: "\u2ad0", csupe: "\u2ad2", ctdot: "\u22ef", cudarrl: "\u2938",
  cudarrr: "\u2935", cuepr: "\u22de", cuesc: "\u22df", cularr: "\u21b6", cularrp: "\u293d", cup: "\u222a",
  cupbrcap: "\u2a48", cupcap: "\u2a46", cupcup: "\u2a4a", cupdot: "\u228d", cupor: "\u2a45",
  cups: "\u222a\ufe00", curarr: "\u21b7", curarrm: "\u293c", curlyeqprec: "\u22de", curlyeqsucc: "\u22df",
  curlyvee: "\u22ce", curlywedge: "\u22cf", curren: "\u00a4", curvearrowleft: "\u21b6",
  curvearrowright: "\u21b7", cuvee: "\u22ce", cuwed: "\u22cf", cwconint: "\u2232", cwint: "\u2231",
  cylcty: "\u232d", dArr: "\u21d3", dHar: "\u2965", dagger: "\u2020", daleth: "\u2138", darr: "\u2193",
  dash: "\u2010", dashv: "\u22a3", dbkarow: "\u290f", dblac: "\u02dd", dcaron: "\u010f", dcy: "\u0434",
  dd: "\u2146", ddagger: "\u2021", ddarr: "\u21ca", ddotseq: "\u2a77", deg: "\u00b0", delta: "\u03b4",
  demptyv: "\u29b1", dfisht: "\u297f", dfr: "\ud835\udd21", dharl: "\u21c3", dharr: "\u21c2", diam: "\u22c4",
  diamond: "\u22c4", diamondsuit: "\u2666", diams: "\u2666", die: "\u00a8", digamma: "\u03dd", disin: "\u22f2",
  div: "\u00f7", divide: "\u00f7", divideontimes: "\u22c7", divonx: "\u22c7", djcy: "\u0452", dlcorn: "\u231e",
  dlcrop: "\u230d", dollar: "$", dopf: "\ud835\udd55", dot: "\u02d9", doteq: "\u2250", doteqdot: "\u2251",
  dotminus: "\u2238", dotplus: "\u2214", dotsquare: "\u22a1", doublebarwedge: "\u2306", downarrow: "\u2193",
  downdownarrows: "\u21ca", downharpoonleft: "\u21c3", downharpoonright: "\u21c2", drbkarow: "\u2910",
  drcorn: "\u231f", drcrop: "\u230c", dscr: "\ud835\udcb9", dscy: "\u0455", dsol: "\u29f6", dstrok: "\u0111",
  dtdot: "\u22f1", dtri: "\u25bf", dtrif: "\u25be", duarr: "\u21f5", duhar: "\u296f", dwangle: "\u29a6",
  dzcy: "\u045f", dzigrarr: "\u27ff", eDDot: "\u2a77", eDot: "\u2251", eacute: "\u00e9", easter: "\u2a6e",
  ecaron: "\u011b", ecir: "\u2256", ecirc: "\u00ea", ecolon: "\u2255", ecy: "\u044d", edot: "\u0117",
  ee: "\u2147", efDot: "\u2252", efr: "\ud835\udd22", eg: "\u2a9a", egrave: "\u00e8", egs: "\u2a96",
  egsdot: "\u2a98", el: "\u2a99", elinters: "\u23e7", ell: "\u2113", els: "\u2a95", elsdot: "\u2a97",
  emacr: "\u0113", empty: "\u2205", emptyset: "\u2205", emptyv: "\u2205", emsp: "\u2003", emsp13: "\u2004",
  emsp14: "\u2005", eng: "\u014b", ensp: "\u2002", eogon: "\u0119", eopf: "\ud835\udd56", epar: "\u22d5",
  eparsl: "\u29e3", eplus: "\u2a71", epsi: "\u03b5", epsilon: "\u03b5", epsiv: "\u03f5", eqcirc: "\u2256",
  eqcolon: "\u2255", eqsim: "\u2242", eqslantgtr: "\u2a96", eqslantless: "\u2a95", equals: "=",
  equest: "\u225f", equiv: "\u2261", equivDD: "\u2a78", eqvparsl: "\u29e5", erDot: "\u2253", erarr: "\u2971",
  escr: "\u212f", esdot: "\u2250", esim: "\u2242", eta: "\u03b7", eth: "\u00f0", euml: "\u00eb", euro: "\u20ac",
  excl: "!", exist: "\u2203", expectation: "\u2130", exponentiale: "\u2147", fallingdotseq: "\u2252",
  fcy: "\u0444", female: "\u2640", ffilig: "\ufb03", fflig: "\ufb00", ffllig: "\ufb04", ffr: "\ud835\udd23",
  filig: "\ufb01", fjlig: "fj", flat: "\u266d", fllig: "\ufb02", fltns: "\u25b1", fnof: "\u0192",
  fopf: "\ud835\udd57", forall: "\u2200", fork: "\u22d4", forkv: "\u2ad9", fpartint: "\u2a0d", frac12: "\u00bd",
  frac13: "\u2153", frac14: "\u00bc", frac15: "\u2155", frac16: "\u2159", frac18: "\u215b", frac23: "\u2154",
  frac25: "\u2156", frac34: "\u00be", frac35: "\u2157", frac38: "\u215c", frac45: "\u2158", frac56: "\u215a",
  frac58: "\u215d", frac78: "\u215e", frasl: "\u2044", frown: "\u2322", fscr: "\ud835\udcbb", gE: "\u2267",
  gEl: "\u2a8c", gacute: "\u01f5", gamma: "\u03b3", gammad: "\u03dd", gap: "\u2a86", gbreve: "\u011f",
  gcirc: "\u011d", gcy: "\u0433", gdot: "\u0121", ge: "\u2265", gel: "\u22db", geq: "\u2265", geqq: "\u2267",
  geqslant: "\u2a7e", ges: "\u2a7e", gescc: "\u2aa9", gesdot: "\u2a80", gesdoto: "\u2a82", gesdotol: "\u2a84",
  gesl: "\u22db\ufe00", gesles: "\u2a94", gfr: "\ud835\udd24", gg: "\u226b", ggg: "\u22d9", gimel: "\u2137",
  gjcy: "\u0453", gl: "\u2277", glE: "\u2a92", gla: "\u2aa5", glj: "\u2aa4", gnE: "\u2269", gnap: "\u2a8a",
  gnapprox: "\u2a8a", gne: "\u2a88", gneq: "\u2a88", gneqq: "\u2269", gnsim: "\u22e7", gopf: "\ud835\udd58",
  grave: "`", gscr: "\u210a", gsim: "\u2273", gsime: "\u2a8e", gsiml: "\u2a90", gt: ">", gtcc: "\u2aa7",
  gtcir: "\u2a7a", gtdot: "\u22d7", gtlPar: "\u2995", gtquest: "\u2a7c", gtrapprox: "\u2a86", gtrarr: "\u2978",
  gtrdot: "\u22d7", gtreqless: "\u22db", gtreqqless: "\u2a8c", gtrless: "\u2277", gtrsim: "\u2273",
  gvertneqq: "\u2269\ufe00", gvnE: "\u2269\ufe00", hArr: "\u21d4", hairsp: "\u200a", half: "\u00bd",
  hamilt: "\u210b", hardcy: "\u044a", harr: "\u2194", harrcir: "\u2948", harrw: "\u21ad", hbar: "\u210f",
  hcirc: "\u0125", hearts: "\u2665", heartsuit: "\u2665", hellip: "\u2026", hercon: "\u22b9",
  hfr: "\ud835\udd25", hksearow: "\u2925", hkswarow: "\u2926", hoarr: "\u21ff", homtht: "\u223b",
  hookleftarrow: "\u21a9", hookrightarrow: "\u21aa", hopf: "\ud835\udd59", horbar: "\u2015",
  hscr: "\ud835\udcbd", hslash: "\u210f", hstrok: "\u0127", hybull: "\u2043", hyphen: "\u2010",
  iacute: "\u00ed", ic: "\u2063", icirc: "\u00ee", icy: "\u0438", iecy: "\u0435", iexcl: "\u00a1",
  iff: "\u21d4", ifr: "\ud835\udd26", igrave: "\u00ec", ii: "\u2148", iiiint: "\u2a0c", iiint: "\u222d",
  iinfin: "\u29dc", iiota: "\u2129", ijlig: "\u0133", imacr: "\u012b", image: "\u2111", imagline: "\u2110",
  imagpart: "\u2111", imath: "\u0131", imof: "\u22b7", imped: "\u01b5", in: "\u2208", incare: "\u2105",
  infin: "\u221e", infintie: "\u29dd", inodot: "\u0131", int: "\u222b", intcal: "\u22ba", integers: "\u2124",
  intercal: "\u22ba", intlarhk: "\u2a17", intprod: "\u2a3c", iocy: "\u0451", iogon: "\u012f",
  iopf: "\ud835\udd5a", iota: "\u03b9", iprod: "\u2a3c", iquest: "\u00bf", iscr: "\ud835\udcbe", isin: "\u2208",
  isinE: "\u22f9", isindot: "\u22f5", isins: "\u22f4", isinsv: "\u22f3", isinv: "\u2208", it: "\u2062",
  itilde: "\u0129", iukcy: "\u0456", iuml: "\u00ef", jcirc: "\u0135", jcy: "\u0439", jfr: "\ud835\udd27",
  jmath: "\u0237", jopf: "\ud835\udd5b", jscr: "\ud835\udcbf", jsercy: "\u0458", jukcy: "\u0454",
  kappa: "\u03ba", kappav: "\u03f0", kcedil: "\u0137", kcy: "\u043a", kfr: "\ud835\udd28", kgreen: "\u0138",
  khcy: "\u0445", kjcy: "\u045c", kopf: "\ud835\udd5c", kscr: "\ud835\udcc0", lAarr: "\u21da", lArr: "\u21d0",
  lAtail: "\u291b", lBarr: "\u290e", lE: "\u2266", lEg: "\u2a8b", lHar: "\u2962", lacute: "\u013a",
  laemptyv: "\u29b4", lagran: "\u2112", lambda: "\u03bb", lang: "\u27e8", langd: "\u2991", langle: "\u27e8",
  lap: "\u2a85", laquo: "\u00ab", larr: "\u2190", larrb: "\u21e4", larrbfs: "\u291f", larrfs: "\u291d",
  larrhk: "\u21a9", larrlp: "\u21ab", larrpl: "\u2939", larrsim: "\u2973", larrtl: "\u21a2", lat: "\u2aab",
  latail: "\u2919", late: "\u2aad", lates: "\u2aad\ufe00", lbarr: "\u290c", lbbrk: "\u2772", lbrace: "{",
  lbrack: "[", lbrke: "\u298b", lbrksld: "\u298f", lbrkslu: "\u298d", lcaron: "\u013e", lcedil: "\u013c",
  lceil: "\u2308", lcub: "{", lcy: "\u043b", ldca: "\u2936", ldquo: "\u201c", ldquor: "\u201e",
  ldrdhar: "\u2967", ldrushar: "\u294b", ldsh: "\u21b2", le: "\u2264", leftarrow: "\u2190",
  leftarrowtail: "\u21a2", leftharpoondown: "\u21bd", leftharpoonup: "\u21bc", leftleftarrows: "\u21c7",
  leftrightarrow: "\u2194", leftrightarrows: "\u21c6", leftrightharpoons: "\u21cb",
  leftrightsquigarrow: "\u21ad", leftthreetimes: "\u22cb", leg: "\u22da", leq: "\u2264", leqq: "\u2266",
  leqslant: "\u2a7d", les: "\u2a7d", lescc: "\u2aa8", lesdot: "\u2a7f", lesdoto: "\u2a81", lesdotor: "\u2a83",
  lesg: "\u22da\ufe00", lesges: "\u2a93", lessapprox: "\u2a85", lessdot: "\u22d6", lesseqgtr: "\u22da",
  lesseqqgtr: "\u2a8b", lessgtr: "\u2276", lesssim: "\u2272", lfisht: "\u297c", lfloor: "\u230a",
  lfr: "\ud835\udd29", lg: "\u2276", lgE: "\u2a91", lhard: "\u21bd", lharu: "\u21bc", lharul: "\u296a",
  lhblk: "\u2584", ljcy: "\u0459", ll: "\u226a", llarr: "\u21c7", llcorner: "\u231e", llhard: "\u296b",
  lltri: "\u25fa", lmidot: "\u0140", lmoust: "\u23b0", lmoustache: "\u23b0", lnE: "\u2268", lnap: "\u2a89",
  lnapprox: "\u2a89", lne: "\u2a87", lneq: "\u2a87", lneqq: "\u2268", lnsim: "\u22e6", loang: "\u27ec",
  loarr: "\u21fd", lobrk: "\u27e6", longleftarrow: "\u27f5", longleftrightarrow: "\u27f7", longmapsto: "\u27fc",
  longrightarrow: "\u27f6", looparrowleft: "\u21ab", looparrowright: "\u21ac", lopar: "\u2985",
  lopf: "\ud835\udd5d", loplus: "\u2a2d", lotimes: "\u2a34", lowast: "\u2217", lowbar: "_", loz: "\u25ca",
  lozenge: "\u25ca", lozf: "\u29eb", lpar: "(", lparlt: "\u2993", lrarr: "\u21c6", lrcorner: "\u231f",
  lrhar: "\u21cb", lrhard: "\u296d", lrm: "\u200e", lrtri: "\u22bf", lsaquo: "\u2039", lscr: "\ud835\udcc1",
  lsh: "\u21b0", lsim: "\u2272", lsime: "\u2a8d", lsimg: "\u2a8f", lsqb: "[", lsquo: "\u2018", lsquor: "\u201a",
  lstrok: "\u0142", lt: "<", ltcc: "\u2aa6", ltcir: "\u2a79", ltdot: "\u22d6", lthree: "\u22cb",
  ltimes: "\u22c9", ltlarr: "\u2976", ltquest: "\u2a7b", ltrPar: "\u2996", ltri: "\u25c3", ltrie: "\u22b4",
  ltrif: "\u25c2", lurdshar: "\u294a", luruhar: "\u2966", lvertneqq: "\u2268\ufe00", lvnE: "\u2268\ufe00",
  mDDot: "\u223a", macr: "\u00af", male: "\u2642", malt: "\u2720", maltese: "\u2720", map: "\u21a6",
  mapsto: "\u21a6", mapstodown: "\u21a7", mapstoleft: "\u21a4", mapstoup: "\u21a5", marker: "\u25ae",
  mcomma: "\u2a29", mcy: "\u043c", mdash: "\u2014", measuredangle: "\u2221", mfr: "\ud835\udd2a", mho: "\u2127",
  micro: "\u00b5", mid: "\u2223", midast: "*", midcir: "\u2af0", middot: "\u00b7", minus: "\u2212",
  minusb: "\u229f", minusd: "\u2238", minusdu: "\u2a2a", mlcp: "\u2adb", mldr: "\u2026", mnplus: "\u2213",
  models: "\u22a7", mopf: "\ud835\udd5e", mp: "\u2213", mscr: "\ud835\udcc2", mstpos: "\u223e", mu: "\u03bc",
  multimap: "\u22b8", mumap: "\u22b8", nGg: "\u22d9\u0338", nGt: "\u226b\u20d2", nGtv: "\u226b\u0338",
  nLeftarrow: "\u21cd", nLeftrightarrow: "\u21ce", nLl: "\u22d8\u0338", nLt: "\u226a\u20d2",
  nLtv: "\u226a\u0338", nRightarrow: "\u21cf", nVDash: "\u22af", nVdash: "\u22ae", nabla: "\u2207",
  nacute: "\u0144", nang: "\u2220\u20d2", nap: "\u2249", napE: "\u2a70\u0338", napid: "\u224b\u0338",
  napos: "\u0149", napprox: "\u2249", natur: "\u266e", natural: "\u266e", naturals: "\u2115", nbsp: "\u00a0",
  nbump: "\u224e\u0338", nbumpe: "\u224f\u0338", ncap: "\u2a43", ncaron: "\u0148", ncedil: "\u0146",
  ncong: "\u2247", ncongdot: "\u2a6d\u0338", ncup: "\u2a42", ncy: "\u043d", ndash: "\u2013", ne: "\u2260",
  neArr: "\u21d7", nearhk: "\u2924", nearr: "\u2197", nearrow: "\u2197", nedot: "\u2250\u0338",
  nequiv: "\u2262", nesear: "\u2928", nesim: "\u2242\u0338", nexist: "\u2204", nexists: "\u2204",
  nfr: "\ud835\udd2b", ngE: "\u2267\u0338", nge: "\u2271", ngeq: "\u2271", ngeqq: "\u2267\u0338",
  ngeqslant: "\u2a7e\u0338", nges: "\u2a7e\u0338", ngsim: "\u2275", ngt: "\u226f", ngtr: "\u226f",
  nhArr: "\u21ce", nharr: "\u21ae", nhpar: "\u2af2", ni: "\u220b", nis: "\u22fc", nisd: "\u22fa", niv: "\u220b",
  njcy: "\u045a", nlArr: "\u21cd", nlE: "\u2266\u0338", nlarr: "\u219a", nldr: "\u2025", nle: "\u2270",
  nleftarrow: "\u219a", nleftrightarrow: "\u21ae", nleq: "\u2270", nleqq: "\u2266\u0338",
  nleqslant: "\u2a7d\u0338", nles: "\u2a7d\u0338", nless: "\u226e", nlsim: "\u2274", nlt: "\u226e",
  nltri: "\u22ea", nltrie: "\u22ec", nmid: "\u2224", nopf: "\ud835\udd5f", not: "\u00ac", notin: "\u2209",
  notinE: "\u22f9\u0338", notindot: "\u22f5\u0338", notinva: "\u2209", notinvb: "\u22f7", notinvc: "\u22f6",
  notni: "\u220c", notniva: "\u220c", notnivb: "\u22fe", notnivc: "\u22fd", npar: "\u2226", nparallel: "\u2226",
  nparsl: "\u2afd\u20e5", npart: "\u2202\u0338", npolint: "\u2a14", npr: "\u2280", nprcue: "\u22e0",
  npre: "\u2aaf\u0338", nprec: "\u2280", npreceq: "\u2aaf\u0338", nrArr: "\u21cf", nrarr: "\u219b",
  nrarrc: "\u2933\u0338", nrarrw: "\u219d\u0338", nrightarrow: "\u219b", nrtri: "\u22eb", nrtrie: "\u22ed",
  nsc: "\u2281", nsccue: "\u22e1", nsce: "\u2ab0\u0338", nscr: "\ud835\udcc3", nshortmid: "\u2224",
  nshortparallel: "\u2226", nsim: "\u2241", nsime: "\u2244", nsimeq: "\u2244", nsmid: "\u2224", nspar: "\u2226",
  nsqsube: "\u22e2", nsqsupe: "\u22e3", nsub: "\u2284", nsubE: "\u2ac5\u0338", nsube: "\u2288",
  nsubset: "\u2282\u20d2", nsubseteq: "\u2288", nsubseteqq: "\u2ac5\u0338", nsucc: "\u2281",
  nsucceq: "\u2ab0\u0338", nsup: "\u2285", nsupE: "\u2ac6\u0338", nsupe: "\u2289", nsupset: "\u2283\u20d2",
  nsupseteq: "\u2289", nsupseteqq: "\u2ac6\u0338", ntgl: "\u2279", ntilde: "\u00f1", ntlg: "\u2278",
  ntriangleleft: "\u22ea", ntrianglelefteq: "\u22ec", ntriangleright: "\u22eb", ntrianglerighteq: "\u22ed",
  nu: "\u03bd", num: "#", numero: "\u2116", numsp: "\u2007", nvDash: "\u22ad", nvHarr: "\u2904",
  nvap: "\u224d\u20d2", nvdash: "\u22ac", nvge: "\u2265\u20d2", nvgt: ">\u20d2", nvinfin: "\u29de",
  nvlArr: "\u2902", nvle: "\u2264\u20d2", nvlt: "<\u20d2", nvltrie: "\u22b4\u20d2", nvrArr: "\u2903",
  nvrtrie: "\u22b5\u20d2", nvsim: "\u223c\u20d2", nwArr: "\u21d6", nwarhk: "\u2923", nwarr: "\u2196",
  nwarrow: "\u2196", nwnear: "\u2927", oS: "\u24c8", oacute: "\u00f3", oast: "\u229b", ocir: "\u229a",
  ocirc: "\u00f4", ocy: "\u043e", odash: "\u229d", odblac: "\u0151", odiv: "\u2a38", odot: "\u2299",
  odsold: "\u29bc", oelig: "\u0153", ofcir: "\u29bf", ofr: "\ud835\udd2c", ogon: "\u02db", ograve: "\u00f2",
  ogt: "\u29c1", ohbar: "\u29b5", ohm: "\u03a9", oint: "\u222e", olarr: "\u21ba", olcir: "\u29be",
  olcross: "\u29bb", oline: "\u203e", olt: "\u29c0", omacr: "\u014d", omega: "\u03c9", omicron: "\u03bf",
  omid: "\u29b6", ominus: "\u2296", oopf: "\ud835\udd60", opar: "\u29b7", operp: "\u29b9", oplus: "\u2295",
  or: "\u2228", orarr: "\u21bb", ord: "\u2a5d", order: "\u2134", orderof: "\u2134", ordf: "\u00aa",
  ordm: "\u00ba", origof: "\u22b6", oror: "\u2a56", orslope: "\u2a57", orv: "\u2a5b", oscr: "\u2134",
  oslash: "\u00f8", osol: "\u2298", otilde: "\u00f5", otimes: "\u2297", otimesas: "\u2a36", ouml: "\u00f6",
  ovbar: "\u233d", par: "\u2225", para: "\u00b6", parallel: "\u2225", parsim: "\u2af3", parsl: "\u2afd",
  part: "\u2202", pcy: "\u043f", percnt: "%", period: ".", permil: "\u2030", perp: "\u22a5", pertenk: "\u2031",
  pfr: "\ud835\udd2d", phi: "\u03c6", phiv: "\u03d5", phmmat: "\u2133", phone: "\u260e", pi: "\u03c0",
  pitchfork: "\u22d4", piv: "\u03d6", planck: "\u210f", planckh: "\u210e", plankv: "\u210f", plus: "+",
  plusacir: "\u2a23", plusb: "\u229e", pluscir: "\u2a22", plusdo: "\u2214", plusdu: "\u2a25", pluse: "\u2a72",
  plusmn: "\u00b1", plussim: "\u2a26", plustwo: "\u2a27", pm: "\u00b1", pointint: "\u2a15",
  popf: "\ud835\udd61", pound: "\u00a3", pr: "\u227a", prE: "\u2ab3", prap: "\u2ab7", prcue: "\u227c",
  pre: "\u2aaf", prec: "\u227a", precapprox: "\u2ab7", preccurlyeq: "\u227c", preceq: "\u2aaf",
  precnapprox: "\u2ab9", precneqq: "\u2ab5", precnsim: "\u22e8", precsim: "\u227e", prime: "\u2032",
  primes: "\u2119", prnE: "\u2ab5", prnap: "\u2ab9", prnsim: "\u22e8", prod: "\u220f", profalar: "\u232e",
  profline: "\u2312", profsurf: "\u2313", prop: "\u221d", propto: "\u221d", prsim: "\u227e", prurel: "\u22b0",
  pscr: "\ud835\udcc5", psi: "\u03c8", puncsp: "\u2008", qfr: "\ud835\udd2e", qint: "\u2a0c",
  qopf: "\ud835\udd62", qprime: "\u2057", qscr: "\ud835\udcc6", quaternions: "\u210d", quatint: "\u2a16",
  quest: "?", questeq: "\u225f", quot: "\"", rAarr: "\u21db", rArr: "\u21d2", rAtail: "\u291c", rBarr: "\u290f",
  rHar: "\u2964", race: "\u223d\u0331", racute: "\u0155", radic: "\u221a", raemptyv: "\u29b3", rang: "\u27e9",
  rangd: "\u2992", range: "\u29a5", rangle: "\u27e9", raquo: "\u00bb", rarr: "\u2192", rarrap: "\u2975",
  rarrb: "\u21e5", rarrbfs: "\u2920", rarrc: "\u2933", rarrfs: "\u291e", rarrhk: "\u21aa", rarrlp: "\u21ac",
  rarrpl: "\u2945", rarrsim: "\u2974", rarrtl: "\u21a3", rarrw: "\u219d", ratail: "\u291a", ratio: "\u2236",
  rationals: "\u211a", rbarr: "\u290d", rbbrk: "\u2773", rbrace: "}", rbrack: "]", rbrke: "\u298c",
  rbrksld: "\u298e", rbrkslu: "\u2990", rcaron: "\u0159", rcedil: "\u0157", rceil: "\u2309", rcub: "}",
  rcy: "\u0440", rdca: "\u2937", rdldhar: "\u2969", rdquo: "\u201d", rdquor: "\u201d", rdsh: "\u21b3",
  real: "\u211c", realine: "\u211b", realpart: "\u211c", reals: "\u211d", rect: "\u25ad", reg: "\u00ae",
  rfisht: "\u297d", rfloor: "\u230b", rfr: "\ud835\udd2f", rhard: "\u21c1", rharu: "\u21c0", rharul: "\u296c",
  rho: "\u03c1", rhov: "\u03f1", rightarrow: "\u2192", rightarrowtail: "\u21a3", rightharpoondown: "\u21c1",
  rightharpoonup: "\u21c0", rightleftarrows: "\u21c4", rightleftharpoons: "\u21cc", rightrightarrows: "\u21c9",
  rightsquigarrow: "\u219d", rightthreetimes: "\u22cc", ring: "\u02da", risingdotseq: "\u2253", rlarr: "\u21c4",
  rlhar: "\u21cc", rlm: "\u200f", rmoust: "\u23b1", rmoustache: "\u23b1", rnmid: "\u2aee", roang: "\u27ed",
  roarr: "\u21fe", robrk: "\u27e7", ropar: "\u2986", ropf: "\ud835\udd63", roplus: "\u2a2e", rotimes: "\u2a35",
  rpar: ")", rpargt: "\u2994", rppolint: "\u2a12", rrarr: "\u21c9", rsaquo: "\u203a", rscr: "\ud835\udcc7",
  rsh: "\u21b1", rsqb: "]", rsquo: "\u2019", rsquor: "\u2019", rthree: "\u22cc", rtimes: "\u22ca",
  rtri: "\u25b9", rtrie: "\u22b5", rtrif: "\u25b8", rtriltri: "\u29ce", ruluhar: "\u2968", rx: "\u211e",
  sacute: "\u015b", sbquo: "\u201a", sc: "\u227b", scE: "\u2ab4", scap: "\u2ab8", scaron: "\u0161",
  sccue: "\u227d", sce: "\u2ab0", scedil: "\u015f", scirc: "\u015d", scnE: "\u2ab6", scnap: "\u2aba",
  scnsim: "\u22e9", scpolint: "\u2a13", scsim: "\u227f", scy: "\u0441", sdot: "\u22c5", sdotb: "\u22a1",
  sdote: "\u2a66", seArr: "\u21d8", searhk: "\u2925", searr: "\u2198", searrow: "\u2198", sect: "\u00a7",
  semi: ";", seswar: "\u2929", setminus: "\u2216", setmn: "\u2216", sext: "\u2736", sfr: "\ud835\udd30",
  sfrown: "\u2322", sharp: "\u266f", shchcy: "\u0449", shcy: "\u0448", shortmid: "\u2223",
  shortparallel: "\u2225", shy: "\u00ad", sigma: "\u03c3", sigmaf: "\u03c2", sigmav: "\u03c2", sim: "\u223c",
  simdot: "\u2a6a", sime: "\u2243", simeq: "\u2243", simg: "\u2a9e", simgE: "\u2aa0", siml: "\u2a9d",
  simlE: "\u2a9f", simne: "\u2246", simplus: "\u2a24", simrarr: "\u2972", slarr: "\u2190",
  smallsetminus: "\u2216", smashp: "\u2a33", smeparsl: "\u29e4", smid: "\u2223", smile: "\u2323", smt: "\u2aaa",
  smte: "\u2aac", smtes: "\u2aac\ufe00", softcy: "\u044c", sol: "/", solb: "\u29c4", solbar: "\u233f",
  sopf: "\ud835\udd64", spades: "\u2660", spadesuit: "\u2660", spar: "\u2225", sqcap: "\u2293",
  sqcaps: "\u2293\ufe00", sqcup: "\u2294", sqcups: "\u2294\ufe00", sqsub: "\u228f", sqsube: "\u2291",
  sqsubset: "\u228f", sqsubseteq: "\u2291", sqsup: "\u2290", sqsupe: "\u2292", sqsupset: "\u2290",
  sqsupseteq: "\u2292", squ: "\u25a1", square: "\u25a1", squarf: "\u25aa", squf: "\u25aa", srarr: "\u2192",
  sscr: "\ud835\udcc8", ssetmn: "\u2216", ssmile: "\u2323", sstarf: "\u22c6", star: "\u2606", starf: "\u2605",
  straightepsilon: "\u03f5", straightphi: "\u03d5", strns: "\u00af", sub: "\u2282", subE: "\u2ac5",
  subdot: "\u2abd", sube: "\u2286", subedot: "\u2ac3", submult: "\u2ac1", subnE: "\u2acb", subne: "\u228a",
  subplus: "\u2abf", subrarr: "\u2979", subset: "\u2282", subseteq: "\u2286", subseteqq: "\u2ac5",
  subsetneq: "\u228a", subsetneqq: "\u2acb", subsim: "\u2ac7", subsub: "\u2ad5", subsup: "\u2ad3",
  succ: "\u227b", succapprox: "\u2ab8", succcurlyeq: "\u227d", succeq: "\u2ab0", succnapprox: "\u2aba",
  succneqq: "\u2ab6", succnsim: "\u22e9", succsim: "\u227f", sum: "\u2211", sung: "\u266a", sup: "\u2283",
  sup1: "\u00b9", sup2: "\u00b2", sup3: "\u00b3", supE: "\u2ac6", supdot: "\u2abe", supdsub: "\u2ad8",
  supe: "\u2287", supedot: "\u2ac4", suphsol: "\u27c9", suphsub: "\u2ad7", suplarr: "\u297b", supmult: "\u2ac2",
  supnE: "\u2acc", supne: "\u228b", supplus: "\u2ac0", supset: "\u2283", supseteq: "\u2287",
  supseteqq: "\u2ac6", supsetneq: "\u228b", supsetneqq: "\u2acc", supsim: "\u2ac8", supsub: "\u2ad4",
  supsup: "\u2ad6", swArr: "\u21d9", swarhk: "\u2926", swarr: "\u2199", swarrow: "\u2199", swnwar: "\u292a",
  szlig: "\u00df", target: "\u2316", tau: "\u03c4", tbrk: "\u23b4", tcaron: "\u0165", tcedil: "\u0163",
  tcy: "\u0442", tdot: "\u20db", telrec: "\u2315", tfr: "\ud835\udd31", there4: "\u2234", therefore: "\u2234",
  theta: "\u03b8", thetasym: "\u03d1", thetav: "\u03d1", thickapprox: "\u2248", thicksim: "\u223c",
  thinsp: "\u2009", thkap: "\u2248", thksim: "\u223c", thorn: "\u00fe", tilde: "\u02dc", times: "\u00d7",
  timesb: "\u22a0", timesbar: "\u2a31", timesd: "\u2a30", tint: "\u222d", toea: "\u2928", top: "\u22a4",
  topbot: "\u2336", topcir: "\u2af1", topf: "\ud835\udd65", topfork: "\u2ada", tosa: "\u2929", tprime: "\u2034",
  trade: "\u2122", triangle: "\u25b5", triangledown: "\u25bf", triangleleft: "\u25c3", trianglelefteq: "\u22b4",
  triangleq: "\u225c", triangleright: "\u25b9", trianglerighteq: "\u22b5", tridot: "\u25ec", trie: "\u225c",
  triminus: "\u2a3a", triplus: "\u2a39", trisb: "\u29cd", tritime: "\u2a3b", trpezium: "\u23e2",
  tscr: "\ud835\udcc9", tscy: "\u0446", tshcy: "\u045b", tstrok: "\u0167", twixt: "\u226c",
  twoheadleftarrow: "\u219e", twoheadrightarrow: "\u21a0", uArr: "\u21d1", uHar: "\u2963", uacute: "\u00fa",
  uarr: "\u2191", ubrcy: "\u045e", ubreve: "\u016d", ucirc: "\u00fb", ucy: "\u0443", udarr: "\u21c5",
  udblac: "\u0171", udhar: "\u296e", ufisht: "\u297e", ufr: "\ud835\udd32", ugrave: "\u00f9", uharl: "\u21bf",
  uharr: "\u21be", uhblk: "\u2580", ulcorn: "\u231c", ulcorner: "\u231c", ulcrop: "\u230f", ultri: "\u25f8",
  umacr: "\u016b", uml: "\u00a8", uogon: "\u0173", uopf: "\ud835\udd66", uparrow: "\u2191",
  updownarrow: "\u2195", upharpoonleft: "\u21bf", upharpoonright: "\u21be", uplus: "\u228e", upsi: "\u03c5",
  upsih: "\u03d2", upsilon: "\u03c5", upuparrows: "\u21c8", urcorn: "\u231d", urcorner: "\u231d",
  urcrop: "\u230e", uring: "\u016f", urtri: "\u25f9", uscr: "\ud835\udcca", utdot: "\u22f0", utilde: "\u0169",
  utri: "\u25b5", utrif: "\u25b4", uuarr: "\u21c8", uuml: "\u00fc", uwangle: "\u29a7", vArr: "\u21d5",
  vBar: "\u2ae8", vBarv: "\u2ae9", vDash: "\u22a8", vangrt: "\u299c", varepsilon: "\u03f5", varkappa: "\u03f0",
  varnothing: "\u2205", varphi: "\u03d5", varpi: "\u03d6", varpropto: "\u221d", varr: "\u2195",
  varrho: "\u03f1", varsigma: "\u03c2", varsubsetneq: "\u228a\ufe00", varsubsetneqq: "\u2acb\ufe00",
  varsupsetneq: "\u228b\ufe00", varsupsetneqq: "\u2acc\ufe00", vartheta: "\u03d1", vartriangleleft: "\u22b2",
  vartriangleright: "\u22b3", vcy: "\u0432", vdash: "\u22a2", vee: "\u2228", veebar: "\u22bb", veeeq: "\u225a",
  vellip: "\u22ee", verbar: "|", vert: "|", vfr: "\ud835\udd33", vltri: "\u22b2", vnsub: "\u2282\u20d2",
  vnsup: "\u2283\u20d2", vopf: "\ud835\udd67", vprop: "\u221d", vrtri: "\u22b3", vscr: "\ud835\udccb",
  vsubnE: "\u2acb\ufe00", vsubne: "\u228a\ufe00", vsupnE: "\u2acc\ufe00", vsupne: "\u228b\ufe00",
  vzigzag: "\u299a", wcirc: "\u0175", wedbar: "\u2a5f", wedge: "\u2227", wedgeq: "\u2259", weierp: "\u2118",
  wfr: "\ud835\udd34", wopf: "\ud835\udd68", wp: "\u2118", wr: "\u2240", wreath: "\u2240", wscr: "\ud835\udccc",
  xcap: "\u22c2", xcirc: "\u25ef", xcup: "\u22c3", xdtri: "\u25bd", xfr: "\ud835\udd35", xhArr: "\u27fa",
  xharr: "\u27f7", xi: "\u03be", xlArr: "\u27f8", xlarr: "\u27f5", xmap: "\u27fc", xnis: "\u22fb",
  xodot: "\u2a00", xopf: "\ud835\udd69", xoplus: "\u2a01", xotime: "\u2a02", xrArr: "\u27f9", xrarr: "\u27f6",
  xscr: "\ud835\udccd", xsqcup: "\u2a06", xuplus: "\u2a04", xutri: "\u25b3", xvee: "\u22c1", xwedge: "\u22c0",
  yacute: "\u00fd", yacy: "\u044f", ycirc: "\u0177", ycy: "\u044b", yen: "\u00a5", yfr: "\ud835\udd36",
  yicy: "\u0457", yopf: "\ud835\udd6a", yscr: "\ud835\udcce", yucy: "\u044e", yuml: "\u00ff", zacute: "\u017a",
  zcaron: "\u017e", zcy: "\u0437", zdot: "\u017c", zeetrf: "\u2128", zeta: "\u03b6", zfr: "\ud835\udd37",
  zhcy: "\u0436", zigrarr: "\u21dd", zopf: "\ud835\udd6b", zscr: "\ud835\udccf", zwj: "\u200d", zwnj: "\u200c",
};
function mdUnescape(value) {
  return value.replace(/\\([!-/:-@[-\x60{-~])|&([a-z#][a-z0-9]{1,31});/gi, (original, punct, name) => {
    if (punct) return punct;
    if (Object.hasOwn(mdEntities, name)) return mdEntities[name];
    let code;
    if (/^#[0-9]{1,8}$/.test(name)) code = Number(name.slice(1));
    else if (/^#x[0-9a-f]{1,8}$/i.test(name)) code = parseInt(name.slice(2), 16);
    else return original;
    if (code > 0x10ffff || (code & 0xffff) >= 0xfffe || (code >= 0xd800 && code <= 0xdfff)
      || (code >= 0xfdd0 && code <= 0xfdef) || code <= 8 || code === 11
      || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)) return original;
    return String.fromCodePoint(code);
  });
}

function mdSafeLink(link, { literal = false } = {}) {
  const raw = literal ? link : mdUnescape(link.startsWith('<') ? link.slice(1, -1) : link);
  const url = raw.replace(mdTrim, '');
  if (/^(?:vbscript|javascript|file):/i.test(url)) return false;
  if (!/^data:/i.test(url)) return true;

  // 只投影 normalizeLink 后 validateLink 读取的前缀。百分号编码不产生新的 ASCII 协议或 MIME 分隔符。
  const mime = /^data:([^/?#]*)\/(?:gif|png|jpeg|webp);/i.exec(url);
  if (!mime || mime[1].lastIndexOf('@') > 0) return false;
  const host = mime[1].replace(/^@/, ''); // mdurl 格式化时略去空用户名和单纯主机名的方括号。
  if (/^(?:image|\[image\])$/i.test(host)) return true;
  if (host.length <= 255 || !/image$/i.test(host)) return false;

  // mdurl 将首个无效域名段的尾部移入路径，主机超过 255 个码点时丢弃主机。
  const parts = host.split('.');
  let length = 0;
  for (const [index, part] of parts.entries()) {
    const ascii = part.replace(/[^\x00-\x7f]/gu, 'x');
    if (!/^[+a-z0-9_-]{0,63}$/i.test(ascii)) {
      const prefix = /^[+a-z0-9_-]{0,63}/i.exec(part)[0].length;
      return length + prefix > 255 && index === parts.length - 1 && /^image$/i.test(part.slice(prefix));
    }
    length += ascii.length + 1;
  }
  return false;
}

const mdAutolinkUri = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*$/;
const mdAutolinkEmail = /^[A-Za-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
function mdAutolinkEnd(source, from, max = source.length) {
  let to = from + 1;
  while (to < max && source[to] !== '<' && source[to] !== '>') to++;
  if (to >= max || source[to] !== '>') return -1;
  const url = source.slice(from + 1, to);
  // Python 的 $ 也匹配最后一个换行之前；原始 URI 不展开 Markdown 实体。
  const value = url.endsWith('\n') ? url.slice(0, -1) : url;
  if (mdAutolinkUri.test(value)) return mdSafeLink(value, { literal: true }) ? to + 1 : -1;
  return mdAutolinkEmail.test(value) ? to + 1 : -1;
}

function mdDefinition(source, nextLine) {
  const grow = () => {
    const next = nextLine();
    if (next === null) return false;
    source += '\n' + next;
    return true;
  };
  const labelPattern = /^\[((?:\\[\s\S]|[^\[\]\\])+)\]:/;
  let label = labelPattern.exec(source);
  while (!label && /^\[(?:\\[\s\S]|[^\[\]\\])*\\?$/.test(source) && grow()) label = labelPattern.exec(source);
  const key = label && mdRefKey(label[1]);
  if (!key) return null;
  let value = mdSpaceEnd(source, label[0].length);
  while (value === source.length && grow()) value = mdSpaceEnd(source, value);
  // 引用定义的目标扫描包含当前物理行的行尾，反斜杠可消耗这个换行。
  const dest = mdDestination(source + '\n', value);
  if (dest < 0 || !mdSafeLink(source.slice(value, dest))) return null;
  let titleAt = mdSpaceEnd(source, dest);
  if (titleAt === source.length && grow()) titleAt = mdSpaceEnd(source, titleAt);
  let titleEnd = titleAt === dest ? undefined : mdTitle(source, titleAt);
  while (titleEnd === -1 && grow()) titleEnd = mdTitle(source, titleAt);
  // 参考解析器只在非空标题后有杂字时退回到无标题定义。
  const ends = titleEnd === titleAt + 2 ? [titleEnd] : [titleEnd, dest];
  for (const pos of ends) {
    if (pos === undefined || pos < 0 || !/^[ \t]*(?:\n|$)/.test(source.slice(pos))) continue;
    return { key, length: source.slice(0, pos).split('\n').length };
  }
  return null;
}

// 只输出检查器关心的源码区间。每个行内输入有自己的试读缓存和反引号扫描历史。
function mdInlineRanges(source, references, labelAt = -1) {
  const ranges = [];
  const maxNesting = 20;
  function parse(text, offset, requestedLabel = -1) {
    const skipped = new Map(), backticks = new Map();
    let backticksScanned = false;
    function emit(from, to, kind, silent) {
      if (!silent) ranges.push({ from: offset + from, to: offset + to, kind });
      return to;
    }
    function backtick(pos, max, silent) {
      let end = pos + 1;
      while (end < max && text[end] === '\x60') end++;
      const width = end - pos;
      if (backticksScanned && (backticks.get(width) ?? 0) <= pos) return end;
      // 参考实现在全输入上找起点，用当前标签上界量宽；试读和发出 token 两遍共享这个结果。
      let from = text.indexOf('\x60', end);
      while (from >= 0) {
        let to = from + 1;
        while (to < max && text[to] === '\x60') to++;
        if (to - from === width) return emit(pos, to, 'code', silent);
        backticks.set(to - from, from);
        from = text.indexOf('\x60', to);
      }
      backticksScanned = true;
      return end;
    }
    function labelEnd(open, max, level, disableNested) {
      let brackets = 1;
      for (let pos = open + 1; pos < max;) {
        const marker = text[pos];
        if (marker === ']' && --brackets === 0) return pos;
        let next = skipped.get(pos);
        if (next === undefined) {
          next = level < maxNesting ? token(pos, max, level + 1, true) : max + 1;
          skipped.set(pos, next);
        }
        if (marker === '[') {
          if (next === pos + 1) brackets++;
          else if (disableNested) return -1;
        }
        pos = next;
      }
      return -1;
    }
    function link(pos, max, level, silent, image) {
      const start = pos + (image ? 2 : 1);
      const close = labelEnd(start - 1, max, level, !image);
      if (close < 0) return pos + 1;
      let refAt = close + 1, end = -1, kind = 'destination';
      if (refAt < max && text[refAt] === '(') {
        const value = mdSpaceEnd(text, refAt + 1, max);
        if (value >= max) return pos + 1;
        const dest = mdDestination(text, value, max);
        let cursor = dest >= 0 && mdSafeLink(text.slice(value, dest)) ? dest : value;
        const titleAt = mdSpaceEnd(text, cursor, max);
        if (titleAt > cursor) {
          const title = mdTitle(text, titleAt, max);
          cursor = title >= 0 ? mdSpaceEnd(text, title, max) : titleAt;
        }
        if (cursor < max && text[cursor] === ')') end = cursor + 1;
        else if (image) return pos + 1;
        else refAt = cursor + 1; // 普通链接试读失败时，参考实现从这个位置尝试引用。
      }
      if (end < 0) {
        if (!references.size) return pos + 1;
        const second = refAt < max && text[refAt] === '[' ? labelEnd(refAt, max, level, false) : -1;
        const key = second > refAt + 1 ? text.slice(refAt + 1, second) : text.slice(start, close);
        if (!references.has(mdRefKey(key))) return pos + 1;
        end = second < 0 ? close + 1 : second + 1;
        if (second < 0) kind = 'reference';
      }
      if (!silent) {
        if (image) parse(text.slice(start, close), offset + start);
        else tokenize(start, close, level + 1);
      }
      return emit(close, end, kind, silent);
    }
    function token(pos, max, level, silent) {
      const ch = text[pos];
      if (ch === '[' || (ch === '!' && pos + 1 < max && text[pos + 1] === '[')) {
        return link(pos, max, level, silent, ch === '!');
      }
      if (ch === '\x60') return backtick(pos, max, silent);
      if (ch === '<') {
        const auto = mdAutolinkEnd(text, pos, max);
        if (auto >= 0) return emit(pos, auto, 'autolink', silent);
        if (pos + 2 < max) {
          mdInlineHtml.lastIndex = pos;
          const html = mdInlineHtml.exec(text);
          if (html) return emit(pos, pos + html[0].length, html[0].startsWith('<!--') ? 'comment' : 'html', silent);
        }
      }
      if (ch === '\n' || (ch === '\\' && pos + 1 < max && text[pos + 1] === '\n')) {
        let end = pos + (ch === '\\' ? 2 : 1);
        while (end < max && (text[end] === ' ' || text[end] === '\t')) end++;
        return end;
      }
      if (ch === '\\' && pos + 1 < max) return pos + (text.codePointAt(pos + 1) > 0xffff ? 3 : 2);
      if (ch === '&') {
        mdInlineEntity.lastIndex = pos;
        const entity = mdInlineEntity.exec(text);
        if (entity && (!entity[1] || Object.hasOwn(mdEntities, entity[1]))) return mdInlineEntity.lastIndex;
      }
      mdInlineText.lastIndex = pos;
      if (mdInlineText.test(text)) return mdInlineText.lastIndex === text.length ? max : mdInlineText.lastIndex;
      return pos + 1;
    }
    function tokenize(start, max, level) {
      if (level >= maxNesting) return;
      for (let pos = start; pos < max;) pos = token(pos, max, level, false);
    }
    if (requestedLabel >= 0) return labelEnd(requestedLabel, text.length, 0, false);
    tokenize(0, text.length, 0);
    return ranges;
  }
  return parse(source, 0, labelAt);
}

function mdTicket(text) {
  text = text.replace(/^\uFEFF/, '');
  const raw = text.split(/\r\n?|\n/);
  if (raw.at(-1) === '') raw.pop();
  const lines = raw.map(line => line.replace(/\0/g, '\uFFFD'));
  const rows = raw.map(visible => ({ visible, mask: [], owner: [], block: null, lazy: false }));
  const blocks = [], headings = [], stack = [], references = new Set(), inlineRanges = [];
  let leaf = null;

  // 引用/列表的续行只消耗前缀，Tab 未用完的列仍归下一层。
  function quoteBody(line, { at }) {
    const point = { pos: at.pos + 1, col: at.col + 1 };
    // 引用剥去标记后仍保留部分 Tab 的原字符；列表的部分 Tab 则展开成剩余空格。
    const { pos, col } = mdSpace(line, point, point.col + 1);
    return { pos, col };
  }
  function continuation(line, consuming = false) {
    let base = mdStart, depth = 0, blankBelowIndent = false;
    for (const frame of stack) {
      const view = mdView(line, base);
      if (frame.kind === 'quote') {
        if (view.text[0] !== '>') break;
        base = quoteBody(line, view);
        blankBelowIndent = false;
      } else if (!view.text) {
        if (frame.empty) break;
        if (view.indent < frame.indent) blankBelowIndent = true;
        base = mdSpace(line, base, base.col + frame.indent);
      } else if (view.indent >= frame.indent) {
        if (consuming) frame.empty = false;
        base = mdSpace(line, base, base.col + frame.indent);
      } else break;
      depth++;
    }
    return { base, depth, blankBelowIndent };
  }
  function interrupt({ text: body, indent }, paragraph) {
    if (indent >= 4) return false;
    if (body[0] === '>' || mdAtx.test(body) || mdHr.test(body) || mdFenceStart(body) || mdHtml(body, true)) return true;
    const list = mdList.exec(body);
    return !!list && (!paragraph || ((!list[2] || Number(list[2]) === 1) && /[^ \t]/.test(body.slice(list[0].length))));
  }
  function open(kind, start, data = {}) {
    const block = { kind, start, after: start, owner: stack.slice(), inline: [], ...data };
    blocks.push(block);
    return block;
  }
  function rowIn(block, i, start, end = raw[i].length) {
    rows[i].block = block;
    rows[i].owner = block.owner;
    block.after = i + 1;
    if (start) block.inline.push([i, start.pos, end, start.tabLeft ?? 0]);
  }
  function heading(block, level, markup) {
    Object.assign(block, { kind: 'heading', level, markup, style: markup[0] === '#' ? 'atx' : 'setext' });
    headings.push(block);
  }
  function closeContainers(depth, i) {
    while (stack.length > depth) stack.pop().end = i;
    leaf = null;
  }
  for (let i = 0; i < raw.length; i++) {
    const line = lines[i];
    let { base, depth, blankBelowIndent } = continuation(line, true), view = mdView(line, base);
    if (depth < stack.length) {
      // 外层引用已按延迟续行看过的行，在内层引用不再享有四列缩进屏障。
      const missingQuotes = stack.slice(depth).filter(frame => frame.kind === 'quote').length;
      const outside = missingQuotes > 1 ? { ...view, indent: 0 } : view;
      if (leaf?.kind === 'paragraph' && view.text && !interrupt(outside, false)) {
        rowIn(leaf, i, base); rows[i].lazy = true;
        continue;
      }
      closeContainers(depth, i);
    }
    if (leaf?.kind === 'fence') {
      rowIn(leaf, i);
      const closing = mdFence.exec(view.text);
      if (view.indent < 4 && closing?.[1][0] === leaf.markup[0] && closing[1].length >= leaf.markup.length && /^[ \t]*$/.test(closing[2])) leaf = null;
      continue;
    }
    if (leaf?.kind === 'html') {
      if (!blankBelowIndent && (leaf.close || view.text)) {
        rowIn(leaf, i);
        if (leaf.close?.test(view.text)) leaf = null;
        continue;
      }
      leaf = null;
    }
    if (leaf?.kind === 'code') {
      if (!view.text) continue;
      if (view.indent >= 4) { rowIn(leaf, i); continue; }
      leaf = null;
    }
    if (!view.text) {
      rows[i].owner = stack.slice();
      leaf = null;
      continue;
    }
    if (leaf?.kind === 'paragraph') {
      const underline = view.indent < 4 && mdSetext.exec(view.text);
      if (underline) {
        rowIn(leaf, i);
        const marker = underline[1][0];
        heading(leaf, marker === '=' ? 1 : 2, marker);
        leaf = null;
        continue;
      }
      if (!interrupt(view, true)) { rowIn(leaf, i, base); continue; }
      leaf = null;
    }
    for (;;) {
      const { at, indent, text: body } = view;
      if (!body) { rows[i].owner = stack.slice(); break; }
      if (indent >= 4) {
        leaf = open('code', i);
        rowIn(leaf, i);
        break;
      }
      if (body[0] === '>') {
        stack.push({ kind: 'quote', start: i });
        base = quoteBody(line, view);
      } else {
        const fence = mdFenceStart(body), atx = mdAtx.exec(body), list = mdList.exec(body);
        if (fence) {
          leaf = open('fence', i, { markup: fence });
          rowIn(leaf, i);
          break;
        }
        if (mdHr.test(body)) { rowIn(open('hr', i), i); break; }
        if (list) {
          const marker = { pos: at.pos + list[0].length, col: at.col + list[0].length };
          const content = mdSpace(line, marker);
          const empty = content.pos === line.length, spaces = content.col - marker.col;
          const padding = empty || spaces > 4 ? 1 : spaces;
          stack.push({ kind: 'item', start: i, indent: indent + list[0].length + padding, empty });
          base = mdSpace(line, marker, marker.col + padding);
        } else if (atx) {
          const from = at.pos + atx[1].length;
          const content = body.slice(atx[1].length).replace(/[ \t]+$/, '').replace(/[ \t]+#+$/, '');
          const block = open('heading', i);
          rowIn(block, i, { pos: from }, from + content.length);
          heading(block, atx[1].length, atx[1]);
          break;
        } else {
          const html = mdHtml(body, false);
          if (html) {
            const block = open('html', i, { close: html[1] });
            rowIn(block, i);
            leaf = block.close?.test(body) ? null : block;
            break;
          }
          if (body[0] === '[') {
            let last = i + 1;
            const def = mdDefinition(body, () => {
              if (last >= raw.length) return null;
              const nextLine = lines[last++], next = mdView(nextLine, continuation(nextLine).base);
              return next.text && !interrupt(next, false) ? next.text : null;
            });
            if (def) {
              references.add(def.key);
              const block = open('reference', i);
              for (let j = i; j < i + def.length; j++) rowIn(block, j);
              i = block.after - 1;
              break;
            }
          }
          leaf = open('paragraph', i);
          rowIn(leaf, i, base);
          break;
        }
      }
      view = mdView(line, base);
    }
  }
  closeContainers(0, raw.length);
  for (const block of blocks) {
    if (block.kind === 'code') {
      for (let i = block.start; i < block.after; i++) {
        rows[i].block = block; rows[i].owner = block.owner;
      }
    }
    if (['fence', 'code', 'html', 'reference'].includes(block.kind)) {
      for (let i = block.start; i < block.after; i++) rows[i].visible = '';
      continue;
    }
    if (!block.inline.length) continue;
    let offset = 0;
    const positions = block.inline.map(([i, from, to, tabLeft]) => {
      const part = tabLeft ? ' '.repeat(tabLeft) + lines[i].slice(from + 1, to) : lines[i].slice(from, to);
      const position = { i, from, part, tabLeft, offset, end: offset + part.length };
      offset = position.end + 1;
      return position;
    });
    const column = (p, index) => {
      const local = Math.max(0, Math.min(index, p.end) - p.offset);
      return p.from + (p.tabLeft ? Math.max(0, local + 1 - p.tabLeft) : local);
    };
    const inline = positions.map(p => p.part).join('\n');
    const content = inline.replace(mdTrim, ''), leading = inline.indexOf(content);
    let first = 0, headingText = '', afterComment = 0;
    for (const range of mdInlineRanges(content, references)) {
      range.from += leading;
      range.to += leading;
      if (block.kind === 'heading' && range.kind === 'comment') {
        headingText += inline.slice(afterComment, range.from);
        afterComment = range.to;
      }
      while (positions[first].end < range.from) first++;
      let last = first;
      for (; last < positions.length && positions[last].offset < range.to; last++) {
        const part = positions[last];
        if (range.kind !== 'comment') continue;
        const lo = column(part, range.from), hi = column(part, range.to);
        if (lo < hi) rows[part.i].mask.push([lo, hi]);
      }
      const begin = positions[first], finish = positions[last - 1];
      inlineRanges.push({ start: begin.i, after: finish.i + 1, kind: range.kind,
        from: column(begin, range.from), to: column(finish, range.to) });
    }
    for (const { i } of positions) {
      let value = '', at = 0;
      for (const [lo, hi] of rows[i].mask) { value += raw[i].slice(at, lo); at = hi; }
      rows[i].visible = value + raw[i].slice(at);
    }
    if (block.kind === 'heading') block.label = (headingText + inline.slice(afterComment)).replace(mdTrim, '');
  }
  const sections = new Map();
  for (const h of headings) {
    const owner = h.owner.at(-1);
    let open = sections.get(owner);
    if (!open) { open = []; sections.set(owner, open); }
    while (open.length && open.at(-1).level >= h.level) {
      const previous = open.pop();
      previous.end = h.start; previous.next = h;
    }
    h.end = owner?.end ?? raw.length;
    open.push(h);
  }
  return { text, raw, rows, blocks, headings, top: headings.filter(h => !h.owner.length), inlineRanges };
}

function sheetFacts(root, NN, doc, { createdVer, upgradeVer, upgradeDate, upgradeBroken, legacySet }) {
  const { version, confirms } = doc;
  const rel = `docs\\check\\ticket-${NN}-v${version}.sha256`;
  const hasFingerprint = lexists(path.join(root, rel));
  const confirmed = confirmationFor(confirms, version);
  const [date, ...words] = (confirmed?.replace(CONFIRM, '') ?? '').trim().split(/\s*[｜|]\s*/);
  const when = isoDate(date);
  // 早期升级没有 NN@V 清单时，仍按本版最后确认日期回查。
  const isLegacyTicketSheet = !upgradeBroken && !!createdVer && !hasFingerprint && hasVersionRound(doc, version)
    && (!upgradeVer || (legacySet ? legacySet.has(`${NN}@${version}`) : !!when && when <= upgradeDate));
  return { version, rel, hasFingerprint, confirmed, quote: words.join('｜'),
    legacyValue: isLegacyTicketSheet && !verAtLeast(createdVer, [1, 18, 0]), legacyRun: isLegacyTicketSheet && !verAtLeast(createdVer, [1, 21, 0]),
    requireFingerprint: upgradeBroken || verAtLeast(createdVer, [1, 21, 0]) || (verAtLeast(upgradeVer, [1, 21, 0]) && !isLegacyTicketSheet) };
}
const sourcesOf = doc => below(doc, doc.sheet, doc.self[0]?.start)
  .map((line, i) => ({ line, at: doc.sheet.after + i })).filter(({ line }) => /^- 预期值来源[：:]/.test(line));
function validValueSource(N, row, entries) {
  const source = entries.length === 1 ? entries[0].line.replace(/^- 预期值来源[：:]\s*/, '').trim() : '';
  const match = /^(样例清点确认|旧成品对照|SOP硬阈值|边界小样核定|AI同源试算（未做独立口径核验）)[：:](.+)$/.exec(source);
  const why = match?.[2]?.trim() ?? '';
  // 沿用原有计算/筛选规则；清洗类动作只看本步做什么，读取前一步清洗产物仍可只是清点。
  const calculated = /汇总|合计|剔除|筛选|差值|平均|占比|率|折算|排名|星标/.test(row?.join(' ') ?? '')
    || /清洗|去重|转换|标准化|映射/.test(row?.[3] ?? '');
  return !!why && !/[<>]|\.{3}|…|待填|待确认/.test(why) && !(N !== 1 && calculated && match[1] === '样例清点确认');
}
function checkValueSource(N, row, entries, legacyValue) {
  if (validValueSource(N, row, entries)) return;
  if (legacyValue) note('旧版票据未写预期值来源（按历史已过票兼容；后续升版修改本票时请补齐）');
  else no('计算或筛选步骤缺少独立真值来源（旧成品对照 / SOP硬阈值 / 边界小样核定，或显式标明 AI同源试算未核风险）；清点步骤也须填写具体来源');
}
const hasBadInput = (groups, NN) => groups.current.some(c => c.p.startsWith(`work\\${NN}-坏输入\\`) && c.verb === '含');

function ticketContract() {
  label = '票 ' + pad(Number(extra));
  const data = readTicket();
  if (!data) return null;
  const { N, NN, doc } = data;
  const lines = flowLines(), rows = table(lines, '运行表', FLOW_HEAD);
  const row = rows?.find(r => r[0] === String(N));
  if (!row || !['AI照规矩', 'AI看情况'].includes(row[1])) no(`运行表第 ${N} 步缺失或为人工步骤，不应出票`);
  if (Number(doc.raw[0]?.match(/^# 票\s*(\d+)\s*[：:]/)?.[1]) !== N) no('票标题步号须与运行表和文件名一致');
  const stepNumber = doc.step?.label.match(/第\s*(\d+)\s*行/)?.[1];
  if (!doc.step || (stepNumber && Number(stepNumber) !== N)) no('缺少对应运行表步号的“## 这一步”');
  const indexText = readProjectIndex();
  const history = projectVersions(indexText?.replace(/^\uFEFF/, '') ?? '');
  if (history.upgradeBroken) no('docs\\PROJECT_INDEX.md 的"最近体检升级："格式或日期无效');
  const facts = sheetFacts(PROJ, NN, doc, history);
  if (indexText === null) facts.requireFingerprint = true;
  if (!facts.version) no('缺少有效的最新版验收单标题');
  if (doc.self.length !== 1) no('最新版验收单需要一节“### AI 自检”');
  checkValueSource(N, row, sourcesOf(doc), facts.legacyValue);
  const groups = assertionGroups(doc, doc.self[0]);
  const hasBad = hasBadInput(groups, NN);
  if (N === 1 && !hasBad) no('票 01 缺少坏输入结果的内容断言');
  return { ...data, ...facts, indexText, history, lines, rows, row, groups, hasBad };
}

// 旧签只复算 v1.21 选中的一个物理标题与一个边界。
const fingerprintText = lines => lines.map(line => line.trimEnd()).join('\n').trimEnd();
const fingerprintOf = lines => createHash('sha256').update(fingerprintText(lines), 'utf8').digest('hex') + '\n';
const oldEnd = (lines, start) => {
  let i = start + 1;
  while (i < lines.length && (lines[i].trimStart().match(/^(#+) /)?.[1].length ?? 9) > 2) i++;
  return i;
};
function oldConfirmation(lines, version) {
  const at = lines.findIndex(l => l.trim() === '## 确认记录');
  return at >= 0 && confirmationFor(confirmationRows(lines.slice(at + 1, oldEnd(lines, at))), version);
}

function fingerprintContract(doc, groups, hasBad) {
  const start = doc.sheet.start, h = doc.self[0];
  const withSource = (at, value) => [at - start, doc.raw[at].trimEnd(), value];
  return [doc.sheet.label, doc.version, [h.start - start, h.after - start, h.end - start, h.label],
    sourcesOf(doc).map(({ at, line }) => withSource(at, line.trimEnd())), groups.baseline,
    groups.facts.map(([at, kind, fact]) => withSource(at, [kind, fact])), hasBad];
}
function sealedOldPrefix(data, signed, end) {
  const { doc, groups, NN, hasBad } = data;
  const start = doc.sheet.start;
  const stop = doc.self[0]?.next;
  if (!stop || stop.after > end || end >= doc.sheet.end) return false;
  // 末尾仍可接着写的块不能证明封口；阅读提示里的围栏只遮蔽节外示例。
  if (doc.blocks.some(b => b.start >= start && b.start < end && b.after > end && !(b.kind === 'fence' && b.start >= stop.after))
    || doc.inlineRanges.some(r => r.start >= start && r.start < end && r.after > end)) return false;

  const prefix = ticketDocument(signed);
  const witness = prefix.self[0]?.next;
  if (prefix.raw.length !== end - start || prefix.sheet?.start !== 0 || prefix.self.length !== 1 ||
      !witness || witness.start + start !== stop.start || witness.after + start !== stop.after ||
      witness.level !== stop.level || witness.style !== stop.style || witness.label !== stop.label) return false;
  // 同一已签行在两次解析中须有相同的归属、资格和可见正文。
  const rowShape = (row, shift) => [row.visible.trimEnd(), row.lazy, row.block?.kind,
    row.block ? row.block.start - shift : null, row.owner.map(f => [f.kind, f.start - shift])];
  if (prefix.rows.some((r, i) => JSON.stringify(rowShape(r, 0)) !== JSON.stringify(rowShape(doc.rows[start + i], start)))) return false;
  const inlineShape = (ranges, shift) => ranges.filter(r => r.start >= shift && r.after <= end - start + shift)
    .map(r => [r.start - shift, r.after - shift, r.kind, r.from, r.to]);
  if (JSON.stringify(inlineShape(prefix.inlineRanges, 0)) !== JSON.stringify(inlineShape(doc.inlineRanges, start))) return false;
  const problems = [];
  const oldGroups = assertionGroups(prefix, prefix.self[0], issue => problems.push(issue));
  return !problems.length && JSON.stringify(fingerprintContract(prefix, oldGroups, hasBadInput(oldGroups, NN)))
    === JSON.stringify(fingerprintContract(doc, groups, hasBad));
}
function oldFingerprint(data, stored, lines) {
  const { doc, version } = data;
  const from = lines.findLastIndex(l => l.startsWith('## 验收单'));
  if (from < 0 || OLD_SHEET.exec(lines[from])?.[1] !== version ||
      lines.filter(l => OLD_SHEET.exec(l)?.[1] === version).length !== 1) return 'different';
  const until = oldEnd(lines, from);
  const offset = [0, ...Array.from(doc.text.matchAll(/\r?\n/g), m => m.index + m[0].length)];
  const physicalLine = i => i >= offset.length ? doc.raw.length : (doc.text.slice(0, offset[i]).match(/\r\n?|\n/g)?.length ?? 0);
  if (physicalLine(from) !== doc.sheet.start) return 'different';
  const signed = lines.slice(from, until);
  if (fingerprintOf(signed) !== stored) return 'different';

  const end = physicalLine(until);
  // B：终止标题的全部原行也须在覆盖之内；无终止标题时两边须共同到文末。
  if (doc.sheet.next ? doc.sheet.next.after <= end : until === lines.length) return 'match';
  // A：仅以指纹实际覆盖的规范化字节重放已封口的合同。
  const prefix = signed.map(line => line.trimEnd()).join('\n') + '\n';
  return sealedOldPrefix(data, prefix, end) ? 'match' : 'uncovered';
}

function checkTicketFingerprint(data) {
  const { NN, version, doc, rel, confirmed, requireFingerprint, history, indexText } = data;
  const file = guard(rel);
  const entry = fs.lstatSync(path.join(PROJ, rel), { throwIfNoEntry: false });
  if (entry && !entry.isFile()) return no(`第 ${version} 版预检指纹不是项目内普通文件`);
  const stored = entry ? fs.readFileSync(file, 'utf8') : undefined;
  const hash = fingerprintOf(doc.raw.slice(doc.sheet.start, doc.sheet.end));
  if (stored === hash) return;

  const valid = stored !== undefined && /^[a-f0-9]{64}\n$/.test(stored) && stored.length === 65;
  const oldProject = indexText !== null && !history.upgradeBroken && !verAtLeast(history.createdVer, [2, 0, 0]);
  const oldLines = oldProject && entry ? doc.text.split(/\r?\n/) : null;
  const locked = confirmed || (oldLines && oldConfirmation(oldLines, version));
  if (cmd === 'ticket' && !locked) {
    if (entry && !valid) return no(`第 ${version} 版已有预检指纹的格式无效，请核对原记录`);
    // 先保存预检报告；报告失败或指纹无法原子替换时，保留上一次签发的字节。
    return () => writeIn(rel, hash, { atomic: true });
  }

  const next = BigInt(version) + 1n;
  if (entry) {
    const result = valid && oldLines ? oldFingerprint(data, stored, oldLines) : 'different';
    if (result === 'match') return;
    if (result === 'uncovered') return no(cmd === 'ticket'
      ? `第 ${version} 版已确认且旧预检指纹覆盖不足，续用或修改须升为第 ${next} 版`
      : `历史旧预检指纹覆盖不足，无法证明后续内容未改，请升为第 ${next} 版重新请学员确认`);
    no(cmd === 'ticket'
      ? `第 ${version} 版已确认，改验收单须升为第 ${next} 版`
      : `票 ${NN} 第 ${version} 版验收单在确认/预检后被改过，请恢复原验收单或升为第 ${next} 版重新请学员确认`);
  } else if (requireFingerprint) {
    no(`第 ${version} 版已确认但缺预检指纹：请升为第 ${next} 版，跑 ticket 后重新请学员确认`);
  } else note(`第 ${version} 版验收单没有预检指纹（旧票或手写），本次未核正文是否改过`);
}

function ticket() {
  const data = ticketContract();
  if (data) label = `票 ${data.NN}｜第 ${data.version ?? '?'} 版｜语法预检`;
  const saveFingerprint = data && !bad ? checkTicketFingerprint(data) : undefined;
  out.push('语法预检不代表已有批准、产物或业务验收结果。');
  return saveFingerprint;
}

const DENY = /不|别|勿|没|暂|等|如果|假如|要是|仅定稿|再说/u;
const RUN = /^(?:(?:好的?|可以|行|嗯|OK)[，,、]?\s*)?(?:就这样跑|先这样跑|按这个跑|照这个跑|就按这个跑|开始跑|跑吧|可以跑了?)(?:吧)?$/iu;
const LEGACY = /^([^（(]{1,20}?)[（(]意同(?:口令)?[“"「']?就这样跑[”"」']?[^）)]*[）)]$/u;
const quoteDigits = s => s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const otherTicket = (quote, N) => [...quote.matchAll(/票\s*(\d+)/g)].some(m => Number(m[1]) !== N);
function singlePermit(quote, legacyRun) {
  const body = quote.trim().replace(/[。.!！～~\s]+$/u, '').replace(/^票\s*\d+\s*(?:验收单确认)?\s*[，,：:｜|]?\s*/u, '');
  const old = LEGACY.exec(body);
  if (DENY.test(old ? old[1] : body)) return '';
  return RUN.test(body) ? '单票' : old && legacyRun ? '旧版括注' : '';
}
function verifyRunPermission(data) {
  const { N, NN, doc, version, hasBad } = data;
  const confirmations = doc.confirms;
  for (const l of confirmations) if (!CONFIRM.test(l)) no(`确认记录格式不符：${l}`);
  const last = confirmations.at(-1) ?? '';
  const match = CONFIRM.exec(last);
  if (!match) return no('没有有效的本票确认记录');
  const [, k, cv] = match;
  label = `票 ${NN}｜第 ${k} 次确认（第 ${cv ?? '?'} 版）`;
  if (!cv || cv !== version) no('最后确认的验收单版号与最新版不符');
  const [date = '', ...words] = last.slice(match[0].length).trim().split(/\s*[｜|]\s*/);
  const quote = quoteDigits(words.join('｜'));
  if (!isoDate(date) || /<[^<>]*>/.test(quote)) no('确认记录须写日期和真实原话');
  if (otherTicket(quote, N)) return no('最后一条确认记录点名了其它票号，不能代认本票');
  const permit = singlePermit(quote, data.legacyRun);
  if (quote.includes('仅定稿·未获准运行') || (/票\s*\d+\s*验收单确认/.test(quote) && !permit && !quote.includes('按快跑档推进')))
    return no(`票 ${NN} 当前仅为验收单定稿（未获准运行），须获运行授权并实跑后再验收`);
  if (quote === '按快跑档推进') {
    checkFastBatch(data, cv, date.trim());
    if (!hasBad) no('快跑缺少本票当期坏输入结果的内容断言');
  } else if (permit === '旧版括注') note('旧版确认记录（括注写法），按历史已过票兼容');
  else if (!permit) no('当前验收单没有明确的单票运行许可或合法快跑许可');
}

// A bounded head tokenizer reads metadata as data. Raw text and template bodies cannot declare it.
const HEAD_TAGS = new Set(['title','meta','base','link','script','style','template','noscript']);
function headMeta(text, wanted) {
  const tags = /<!--[\s\S]*?(?:-->|$)|<!doctype\b[^>]*>|<(\/?)([a-z][\w:-]*)(\s*(?:"[^"]*"|'[^']*'|[^'"<>])*)>/gi;
  let inHead = false, inTemplate = 0, consumed = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const matches = [];
  for (let tok; (tok=tags.exec(text)); consumed=tags.lastIndex) {
    if (!inTemplate && /[^ \t\n\f\r]/.test(text.slice(consumed,tok.index))) return {matches,ended:true};
    const [,closing,rawName,attrs] = tok;
    if (!rawName) continue;
    const name=rawName.toLowerCase();
    if (!inHead) {
      if (name==='head' && !closing) { inHead=true; continue; }
      if (name==='html' && !closing) continue;
      if (!closing && HEAD_TAGS.has(name)) inHead=true;
      else return {matches,ended:true};
    }
    if (!inTemplate && !HEAD_TAGS.has(name) && !(name==='head' && !closing))
      return {matches,ended:true};
    if (name==='template') { inTemplate=Math.max(0,inTemplate+(closing?-1:1)); continue; }
    if (!closing && ['script','style','title','noscript'].includes(name)) {
      const close=new RegExp('</'+name+'\\s*>','ig');
      close.lastIndex=tags.lastIndex;
      if (!close.exec(text)) break;
      tags.lastIndex=close.lastIndex;
      continue;
    }
    if (inTemplate || name!=='meta' || closing) continue;
    const fields=new Map();
    for (const a of attrs.matchAll(/([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const key=a[1].toLowerCase();
      if (!fields.has(key)) fields.set(key,[]);
      fields.get(key).push(htmlValue(a[2] ?? a[3] ?? a[4] ?? ''));
    }
    if (fields.get('name')?.some(x=>x.toLowerCase()===wanted))
      matches.push({value:fields.get('content')?.[0] ?? '', valid:fields.get('name').length===1 && fields.get('content')?.length===1});
  }
  return {matches,ended:false};
}
// WHATWG entities.json. Each record is hex code point(s) followed by case-sensitive names.
const htmlEntities=new Map();
for (const record of `c6:AElig 26:AMP:amp c1:Aacute 102:Abreve c2:Acirc 410:Acy 1d504:Afr c0:Agrave 391:Alpha 100:Amacr 2a53:And
104:Aogon 1d538:Aopf 2061:ApplyFunction:af c5:Aring:angst 1d49c:Ascr 2254:Assign:colone:coloneq c3:Atilde
c4:Auml 2216:Backslash:setminus:setmn:smallsetminus:ssetmn 2ae7:Barv 2306:Barwed:doublebarwedge 411:Bcy
2235:Because:becaus:because 212c:Bernoullis:Bscr:bernou 392:Beta 1d505:Bfr 1d539:Bopf 2d8:Breve:breve
224e:Bumpeq:HumpDownHump:bump 427:CHcy a9:COPY:copy 106:Cacute 22d2:Cap 2145:CapitalDifferentialD:DD
212d:Cayleys:Cfr 10c:Ccaron c7:Ccedil 108:Ccirc 2230:Cconint 10a:Cdot b8:Cedilla:cedil
b7:CenterDot:centerdot:middot 3a7:Chi 2299:CircleDot:odot 2296:CircleMinus:ominus 2295:CirclePlus:oplus
2297:CircleTimes:otimes 2232:ClockwiseContourIntegral:cwconint 201d:CloseCurlyDoubleQuote:rdquo:rdquor
2019:CloseCurlyQuote:rsquo:rsquor 2237:Colon:Proportion 2a74:Colone 2261:Congruent:equiv
222f:Conint:DoubleContourIntegral 222e:ContourIntegral:conint:oint 2102:Copf:complexes 2210:Coproduct:coprod
2233:CounterClockwiseContourIntegral:awconint 2a2f:Cross 1d49e:Cscr 22d3:Cup 224d:CupCap:asympeq 2911:DDotrahd
402:DJcy 405:DScy 40f:DZcy 2021:Dagger:ddagger 21a1:Darr 2ae4:Dashv:DoubleLeftTee 10e:Dcaron 414:Dcy
2207:Del:nabla 394:Delta 1d507:Dfr b4:DiacriticalAcute:acute 2d9:DiacriticalDot:dot
2dd:DiacriticalDoubleAcute:dblac 60:DiacriticalGrave:grave 2dc:DiacriticalTilde:tilde 22c4:Diamond:diam:diamond
2146:DifferentialD:dd 1d53b:Dopf a8:Dot:DoubleDot:die:uml 20dc:DotDot 2250:DotEqual:doteq:esdot
21d3:DoubleDownArrow:Downarrow:dArr 21d0:DoubleLeftArrow:Leftarrow:lArr
21d4:DoubleLeftRightArrow:Leftrightarrow:hArr:iff 27f8:DoubleLongLeftArrow:Longleftarrow:xlArr
27fa:DoubleLongLeftRightArrow:Longleftrightarrow:xhArr 27f9:DoubleLongRightArrow:Longrightarrow:xrArr
21d2:DoubleRightArrow:Implies:Rightarrow:rArr 22a8:DoubleRightTee:vDash 21d1:DoubleUpArrow:Uparrow:uArr
21d5:DoubleUpDownArrow:Updownarrow:vArr 2225:DoubleVerticalBar:par:parallel:shortparallel:spar
2193:DownArrow:ShortDownArrow:darr:downarrow 2913:DownArrowBar 21f5:DownArrowUpArrow:duarr 311:DownBreve
2950:DownLeftRightVector 295e:DownLeftTeeVector 21bd:DownLeftVector:leftharpoondown:lhard 2956:DownLeftVectorBar
295f:DownRightTeeVector 21c1:DownRightVector:rhard:rightharpoondown 2957:DownRightVectorBar 22a4:DownTee:top
21a7:DownTeeArrow:mapstodown 1d49f:Dscr 110:Dstrok 14a:ENG d0:ETH c9:Eacute 11a:Ecaron ca:Ecirc 42d:Ecy 116:Edot
1d508:Efr c8:Egrave 2208:Element:in:isin:isinv 112:Emacr 25fb:EmptySmallSquare 25ab:EmptyVerySmallSquare
118:Eogon 1d53c:Eopf 395:Epsilon 2a75:Equal 2242:EqualTilde:eqsim:esim 21cc:Equilibrium:rightleftharpoons:rlhar
2130:Escr:expectation 2a73:Esim 397:Eta cb:Euml 2203:Exists:exist 2147:ExponentialE:ee:exponentiale 424:Fcy
1d509:Ffr 25fc:FilledSmallSquare 25aa:FilledVerySmallSquare:blacksquare:squarf:squf 1d53d:Fopf
2200:ForAll:forall 2131:Fouriertrf:Fscr 403:GJcy 3e:GT:gt 393:Gamma 3dc:Gammad 11e:Gbreve 122:Gcedil 11c:Gcirc
413:Gcy 120:Gdot 1d50a:Gfr 22d9:Gg:ggg 1d53e:Gopf 2265:GreaterEqual:ge:geq 22db:GreaterEqualLess:gel:gtreqless
2267:GreaterFullEqual:gE:geqq 2aa2:GreaterGreater 2277:GreaterLess:gl:gtrless
2a7e:GreaterSlantEqual:geqslant:ges 2273:GreaterTilde:gsim:gtrsim 1d4a2:Gscr 226b:Gt:NestedGreaterGreater:gg
42a:HARDcy 2c7:Hacek:caron 5e:Hat 124:Hcirc 210c:Hfr:Poincareplane 210b:HilbertSpace:Hscr:hamilt
210d:Hopf:quaternions 2500:HorizontalLine:boxh 126:Hstrok 224f:HumpEqual:bumpe:bumpeq 415:IEcy 132:IJlig
401:IOcy cd:Iacute ce:Icirc 418:Icy 130:Idot 2111:Ifr:Im:image:imagpart cc:Igrave 12a:Imacr 2148:ImaginaryI:ii
222c:Int 222b:Integral:int 22c2:Intersection:bigcap:xcap 2063:InvisibleComma:ic 2062:InvisibleTimes:it 12e:Iogon
1d540:Iopf 399:Iota 2110:Iscr:imagline 128:Itilde 406:Iukcy cf:Iuml 134:Jcirc 419:Jcy 1d50d:Jfr 1d541:Jopf
1d4a5:Jscr 408:Jsercy 404:Jukcy 425:KHcy 40c:KJcy 39a:Kappa 136:Kcedil 41a:Kcy 1d50e:Kfr 1d542:Kopf 1d4a6:Kscr
409:LJcy 3c:LT:lt 139:Lacute 39b:Lambda 27ea:Lang 2112:Laplacetrf:Lscr:lagran 219e:Larr:twoheadleftarrow
13d:Lcaron 13b:Lcedil 41b:Lcy 27e8:LeftAngleBracket:lang:langle
2190:LeftArrow:ShortLeftArrow:larr:leftarrow:slarr 21e4:LeftArrowBar:larrb
21c6:LeftArrowRightArrow:leftrightarrows:lrarr 2308:LeftCeiling:lceil 27e6:LeftDoubleBracket:lobrk
2961:LeftDownTeeVector 21c3:LeftDownVector:dharl:downharpoonleft 2959:LeftDownVectorBar 230a:LeftFloor:lfloor
2194:LeftRightArrow:harr:leftrightarrow 294e:LeftRightVector 22a3:LeftTee:dashv 21a4:LeftTeeArrow:mapstoleft
295a:LeftTeeVector 22b2:LeftTriangle:vartriangleleft:vltri 29cf:LeftTriangleBar
22b4:LeftTriangleEqual:ltrie:trianglelefteq 2951:LeftUpDownVector 2960:LeftUpTeeVector
21bf:LeftUpVector:uharl:upharpoonleft 2958:LeftUpVectorBar 21bc:LeftVector:leftharpoonup:lharu
2952:LeftVectorBar 22da:LessEqualGreater:leg:lesseqgtr 2266:LessFullEqual:lE:leqq 2276:LessGreater:lessgtr:lg
2aa1:LessLess 2a7d:LessSlantEqual:leqslant:les 2272:LessTilde:lesssim:lsim 1d50f:Lfr 22d8:Ll
21da:Lleftarrow:lAarr 13f:Lmidot 27f5:LongLeftArrow:longleftarrow:xlarr
27f7:LongLeftRightArrow:longleftrightarrow:xharr 27f6:LongRightArrow:longrightarrow:xrarr 1d543:Lopf
2199:LowerLeftArrow:swarr:swarrow 2198:LowerRightArrow:searr:searrow 21b0:Lsh:lsh 141:Lstrok
226a:Lt:NestedLessLess:ll 2905:Map 41c:Mcy 205f:MediumSpace 2133:Mellintrf:Mscr:phmmat 1d510:Mfr
2213:MinusPlus:mnplus:mp 1d544:Mopf 39c:Mu 40a:NJcy 143:Nacute 147:Ncaron 145:Ncedil 41d:Ncy
200b:NegativeMediumSpace:NegativeThickSpace:NegativeThinSpace:NegativeVeryThinSpace:ZeroWidthSpace a:NewLine
1d511:Nfr 2060:NoBreak a0:NonBreakingSpace:nbsp 2115:Nopf:naturals 2aec:Not 2262:NotCongruent:nequiv
226d:NotCupCap 2226:NotDoubleVerticalBar:npar:nparallel:nshortparallel:nspar 2209:NotElement:notin:notinva
2260:NotEqual:ne 2242,338:NotEqualTilde:nesim 2204:NotExists:nexist:nexists 226f:NotGreater:ngt:ngtr
2271:NotGreaterEqual:nge:ngeq 2267,338:NotGreaterFullEqual:ngE:ngeqq 226b,338:NotGreaterGreater:nGtv
2279:NotGreaterLess:ntgl 2a7e,338:NotGreaterSlantEqual:ngeqslant:nges 2275:NotGreaterTilde:ngsim
224e,338:NotHumpDownHump:nbump 224f,338:NotHumpEqual:nbumpe 22ea:NotLeftTriangle:nltri:ntriangleleft
29cf,338:NotLeftTriangleBar 22ec:NotLeftTriangleEqual:nltrie:ntrianglelefteq 226e:NotLess:nless:nlt
2270:NotLessEqual:nle:nleq 2278:NotLessGreater:ntlg 226a,338:NotLessLess:nLtv
2a7d,338:NotLessSlantEqual:nleqslant:nles 2274:NotLessTilde:nlsim 2aa2,338:NotNestedGreaterGreater
2aa1,338:NotNestedLessLess 2280:NotPrecedes:npr:nprec 2aaf,338:NotPrecedesEqual:npre:npreceq
22e0:NotPrecedesSlantEqual:nprcue 220c:NotReverseElement:notni:notniva
22eb:NotRightTriangle:nrtri:ntriangleright 29d0,338:NotRightTriangleBar
22ed:NotRightTriangleEqual:nrtrie:ntrianglerighteq 228f,338:NotSquareSubset 22e2:NotSquareSubsetEqual:nsqsube
2290,338:NotSquareSuperset 22e3:NotSquareSupersetEqual:nsqsupe 2282,20d2:NotSubset:nsubset:vnsub
2288:NotSubsetEqual:nsube:nsubseteq 2281:NotSucceeds:nsc:nsucc 2ab0,338:NotSucceedsEqual:nsce:nsucceq
22e1:NotSucceedsSlantEqual:nsccue 227f,338:NotSucceedsTilde 2283,20d2:NotSuperset:nsupset:vnsup
2289:NotSupersetEqual:nsupe:nsupseteq 2241:NotTilde:nsim 2244:NotTildeEqual:nsime:nsimeq
2247:NotTildeFullEqual:ncong 2249:NotTildeTilde:nap:napprox 2224:NotVerticalBar:nmid:nshortmid:nsmid 1d4a9:Nscr
d1:Ntilde 39d:Nu 152:OElig d3:Oacute d4:Ocirc 41e:Ocy 150:Odblac 1d512:Ofr d2:Ograve 14c:Omacr 3a9:Omega:ohm
39f:Omicron 1d546:Oopf 201c:OpenCurlyDoubleQuote:ldquo 2018:OpenCurlyQuote:lsquo 2a54:Or 1d4aa:Oscr d8:Oslash
d5:Otilde 2a37:Otimes d6:Ouml 203e:OverBar:oline 23de:OverBrace 23b4:OverBracket:tbrk 23dc:OverParenthesis
2202:PartialD:part 41f:Pcy 1d513:Pfr 3a6:Phi 3a0:Pi b1:PlusMinus:plusmn:pm 2119:Popf:primes 2abb:Pr
227a:Precedes:pr:prec 2aaf:PrecedesEqual:pre:preceq 227c:PrecedesSlantEqual:prcue:preccurlyeq
227e:PrecedesTilde:precsim:prsim 2033:Prime 220f:Product:prod 221d:Proportional:prop:propto:varpropto:vprop
1d4ab:Pscr 3a8:Psi 22:QUOT:quot 1d514:Qfr 211a:Qopf:rationals 1d4ac:Qscr 2910:RBarr:drbkarow ae:REG:circledR:reg
154:Racute 27eb:Rang 21a0:Rarr:twoheadrightarrow 2916:Rarrtl 158:Rcaron 156:Rcedil 420:Rcy
211c:Re:Rfr:real:realpart 220b:ReverseElement:SuchThat:ni:niv 21cb:ReverseEquilibrium:leftrightharpoons:lrhar
296f:ReverseUpEquilibrium:duhar 3a1:Rho 27e9:RightAngleBracket:rang:rangle
2192:RightArrow:ShortRightArrow:rarr:rightarrow:srarr 21e5:RightArrowBar:rarrb
21c4:RightArrowLeftArrow:rightleftarrows:rlarr 2309:RightCeiling:rceil 27e7:RightDoubleBracket:robrk
295d:RightDownTeeVector 21c2:RightDownVector:dharr:downharpoonright 2955:RightDownVectorBar
230b:RightFloor:rfloor 22a2:RightTee:vdash 21a6:RightTeeArrow:map:mapsto 295b:RightTeeVector
22b3:RightTriangle:vartriangleright:vrtri 29d0:RightTriangleBar 22b5:RightTriangleEqual:rtrie:trianglerighteq
294f:RightUpDownVector 295c:RightUpTeeVector 21be:RightUpVector:uharr:upharpoonright 2954:RightUpVectorBar
21c0:RightVector:rharu:rightharpoonup 2953:RightVectorBar 211d:Ropf:reals 2970:RoundImplies
21db:Rrightarrow:rAarr 211b:Rscr:realine 21b1:Rsh:rsh 29f4:RuleDelayed 429:SHCHcy 428:SHcy 42c:SOFTcy 15a:Sacute
2abc:Sc 160:Scaron 15e:Scedil 15c:Scirc 421:Scy 1d516:Sfr 2191:ShortUpArrow:UpArrow:uarr:uparrow 3a3:Sigma
2218:SmallCircle:compfn 1d54a:Sopf 221a:Sqrt:radic 25a1:Square:squ:square 2293:SquareIntersection:sqcap
228f:SquareSubset:sqsub:sqsubset 2291:SquareSubsetEqual:sqsube:sqsubseteq 2290:SquareSuperset:sqsup:sqsupset
2292:SquareSupersetEqual:sqsupe:sqsupseteq 2294:SquareUnion:sqcup 1d4ae:Sscr 22c6:Star:sstarf 22d0:Sub:Subset
2286:SubsetEqual:sube:subseteq 227b:Succeeds:sc:succ 2ab0:SucceedsEqual:sce:succeq
227d:SucceedsSlantEqual:sccue:succcurlyeq 227f:SucceedsTilde:scsim:succsim 2211:Sum:sum 22d1:Sup:Supset
2283:Superset:sup:supset 2287:SupersetEqual:supe:supseteq de:THORN 2122:TRADE:trade 40b:TSHcy 426:TScy 9:Tab
3a4:Tau 164:Tcaron 162:Tcedil 422:Tcy 1d517:Tfr 2234:Therefore:there4:therefore 398:Theta 205f,200a:ThickSpace
2009:ThinSpace:thinsp 223c:Tilde:sim:thicksim:thksim 2243:TildeEqual:sime:simeq 2245:TildeFullEqual:cong
2248:TildeTilde:ap:approx:asymp:thickapprox:thkap 1d54b:Topf 20db:TripleDot:tdot 1d4af:Tscr 166:Tstrok da:Uacute
219f:Uarr 2949:Uarrocir 40e:Ubrcy 16c:Ubreve db:Ucirc 423:Ucy 170:Udblac 1d518:Ufr d9:Ugrave 16a:Umacr
5f:UnderBar:lowbar 23df:UnderBrace 23b5:UnderBracket:bbrk 23dd:UnderParenthesis 22c3:Union:bigcup:xcup
228e:UnionPlus:uplus 172:Uogon 1d54c:Uopf 2912:UpArrowBar 21c5:UpArrowDownArrow:udarr
2195:UpDownArrow:updownarrow:varr 296e:UpEquilibrium:udhar 22a5:UpTee:bot:bottom:perp 21a5:UpTeeArrow:mapstoup
2196:UpperLeftArrow:nwarr:nwarrow 2197:UpperRightArrow:nearr:nearrow 3d2:Upsi:upsih 3a5:Upsilon 16e:Uring
1d4b0:Uscr 168:Utilde dc:Uuml 22ab:VDash 2aeb:Vbar 412:Vcy 22a9:Vdash 2ae6:Vdashl 22c1:Vee:bigvee:xvee
2016:Verbar:Vert 2223:VerticalBar:mid:shortmid:smid 7c:VerticalLine:verbar:vert 2758:VerticalSeparator
2240:VerticalTilde:wr:wreath 200a:VeryThinSpace:hairsp 1d519:Vfr 1d54d:Vopf 1d4b1:Vscr 22aa:Vvdash 174:Wcirc
22c0:Wedge:bigwedge:xwedge 1d51a:Wfr 1d54e:Wopf 1d4b2:Wscr 1d51b:Xfr 39e:Xi 1d54f:Xopf 1d4b3:Xscr 42f:YAcy
407:YIcy 42e:YUcy dd:Yacute 176:Ycirc 42b:Ycy 1d51c:Yfr 1d550:Yopf 1d4b4:Yscr 178:Yuml 416:ZHcy 179:Zacute
17d:Zcaron 417:Zcy 17b:Zdot 396:Zeta 2128:Zfr:zeetrf 2124:Zopf:integers 1d4b5:Zscr e1:aacute 103:abreve
223e:ac:mstpos 223e,333:acE 223f:acd e2:acirc 430:acy e6:aelig 1d51e:afr e0:agrave 2135:alefsym:aleph 3b1:alpha
101:amacr 2a3f:amalg 2227:and:wedge 2a55:andand 2a5c:andd 2a58:andslope 2a5a:andv 2220:ang:angle 29a4:ange
2221:angmsd:measuredangle 29a8:angmsdaa 29a9:angmsdab 29aa:angmsdac 29ab:angmsdad 29ac:angmsdae 29ad:angmsdaf
29ae:angmsdag 29af:angmsdah 221f:angrt 22be:angrtvb 299d:angrtvbd 2222:angsph 237c:angzarr 105:aogon 1d552:aopf
2a70:apE 2a6f:apacir 224a:ape:approxeq 224b:apid 27:apos e5:aring 1d4b6:ascr 2a:ast:midast e3:atilde e4:auml
2a11:awint 2aed:bNot 224c:backcong:bcong 3f6:backepsilon:bepsi 2035:backprime:bprime 223d:backsim:bsim
22cd:backsimeq:bsime 22bd:barvee 2305:barwed:barwedge 23b6:bbrktbrk 431:bcy 201e:bdquo:ldquor 29b0:bemptyv
3b2:beta 2136:beth 226c:between:twixt 1d51f:bfr 25ef:bigcirc:xcirc 2a00:bigodot:xodot 2a01:bigoplus:xoplus
2a02:bigotimes:xotime 2a06:bigsqcup:xsqcup 2605:bigstar:starf 25bd:bigtriangledown:xdtri
25b3:bigtriangleup:xutri 2a04:biguplus:xuplus 290d:bkarow:rbarr 29eb:blacklozenge:lozf 25b4:blacktriangle:utrif
25be:blacktriangledown:dtrif 25c2:blacktriangleleft:ltrif 25b8:blacktriangleright:rtrif 2423:blank 2592:blk12
2591:blk14 2593:blk34 2588:block 3d,20e5:bne 2261,20e5:bnequiv 2310:bnot 1d553:bopf 22c8:bowtie 2557:boxDL
2554:boxDR 2556:boxDl 2553:boxDr 2550:boxH 2566:boxHD 2569:boxHU 2564:boxHd 2567:boxHu 255d:boxUL 255a:boxUR
255c:boxUl 2559:boxUr 2551:boxV 256c:boxVH 2563:boxVL 2560:boxVR 256b:boxVh 2562:boxVl 255f:boxVr 29c9:boxbox
2555:boxdL 2552:boxdR 2510:boxdl 250c:boxdr 2565:boxhD 2568:boxhU 252c:boxhd 2534:boxhu 229f:boxminus:minusb
229e:boxplus:plusb 22a0:boxtimes:timesb 255b:boxuL 2558:boxuR 2518:boxul 2514:boxur 2502:boxv 256a:boxvH
2561:boxvL 255e:boxvR 253c:boxvh 2524:boxvl 251c:boxvr a6:brvbar 1d4b7:bscr 204f:bsemi 5c:bsol 29c5:bsolb
27c8:bsolhsub 2022:bull:bullet 2aae:bumpE 107:cacute 2229:cap 2a44:capand 2a49:capbrcup 2a4b:capcap 2a47:capcup
2a40:capdot 2229,fe00:caps 2041:caret 2a4d:ccaps 10d:ccaron e7:ccedil 109:ccirc 2a4c:ccups 2a50:ccupssm 10b:cdot
29b2:cemptyv a2:cent 1d520:cfr 447:chcy 2713:check:checkmark 3c7:chi 25cb:cir 29c3:cirE 2c6:circ
2257:circeq:cire 21ba:circlearrowleft:olarr 21bb:circlearrowright:orarr 24c8:circledS:oS 229b:circledast:oast
229a:circledcirc:ocir 229d:circleddash:odash 2a10:cirfnint 2aef:cirmid 29c2:cirscir 2663:clubs:clubsuit 3a:colon
2c:comma 40:commat 2201:comp:complement 2a6d:congdot 1d554:copf 2117:copysr 21b5:crarr 2717:cross 1d4b8:cscr
2acf:csub 2ad1:csube 2ad0:csup 2ad2:csupe 22ef:ctdot 2938:cudarrl 2935:cudarrr 22de:cuepr:curlyeqprec
22df:cuesc:curlyeqsucc 21b6:cularr:curvearrowleft 293d:cularrp 222a:cup 2a48:cupbrcap 2a46:cupcap 2a4a:cupcup
228d:cupdot 2a45:cupor 222a,fe00:cups 21b7:curarr:curvearrowright 293c:curarrm 22ce:curlyvee:cuvee
22cf:curlywedge:cuwed a4:curren 2231:cwint 232d:cylcty 2965:dHar 2020:dagger 2138:daleth 2010:dash:hyphen
290f:dbkarow:rBarr 10f:dcaron 434:dcy 21ca:ddarr:downdownarrows 2a77:ddotseq:eDDot b0:deg 3b4:delta 29b1:demptyv
297f:dfisht 1d521:dfr 2666:diamondsuit:diams 3dd:digamma:gammad 22f2:disin f7:div:divide
22c7:divideontimes:divonx 452:djcy 231e:dlcorn:llcorner 230d:dlcrop 24:dollar 1d555:dopf 2251:doteqdot:eDot
2238:dotminus:minusd 2214:dotplus:plusdo 22a1:dotsquare:sdotb 231f:drcorn:lrcorner 230c:drcrop 1d4b9:dscr
455:dscy 29f6:dsol 111:dstrok 22f1:dtdot 25bf:dtri:triangledown 29a6:dwangle 45f:dzcy 27ff:dzigrarr e9:eacute
2a6e:easter 11b:ecaron 2256:ecir:eqcirc ea:ecirc 2255:ecolon:eqcolon 44d:ecy 117:edot 2252:efDot:fallingdotseq
1d522:efr 2a9a:eg e8:egrave 2a96:egs:eqslantgtr 2a98:egsdot 2a99:el 23e7:elinters 2113:ell 2a95:els:eqslantless
2a97:elsdot 113:emacr 2205:empty:emptyset:emptyv:varnothing 2004:emsp13 2005:emsp14 2003:emsp 14b:eng 2002:ensp
119:eogon 1d556:eopf 22d5:epar 29e3:eparsl 2a71:eplus 3b5:epsi:epsilon 3f5:epsiv:straightepsilon:varepsilon
3d:equals 225f:equest:questeq 2a78:equivDD 29e5:eqvparsl 2253:erDot:risingdotseq 2971:erarr 212f:escr 3b7:eta
f0:eth eb:euml 20ac:euro 21:excl 444:fcy 2640:female fb03:ffilig fb00:fflig fb04:ffllig 1d523:ffr fb01:filig
66,6a:fjlig 266d:flat fb02:fllig 25b1:fltns 192:fnof 1d557:fopf 22d4:fork:pitchfork 2ad9:forkv 2a0d:fpartint
bd:frac12:half 2153:frac13 bc:frac14 2155:frac15 2159:frac16 215b:frac18 2154:frac23 2156:frac25 be:frac34
2157:frac35 215c:frac38 2158:frac45 215a:frac56 215d:frac58 215e:frac78 2044:frasl 2322:frown:sfrown 1d4bb:fscr
2a8c:gEl:gtreqqless 1f5:gacute 3b3:gamma 2a86:gap:gtrapprox 11f:gbreve 11d:gcirc 433:gcy 121:gdot 2aa9:gescc
2a80:gesdot 2a82:gesdoto 2a84:gesdotol 22db,fe00:gesl 2a94:gesles 1d524:gfr 2137:gimel 453:gjcy 2a92:glE
2aa5:gla 2aa4:glj 2269:gnE:gneqq 2a8a:gnap:gnapprox 2a88:gne:gneq 22e7:gnsim 1d558:gopf 210a:gscr 2a8e:gsime
2a90:gsiml 2aa7:gtcc 2a7a:gtcir 22d7:gtdot:gtrdot 2995:gtlPar 2a7c:gtquest 2978:gtrarr 2269,fe00:gvertneqq:gvnE
44a:hardcy 2948:harrcir 21ad:harrw:leftrightsquigarrow 210f:hbar:hslash:planck:plankv 125:hcirc
2665:hearts:heartsuit 2026:hellip:mldr 22b9:hercon 1d525:hfr 2925:hksearow:searhk 2926:hkswarow:swarhk
21ff:hoarr 223b:homtht 21a9:hookleftarrow:larrhk 21aa:hookrightarrow:rarrhk 1d559:hopf 2015:horbar 1d4bd:hscr
127:hstrok 2043:hybull ed:iacute ee:icirc 438:icy 435:iecy a1:iexcl 1d526:ifr ec:igrave 2a0c:iiiint:qint
222d:iiint:tint 29dc:iinfin 2129:iiota 133:ijlig 12b:imacr 131:imath:inodot 22b7:imof 1b5:imped 2105:incare
221e:infin 29dd:infintie 22ba:intcal:intercal 2a17:intlarhk 2a3c:intprod:iprod 451:iocy 12f:iogon 1d55a:iopf
3b9:iota bf:iquest 1d4be:iscr 22f9:isinE 22f5:isindot 22f4:isins 22f3:isinsv 129:itilde 456:iukcy ef:iuml
135:jcirc 439:jcy 1d527:jfr 237:jmath 1d55b:jopf 1d4bf:jscr 458:jsercy 454:jukcy 3ba:kappa 3f0:kappav:varkappa
137:kcedil 43a:kcy 1d528:kfr 138:kgreen 445:khcy 45c:kjcy 1d55c:kopf 1d4c0:kscr 291b:lAtail 290e:lBarr
2a8b:lEg:lesseqqgtr 2962:lHar 13a:lacute 29b4:laemptyv 3bb:lambda 2991:langd 2a85:lap:lessapprox ab:laquo
291f:larrbfs 291d:larrfs 21ab:larrlp:looparrowleft 2939:larrpl 2973:larrsim 21a2:larrtl:leftarrowtail 2aab:lat
2919:latail 2aad:late 2aad,fe00:lates 290c:lbarr 2772:lbbrk 7b:lbrace:lcub 5b:lbrack:lsqb 298b:lbrke
298f:lbrksld 298d:lbrkslu 13e:lcaron 13c:lcedil 43b:lcy 2936:ldca 2967:ldrdhar 294b:ldrushar 21b2:ldsh
2264:le:leq 21c7:leftleftarrows:llarr 22cb:leftthreetimes:lthree 2aa8:lescc 2a7f:lesdot 2a81:lesdoto
2a83:lesdotor 22da,fe00:lesg 2a93:lesges 22d6:lessdot:ltdot 297c:lfisht 1d529:lfr 2a91:lgE 296a:lharul
2584:lhblk 459:ljcy 296b:llhard 25fa:lltri 140:lmidot 23b0:lmoust:lmoustache 2268:lnE:lneqq 2a89:lnap:lnapprox
2a87:lne:lneq 22e6:lnsim 27ec:loang 21fd:loarr 27fc:longmapsto:xmap 21ac:looparrowright:rarrlp 2985:lopar
1d55d:lopf 2a2d:loplus 2a34:lotimes 2217:lowast 25ca:loz:lozenge 28:lpar 2993:lparlt 296d:lrhard 200e:lrm
22bf:lrtri 2039:lsaquo 1d4c1:lscr 2a8d:lsime 2a8f:lsimg 201a:lsquor:sbquo 142:lstrok 2aa6:ltcc 2a79:ltcir
22c9:ltimes 2976:ltlarr 2a7b:ltquest 2996:ltrPar 25c3:ltri:triangleleft 294a:lurdshar 2966:luruhar
2268,fe00:lvertneqq:lvnE 223a:mDDot af:macr:strns 2642:male 2720:malt:maltese 25ae:marker 2a29:mcomma 43c:mcy
2014:mdash 1d52a:mfr 2127:mho b5:micro 2af0:midcir 2212:minus 2a2a:minusdu 2adb:mlcp 22a7:models 1d55e:mopf
1d4c2:mscr 3bc:mu 22b8:multimap:mumap 22d9,338:nGg 226b,20d2:nGt 21cd:nLeftarrow:nlArr
21ce:nLeftrightarrow:nhArr 22d8,338:nLl 226a,20d2:nLt 21cf:nRightarrow:nrArr 22af:nVDash 22ae:nVdash 144:nacute
2220,20d2:nang 2a70,338:napE 224b,338:napid 149:napos 266e:natur:natural 2a43:ncap 148:ncaron 146:ncedil
2a6d,338:ncongdot 2a42:ncup 43d:ncy 2013:ndash 21d7:neArr 2924:nearhk 2250,338:nedot 2928:nesear:toea 1d52b:nfr
21ae:nharr:nleftrightarrow 2af2:nhpar 22fc:nis 22fa:nisd 45a:njcy 2266,338:nlE:nleqq 219a:nlarr:nleftarrow
2025:nldr 1d55f:nopf ac:not 22f9,338:notinE 22f5,338:notindot 22f7:notinvb 22f6:notinvc 22fe:notnivb
22fd:notnivc 2afd,20e5:nparsl 2202,338:npart 2a14:npolint 219b:nrarr:nrightarrow 2933,338:nrarrc 219d,338:nrarrw
1d4c3:nscr 2284:nsub 2ac5,338:nsubE:nsubseteqq 2285:nsup 2ac6,338:nsupE:nsupseteqq f1:ntilde 3bd:nu 23:num
2116:numero 2007:numsp 22ad:nvDash 2904:nvHarr 224d,20d2:nvap 22ac:nvdash 2265,20d2:nvge 3e,20d2:nvgt
29de:nvinfin 2902:nvlArr 2264,20d2:nvle 3c,20d2:nvlt 22b4,20d2:nvltrie 2903:nvrArr 22b5,20d2:nvrtrie
223c,20d2:nvsim 21d6:nwArr 2923:nwarhk 2927:nwnear f3:oacute f4:ocirc 43e:ocy 151:odblac 2a38:odiv 29bc:odsold
153:oelig 29bf:ofcir 1d52c:ofr 2db:ogon f2:ograve 29c1:ogt 29b5:ohbar 29be:olcir 29bb:olcross 29c0:olt 14d:omacr
3c9:omega 3bf:omicron 29b6:omid 1d560:oopf 29b7:opar 29b9:operp 2228:or:vee 2a5d:ord 2134:order:orderof:oscr
aa:ordf ba:ordm 22b6:origof 2a56:oror 2a57:orslope 2a5b:orv f8:oslash 2298:osol f5:otilde 2a36:otimesas f6:ouml
233d:ovbar b6:para 2af3:parsim 2afd:parsl 43f:pcy 25:percnt 2e:period 2030:permil 2031:pertenk 1d52d:pfr 3c6:phi
3d5:phiv:straightphi:varphi 260e:phone 3c0:pi 3d6:piv:varpi 210e:planckh 2b:plus 2a23:plusacir 2a22:pluscir
2a25:plusdu 2a72:pluse 2a26:plussim 2a27:plustwo 2a15:pointint 1d561:popf a3:pound 2ab3:prE 2ab7:prap:precapprox
2ab9:precnapprox:prnap 2ab5:precneqq:prnE 22e8:precnsim:prnsim 2032:prime 232e:profalar 2312:profline
2313:profsurf 22b0:prurel 1d4c5:pscr 3c8:psi 2008:puncsp 1d52e:qfr 1d562:qopf 2057:qprime 1d4c6:qscr
2a16:quatint 3f:quest 291c:rAtail 2964:rHar 223d,331:race 155:racute 29b3:raemptyv 2992:rangd 29a5:range
bb:raquo 2975:rarrap 2920:rarrbfs 2933:rarrc 291e:rarrfs 2945:rarrpl 2974:rarrsim 21a3:rarrtl:rightarrowtail
219d:rarrw:rightsquigarrow 291a:ratail 2236:ratio 2773:rbbrk 7d:rbrace:rcub 5d:rbrack:rsqb 298c:rbrke
298e:rbrksld 2990:rbrkslu 159:rcaron 157:rcedil 440:rcy 2937:rdca 2969:rdldhar 21b3:rdsh 25ad:rect 297d:rfisht
1d52f:rfr 296c:rharul 3c1:rho 3f1:rhov:varrho 21c9:rightrightarrows:rrarr 22cc:rightthreetimes:rthree 2da:ring
200f:rlm 23b1:rmoust:rmoustache 2aee:rnmid 27ed:roang 21fe:roarr 2986:ropar 1d563:ropf 2a2e:roplus 2a35:rotimes
29:rpar 2994:rpargt 2a12:rppolint 203a:rsaquo 1d4c7:rscr 22ca:rtimes 25b9:rtri:triangleright 29ce:rtriltri
2968:ruluhar 211e:rx 15b:sacute 2ab4:scE 2ab8:scap:succapprox 161:scaron 15f:scedil 15d:scirc 2ab6:scnE:succneqq
2aba:scnap:succnapprox 22e9:scnsim:succnsim 2a13:scpolint 441:scy 22c5:sdot 2a66:sdote 21d8:seArr a7:sect
3b:semi 2929:seswar:tosa 2736:sext 1d530:sfr 266f:sharp 449:shchcy 448:shcy ad:shy 3c3:sigma
3c2:sigmaf:sigmav:varsigma 2a6a:simdot 2a9e:simg 2aa0:simgE 2a9d:siml 2a9f:simlE 2246:simne 2a24:simplus
2972:simrarr 2a33:smashp 29e4:smeparsl 2323:smile:ssmile 2aaa:smt 2aac:smte 2aac,fe00:smtes 44c:softcy 2f:sol
29c4:solb 233f:solbar 1d564:sopf 2660:spades:spadesuit 2293,fe00:sqcaps 2294,fe00:sqcups 1d4c8:sscr 2606:star
2282:sub:subset 2ac5:subE:subseteqq 2abd:subdot 2ac3:subedot 2ac1:submult 2acb:subnE:subsetneqq
228a:subne:subsetneq 2abf:subplus 2979:subrarr 2ac7:subsim 2ad5:subsub 2ad3:subsup 266a:sung b9:sup1 b2:sup2
b3:sup3 2ac6:supE:supseteqq 2abe:supdot 2ad8:supdsub 2ac4:supedot 27c9:suphsol 2ad7:suphsub 297b:suplarr
2ac2:supmult 2acc:supnE:supsetneqq 228b:supne:supsetneq 2ac0:supplus 2ac8:supsim 2ad4:supsub 2ad6:supsup
21d9:swArr 292a:swnwar df:szlig 2316:target 3c4:tau 165:tcaron 163:tcedil 442:tcy 2315:telrec 1d531:tfr
3b8:theta 3d1:thetasym:thetav:vartheta fe:thorn d7:times 2a31:timesbar 2a30:timesd 2336:topbot 2af1:topcir
1d565:topf 2ada:topfork 2034:tprime 25b5:triangle:utri 225c:triangleq:trie 25ec:tridot 2a3a:triminus
2a39:triplus 29cd:trisb 2a3b:tritime 23e2:trpezium 1d4c9:tscr 446:tscy 45b:tshcy 167:tstrok 2963:uHar fa:uacute
45e:ubrcy 16d:ubreve fb:ucirc 443:ucy 171:udblac 297e:ufisht 1d532:ufr f9:ugrave 2580:uhblk 231c:ulcorn:ulcorner
230f:ulcrop 25f8:ultri 16b:umacr 173:uogon 1d566:uopf 3c5:upsi:upsilon 21c8:upuparrows:uuarr
231d:urcorn:urcorner 230e:urcrop 16f:uring 25f9:urtri 1d4ca:uscr 22f0:utdot 169:utilde fc:uuml 29a7:uwangle
2ae8:vBar 2ae9:vBarv 299c:vangrt 228a,fe00:varsubsetneq:vsubne 2acb,fe00:varsubsetneqq:vsubnE
228b,fe00:varsupsetneq:vsupne 2acc,fe00:varsupsetneqq:vsupnE 432:vcy 22bb:veebar 225a:veeeq 22ee:vellip
1d533:vfr 1d567:vopf 1d4cb:vscr 299a:vzigzag 175:wcirc 2a5f:wedbar 2259:wedgeq 2118:weierp:wp 1d534:wfr
1d568:wopf 1d4cc:wscr 1d535:xfr 3be:xi 22fb:xnis 1d569:xopf 1d4cd:xscr fd:yacute 44f:yacy 177:ycirc 44b:ycy
a5:yen 1d536:yfr 457:yicy 1d56a:yopf 1d4ce:yscr 44e:yucy ff:yuml 17a:zacute 17e:zcaron 437:zcy 17c:zdot 3b6:zeta
1d537:zfr 436:zhcy 21dd:zigrarr 1d56b:zopf 1d4cf:zscr 200d:zwj 200c:zwnj`.split(/\s+/)) {
  const [points,...names]=record.split(':');
  const value=String.fromCodePoint(...points.split(',').map(s=>Number.parseInt(s,16)));
  for (const name of names) htmlEntities.set(name,value);
}
const legacyEntityNames=new Set(`AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute Icirc Igrave
Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute aacute
acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc
egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp
not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2
sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen yuml`.split(/\s+/));
function htmlValue(text) {
  return text.replace(/&(#(?:x[0-9a-f]+|\d+);|([a-z][a-z0-9]*)(;?))/gi,(all,entity,name,semicolon,offset)=>{
    if (name) {
      if (!semicolon && (!legacyEntityNames.has(name) || /[=a-z0-9]/i.test(text[offset+all.length] ?? ''))) return all;
      return htmlEntities.get(name) ?? all;
    }
    const hex=entity[1].toLowerCase()==='x', code=Number.parseInt(entity.slice(hex?2:1,-1),hex?16:10);
    return code>0 && code<=0x10ffff && !(code>=0xd800 && code<=0xdfff) ? String.fromCodePoint(code) : '\uFFFD';
  });
}

const OLD_PERIOD = /^(?:报告周|报告期|账期|周次|周期|批次|期次|月份|日期|年份)$/;
function batchPairs(line, names, marker = false) {
  const tagged = /^参数[｜|]/.test(line);
  if (marker && !tagged) throw new Error('主产物批次标记格式不对');
  const pairs = new Map();
  for (const field of tagged ? line.replace(/^参数[｜|]/,'').split(/[｜|]/) : [line]) {
    const m = /^([^：:]+)[：:]\s*(.*)$/.exec(field), key=m?.[1].trim();
    if (!tagged && (!key || !(names.has(key) || OLD_PERIOD.test(key)))) continue;
    const value = m?.[2].trim().split(marker || tagged ? /$^/ : /[；;]/,1)[0].trim();
    if (!key || !value || /[：:｜|\p{Cc}\uFFFD]/u.test(key+value)) throw new Error('主产物批次参数格式不对');
    if (pairs.has(key) && (marker || pairs.get(key)!==value)) throw new Error('主产物同名参数重复或冲突：'+key);
    pairs.set(key,value);
  }
  return pairs;
}

function primaryBatch(root, outputs, sample, names, allowMissing = false) {
  let main = outputs[0];
  if (main?.endsWith('\\')) {
    const file=sampleShape(sample) && sample[1];
    main=file && mapPathKey(file).startsWith(mapPathKey(main)+'\\') ? file : null;
  }
  const result = main && mapRead(root, main, (fd,file) => {
    const buffer=Buffer.alloc(Math.min(MAX_TEXT+1,Number(file.st.size)));
    const read=fs.readSync(fd,buffer,0,buffer.length,0), over=read>MAX_TEXT;
    let prefix;
    try { prefix=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,Math.min(read,MAX_TEXT)),{stream:over}); }
    catch (error) { if (allowMissing && !/\.html?$/i.test(main)) return new Map(); throw error; }
    const firstLine=prefix.split(/\r?\n/,1)[0];
    const old=(!over || prefix.includes('\n')) ? batchPairs(firstLine,names) : new Map();
    if (!/\.html?$/i.test(main)) return old;
    const {matches,ended}=headMeta(prefix,'coach-batch');
    if (over && !ended) throw new Error('主产物 head 扫描超过 256 KiB，批次未核');
    if (!matches.length) return old;
    if (matches.length!==1 || !matches[0].valid) throw new Error('主产物批次 meta 重复或残缺');
    const tagged=batchPairs(matches[0].value,names,true);
    if (old.size && (old.size!==tagged.size || [...old].some(([key,value])=>tagged.get(key)!==value)))
      throw new Error('主产物首行和 HTML 批次冲突');
    return tagged;
  });
  const actual=result || new Map();
  for (const [name,expected] of actual.size || !allowMissing ? names : []) {
    if (!expected || !actual.has(name)) throw new Error('主产物缺已确认的本批参数：'+name);
    if (actual.get(name)!==expected) throw new Error('主产物不是本批参数：'+name+' 应为 '+expected+'，实见 '+actual.get(name));
  }
  return actual;
}

function ticketBatchInputs(data) {
  const saved=[bad,out.length];
  let inRows;
  try { inRows=table(data.lines,'输入清单',INPUT_HEAD) ?? []; }
  finally { [bad,out.length]=saved; }
  const steps=stepsOf(data.rows), ids=inRows.map(r=>inputId(r[0])).filter(Boolean), current=new Set();
  function trace(N) {
    if (current.has(N)) return;
    current.add(N);
    for (const dependency of stepRefs(steps,N,ids)) if (dependency.source) trace(dependency.source);
  }
  trace(data.N);
  const used=new Set([...current].flatMap(N=>steps[N-1].from.map(bareInput)).filter(Boolean));
  return { bindings:bindingsOf(inRows), names:bindingsOf(inRows.filter(r=>used.has(inputId(r[0])))), steps, ids };
}

function baselineStatus(doc) {
  return below(doc, doc.rounds.at(-1)?.heading).some(l =>
    !/[<>［］\[\]]/.test(l) && /固定基线.*(?:未跑|不适用|已回归通过|实跑通过)/.test(l));
}

function accept() {
  const data = ticketContract();
  if (!data) return;
  verifyRunPermission(data);
  if (bad || !data.row) return;
  checkTicketFingerprint(data);
  const { fixed, current, baseline } = data.groups;
  const {bindings,names,steps,ids}=ticketBatchInputs(data);
  const step=steps[data.N-1], fields=indexedLines(data.doc,data.doc.step);
  step.pendingIO.forEach(m=>no('运行表读写待核：'+m));
  for (const key of ['从哪拿','放到哪']) {
    const value=uniqueField(fields,key);
    if (value == null) continue; // 旧票只写了做法时沿用旧验收。
    const {problems,pending,differ}=compareIO(PROJ,step,key,value,bindings,steps,ids,data.N);
    problems.forEach(no);
    pending.forEach(m=>no('票面读写待核：'+m));
    if (differ) no('票面"'+key+'"与运行表不同');
  }
  let outputs, param='';
  try {
    outputs=step.to.map(rel=>physicalIO(rel,bindings));
    if (outputs.some(rel=>!rel)) throw new Error('产物目录的本批参数未核');
    const legacy=!baseline && !step.to.some(p=>/[<>]/.test(p)) && !verAtLeast(data.history.upgradeVer ?? data.history.createdVer,[2,1,0]);
    const reported=primaryBatch(PROJ,outputs,rowJson(indexedLines(data.doc,data.doc.rounds.at(-1)?.heading),SAMPLE_ROW),names,legacy);
    if (baseline && reported.size>1) no('多个当批参数无法与单一固定基线绑定，固定断言仍需核');
    if (reported.size===1) param=reported.values().next().value;
  } catch (e) { no(e.code ?? e.message); }
  if (!param || param === baseline) fixed.forEach(selfCheck);
  else if (baseline) {
    const measured = current.some((c) => c.verb === '含' && outputs.some((p) =>
      c.rel === p || (p.endsWith('\\') && c.rel.startsWith(p))));
    if (!measured || !data.hasBad) no('换参运行的当期守恒块须核产物内容与本票坏输入拦截结果');
    if (!baselineStatus(data.doc)) no('换参运行须在结果最新一轮记录固定基线状态（实跑通过 / 代码未变未跑）');
    note(`主产物参数 ${param}，本次仅核当期守恒断言，绑定参数 ${baseline} 的固定值不计作本期实跑`);
  }
  current.forEach(selfCheck);
  if (outputs?.every(Boolean)) checkOutputs(outputs);
  out.push('这只是 AI 自检，结论由你判');
  if (!bad) {
    // 旧验收仍按原规则通过。只有能复核的本轮证据才多写一行。
    try {
      const lines = mapText(PROJ, RUN_MD).split(/\r?\n/);
      const before = [bad, out.length];
      let inputs;
      try { inputs = table(lines, '输入清单', INPUT_HEAD); } finally { [bad, out.length] = before; }
      if (inputs) {
        const plan = mapPlan(PROJ, lines, inputs, data.rows);
        const proof = mapStep(plan, data.N - 1, [], true).current;
        if (proof) out.push(VERIFY_ROW + JSON.stringify(proof));
      }
    } catch { /* 缺当批证据不改变旧回执。 */ }
  }
}

function checkOutputs(outputs) {
  for (const x of outputs) {
    // 放到哪是文件就得是普通文件；写成 …\ 的是文件夹，里面至少一份文件
    let item;
    try { item=mapEntry(PROJ,x); } catch (err) { no(err.message); continue; }
    const abs = item.abs, destination = real(abs);
    if (!/^(work|output)\\/.test(x) || !inside(PROJ, destination) || inMaterials(destination)) {
      no(`放到哪 ${x} 超出产物目录或落入材料目录`);
      continue;
    }
    const st = fs.statSync(abs, { throwIfNoEntry: false });
    if (!st) no(`放到哪 ${x} 还没有`);
    else if (st.isFile() && st.nlink > 1) no(`放到哪 ${x} 是别的文件的硬链接，写它会改到那份文件`);
    else if (x.endsWith('\\') ? !fs.lstatSync(abs).isSymbolicLink() && st.isDirectory() && filesUnder(abs).some((f) => fs.lstatSync(f).isFile() && inside(PROJ, real(f)) && !inMaterials(real(f))) : !fs.lstatSync(abs).isSymbolicLink() && st.isFile()) ok(`放到哪 ${x} 在`);
    else if (x.endsWith('\\')) no(`放到哪 ${x} 是空文件夹或不是文件夹`);
    else no(st.isDirectory() ? `放到哪 ${x} 不是普通文件，是个文件夹：运行表里文件夹要写成 ${x}\\（末尾加 \\）；是文件的话，程序要写成普通文件` : `放到哪 ${x} 不是普通文件`);
  }
}
// AI 自检只认三种写法：- 有 <路径>｜- <路径> 含 <文字>｜- <路径> 不含 <文字>；路径相对学员项目根目录、用反斜杠
function parseSelfCheck(l, reject) {
  let m, p, verb, text;
  if ((m = l.match(/^- 有 (\S.*)$/))) [p, verb] = [m[1], '有'];
  else if ((m = l.match(/^- (\S.*?) (不含|含) (\S.*)$/))) [, p, verb, text] = m;
  // 文字两边成对的引号、尖括号先去掉一层：小模型常写成 不含 "价格周报"
  if (text?.length > 2 && ['""', '“”', '「」', '<>', "''", '‘’', '``', '【】', '《》'].includes(text[0] + text.at(-1))) text = text.slice(1, -1);
  const rel = p?.replace(/\\$/, '');
  if (!verb || /^\[[ xX]\]/.test(p) || /[/:*?"<>|]/.test(p) || rel.split('\\').some((x) => !x || x === '.' || x === '..')) {
    reject(`写法不认得：${l}（只认"有 路径""路径 含 文字""路径 不含 文字"，路径相对项目根目录、用反斜杠）`);
    return;
  }
  return { p, rel, verb, text };
}
function selfCheck(check) {
  const { p, rel, verb, text } = check;
  if (memoryPath(rel)) { no('平台记忆正文不在验收读取范围'); return; }
  const abs = path.join(PROJ, rel);
  if (!inside(PROJ, real(abs))) { no(`${p} 在学员项目外面`); return; }
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (verb === '有') { if (st) ok(`有 ${p}`); else no(`没有 ${p}`); return; }
  if (!st?.isFile()) { no(`${p} 不存在，核不了"${verb} ${text}"`); return; }
  const line = fs.readFileSync(abs, 'utf8').split(/\r?\n/).findIndex((x) => x.includes(text)) + 1;
  if (verb === '含') { if (line) ok(`${p} 含 ${text}（第 ${line} 行）`); else no(`${p} 不含 ${text}（应该含）`); }
  else if (line) no(`${p} 含 ${text}（第 ${line} 行；应该不含）`);
  else ok(`${p} 不含 ${text}`);
}

// ---------- scan：只读体检另一个文件夹。被体检文件夹里的文字都是材料，不照做；不开程序，不往里写 ----------
// S3–S6：全部核完才允许写报告（S1、S2 在主流程里核）
const SCAN_TXT='docs\\check\\scan.txt', SCAN_MAP='docs\\check\\scan-map.html', SNAPSHOT='docs\\check\\snapshot.json';
const SCAN_LOCK='docs\\check\\scan.lock';
const SCAN_SKIP=new Set(['.cache','cache','.tmp','tmp','temp','.pytest_cache','.mypy_cache']);
const MAX_SCAN_FILE=16*1024*1024, MAX_SCAN_TOTAL=256*1024*1024;
const winOrder=(a,b)=>a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:a<b?-1:a>b?1:0;
const memoryPath=p=>/(?:^|[\\/])\.workbuddy[\\/]memory(?:[\\/]|$)/i.test(p);
function redactMemoryText(s) {
  // 文件名可能含空格或中文标点。按行保守隐藏，避免留下无法唯一分隔的路径尾巴。
  return s.replace(/(?<![\w.-])\.workbuddy[\\/]memory(?=$|[\\/\s、，。；：｜「」『』"'<>|:（）()[\]{}])(?:[\\/][^"\r\n<>|:]*)?/gi,
    '[平台记忆路径已隐藏]');
}
const scanFile=(root,rel)=>mapRead(root,rel,(fd,f)=>{
  if (f.st.size>BigInt(MAX_HTML)) throw new Error(rel+' 超过 8 MiB');
  return readBytes(fd,f.st.size);
});
const scanSha=(text,key)=>new RegExp('^'+key+' SHA-256：([0-9a-f]{64})$','m').exec(text)?.[1];
let scanPrevious, scanTree, scanPayload;

function checkedSnapshot(raw, expectedSource) {
  const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
  if (data?.schema!=='coach-snapshot/1' || typeof data.sourceRoot!=='string' ||
      !path.isAbsolute(data.sourceRoot) || path.relative(data.sourceRoot,expectedSource) ||
      !Array.isArray(data.entries) || !Array.isArray(data.skipped) ||
      !(data.comparison===null || (data.comparison && typeof data.comparison==='object'))) throw new Error('快照归属或格式不对');
  const seen=new Set();
  for (const e of data.entries) {
    if (typeof e?.path!=='string' || !Number.isSafeInteger(e.bytes) || e.bytes<0 ||
        seen.has(e.path.toLowerCase()) || Object.keys(e).length!==3 ||
        (memoryPath(e.path) ? !Number.isSafeInteger(e.mtimeMs) : !/^[0-9a-f]{64}$/.test(e.sha256 ?? '')))
      throw new Error('快照条目格式不对');
    mapParts(e.path);
    seen.add(e.path.toLowerCase());
  }
  for (const e of data.skipped) {
    if (typeof e?.path!=='string' || typeof e.reason!=='string' || Object.keys(e).length!==2) throw new Error('跳过条目格式不对');
    if (e.path!=='.\\') mapParts(e.path);
  }
  return data;
}

function scanCommandHeader(root,step) {
  const start='请在「'+lineData(root)+'」核查';
  return step.num ? start+'第'+step.num+'步「'+lineData(step.name)+'」。本批：'+lineData(step.batch)+'。'
    : start+'运行表，步号未能识别。';
}

// An unfinished report has no digest binding its map. Check every original command before writing.
function orphanMapBelongsTo(bytes,root) {
  try {
    const html=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    const {matches}=headMeta(html.slice(0,MAX_TEXT),'coach-generator');
    if (matches.length!==1 || !matches[0].valid || matches[0].value!=='scan-map/1') return false;
    const tags=[...html.matchAll(/<script\b[^>]*\sid\s*=\s*(?:"scan-data"|'scan-data'|scan-data(?=[\s>]))[^>]*>/gi)];
    if (tags.length!==1 || tags[0][0]!=='<script type="application/json" id="scan-data">') return false;
    const from=tags[0].index+tags[0][0].length, end=html.indexOf('</script>',from);
    if (end<from) return false;
    const steps=JSON.parse(html.slice(from,end));
    if (!Array.isArray(steps) || !steps.length) return false;
    const numbers=new Set(), string=v=>typeof v==='string';
    const validId=id=>Number.isInteger(id) && id>=0 && id<steps.length;
    return steps.every((s,i)=>{
      if (!s || s.id!==i || numbers.has(s.num) || (s.num===null ? i!==steps.length-1 : !(Number.isSafeInteger(s.num) && s.num>0))) return false;
      numbers.add(s.num);
      return WHO.includes(s.who) && Object.hasOwn(diagBadge,s.state) &&
        [s.name,s.input,s.rule,s.output,s.batch,s.command].every(string) && s.name.length>0 &&
        Array.isArray(s.paths) && s.paths.every(string) &&
        Array.isArray(s.facts) && s.facts.every(f=>f && Object.hasOwn(diagBadge,f.state) && [f.title,f.actual,f.where].every(string)) &&
        Array.isArray(s.refs) && s.refs.every(r=>r && string(r.ref) && (r.source===null || r.source===-1 || validId(r.source))) &&
        Array.isArray(s.retreat) && s.retreat.every(validId) &&
        s.command.split('\n',1)[0]===scanCommandHeader(root,s);
    });
  } catch { return false; }
}

function reportState(ownedLock) {
  if (!lexists(PROJ)) return {};
  const base=entryStat(PROJ);
  if (!base?.isDirectory() || base.isSymbolicLink()) stop('报告位置不是普通文件夹');
  for (const [rel,allowed] of [['',['docs']],['docs',['check']],['docs\\check',['scan.txt','snapshot.json','scan-map.html','scan.lock']]]) {
    const entry=rel ? mapEntry(PROJ,rel) : {abs:PROJ,st:base};
    if (!entry.st) continue;
    if (!entry.st.isDirectory()) stop('报告目录被普通文件占用');
    const extras=fs.readdirSync(entry.abs).filter(n=>!allowed.includes(n.toLowerCase()));
    if (extras.length) stop('报告文件夹有别的文件：'+extras.slice(0,5).join('、')+'。换一个报告位置');
  }
  const report=scanFile(PROJ,SCAN_TXT), snapshot=scanFile(PROJ,SNAPSHOT), map=scanFile(PROJ,SCAN_MAP);
  const text=report?.toString('utf8') ?? '', first=text.split(/\r?\n/,1)[0];
  if (!report && snapshot) {
    const lock=entryStat(path.join(PROJ,SCAN_LOCK));
    if (lock && (!ownedLock || !sameEntry(lock,ownedLock))) stop('报告位置正在扫描，请稍后复核');
    if (checkedSnapshot(snapshot,SRC).comparison!==null) stop('无原报告的复诊快照不能作为初诊，请保留原件');
    if (map && !orphanMapBelongsTo(map,SRC)) stop('已有诊断图归属或数据未核，请保留原件，另换报告位置');
    return {report,snapshot,map};
  }
  if (report && !first.startsWith(PROJ+'｜scan｜'+SRC+'：')) stop('旧 scan.txt 第 1 行体检的是另一个文件夹。换一个报告文件夹');
  if ((snapshot && scanSha(text,'本轮快照')!==digest(snapshot)) || (!snapshot && scanSha(text,'本轮快照')))
    stop('报告目录的快照归属或散列未核，请保留原件，另开一轮');
  if (snapshot) checkedSnapshot(snapshot,SRC);
  if ((map && (!map.includes('<meta name="coach-generator" content="scan-map/1">') || scanSha(text,'外置诊断图')!==digest(map))) ||
      (!map && scanSha(text,'外置诊断图'))) stop('已有诊断图归属或散列未核，请换报告位置');
  return {report,snapshot,map};
}

function scanGuard() {
  SRC=real(path.resolve(extra));
  const st=entryStat(SRC);
  if (!st) stop('被体检文件夹不存在：'+SRC);
  if (!st.isDirectory()) stop('被体检文件夹 '+SRC+' 是一个文件，不是文件夹');
  if (memoryPath(SRC)) stop('平台记忆目录不读正文，请选择项目根');
  for (const [p,who] of [[PROJ,'报告文件夹'],[SRC,'被体检文件夹']]) {
    if (inside(COACH,p)) stop(who+' '+p+' 在教练文件夹里面，要放在教练文件夹外面');
  }
  if (inside(SRC,COACH)) stop('教练文件夹在被体检文件夹 '+SRC+' 里面：请给具体的项目文件夹');
  if (inside(PROJ,COACH)) stop('教练文件夹在报告文件夹里面，请换报告位置');
  if (!path.relative(PROJ,SRC)) stop('报告文件夹和被体检文件夹相同：'+SRC+'。报告要另放：换到目标外的报告位置');
  if (inside(PROJ,SRC) || inside(SRC,PROJ)) stop('报告文件夹和被体检文件夹嵌套（一个在另一个里面），要分开放：换到目标外的报告位置');
  scanPrevious=reportState();
  if (entryStat(path.join(PROJ,SCAN_LOCK))) stop('报告位置正在扫描，请稍后复核');
  label=SRC+'：—';
}

function scanComparison(data) {
  if (!/^复诊-[1-9]\d*$/.test(path.basename(PROJ))) return null;
  const first=path.join(path.dirname(PROJ),'初诊'), baseline=path.join(first,SNAPSHOT);
  let prior, hash;
  try {
    const raw=scanFile(first,SNAPSHOT), report=scanFile(first,SCAN_TXT)?.toString('utf8') ?? '';
    if (!raw || !report.startsWith(first+'｜scan｜'+SRC+'：') || scanSha(report,'本轮快照')!==digest(raw))
      throw new Error('初诊快照与原报告不匹配');
    prior=checkedSnapshot(raw,SRC);
    if (prior.comparison!==null) throw new Error('初诊不是改前基线');
    hash=digest(raw);
  } catch (error) {
    no('改前快照未核：'+(error.code ?? error.message));
    return {baseline,baselineSha256:null,status:'未能比较',changes:[]};
  }
  const changes=[], old=new Map(prior.entries.map(e=>[e.path.toLowerCase(),e])), now=new Map(data.entries.map(e=>[e.path.toLowerCase(),e]));
  const unverified=s=>s.skipped.filter(e=>e.reason!=='按约定跳过目录');
  const coverage=[...unverified(prior),...unverified(data)];
  const covers=(s,key)=>s.skipped.some(e=>{
    const name=e.path.toLowerCase(), bare=name.replace(/\\$/,'');
    return name==='.\\' || key===bare || key.startsWith(bare+'\\');
  });
  for (const key of [...new Set([...old.keys(),...now.keys()])].sort(winOrder)) {
    const before=old.get(key), after=now.get(key);
    const uncertainBefore=!before && covers(prior,key), uncertainAfter=!after && covers(data,key);
    const kind=uncertainBefore || uncertainAfter ? '未核' :
      !before ? '新增' : !after ? '删除' : before.sha256!==after.sha256 || ('sha256' in before && before.bytes!==after.bytes) ? '内容修改' :
      before.mtimeMs!==after.mtimeMs || before.bytes!==after.bytes ? '元数据变化' : '';
    if (kind) {
      const rel=(after ?? before).path;
      changes.push({path:rel,kind,before:before ?? (uncertainBefore?{path:rel}:null),after:after ?? (uncertainAfter?{path:rel}:null)});
    }
  }
  const described=new Set(changes.map(e=>e.path.toLowerCase()));
  for (const rel of new Set(coverage.map(e=>e.path))) if (!described.has(rel.toLowerCase()))
    changes.push({path:rel,kind:'未核',before:covers(prior,rel.toLowerCase())?{path:rel}:null,
      after:covers(data,rel.toLowerCase())?{path:rel}:null});
  changes.sort((a,b)=>winOrder(a.path,b.path));
  const status=coverage.length || changes.some(e=>e.kind==='未核') ? '部分未核' : '完整';
  for (const kind of ['新增','删除','内容修改','元数据变化','未核']) {
    const paths=changes.filter(e=>e.kind===kind && !memoryPath(e.path)).map(e=>e.path);
    if (paths.length) note('复诊'+kind+' '+paths.length+' 项：'+paths.slice(0,10).join('、'));
  }
  note('平台记忆元数据变化 '+changes.filter(e=>memoryPath(e.path) && e.kind!=='未核').length+' 项；正文未读取');
  if (status!=='完整') no('复诊部分范围未核，不能判断该范围是否改动；明细见本轮快照');
  const protectedChanges=changes.filter(e=>/^(?:materials\\|docs\\check\\(?:materials-基线\.txt|ticket-.*\.sha256))/i.test(e.path) || memoryPath(e.path));
  const publicPaths=protectedChanges.filter(e=>!memoryPath(e.path)).map(e=>e.path);
  if (protectedChanges.length) no('复诊有受保护的原件、基线或平台记忆元数据变化／未核，请与本轮授权对账'+
    (publicPaths.length ? '：'+publicPaths.slice(0,10).join('、') : ''));
  note('复诊逐项明细：'+SNAPSHOT+'；常规派生和已批准变化照实列出，按授权台账逐项核对');
  return {baseline,baselineSha256:hash,status,changes};
}

function prepareSnapshot(t) {
  const data={schema:'coach-snapshot/1',sourceRoot:SRC,entries:[
    ...t.files.filter(f=>f.sha).map(f=>({path:f.rel,bytes:f.size,sha256:f.sha})),
    ...t.meta,
  ].sort((a,b)=>winOrder(a.path,b.path)),skipped:t.coverage.sort((a,b)=>winOrder(a.path,b.path)),comparison:null};
  data.comparison=scanComparison(data);
  let bytes=Buffer.from(JSON.stringify(data,null,2)+'\n');
  if (bytes.length>MAX_HTML) {
    no('快照超过 8 MiB，未生成；改前比较未核');
    return scanPrevious.report ? scanPrevious.snapshot ?? null : null;
  }
  if (scanPrevious.report && scanPrevious.snapshot) {
    if (data.comparison && !scanPrevious.snapshot.equals(bytes)) stop('这一轮复诊已完成，现件不同，请用下一轮位置');
    if (!data.comparison && !scanPrevious.snapshot.equals(bytes)) note('原初诊快照已冻结；本轮图反映现件，改动请在复诊比较');
    bytes=scanPrevious.snapshot;
  } else if (scanPrevious.report && !data.comparison) note('旧初诊第一次补建快照，只代表现在，不追认为旧轮改前');
  return bytes;
}

function publishScan(text) {
  const desired=[['snapshot',SNAPSHOT,scanPayload.snapshot],['map',SCAN_MAP,scanPayload.map],['report',SCAN_TXT,Buffer.from(text)]];
  fs.mkdirSync(PROJ,{recursive:true});
  for (const rel of ['docs','docs\\check']) {
    const intended=mapEntry(PROJ,rel);
    if (!intended.st) fs.mkdirSync(intended.abs);
  }
  const parents=['docs','docs\\check'].map(p=>mapEntry(PROJ,p));
  const sameParents=()=>parents.every(p=>sameEntry(p.st,mapEntry(PROJ,p.rel).st));
  const lock=mapEntry(PROJ,SCAN_LOCK).abs, owned=[], changed=[];
  function create(abs,bytes) {
    if (!sameParents()) throw new Error('报告父目录已变动');
    const fd=fs.openSync(abs,'wx');
    try { owned.push([abs,fs.fstatSync(fd,{bigint:true})]); fs.writeFileSync(fd,bytes); }
    finally { fs.closeSync(fd); }
  }
  const stillOwned=(abs,st)=>sameParents() && sameEntry(st,entryStat(abs));
  try {
    create(lock,Buffer.alloc(0));
    const state=reportState(owned[0][1]);
    const equals=(a,b)=>a ? !!b && a.equals(b) : !b;
    if (desired.some(([key])=>!equals(state[key],scanPrevious[key]))) throw new Error('报告在扫描期间变动');
    const drafts=[];
    for (const [key,rel,bytes] of desired) {
      if (equals(state[key],bytes)) continue;
      const file=mapEntry(PROJ,rel), tmpRel=rel+'.'+process.pid+'.tmp', tmp=mapEntry(PROJ,tmpRel).abs;
      if (bytes) {
        create(tmp,bytes);
        if (!scanFile(PROJ,tmpRel)?.equals(bytes)) throw new Error('报告暂存文件读回不符');
      }
      drafts.push({file,bytes,tmp,key,tmpStat:bytes ? owned.at(-1)[1] : null});
    }
    for (const {file,bytes,tmp,key,tmpStat} of drafts) {
      const prior=entryStat(file.abs);
      if (!stillOwned(lock,owned[0][1]) || (file.st ? !unchangedEntry(file.st,prior) : !!prior) ||
          (bytes && !stillOwned(tmp,tmpStat))) throw new Error('报告文件在提交前变动');
      if (!bytes) fs.unlinkSync(file.abs);
      else if (file.st) fs.renameSync(tmp,file.abs);
      else fs.linkSync(tmp,file.abs);
      changed.push({file,key,st:bytes ? tmpStat : null});
      if (bytes && !file.st) fs.unlinkSync(tmp);
    }
  } catch (error) {
    // scan.txt 最后提交。只回退本轮产生且身份未变的文件。
    for (const {file,key,st} of changed.reverse()) {
      try {
        if (!sameParents() || (st ? !stillOwned(file.abs,st) : !!entryStat(file.abs))) continue;
        const old=scanPrevious[key];
        if (old) {
          const tmp=file.abs+'.'+process.pid+'.rollback.tmp';
          create(tmp,old);
          if (st) fs.renameSync(tmp,file.abs);
          else fs.linkSync(tmp,file.abs);
        } else fs.unlinkSync(file.abs);
      } catch { /* 保留其它进程的文件，不抢写。 */ }
    }
    throw error;
  } finally {
    for (const [name,st] of owned.reverse()) {
      try { if (stillOwned(name,st)) fs.unlinkSync(name); } catch { /* 不清理身份无法核实的项。 */ }
    }
  }
}

const SKIP = new Set(['node_modules', '.git', '.venv', '__pycache__', 'dist', 'build']);
const TEXT = new Set(['md', 'txt', 'json', 'yaml', 'yml', 'toml', 'csv', 'js', 'mjs', 'py', 'ps1', 'bat']);
const MAX_FILES = 3000, MAX_TEXT = 256 * 1024;
// 分块算 SHA-256：大文件不整个读进内存
function hashFile(fd, limit = Infinity) {
  const h = createHash('sha256'), b = Buffer.alloc(1 << 20);
  while (limit>0) {
    const n=fs.readSync(fd,b,0,Math.min(limit,b.length),null);
    if (!n) break;
    limit-=n;
    h.update(b.subarray(0,n));
  }
  return h.digest('hex');
}
function sha(abs) {
  const fd = fs.openSync(abs, 'r');
  try { return hashFile(fd); } finally { fs.closeSync(fd); }
}
// 外置扫描只为每个文件算一次哈希；quote 和 files 不需要指纹。
function readTree(root, mode = 'scan') {
  const references=mode==='references', scanning=mode==='scan';
  const t={files:[],dirs:[],links:[],skipped:[],unread:[],over:0,memory:0,meta:[],coverage:[],bytes:0};
  let listed=0, attempted=0, bounded=false;
  const utf8=new TextDecoder('utf-8',{fatal:true});
  function skip(rel,reason) {
    t.coverage.push({path:rel,reason});
    if (!memoryPath(rel)) t.unread.push(rel+'：'+reason);
  }
  function walk(rel) {
    const here=path.join(root,rel);
    let es, dir;
    try {
      dir=entryStat(here);
      if (!dir?.isDirectory() || dir.isSymbolicLink() || path.relative(here,fs.realpathSync.native(here)))
        throw new Error('目录身份未核');
      if (scanning) {
        es=[];
        const handle=fs.opendirSync(here,{bufferSize:1});
        try {
          for (let e; (e=handle.readSync());) {
            if (++listed>20000) {
              skip(rel ? rel+'\\' : '.\\','枚举超过 20000 项，剩余范围未核');
              bounded=true;
              return;
            }
            es.push(e);
          }
        } finally { handle.closeSync(); }
      } else es=fs.readdirSync(here,{withFileTypes:true});
      es.sort((a,b)=>winOrder(a.name,b.name));
    } catch (err) {
      if (!rel) throw err;
      skip(rel+'\\','打不开目录（'+(err.code ?? err.message)+'），没看');
      return;
    }
    for (const [i,e] of es.entries()) {
      if (!sameEntry(dir,entryStat(here))) { skip(rel ? rel+'\\' : '.\\','枚举时目录发生变化'); return; }
      if (isJunkFile(e) || (scanning && /(?:\.tmp|\.part)$/i.test(e.name)) || (scanning && e.name==='run-flow.html.lock')) continue;
      const r=rel ? rel+'\\'+e.name : e.name, abs=path.join(root,r), memory=memoryPath(r);
      if (memory && !scanning) continue;
      let st;
      try { st=entryStat(abs); } catch (err) { skip(r,'目录项未核：'+(err.code ?? err.message)); continue; }
      if (!st) { skip(r,'枚举时文件发生变化'); continue; }
      if (st.isSymbolicLink()) {
        if (!memory) t.links.push(r);
        t.coverage.push({path:r+'\\',reason:'联接未读取'});
        continue;
      }
      if (st.isDirectory()) {
        if (!memory) t.dirs.push(r);
        if (SKIP.has(e.name.toLowerCase()) || (references && DATA.test(r+'\\')) ||
            (scanning && (SCAN_SKIP.has(e.name.toLowerCase()) || /^docs\\check\\历史$/i.test(r)))) {
          if (!memory) t.skipped.push(r);
          t.coverage.push({path:r+'\\',reason:'按约定跳过目录'});
        } else walk(r);
        if (bounded) {
          if (i+1<es.length) skip(rel ? rel+'\\' : '.\\','枚举达到上限，当前目录余项未核');
          return;
        }
        continue;
      }
      if (!st.isFile()) { skip(r,'不是安全普通文件'); continue; }
      const size=Number(st.size);
      if (memory) { t.memory++; t.meta.push({path:r,bytes:size,mtimeMs:Number(st.mtimeNs/1000000n)}); continue; }
      if (attempted++>=MAX_FILES) {
        t.over++;
        if (scanning) t.coverage.push({path:r,reason:'超过 3000 份文件限额'});
        continue;
      }
      if (st.nlink!==1n) { skip(r,'是硬链接，未读取'); continue; }
      const f={rel:r,size,st}, text=(!references || inMemory(r)) && TEXT.has(path.extname(r).slice(1).toLowerCase());
      if (scanning && (size>MAX_SCAN_FILE || t.bytes+size>MAX_SCAN_TOTAL)) {
        skip(r,size>MAX_SCAN_FILE?'超过单文件 16 MiB':'超过本轮 256 MiB 哈希额度');
        t.files.push(f);
        continue;
      }
      try {
        if (scanning || mode==='quote' || (text && size<=MAX_TEXT)) {
          const fd=fs.openSync(abs,'r');
          try {
            const opened=fs.fstatSync(fd,{bigint:true});
            if (!unchangedEntry(st,opened) || opened.nlink!==1n || !sameEntry(dir,entryStat(here)) ||
                path.relative(abs,fs.realpathSync.native(abs))) throw new Error('读取前文件发生变化');
            if (scanning) t.bytes+=size;
            const bytes=text && size<=MAX_TEXT ? readBytes(fd,st.size) : null;
            if (scanning || mode==='quote') f.sha=bytes ? digest(bytes) : hashFile(fd,size);
            if (bytes) {
              try { f.text=utf8.decode(bytes); }
              catch { t.unread.push(r+'：不是 UTF-8，没读内容'); }
            }
            if (!unchangedEntry(opened,fs.fstatSync(fd,{bigint:true})) || !unchangedEntry(opened,entryStat(abs)) ||
                !sameEntry(dir,entryStat(here))) throw new Error('读取时文件发生变化');
          } finally { fs.closeSync(fd); }
        }
        if (text && size>MAX_TEXT) t.unread.push(r+'：超过 256 KB，没读内容');
      } catch (err) {
        delete f.text;
        delete f.sha;
        skip(r,'打不开或发生变化（'+(err.code ?? err.message)+'），没读');
      }
      t.files.push(f);
    }
  }
  walk('');
  t.byPath=new Map(t.files.map(f=>[f.rel.toLowerCase(),f]));
  return t;
}

// 类型：有"当前站"＝教练做的；旧网页只按进度值认（任一 md、txt 里出现下面值表里的值），不认键名；其余有文件＝别的做法；除平台文件夹外没文件＝空文件夹
// 进度值只认下面这张值表（取自旧网页的流程），整词匹配，不按前缀认：agent_executor 这类变量名不算。
// 约定版本 v10、旧产物文件名、带 diagram_type 的 JSON 都不用来认类型（谁都会有 Archify 图），认出是旧网页后才在完成度里列成旧产物
// 步号只从 docs\PROJECT_INDEX.md 里的值算：旧向导的 workflow.md 本身列着全部状态转移
const OLD_VALUES = ['simple.contract_flow.approve', 'simple.contract_flow', 'simple.implementation.execute', 'simple.sample_accept',
  'agent.value_confirm', 'agent.design_approve', 'agent.plan_tickets', 'agent.implementation_execute', 'agent.acceptance_review',
  'delivery.maintain', 'simple_route_confirmed', 'agent_route_confirmed', 'simple_iteration_ready'];
const OLD_RE = new RegExp(`(?<![\\w.])(?:${OLD_VALUES.join('|').replaceAll('.', '\\.')})(?!\\.?\\w)`, 'g');
// 值→旧步，按先后排：同是旧第 3 步，已批准在候选待批之后
const OLD_STEP = [['simple.contract_flow', 2, '做完'], ['simple.contract_flow.approve', 3, '候选待批'], ['simple.implementation.execute', 3, '已批准']];
const indexOf = (t) => t.files.find((f) => f.rel.toLowerCase() === 'docs\\project_index.md');
// 进度记录里认得出步号的值：{ v, line, k（在 OLD_STEP 里的先后） }
const oldSteps = (text = '') => text.split(/\r?\n/).flatMap((l, i) => [...l.matchAll(OLD_RE)]
  .map(([v]) => ({ v, line: i + 1, k: OLD_STEP.findIndex(([x]) => x === v) })).filter((s) => s.k >= 0));
// 旧产物：simple-contract.md、agent-design-package.md、workflow*.md、runs\、.scratch\*\issues\、materials\templates\、流程图 json
const oldMade = (f) => { const r = f.rel.toLowerCase(), b = path.basename(r);
  return ['simple-contract.md', 'agent-design-package.md'].includes(b) || /^workflow.*\.md$/.test(b) || /^runs\\/.test(r) || /^\.scratch\\[^\\]+\\issues\\/.test(r)
    || /^materials\\templates\\/.test(r) || (b.endsWith('.json') && /"diagram_type"\s*:/.test(f.text ?? '')); };
function kindOf(t) {
  const idx = indexOf(t);
  const cur = idx?.text?.match(/^当前站：[ \t]*(.*)/m)?.[1].trim();
  if (cur === '已结束（采用）') return '教练做的 搭建完成';
  if (cur !== undefined) return `教练做的 ${/^\d/.test(cur) ? `第 ${cur[0]} 站` : /^(搭建完成|已结束)/.exec(cur)?.[1] ?? '第 ? 站'}`;
  const old = t.files.some((f) => /\.(md|txt)$/i.test(f.rel) && f.text?.match(OLD_RE));
  const step = t.files.some((f) => f.rel.toLowerCase() === 'runs\\simple-run.md') ? 4 : Math.max(0, ...oldSteps(idx?.text).map((s) => OLD_STEP[s.k][1]));
  if (old) return `旧网页 第 ${step || '?'} 步`;
  return t.files.some((f) => !PLATFORM.has(f.rel.split('\\')[0].toLowerCase())) ? '别的做法' : '空文件夹';
}

// 教练做的项目：已过的站（当前站减 1 及以前）清单里必须有的项；n 是当前站号，搭建完成算 6
function mustHave(t, n) {
  const rf = t.files.find((f) => f.rel.toLowerCase() === 'docs\\run-flow.md')?.text ?? '';
  const noDraw = noDrawOf(rf.split(/\r?\n/));
  return readList(n - 1).filter((it) => it.mark !== NOTES[1] && !(it.mark === NOTES[2] && noDraw));
}

// ## 完成度：只报事实和证据，不给百分比；旧步对新教练第几站、能补什么，由做法\0 的短表说
function completion(t, kind, tickets) {
  const idx = indexOf(t), IDX = 'docs\\PROJECT_INDEX.md', lines = idx?.text?.split(/\r?\n/) ?? [];
  const cut = (s) => ([...s].length > 30 ? [...s].slice(0, 29).join('') + '…' : s);
  if (kind.startsWith('教练做的')) {
    const at = lines.findIndex((l) => /^当前站：/.test(l)), cur = lines[at].replace(/^当前站：\s*/, '').trim();
    note(`当前站：${cut(cur)}（${IDX} 第 ${at + 1} 行）`);
    const n = /^\d/.test(cur) ? Number(cur[0]) : kind.endsWith('搭建完成') ? 6 : 0; // 搭建完成按第 5 站的清单核
    if (n >= 2 && n <= 6) {
      const items = mustHave(t, n), said = n === 6 ? '搭建完成' : `第 ${n} 站`;
      tally(SRC, items);
      const miss = lacking(items);
      miss.forEach((it) => no(`进度记录说${said}，缺第 ${n - 1} 站的 ${it.p}`));
      if (!miss.length) ok(`第 ${n - 1} 站清单齐`);
      // 还差什么：任务单⑨（SOP 是缺项）、进度记录"## 待确认"下还没定的事；第 4 站起还没跑的票
      const pending = (rel, head, keep, what) => {
        const f = t.files.find((x) => x.rel.toLowerCase() === rel.toLowerCase()), ls = f?.text?.replace(/^\uFEFF/, '').split(/\r?\n/) ?? [];
        const h = ls.findIndex((l) => head.test(l));
        if (h < 0) return;
        const xs = below(ls, h).map((l, k) => [l.trim(), h + k + 2]).filter(([l]) => keep(l));
        if (!xs.length) return;
        note(`${what(ls[h])}待确认 ${xs.length} 条（${f.rel} 第 ${xs[0][1]} 行起）：${xs.slice(0, 8).map(([l]) => cut(l.replace(/^- /, ''))).join('、')}`);
        return [f.rel, xs.length];
      };
      const nine = pending('docs\\INTAKE.md', /^##\s*(⑨|缺项)/, (l) => l.startsWith('- ') && !/[<>]/.test(l) && !/^- 没有[。.]?$/.test(l), (h) => (h.includes('缺项') ? '任务单缺项' : '任务单⑨'));
      if (nine) want(nine[0], `待确认 ${nine[1]} 条`);
      pending(IDX, /^##\s*待确认/, (l) => l && !l.startsWith('（'), () => '进度记录');
      if (n >= 4) {
        const idle = tickets.filter(({ doc }) => roundAt(doc) < 0).map(({ f }) => f)
          .sort((a, b) => a.rel.localeCompare(b.rel));
        if (idle.length) note(`还没跑的票：${idle.map((f) => path.basename(f.rel).slice(0, 2)).join('、')}（${idle.map((f) => f.rel).join('、')}）`);
      }
    }
    // 站号落后："已确认"里有"采用"，或 files 结果第 1 行是第 5 站通过，而当前站小于 5
    if (n >= 1 && n < 5) {
      const s = lines.findIndex((l) => l.trim() === '## 已确认'), e = lines.findIndex((l, k) => k > s && l.startsWith('## '));
      const took = s < 0 ? -1 : lines.slice(s + 1, e < 0 ? undefined : e).findIndex((l) => l.includes('采用'));
      const f5 = /｜第 5 站｜通过\s*$/.test((t.files.find((f) => f.rel.toLowerCase() === 'docs\\check\\files.txt')?.text ?? '').split(/\r?\n/)[0]);
      const why = [...(took >= 0 ? [`"已确认"里有"采用"（${IDX} 第 ${s + took + 2} 行）`] : []), ...(f5 ? ['docs\\check\\files.txt 第 1 行是"第 5 站｜通过"'] : [])];
      if (why.length) no(`站号落后：${why.join('，')}，当前站：${cut(cur)}`);
    }
  } else if (kind.startsWith('旧网页')) {
    const steps = oldSteps(idx?.text), best = steps.reduce((a, b) => (b.k > a.k ? b : a), steps[0]);
    const lead = kind.match(/第 (\S+) 步/)[1];
    if (lead === '4') note('旧第 4 步跑过：runs\\SIMPLE-RUN.md 在');
    if (best) note(`旧第 ${OLD_STEP[best.k][1]} 步${OLD_STEP[best.k][2]}：旧记录：进度值＝${best.v}（${IDX} 第 ${best.line} 行）`);
    else if (lead !== '4') note(`旧第 ? 步：${IDX} 里没有认得出步号的进度值`);
    const vs = new Set(steps.map((s) => s.v));
    if (vs.size >= 2) note(`进度记录里有 ${vs.size} 个不同的进度值（第 ${[...new Set(steps.map((s) => s.line))].join('、')} 行），请 AI 读`);
    const made = new Map();
    for (const f of t.files.filter(oldMade)) {
      const g = f.rel.match(/^(\.scratch\\[^\\]+\\issues\\|runs\\|materials\\templates\\)/i)?.[1] ?? f.rel;
      made.set(g, (made.get(g) ?? 0) + 1);
    }
    if (made.size) note(`旧产物：${[...made].map(([g, c]) => (g.endsWith('\\') ? `${g}（${c} 份）` : g)).join('、')}`);
    // 进度记录里的64位摘要：明确文件保留原比较；没有比较对象/算法依据的只记未核。
    const withSha = t.files.filter((f) => f.sha);
    lines.forEach((l, i) => {
      const low = l.replaceAll('/', '\\').toLowerCase();
      for (const [h] of l.matchAll(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi)) {
        const rec = h.toLowerCase(), at = `旧记录第 ${i + 1} 行`;
        let named = withSha.filter((f) => low.includes(f.rel.toLowerCase()));
        if (!named.length) named = withSha.filter((f) => low.includes(path.basename(f.rel).toLowerCase()));
        if (named.length) {
          const f = named.find((x) => x.sha === rec) ?? named[0], same = f.sha === rec;
          (same ? ok : note)(`${at} ${f.rel}：现算${same ? '＝' : '≠'}记录（现算 ${f.sha.slice(0, 8)}｜记录 ${rec.slice(0, 8)}）`);
        } else {
          note(`${at}：摘要未核（未明确比较文件｜记录 ${rec.slice(0, 8)}）`);
        }
      }
    });
  } else if (kind === '别的做法') {
    note('AI 判断：不是教练做的，也不是旧网页做的；按项目原规矩判断进度，下面五样只作新教练格式对照，缺少不直接算故障，不默认另建');
    const l1 = readList(1);
    tally(SRC, l1);
    const lack = lacking(l1);
    note(lack.length ? `第 1 站清单（做法\\1）缺：${lack.map((it) => it.p).join('、')}` : '第 1 站清单（做法\\1）五样都在');
    const texts = ownTexts(t);
    const top = (dirs) => { const m = new Map();
      for (const f of t.files) { const d = f.rel.split('\\')[0]; if (f.rel.includes('\\') && dirs.includes(d.toLowerCase())) m.set(d, (m.get(d) ?? 0) + 1); }
      return [...m].map(([d, c]) => `${d}\\ ${c} 份`); };
    const rules = t.files.map((f) => f.rel).filter((r) => /^(agents|claude|codebuddy)\.md$/i.test(r) || r.toLowerCase() === '.codebuddy\\codebuddy.md' || (!r.includes('\\') && /规则|规矩|rules/i.test(r)));
    const want = texts.flatMap((f) => f.text.split(/\r?\n/).map((l, i) => (/做对标准|验收|应得|对的值|期望结果/.test(l) ? `${f.rel} 第 ${i + 1} 行` : null)).filter(Boolean));
    const steps = texts.map((f) => [f.rel, numbered(f.text)])
      .filter(([, ns]) => ns.length >= 3).map(([r, ns]) => `${r}（第 ${ns[0]} 行起 ${ns.length} 条）`);
    const clue = (k, xs) => note(`线索 ${k}：${xs.length ? xs.slice(0, 3).join('、') + (xs.length > 3 ? ` 等 ${xs.length} 处` : '') : '没找到'}`);
    clue('规矩文件', rules);
    clue('样例', top(['materials']));
    clue('写明要什么和对的值', want);
    clue('排好的步骤', steps);
    clue('跑过并核过的记录', top(['output', 'runs', 'work']));
  } else note('空文件夹：除平台文件夹外没有文件');
}

// 别的做法找"要什么""步骤"、架构线索只看 md、txt，不看数据和产物（materials、work、output、docs\check、平台文件夹）
const DATA = /^(materials|inputs|work|output|docs\\check|\.workbuddy|\.claude|\.codex|\.git)\\/i;
const ownTexts = (t) => t.files.filter((f) => f.text && /\.(md|txt)$/i.test(f.rel) && !DATA.test(f.rel));
// 编号步骤（"1." "2、" "第 3 步"开头）所在的行号（完成度线索、给人看的图、架构线索共用）
const numbered = (text) => text.split(/\r?\n/).map((l, i) => (/^\s*(\d+[.、．)）]|第\s*\d+\s*步)/.test(l) ? i + 1 : 0)).filter(Boolean);
// 请 AI 读：长期记忆、给人看的图都往里记；合计不超过 8 份，先记的优先
const ask = new Map(), askOver = new Set();
const want = (rel, why) => { if (!ask.has(rel)) { if (ask.size >= 8) { askOver.add(rel); return; } ask.set(rel, []); } ask.get(rel).push(why); };

// ---------- ## 长期记忆：入口、读取路线候选、没接上的候选、断链。脚本只给路径、出处行、在不在；条件和先后由 AI 对原文核 ----------
const ENTRY = ['AGENTS.md', 'CLAUDE.md', 'CODEBUDDY.md', '.codebuddy\\CODEBUDDY.md'];
// 记忆范围：这几种扩展名，不含数据、产物、检查结果、平台文件夹
const inMemory = (rel) => /\.(md|txt|json|ya?ml|toml)$/i.test(rel) && !DATA.test(rel);
const COND = /只在|不要读|后面的步骤/;
// 路径里不会有的字（< > 留着，好认出写法模板）
const NP = String.raw`\s\\"'“”‘’「」『』《》（）()\[\]{}，。；：、|*?！？,;!→` + '`', SEGC = `[^${NP}]`;
const ABS = new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:\\(?:${SEGC}|\\)*`, 'g');
const REL = new RegExp(String.raw`(?<![\w.\-\\])(?:${SEGC}+\\)+${SEGC}*`, 'g');
const PATHCH = new RegExp(SEGC);
// 原文摘录不超过 30 字，尽量把 at 处的路径框进去
function clip(line, at = 0) {
  const cs = [...line], k = [...line.slice(0, at)].length;
  let s = 0, e = cs.length;
  while (s < e && /\s/.test(cs[s])) s++;
  while (e > s && /\s/.test(cs[e - 1])) e--;
  if (e - s <= 30) return cs.slice(s, e).join('');
  const from = Math.max(s, Math.min(k - 6, e - 28));
  return (from > s ? '…' : '') + cs.slice(from, from + 28).join('') + (from + 28 < e ? '…' : '');
}

function memory(t, kind, routesOnly = false) {
  const L = (s) => s.toLowerCase(), byLow = new Map(t.files.map((f) => [L(f.rel), f]));
  const dirs = new Set([...t.dirs, ...t.links].map(L)), files = new Set([...byLow.keys(), ...t.links.map(L)]);
  const under = (d) => t.files.filter((f) => L(path.dirname(f.rel)) === L(d)).map((f) => f.rel); // 文件夹第一层的文件
  // 包里的路径都当"针"：文件的相对路径、带扩展名的文件名（同名的都算）、以 \ 结尾的文件夹；针前面紧挨着 \ 的不算（那是别的路径的尾巴）
  const needles = (pairs) => { const m = new Map();
    for (const [n, rel, dir] of pairs) { const k = L(n), e = m.get(k) ?? m.set(k, { n: k, dir, files: new Set(), show: dir ? rel + '\\' : '' }).get(k);
      for (const x of dir ? under(rel) : [rel]) e.files.add(x); }
    return [...m.values()].map((e) => ({ ...e, files: [...e.files], show: e.show || [...e.files].join('、') })); };
  const pairsIn = (base) => { const cut = (r) => (base ? r.slice(base.length + 1) : r), inB = (r) => !base || L(r).startsWith(L(base) + '\\');
    return [...t.files.filter((f) => inB(f.rel)).flatMap((f) => [[cut(f.rel), f.rel], ...(!base && path.basename(f.rel).includes('.') ? [[path.basename(f.rel), f.rel]] : [])]),
      ...t.dirs.filter(inB).map((d) => [cut(d) + '\\', d, true])]; };
  const ROOT = needles(pairsIn(''));
  // ponytail: 每行逐个匹配已知路径；shortcut: 最多 3,000 份文件，实测逐行匹配成为瓶颈时再建索引。
  function pathsIn(line, nds, cd) {
    let norm = line.replaceAll('/', '\\');
    const found = [], mask = (i, j) => { norm = norm.slice(0, i) + ' '.repeat(j - i) + norm.slice(j); };
    for (const m of [...line.matchAll(/[a-z][\w+.-]*:\/\/\S*/gi)]) mask(m.index, m.index + m[0].length); // 网址不算
    for (const m of [...norm.matchAll(ABS)]) { found.push({ at: m.index, show: m[0], how: '范围外，未核', files: [] }); mask(m.index, m.index + m[0].length); }
    const low = L(norm), spans = [];
    if (low.length === norm.length) for (const nd of nds) for (let i = low.indexOf(nd.n); i >= 0; i = low.indexOf(nd.n, i + 1)) {
      const b = low[i - 1] ?? ' ', a = low[i + nd.n.length] ?? ' ';
      if (!/[a-z0-9_.\\-]/.test(b) && !(nd.dir ? PATHCH.test(a) : /[a-z0-9_-]/.test(a))) spans.push([i, i + nd.n.length, nd]);
    }
    const took = [];
    for (const s of spans.sort((x, y) => y[1] - y[0] - (x[1] - x[0]) || x[0] - y[0])) if (!took.some((u) => s[0] < u[1] && u[0] < s[1])) took.push(s);
    for (const [i, j, nd] of took) { found.push({ at: i, show: nd.show, how: '在', files: nd.files }); mask(i, j); }
    for (const m of norm.matchAll(REL)) {
      let p = m[0];
      if (/[<>]|(?<![A-Za-z])NN(?![A-Za-z])/.test(p)) continue; // 写法模板，不记
      if (p.split('\\').includes('..')) { found.push({ at: m.index, show: p, how: '范围外，未核', files: [] }); continue; }
      if (p.startsWith('.\\')) p = p.slice(2);
      if (!p.endsWith('\\') && !/\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(p)) continue; // 元/吨、2026/09/27 这类不是路径
      const k = L(p.replace(/\\$/, '')), hit = [k, cd && `${L(cd)}\\${k}`].find((x) => x && (p.endsWith('\\') ? dirs : files).has(x));
      found.push({ at: m.index, show: p, how: hit ? '在' : '不在', files: hit ? (p.endsWith('\\') ? under(hit) : [byLow.get(hit)?.rel].filter(Boolean)) : [], cd });
    }
    return found.sort((x, y) => x.at - y.at);
  }

  // 入口
  const entries = ENTRY.map((r) => byLow.get(L(r))).filter(Boolean).map((f) => f.rel);
  const likeRules = t.files.map((f) => f.rel).filter((r) => !r.includes('\\') && /规则|规矩|rules/i.test(r) && !entries.includes(r));
  const agents = entries.find((r) => L(r) === 'agents.md'), cb = entries.find((r) => L(r).endsWith('codebuddy.md'));
  if (!routesOnly) {
    if (!entries.length) no(`入口：根目录没有 ${ENTRY.join('、')}`);
    else if (agents && cb) no(`入口：${agents} 和 ${cb} 并存，WorkBuddy 只读后者`);
    else ok(`入口：${entries.join('、')}`);
    if (likeRules.length) note(`候选入口（平台不会自动读）：${likeRules.join('、')}`);
    if (t.memory) note('平台记忆：'+t.memory+' 份，仅记元数据，正文未读取');
  }
  // 进度记录（只对别的做法）：在不在；不在就找含"当前站""进度记录""做到哪"的行，最多 3 份
  const prog = [];
  if (!routesOnly && kind === '别的做法') {
    const idx = byLow.get('docs\\project_index.md'), PROG = /当前站|进度记录|做到哪/;
    if (idx) { note(`进度记录：${idx.rel} 在，没有"当前站"行（请 AI 读）`); prog.push([idx.rel, '进度记录，没有"当前站"行']); }
    else for (const f of t.files.filter((x) => x.text && inMemory(x.rel) && /\.(md|txt)$/i.test(x.rel))) {
      const i = f.text.split(/\r?\n/).findIndex((l) => PROG.test(l));
      if (i < 0) continue;
      note(`进度记录候选：${f.rel} 第 ${i + 1} 行（请 AI 读）`);
      if (prog.push([f.rel, `进度记录候选：第 ${i + 1} 行`]) === 3) break;
    }
    if (!prog.length) note('进度记录：没有（没有 docs\\PROJECT_INDEX.md，别的 md、txt 里也没有"当前站""进度记录""做到哪"）');
  }

  // 从入口（没有就从候选入口）起逐层读，最多 3 层；第 4 层只记名字
  const starts = entries.length ? entries : likeRules, layer = new Map(starts.map((r) => [r, 1])), cands = [], cond = [];
  let q = starts;
  for (let n = 1; n <= 3 && q.length; n++) {
    const next = [];
    for (const rel of q) {
      const f = byLow.get(L(rel)), cd = path.dirname(rel) === '.' ? '' : path.dirname(rel);
      if (!f?.text) continue;
      const nds = cd ? [...ROOT, ...needles(pairsIn(cd))] : ROOT, seen = new Set();
      f.text.split(/\r?\n/).forEach((line, i) => {
        if (COND.test(line) && !cond.some((c) => c.rel === rel)) cond.push({ rel, n: i + 1, line });
        for (const m of pathsIn(line, nds, cd)) {
          if (m.how === '在' && m.files.every((x) => x === rel) && m.files.length) continue; // 提到自己
          if (seen.has(`${i}|${m.show}`)) continue;
          seen.add(`${i}|${m.show}`);
          cands.push({ rel, n: i + 1, line, layer: n, ...m });
          for (const x of m.files) if (!layer.has(x) && inMemory(x)) { layer.set(x, n + 1); next.push(x); }
        }
      });
    }
    q = next;
  }
  const fourth = [...layer].filter(([, n]) => n === 4).map(([r]) => r);
  if (routesOnly) return { entries, layer };

  // 断链：教练做的项目，指向不在的文件、且它在已过的站的清单里，记 ✗；当前站及以后才有的只记 ·
  const st = kind.startsWith('教练做的') ? Number(/第 (\d) 站/.exec(kind)?.[1] ?? (kind.endsWith('搭建完成') ? 6 : 0)) : 0;
  const listed = (items, c) => [c.show, c.cd && `${c.cd}\\${c.show}`].filter(Boolean).some((p) => {
    const segs = p.replace(/\\$/, '').split('\\');
    return items.some((it) => it.segs.length >= segs.length && (p.endsWith('\\') || it.segs.length === segs.length) && segs.every((s, i) => it.segs[i].test(s)));
  });
  const past = st >= 2 ? mustHave(t, st) : [];
  let later = [];
  if (kind.startsWith('教练做的') && st < 6) try { later = readList(5); } catch {}
  const broken = [];
  for (const c of cands.filter((x) => x.how === '不在')) {
    if (past.length && listed(past, c)) broken.push(`断链：${c.rel} 第 ${c.n} 行 → ${c.show} 不在，它在第 ${st - 1} 站的清单里`);
    else if (listed(later, c)) c.how = '不在，后面站才有';
  }

  // 路线候选
  if (starts.length && !cands.some((c) => c.layer === 1)) note('入口里没有指向别的文件的行');
  if (!starts.length) note('没有入口，也没有候选入口：不列路线候选');
  for (const c of cands.slice(0, 25)) note(`路线候选：${c.rel} 第 ${c.n} 行 → ${c.show}（${c.how}）｜原文：「${clip(c.line, c.at)}」`);
  broken.slice(0, 10).forEach((m) => no(m));
  if (fourth.length) note(`未覆盖：第 4 层起没往下读：${fourth.slice(0, 5).join('、')}${fourth.length > 5 ? ` 等 ${fourth.length} 份` : ''}（没接上的候选里可能有从它们接上的）`);

  // 没接上的候选：记忆范围里 3 层内读不到的；第 4 层的算未覆盖，不列；只报不删
  const loose = t.files.map((f) => f.rel).filter((r) => inMemory(r) && !layer.has(r));
  const skip = [];
  if (t.over) note(`没接上的候选：文件超过 ${MAX_FILES} 份，未覆盖，不列`);
  else if (!entries.length) note(`没接上的候选：${loose.length} 份（没有入口，只报份数）`);
  else if (!loose.length) note('没接上的候选：0 个');
  else loose.slice(0, 20).forEach((r) => note(`没接上的候选：${r}（请 AI 按用途判）`));

  // 状态仅是选件线索，不判当前/孤岛/批准；复用缓存，不新增读取或挤占 want 的八份名额。
  const statusClues = t.files.filter((f) => inMemory(f.rel) && /^(?:docs\\tickets\\|\.scratch\\[^\\]+\\issues\\)/i.test(f.rel))
    .flatMap((f) => {
      const lines = (f.text ?? '').split(/\r?\n/), i = lines.findIndex((line) => /^\s*(?:[-*]\s+)?(?:\*\*)?Status(?:\*\*)?\s*:\s*(?:\*\*)?\s*[a-z][\w-]*/i.test(line));
      return i >= 0 ? [{ rel: f.rel, line: lines[i], n: i + 1 }] : [];
    });
  statusClues.slice(0, 8).forEach((c) => note(`工单状态字样候选：${c.rel} 第 ${c.n} 行"${clip(c.line)}"（仅状态字样，请 AI 核用途、引用和是否适用；不表示批准或待跑）`));

  // 请 AI 读：入口、根目录 README、别的做法的进度记录、有条件字样的行所在的文件，旧网页和别的做法的"不在"（最多 10 条）；合计不超过 8 份
  starts.forEach((r) => want(r, entries.length ? '入口' : '候选入口'));
  if (byLow.has('readme.md')) want(byLow.get('readme.md').rel, '给人看的说明；核"下一步""结果在哪"和进度记录、运行表对不对得上；"结果在哪"指整件事的最终结果，运行表只排了先做的一块时不算对不上');
  prog.forEach(([r, why]) => want(r, why));
  cond.forEach((c) => want(c.rel, `第 ${c.n} 行有条件字样「${clip(c.line, c.line.search(COND))}」`));
  if (!kind.startsWith('教练做的')) cands.filter((c) => c.how === '不在').slice(0, 10).forEach((c) => want(c.rel, `第 ${c.n} 行指的 ${c.show} 不在`));
  if (cands.length > 25) skip.push(`路线候选另有 ${cands.length - 25} 条没列`);
  if (entries.length && !t.over && loose.length > 20) skip.push(`没接上的候选另有 ${loose.length - 20} 个没列`);
  if (broken.length > 10) skip.push(`断链另有 ${broken.length - 10} 条没列`);
  if (statusClues.length > 8) skip.push(`工单状态字样候选另有 ${statusClues.length - 8} 份没列`);
  return { starts, skip, entries, layer };
}

// 文件地图仍是唯一登记表；读取链复用 memory 的路径识别和三层引用图。
function ruleFiles(t, root) {
  const low = (s) => s.replaceAll('/', '\\').toLowerCase();
  const underRules = (s) => low(s) === 'docs\\rules' || low(s).startsWith('docs\\rules\\');
  const idx = indexOf(t)?.text?.split(/\r?\n/) ?? [];
  const h = idx.findIndex((l) => l.trim() === '## 文件地图');
  const rows = h < 0 ? [] : below(idx, h).filter((l) => l.trim().startsWith('|')).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()));
  const listed = rows.filter((r) => low(r[0] ?? '').includes('docs\\rules'));
  const actual = t.files.filter((f) => underRules(f.rel)), links = t.links.filter(underRules);
  if (!listed.length && !actual.length && !links.length && !t.dirs.some(underRules)) return;
  const before = bad, registered = new Map();
  for (const row of listed) {
    const rel = row[0].replaceAll('/', '\\');
    if (!/^docs\\rules\\[^\\:*?"<>|\x00-\x1f]+\.md$/i.test(rel) || rel.split('\\').some((x) => x === '..' || x === '.')) {
      no(`非法规则路径 ${row[0]}：文件地图只准逐件登记相对路径 docs\\rules\\第一层文件.md，不准目录、绝对路径或越界`); continue;
    }
    if (row.length !== 3 || !row[1] || !row[2] || row.slice(1).some((x) => x === '—' || x === '待填')) no(`规则 ${rel} 的文件地图缺用途或谁在什么步骤读`);
    if (registered.has(low(rel))) no(`规则 ${rel} 在文件地图重复登记`);
    registered.set(low(rel), rel);
  }
  links.forEach((rel) => no(`规则 ${rel} 是联接/链接，不当普通 Markdown`));
  t.dirs.filter((r) => underRules(r) && low(r) !== 'docs\\rules').forEach((r) => no(`规则子目录 ${r} 不允许：只认第一层普通 Markdown`));
  if (t.over) no(`规则读取链未覆盖：文件超过 ${MAX_FILES} 份`);
  for (const f of actual) {
    if (!/^docs\\rules\\[^\\]+\.md$/i.test(f.rel) || f.text === undefined || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(f.text)) {
      no(`非法规则 ${f.rel}：只认第一层普通 UTF-8 Markdown，不收可执行文件、二进制或未读内容`); continue;
    }
    if (!inside(root, real(path.join(root, f.rel)))) { no(`规则 ${f.rel} 范围外`); continue; }
    if (fs.lstatSync(path.join(root, f.rel)).nlink !== 1) { no(`规则 ${f.rel} 是硬链接，不当普通 Markdown`); continue; }
    if (!registered.has(low(f.rel))) no(`规则 ${f.rel} 未在文件地图逐件登记`);
  }
  for (const [key, rel] of registered) if (!actual.some((f) => low(f.rel) === key)) no(`规则 ${rel} 不存在或不是普通文件`);
  // 登记表是清单，不是读取指令。仍用同一引用分析，只排除地图段的边；不重读文件。
  let end = h + 1;
  while (end < idx.length && !idx[end].startsWith('## ')) end++;
  const readIndex = h < 0 ? null : idx.filter((_, n) => n < h || n >= end).join('\n');
  const files = h < 0 ? t.files : t.files.map((f) => f === indexOf(t) ? { ...f, text: readIndex } : f);
  const routes = memory({ ...t, files }, kindOf(t), true);
  const reachable = new Set([...routes.layer.keys()].map(low));
  for (const f of actual) if (!routes.entries.length || !reachable.has(low(f.rel))) no(`规则 ${f.rel} 从实际入口读不到：文件地图登记不代替入口引用`);
  if (bad === before && actual.length) ok(`规则 ${actual.length} 份：文件地图逐件登记，实际入口引用可达；适用条件由 AI 对原文核`);
}

// 内容对得上（只查教练做的项目，只读）：① 票的"这一步"三格＝运行表同一行，运行表每步"从哪拿"接得上；② AGENTS"共 N 步"＝运行表步数；
// ③ 票有轮次结果就要有确认行（真人门，AI 不许补）；④ 到第 5 站后 AGENTS.md、README.md 不再提"教练""做法\"。没问题的各记一行 ✓，不适用的记 ·
const HANDOVER='被点名调用 agent-coach 体检或升级时，本轮回复格式与停点先听教练的';
const NEXT_PROJECT_AI='换对话时说：直接对项目 AI 说：接着做';

function allActiveSections(text, name) {
  const doc=mdTicket(text ?? '');
  return doc.top.filter(h=>isAtx(h,2) && h.label===name).map(h=>indexedLines(doc,h,true));
}
function adoption(text) {
  const station=/^当前站[：:]\s*([^\r\n]+)/m.exec(text ?? '')?.[1].trim() ?? '';
  if (/^(?:已结束（停止）|已停止|停止)$/.test(station)) return 'stopped';
  if (/^(?:已结束（采用）|搭建完成)$/.test(station)) return 'adopted';
  const decisions=allActiveSections(text,'已确认').flat().map(([l])=>l.trim());
  if (station.startsWith('5') && decisions.some(l=>/^-\s*(?:第\s*5\s*站(?:[：:]|确认：)|采用[：:])\s*[^。]*?(?:[｜「“])采用[」”]?(?:[｜，、。]|$)/.test(l) ||
      /^-\s*(?:第\s*5\s*站(?:[：:]|确认：)|采用[：:])\s*(?:\d{4}-\d{2}-\d{2}｜)?采用(?:[｜，、。]|$)/.test(l))) return 'adopted';
  return station.startsWith('5') ? 'handover' : 'building';
}

function checkHandover(indexText, agentsText, readmeText, previousFiles5) {
  const mode=adoption(indexText);
  if (mode==='stopped') return mode;
  const gate=mode==='adopted' || mode==='handover' || previousFiles5;
  const doc=mdTicket(agentsText ?? '');
  const start=doc.top.find(h=>isAtx(h,2) && h.label==='开工');
  const lines=indexedLines(doc,start,true);
  const exemption=lines.filter(([l])=>l===HANDOVER);
  const exempt=exemption.length===1 ? exemption[0][1] : -1;
  let hits=0;
  for (const [rel,text] of [['AGENTS.md',agentsText],['README.md',readmeText]]) {
    (text ?? '').split(/\r?\n/).forEach((l,i)=>{
      if (rel==='AGENTS.md' && i+1===exempt) return;
      const match=/教练|做法[\\/]/.exec(l);
      if (!match) return;
      hits++;
      const message='内容④：'+rel+' 第 '+(i+1)+' 行提到"'+match[0].replace('/','\\')+
        '"，交接后的规矩不该再指回教练｜原文：「'+clip(l,match.index)+'」';
      if (gate) no(message);
      else note(message+'（还在搭建，不判）');
    });
  }
  const next=allActiveSections(indexText,'下一步');
  const values=next.flat().filter(([l])=>/^\s*(?:-\s*)?换对话时说[：:]/.test(l));
  const activeOk=next.length===1 && values.length===1 && values[0][0]===NEXT_PROJECT_AI;
  if (mode==='adopted' && !activeOk)
    no('内容④：docs\\PROJECT_INDEX.md 「下一步」'+(next.length>1?'有 '+next.length+' 个活动节；':'')+(values.length?values.map(([,n])=>'第 '+n+' 行').join('、'):'缺活动字段')+'，采用时应唯一写「'+NEXT_PROJECT_AI+'」');
  else if (mode==='handover' && !activeOk) note('内容④：采用前在 docs\\PROJECT_INDEX.md 「下一步」更新「换对话时说」并读回');
  if (!hits && (mode!=='adopted' || activeOk)) ok('内容④：项目接班从自己的规矩开始');
  return mode;
}

const receiptNames = new Map([
  ['目标系统','目标'], ['目标表','目标'], ['工作表','目标'], ['读回结果','结果'],
  ['实见业务键','业务键'], ['人工列核对','人工列'], ['学员授权','授权'],
  ...['目标','结果','批次','允许列','执行时间','写前','本次新增','写后','业务键','人工列','授权'].map(key=>[key,key]),
]);
const clauses = text => text.split(/[，,。；;！!？?\r\n]+/u).map(s=>s.trim()).filter(Boolean);
const undecided = /请确认|是否|能否|可否|待审批|待确认|待批准|申请|待定|等待确认|[?？]|吗(?=$|[\s，,。；;！!？?])/u;
const regexLiteral = value => value.replace(/[.*+?^{}()|[\]\\$]/gu,'\\$&');

function writePermission(text, item) {
  if (!text) return '待核';
  const columns=item.columns.split(/[、,，]/u).map(c=>c.trim().replace(/列$/u,''));
  const restriction=/^(?:请)?((?:禁止|不得|不能|不准|不许|不可|不要|不)(?:再)?(?:修改|更改|写入|覆盖|清空|改动|动|改|写)|保留|保护)(.+)$/u;
  const protectedName=/^(?:人工列|其他列|其它列|其余列|非目标列|保留列|预留列|人工备注列|备注列|历史(?:数据|记录)?)$/u;
  const clear=s=>!s.includes(item.target) && !columns.some(c=>s.includes(c));
  const namedCol=s=>/^[\p{L}\p{N}_]{1,16}列$/u.test(s) && !/所有|全部|整|全表|目标|允许|本批|本次|任[何意]|其[他它余]|非|原有|已有|原|该|此|表|每|各/u.test(s);
  const scope='(?:范围[为：:]?)?(?:仅限|限于|仅|限)?(?:本批|本次)?(单次|长期)(?:有效)?';
  const scopeOnly=new RegExp('^'+scope+'$','u');
  const object=[item.columns,...['的','：',':'].map(sep=>item.target+sep+item.columns)].map(regexLiteral).join('|');
  const grant='(?:(?:我|学员)(?:已)?|已)?(?:(?:确认|同意|准许|允许|授权|批准|可以)(?:可以)?(?:只|仅)?|只|仅)';
  const permit=new RegExp('^(?:'+scope+'\\s*)?'+grant+'(?:'+scope+'\\s*)?(?:写入|填写|回写|修改|写)\\s*(?:'+object+')\\s*(?:'+scope+')?$','u');
  const scopes=[];
  let approved=false, unknown=false, writeClaim=false, preserveTarget=false;
  for (const part of clauses(text)) {
    const limit=restriction.exec(part);
    if (limit) {
      const objects=limit[2].split(/、|以及|和|与|及/u).map(s=>s.trim().replace(/的值$/u,''));
      if (objects.every(s=>protectedName.test(s) && clear(s))) continue;
      if (limit[1]==='保留' || limit[1]==='保护') preserveTarget ||= objects.some(s=>!clear(s));
      else if (!objects.every(s=>namedCol(s) && clear(s))) return '失败';
      unknown=true;
      continue;
    }
    if (/不同意|未同意|未获准|未授权|拒绝|撤[销回]|取消授权|暂[停缓]|停止|禁止|不得|不准|不许|不可以|不可写|不能写|暂不|不(?:要)?(?:写|改|动|覆盖)/u.test(part)) return '失败';
    const range=scopeOnly.exec(part);
    if (range) { scopes.push(range[1]); continue; }
    const match=permit.exec(part);
    if (match) { approved=true; scopes.push(...match.slice(1).filter(Boolean)); }
    else { unknown=true; writeClaim ||= /写|填写|修改/u.test(part); }
  }
  if (undecided.test(text) || !scopes.length || scopes.some(s=>s!==item.scope)) return '待核';
  if (!approved) return writeClaim?'待核':'失败';
  if (preserveTarget) return '失败';
  return unknown?'待核':'已授权';
}

function manualReadback(text) {
  const subject='(?:(?:人工列|各人工列|手工列)(?:均|都|全部)?)?';
  const safe=new RegExp('^'+subject+'(?:未发现异常|没有异常|未见异常|无异常|未改变|未变化|未被修改|未被清空|无变动|无差异|无改动|保留完整|保持原样|完好无损)$','u');
  const equal=new RegExp('^'+subject+'(?:前后(?:逐值)?(?:一致|相同)|逐值一致)(?:（人工内容[甲乙丙丁戊己庚辛壬癸A-Za-z0-9_-]+）)?$','u');
  const denied=/(?:并非|不是|并不是|不|未)(?:完全)?(?:无异常|未发现异常|没有异常|未见异常|无变化|无变动|无差异|未改变|未变化|未被修改|未被清空)|(?:没(?:有)?|未(?:能)?|不能|无法|难以|尚未|并非|不是|不)(?:证明|确认|保证|核实|验证|保持|做到)?(?:前后)?(?:逐值)?(?:一致|相同)/u;
  const changed=/不一致|不同|已(?:改变|修改|变更|清空|覆盖)|(?<!未)被(?:改|清|覆盖)|破坏|丢失|(?<!无|没有|未发现|未见)异常/u;
  let confirmed=false, pending=undecided.test(text??'');
  for (const part of clauses(text??'')) {
    if (safe.test(part)) continue;
    if (denied.test(part) || changed.test(part)) return '失败';
    if (equal.test(part)) confirmed=true;
    else pending=true;
  }
  return confirmed && !pending ? '一致' : '待核';
}

function scopeExcluded(lines, target, targets=new Set([target])) {
  const action='(?:缩小采用范围|本次不纳入|本次排除)';
  const actor='(?:(?:我|学员)(?:已)?|已)?(?:明确)?';
  const vote=actor+'(同意|确认|不同意|未同意|拒绝|不接受)'+action;
  const before=new RegExp('^'+vote+'[\\s：:]*','u'), after=new RegExp('[\\s：:]*'+vote+'$','u');
  const bareAction=new RegExp('^'+vote+'$','u');
  const retain=new RegExp('^('+actor+'(?:同意|确认))只采用[\\s：:]*(.+)$','u');
  const topic=/排除|缩小|缩范围|不纳入|只采用|交付|纳入|撤[回销]|取消.*(?:排除|缩范围|决定)|恢复|(?<![不未无非没])(?:拒绝|不接受|不同意|未同意)$|[?？]|吗(?=$|[\s，,。；;！!？?])/u;
  const concernsScope=s=>topic.test(s) || (undecided.test(s) && /范围|采用/u.test(s));
  const names=[...targets];
  const exactTarget=(part,name)=>{
    for (let i=part.indexOf(name);i>=0;i=part.indexOf(name,i+1)) {
      if (/(?:另一?|其[他它余]?|别的?|[旧新原副总分子A-Za-z0-9_])$/u.test(part.slice(0,i)) ||
          /^(?:归档|副本|备份|明细|汇总|总表|分表|子表|旧表|新表|表|库|系统|（[^）]*）|\([^)]*\)|[A-Za-z0-9_])/u.test(part.slice(i+name.length))) continue;
      if (!names.some(other=>{
        if (other.length<=name.length) return false;
        const start=part.lastIndexOf(other,i);
        return start>=0 && start+other.length>=i+name.length;
      })) return true;
    }
    return false;
  };
  const named=value=>{
    const raw=value.trim();
    for (const name of [raw,raw.replace(/^(?:针对|关于|对|将|把)\s*/u,'')]) {
      if (targets.has(name)) return name;
      const unquoted=/^(?:「([^」]+)」|“([^”]+)”|《([^》]+)》|"([^"]+)"|'([^']+)')$/u.exec(name)?.slice(1).find(Boolean);
      if (targets.has(unquoted)) return unquoted;
    }
  };
  let last=false, latest='';
  for (const line of lines) {
    const body=line.trim().replace(/^[-*]\s*/u,'');
    const dated=/^(\d{4}-\d{2}-\d{2})(?=$|[：:｜|，,\s])[：:｜|，,\s]*/u.exec(body);
    const parts=body.slice(dated?.[0].length??0).split(/([，,。；;！!\r\n]+)/u);
    let record, unknown=false;
    for (let i=0;i<parts.length;i+=2) {
      let part=parts[i].trim();
      if (!part) continue;
      const next=/^[，,]+$/u.test(parts[i+1]) ? parts[i+2].trim() : '';
      const subject=named(part), kept=retain.exec(part);
      if (kept && (kept[2]==='本地部分' || named(kept[2]))) {
        if (exactTarget(kept[2],target)) record=false;
        if (/^本次不纳入/u.test(next)) parts[i+2]=kept[1]+next;
        continue;
      }
      if (bareAction.test(part) && named(next)) { part+=' '+next; i+=2; }
      else if (subject && concernsScope(next) && !names.some(n=>n!==subject && exactTarget(next,n))) {
        part+='：'+next; i+=2;
      }
      const first=before.exec(part), final=after.exec(part);
      const owner=first ? named(part.slice(first[0].length)) : final ? named(part.slice(0,final.index)) : undefined;
      if (owner) {
        const verb=(first??final)[1];
        if (owner===target) record=record!==false && (verb==='同意' || verb==='确认') && !undecided.test(part);
        continue;
      }
      if (concernsScope(part)) {
        if (exactTarget(part,target)) { record=false; continue; }
        if (names.some(n=>n!==target && exactTarget(part,n))) continue;
      }
      unknown=true;
    }
    if (record===undefined) continue;
    const decision=record && !unknown, date=dated?.[1];
    if (!date) { last=decision; continue; }
    if (!isoDate(date)) return false;
    if (date<latest) continue;
    // 同日只能进一步收紧；无日期的决定替换当前状态，保留已见日期的上限。
    last=date===latest ? last && decision : decision;
    latest=date;
  }
  return last;
}

function localReadback(root, rel, item) {
  if (!rel) return {status:'待核',why:'还没有可核回执'};
  const target=rel.replace(/\s+(?:第\s*\d+\s*行|##?.+)$/,'').trim();
  let text;
  try { text=mapText(root,target); }
  catch (e) { return {status:'待核',why:'回执路径未核：'+target+'（'+(e.code ?? e.message)+'）'}; }
  if (!text) return {status:'待核',why:'本地回执缺失、为空或仅模拟'};
  const fields=new Map();
  for (const line of text.split(/\r\n?|\n/)) {
    const pair=/^\s*(?:[-*]\s*)?([^：:\s]+)[ \t]*[：:](.*)$/u.exec(line);
    if (!pair || !receiptNames.has(pair[1])) continue;
    const key=receiptNames.get(pair[1]), value=pair[2].trim();
    if (fields.has(key) && fields.get(key)!==value) return {status:'失败',why:'回执同一字段存在冲突记录'};
    fields.set(key,value);
  }
  if (/模拟|教学样例|待实跑/.test(text)) return {status:'待核',why:'本地回执缺失、为空或仅模拟'};
  const field=name=>fields.get(name);
  if (field('目标')!==item.target || field('批次')!==item.batch)
    return {status:'待核',why:'回执的目标或批次未核同'};
  const result=field('结果');
  if (/^(?:失败|不通过|未写成|回读不符)/.test(result ?? ''))
    return {status:'失败',why:result};
  const counts=['写前','本次新增','写后'].map(name=>/^\d+(?=\s*(?:[行条]|$))/.exec(field(name) ?? '')?.[0]).map(x=>x===undefined ? NaN : Number(x));
  const keys=field('业务键'), manual=manualReadback(field('人工列')), permission=writePermission(field('授权'),item);
  if (permission==='失败') return {status:'失败',why:'回执显示未获写入授权或已拒绝'};
  if (manual==='失败') return {status:'失败',why:'人工列核对未证明前后一致或已发生变更'};
  const [before,added,after]=counts;
  if (field('允许列')!==item.columns || !field('执行时间') || !/^(?:通过|成功|已读回)$/.test(result ?? '') ||
      permission!=='已授权' || manual!=='一致' || !counts.every(Number.isSafeInteger) || before+added!==after ||
      !keys || /^(?:无|—|待核|空值)$/.test(keys) ||
      (after===0 && !/^当批(?:可信)?输入[：:]0\s*(?:行|条).+明确应为零/m.test(text)))
    return {status:'待核',why:'回执仍缺授权、真实行数/业务键、当批对账或人工列核对'};
  return {status:'本地回执已核',why:'批次 '+item.batch+'，写前 '+before+'／本次新增 '+added+'／写后 '+after+'；线上现况另行只读核对'};
}

// 只从本轮结构或明确交付承诺收集，不从旧结果猜线上授权。
function externalDeliveries(root, indexText, fl, tickets, intake, mode) {
  if (mode==='stopped' && cmd==='files') return;
  const items=[], next=allActiveSections(indexText,'下一步').flat();
  for (const [line,n] of next) {
    const parts=line.replace(/^\s*-\s*/,'').split('｜').map(s=>s.trim());
    if (parts[0]!=='外部交付') continue;
    const [,step,target,columns,batch,scope,state,evidence]=parts;
    const N=/^第([1-9]\d*)步$/.exec(step ?? '')?.[1];
    const valid=parts.length===8 && N && target && columns && batch && /^(?:单次|长期)$/.test(scope) &&
      /^(?:已读回|待核|已排除本次)$/.test(state) && evidence;
    items.push({step:Number(N)||0,target:target||'交付位置待核',columns,batch,scope,state,evidence,
      where:'docs\\PROJECT_INDEX.md 第 '+n+' 行',valid});
  }
  const documented = (N,line,where) => {
    if (/^\s*(?:>|(?:示例|教学样例)[：:])/.test(line)) return;
    const pieces=line.split(/[。；;\n]/).filter(x=>!/(?:只读|只读取|读取来源|无需写入|不写入|不需要写入)/.test(x));
    for (const s of pieces) {
      const action=/(?:写入|回写|追加到|上表|推送到|待接|下站再接|尚未接)/.exec(s);
      if (!action || !/(?:飞书|线上|在线|外部|企微|Lark|系统)/i.test(s)) continue;
      const part=s.slice(action.index+action[0].length).replace(/^[：:\s「《"'“]+/,'');
      const target=/^([^，、；。｜:”」》\s]{1,55}?(?:工作表|表格|系统|表)(?:[《「][^」》]+[」》])?)/.exec(part)?.[1];
      const candidates=items.filter(i=>i.step===N);
      if (target && candidates.some(i=>i.target===target)) continue;
      if (items.some(i=>i.where===where && i.target===(target || '线上交付位置待核'))) continue;
      items.push({step:N,target:target || '线上交付位置待核',where,unregistered:true});
    }
  };
  for (const row of fl?.rows ?? []) for (const value of [row[3],row[5]])
    documented(Number(row[0]),value,RUN_MD+' 运行表第 '+row[0]+' 步');
  for (const {f,N,doc} of tickets) for (const [line,no] of indexedLines(doc,doc.step,true)) documented(N,line,f.rel+' 第 '+no+' 行');
  if (intake) {
    const doc=mdTicket(intake);
    for (const h of doc.top.filter(h=>isAtx(h,2) && /交付|产出|输出|要什么/.test(h.label)))
      for (const [l,n] of indexedLines(doc,h,true)) documented(0,l,'docs\\INTAKE.md 第 '+n+' 行');
  }
  const existing=allActiveSections(indexText,'已确认').flat().map(([l])=>l);
  const targets=new Set(items.filter(i=>i.valid).map(i=>i.target));
  for (const item of items) {
    let result={status:'待核',why:'交付尚未核同'};
    if (item.unregistered) result.why='请确认这个承诺、执行步、读回人和回执位置';
    else if (!item.valid) result.why='登记缺少步号、目标、允许列、批次、范围或证据';
    else if (item.state==='已读回') result=localReadback(root,item.evidence,item);
    else if (item.state==='待核') result.why='待办：'+item.evidence;
    else if (item.state==='已排除本次') {
      result=scopeExcluded(existing,item.target,targets) ? {status:'已排除本次',why:'按学员确认缩范围，保留待办：'+item.evidence}
        : {status:'待核',why:'还缺学员确认缩小采用范围的原话'};
    }
    const at=item.step?'第 '+item.step+' 步':'未绑定交付';
    const message='外部交付 '+at+'「'+item.target+'」'+result.status+'：'+result.why+'（'+item.where+'）';
    if (result.status==='失败' || (mode==='adopted' && result.status==='待核' && (!item.unregistered || cmd==='files'))) no(message);
    else if (result.status==='本地回执已核') ok(message);
    else note(message);
    scanFact(item.step,result.status==='失败'?'red':result.status==='本地回执已核'?'green':'yellow',
      result.status==='待核'?'交付待核':result.status,result.why,item.where);
  }
}

function safelyRead(root,rel) {
  try { return mapText(root,rel); } catch { return null; }
}

function content(t, kind, tickets, lines, hasFlow) {
  const byLow=t.byPath, own=kind.startsWith('教练做的');
  const before=[bad,out.length];
  const rows=table(lines,'运行表',FLOW_HEAD), inRows=table(lines,'输入清单',INPUT_HEAD);
  if (!own) [bad,out.length]=before;
  const nos=xs=>xs.map(x=>pad(x.N)).join('、');
  const steps=rows ? stepsOf(rows,SRC) : [], ids=inRows?.map(r=>inputId(r[0])).filter(Boolean) ?? [], bindings=bindingsOf(inRows ?? []);
  if (!rows || !inRows) {
    if (own) note('内容①②：'+(hasFlow?'docs\\run-flow.md 没读内容或表的格式没过':'还没有 docs\\run-flow.md')+'，不比');
    else if (hasFlow) note('运行表格式待核，外置图按原项目可识别内容展示');
  } else {
    let issues=0;
    const add=(N,state,title,actual,where)=>{
      issues++;
      (state==='red'?no:note)('内容①：'+actual);
      scanFact(N,state,title,actual,where);
    };
    for (const [i,step] of steps.entries()) {
      for (const output of step.to) if (!/^(work|output)\\[^\\]/.test(output))
        add(i+1,'red','读写不符','第 '+(i+1)+' 步产物不在 work 或 output：'+output,RUN_MD);
      for (const m of step.pendingIO) add(i+1,'yellow','读写待核','第 '+(i+1)+' 步 '+m,RUN_MD);
      for (const ref of [...step.from.filter(x=>!bareInput(x)),...step.to]) {
        try { const rel=physicalIO(ref,bindings); if (rel) mapEntry(SRC,rel); else add(i+1,'yellow','批次待核','第 '+(i+1)+' 步产物目录待本批参数',RUN_MD); }
        catch(e) { add(i+1,'red','断在这里','第 '+(i+1)+' 步的读写引用未核：'+(e.code ?? e.message),RUN_MD); }
      }
    }
    for (const {f,N,doc} of tickets) {
      const row=rows.find(r=>r[0]===String(N));
      if (!doc.step || !row) {
        add(N,'red','读写不符','票 '+pad(N)+(doc.step?'：运行表没有第 '+N+' 步':' 没有"## 这一步"')+'（'+f.rel+'）',f.rel);
        continue;
      }
      const fields=indexedLines(doc,doc.step,true), i=rows.indexOf(row);
      for (const [name,col] of [['从哪拿',2],['做什么',3],['放到哪',4]]) {
        const hits=fields.filter(([l])=>new RegExp('^'+name+'[：:]').test(l.trim()));
        const actual=hits[0]?.[0].trim().slice(name.length+1).trim() ?? '', where=f.rel+(hits.length?' 第 '+hits[0][1]+' 行':' 的"## 这一步"');
        const prefix='票 '+pad(N)+'"'+name+'"';
        const context='（'+where+'）';
        const values='票值「'+actual+'」（'+where+'）；运行表值「'+row[col]+'」（'+RUN_MD+' 运行表第 '+N+' 步）';
        if (hits.length!==1 || !actual || !row[col]) {
          add(N,'red','读写不符',prefix+'缺必要值或与运行表第 '+N+' 步不同'+context,where);
        } else if (name==='做什么') {
          if (actual!==row[col]) add(N,'yellow','票面待核',prefix+'差异未核：'+values,where);
        } else {
          const {problems,pending,differ}=compareIO(SRC,steps[i],name,actual,bindings,steps,ids,i+1);
          if (problems.length || differ) add(N,'red','读写不符',prefix+'是 '+actual+'，运行表第 '+N+' 步是 '+row[col]+
            (problems.length?'；'+problems.join('；'):'')+context,where);
          for (const message of pending) add(N,'yellow','读写待核',prefix+'差异未核：'+values+'；待核：'+message,where);
        }
      }
    }
    steps.forEach((s,i)=>fromErrs(steps,i+1,ids).forEach(m=>add(i+1,'red','断在这里','运行表'+m,RUN_MD+' 运行表第 '+(i+1)+' 步')));
    if (!issues && own) ok('内容①：'+(tickets.length?'票 '+nos(tickets)+' 的"这一步"三格和运行表同一行一致；':'还没有票；')+'运行表每步"从哪拿"都接得上');
    if (own) {
      const al=byLow.get('agents.md')?.text?.split(/\r?\n/) ?? [], k=al.findIndex(l=>/共\s*\d+\s*步/.test(l));
      const n=k<0?0:Number(al[k].match(/共\s*(\d+)\s*步/)[1]);
      if (k<0) note('内容②：AGENTS.md 里没写"共 N 步"，不比');
      else if (n===rows.length) ok('内容②：AGENTS.md 第 '+(k+1)+' 行"共 '+n+' 步"＝运行表 '+n+' 步');
      else no('内容②：AGENTS.md 第 '+(k+1)+' 行写"共 '+n+' 步"，运行表有 '+rows.length+' 步');
    }
  }
  const ran=tickets.filter(({doc})=>roundAt(doc)>=0);
  const bare=ran.filter(({doc})=>!doc.confirms.some(l=>CONFIRM.test(l)));
  for (const {N,f,doc} of bare) {
    const where=f.rel+' 第 '+(roundAt(doc)+1)+' 行';
    no('内容③：票 '+pad(N)+' 有第 '+doc.rounds[0].number+' 轮结果（'+where+'），"## 确认记录"下没有确认行。真人门，只能请学员重新确认，AI 不许补');
    scanFact(N,'red','缺少确认','有结果但没有真人确认',where);
  }
  if (own && !ran.length) note('内容③：还没有跑过的票，不核');
  else if (ran.length && !bare.length) ok('内容③：有结果的票 '+nos(ran)+' 都有确认记录');
  const idx=byLow.get('docs\\project_index.md')?.text ?? '';
  const mode=own ? checkHandover(idx,byLow.get('agents.md')?.text,byLow.get('readme.md')?.text,
    /｜第 5 站｜/.test(byLow.get('docs\\check\\files.txt')?.text?.split(/\r?\n/,1)[0] ?? '')) : adoption(idx);
  const fl={rows,inRows,tickets};
  externalDeliveries(SRC,idx,fl,tickets,byLow.get('docs\\intake.md')?.text,mode);
  return fl;
}

// ---------- ## 给人看的图：分三类（可查看候选／只有图源／只有文字流程）。自家图源核步骤、依赖边、人工关口；
// docs\run-flow.html 和自家图源比；别的 Archify html、外来图源只列四样事实；图片、Mermaid 不解析，交 AI 看、学员核 ----------
const LOOK = '给人看的图：AI 看图、学员核；读不了写未确认';
// 第一张带步号的表（第一格是数字的行）：各行第 4 格冒号前的字（短名），行数就是步数
function stepRows(text = '') {
  const xs = [];
  for (const l of text.split(/\r?\n/)) {
    if (!l.trim().startsWith('|')) { if (xs.length) break; continue; }
    const c = l.trim().slice(1).split('|');
    if (/^\d+$/.test(c[0].trim())) xs.push((c[3] ?? '').split(/[：:]/)[0].trim());
  }
  return xs;
}
// 四样事实（html 和外来 JSON 都先转成同一形状）：①分不清 ②看不出先后 ③照 SOP 或人的做法画 ④materials 画错。只报事实，只记 ·，每样最多 3 条
function picFacts(pic, shorts, cap, rel) {
  const { nodes, edges } = pic, by = new Map(nodes.map((n) => [n.id, n])), out = new Set(edges.map((e) => e.from));
  const lanes = [...new Set(nodes.map((n) => n.lane).filter((l) => l && l !== '读不出'))];
  const lane = lanes.length ? lanes.join('｜') + (lanes.some((l) => /程序|脚本/.test(l)) ? '' : '（没有程序道）') + (lanes.some((l) => /文件|数据/.test(l)) ? '' : '（没有文件道）') : '读不出';
  const last = Math.max(...nodes.map((n) => n.col)); // 最后一列＝节点 col 的最大值；有节点没有 col 就不核死胡同，不按列头或节点顺序猜
  const facts = [
    [`道：${lane}；图例：${Object.entries(pic.legend).map(([k, v]) => `${v}(${k})`).join('、') || '没有'}；框 ${nodes.length}、线 ${edges.length}`],
    [...(nodes.some((n) => /第\s*\d+\s*步/.test(n.phase ?? '')) ? [] : ['列头没有"第N步"']),
      ...(nodes.some((n) => typeof n.col !== 'number') ? ['列序读不出，未核死胡同'] : nodes.filter((n) => n.kind !== 'database' && !out.has(n.id) && n.col !== last).map((n) => `死胡同：${n.label}`)),
      ...nodes.filter((n) => /[＋+]/.test(n.label)).map((n) => `一框两步候选：${n.label}`)],
    [shorts.length ? `框名对得上运行表短名 ${shorts.filter((s) => nodes.some((n) => n.label === s)).length}/${shorts.length}` : '没有运行表，没法核',
      ...nodes.filter((n) => /attempt|✓|待跑|(?<![A-Za-z])v\d|SHA|\d+\/\d+/.test(n.label)).map((n) => `状态字样：${n.label}`),
      ...nodes.filter((n) => /SOP 拆解|拆解表|合同|批准|候选|修订重批|拆票/.test(n.label)).map((n) => `开发过程字样：${n.label}`)],
    edges.filter((e) => /materials/i.test(by.get(e.from)?.label ?? '') && by.has(e.to) && by.get(e.to).kind !== 'database').map((e) => `materials 直连步骤：${by.get(e.from).label} → ${by.get(e.to).label}`),
  ];
  ['分不清', '看不出先后', '照 SOP 或人的做法画', 'materials 画错'].forEach((what, i) => {
    const xs = cap(facts[i], `${rel} ${what}`, 3);
    if (xs.length) note(`${rel}：${'①②③④'[i]}${xs.join('；')}`);
  });
}
function pics(t, kind, starts, fl) {
  const st = /^教练做的 第 (\d) 站$/.exec(kind)?.[1];
  const L = (s) => s.toLowerCase(), byLow = new Map(t.files.map((f) => [L(f.rel), f])), skip = [];
  const cap = (xs, what, n = 10) => { if (xs.length > n) skip.push(`${what}另有 ${xs.length - n} 份没列`); return xs.slice(0, n); };
  const view = t.files.filter((f) => /\.(html?|svg|png|jpe?g)$/i.test(f.rel) && !/^docs\\check\\/i.test(f.rel));
  const srcs = t.files.filter((f) => /\.mmd$/i.test(f.rel) || (/\.json$/i.test(f.rel) && /"diagram_type"\s*:/.test(f.text ?? '')) || (/\.md$/i.test(f.rel) && /^\s*```\s*mermaid/im.test(f.text ?? '')));
  const old = readProjectMap(SRC), source = readFlowSource(SRC);
  if (old.kind === 'bad') no(badMapMessage(old) + '；继续体检');
  const rf = byLow.get('docs\\run-flow.md')?.text, shorts = stepRows(rf);
  const lines = rf !== undefined || old.kind === 'live' || old.kind === 'archify' ? flowLines(SRC) : null;
  const noDraw = noDrawOf(lines ?? []);
  if (st && st <= 3 && !source.json && !source.broken && old.kind === 'missing' && !view.length && !srcs.length) {
    note(`还没到出图那站（当前站 ${st}），不判图`); return [];
  }
  const words = [...t.files.filter(f => path.basename(L(f.rel)) === 'run-flow.md' || L(f.rel) === L(RUN_TXT)).map(f => f.rel),
    ...starts.flatMap(r => { const ns = numbered(byLow.get(L(r))?.text ?? ''); return ns.length >= 3 ? [`${r} 第 ${ns[0]} 行起 ${ns.length} 条编号步骤`] : []; })];
  if (!fl && lines) fl = { rows:table(lines,'运行表',FLOW_HEAD), inRows:table(lines,'输入清单',INPUT_HEAD) };
  if (old.kind === 'archify') {
    const gen = !source.json && fl?.rows && fl.inRows && validateFlow(SRC,fl.inRows,fl.rows);
    checkArchifyMap(old,source,fl,noDraw,gen && swimlane(mapTitle(lines),gen.ids,gen.steps,dirsOf(fl.inRows)));
    if (!source.json && !gen && fl?.rows && fl.inRows && noDraw===false) {
      const steps=stepsOf(fl.rows,SRC), ids=fl.inRows.map(r=>inputId(r[0])).filter(Boolean);
      const actual=old.pic, expected=toPic(swimlane(mapTitle(lines),ids,steps,dirsOf(fl.inRows)));
      const unknown=new Map(steps.map((s,i)=>[i+1,stepRefs(steps,i+1,ids).filter(r=>r.source===null).length]));
      for (const n of expected.nodes) {
        const found=actual.nodes.find(m=>m.id===n.id);
        if (!found || found.label!==n.label || found.phase!==n.phase || found.sublabel!==n.sublabel)
          staleMap(svgStep(n.id),'旧图框 '+n.id+' 与现表不同');
      }
      for (const [type,e] of compareSemanticEdges(actual.edges,expected.edges,unknown,svgStep))
        staleMap(svgStep(e.id),type+' '+e.id+'（'+e.label+'）');
    }
  } else {
    const valid = old.kind === 'live' && !noDraw && fl?.rows && fl.inRows && validateFlow(SRC,fl.inRows,fl.rows);
    const differs=!noDraw && compareLiveTable(old,fl,valid);
    if (!differs) verifyProjectMap(SRC,old,lines,valid || noDraw ? fl : null,false,noDraw);
    if (source.json) selfPic(source,fl);
  }
  for (const f of cap(view, '可查看候选')) {
    note(`可查看候选（请 AI 看是不是流程图）：${f.rel}（${f.size} 字节）`); want(f.rel, LOOK);
    if (L(f.rel) === L(RUN_HTML) || !/\.html?$/i.test(f.rel)) continue;
    try {
      const pic = picOf(path.join(SRC,f.rel));
      if (pic && !pic.err) picFacts(pic,shorts,cap,f.rel);
    } catch (e) { note(f.rel + ' 未核：' + (e.code ?? e.message)); }
  }
  for (const f of cap(srcs,'图源')) note('图源：' + f.rel);
  words.forEach(w => note('文字流程：' + w));
  const description = srcs.length ? '只有图源' : words.length ? '只有文字流程' : '什么都没有';
  if (old.kind === 'missing' && noDraw) note(`本范围没有可查看的流程图（${description}）；本轮不画图，不要求可查看图`);
  else if (st && st <= 3) note(`当前站 ${st}，还在画，先核已有的`);
  else if (old.kind === 'missing' && kind.startsWith('教练做的') && fl?.rows && fl.inRows && noDraw === false)
    no('缺 ' + RUN_HTML + '；请让 AI 按运行表生成项目活地图');
  else if (!view.length && old.kind === 'missing' && noDraw !== null) no(`没有可查看的流程图（${description}）`);
  if (!source.json && !source.broken && kind.startsWith('教练做的')) note(`自家图源 ${SELF} 不在，不比`);
  // 外来图源列全部节点和四样事实，不判；Mermaid 不解析
  for (const f of srcs.filter(x => L(x.rel) !== L(SELF))) {
    want(f.rel, LOOK);
    if (!/\.json$/i.test(f.rel)) continue;
    let p = null;
    try { const x = JSON.parse(f.text); if (Array.isArray(x.nodes)) p = toPic(x); } catch {}
    if (!p) { note(`外来图源 ${f.rel}：读不出节点，不数`); continue; }
    const kinds = new Map();
    for (const n of p.nodes) kinds.set(n.kind, (kinds.get(n.kind) ?? 0) + 1);
    note(`外来图源 ${f.rel}：节点 ${p.nodes.length} 个（${[...kinds].map(([k, c]) => `${k} ${c}`).join('、')}）：${p.nodes.slice(0, 8).map((n) => `${n.label}(${n.kind})`).join('、')}${p.nodes.length > 8 ? ' 等' : ''}`
      + `｜运行表 ${rf === undefined ? '没有' : shorts.length ? `${shorts.length} 行` : '没有带步号的表'}，不判`);
    picFacts(p, shorts, cap, f.rel);
  }
  return skip;
}
// 自家图源（flow 由运行表生成）对运行表核三样，不同记 ✗ 并点名第一处在第几步：
// ① 阶段标签＝"第N步 短名"；② 读边来源＝"从哪拿"（输入→f0，前面步→它的文件框；"你"那一步是写它的那一步 → 你，交你看），有"放到哪"才有写边，文件框＝"放到哪"；
// ③ 第 N 列有红框（security），当且仅当"你要判断什么"不是"—"。"从哪拿"接不上的步（内容①已记），边不比。不比宽度、meta 和人工关口的提示文案
function svgStep(id) {
  return Number(/^(?:you|a|f|r|p)(\d+)/.exec(id ?? '')?.[1]) || 0;
}
function scanFact(step, state, title, actual, where = RUN_MD) {
  if (cmd==='scan') scanFacts.push({step,state,title,actual,where});
}

function compareSemanticEdges(actual, expected, unknown, stepOf) {
  const relation=e=>JSON.stringify([e.from,e.to,e.label,e.dashed]);
  const left=actual.slice(), missing=[];
  for (const edge of expected) {
    const i=left.findIndex(other=>relation(other)===relation(edge));
    if (i<0) missing.push(edge); else left.splice(i,1);
  }
  const extras=left.filter(e=>{
    const N=stepOf(e.to), from=stepOf(e.from);
    const duplicated=actual.filter(a=>relation(a)===relation(e)).length>1;
    if (!duplicated && ['读','交你看'].includes(e.label) && from<N && (unknown.get(N) ?? 0)>0) {
      unknown.set(N,unknown.get(N)-1);
      return false;
    }
    return true;
  });
  return [...missing.map(e=>['缺线',e]),...extras.map(e=>['多线',e])];
}

function partialSourceDiff(j, expected, steps, ids) {
  const actual=toPic(j), want=toPic(expected), diffs=[];
  const unknown=new Map(steps.map((s,i)=>[i+1,stepRefs(steps,i+1,ids).filter(r=>r.source===null).length]));
  const unknownCount=[...unknown.values()].some(Boolean);
  if (!unknownCount && cmd!=='scan') {
    const first=picDiff(actual,want);
    return first ? [[0,first]] : [];
  }
  const fields={label:'文字',sublabel:'小字',kind:'类别',lane:'道',phase:'列头'};
  const found=new Set();
  const last=new Map(actual.nodes.map(n=>[n.id,n]));
  for (const n of actual.nodes) {
    const b=want.nodes.find(m=>m.id===n.id);
    found.add(n.id);
    if (!b || last.get(n.id)!==n) diffs.push([svgStep(n.id),'多框 '+n.id+'（'+n.label+'）']);
    else for (const [field,label] of Object.entries(fields)) if (n[field]!==b[field])
      diffs.push([svgStep(n.id),'框 '+n.id+' 的'+label+'不一致（图上"'+n[field]+'"，现表"'+b[field]+'"）']);
  }
  for (const n of want.nodes) if (!found.has(n.id)) diffs.push([svgStep(n.id),'缺框 '+n.id+'（'+n.label+'）']);
  for (const [type,e] of compareSemanticEdges(actual.edges,want.edges,unknown,svgStep))
    diffs.push([svgStep(e.id) || svgStep(e.to),type+' '+e.id+'（'+e.label+'，'+e.from+' → '+e.to+'）']);
  for (const key of Object.keys(want.legend)) if (actual.legend[key]!==want.legend[key])
    diffs.push([0,'图例 '+key+' 不一致']);
  return diffs;
}

function staleMap(step, detail, rel = RUN_HTML) {
  const when=step ? '第 '+step+' 步：' : '';
  if (rel===SELF) no(detail+'（'+rel+'）｜图已过期'+(step?'，第 '+step+' 步':''));
  else no((rel===RUN_HTML?'项目活地图已过期：':'图已过期：')+when+detail+'（'+rel+'）');
  scanFact(step,'red','图已过期',detail,rel);
}

function compareLiveTable(old, fl, valid) {
  if (old.kind!=='live' || !fl?.rows || !fl?.inRows) return;
  let changed=false;
  const steps=stepsOf(fl.rows,SRC), ids=fl.inRows.map(r=>inputId(r[0])).filter(Boolean);
  const prior=stepsOf(old.meta.flow[2],null,true);
  for (let i=0; i<Math.max(steps.length,prior.length); i++) {
    const a=prior[i], b=steps[i], local=[];
    if (!a || !b) local.push(a ? '现表已无此步' : '旧图缺这一步');
    else {
      if (a.short!==b.short) local.push('短名由「'+a.short+'」改为「'+b.short+'」');
      if (a.who!==b.who) local.push('执行者改为'+(b.who==='你'?'你判断':MAP_ROLES[WHO.indexOf(b.who)] ?? b.who));
      if (a.judge!==b.judge) local.push('人工关口或退回已变');
      if (a.what!==b.what && a.short===b.short) local.push('步骤规则或依据已变');
      if (a.to.map(ioKey).join('\0')!==b.to.map(ioKey).join('\0')) local.push('产物已变');
      const refs=stepRefs(steps,i+1,ids), known=refs.filter(x=>x.source!==null).map(x=>ioKey(x.ref));
      const oldRefs=a.from.map(ioKey);
      if (known.some(x=>!oldRefs.includes(x)) || oldRefs.filter(x=>!known.includes(x)).length>
          refs.filter(r=>r.source===null).length+b.pendingIO.length) local.push('可判读边已变');
    }
    if (local.length) { changed=true; for (const detail of local) staleMap(i+1,detail); }
  }
  if (JSON.stringify(old.meta.flow[1])!==JSON.stringify(fl.inRows)) { changed=true; staleMap(0,'输入清单或批次已变'); }
  if (!valid && !changed) note('内置图可判的步骤已比较；断边及依赖实物尚未核');
  return changed;
}

function selfPic(f, fl) {
  let j;
  try { j = JSON.parse(f.text); } catch { (f.text === undefined ? note : no)(`自家图源 ${SELF} ${f.text === undefined ? '没读内容' : '不是合法的 JSON'}，不比`); return; }
  const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!object(j) || ['nodes', 'edges', 'phases', 'lanes'].some((k) =>
    j[k] !== undefined && (!Array.isArray(j[k]) || j[k].some((x) => !object(x))))) {
    no('自家图源 ' + SELF + ' 结构不对：顶层及数组元素要是对象，图源本项不比');
    return;
  }
  if (!fl?.rows || !fl?.inRows) { note(`自家图源：运行表没读成，不比`); return; }
  const steps = stepsOf(fl.rows), ids = fl.inRows.map((r) => inputId(r[0])).filter(Boolean);
  steps.filter((s) => s.unclear).forEach((s) => note(`第 ${s.n} 步退回条件与目标无法唯一对应，图分支未核，请先澄清`));
  // 新形状（有程序道，v1.6 起生成的）：照同一张运行表重算期望图源，两份转成同一形状再比
  if (Array.isArray(j.lanes) && j.lanes.some(l=>l?.id==='prog')) {
    const unknown=steps.some((s,i)=>fromErrs(steps,i+1,ids).length || s.pendingIO.length);
    const changes=partialSourceDiff(j,swimlane('',ids,steps,dirsOf(fl.inRows)),steps,ids);
    for (const [N,change] of changes) {
      if (cmd==='scan') staleMap(N,'自家图源和运行表不一致：'+change,SELF);
      else no('自家图源和运行表不一致：'+change+'（'+SELF+'）');
    }
    if (unknown) note('运行表有接不上的步，未知读边未核；其余图源照常核对');
    else if (!changes.length && !steps.some(s=>s.unclear))
      ok('图源与运行表一致：'+steps.length+' 步的阶段标签、连线、人工关口（'+SELF+'）');
    return;
  }
  const changes=legacySourceDiff(j,steps,ids,swimlane('',ids,steps,dirsOf(fl.inRows)));
  for (const [N,message] of changes) {
    if (cmd==='scan') staleMap(N,message,SELF);
    else no(message+'（'+SELF+'）');
  }
  if (!changes.length && !steps.some((s,i)=>s.unclear || fromErrs(steps,i+1,ids).length))
    ok('图源与运行表一致：'+steps.length+' 步的阶段标签、读写边、人工关口及退回补换（'+SELF+'）');
}

function legacySourceDiff(j,steps,ids,expected) {
  const nodes=j.nodes ?? [], edges=j.edges ?? [], ph=j.phases ?? [];
  const at = (lane, col) => nodes.find((x) => x.lane === lane && x.col === col);
  const actor = (N) => at(steps[N - 1].who === '你' ? 'you' : 'ai', N);
  const changes=[];
  for (let N = 1; N <= Math.max(steps.length, ph.length - 1); N++) {
    const s = steps[N - 1], diff = [];
    if (!s) diff.push(`图源有"${ph[N].label}"，运行表没有这一步`);
    else {
      const label = `第${N}步 ${s.short}`, me = actor(N), fn = at('files', N);
      if (ph[N]?.label !== label) diff.push(`阶段标签是"${ph[N]?.label ?? '没有'}"，应是"${label}"`);
      if (!me) diff.push(`图源第 ${N} 列没有${s.who === '你' ? '"你"道' : ' AI 道'}的节点`);
      else if (s.who!=='你' && me.label!==s.short) diff.push('业务节点「'+me.label+'」应是「'+s.short+'」');
      const wrote = !!fn && !!me && edges.some((e) => e.from === me.id && e.to === fn.id && e.label === '写');
      const box = fn ? [fn.label, fn.sublabel].filter(Boolean).join('、') : '';
      if (s.to.length && !wrote) diff.push(`没有写到文件框的边，运行表"放到哪"是 ${s.to.join('、')}`);
      else if (s.to.length && box !== s.to.join('、')) diff.push(`files 道节点是 ${box}，运行表"放到哪"是 ${s.to.join('、')}`);
      else if (!s.to.length && fn) diff.push(`files 道有 ${box}，运行表"放到哪"是"—"`);
      const gate = nodes.some((x) => x.col === N && x.type === 'security');
      if (gate !== (s.judge !== '—')) diff.push(gate ? '图源第 ' + N + ' 列有人工关口（红框），运行表"你要判断什么"是"—"' : '运行表"你要判断什么"不是"—"，图源这一列没有人工关口（红框）');
    }
    if (diff.length) changes.push([N,'自家图源和运行表不一致，第一处在第 '+N+' 步：'+diff.join('；')]);
  }
  // 三道沿原列/道映射共用控制关系，保留旧布局，不只核红框是否存在。
  const mapped = (id) => {
    const n = expected.nodes.find((x) => x.id === id);
    if (!n) return undefined;
    if (/^you[1-9]/.test(id)) return nodes.find((x) => x.col === n.col && x.type === 'security')?.id;
    return at(n.lane === 'prog' ? 'ai' : n.lane, n.col)?.id;
  };
  const edgesOf=(xs,map)=>xs.map(e=>({...e,from:map(e.from),to:map(e.to),dashed:e.variant==='dashed'}));
  const stepOf=id=>nodes.find(n=>n.id===id)?.col ?? 0;
  const unknown=new Map(steps.map((s,i)=>[i+1,stepRefs(steps,i+1,ids).filter(r=>r.source===null).length]));
  const details=compareSemanticEdges(edgesOf(edges,id=>id),edgesOf(expected.edges,mapped),unknown,stepOf);
  for (const [type,e] of details)
    changes.push([stepOf(e.to),'自家图源和运行表不一致：控制线/读写关系 '+type+' '+e.id+'（'+e.label+'）']);
  return changes;
}

// ---------- ## 架构：教练做的读任务单⑥查推荐表；旧网页只列旧记录的解决方式；别的做法只列线索。整节正好一个"推荐："行，实际是哪种由 AI 定 ----------
const ASK_EG = '举例问：拿最近一次举例：你第一眼看什么，接着做了什么，最后交出什么？每次都这样吗？请直接打字回答。';
const confirm = []; // 请学员确认
// 旧网页的解决方式按值认，不认键名
const OLD_KIND = /(?<![\w.])(?:script|model_call|agent|none)(?!\.?\w)/g;
// 别的做法的关键词线索；多 Agent（agents 文件夹里 2 个以上 md）、固定（3 个以上编号步骤）另算
const ARCH_WORDS = [['ReAct', /思考\s*[—－–-]+\s*行动\s*[—－–-]+\s*观察|看结果再决定|直到/], ['Plan-and-Execute', /先列计划/], ['分流', /分类|分拣|哪一类/]];
function arch(t, kind) {
  const skip = [], R = '推荐：要问学员一问', IN = 'docs\\INTAKE.md';
  if (kind.startsWith('教练做的')) {
    const f = t.files.find((x) => x.rel.toLowerCase() === 'docs\\intake.md');
    const x = f?.text === undefined ? null : sixOf(f.text.replace(/^﻿/, '').split(/\r?\n/));
    const at = (...ns) => `${IN} 第 ${[...new Set(ns.filter(Boolean))].join('、')} 行`;
    const sig = x?.get('信号') ?? null, n = x?.sec.join('\n').match(/第\s*(\d)\s*种/)?.[1];
    if (!x) note(!f ? `还没有 ${IN}，不核架构` : f.text === undefined ? `${IN} 没读内容，不核架构` : `${IN} 里没有"## ⑥"，不核架构`);
    else if (sig === null && !n) note('⑥ 没有"信号："，也不是旧写法（第 N 种），不核架构');
    else if (sig === null) {
      const where = at(x.line(/第\s*\d\s*种/), x.line(/^\s*架构\s*[：:]/));
      if (n === '4' || x.sec.some((l) => l.includes('两种都列'))) { no(`⑥ 旧写法"第 ${n} 种"，没给确定推荐（架构没选定一种；${where}）`); confirm.push(ASK_EG); }
      else note(`⑥ 旧写法"第 ${n} 种"，不核架构；实际：${clip(x.get('架构')?.split(/[；;]/)[0].trim() || '没写')}（${where}）`);
    } else {
      // 新写法：按信号查表；学员改过的（你改成）不一致只记 ·
      const rec = readRec(), s = sig.split('｜')[0].trim(), changed = x.get('你改成')?.split('｜')[0].trim() ?? null;
      const real = changed ?? x.get('架构') ?? '', should = rec.get(s);
      const where = at(x.line(/^\s*信号\s*[：:]/), x.line(changed === null ? /^\s*架构\s*[：:]/ : /^\s*你改成\s*[：:]/));
      if (!should) no(`⑥ 信号"${s}"不在推荐表里（${where}）`);
      else {
        const same = noPlus(real) === should;
        (same ? ok : changed === null ? no : note)(`实际：${real || '没写'}｜应是：${should}｜${same ? '一致' : '不一致'}（信号"${s}"${changed === null ? '' : '，你改成'}，${where}）`);
        out.push(`推荐：${should}`);
        return skip;
      }
    }
  } else if (kind.startsWith('旧网页')) {
    const hits = (indexOf(t)?.text ?? '').split(/\r?\n/).flatMap((l, i) => [...l.matchAll(OLD_KIND)].map(([v]) => `旧记录：解决方式＝${v}（docs\\PROJECT_INDEX.md 第 ${i + 1} 行）`));
    if (!hits.length) note('旧记录里没找到解决方式的值（script、model_call、agent、none）');
    hits.slice(0, 3).forEach((h) => note(h));
    if (hits.length > 3) skip.push(`架构线索 旧记录另有 ${hits.length - 3} 处没列`);
  } else if (kind === '别的做法') {
    const texts = ownTexts(t);
    const clues = [
      ['多 Agent', ['.codebuddy', '.claude', '.codex'].flatMap((d) => {
        const n = t.files.filter((f) => /\.md$/i.test(f.rel) && f.rel.toLowerCase().startsWith(`${d}\\agents\\`)).length;
        return n >= 2 ? [`${d}\\agents\\ ${n} 份 md`] : []; })],
      ...ARCH_WORDS.map(([k, re]) => [k, texts.flatMap((f) => f.text.split(/\r?\n/).flatMap((l, i) => { const m = l.match(re); return m ? [`${f.rel} 第 ${i + 1} 行"${m[0]}"`] : []; }))]),
      ['固定', texts.flatMap((f) => { const ns = numbered(f.text); return ns.length >= 3 ? [`${f.rel} 第 ${ns[0]} 行起 ${ns.length} 个编号步骤`] : []; })],
    ];
    for (const [k, xs] of clues) {
      if (xs.length) note(`架构线索 ${k}：${xs.slice(0, 3).join('、')}`);
      if (xs.length > 3) skip.push(`架构线索 ${k}另有 ${xs.length - 3} 处没列`);
    }
    if (!clues.some(([, xs]) => xs.length)) note('架构线索：五类都没找到');
    note('请 AI 定实际架构，问举例问，查推荐表');
  }
  out.push(R);
  return skip;
}

function rescueClues(t, kind, fl) {
  if (!kind.startsWith('教练做的')) return note('非教练五站项目，不核五站卡站清单');
  const n = kind.endsWith('搭建完成') ? '5' : /第 ([1-5]) 站/.exec(kind)?.[1];
  if (!n) return note('当前站未定，不核本站清单');
  const start = out.length, history = projectVersions(indexOf(t).text);
  if (history.upgradeBroken) note('[票据:待修] docs\\PROJECT_INDEX.md：最近体检升级记录格式或日期无效');
  for (const m of tally(SRC, readList(n))) note('[卡站:多出] ' + m.replace(/^多出 (.*)：不在本站清单里$/, '$1').replace('：' + CODEBUDDY, ''));
  const byPath = new Map(t.files.map(f => [f.rel.toLowerCase(), f]));
  for (const [rel, saved] of baselineRows(byPath.get(BASE.toLowerCase())?.text ?? '')) {
    const key = rel.toLowerCase(), f = byPath.get(key);
    if (!/^materials\\/.test(key) || key !== path.normalize(key) || /[:/]/.test(key) ||
      [...t.links, ...t.skipped].some(p => key === p.toLowerCase() || key.startsWith(p.toLowerCase() + '\\'))) continue;
    if (!f && !lexists(path.join(SRC, rel))) note(`[基线:差异] ${rel}（已删除）`);
    else if (f?.sha && `${f.size}｜${f.sha}` !== saved) note(`[基线:差异] ${rel}（已修改）`);
    else if (!f?.sha) note(`材料 ${rel} 未取到指纹，本次未核`);
  }
  if (!t.links.some(p => p.toLowerCase() === 'docs\\check')) for (const { N, doc } of fl.tickets) {
    const NN = pad(N), f = sheetFacts(SRC, NN, doc, history), id = `票 ${NN} 第 ${f.version ?? '?'} 版`;
    if (!f.version) { note(`[票据:待修] ${id}：缺有效验收单`); continue; }
    const row = fl.rows?.find(r => r[0] === String(N));
    if (!validValueSource(N, row, sourcesOf(doc))) note(`[${f.legacyValue ? '旧票:建议补真值' : '票据:待修'}] ${id}：请核预期值来源`);
    if (!f.confirmed) continue;
    const quote = quoteDigits(f.quote), permit = singlePermit(quote, f.legacyRun);
    const finalOnly = /仅定稿·未获准运行|^票\s*\d+\s*验收单确认\s*$/.test(quote);
    if (otherTicket(quote, N) || (!permit && quote !== '按快跑档推进' && !(finalOnly && !hasVersionRound(doc, f.version)))) note(`[票据:待修] ${id}：确认原话不能授权本票`);
    if (!f.hasFingerprint) note(`[${f.requireFingerprint ? '票据:待修' : '旧票:兼容'}] ${id}：缺预检指纹${permit === '旧版括注' ? '，旧版括注兼容' : ''}`);
  }
  for (const dir of ['', 'docs']) if (!dir || t.dirs.some(p => p.toLowerCase() === dir)) for (const name of deliveryLocks) {
    const rel = path.join(dir, name);
    if (lexists(path.join(SRC, rel))) note('[残留锁] ' + rel);
  }
  if (out.length === start) note('[卡站:无] 当前站文件清单与基线未见阻断项');
}

// 全文不超过 120 行（第 1 行在 finish 里加，"## 没看的"最多标题＋21 行）：超了就从完成度、长期记忆、给人看的图、卡站线索里当下最长的那节删末尾的 · 行（没有 · 再删末行），删了几行记进没看的
function fit(skipped) {
  const cut = new Map(), tail = () => { const n = skipped.length + cut.size; return 1 + Math.min(n, 20) + (n > 20 ? 1 : 0); };
  while (out.length > 120 - 1 - tail()) {
    const secs = ['## 完成度', '## 长期记忆', '## 给人看的图', '## 卡站与升级线索'].map((h) => { const i = out.indexOf(h); return { h, i, j: out.findIndex((l, k) => k > i && l.startsWith('## ')) }; });
    const s = secs.reduce((a, b) => (b.j - b.i > a.j - a.i ? b : a));
    if (s.j - s.i < 2) break;
    const k = out.slice(s.i + 1, s.j).findLastIndex((l) => l.startsWith('· '));
    out.splice(k < 0 ? s.j - 1 : s.i + 1 + k, 1);
    cut.set(s.h, (cut.get(s.h) ?? 0) + 1);
  }
  skipped.unshift(...[...cut].map(([h, n]) => `${h.slice(3)}另有 ${n} 行没列（全文限 120 行）`));
}

const DIAG_STYLE=`
@layer offline {
  :root {color-scheme:light dark; --foreground:#162b37; --muted-foreground:#465d6b; --card:#f9fcfb; --secondary:#e9f3f1; --border:#c6d8d6; --primary:#005a54; --primary-foreground:#fff; --accent-surface:#eef8f5; --success:#166549; --warning:#845213; --destructive:#a02e24; --radius:10px; --font-sans:system-ui,"Microsoft YaHei",sans-serif}
  @media(prefers-color-scheme:dark){:root{--foreground:#e3f4f0;--muted-foreground:#b5ccc7;--card:#1b2529;--secondary:#283d41;--border:#416063;--primary:#83ded1;--primary-foreground:#0b2c2b;--accent-surface:#172d2c;--success:#91dcb3;--warning:#ffd48a;--destructive:#ffa99a}}
}
*{box-sizing:border-box}
body{margin:0;color:var(--foreground);font:1rem/1.52 var(--font-sans);overflow-wrap:anywhere}
main{width:min(100%,860px);margin-inline:auto}
header,nav,.detail,details,.feedback{margin-inline:.65rem}
header{margin-block:.65rem}
h1,h2,p{margin:0}h1{font-size:1.45rem}h2{font-size:1.05rem}
nav,.actions{display:flex;gap:.38rem;align-items:center;flex-wrap:wrap}
nav{margin-block:.45rem}
[data-visible-count]{color:var(--muted-foreground);font-size:.89rem;font-weight:650}
button,textarea{font:inherit;color:var(--foreground);background:var(--card);border:1px solid var(--border);border-radius:var(--radius)}
button{padding:.32rem .65rem;cursor:pointer}button[aria-pressed=true],.copy{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
button:disabled{opacity:.52;cursor:default}
:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
svg{display:block;width:100%;font-family:var(--font-sans);height:auto}
.narrow{display:none}
.grid{fill:var(--accent-surface)}.dot{fill:var(--border)}
.hit{stroke:var(--border);fill:var(--card);stroke-width:2}
.node{color:var(--muted-foreground)}.green{color:var(--success)}.yellow{color:var(--warning)}.red{color:var(--destructive)}
.node.red .hit,.node.yellow .hit,.node.green .hit{stroke:currentColor;stroke-width:2.6}
.node.selected .hit,.node:focus-visible .hit{stroke:currentColor;stroke-width:4}
.node.idle.selected .hit{stroke:var(--primary);stroke-width:3.6}
svg [role=button]{cursor:pointer}svg text{fill:var(--foreground);text-anchor:middle;pointer-events:none}
.node .label{font-size:19px;font-weight:750}.node .state{font-size:13px;fill:currentColor;font-weight:650}
.node .symbol{fill:none;stroke:currentColor;stroke-width:2}
.edge{fill:none;stroke:var(--muted-foreground);stroke-width:2.2}
.edge.active{stroke:var(--primary);stroke-width:4}.edge.broken,.edge.back{stroke-dasharray:6 5;stroke:var(--destructive)}
.edge.broken.active,.edge.back.active{stroke-width:4}
.edge-key{font-size:12px;fill:var(--muted-foreground);paint-order:stroke;stroke:var(--accent-surface);stroke-width:5px;stroke-linejoin:round}
.edge-key.start{text-anchor:start}.edge-key.end{text-anchor:end}
[data-mode=issues] .node:not(.active) .hit{fill:var(--accent-surface);stroke:var(--border);stroke-width:1.6}
[data-mode=issues] .node:not(.active) text{fill:var(--muted-foreground)}
.detail{padding-block:.45rem}
.sequence{margin:.25rem 0;padding:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.36rem .70rem;font-size:.88rem}
.sequence div{min-width:0;border-top:2px solid var(--border);padding-top:.22rem}
dt{font-weight:700}dd{margin:0;color:var(--muted-foreground)}
details{border-block-start:1px solid var(--border);padding:.28rem 0;font-size:.88rem}
summary{cursor:pointer;font-weight:650}details ul{padding-inline-start:1.25rem;margin:.35rem 0}
.feedback{padding-bottom:.5rem;font-size:.87rem}
textarea{width:100%;max-width:100%;min-block-size:5rem;padding:.4rem}
[hidden]{display:none!important}
@media(max-width:510px){.wide{display:none}.narrow{display:block}.sequence{grid-template-columns:1fr}.node .label{font-size:18px}}
`;
const DIAG_JS=`
const data=JSON.parse(document.querySelector('#scan-data').textContent);
const buttons=[...document.querySelectorAll('[data-filter]')];
const counter=document.querySelector('[data-visible-count]');
const canvas=document.querySelector('[data-visual]');
const field=document.querySelector('textarea');
const status=document.querySelector('[data-copy-status]');
let copyJob=0;
function resetCopy() {
  status.textContent='';
  field.hidden=true;
  return ++copyJob;
}
const isIssue=s=>s.state==='red'||s.state==='yellow';
let mode='normal', selected=Number(document.querySelector('[data-panel]:not([hidden])')?.dataset.panel);
function show() {
  const visible=mode==='issues' ? data.filter(isIssue).map(s=>s.id) : data.map(s=>s.id);
  if (!visible.includes(selected)) selected=visible[0] ?? null;
  canvas.dataset.mode=mode;
  for (const button of buttons) button.setAttribute('aria-pressed',String(button.dataset.filter===mode));
  const current=visible.indexOf(selected);
  document.querySelector('[data-move="-1"]').disabled=current<1;
  document.querySelector('[data-move="1"]').disabled=current<0||current>=visible.length-1;
  counter.textContent=mode==='issues'?'卡点 '+visible.length+' 处':'共 '+data.filter(s=>s.num!==null).length+' 步';
  for (const node of canvas.querySelectorAll('[data-node]')) {
    const id=Number(node.dataset.node);
    const active=mode==='issues'?visible.includes(id):id===selected || id===-1 || id===-2;
    node.classList.toggle('active',active||id===selected);
    node.classList.toggle('selected',id===selected);
    if(id>=0){node.setAttribute('tabindex',visible.includes(id)?'0':'-1');node.setAttribute('aria-pressed',String(id===selected));}
  }
  for(const edge of canvas.querySelectorAll('[data-edge]')) {
    const from=Number(edge.dataset.from), to=Number(edge.dataset.to), blocked=edge.classList.contains('broken')||edge.classList.contains('back');
    const active=mode==='issues'?blocked||visible.includes(to):!blocked||selected===from||selected===to;
    edge.classList.toggle('active',active);
  }
  for (const section of document.querySelectorAll('[data-panel]')) section.hidden=Number(section.dataset.panel)!==selected;
  document.querySelector('[data-empty]').hidden=visible.length>0;
  resetCopy();
}
function choose(node) {
  if (node.dataset.node===undefined || Number(node.dataset.node)<0) return;
  const id=Number(node.dataset.node);
  if(mode==='issues'&&!data.some(x=>x.id===id&&isIssue(x))) mode='normal';
  selected=id;show();
}
canvas.addEventListener('click',e=>{const n=e.target.closest('[data-node]');if(n) choose(n);});
canvas.addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  const n=e.target.closest('[data-node]');if(!n) return;
  e.preventDefault();choose(n);
});
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.filter){mode=b.dataset.filter;show();}
  if(b.dataset.move) {
    const visible=mode==='issues'?data.filter(isIssue):data;
    const i=visible.findIndex(s=>s.id===selected);
    selected=visible[i+Number(b.dataset.move)]?.id ?? selected;show();
  }
  if(b.dataset.copy===undefined)return;
  const text=data.find(x=>x.id===Number(b.dataset.copy)).command;
  const job=resetCopy();
  try {
    await navigator.clipboard.writeText(text);
    if(job===copyJob) status.textContent='已复制';
  } catch {
    if(job!==copyJob) return;
    field.value=text;field.hidden=false;field.focus();field.select();status.textContent='已全选，请复制';
  }
});
show();
`;

const lineData=s=>String(s ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu,' ').replace(/\s+/g,' ').trim();
const diagBadge={red:['断点','!'],yellow:['待核','?'],green:['已核','✓'],idle:['未到','·']};
function scanMapData(fl,lines) {
  const rows=fl?.rows ?? partialFlowRows(lines), inRows=fl?.inRows ?? [], steps=stepsOf(rows,SRC);
  const ids=inRows.map(r=>inputId(r[0])).filter(Boolean);
  const numToId=new Map(steps.map((s,i)=>[Number(s.n),i]));
  const hasMemory=s=>redactMemoryText(s)!==s;
  const privateInputs=new Set(inRows.filter(r=>r.some(hasMemory)).map(r=>inputId(r[0])).filter(Boolean));
  let plan;
  if (fl?.rows && fl?.inRows) {
    try { plan=mapPlan(SRC,lines,inRows,rows); } catch { /* 可识别的静态步骤仍可诊断。 */ }
  }
  const observed=[];
  const data=steps.map((s,i)=>{
    const N=Number(s.n)||i+1, facts=scanFacts.filter(f=>f.step===N);
    const tickets=fl?.tickets?.filter(t=>t.N===N) ?? [];
    let proof=null;
    try { if (plan) proof=mapStep(plan,i,observed); } catch { /* 证明不齐只列待核。 */ }
    observed.push(proof);
    const proofState=proof?.step?.[2], why=proof?.step?.[3], where=proof?.step?.[11];
    if (proofState==='verified') facts.push({state:'green',title:'本批证据齐',actual:why,where:where ?? RUN_MD});
    else if (!fl?.rows || !fl?.inRows || !proof || ['locked','waiting','blocked'].includes(proofState) || (tickets.length&&proofState==='pending'))
      facts.push({state:proofState==='blocked'&&/未过|未放行|对不上/.test(why ?? '')?'red':'yellow',title:s.who==='你'?'待人核':'本批待核',
        actual:why ?? '运行表、票或本批实物还没有核齐',where:where ?? RUN_MD});
    if (rows[i].some(hasMemory) || s.from.some(r=>privateInputs.has(inputId(r)))) {
      const actual='第 '+N+' 步引用平台记忆目录，正文未读取';
      no(actual);
      facts.push({state:'red',title:'平台记忆未读',actual,where:RUN_MD});
    }
    const retreat=[];
    for (const target of s.back) {
      if (numToId.has(target)) retreat.push(numToId.get(target));
      else facts.push({state:'yellow',title:'退回待核',actual:'退回目标第 '+target+' 步未能识别',where:RUN_MD});
    }
    const state=['red','yellow'].find(k=>facts.some(f=>f.state===k)) ?? (proofState==='verified'?'green':'idle');
    const refs=stepRefs(steps,i+1,ids).map(r=>({ref:redactMemoryText(r.ref),source:r.source===0?-1:r.source ? r.source-1 : null}));
    return {
      id:i,num:N,name:lineData(s.short)||'流程步骤',who:s.who, state,facts,refs,
      input:s.from.join('、')||'待核',rule:s.what,output:s.to.join('、')===''
        ? (s.judge==='—'?'待核':s.judge) : s.to.join('、')+(s.judge==='—'?'':'；'+s.judge),
      paths:tickets.map(t=>t.f.rel),batch:proof?.step?.[7]?.map(([,key,value])=>key+'＝'+value).join('、') || '待核',
      retreat,
    };
  });
  // 无法识别步号或交付未绑定时，单列可行动入口。
  const detached=scanFacts.filter(f=>!data.some(s=>s.num===f.step));
  if (!data.length || detached.length) {
    data.push({id:data.length,num:null,name:data.length?'项目待核':'运行表待核',who:'你',state:detached.some(f=>f.state==='red')?'red':'yellow',
      facts:detached.length?detached:[{state:'yellow',title:'运行表待核',where:RUN_MD,actual:lines?'运行表格式损坏或没有可识别步号':'文件未能安全读取，检查编码、链接和文件权限'}],
      refs:[],input:RUN_MD,rule:'先只读查原件和证据',output:'核清后再确定下一步',paths:[],batch:'待核',retreat:[]});
  }
  const criteria={
    '断在这里':'生产步先写、消费步后读，读写位置一致',
    '读写不符':'把票的主产物及读写位置与运行表逐项核对',
    '图已过期':'复诊核对现表、图和图源，尤其是人工核对及退回',
    '交付待核':'只读核对同一表、允许列、批次、行数、业务键与人工列前后一致',
    '待人核':'由我确认本批对象，保留真实决定原话',
  };
  for (const step of data) {
    for (const key of ['name','input','rule','output','batch']) step[key]=redactMemoryText(step[key]);
    step.paths=step.paths.map(redactMemoryText);
    step.facts=step.facts.map(f=>({...f,title:redactMemoryText(f.title),actual:redactMemoryText(f.actual),where:redactMemoryText(f.where)}));
    const facts=step.facts.map(f=>f.title+'：'+lineData(f.actual)).join('；');
    const rule='应读 '+lineData(step.input)+'；应交或应停 '+lineData(step.output);
    const where=[...step.paths,...step.facts.map(f=>f.where)].filter(p=>p && !p.includes('[平台记忆路径已隐藏]'));
    const evidence=[...new Set(where)].filter(p=>!p.startsWith(RUN_MD)).map(p=>path.join(SRC,lineData(p)));
    const table=path.join(SRC,RUN_MD)+(step.num?' 运行表第 '+step.num+' 步':'');
    const actual=facts||'这一步还没有本批可核的运行结果';
    const summary=[...new Set(step.facts.map(f=>f.title))].join('、') || '未到这步';
    const verification=[...new Set(step.facts.map(f=>criteria[f.title] ?? '补齐本批实际样本和可核证据'))].join('；')||'用本批实物核对读写和验收停点';
    const location=evidence.length?evidence.join('、'):step.paths.length?'票已列在证据中':'尚无票';
    step.command=[
      scanCommandHeader(SRC,step),
      '我在本轮诊断图看到：'+summary+'。约定：'+rule+'。实际：'+actual+'。',
      '请先只读核对「'+lineData(table)+'」与「'+lineData(location)+'」。'+
        (step.state==='green'?'给我已核证据和核查结果，若要改规则先给方案等我确认。':
          '给我第一处差异、拟改文件和最小修改办法，等我确认后只改这一步获准的范围。'),
      '验收：'+verification+'。给我当批好样本、坏样本或人工/外部回执中适用的证据，再做外置复诊。未通过：禁止报修好/已通过。',
      '保留 materials 原件、已过票的历史、其他批次和人工列。禁止自行补真人确认、改定时任务、回填历史或写外部表。线上写入另等我确认目标表、允许列、适用批次、单次或长期。',
    ].map(redactMemoryText).join('\n');
  }
  return data;
}

function partialFlowRows(lines) {
  const start=lines?.findIndex(l=>/^## 运行表\s*$/.test(l)) ?? -1;
  const found=[], nums=new Set();
  if(start<0) return found;
  for(const l of lines.slice(start+1)) {
    if(/^##\s/.test(l)) break;
    if(!l.trimStart().startsWith('|')) continue;
    const row=l.trim().replace(/^\||\|$/g,'').split('|').map(s=>s.trim());
    if(row.length!==6 || !/^[1-9]\d*$/.test(row[0]) || !WHO.includes(row[1]) || !row[3] || nums.has(row[0])) continue;
    nums.add(row[0]);found.push(row);
  }
  return found;
}

function diagnosticScene(data,narrow) {
  const mode=narrow?'n':'w', W=narrow?390:728, cols=narrow?1:3, card=narrow?196:158, pitch=narrow?106:184;
  const y0=narrow?52:96, half=card/2, colX=[100,332,564];
  const nodes=[{id:-1,name:'当批输入',state:'idle'},...data,{id:-2,name:'结果交付',state:'idle'}];
  const pointById=new Map(nodes.map((node,i)=>{
    const row=Math.floor(i/cols), at=i%cols, col=row%2?cols-1-at:at;
    return [node.id,{x:narrow?195:colX[col],y:y0+pitch*row,row,col}];
  }));
  const lastRow=Math.floor((nodes.length-1)/cols);
  const backCount=data.reduce((sum,s)=>sum+s.retreat.filter(to=>to!==s.id).length,0);
  const routes=data.flatMap(s=>[...new Set(s.refs.map(r=>r.source))]
    .map(from=>[from,s.id,from===null?'broken':'read',from===null?'缺料':from===-1?'读入':'写出／读入'])
    .concat(s.retreat.filter(to=>to!==s.id).map(to=>[s.id,to,'back','退回'])));
  const actual=data.filter(s=>s.num!==null).at(-1);
  if (actual) routes.push([actual.id,-2,'deliver','交出']);
  const skipCount=narrow ? routes.filter(([from,to,type])=>type==='read' &&
    Math.abs(pointById.get(to).row-pointById.get(from).row)>1).length : 0;
  const spacing=(space,n)=>Math.min(10,Math.floor(space/Math.max(1,n-1)));
  const backStep=spacing(54,backCount), leftStep=spacing(66,skipCount), laneStep=spacing(32,backCount);
  const extraLanes=Math.max(0,backCount-1)*laneStep;
  const height=narrow?105+pitch*lastRow:Math.max(430,y0+pitch*lastRow+96+extraLanes);
  const taken=[...pointById.values()].map(({x,y})=>[x-half-2,y-33,x+half+2,y+33]);
  let backIdx=0, skipIdx=0;
  function placeLabel(label, points, preferred) {
    const w=label.length*12+6;
    const put=([x,y,align=''])=>{
      const left=align==='start'?x-3:align==='end'?x-w+3:x-w/2;
      const box=[left,y-13,left+w,y+5];
      if (box[0]<6 || box[1]<14 || box[2]>W-6 || box[3]>height-6 ||
          taken.some(([l,t,r,b])=>box[0]<r && l<box[2] && box[1]<b && t<box[3])) return null;
      taken.push(box);
      return '<text class="edge-key'+(align?' '+align:'')+'" x="'+x+'" y="'+y+'">'+label+'</text>';
    };
    let placed=put(preferred);
    if (placed) return placed;
    const segments=points.slice(1).map((b,i)=>[points[i],b]);
    for (const [[x,y],[u,v]] of segments) {
      const vertical=x===u, length=Math.abs(u-x)+Math.abs(v-y);
      for (let offset=0;offset<=length/2;offset+=12) for (const sign of offset===0?[1]:[-1,1]) {
        const cx=(x+u)/2+(vertical?0:sign*offset), cy=(y+v)/2+(vertical?sign*offset:0);
        const candidates=vertical ? [[cx,cy+4],[cx+10,cy+4,'start'],[cx-10,cy+4,'end']]
          : [[cx,cy-8],[cx,cy+16]];
        for (const p of candidates) {
          placed=put(p);
          if (placed) return placed;
        }
      }
    }
    // 残表可能远多于合法七步，挤不下的字可从线的提示读到。
    return '<text class="edge-key" visibility="hidden">'+label+'</text>';
  }
  const links=routes.map(([from,to,type,label])=>{
    const a=pointById.get(from), b=pointById.get(to);
    let points, preferred;
    if (from===null) {
      const x=b.x-(narrow?74:46), y=b.y-(narrow?43:64);
      points=narrow?[[x-33,y],[x,y],[x,b.y-37]]:[[x,y],[x,b.y-36]];
      preferred=[narrow?x-11:x,y-7];
    } else if (type==='back') {
      const i=backIdx++, railX=(narrow?310:656)+i*backStep;
      if (narrow) {
        points=[[a.x+half,a.y],[railX,a.y],[railX,b.y],[b.x+half+7,b.y]];
        preferred=[Math.min(372,Math.max(308,railX)),(a.y+b.y)/2+4];
      } else {
        const rightA=a.col===cols-1, rightB=b.col===cols-1;
        const lane=48+i*laneStep, startY=rightA?a.y:a.y+lane, endY=rightB?b.y:b.y-lane;
        const start=rightA?[[a.x+half,a.y]]:[[a.x+28,a.y+32],[a.x+28,startY]];
        const end=rightB?[[b.x+half+7,b.y]]:[[b.x+28,endY],[b.x+28,b.y-39]];
        points=[...start,[railX,startY],[railX,endY],...end];
        preferred=[railX,(startY+endY)/2+4];
      }
    } else if (narrow && Math.abs(b.row-a.row)>1) {
      const railX=82-skipIdx++*leftStep;
      points=[[a.x-half,a.y],[railX,a.y],[railX,b.y],[b.x-half-7,b.y]];
      preferred=[Math.max(40,Math.min(60,railX)),(a.y+b.y)/2+4];
    } else if (a.y===b.y) {
      const x=(a.x+b.x)/2;
      if (Math.abs(b.col-a.col)>1) {
        const lane=a.y-50;
        points=[[a.x,a.y-32],[a.x,lane],[b.x,lane],[b.x,b.y-39]];
        preferred=[x,lane-7];
      } else {
        const heading=Math.sign(b.x-a.x);
        points=[[a.x+heading*half,a.y],[b.x-heading*(half+7),b.y]];
        preferred=[x,a.y-10];
      }
    } else {
      const heading=Math.sign(b.y-a.y), mid=(a.y+b.y)/2;
      const start=[a.x,a.y+heading*32], end=[b.x,b.y-heading*39];
      if (Math.abs(b.row-a.row)>1) {
        const railX=a.col===0 || (a.col===1 && b.col===0) ? 216 : 448;
        const startY=a.y+heading*56, endY=b.y-heading*56;
        points=[start,[a.x,startY],[railX,startY],[railX,endY],[b.x,endY],end];
        preferred=[railX,(startY+endY)/2+4];
      } else {
        points=[start,[a.x,mid],[b.x,mid],end];
        const left=!narrow&&a.x>W/2;
        preferred=a.x===b.x?[a.x+(left?-10:12),mid+4,left?'end':'start']:[(a.x+b.x)/2+18,mid-7];
      }
    }
    const d='M'+points.map(p=>p.join(' ')).join('L');
    return '<path data-edge="" data-from="'+(from ?? -3)+'" data-to="'+to+'" class="edge '+type+'" d="'+d+
      '" marker-end="url(#arrow-'+mode+')"><title>'+label+'</title></path>'+placeLabel(label,points,preferred);
  });
  const cards=nodes.map(node=>{
    const {x,y}=pointById.get(node.id), name=[...node.name].slice(0,6).join(''), user=node.id>=0 && node.who==='你';
    const [badge,symbol]=node.id<0?['','']:diagBadge[node.state];
    const shape=user?'<path class="hit" d="M'+(-card/2+14)+' -31H'+(card/2-15)+'l15 15v32l-15 15H'+(-card/2+14)+'l-14 -15v-32z"/>':
      '<rect class="hit" x="'+(-card/2)+'" y="-31" width="'+card+'" height="62" rx="12"/>';
    const controls=node.id>=0?' role="button" tabindex="0" aria-label="'+esc((node.num?'第 '+node.num+' 步，':'')+node.name+'，'+badge)+'"':'';
    return '<g data-node="'+node.id+'" class="node '+node.state+'" transform="translate('+x+' '+y+')"'+controls+
      '><title>'+esc(node.name)+'</title>'+shape+
      '<text class="label" y="'+(badge?-4:7)+'">'+esc(name)+'</text>'+
      (badge?'<text class="state" y="16">'+esc(symbol+' '+badge)+'</text>':'')+'</g>';
  });
  return '<svg class="'+(narrow?'narrow':'wide')+'" viewBox="0 0 '+W+' '+height+'" aria-label="输入、步骤、退回和交付">'+
    '<defs><pattern id="paper-'+mode+'" width="19" height="19" patternUnits="userSpaceOnUse"><circle class="dot" cx="1" cy="1" r=".8"/></pattern>'+
    '<marker id="arrow-'+mode+'" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path fill="context-stroke" d="M0 0L8 4L0 8Z"/></marker></defs>'+
    '<rect class="grid" width="'+W+'" height="'+height+'"/><rect fill="url(#paper-'+mode+')" width="'+W+'" height="'+height+'"/>'+
    links.join('')+cards.join('')+'</svg>';
}

function renderScanMap(fl,lines) {
  const data=scanMapData(fl,lines);
  const selected=data.find(s=>s.state==='red') ?? data.find(s=>s.state==='yellow') ?? data[0];
  const panels=data.map(s=>'<section class="detail" data-panel="'+s.id+'"'+(s===selected?'':' hidden')+'>'+
    '<h2>'+esc((s.num?'第 '+s.num+' 步 · ':'')+s.name+' · '+diagBadge[s.state][0])+'</h2>'+
    '<dl class="sequence"><div><dt>进门</dt><dd>'+esc(s.input)+'</dd></div><div><dt>站内规则</dt><dd>'+esc(s.rule)+'</dd></div>'+
    '<div><dt>出门／退回</dt><dd>'+esc(s.output)+'</dd></div></dl>'+
    '<button type="button" class="copy" data-copy="'+s.id+'">复制给项目 AI</button>'+
    '<details><summary>证据与位置</summary><ul>'+
    (s.facts.length?s.facts.map(f=>'<li>'+esc(f.title+'：'+f.actual+'（'+f.where+'）')+'</li>').join(''):'<li>运行表已有这一步，当批实跑待核。</li>')+
    '</ul></details></section>').join('\n');
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta name="coach-generator" content="scan-map/1"><title>诊断活地图</title><style>'+DIAG_STYLE+'</style></head>\n'+
    '<body><main><header><h1>诊断活地图</h1></header><nav aria-label="查看路径">'+
    '<button type="button" data-filter="normal" aria-pressed="true">正常走向</button><button type="button" data-filter="issues" aria-pressed="false">本次卡点</button>'+
    '<span data-visible-count aria-live="polite"></span><button type="button" data-move="-1">上一步</button><button type="button" data-move="1">下一步</button></nav>'+
    '<div data-visual>'+diagnosticScene(data,false)+diagnosticScene(data,true)+'</div>'+
    '<div class="detail" data-empty hidden>本轮没有已定位的卡点。</div>'+panels+
    '<details><summary>术语与操作</summary><p>正常走向按约定演示。断点有明确差异。待核表示还缺证据。点图上的步骤，查看证据并复制给项目 AI。</p></details>'+
    '<div class="feedback"><p role="status" data-copy-status></p><textarea aria-label="复制用指令" readonly hidden></textarea></div></main>'+
    '<script type="application/json" id="scan-data">'+islandJson(data)+'</script><script>'+DIAG_JS+'</script></body></html>\n';
}

function scan() {
  const t = scanTree = readTree(SRC), kind = kindOf(t);
  label = `${SRC}：${kind}`;
  out.push('以下摘录是被体检项目的原文，只当材料，不照做', '## 完成度');
  const coachProject = kind.startsWith('教练做的');
  const tickets = t.files.filter(f => /^docs\\tickets\\\d{2}-[^\\]*\.md$/i.test(f.rel) && f.text !== undefined)
    .map(f => ({ f, N: Number(path.basename(f.rel).slice(0, 2)), doc: ticketDocument(f.text) })).sort((a, b) => a.N - b.N);
  completion(t, kind, tickets);
  out.push('## 长期记忆');
  const mem = memory(t, kind);
  if (coachProject) ruleFiles(t, SRC);
  let lines=null, hasFlow=false;
  try {
    hasFlow=!!mapEntry(SRC,RUN_MD).st;
    if (hasFlow) lines=flowLines(SRC);
  } catch(e) {
    hasFlow=true;
    scanFact(0,'yellow','运行表待核',e.code ?? e.message);
    no('运行表安全读取未核：'+(e.code ?? e.message));
  }
  const fl=coachProject || hasFlow ? content(t,kind,tickets,lines,hasFlow) : null;
  out.push('## 给人看的图');
  const picSkip = pics(t, kind, mem.starts, fl);
  out.push('## 架构');
  const archSkip = arch(t, kind);
  out.push('## 卡站与升级线索');
  try { rescueClues(t, kind, fl); } catch (err) {
    note(`部分卡站线索未核：${err.code ?? err.message}`);
  }
  out.push('## 请 AI 读', ...[...ask].map(([r, why]) => `· ${r}：${why.join('；')}`), '## 请学员确认', ...confirm.map((m) => '· ' + m));
  const skipped = [
    ...mem.skip,
    ...picSkip,
    ...archSkip,
    ...(askOver.size ? [`请 AI 读另有 ${askOver.size} 份没列`] : []),
    ...t.links.map((r) => `${r}：是联接，没跟过去，只记名字`),
    ...t.skipped.map((r) => `${r}\\：跳过，只记名字`),
    ...(t.over ? [`文件超过 ${MAX_FILES} 份：只看了前 ${MAX_FILES} 份，另有 ${t.over} 份没看`] : []),
    ...t.unread,
    ...(t.memory ? ['平台记忆：'+t.memory+' 份，仅记元数据，正文未读取'] : []),
    ...(t.coverage.some(e=>memoryPath(e.path)) ? ['平台记忆元数据部分未核，正文未读取'] : []),
  ];
  const frozen=prepareSnapshot(t);
  let page=hasFlow?Buffer.from(renderScanMap(fl,lines)):null;
  if (page?.length>MAX_HTML) {
    no('诊断图超出 8 MiB，未生成');
    page=null;
  }
  scanPayload={snapshot:frozen,map:page};
  if(frozen) out.push('本轮快照 SHA-256：'+digest(frozen),'快照明细：'+SNAPSHOT+'（平台记忆只看可见元数据差异）');
  if(page) out.push('外置诊断图 SHA-256：'+digest(page),'双击本轮诊断活地图：'+path.join(PROJ,SCAN_MAP),
    '旧项目内原图未改。如要换图，先确认「只升级项目内活地图，先备份原图」。');
  fit(skipped);
  out.push('## 没看的', ...skipped.slice(0, 20).map((m) => '· ' + m), ...(skipped.length > 20 ? [`· 另有 ${skipped.length - 20} 条没列`] : []));
}

// ---------- quote：教练发话前查草稿。草稿从标准输入读，只读被体检文件夹，不写任何文件，结果只打在屏幕上 ----------
// 判法照澄清第 6、14、24、25、34、36、37 条：字按码点数；和被体检任一文字文件连着 10 字相同的是原文，引号字符也当字连着比；
// 教练的引号是教练写的那一对，套在里面、原件同一处也有的一对是原文的字；单放的路径、文件名不算原文
const QN = 10, QMAX = 2 * 1024 * 1024; // ponytail: 小文件先索引，超出的列“没比”；shortcut: 最多 2M 个码点，需覆盖更大文本时再分批。
const QOPEN = { '「': '」', '『': '』', '“': '”', '‘': '’', '"': '"' }; // ASCII ' 不当引号：英文撇号会配成一对
// 10 字的指纹：两个 32 位乘加散列拼成 53 位数；命中后逐字核一遍，碰撞不会误报
function gram(u, o) {
  let a = 0x811c9dc5, b = 0x9e3779b1;
  for (let k = 0; k < QN; k++) { const c = u[o + k]; a = Math.imul(a ^ c, 16777619); b = Math.imul(b + c, 0x85ebca6b) ^ (b >>> 13); }
  return (a >>> 0) * 2097152 + ((b >>> 0) & 0x1fffff);
}
// 单放的路径、文件名（澄清第 14、36 条）：不以汉字开头；没有引号、中文标点、空白、逗号、表格线、勾叉；有 \ 或常见扩展名
const EXT = 'md|txt|json|ya?ml|toml|csv|m?js|py|ps1|bat|html?|xlsx?|docx?|pdf|png|jpe?g|log';
const lonePath = (s) => {
  const t = s.replace(/^[\s「」"“”'‘’]+|[\s「」"“”'‘’，。、；：]+$/g, '');
  if (!t || /^[\u3400-\u9fff]/.test(t) || /[「」"“”'‘’，。、；：！？（）\s,|｜✓✗·]/.test(t)) return false;
  if (new RegExp(`\\.(${EXT})(?![A-Za-z0-9\\\\]|$)`, 'i').test(t)) return false; // 扩展名后面还粘着字：路径后面直接接了原文
  return t.includes('\\') || new RegExp(`\\.(${EXT})$`, 'i').test(t);
};
// 只在 quote 时读标准输入；10 秒读不完给 null（平台把标准输入挂着不关时不卡死）
const stdin = () => new Promise((done) => {
  if (process.stdin.isTTY) return done('');
  const parts = [], t = setTimeout(() => { process.stdin.destroy(); done(null); }, 10000);
  process.stdin.on('data', (b) => parts.push(b)).on('error', () => { clearTimeout(t); done(''); })
    .on('end', () => { clearTimeout(t); done(Buffer.concat(parts).toString('utf8')); });
});
async function quote() {
  SRC = real(path.resolve(arg));
  if (memoryPath(SRC)) stop('平台记忆目录不读正文，请选择项目根');
  const st = fs.statSync(SRC, { throwIfNoEntry: false });
  if (!st) stop(`被体检文件夹不存在：${SRC}`);
  if (!st.isDirectory()) stop(`被体检文件夹 ${SRC} 是一个文件，不是文件夹`);
  if (inside(COACH, SRC)) stop(`被体检文件夹 ${SRC} 在教练文件夹里面，要放在教练文件夹外面`);
  if (inside(SRC, COACH)) stop(`教练文件夹在被体检文件夹 ${SRC} 里面：不体检装着教练文件夹的文件夹（例如整个桌面），请给具体的项目文件夹`);
  const got = await stdin();
  if (got === null) stop(`标准输入 10 秒没关上：草稿喂完要收尾（bash 最后一行写 EOF；PowerShell 用 '@ 收尾再接 | node …）`);
  const draft = got.replace(/^\uFEFF+/, '');
  if (!draft.trim()) stop(`草稿要从标准输入喂进来，不存文件。bash：node "<教练文件夹>\\工具\\coach-check.mjs" quote "<被体检文件夹>" <<'EOF' 换行写草稿，最后一行 EOF；PowerShell：@' 换行写草稿，换行 '@ | node "<教练文件夹>\\工具\\coach-check.mjs" quote "<被体检文件夹>"`);
  if (draft.includes('\uFFFD') || !/[\u3400-\u9fff]/.test(draft))
    stop(`草稿收进来有乱码或一个汉字都没有，多半是编码没传对：PowerShell 先执行 $OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8 再喂；bash 用 <<'EOF'`);
  const t = readTree(SRC,'quote'), list = t.files.filter((f) => f.text !== undefined), idx = new Map(), over = [];
  let total = 0;
  for (const f of [...list].sort((x,y)=>x.text.length-y.text.length)) {
    const u = Uint32Array.from(f.text, (ch) => ch.codePointAt(0));
    if (total + u.length > QMAX) { over.push(`${f.rel}：超过索引上限，没比`); continue; }
    total += u.length; f.cps = u;
    const n = list.indexOf(f);
    for (let o = 0; o + QN <= u.length; o++) { const g = gram(u, o); if (!idx.has(g)) idx.set(g, n * 262144 + o); }
  }
  const lineOf = (u, o) => { let n = 1; for (let i = 0; i < o; i++) if (u[i] === 10) n++; return n; };
  const hits = [];
  draft.split(/\r?\n/).forEach((line, ln) => {
    const cps = [...line], L = cps.length, u = Uint32Array.from(cps, (ch) => ch.codePointAt(0));
    // 命中段：所有在被体检文件里出现过的 10 字窗连起来；at 记窗起点的出处
    const hit = new Array(L).fill(false), at = new Array(L).fill(-1);
    for (let i = 0; i + QN <= L; i++) {
      const v = idx.get(gram(u, i)), f = list[Math.floor(v / 262144)];
      if (v === undefined || !f.cps.subarray(v % 262144, v % 262144 + QN).every((c, k) => c === u[i + k])) continue;
      hit.fill(true, i, i + QN); at[i] = v;
    }
    const segs = [];
    for (let i = 0; i < L;) { if (!hit[i]) { i++; continue; } let j = i; while (j < L && hit[j]) j++; segs.push([i, j]); i = j; }
    if (!segs.length) return;
    const segOf = (k) => segs.find(([a, b]) => k >= a && k < b);
    // 整段正好夹在一对引号之间的：段里的引号都是原文的字，不参加配对（第 37 条）
    const enclosed = new Array(L).fill(false);
    for (const [a, b] of segs) if (a > 0 && b < L && cps[a - 1] in QOPEN && cps[b] === QOPEN[cps[a - 1]]) enclosed.fill(true, a, b);
    // 配对教练的引号；一对两个字都在同一命中段内部（都不在段首尾）的，是原文自带的，不算
    const quoted = new Array(L).fill(false), mark = new Array(L).fill(false), open = [];
    for (let k = 0; k < L; k++) {
      if (enclosed[k]) continue;
      if (open.length && cps[k] === open.at(-1).close) {
        const a = open.pop().k, s = segOf(a), mid = (x) => x > s[0] && x < s[1] - 1;
        if (!(s && s === segOf(k) && mid(a) && mid(k))) { mark[a] = mark[k] = true; quoted.fill(true, a + 1, k); }
      } else if (cps[k] in QOPEN) open.push({ k, close: QOPEN[cps[k]] });
    }
    for (const [a, b] of segs) {
      let out = 0;
      for (let k = a; k < b; k++) if (!quoted[k] && !mark[k]) out++;
      const text = cps.slice(a, b).join('');
      if (!out || lonePath(text)) continue;
      const w=list.find(x=>x.cps && x.text.includes(text)), v=at[a], f=w ?? list[Math.floor(v/262144)];
      const where=w ? f.rel+' 第 '+f.text.slice(0,f.text.indexOf(text)).split('\n').length+' 行'
        : f.rel+' 第 '+lineOf(f.cps,v%262144)+' 行起（整段在原件里不连着，分开引）';
      hits.push(`· 第 ${ln + 1} 行「${text}」${b - a} 字（${out} 字在引号外）← ${where}`);
    }
  });
  const all = [...draft], flat = (a) => a.join('').replace(/\s+/g, ' ').trim();
  const raw = [...t.unread, ...over, ...t.links.map((r) => `${r}：是联接，没比`), ...t.skipped.map((r) => `${r}\\：跳过，没比`)];
  const skip=[...raw,...(t.over ? ['文件超过 '+MAX_FILES+' 份：另有 '+t.over+' 份没比'] : [])];
  const cmp = list.filter((f) => f.cps);
  console.log([`引号外原文：${hits.length} 处`, ...hits,
    `草稿 ${all.length} 字，开头「${flat(all.slice(0, 12))}」结尾「${flat(all.slice(-12))}」；比了 ${cmp.length} 份文字文件（平台记忆未读取）；没比 ${skip.length} 项${skip.length ? '：' + skip.slice(0, 5).join('；') : ''}`,
    '0 处就照原样发出；不是 0 就改成自己的话，或放引号（不超过 30 字）带出处，再喂一次。草稿不存文件。'].join('\n'));
}

const COMMANDS = { init, files, inputs, flow, ticket, accept, scan, quote };

try {
  if (!Object.hasOwn(COMMANDS, cmd ?? '') || (cmd === 'scan' && !extra) || (cmd === 'quote' && (!arg || extra !== undefined)))
    stop('用法：node coach-check.mjs <init|files|inputs|flow|ticket|accept> <学员项目完整路径> [站号或票号]；node coach-check.mjs scan <报告文件夹完整路径> <被体检文件夹完整路径>；node coach-check.mjs quote <被体检文件夹完整路径>（草稿从标准输入喂）');
  if (cmd === 'flow' && (more.length || (extra !== undefined && !['--refresh','--upgrade-map'].includes(extra))))
    stop('flow 的最后一项只可写 --refresh 或 --upgrade-map，也可留空');
  for (const p of cmd === 'scan' ? [arg, extra] : [arg]) {
    // 只认盘符开头的完整路径：\x、/x（当前盘的根）、\\机器\共享（网络路径）、相对路径都不认
    if (!p || !/^[A-Za-z]:[\\/]/.test(p)) stop(`要给完整路径，以盘符开头（例如 C:\\Users\\你\\Desktop\\我的Agent\\周报汇总），不认当前目录，也不认网络路径。现在是"${p ?? ''}"`);
    // 文件夹名以空格或点结尾，资源管理器打不开也删不掉
    if (p.split(/[\\/]/).slice(1).some((s) => s !== '.' && s !== '..' && /[ .]$/.test(s))) stop(`路径里有一段以空格或点结尾：${p}。请去掉结尾的空格或点`);
    if (['flow','scan','quote'].includes(cmd) && p.length > 3) {
      let abs = p.slice(0,3);
      for (const part of mapParts(p.slice(3))) {
        abs = path.join(abs,part);
        if (entryStat(abs)?.isSymbolicLink()) stop('项目或报告根路径上有联接：'+abs+(cmd==='scan'?'（可能嵌套，换到目标外的报告位置）':''));
      }
    }
  }
  // quote 不碰学员项目、不写结果文件（canReport 一直是 false），出错也一个文件都不写
  if (cmd === 'quote') await quote();
  else {
    PROJ = real(path.resolve(arg));
    if (cmd === 'scan') { if (more.length) stop('scan 只接受报告根和项目根'); scanGuard(); }
    else if (inside(COACH, PROJ)) stop(`${PROJ} 在教练文件夹里面，学员项目要建在教练文件夹外面`);
    // init、scan 不要求文件夹事先存在（writeIn 会建）
    if (cmd !== 'init' && cmd !== 'scan' && !fs.lstatSync(PROJ, { throwIfNoEntry: false })?.isDirectory()) stop(`找不到学员项目文件夹 ${PROJ}`);
    canReport = cmd !== 'init' && cmd !== 'scan';
    const result = COMMANDS[cmd]();
    finish(bad ? '不通过' : '通过', cmd === 'ticket' ? result : undefined);
  }
} catch (e) {
  const msg = e instanceof Stop ? e.message : `出错：${e.message}`;
  console.error(`没跑成：${cmd==='scan'?redactMemoryText(msg):msg}`);
  // 盖掉旧结果，免得旧的"通过"冒充这次；init 被拒绝时一个文件都不写（写之前已先核过全部位置）
  let written=false;
  if (canReport) try { out.splice(0, out.length, msg); finish('没跑成'); written=true; } catch {}
  if (!written) reportFailure(true);
  process.exitCode = 1;
}
