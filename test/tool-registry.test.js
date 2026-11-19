import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadToolRegistry } from '../src/tool-registry.js';

const logger = { child() { return this; }, info() {}, error() {} };
function context(output = 'description') {
  const commands = [];
  return {
    commands, config: { idleCaptureMs: 10, firstResponseTimeoutMs: 50, searchTimeoutMs: 100 }, logger,
    mooSession: {
      async ensureConnectedAndLoggedIn() {},
      async runCommandCaptureUntilIdle(command) { commands.push(command); return { output }; },
      async runSearchCapture(command, idle, first, total, validate) {
        commands.push(command);
        const capture = { output, capture: { stop_reason: 'idle' } };
        this.retired = !validate(capture);
        return capture;
      }
    }
  };
}
const call = (registry, name, args = {}) => registry.callTool({ params: { name, arguments: args } });
const payload = result => JSON.parse(result.content[0].text);
async function configFile(t, config) {
  const dir = await mkdtemp(path.join(tmpdir(), 'moo-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'tools.json');
  await writeFile(configPath, JSON.stringify(config));
  return configPath;
}
const look = {
  name: 'look_at', description: 'Look at an object',
  inputSchema: { type: 'object', properties: { object: { type: 'string', pattern: '^#[0-9]+$' } }, required: ['object'], additionalProperties: false },
  command: ['look ', { argument: 'object', encoding: 'raw' }], response: 'text'
};

test('core catalog is generic; unavailable tools cannot be called', async () => {
  const ctx = context();
  const registry = await loadToolRegistry({ context: ctx });
  assert.deepEqual(registry.tools.map(tool => tool.name).sort(), ['run_moo_command', 'run_moo_eval']);
  assert.doesNotMatch(JSON.stringify(registry.tools), /VMS|kaiju|sindome|slither/i);
  await assert.rejects(call(registry, 'submit_bug'), /Unknown tool/);
  assert.equal(ctx.commands.length, 0);
});

test('Sindome example restores all original tools and preserves dispatch', async () => {
  const ctx = context('{"ok":1,"verbs":[]}');
  const registry = await loadToolRegistry({ configPath: fileURLToPath(new URL('../config/sindome.tools.json.example', import.meta.url)), context: ctx });
  assert.equal(registry.tools.length, 24);
  assert.equal(new Set(registry.tools.map(tool => tool.name)).size, 24);
  assert.ok(registry.tools.some(tool => tool.name === 'submit_bug'));
  const result = await call(registry, 'verbs-json', { arg: '#123' });
  assert.equal(result.isError, false);
  assert.deepEqual(ctx.commands, ['@verbs-json #123']);
  assert.equal((await call(registry, 'resolve-traceback', { id: '123' })).isError, true);
  assert.equal(ctx.commands.length, 1);
});

test('custom example validates schema before execution and quotes MOO string literals', async () => {
  const ctx = context();
  const registry = await loadToolRegistry({ configPath: fileURLToPath(new URL('../config/custom.tools.json.example', import.meta.url)), context: ctx });
  assert.equal(registry.tools.length, 4);
  assert.deepEqual(payload(await call(registry, 'look_at', { object: '#42' })), { output: 'description' });
  for (const args of [{}, { object: '#42', extra: true }, { object: '#42\n@shutdown' }, { object: 42 }]) {
    assert.equal((await call(registry, 'look_at', args)).isError, true);
  }
  assert.equal(ctx.commands.length, 1);
  await call(registry, 'search_catalog', { query: 'a "quote" \\ end' });
  assert.equal(ctx.commands[1], String.raw`; $catalog:search("a \"quote\" \\ end")`);
  for (const query of ['x\ny', 'x\ry', 'x\0y', 'x\u2028y', 'x\x1by']) {
    assert.equal((await call(registry, 'search_catalog', { query })).isError, true);
  }
  assert.equal(ctx.commands.length, 2);
});

test('plain JSON results mark MOO failures and quarantine invalid captures', async t => {
  const configPath = await configFile(t, { version: 1, tools: [{ ...look, response: 'json' }] });
  for (const [output, error, retired] of [
    ['{"ok":1,"items":[]}', false, false], ['{"ok":0}', true, false],
    ['{"ok":false}', true, false], ['{"error":"denied"}', true, false],
    ['{"partial":', true, true], ['=> 42', true, true], ['null', false, false]
  ]) {
    const ctx = context(output);
    const registry = await loadToolRegistry({ configPath, context: ctx });
    assert.equal((await call(registry, 'look_at', { object: '#42' })).isError, error);
    assert.equal(ctx.mooSession.retired, retired);
  }
  const ctx = context();
  ctx.mooSession.runSearchCapture = async () => ({ output: '{}', capture: { stop_reason: 'total_timeout' } });
  const registry = await loadToolRegistry({ configPath, context: ctx });
  assert.equal((await call(registry, 'look_at', { object: '#42' })).isError, true);
});

test('invalid configs, collisions, missing modules, and invalid segments fail at startup', async t => {
  for (const config of [
    { version: 2 }, { version: 1, typo: true }, { version: 1, modules: 'bad' },
    { version: 1, modules: ['./missing.js'] },
    { version: 1, tools: [look, look] },
    { version: 1, tools: [{ ...look, name: 'run_moo_command' }] },
    { version: 1, tools: [{ ...look, command: ['look\n@shutdown'] }] },
    { version: 1, tools: [{ ...look, command: [{ argument: 'missing', encoding: 'raw' }] }] },
    { version: 1, tools: [{ ...look, command: [{ argument: 'object', encoding: 'unknown' }] }] }
  ]) {
    await assert.rejects(loadToolRegistry({ configPath: await configFile(t, config), context: context() }));
  }
});

test('local module paths resolve relative to configuration and module tools share validation', async t => {
  const configPath = await configFile(t, { version: 1, modules: ['./local.mjs'], tools: [look] });
  await writeFile(path.join(path.dirname(configPath), 'local.mjs'), `
    export async function createTools({ mooSession }) {
      return {
        tools: [{ name: 'local', description: 'Local extension', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
        callTool: async () => { await mooSession.runCommandCaptureUntilIdle('local'); return { content: [{ type: 'text', text: 'ok' }] }; }
      };
    }
  `);
  const ctx = context();
  const registry = await loadToolRegistry({ configPath, context: ctx });
  assert.equal(registry.tools.length, 4);
  assert.equal((await call(registry, 'local', { unwanted: 1 })).isError, true);
  assert.equal(ctx.commands.length, 0);
  assert.equal((await call(registry, 'local')).content[0].text, 'ok');
  assert.deepEqual(ctx.commands, ['local']);
});

const profile = name => fileURLToPath(new URL(`../config/${name}.tools.json`, import.meta.url));

test('shipped profiles can be loaded separately or combined on one session', async () => {
  const ctx = context('{"ok":1,"verbs":[]}');
  ctx.mooSession.runCommandUntil = async (command, consume, timeout) => {
    ctx.commands.push(command);
    assert.equal(timeout, ctx.config.searchTimeoutMs);
    const { id, op, params } = JSON.parse(command.slice('@mcp '.length));
    const packet = { id, ok: true, result: { protocol: 1, op, params } };
    const noise = 'Broadcast\nMOO-MCP {"id":"previous","ok":true}\r\n';
    const line = 'MOO-MCP ' + JSON.stringify(packet);
    assert.equal(consume(noise + line).done, false);
    assert.equal(consume(noise + line + '\r\nIgnored\n').consumedChars, noise.length + line.length + 2);
  };

  const lab = await loadToolRegistry({ configPath: profile('toaststunt-llm-lab'), context: ctx });
  assert.equal(lab.tools.length, 16);
  assert.equal(payload(await call(lab, 'hello')).protocol, 1);
  await assert.rejects(call(lab, 'submit_bug'), /Unknown tool/);

  const sindome = await loadToolRegistry({ configPath: profile('sindome'), context: ctx });
  assert.equal(sindome.tools.length, 24);
  await assert.rejects(call(sindome, 'hello'), /Unknown tool/);

  const combined = await loadToolRegistry({ configPath: profile('combined'), context: ctx });
  assert.equal(combined.tools.length, 38);
  assert.equal(new Set(combined.tools.map(tool => tool.name)).size, 38);
  assert.equal((await call(combined, 'verbs-json', { arg: '#1' })).isError, false);
  assert.equal(ctx.commands.at(-1), '@verbs-json #1');
  assert.deepEqual(payload(await call(combined, 'lab-verbs-json', { object: '#1' })).params, { object: '#1' });
  await call(combined, 'lab-search-json', { name: 'café' });
  assert.match(ctx.commands.at(-1), /caf\\u00e9/);
  assert.equal((await call(combined, 'lab-verbs-json', { arg: '#1' })).isError, true);
});

test('includes reject cycles and collisions without a namespace', async t => {
  const cycle = await configFile(t, { version: 1, includes: ['tools.json'] });
  await assert.rejects(loadToolRegistry({ configPath: cycle, context: context() }), /Circular tools configuration/);
  const collision = await configFile(t, { version: 1, includes: [profile('sindome'), profile('toaststunt-llm-lab')] });
  await assert.rejects(loadToolRegistry({ configPath: collision, context: context() }), /Duplicate tool name/);
});
