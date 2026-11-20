# ToastStunt LLM Lab profile

See the [command reference](toaststunt-llm-lab-commands.md) for the complete tool list, arguments, and responses.

Set `MOO_TOOLS_CONFIG` to the absolute path of `config/toaststunt-llm-lab.tools.json` and run the normal `src/index.js` entry point. The [ToastStunt LLM Lab](https://github.com/SindomeCorp/toaststunt-llm-lab) provisions the MOO, installs the feature, and passes the connection settings and profile to this process.

Install the [MOO verb transcript](https://github.com/SindomeCorp/toaststunt-llm-lab/blob/main/moo/install.moo) from the lab repository. Use its `moo/install.py` to automate installation on an existing MOO, or run its `setup.sh --register-codex` for a fresh lab. The account must have version 1 of the lab's `@mcp` feature attached. Call `hello` to verify it. The structured tools send one request to `@mcp` and wait for its matching response. All tools share the same connection, timeouts, and command queue. The core `run_moo_command` and `run_moo_eval` tools also use the selected account's MOO permissions.

To expose both tool sets on one account, use `config/combined.tools.json`. Every tool keeps its standalone name. For a lab MOO and a separate Sindome MOO, configure two server instances with their own connection settings.

Example tool arguments:

- `verb-data` takes `{"object":"#123","verb":"describe","mode":"local"}`. Use a numbered slot for ambiguous aliases. `source.code_lines` includes any stored VMS comments.
- `search-json` takes `{"type":"things","name":"example item","scope":"#123","include_descendants":true,"limit":10}`. Supply a plain string for the name. Use the returned cursor and offset to read further pages.
