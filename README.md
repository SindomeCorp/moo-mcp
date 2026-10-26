# MOO MCP

A lightweight MCP server for connecting to a MOO.

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

Slack Slither your IP and ask him to whitelist it for connecting directly to the MOO on port 5555

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
- `moo-code-search-timeout-ms` (default `15000`)

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

## Structured search strings

`search-json` accepts ordinary string values, including multiword names. For example:

```json
{"type":"things","name":"TERRA armband","generics_only":true,"limit":3,"extra_filters":["backend=cache"]}
```

The connector quotes and escapes typed filter values for the MOO command parser.
Supply the intended text directly; embedded quote characters are treated as literal
search characters, not caller-provided command syntax. Control characters and line
separators are rejected. `extra_filters` retains its raw command-token contract
(including caller-provided quoting), but also rejects control characters and line
separators. Raw `run_moo_command` syntax remains the caller's responsibility.

Run local regression checks with `npm test` and `npm run check`.

## Search response diagnostics

The `search-json` handler distinguishes transport capture problems from MOO results:

| Outcome | MCP result |
| --- | --- |
| No bytes before the first-response deadline | `isError=true`, `error=moo_response_timeout` |
| Output continues until the total deadline | `isError=true`, `error=moo_response_timeout`; partial preview retained |
| Connection closes during capture | `isError=true`, `error=moo_connection_closed` |
| Idle capture contains only whitespace | `isError=true`, `error=moo_empty_response` |
| Idle capture has an unclosed JSON object/string | `isError=true`, `error=moo_incomplete_response` |
| Other output cannot be parsed as a JSON object | `isError=true`, `error=moo_invalid_json` |
| Valid MOO error JSON (`ok=0` or truthy `error`) | Original MOO payload preserved, `isError=true` |
| Valid successful JSON, including an empty results list | Original MOO payload preserved, `isError=false` |

Existing first-response and idle settings retain their defaults and behavior.
Search capture now also has a total deadline: `moo-search-timeout-ms` (alias
`MOO_SEARCH_TIMEOUT_MS`), default 15000, integer range 1..120000 milliseconds.
This bounds continuous output; it does not add a delay to normal calls. The earliest
applicable deadline wins. Legacy captures and queue waits are now bounded as described
in the transport-hardening rollout section below.

Capture diagnostics report stop reason, elapsed capture time (excluding queue wait),
first-byte observation time, all three wait settings, and received character count.
The existing `timed_out_waiting_for_first_line` name is retained in this metadata,
but receipt detection is based on bytes/text arriving, not a newline. Timing uses a
poll interval of at most 50 ms. Parsed results carry this metadata in MCP
`_meta.moo_capture`; transport/parse errors carry it in their JSON `capture` field.

Error previews preserve at most 1000 characters after redacting the configured MOO
password and stripping terminal controls. `preview_truncated` explicitly reports
preview truncation; it does not claim that the server truncated its response.
New capture log records contain timing/count metadata, not response contents.

Idle is not a completion marker. Unclosed JSON is evidence of potentially incomplete
output, not proof that more will arrive. Timeout never means an empty search result
or a canceled MOO task. No automatic command retry is performed. Uncertain streams
are now retired; the next explicit request may reconnect as described below.
The existing protocol has no request identifier on MOO response lines; late output
can still complicate attribution to a subsequent command. This change reports capture
uncertainty and does not solve server-task cancellation or response framing.

Historical validation of the earlier search-only change used simulated timing.
Its read-only live baseline returned Generic TERRA Armband #8536,
an empty result for `zzzzNoSuchTerraItem94721`, and `invalid_property_filter` for
`prop=description`, all with cached searches limited to 3. The running process was
not restarted to test the new capture implementation.

Activation requires separate approval as described in the transport-hardening rollout
section below. Do not induce slow searches or mutation
retries to test timeouts on the shared server.

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

Validation is entirely offline against fake TCP/MOO servers and ephemeral localhost MCP
listeners. No production `.env` is needed. From this worktree, use the installed Node 22:

```sh
PATH=/home/example/.nvm/versions/node/v22.22.2/bin:$PATH npm test
PATH=/home/example/.nvm/versions/node/v22.22.2/bin:$PATH npm run check
```

After separately approved rollout, initialize a fresh MCP session, list tools and run
one harmless `search-json` help call. Do not deliberately stall or mutate the live MOO
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
