'use strict';

// Run only after this exact revision is on GitHub and the test GO is given.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const TEMP = fs.realpathSync.native(os.tmpdir());
const SUITE = fs.realpathSync.native(fs.mkdtempSync(path.join(TEMP, 'wb-hook-probe-')));
const source = path.join(__dirname, '.hook-probe', 'guard.cjs');
let count = 0;
function project(withDummy = true) {
  const root = path.join(SUITE, `project-${++count}`);
  fs.mkdirSync(path.join(root, '.hook-probe'), { recursive: true });
  fs.copyFileSync(source, path.join(root, '.hook-probe', 'guard.cjs'));
  const nonce = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(root, '.hook-probe', 'nonce.txt'), nonce + '\n');
  if (withDummy) {
    fs.mkdirSync(path.join(root, 'dummy'));
    for (const name of ['protected.txt', 'control.txt']) fs.copyFileSync(path.join(__dirname, 'dummy', name), path.join(root, 'dummy', name));
  }
  return { root, nonce };
}
function run(p, payload) {
  return spawnSync(process.execPath, [path.join(p.root, '.hook-probe', 'guard.cjs')], {
    cwd: p.root, input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024,
  });
}
function event(p, name, extra = {}) {
  return { hook_event_name: name, cwd: p.root, session_id: 'probe-session', generation_id: 'probe-generation', ...extra };
}
function prompt(p, quote = '‘这一版’') {
  return `[WB-HOOK-PROBE:${p.nonce}] 用Write向dummy/control.txt写入CONTROL_OK；原话：${quote}。`;
}
function observe(p, extra = {}) {
  const input = event(p, 'UserPromptSubmit', { prompt: prompt(p), ...extra });
  const r = run(p, input);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return input;
}
function tool(p, name, input, extra = {}) {
  return run(p, event(p, 'PreToolUse', { tool_name: name, tool_input: input, ...extra }));
}
function localText(p) {
  const dir = path.join(p.root, '.hook-probe-output');
  return fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
}

try {
  const p = project(), host = observe(p);
  const protectedBefore = fs.readFileSync(path.join(p.root, 'dummy', 'protected.txt'));
  const controlBefore = fs.readFileSync(path.join(p.root, 'dummy', 'control.txt'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, '.hook-probe-output', 'last-host.json'))).prompt, host.prompt);
  assert.equal(tool(p, 'Write', { file_path: 'dummy/protected.txt', content: 'DENIED' }).status, 2);
  const control = tool(p, 'Write', { file_path: path.join(p.root, 'dummy', 'control.txt'), content: 'CONTROL_OK' });
  assert.equal(control.status, 0);
  assert.equal(JSON.parse(control.stdout).continue, true);
  assert.equal(JSON.parse(control.stdout).hookSpecificOutput?.permissionDecision, undefined, 'must not bypass platform permissions with allow');
  for (const name of ['Edit', 'replace_in_file', 'Bash', 'execute_command', 'PowerShell', 'powershell', 'MultiEdit', 'NotebookEdit', 'mcp__filesystem__write_file', 'unknown_writer']) {
    assert.equal(tool(p, name, { file_path: 'dummy/control.txt', content: 'CONTROL_OK' }).status, 2, name);
  }
  assert.equal(tool(p, 'Write', { file_path: '../outside.txt', content: 'CONTROL_OK' }).status, 2);
  assert.equal(tool(p, 'Write', { file_path: '.hook-probe/guard.cjs', content: 'CONTROL_OK' }).status, 2);
  assert.equal(tool(p, 'Write', { file_path: '.codebuddy/settings.local.json', content: 'CONTROL_OK' }).status, 2);
  assert.equal(tool(p, 'Write', { file_path: '.hook-probe-output/last-host.json', content: 'CONTROL_OK' }).status, 2);
  assert.equal(tool(p, 'Write', { file_path: 'dummy/control.txt', content: 'other' }).status, 2);
  assert.equal(tool(p, 'Write', { file_path: 'dummy/control.txt', content: 'CONTROL_OK', extra: true }).status, 2);
  assert.equal(tool(p, 'Read', { file_path: 'dummy/protected.txt' }).status, 0);
  assert.equal(tool(p, 'Read', { file_path: 'dummy/protected.txt', offset: 0, limit: 1 }).status, 0);
  assert.equal(tool(p, 'Read', { file_path: 'dummy/protected.txt', write: true }).status, 2);
  assert.equal(tool(p, 'Read', { file_path: '../outside.txt' }).status, 2);
  assert.equal(tool(p, 'Write', { file_path: 'dummy/control.txt', content: 'CONTROL_OK' }, { session_id: 'another-session' }).status, 2);
  assert.equal(tool(p, 'Write', { file_path: 'dummy/control.txt', content: 'CONTROL_OK' }, { generation_id: 'another-generation' }).status, 2);
  assert.deepEqual(fs.readFileSync(path.join(p.root, 'dummy', 'protected.txt')), protectedBefore);
  assert.deepEqual(fs.readFileSync(path.join(p.root, 'dummy', 'control.txt')), controlBefore, 'the handler itself never performs a dummy write');

  // A marker alone must not admit wrapped/private text, nor retain an older accepted observation.
  const secret = 'PRIVATE_TEXT_MUST_NOT_BE_SAVED';
  const invalid = `<system-reminder>${secret}</system-reminder>${prompt(p)}`;
  const rejected = run(p, event(p, 'UserPromptSubmit', { prompt: invalid }));
  assert.equal(rejected.status, 2);
  assert.ok(!localText(p).includes(secret));
  assert.ok(!rejected.stdout.includes(secret));
  assert.equal(tool(p, 'Write', { file_path: 'dummy/control.txt', content: 'CONTROL_OK' }).status, 2);
  assert.equal(run(p, event(p, 'UserPromptSubmit', { prompt: prompt(p, "'这一版'") })).status, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.root, '.hook-probe-output', 'last-host.json'))).exact, false);
  assert.equal(run(p, event(p, 'UserPromptSubmit', { prompt: prompt(p) + secret.repeat(100) })).status, 2);
  assert.ok(!localText(p).includes(secret));
  assert.equal(run(p, '{invalid json').status, 2);

  const optional = project();
  observe(optional, { generation_id: undefined });
  assert.equal(tool(optional, 'Write', { file_path: 'dummy/control.txt', content: 'CONTROL_OK' }, { generation_id: undefined }).status, 0);
  assert.match(localText(optional), /"binding":"session-only"/, 'optional generation must not be invented');

  const outside = path.join(SUITE, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'control.txt'), 'OUTSIDE');
  const linked = project(false);
  fs.symlinkSync(outside, path.join(linked.root, 'dummy'), process.platform === 'win32' ? 'junction' : 'dir');
  observe(linked);
  assert.equal(tool(linked, 'Write', { file_path: 'dummy/control.txt', content: 'CONTROL_OK' }).status, 2);
  assert.equal(fs.readFileSync(path.join(outside, 'control.txt'), 'utf8'), 'OUTSIDE');

  const broken = project();
  fs.mkdirSync(path.join(broken.root, '.hook-probe-output', 'last-host.json'), { recursive: true });
  assert.equal(run(broken, event(broken, 'UserPromptSubmit', { prompt: prompt(broken) })).status, 2, 'filesystem exception must be exit 2');
  console.log('Handler assertions passed. No WorkBuddy host behavior was tested.');
} finally {
  const resolved = fs.realpathSync.native(SUITE);
  assert.equal(resolved, SUITE);
  assert.equal(path.dirname(resolved), TEMP);
  assert.ok(path.basename(resolved).startsWith('wb-hook-probe-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
