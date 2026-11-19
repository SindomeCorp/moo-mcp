# MOO MCP

An extensible MCP server connecting AI tools to a MOO over telnet. It supports a spawned stdio process or a localhost HTTP daemon shared by multiple clients, using one connection and command queue.

The default tools are `run_moo_command` and `run_moo_eval`. Optional configuration adds your own tools or loads a shipped tool profile.

## Quick start

### 1. Install and configure your MOO connection

Use Node.js 22 or later.

```sh
git clone https://github.com/sevenecks/moo-mcp.git
cd moo-mcp
npm ci
cp .env.example .env
```

Set `moo-hostname`, `moo-port`, `moo-user`, and `moo-password` in `.env`. Use a development MOO and an account with the permissions your tools require. The connection uses plain TCP telnet, so use a trusted network or a secure tunnel. Keep credentials in `.env`.

### 2. Choose your tools

Set `moo-tools-config` in `.env` to one of the paths below. Start with **Basic** to send commands to an existing MOO. Choose **ToastStunt LLM Lab** for structured tools to browse and develop a ToastStunt MOO.

| Profile | `moo-tools-config` value | What you can do |
| --- | --- | --- |
| **Basic** | Leave unset | Send MOO commands with `run_moo_command` and parse eval results with `run_moo_eval`. |
| **ToastStunt LLM Lab** | `config/toaststunt-llm-lab.tools.json` | Read verb source, inspect objects and properties, and search the MOO. Requires the lab's `@mcp` feature. |
| **Sindome** (optional) | `config/sindome.tools.json` | Review bugs and tracebacks, file bug reports, and post bug comments on a Sindome MOO. |
| **Combined** | `config/combined.tools.json` | Use the lab and Sindome tools on one MOO and account that support both sets. |

For example, to enable the lab tools, set `moo-tools-config=config/toaststunt-llm-lab.tools.json`. The basic tools are available with every profile. Try `run_moo_command` with `{"command":"look"}`. If the account can eval, try `run_moo_eval` with `{"eval":";2 + 2"}`.

For the lab profile, attach the server-side feature to the programmer account using the [MOO installation transcript](https://github.com/SindomeCorp/toaststunt-llm-lab/blob/main/moo/install.moo). The [ToastStunt LLM Lab setup](https://github.com/SindomeCorp/toaststunt-llm-lab) installs that feature automatically when provisioning stock ToastCore. Once connected, call `hello` to verify it, or try `verb-data` to read a verb. See the [lab tool examples](docs/toaststunt-llm-lab.md) and [Sindome account requirements](docs/sindome.md).

To connect to two different MOOs, run a server instance for each with its own credentials and profile.

For your own MOO commands or a different mix of tools, see [Custom configurations](#custom-configurations).

### 3. Start the server and connect Codex

Choose [Codex-launched stdio](#codex-launched-stdio) for a server Codex starts on demand. Choose [shared local HTTP](#shared-local-http) for one running server that multiple local clients can use.

#### Codex-launched stdio

Set `mcp-mode=stdio` in `.env` or leave it unset. Add this entry to `~/.codex/config.toml` and replace the example paths with the absolute path to your checkout.

```toml
[mcp_servers.moo]
command = "node"
args = ["/absolute/path/to/moo-mcp/src/index.js"]
cwd = "/absolute/path/to/moo-mcp"
```

Codex launches the process from `cwd`, where the server reads `.env` and resolves your chosen profile. If Codex cannot find Node on its PATH, set `command` to the absolute path to the Node executable.

#### Shared local HTTP

Set these values in the server's `.env` file.

```ini
mcp-mode=http_shared
mcp-http-host=127.0.0.1
mcp-http-port=3000
```

Run `npm start` from the `moo-mcp` checkout and leave it running. Use this entry in `~/.codex/config.toml` for the shared server.

```toml
[mcp_servers.moo]
url = "http://127.0.0.1:3000/mcp"
```

The HTTP listener is loopback-only. Clients on the same host share the configured MOO account, tools, and command queue. To run it under Supervisor, adapt the paths in `moo-mcp.conf`.

Start a new Codex session after saving its configuration and use `/mcp` in the Codex terminal UI to check the connection. See the [OpenAI Docs for Codex MCP configuration](https://developers.openai.com/codex/mcp).

## Custom configurations

Copy the example when you want to define your own tools.

```sh
cp config/custom.tools.json.example config/local.tools.json
```

Point `moo-tools-config` at `config/local.tools.json` in `.env`. You can also set `MOO_TOOLS_CONFIG` when launching the server if `moo-tools-config` is unset. Relative paths resolve from the server's working directory.

Configuration is read once at startup. Restart the server and reconnect clients after changing it. Invalid configurations, duplicate tool names, or missing modules fail startup before the server connects to the MOO. Git ignores custom `config/*.tools.json` files and tracks the shipped profiles and example templates.

### Define a tool without JavaScript

The custom example contains two tools you can adapt. Each tool has an MCP `name`, `description`, and object `inputSchema`, plus a `command` array and `response` mode:

```json
{
  "version": 1,
  "tools": [
    {
      "name": "look_at",
      "description": "Look at an object.",
      "inputSchema": {
        "type": "object",
        "properties": { "object": { "type": "string", "pattern": "^#[0-9]+$" } },
        "required": ["object"],
        "additionalProperties": false
      },
      "command": ["look ", { "argument": "object", "encoding": "raw" }],
      "response": "text"
    }
  ]
}
```

Command segments concatenate exactly, including spaces. Literal strings supply fixed syntax. Argument segments reference top-level schema properties; supplied values must be strings, numbers, or booleans. All referenced arguments must be supplied, even if the schema makes them optional. JSON Schema validates each call before any MOO command runs.

- `raw` inserts a scalar as command syntax. Constrain its schema with patterns, enums, or numeric bounds as appropriate for your MOO parser.
- `moo-string` surrounds a value with double quotes and escapes backslashes and quotes, suitable for a MOO string literal in an eval expression. It is not a universal quoting mode for every MOO command parser.
- Control characters and line separators are rejected in both modes and in literal segments.
- `response: "text"` returns `{ "output": "..." }` after idle capture.
- `response: "json"` expects the entire captured response to be plain JSON and returns that value. A truthy `error`, `ok: 0`, or `ok: false` marks a tool error. Capture failures or invalid JSON also return tool errors and retire the uncertain connection inside the queue. An eval response containing `=>` is not plain JSON; use text mode or a module to parse it.

The example `search_catalog` assumes your MOO has `$catalog:search`; adapt it to your server. Configuration only describes client tools and does not install MOO verbs.

### Combine configurations

Use `includes` to load other version 1 configurations. Paths are relative to the file that lists them. Each entry is a path string, and includes can be nested. The two core tools are registered once. Duplicate tool names and circular includes fail at startup.

```json
{
  "version": 1,
  "includes": [
    "sindome.tools.json",
    "toaststunt-llm-lab.tools.json"
  ]
}
```

### Write a module for complex tools

A configuration can combine `modules` and declarative `tools`:

```json
{
  "version": 1,
  "modules": ["../extensions/my-moo.js"],
  "tools": []
}
```

Module paths resolve relative to the configuration file. A module exports `createTools(context)` and returns `{ tools, callTool }`. The factory may be async. `tools` is an array of MCP definitions; `callTool(request, extra)` returns an MCP tool result. See `extensions/sindome.js` for an implementation.

The context supplies `config`, `mooSession`, and the sanitized `logger`. Use the supplied session methods for connection readiness, serialization, deadlines, and cancellation. Return failures as `isError: true`. Do not create an independent connection or log command arguments, credentials, or response contents. Modules run trusted JavaScript with the server's permissions; only load modules you control.

Core names cannot be replaced, and duplicate names across modules/configuration are rejected. Every registered tool's input schema is validated before dispatch. Tool definitions are shared by stdio and HTTP clients.

## Runtime behavior

`run_moo_command` captures until output becomes idle; idle is a heuristic rather than proof of command completion. `run_moo_eval` expects a final `=>` return line or a recognized compiler error/traceback. Eval requires a compatible MOO command interface and programmer permissions.

The connector assumes a `connect USER PASSWORD` login command. It rejects known login errors and otherwise assumes readiness after bounded idle capture; the first tool call confirms usability. Different login protocols require a transport adaptation.

Optional timeout settings include `moo-idle-ms` (1000), `moo-first-response-timeout-ms` (2000), `moo-search-timeout-ms` (15000, for structured responses). TCP connection and login capture each have a 10-second bound; queue wait is bounded to 30 seconds. Raw idle captures have a 30-second total ceiling, extended if the configured first-response plus idle waits require it.

Timeouts, disconnects, cancellation, and uncertain JSON captures retire the connection. Commands are never automatically replayed; the next explicit call may reconnect. Lifecycle logs go to stderr and `logs/mcp.log`, with command contents and responses removed. Treat historical logs as private. Restarting a shared HTTP daemon invalidates client sessions.

## Validation

```sh
npm test
npm run check
```

Tests use synthetic accounts, fake TCP/MOO servers, and temporary localhost HTTP listeners. No live MOO credentials are needed.
