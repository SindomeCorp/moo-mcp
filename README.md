# MOO MCP

An extensible MCP server connecting AI tools to a MOO over telnet. It supports a spawned stdio process or a localhost HTTP daemon shared by multiple clients, using one connection and command queue.

The default tools are `run_moo_command` and `run_moo_eval`. Optional configuration adds your own tools or loads a shipped tool profile.

## Setup

Use Node.js 22 or later. Install dependencies and create your private settings:

```sh
npm ci
cp .env.example .env
```

Set `moo-hostname`, `moo-port`, `moo-user`, and `moo-password` in `.env`. Use a development MOO and an account with the permissions your tools require. The connection uses plain TCP telnet; use a trusted network or a secure tunnel. Never commit credentials or logs.

```sh
npm start
```

By default, the server uses stdio. Configure your MCP client to launch `node /absolute/path/to/moo-mcp/src/index.js` with the repository as its working directory so `.env`, configuration, and logs resolve correctly.

For a shared local daemon, set these values in `.env`:

```ini
mcp-mode=http_shared
mcp-http-host=127.0.0.1
mcp-http-port=3000
```

Point your MCP client at `http://127.0.0.1:3000/mcp`. HTTP mode permits only localhost addresses. All clients share the bot account's permissions and command queue. The sample `moo-mcp.conf` shows a Supervisor installation. Adapt its paths and Node executable before using it.

## Optional tools configuration

Leave `moo-tools-config` unset for the two core tools. To add custom tools:

```sh
cp config/custom.tools.json.example config/local.tools.json
```

Add this setting to `.env`:

```ini
moo-tools-config=config/local.tools.json
```

`MOO_TOOLS_CONFIG` is the equivalent environment variable. Relative configuration paths resolve from the process working directory. Configuration is read once at startup; restart the process and reconnect clients after changing it. Invalid configurations, duplicate tool names, or missing modules fail startup before connecting to the MOO.

Custom `config/*.tools.json` files are ignored by Git. The shipped profiles and example templates are tracked. Keep credentials in `.env`.

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

### Select a shipped profile

The two core tools are always available. Choose an optional profile for the MOO you are connecting to.

| Profile | Configuration | Tools |
| --- | --- | --- |
| ToastStunt LLM Lab | `config/toaststunt-llm-lab.tools.json` | 14 tools for verb source, object and property inspection, and structured search over the installed `@mcp` feature |
| Sindome | `config/sindome.tools.json` | 9 tools for bug triage, bug reports and comments, and traceback review |
| Combined | `config/combined.tools.json` | Both sets plus the two core tools. Tool names stay the same |

Set the path in `.env` and start or restart the MCP server.

```ini
moo-tools-config=config/toaststunt-llm-lab.tools.json
```

Alternatively, launch the server from the repository root with an environment variable. Leave `moo-tools-config` unset in `.env` when selecting the profile this way.

```sh
MOO_TOOLS_CONFIG=config/combined.tools.json npm start
```

Use the combined profile when the same MOO and account support both sets of commands. To connect to two worlds, launch two instances of `src/index.js` with separate credentials and profiles.

The portable tools require the server-side `@mcp` feature. Run the [MOO installation transcript](https://github.com/SindomeCorp/toaststunt-llm-lab/blob/main/moo/install.moo) from [ToastStunt LLM Lab](https://github.com/SindomeCorp/toaststunt-llm-lab), or use its setup script to install the feature automatically on stock ToastCore. See the [lab profile notes](docs/toaststunt-llm-lab.md) for setup and call examples and the [Sindome notes](docs/sindome.md) for account and verb requirements.

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
