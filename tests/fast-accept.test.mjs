import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../工具/coach-check.mjs', import.meta.url));

test('快跑单口令仅接受当前批次中没有人工停点的纯脚本票', { skip: process.platform !== 'win32' }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coach-fast-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  function write(rel, text) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  write('scripts/01_认出输入.js', '// fixture\n');
  write('work/01-结果.txt', '12\n');
  write('work/01-坏输入/结果.txt', '已拦截\n');

  function verify(expected, overrides = {}) {
    const opts = {
      scope: '01@1、02@1', version: 1, station: '4 一步一票', who: 'AI照规矩', second: 'AI照规矩',
      judge: '—', method: '写程序（scripts\\01_认出输入.js）', phrase: '按快跑档推进',
      date: '2026-11-12', badResult: '已拦截', ...overrides,
    };
    write('work/01-坏输入/结果.txt', opts.badResult);
    write('docs/PROJECT_INDEX.md', [
      '当前站：' + opts.station, '## 已确认',
      '- 快跑批次：2026-11-12｜01@1｜按快跑档推进',
      '- 快跑批次：2026-11-12｜' + opts.scope + '｜按快跑档推进',
    ].join('\n'));
    write('docs/run-flow.md', [
      '## 运行表', '| 第几步 | 谁做 | 从哪拿 | 做什么 | 放到哪 | 你要判断什么 |',
      '|---|---|---|---|---|---|',
      '| 1 | ' + opts.who + ' | 输入 1 | 认出输入 | work\\01-结果.txt | ' + opts.judge + ' |',
      '| 2 | ' + opts.second + ' | work\\01-结果.txt | 汇总 | output\\结果.txt | — |',
    ].join('\n'));
    write('docs/tickets/01-认出输入.md', [
      '# 票 01：认出输入', '## 这一步（照运行表第 1 行）', '怎么做：' + opts.method,
      '## 验收单（第 ' + opts.version + ' 版）', '- 预期值来源：样例清点确认：样例有 12 行', '### AI 自检',
      '- work\\01-结果.txt 含 12', opts.skipBad ? '' : '- work\\01-坏输入\\结果.txt 含 已拦截', '## 确认记录',
      '- 第 1 次确认（第 1 版）：' + opts.date + '｜' + opts.phrase,
    ].join('\n'));
    const r = spawnSync(process.execPath, [checker, 'accept', dir, '01'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const report = fs.readFileSync(path.join(dir, 'docs/check/accept.txt'), 'utf8');
    assert.equal(report.split(/\r?\n/)[0].endsWith('｜通过'), expected, JSON.stringify(overrides) + '\n' + report);
  }

  verify(true);
  for (const invalid of [
    { scope: '02@1' }, { scope: '01@2' }, { scope: '01@1、03@1' }, { scope: '' },
    { date: '2026-11-11' }, { version: 2 }, { who: 'AI看情况' }, { who: '你' },
    { second: '你' }, { judge: '看数据｜对金额｜不对退回第1步' }, { method: 'AI 亲自做' },
    { method: '写程序（scripts\\01_不存在.js）' }, { station: '已结束（停止）' },
    { phrase: '继续' }, { phrase: '按快跑档推进，就这样跑', scope: '' }, { skipBad: true }, { badResult: '漏过坏输入' },
  ]) verify(false, invalid);
  verify(true, { phrase: '就这样跑', scope: '', who: 'AI看情况', method: 'AI 亲自做' });
  verify(false, { phrase: '票 01 验收单确认', scope: '' });
});
