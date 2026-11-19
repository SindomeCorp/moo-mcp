# Sindome extension and operational notes

These tools require Sindome-specific server verbs and response formats. Enable them with `moo-tools-config=config/sindome.tools.json`. This profile provides nine Sindome bug and traceback tools plus the two core tools. Use the combined profile for object inspection, verb source, and search after attaching the portable `@mcp` feature to the account. Profiles do not install server-side verbs.

The programming and VMS preservation rules below apply to this extension. Core raw command/eval tools use generic descriptions; callers using those tools for Sindome edits must still follow these rules.

## Run Modes

This server supports two runtime modes:

- `stdio` (default): existing behavior, fully backward compatible.
- `http_shared`: runs as a local Streamable HTTP MCP daemon so multiple local agents can use the same process, MOO connection, and command queue.

If you do nothing, it still runs exactly as before in `stdio` mode.

## Requirements

1. Node 22

## Warning

DO NOT CONNECT THIS TO A PRODUCTION MOO. USE ONLY ON A DEV MOO LIKE development MOO.

## MOO Setup

In order for this to work you need a 'MOOBot' type account on the MOO.

Get a $justice to:
- @make-player MOOBot1234 <your email>
- @programmer MOOBot1234
- @chparent MOOBot1234 to $generic_moo_bot ($agent child)
- @ansi off on the bot
- bot:rp_info_add({"DEFAULT-@VERBS-MODE", "d -c=no -u"})
- Get the username and pw

Ask your server administrator to authorize the bot account and connection.

## Installation

Clone the repo locally, then:

```bash
npm install
cp .env.example .env
```

Edit `./.env` and add your user and password for your MOO bot.

Core mode settings:

- `mcp-mode=stdio` (default)
- `mcp-mode=http_shared`
- `mcp-http-host=127.0.0.1` and `mcp-http-port=3000` (used only in `http_shared`)

Optional execution tuning:

- `moo-idle-ms` (default `1000`)
- `moo-first-response-timeout-ms` (default `2000`)

In `http_shared` mode, host is restricted to localhost (`127.0.0.1`, `localhost`, or `::1`) so it only accepts connections from the same computer.

## Running in `http_shared` Mode (Shared Local MCP Daemon)

This is optional. The default is still `stdio`.

1. In `./.env`, set:

```ini
mcp-mode=http_shared
mcp-http-host=127.0.0.1
mcp-http-port=1337
```

2. Start this server from the `moo-mcp` repo root:

```bash
npm run start
```

3. In the `moo-codex` repo, update `./.codex/config.toml` to use the HTTP endpoint instead of spawning this process over stdio:

```toml
[mcp_servers.moo]
url = "http://127.0.0.1:1337/mcp"
```

4. Restart Codex from the `moo-codex` repo so it picks up the updated MCP config.

## Running in `http_shared` Mode with `supervisord`

Use this if you want `moo-mcp` to start on boot and auto-restart if it exits.

1. In `./.env`, make sure shared HTTP mode is enabled:

```ini
mcp-mode=http_shared
mcp-http-host=127.0.0.1
mcp-http-port=1337
```

2. Review `./moo-mcp.conf` and verify:
- `command` points to your Node binary (for example, from `which node`).
- `directory` points to your local `moo-mcp` path.

3. Symlink the included Supervisor config into `conf.d`:

```bash
sudo ln -sf /opt/moo-mcp/moo-mcp.conf /etc/supervisor/conf.d/moo-mcp.conf
```

4. Reload Supervisor and start the service:

```bash
sudo supervisorctl reread
sudo supervisorctl update
sudo supervisorctl start moo-mcp
```

Common commands:

```bash
sudo supervisorctl status moo-mcp
sudo supervisorctl restart moo-mcp
sudo supervisorctl stop moo-mcp
```

Logs:

- App log: `./logs/mcp.log`
- Supervisor stdout: `./logs/supervisor-moo-mcp.out.log`
- Supervisor stderr: `./logs/supervisor-moo-mcp.err.log`

## Codex Integration

You also need the `moo-codex` repo, which contains the integration prompts/flows.

Clone that repo: [MOO Codex](https://github.com/sevenecks/moo-codex)

Inside that repo:

- For `stdio`, keep the existing spawned-process MCP config.
- For `http_shared`, set:
  - `[mcp_servers.moo]`
  - `url = "http://127.0.0.1:<port>/mcp"`
- Run `codex` from the command line
- Connect to development MOO and confirm your MOOBot is online.

## Agent instructions for verb edits

Read `AGENTS.md` and `playbook.md` in the `moo-codex` repository before using this
connection for verb edits. These rules apply to every full-source upload, including
documentation/readability-only edits:

1. Capture the full original source before editing, including every bottom
   `VMS NOTE` string, `VMS VERSION`, and `Last modified` annotation. Prefer
   `verb-data` from the combined profile and verify `source.code_lines` includes
   the stored annotations. An annotated listing may present a `VMS NOTES` heading
   outside the program. If annotations are missing or conflicting, stop and
   reconcile before programming.
2. Edit only the intended body. Retain all existing bottom annotations verbatim
   as input to every full-source upload. Never assume save reconstructs omitted
   history: `$vms2:comment_code` uses the submitted version/history, and a missing
   version defaults to `1.0`, which can regress generated versions.
3. Use the interactive save flow: `@program <obj>:<verb>`, full source with the
   preserved bottom annotations, `.` on its own line, then a one-line VMS note.
   Let the normal VMS save add the current note and update version/attribution;
   do not manually rewrite the preserved annotations. Do not use `set_verb_code`
   for normal edits or `@abort` to finish a save.
4. Immediately read back the full saved source and compare against the original.
   Verify existing `VMS NOTE` history remains verbatim, the current note is present,
   `VMS VERSION` has not decreased and has incremented as expected, and the normal
   save updated `Last modified` attribution. Executable-code and metadata checks
   alone are insufficient. Stop and reconcile any missing history, unexpected
   version, or conflicting annotations before further programming or migration.

These instructions govern caller behavior; the connector does not enforce footer
preservation. See `docs/MOO_CODE_GOTCHAS.md`, sections 7 and 10, in `moo-codex`.

## Troubleshooting

- Handshake/content-type errors:
  - Confirm `mcp-mode=http_shared`.
  - Confirm URL is exactly `http://127.0.0.1:<port>/mcp`.
  - Restart Codex after MCP config changes.
- Connection/session errors with multiple agents:
  - Reinitialize expired MCP sessions first; a backend restart requires operator approval.
  - Check `./logs/mcp.log` for `mcp_session_created` and per-connection `connectionId` entries.
- Supervisor not picking up changes:
  - Run `sudo supervisorctl reread` then `sudo supervisorctl update`.

If you want to observe bot-side behavior on the MOO directly, ask a `$justice` to help monitor the bot connection.

## Transport hardening rollout (requires separate deployment approval)

This branch is not a production deployment. Login requires no new marker setting or
probe command. For compatibility, after sending the configured login command the client
captures output until 500 ms of silence, with a 10-second total login-capture deadline.
The existing known failure patterns (`incorrect`, `different password`, `no such player`,
`invalid`, `denied`, `failed`, case-insensitive) reject login. Otherwise `loggedIn` records
assumed readiness, even for a silent response; it is not positive authentication proof.
The first tool command establishes actual usability. A disconnected or continuously
streaming login fails and retires its socket. No automatic command replay is introduced.

Bounds and behavior:

- TCP connection establishment has a 10-second deadline, followed by the bounded
  10-second login capture described above.
- Commands have a 30-second cumulative queue-wait budget across reconnect preflight
  and command enqueue. Own execution time is separate. Busy/expired or cancelled queued
  work is removed logically and can never execute later; deadline checks also run at dequeue.
- Legacy idle captures use a 30-second total ceiling, raised only to the configured
  first-response wait plus idle window if those existing settings require it. This bounds
  continuous output without shortening the configured initial/idle waits. Search keeps
  its existing total deadline. Marker-based commands retain their existing deadlines.
- Timeout, disconnect, explicit MCP cancellation, ambiguous write failure, and invalid
  or incomplete search JSON retire the affected TCP stream before another queued command
  can use it. No command is retried or replayed. The next explicit request can reconnect;
  already queued work that depended on the retired connection can fail safely.
- Successful idle capture remains a heuristic; idle alone cannot prove command completion.
  Late output after a seemingly successful raw idle capture remains a protocol limitation.
  Interactive raw-command workflows retain their connection on ordinary idle success.
- HTTP disconnect alone does not cancel MCP work. Explicit `notifications/cancelled`
  and SDK session shutdown signals cancel it. Closing one idle MCP session does not close
  the shared MOO connection or invalidate other MCP sessions.
- Missing MCP session headers still return HTTP 400 and unknown/expired sessions HTTP
  404. Error responses now retain a valid string/numeric JSON-RPC request ID (including 0).
  `server/discover` is unsupported: a valid initialized session receives SDK `-32601`.
  Pre-session discovery receives the required session error, not invented discovery support.
- Lifecycle logs include generated request IDs, stage, queue wait, duration and status.
  A central allowlist removes command arguments, response contents, login/user data and
  exception messages from console and file logs. Tool responses retain their existing data.
- `run_moo_eval` recognizes a standalone final `(End of traceback)` line as a
  completed runtime error. Live capture waits for the line ending (LF or CRLF),
  including when the terminator arrives across multiple TCP chunks. The tool
  returns MCP `isError: true`, with the complete captured traceback in `reason`
  and `raw_output`, rather than waiting for the completion timeout. This completed
  error keeps the shared MOO connection available for the next queued command.
  Traceback contents are returned to the caller, not written to lifecycle logs;
  the log records `tool_eval_runtime_error` with request correlation.
- Every socket retirement logs `moo_connection_closed` with a `reason`, generated
  `socketId`, process `pid`, socket age, send/receive idle times, byte counts,
  buffered character count and queue state. Active work also includes its MCP
  `connectionId`, `requestId` and validated `toolName`. Idle socket callbacks do not
  inherit attribution from the request that originally opened the connection.
  Reasons distinguish `first_response_timeout`, `capture_total_timeout`,
  `marker_timeout`, `completion_timeout`, `request_cancelled`, `write_error`,
  `socket_error`, search capture/validation failures, login failures and shutdown.
  `moo_socket_end` records remote EOF before `remote_close`; `socket_error` retains
  an allowlisted OS error code. Remote EOF/close alone does not identify why the peer
  disconnected. `moo_command_finished` now distinguishes `success`, `error` and
  `cancelled` (execution outcome, not validation of returned tool data).
  Keep-alive writes are visible at info level; successful writes do not prove a
  server response. Filter by `socketId` to follow a connection and by `requestId`
  to follow the queue and tool call. Commands and response contents remain private.

Validation is entirely offline against fake TCP/MOO servers and ephemeral localhost MCP
listeners. No production `.env` is needed. From this worktree, use the installed Node 22:

```sh
PATH=/path/to/node/bin:$PATH npm test
PATH=/path/to/node/bin:$PATH npm run check
```

After separately approved rollout, initialize a fresh MCP session, list tools and run
one read-only `bugs-json` call. Do not deliberately stall or mutate the live MOO
to test failure handling. Preserve the previous commit/config for operator rollback.
Backend restart invalidates previous MCP HTTP session IDs; clients must initialize again.

This change cannot repair upstream tunnel control-plane 503/504 errors. On recurrence,
compare direct initialization/list-tools/help with a tunneled equivalent and correlate
UTC times with `the tunnel service`: upstream poll failures without a matching local
request remain evidence of a separate tunnel path problem.

## Node.js 26 validation

Validated on Linux with **Node.js 26.12.1** on **2026-10-26**. The local regression suite and syntax checks passed using mocked MOO sessions and temporary local HTTP listeners.

With Node.js 26.12.1 selected, reproduce the checks with:

```sh
npm test
npm run check
```
