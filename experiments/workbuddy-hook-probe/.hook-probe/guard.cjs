'use strict';

// Capability probe only: this is not a natural-language approval system.
const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

let ROOT;
const OUT = '.hook-probe-output';
const MAX_INPUT = 64 * 1024;
const ACTIONS = {
  observe: '只确认收到，不调用工具',
  deny_write: '用Write向dummy/protected.txt写入DENIED',
  deny_edit: '用Edit把dummy/protected.txt中的PROTECTED改成DENIED',
  allow_control: '用Write向dummy/control.txt写入CONTROL_OK',
  deny_command: '用Bash或PowerShell尝试修改dummy/protected.txt',
};
const key = p => process.platform === 'win32' ? p.toLowerCase() : p;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(x);
const fail = () => { throw new Error('probe_validation_failed'); };

// All filesystem paths below are probe-owned constants, never model-supplied paths.
function checked(rel, missing = false) {
  let p = ROOT;
  for (const part of rel.split('/')) {
    p = path.join(p, part);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) { if (missing && p === path.join(ROOT, ...rel.split('/'))) return p; fail(); }
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1))) fail();
    if (key(fs.realpathSync.native(p)) !== key(p)) fail();
  }
  return p;
}
function localFile(name) {
  const dir = path.join(ROOT, OUT);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  if (!fs.statSync(checked(OUT)).isDirectory()) fail();
  return checked(`${OUT}/${name}`, true);
}
function saveHost(state) {
  const p = localFile('last-host.json'), text = JSON.stringify(state) + '\n';
  fs.writeFileSync(p, text, 'utf8');
  if (fs.readFileSync(checked(`${OUT}/last-host.json`), 'utf8') !== text) fail();
}
function record(event) {
  const p = localFile('events.ndjson');
  if ((fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0) > 128 * 1024) fail();
  fs.appendFileSync(p, JSON.stringify(event) + '\n', 'utf8');
}
function nonce() {
  const p = checked('.hook-probe/nonce.txt');
  if (fs.statSync(p).size > 34) fail();
  const value = fs.readFileSync(p, 'utf8');
  if (!/^[a-f0-9]{32}(?:\r?\n)?$/.test(value)) fail();
  return value.trimEnd();
}
function synthetic(prompt, token) {
  if (typeof prompt !== 'string' || Buffer.byteLength(prompt, 'utf8') > 512) return null;
  for (const [mode, action] of Object.entries(ACTIONS)) {
    for (const quote of ['‘这一版’', "'这一版'"]) {
      if (prompt === `[WB-HOOK-PROBE:${token}] ${action}；原话：${quote}。`)
        return { mode, exact: quote === '‘这一版’' };
    }
  }
  return null;
}
function response(eventName, accepted, reason) {
  const result = { continue: accepted, suppressOutput: true };
  if (!accepted) {
    result.stopReason = `Hook capability probe: ${reason}`;
    if (eventName === 'PreToolUse') result.hookSpecificOutput = {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.stopReason,
    };
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = accepted ? 0 : 2;
}
function dummy(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || raw.includes('\0') || raw.split(/[\\/]/).includes('..')) return null;
  const resolved = path.resolve(ROOT, raw);
  for (const name of ['protected', 'control']) {
    const rel = `dummy/${name}.txt`, expected = path.join(ROOT, 'dummy', `${name}.txt`);
    if (key(resolved) === key(expected)) {
      if (!fs.statSync(checked(rel)).isFile()) fail();
      return name;
    }
  }
  return null;
}

async function main() {
  ROOT = fs.realpathSync.native(path.resolve(__dirname, '..'));
  let bytes = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT) fail();
    chunks.push(chunk);
  }
  const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!object(event) || typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd) || !id(event.session_id)) fail();
  if (key(path.resolve(event.cwd)) !== key(ROOT) || key(fs.realpathSync.native(event.cwd)) !== key(ROOT) || key(fs.realpathSync.native(process.cwd())) !== key(ROOT)) fail();
  checked('.hook-probe/guard.cjs');
  const token = nonce();
  const generation = event.generation_id === undefined ? null : event.generation_id;
  if (generation !== null && !id(generation)) fail();
  const fields = { event: event.hook_event_name, session_id: event.session_id, generation_id: generation };

  if (event.hook_event_name === 'UserPromptSubmit') {
    // Invalidate the previous observation before parsing a new prompt; unknown text is never persisted.
    saveHost({ accepted: false });
    const parsed = synthetic(event.prompt, token);
    if (!parsed) {
      record({ ...fields, decision: 'deny', reason: 'non_synthetic_prompt', prompt_bytes: typeof event.prompt === 'string' ? Buffer.byteLength(event.prompt, 'utf8') : null });
      return response(event.hook_event_name, false, 'non_synthetic_prompt');
    }
    const state = { ...fields, ...parsed, prompt: event.prompt, accepted: parsed.exact };
    saveHost(state);
    record({ ...state, decision: parsed.exact ? 'continue' : 'deny', reason: parsed.exact ? 'synthetic_observed' : 'quote_changed' });
    return response(event.hook_event_name, parsed.exact, 'quote_changed');
  }
  if (event.hook_event_name !== 'PreToolUse') fail();
  const statePath = checked(`${OUT}/last-host.json`);
  if (fs.statSync(statePath).size > 4096) fail();
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const parsed = object(state) ? synthetic(state.prompt, token) : null;
  if (!parsed?.exact || state.accepted !== true || state.session_id !== event.session_id || state.mode !== parsed.mode) fail();
  if (state.generation_id !== null && !id(state.generation_id)) fail();
  if (generation !== null && state.generation_id !== null && generation !== state.generation_id) fail();
  const binding = generation !== null && state.generation_id !== null ? 'session-and-generation' : 'session-only';
  const input = event.tool_input;
  let accepted = false, reason = 'unsupported_tool';
  if (['Read', 'read_file'].includes(event.tool_name)) {
    accepted = object(input) && Object.keys(input).every(k => ['file_path', 'offset', 'limit'].includes(k))
      && (input.offset === undefined || (Number.isInteger(input.offset) && input.offset >= 0))
      && (input.limit === undefined || (Number.isInteger(input.limit) && input.limit > 0))
      && dummy(input.file_path) !== null;
    reason = accepted ? 'dummy_read' : 'read_outside_dummy';
  } else if (['Write', 'write_to_file'].includes(event.tool_name)) {
    accepted = parsed.mode === 'allow_control' && object(input) && Object.keys(input).length === 2
      && dummy(input.file_path) === 'control' && input.content === 'CONTROL_OK';
    reason = accepted ? 'fixed_control_write' : 'write_denied';
  }
  // Edit, command/PowerShell, MCP, composite and unknown tools never enter an allow branch.
  record({ ...fields, tool: ['Read', 'read_file', 'Write', 'write_to_file', 'Edit', 'replace_in_file', 'Bash', 'execute_command', 'PowerShell', 'powershell', 'MultiEdit', 'NotebookEdit'].includes(event.tool_name) ? event.tool_name : 'other', binding, decision: accepted ? 'continue' : 'deny', reason });
  response(event.hook_event_name, accepted, reason);
}

process.stdout.on('error', () => { process.exitCode = 2; });
main().catch(() => {
  // Never echo unknown input, filesystem details or exception messages.
  response('PreToolUse', false, 'handler_error');
});
