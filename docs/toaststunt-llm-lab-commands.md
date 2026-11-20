# ToastStunt LLM Lab command reference

Enable with `moo-tools-config=config/toaststunt-llm-lab.tools.json` in `.env`. This adds 14 tools to the two [default tools](default-commands.md), for 16 total. The same 14 tools are included in `config/combined.tools.json`, alongside the nine [Sindome bug and traceback tools](sindome-commands.md), for 25 total.

The account must have version 1 of the lab's `@mcp` feature attached. See the [lab setup guide](toaststunt-llm-lab.md). Call `hello` first to identify the feature and its supported operations. This profile uses the portable feature; the similarly named [Sindome compatibility tools](sindome-compat-commands.md) use different arguments and responses.

Examples are JSON argument objects for the named MCP tool. Unknown arguments are rejected. Required arguments are listed below; all other listed arguments are optional. Object references are strings such as `#123` or `$string_utils`. Replace sample objects and verb names with ones on your MOO.

## Inspect objects and source

| Tool | Required arguments | Optional arguments | Purpose | Example arguments |
| --- | --- | --- | --- | --- |
| `hello` | None | None | Identify feature, protocol, and operations. | `{}` |
| `verb-data` | `object` (string), `verb` (string or integer) | `mode`: `local` or `resolved` | Read a complete verb by local slot, alias, or callable name. | `{"object":"#123","verb":"describe","mode":"local"}` |
| `get_moo_verb_source` | `object` (string), `verb` (string or integer) | `mode`: `local` or `resolved` | Alias of `verb-data`, with the same response. | `{"object":"#123","verb":1,"mode":"local"}` |
| `verbs-json` | `object` (string) | None | List local verb metadata by numbered slot. | `{"object":"#123"}` |
| `props-json` | `object` (string) | None | List readable property metadata without values. | `{"object":"#123"}` |
| `show-json` | `object` (string) | `property` (string) | Inspect an object and readable property values, optionally selecting one property. | `{"object":"#123","property":"name"}` |
| `contents` | `object` (string) | None | List immediate contents. | `{"object":"#123"}` |
| `location` | `object` (string) | None | Follow the containment chain. | `{"object":"#123"}` |
| `cored_json` | None | `arg` (string) | List readable object-valued properties on `#0`, optionally passing an argument to the feature. | `{}` |

Use a numbered local verb slot when aliases are ambiguous. Verb source responses include `source.code_lines` and a `source.code` string formed by joining those lines with newlines. Stored VMS comments remain in `code_lines`. When editing Sindome source through the combined profile, follow the [VMS preservation and save instructions](sindome.md#agent-instructions-for-verb-edits).

## Search and find definitions

| Tool | Required arguments | Optional arguments | Purpose | Example arguments |
| --- | --- | --- | --- | --- |
| `defines_verb_json` | `pattern` (string) | Shared scan options | Find readable direct verb definitions. | `{"pattern":"describe","scope":"#123","include_descendants":true,"limit":10}` |
| `defines_prop_json` | `pattern` (string) | Shared scan options | Find readable direct property definitions. | `{"pattern":"description","scope":"#123","limit":10}` |
| `search-json` | None | `type`, `name` (strings), `parent`, `location` (object reference strings), shared scan options | Search by name, kind, parent, or location. | `{"type":"things","name":"example item","scope":"#123","include_descendants":true,"limit":10}` |
| `run_moo_code_search` | `pattern` (string) | `match_type`: `simple` or `regex`, shared scan options | Search readable verb source by line. | `{"pattern":"notify","scope":"#123","limit":10,"match_type":"simple"}` |
| `prop-search` | `scope`, `pattern` (strings) | `match_type`: `simple` or `regex`, other shared scan options | Search readable locally declared property values. | `{"scope":"#123","pattern":"example","limit":10}` |

Shared scan options:

| Argument | Type | Purpose |
| --- | --- | --- |
| `scope` | string | Object reference identifying the scan scope. Required for `prop-search`. |
| `include_descendants` | boolean | Request descendant scanning. |
| `limit` | integer | Requested page size. |
| `cursor` | integer | Resume scanning with the cursor returned by the feature. |
| `offset` | integer | Resume within a page using the returned offset. |
| `count_only` | boolean | Request counts. |

Use the returned cursor and offset to request further pages, retaining the original filters. Send names and patterns as plain JSON strings, without adding MOO command quotes. The connector validates argument types and the two enums; the installed feature determines defaults, accepted search kinds, numeric bounds, scan semantics, and result fields.

## Responses and failures

Each call sends `@mcp` a JSON request with a unique ID and waits for the matching newline-terminated `MOO-MCP` response. The tool returns the packet's `result` as JSON text in MCP `content`, or its `error` with `isError: true`. It does not return the surrounding protocol packet. `hello` requires protocol version 1. The connector adds `source.code` to successful verb source results.

The ASCII-escaped request payload must fit within 8192 characters. Response wait uses `moo-search-timeout-ms` (default 15000 ms). Account permissions still control what the feature can read. See [Runtime behavior](../README.md#runtime-behavior) for queueing, cancellation, and connection failures.
