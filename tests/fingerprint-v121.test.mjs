import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../工具/coach-check.mjs', import.meta.url));
const windows = { skip: process.platform !== 'win32' };
const heading = '## 验收单（第 1 版）';
const sheet = [heading, '- 预期值来源：样例清点确认：样例有 12 行', '### AI 自检',
  '- work\\01-结果.txt 含 12', '- work\\01-坏输入\\结果.txt 含 已拦截'].join('\n');
const edited = sheet.replace('结果.txt 含 12', '结果.txt 含 15');
const confirmed = '- 第 1 次确认（第 1 版）：2026-11-18｜就这样跑';
const digest = (body) => createHash('sha256').update(body).digest('hex') + '\n';

function project(t, version = 'v1.21') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-fingerprint-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function put(rel, text) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  put('docs/PROJECT_INDEX.md', (version ? '搭建教练版本：' + version + '\n' : '') + '当前站：4 一步一票\n');
  put('docs/run-flow.md', ['## 运行表', '| 第几步 | 谁做 | 从哪拿 | 做什么 | 放到哪 | 你要判断什么 |',
    '|---|---|---|---|---|---|', '| 1 | AI照规矩 | 输入 1 | 认出输入 | work\\01-结果.txt | — |'].join('\n'));
  put('work/01-结果.txt', '12\n');
  put('work/01-坏输入/结果.txt', '已拦截\n');

  function ticket(body = sheet, confirmation = '') {
    put('docs/tickets/01-认出输入.md', ['\uFEFF# 票 01：认出输入', '## 这一步', body,
      '## 确认记录', confirmation, '## 结果'].join('\n'));
  }
  function check(command, verdict, detail) {
    execFileSync(process.execPath, [checker, command, root, '01']);
    const report = fs.readFileSync(path.join(root, 'docs/check/' + command + '.txt'), 'utf8');
    assert.equal(report.split(/\r?\n/, 1)[0].split('｜').at(-1), verdict, report);
    if (detail) assert.match(report, detail);
  }
  function fingerprint(v = 1) {
    const file = path.join(root, 'docs/check/ticket-01-v' + v + '.sha256');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  }
  return { ticket, check, fingerprint, put };
}

test('确认后同版改预期值，即使产物也改成新值，accept 仍拒绝', windows, (t) => {
  const p = project(t);
  p.ticket();
  p.check('ticket', '通过');
  p.ticket(sheet, confirmed);
  p.check('accept', '通过');
  p.ticket(edited, confirmed);
  p.put('work/01-结果.txt', '15\n');
  p.check('accept', '不通过', /票 01 第 1 版验收单在确认\/预检后被改过，请恢复原验收单或升为第 2 版重新请学员确认/);
});

test('已快跑确认的版本重跑 ticket，拒绝覆盖原指纹', windows, (t) => {
  const p = project(t);
  p.ticket();
  p.check('ticket', '通过');
  const original = p.fingerprint();
  p.ticket(edited, confirmed.replace('就这样跑', '按快跑档推进'));
  p.check('ticket', '不通过', /第 1 版已确认，改验收单须升为第 2 版/);
  assert.equal(original, digest(sheet));
  assert.equal(p.fingerprint(), original);
});

test('未确认可更新指纹，无效草案不得覆盖最后一次成功预检', windows, (t) => {
  const p = project(t);
  p.ticket();
  p.check('ticket', '通过');
  assert.equal(p.fingerprint(), digest(sheet));
  p.ticket(edited, confirmed.replace('就这样跑', '<学员原话>'));
  p.check('ticket', '通过');
  assert.equal(p.fingerprint(), digest(edited));
  p.ticket(edited.replace('### AI 自检', '### 待补'));
  p.check('ticket', '不通过');
  assert.equal(p.fingerprint(), digest(edited));
});

test('缺版本行及旧项目：已确认的无指纹票可验收，并明示未核正文', windows, (t) => {
  for (const version of ['', 'v1.20', 'v0.99']) {
    const p = project(t, version);
    p.ticket(sheet, confirmed);
    for (const cmd of ['ticket', 'accept']) {
      p.check(cmd, '通过', /· 第 1 版验收单没有预检指纹（旧票或手写），本次未核正文是否改过/);
      assert.equal(p.fingerprint(), null);
    }
  }
});

test('v1.21 和更高版本：已确认却缺预检指纹，accept 和 ticket 都拒绝且不补建', windows, (t) => {
  for (const version of ['v1.21', 'v1.100', 'v2.0']) {
    const p = project(t, version);
    p.ticket(sheet, confirmed);
    for (const cmd of ['accept', 'ticket']) {
      p.check(cmd, '不通过', /第 1 版已确认但缺预检指纹：请升为第 2 版，跑 ticket 后重新请学员确认/);
      assert.equal(p.fingerprint(), null);
    }
  }
});

test('升版只核最新验收单，换行、行尾空白以及节外内容不影响指纹', windows, (t) => {
  const p = project(t);
  p.ticket();
  p.check('ticket', '通过');
  const v2 = edited.replace(heading, '## 验收单（第 2 版）');
  p.ticket(sheet + '\n' + v2, confirmed);
  p.check('ticket', '通过');
  assert.equal(p.fingerprint(2), digest(v2));
  assert.equal(p.fingerprint(1), digest(sheet));
  const formatted = v2.split('\n').map((line) => line + ' \t').join('\r\n') + '\r\n\r\n';
  p.ticket(sheet.replace('12 行', '原版记载') + '\n' + formatted, confirmed.replace('第 1 版', '第 2 版'));
  p.put('work/01-结果.txt', '15\n');
  p.check('ticket', '通过');
  p.check('accept', '通过');
  assert.equal(p.fingerprint(2), digest(v2));
});
