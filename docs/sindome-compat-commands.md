# Sindome compatibility command reference

Enable with `moo-tools-config=config/sindome-compat.tools.json` in `.env`. This profile exposes 24 tools: the two [default tools](default-commands.md), nine [Sindome bug and traceback tools](sindome-commands.md), and 13 native inspection and search tools documented here.

Use this profile for integrations expecting Sindome's native command arguments and VMS source output. It requires the native server verbs and an authorized development MOO bot account, with no portable `@mcp` feature. See [Sindome setup and operational notes](sindome.md).

The compatibility and [portable lab](toaststunt-llm-lab-commands.md) profiles share tool names with different contracts. Select one profile per server process. Including compatibility alongside the lab or combined profile fails startup because of duplicate tool names.

Examples below are JSON argument objects passed to the named MCP tool. Unknown arguments are rejected. Object references use `#1234` or a cored reference such as `$string_utils`. Replace example objects and verbs with ones on your MOO.

## Inspect objects and source

| Tool | Required arguments | Optional arguments | MOO command | Example arguments |
| --- | --- | --- | --- | --- |
| `get_moo_verb_source` | `object`, `verb` (strings) | None | `@list OBJECT:VERB` | `{"object":"$string_utils","verb":"trim"}` |
| `verb-data` | `arg` (string in `obj:verb_spec` or `obj::verb_spec` form) | None | `@verb-data ARG` | `{"arg":"#1234:look"}` |
| `verbs-json` | `arg` (object reference string) | None | `@verbs-json ARG` | `{"arg":"#1234"}` |
| `props-json` | `arg` (object reference string) | None | `@props-json ARG` | `{"arg":"#1234"}` |
| `contents` | `arg` (object reference string) | None | `@contents ARG` | `{"arg":"#1234"}` |
| `location` | `arg` (object reference string) | None | `@location-json ARG` | `{"arg":"#1234"}` |
| `show-json` | `arg` (object reference string) | `property` (string) | `@show-json ARG` or `@show-json ARG.PROPERTY` | `{"arg":"$time_utils"}` |
| `cored_json` | None | `arg` (string) | `@cored-json [ARG]` | `{}` |
| `defines_verb_json` | None | `arg` (string containing a verb name) | `@defines-verb-json [ARG]` | `{"arg":"look"}` |
| `defines_prop_json` | None | `arg` (string containing a property name) | `@defines-prop-json [ARG]` | `{"arg":"description"}` |

Omitting `arg` for a definition lookup sends the command without an argument, preserving the server-side usage error. `show-json` takes the object in `arg` and the property separately, for example `{"arg":"#1234","property":"name"}`.

`get_moo_verb_source` parses the native annotated listing into `error`, `object`, `verbname`, `verb_aliases`, `verb_args`, `source_code`, and `vms_notes`. It requires a `VMS NOTES` section. `source_code` alone is not a complete upload, and the rendered `VMS NOTES` heading is not MOO source.

`verb-data` returns `{"error":false,"arg":"...","verb_info":{...}}`, enriching `verb_info.source.code` from `verb_info.source.code_lines` when present. Its `arg` accepts `:` or `::` separators and non-empty verb specifications, including quoted names, such as `{"arg":"#1234::\"_example\""}`.

The other inspection tools return the parsed JSON object from the MOO. Preserve all existing bottom `VMS NOTE`, `VMS VERSION`, and `Last modified` annotations before editing. Follow the full [Sindome verb editing instructions](sindome.md#agent-instructions-for-verb-edits), including readback after saving.

## `search-json`

Search native Sindome object categories with `@search-json`. Use `{"help":true}` to request server-side help. Otherwise, `type` is required and must be one of `rooms`, `exits`, `npcs`, `players`, `players-all`, `avatars`, `vehicles`, `jobs`, `attacks`, `channels`, `wares`, or `things`.

| Argument | Type | Meaning |
| --- | --- | --- |
| `help` | boolean | Run `@search-json --help` when true. |
| `type` | string | Search category; required unless `help` is true. |
| `name` | string | Name filter (`n=`). |
| `location` | string | Location filter (`l=`). |
| `parent` | string | Parent filter (`p=`). |
| `sic` | string | SIC filter (`a=`). |
| `prop` | string | Property filter (`prop=`). |
| `mutex` | string | Mutex filter (`mutex=`). |
| `moved_by` | string | Moved-by filter (`w=`). |
| `generics_only` | boolean | Add `-g` when true. |
| `mementos_only` | boolean | Add `-m` when true. |
| `limit` | integer | Positive result limit. |
| `extra_filters` | array of strings | Additional raw filter tokens, retaining their command syntax and quoting. |

```json
{"type":"things","name":"example item","location":"#1234","limit":10}
```

Typed filter strings are literal values: supply `example item` directly without adding command quotes. The connector escapes spaces, quotes, and backslashes for the command parser. Control characters and line separators are rejected. `extra_filters` is a raw token interface; use it only when you need native filter syntax beyond the typed fields.

Successful captures return the MOO's parsed JSON object in MCP `content` with capture metadata in `_meta.moo_capture`. MOO results with a truthy `error`, `ok: 0`, or `ok: false` set `isError: true`. Capture failures include an error code, capture details, and a bounded response preview. Response wait uses `moo-search-timeout-ms` (default 15000 ms).

## Code and property search

| Tool | Required arguments | MOO command | Example arguments |
| --- | --- | --- | --- |
| `run_moo_code_search` | `pattern` (string) | `@code-search` | `{"pattern":"notify","scope":"#1234","max_matches":10}` |
| `prop-search` | `pattern`, `scope` (strings) | `@prop-grep-json` | `{"pattern":"example","scope":"#1234","max_matches":10}` |

Both tools support these options:

| Argument | Type | Meaning |
| --- | --- | --- |
| `scope` | string | Object scope, such as `#1234` or `$string_utils`. Required for `prop-search`. |
| `include_descendants` | boolean | If supplied, must be `true` and requires `scope`. |
| `max_matches` | integer | Positive maximum match count. |
| `count_only` | boolean | If supplied, must be `true`. |
| `match_type` | string | `simple` (default) or `regex`. |

Supply a non-empty pattern without command quotes. These tools return `{"value":{...}}` containing the parsed MOO JSON object. Inspect `value` for server-side errors as well as the MCP status. They use `moo-code-search-timeout-ms` or `MOO_CODE_SEARCH_TIMEOUT_MS` for the first-response wait (default 15000 ms), followed by idle capture.

## Differences from the portable profile

| Tool or option | Sindome compatibility | ToastStunt LLM Lab / Combined |
| --- | --- | --- |
| `hello` | Unavailable | Identifies the portable feature. |
| `verb-data` | `arg` containing `obj:verb_spec`; response under `verb_info`. | `object`, `verb`, optional `mode`; source at top-level `source`. |
| `get_moo_verb_source` | `object`, string `verb`; parsed listing with separate VMS notes. | Alias of portable `verb-data`; also accepts integer verb slots and `mode`. |
| Object inspection | Object in `arg`. | Object in `object`. |
| Definition lookup | Optional `arg` string. | Required `pattern`, plus scan options. |
| `search-json` | Native kinds, help, and Sindome filters. | Portable filters and scan pagination. |
| Code/property search | `max_matches`; supplied boolean flags must be true; response under `value`. | `limit`, `cursor`, `offset`, and shared scan options; returns feature result. |

All tools share the same account and connection queue. Capture success at an idle boundary does not prove command completion. See [Runtime behavior](../README.md#runtime-behavior) for timeouts, cancellation, and retry behavior.
