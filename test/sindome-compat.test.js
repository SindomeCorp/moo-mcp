import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadToolRegistry } from "../src/tool-registry.js";

const logger = { child() { return this; }, info() {}, error() {} };
const profile = name => fileURLToPath(new URL(`../config/${name}.tools.json`, import.meta.url));

function fixture(responses = {}) {
  const calls = [];
  const capture = (kind, line, ...timeouts) => {
    calls.push([kind, line, ...timeouts]);
    assert.ok(Object.hasOwn(responses, line), `Unexpected command: ${line}`);
    const reply = responses[line];
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  };
  return {
    calls,
    config: { idleCaptureMs: 40, firstResponseTimeoutMs: 100, searchTimeoutMs: 1500 },
    logger,
    mooSession: {
      async ensureConnectedAndLoggedIn() {},
      async runCommand(line) { return capture("marker", line); },
      async runCommandCaptureUntilIdle(line, ...timeouts) { return { output: capture("idle", line, ...timeouts) }; },
      async runCommandCaptureFragmentsUntilIdle(line, ...timeouts) {
        return { output: capture("fragments", line, ...timeouts) };
      },
      async runSearchCapture(line, idle, first, total, validate) {
        const output = capture("search", line, idle, first, total);
        const response = { output, capture: { stop_reason: "idle", received_chars: output.length } };
        this.retired = !validate(response);
        return response;
      }
    }
  };
}
const call = (registry, name, args = {}) => registry.callTool({ params: { name, arguments: args } });
const payload = result => JSON.parse(result.content[0].text);
async function success(registry, name, args) {
  const result = await call(registry, name, args);
  assert.equal(result.isError, false, result.content[0].text);
  return payload(result);
}

test("compatibility profile matches all 24 deployed input schemas", async () => {
  const deployed = JSON.parse(await readFile(new URL("./fixtures/sindome-deployed-input-schemas.json", import.meta.url)));
  const registry = await loadToolRegistry({ configPath: profile("sindome-compat"), context: fixture() });
  assert.equal(registry.tools.length, 24);
  assert.deepEqual(Object.fromEntries(registry.tools.map(tool => [tool.name, tool.inputSchema])), deployed);
  await assert.rejects(call(registry, "hello"), /Unknown tool/);
});

test("compatibility profile preserves legacy routing and responses for the 13 tools", async () => {
  const cored = { arg: "", mode: "list", count: 1, records: [{ object: "#42" }] };
  const defines = { query: "sample", result_count: 1, results: [{ object: "#42" }] };
  const search = { ok: 1, results: [{ object: "#42" }] };
  const context = fixture({
    "@list #42:sample": '#42:"sample alias" this none this\n 1: return 42;\nVMS NOTES\nFixture note',
    '@verb-data #42::"sample"': { source: { code_lines: ["return 42;", '"Fixture note";'] } },
    "@verbs-json #42": { verbs: ["sample"] },
    "@props-json #42": { properties: ["sample"] },
    "@contents-json #42": { contents: ["#43"] },
    "@location-json #42": { location: "#43" },
    "@show-json $thing.sample": { object: "#42", property: "sample", value: 42 },
    "@cored-json": cored,
    "@defines-verb-json sample": defines,
    "@defines-prop-json sample": defines,
    "@search-json --help": { ok: 1, usage: "Synthetic help" },
    "@search-json things n=\"Sample Item\" l=#43 p=#42 a=Amber prop=sample mutex=sample w=#45 -g -m limit=4 backend=cache": search,
    '@code-search "return 42;" --scope=#42 --include_descendants=true --max_matches=4 --count_only=true --match_type=regex': { count: 1 },
    '@prop-grep-json "Sample" --scope=#42 --match_type=simple': { matches: ["sample"] }
  });
  const registry = await loadToolRegistry({ configPath: profile("sindome-compat"), context });
  assert.deepEqual(await success(registry, "get_moo_verb_source", { object: "#42", verb: "sample" }), {
    error: false, object: "#42", verbname: "sample alias", verb_aliases: ["sample", "alias"],
    verb_args: "this none this", source_code: "return 42;", vms_notes: "VMS NOTES\nFixture note"
  });
  const info = await success(registry, "verb-data", { arg: '#42::"sample"' });
  assert.equal(info.verb_info.source.code, 'return 42;\n"Fixture note";');
  assert.deepEqual(await success(registry, "verbs-json", { arg: "#42" }), { verbs: ["sample"] });
  assert.deepEqual(await success(registry, "props-json", { arg: "#42" }), { properties: ["sample"] });
  assert.deepEqual(await success(registry, "contents", { arg: "#42" }), { contents: ["#43"] });
  assert.deepEqual(await success(registry, "location", { arg: "#42" }), { location: "#43" });
  assert.equal((await success(registry, "show-json", { arg: "$thing", property: "sample" })).value, 42);
  assert.deepEqual(await success(registry, "cored_json"), cored);
  for (const tool of ["defines_verb_json", "defines_prop_json"]) {
    assert.deepEqual(await success(registry, tool, { arg: "sample" }), defines);
  }
  assert.equal((await success(registry, "search-json", { help: true })).usage, "Synthetic help");
  assert.deepEqual(await success(registry, "search-json", { type: "things", name: "Sample Item", parent: "#42",
    location: "#43", sic: "Amber", moved_by: "#45", mutex: "sample", prop: "sample",
    generics_only: true, mementos_only: true, limit: 4, extra_filters: ["backend=cache"] }), search);
  assert.deepEqual(await success(registry, "run_moo_code_search", { pattern: "return 42;", scope: "#42",
    include_descendants: true, max_matches: 4, count_only: true, match_type: "regex" }), { value: { count: 1 } });
  assert.deepEqual(await success(registry, "prop-search", { pattern: "Sample", scope: "#42" }), {
    value: { matches: ["sample"] }
  });
  assert.deepEqual(context.calls.map(entry => entry[0]),
    ["marker","idle","idle","idle","idle","idle","fragments","idle","idle","idle","search","search","idle","idle"]);
  assert.deepEqual(context.calls[11].slice(2), [40, 100, 1500]);
});

for (const [tool, command] of [
  ["defines_verb_json", "@defines-verb-json"],
  ["defines_prop_json", "@defines-prop-json"]
]) {
  test(`${tool} forwards wildcard patterns intact and preserves matches`, async () => {
    const patterns = ["@done-*", "*-pull", "SQL_EVENT_*", "wildfixture name [1].*",
      "wild*fixture*", 'wildfixture  name [1]."quoted"\\*'];
    const context = fixture(Object.fromEntries(patterns.map(query => [`${command} ${query}`, {
      query, result_count: 2, results: [
        { obj: "#42", name: "Fixture", owner: "#1", parent: "#2",
          matches: ["@done-pull full-alias", "wildfixture name [1].value"] },
        { obj: "#43", name: "Second fixture", owner: "#1", parent: "#2", matches: [] }
      ]
    }])));
    const registry = await loadToolRegistry({ configPath: profile("sindome-compat"), context });
    for (const query of patterns) {
      const result = await success(registry, tool, { arg: `  ${query}  ` });
      assert.deepEqual(result, {
        query, result_count: 2, results: [
          { obj: "#42", name: "Fixture", owner: "#1", parent: "#2",
            matches: ["@done-pull full-alias", "wildfixture name [1].value"] },
          { obj: "#43", name: "Second fixture", owner: "#1", parent: "#2", matches: [] }
        ]
      });
    }
    assert.deepEqual(context.calls, patterns.map(query => ["idle", `${command} ${query}`, 40, 100]));
  });

  test(`${tool} accepts exact and older wildcard responses without matches`, async () => {
    for (const query of ["exact name [1].value", "older_*"]) {
      const response = { query, result_count: 1,
        results: [{ obj: "#42", name: "Fixture", owner: "#1", parent: "#2" }] };
      const context = fixture({ [`${command} ${query}`]: response });
      const registry = await loadToolRegistry({ configPath: profile("sindome-compat"), context });
      assert.deepEqual(await success(registry, tool, { arg: query }), response);
      assert.equal(Object.hasOwn(response.results[0], "matches"), false);
      assert.deepEqual(context.calls, [["idle", `${command} ${query}`, 40, 100]]);
    }
  });

  test(`${tool} rejects controls and multiline input before connection or dispatch`, async () => {
    const context = fixture();
    let connections = 0;
    context.mooSession.ensureConnectedAndLoggedIn = async () => { connections++; };
    const registry = await loadToolRegistry({ configPath: profile("sindome-compat"), context });
    const controls = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index))
      .concat(Array.from({ length: 33 }, (_, index) => String.fromCharCode(127 + index)),
        ["\u2028", "\u2029", "\r\n"]);
    for (const control of controls) {
      for (const arg of [`${control}fixture*`, `fixture${control}*`, `fixture*${control}`]) {
        const result = await call(registry, tool, { arg });
        assert.equal(result.isError, true, JSON.stringify(arg));
        assert.match(payload(result).error, /control characters or line separators/);
      }
    }
    assert.equal(connections, 0);
    assert.deepEqual(context.calls, []);
  });
}

test("legacy validation and error shapes remain distinct", async () => {
  const context = fixture({
    "@list #42:missing": "That object does not define that verb.",
    "@defines-verb-json": { error: "usage" },
    "@defines-prop-json": { error: "missing_argument" },
    "@contents-json #42": "unparseable",
    "@cored-json": { arg: "" },
    "@search-json things": '{"partial":',
  });
  const registry = await loadToolRegistry({ configPath: profile("sindome-compat"), context });
  assert.equal((await call(registry, "show-json", { object: "#42" })).isError, true);
  assert.equal((await call(registry, "run_moo_code_search", { pattern: "sample", include_descendants: true })).isError, true);
  assert.equal(context.calls.length, 0);
  const missing = await call(registry, "get_moo_verb_source", { object: "#42", verb: "missing" });
  assert.equal(missing.isError, true);
  assert.equal(payload(missing).reason, "That object does not define that verb.");
  const verb = await call(registry, "defines_verb_json");
  assert.equal(verb.isError, true);
  assert.deepEqual(payload(verb), { error: "usage" });
  assert.deepEqual(payload(await call(registry, "defines_prop_json")), { error: "missing_argument" });
  assert.deepEqual(payload(await call(registry, "contents", { arg: "#42" })), { error: "unable to parse result into json" });
  assert.equal(payload(await call(registry, "cored_json")).error, "unexpected @cored-json response shape");
  const searchError = await call(registry, "search-json", { type: "things" });
  assert.equal(searchError.isError, true);
  assert.equal(payload(searchError).error, "moo_incomplete_response");
  assert.equal(context.mooSession.retired, true);
});

test("portable profile still has 16 tools and no-argument hello", async () => {
  const context = fixture();
  context.mooSession.runCommandUntil = async (line, complete) => {
    const request = JSON.parse(line.slice("@mcp ".length));
    assert.deepEqual({ op: request.op, params: request.params }, { op: "hello", params: {} });
    assert.equal(complete(`MOO-MCP ${JSON.stringify({id: request.id, ok: true, result: {protocol: 1}})}\n`).done, true);
  };
  const registry = await loadToolRegistry({ configPath: profile("toaststunt-llm-lab"), context });
  assert.equal(registry.tools.length, 16);
  assert.deepEqual(await success(registry, "hello"), { protocol: 1 });
  assert.equal((await call(registry, "hello", { arg: "extra" })).isError, true);
  await assert.rejects(call(registry, "bugs-json"), /Unknown tool/);
});
