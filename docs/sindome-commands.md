# Sindome bug and traceback command reference

Enable with `moo-tools-config=config/sindome.tools.json` in `.env`. This adds nine tools to the two [default tools](default-commands.md), for 11 total. These nine tools are also included in the [Sindome compatibility profile](sindome-compat-commands.md) (24 total) and the combined profile (25 total, including the [lab tools](toaststunt-llm-lab-commands.md)).

These tools require Sindome's server-side verbs, response formats, and an authorized development MOO bot account. They do not require the portable `@mcp` feature. See [Sindome account setup and operational notes](sindome.md). Profiles only expose client tools; they do not install MOO verbs.

Examples below are JSON argument objects passed to the named MCP tool. Unknown arguments are rejected. ID fields are positive integers unless noted otherwise. Replace sample IDs with real bug or traceback IDs.

## Read bugs and tracebacks

| Tool | Arguments | MOO command | Example arguments |
| --- | --- | --- | --- |
| `bugs-json` | Optional `arg` (string): `new`, `unassigned`, `assigned`, `resolved`, `mine`, or search text of at least three characters. Omit for open unresolved bugs. | `@bugs-json [arg]` | `{"arg":"new"}` |
| `vb-json` | Required `arg`: positive integer bug ID, numeric string, or `last` for the last viewed bug. | `@vb-json <arg>` | `{"arg":12345}` |
| `get-next-unreviewed-bug` | None. | `;$kaiju:bot_get_next_unreviewed_bug()` | `{}` |
| `next-unreviewed-traceback-json` | None. | `@next-unreviewed-traceback-json` | `{}` |
| `view-traceback-json` | Required `traceback_id` (integer). | `@view-traceback-json <traceback_id>` | `{"traceback_id":123}` |

The JSON command tools return the parsed MOO JSON object as JSON text in MCP `content`. Its fields depend on the server-side verb. `get-next-unreviewed-bug` instead returns `{"bug_id":12345}`; when the MOO returns `0` or `false`, the tool returns `isError: true` with the reason `No unreviewed bug is available.`

## Submit reports and update records

These calls change MOO records.

| Tool | Required arguments | Optional arguments | MOO operation | Example arguments |
| --- | --- | --- | --- | --- |
| `submit_bug` | `subject` (non-blank string, at most 255 characters), `body` (non-blank string or non-empty array of strings) | `traceback_json_text` (string containing valid JSON, or an empty string) | `;$kaiju:bot_submit_bug(SUBJECT, BODY, TRACEBACK_JSON_TEXT)` | `{"subject":"Example development bug","body":["Steps to reproduce","Expected and actual behavior"]}` |
| `submit_bug_comment` | `bug_id` (integer), `comment` (non-blank string) | None | `;$kaiju:bot_submit_comment(BUG_ID, COMMENT_LIST)` | `{"bug_id":12345,"comment":"Reviewed on development MOO.\nReproduction confirmed."}` |
| `resolve-traceback` | `id` (integer) | None | `@resolve-traceback <id>` | `{"id":123}` |
| `update-llm-reviewed-timestamp` | `traceback_id` (integer) | None | `;$error:update_llm_reviewed_timestamp(TRACEBACK_ID)` | `{"traceback_id":123}` |

`submit_bug` converts a string body into a MOO list of lines, or uses the supplied array as the list. Traceback JSON text is parsed and normalized before sending. A successful eval capture returns `error`, `eval`, `response_body`, and `return_value`; the return value remains a string in MOO syntax. Inspect that value to assess the server-side submission outcome.

`submit_bug_comment` converts comment newlines into a MOO list of strings. It returns `bug_id`, `return_value`, and `response_body`. `update-llm-reviewed-timestamp` returns `traceback_id`, `return_value`, and `response_body`. Both tools mark `0` or `false` returns as errors. `resolve-traceback` returns the parsed JSON object from the MOO.

## Responses and failures

Connector validation, capture, parsing, and eval failures return MCP `isError: true`. JSON command results retain their server-provided fields; inspect those fields as well as MCP status for application-level failures. Parse failures can include `truncated_response`; eval failures can include `reason` and `raw_output`.

JSON command tools capture until idle using `moo-idle-ms` and `moo-first-response-timeout-ms`. Eval operations wait up to 15000 ms for a return line or recognized compiler error. Idle capture does not prove completion. Commands are never automatically replayed; check record state before retrying a write after a timeout or disconnect. See [Runtime behavior](../README.md#runtime-behavior).
