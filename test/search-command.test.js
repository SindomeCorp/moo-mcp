import assert from "node:assert/strict";
import test from "node:test";
import { buildSearchCommand } from "../src/search-command.js";

// Reference tokenizer following ToastStunt parse_cmd.cc:parse_into_words.
function mooWords(command) {
  const words = [];
  let word = "", quoted = false, started = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === " " && !quoted) {
      if (started) words.push(word);
      word = ""; started = false;
    } else {
      started = true;
      if (c === '"') quoted = !quoted;
      else if (c === "\\") word += command[++i] ?? "";
      else word += c;
    }
  }
  if (started) words.push(word);
  assert.equal(quoted, false, "balanced command quotes");
  return words;
}

test("preserves ordinary commands, flag ordering, empty filters and help", () => {
  assert.equal(buildSearchCommand({ type: "rooms", name: " market ", location: "", limit: 5 }),
    "@search-json rooms n=market limit=5");
  assert.equal(buildSearchCommand({ help: true }), "@search-json --help");
  assert.equal(buildSearchCommand({ type: "things", generics_only: true, mementos_only: true,
    limit: 3, extra_filters: ["backend=cache"] }), "@search-json things -g -m limit=3 backend=cache");
});

test("exact emitted commands preserve multiword names", () => {
  for (const item of ["jumpsuit", "armband", "helmet"]) {
    assert.equal(buildSearchCommand({ type: "things", name: `TERRA ${item}`,
      generics_only: true, limit: 3, extra_filters: ["backend=cache"] }),
    `@search-json things n="TERRA ${item}" -g limit=3 backend=cache`);
  }
});

test("quotes and backslashes are escaped as MOO command syntax", () => {
  assert.equal(buildSearchCommand({ type: "things", name: 'A "B" \\ C' }),
    String.raw`@search-json things n="A \"B\" \\ C"`);
  for (const value of ['A "B" \\ C', '"TERRA armband"', 'tail\\', 'a\\" b',
    "TERRA  armband", "TERRA -g limit=1000 backend=live", 'x" -g "y', "x;@shutdown"]) {
    assert.deepEqual(mooWords(buildSearchCommand({ type: "things", name: value, limit: 3 })),
      ["@search-json", "things", `n=${value}`, "limit=3"]);
  }
});

test("all typed string filters preserve word boundaries", () => {
  for (const [field, key] of Object.entries({ name: "n", location: "l", parent: "p",
    sic: "a", prop: "prop", mutex: "mutex", moved_by: "w" })) {
    assert.deepEqual(mooWords(buildSearchCommand({ type: "things", [field]: "two words" })),
      ["@search-json", "things", `${key}=two words`]);
  }
  assert.equal(buildSearchCommand({ type: "wares", prop: "mutex;gangrel" }),
    "@search-json wares prop=mutex;gangrel");
});

test("rejects controls before trimming in typed fields and raw extra filters", () => {
  for (const control of ["\n", "\r", "\r\n", "\0", "\t", "\x1b", "\x7f", "\x85", "\u2028", "\u2029"]) {
    for (const field of ["name", "location", "parent", "sic", "prop", "mutex", "moved_by"]) {
      assert.throws(() => buildSearchCommand({ type: "things", [field]: `${control}@shutdown` }), /control characters/);
      assert.throws(() => buildSearchCommand({ type: "things", [field]: `TERRA${control}` }), /control characters/);
    }
    assert.throws(() => buildSearchCommand({ type: "things", extra_filters: [`backend=cache${control}@shutdown`] }), /control characters/);
  }
});

test("extra_filters preserves its explicit raw-token contract", () => {
  assert.equal(buildSearchCommand({ type: "things", extra_filters: [' n="TERRA armband" ', "backend=cache"] }),
    '@search-json things n="TERRA armband" backend=cache');
});
