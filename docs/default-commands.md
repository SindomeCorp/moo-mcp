# Default command reference

The two default MCP tools are available with every configuration. Leave `moo-tools-config` unset in `.env` to expose only these tools. See [Choose your tools](../README.md#2-choose-your-tools) for additional profiles.

Examples below are JSON argument objects passed to the named MCP tool. Responses contain JSON text in MCP `content`; connector failures set `isError: true`. All tools use the configured MOO account and its permissions, connection, and command queue. Configuration does not install commands on the MOO.

## `run_moo_command`

Send a raw MOO command and collect output until the configured idle period.

| Argument | Required | Type | Meaning |
| --- | --- | --- | --- |
| `command` | Yes | string | Non-empty command to send, such as `look`. Leading and trailing whitespace is trimmed. |

```json
{"command":"look"}
```

Successful captures return `error: false`, `command`, `output`, `timed_out_waiting_for_first_line`, `idle_capture_ms`, and `first_response_timeout_ms`. A MOO command's own error message can appear in `output` even when capture succeeds; this tool does not interpret command output.

Idle capture is a heuristic, so success does not prove that the MOO finished executing the command. It uses `moo-idle-ms` (default 1000 ms) and `moo-first-response-timeout-ms` (default 2000 ms). See [Runtime behavior](../README.md#runtime-behavior) for total bounds and connection handling.

Commands can change MOO state. Follow your MOO's programming and save rules; for Sindome, read the [verb editing instructions](sindome.md#agent-instructions-for-verb-edits) before uploading source.

## `run_moo_eval`

Send a single-line eval command and separate printed output from its final `=>` return line. Requires programmer permissions and a compatible eval interface. Supply the complete command, including the usual leading semicolon.

| Argument | Required | Type | Meaning |
| --- | --- | --- | --- |
| `eval` | Yes | string | Non-empty eval command. Leading and trailing whitespace is trimmed. |

```json
{"eval":";2 + 2"}
```

For a response of `=> 4`, the returned JSON is:

```json
{"error":false,"eval":";2 + 2","response_body":"","return_value":"4"}
```

`return_value` is a string containing the MOO representation, not a decoded JSON value. `response_body` contains output before the final return line. Capture waits up to 15000 ms for completion. Recognized compiler errors and completed tracebacks return `error: true`, `reason`, `eval`, and `raw_output`, with MCP `isError: true`. An ordinary return value such as `0` is not automatically an error.

## Errors and retries

Both tools reject unknown arguments and empty commands. Transport errors return an error result. Timeouts, disconnects, and cancellation can leave command completion uncertain and retire the connection. Commands are never automatically replayed. Check the MOO state before repeating a command that may have made changes.

Additional references: [ToastStunt LLM Lab](toaststunt-llm-lab-commands.md), [Sindome bugs and tracebacks](sindome-commands.md), and [Sindome compatibility](sindome-compat-commands.md).
