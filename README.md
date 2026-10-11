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

## Troubleshooting

- Handshake/content-type errors:
  - Confirm `mcp-mode=http_shared`.
  - Confirm URL is exactly `http://127.0.0.1:<port>/mcp`.
  - Restart Codex after MCP config changes.
- Connection/session errors with multiple agents:
  - Restart `moo-mcp` and Codex so all clients open fresh sessions.
  - Check `./logs/mcp.log` for `mcp_session_created` and per-connection `connectionId` entries.
- Supervisor not picking up changes:
  - Run `sudo supervisorctl reread` then `sudo supervisorctl update`.

If you want to observe bot-side behavior on the MOO directly, ask a `$justice` to help monitor the bot connection.
