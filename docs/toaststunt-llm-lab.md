# ToastStunt LLM Lab profile

Set `MOO_TOOLS_CONFIG` to the absolute path of `config/toaststunt-llm-lab.tools.json` and run the normal `src/index.js` entry point. The [ToastStunt LLM Lab](https://github.com/SindomeCorp/toaststunt-llm-lab) provisions the MOO, installs the feature, and passes the connection settings and profile to this process.

The account must have version 1 of the lab's `@mcp` feature attached. Call `hello` to verify it. The structured tools send one request to `@mcp` and wait for its matching response. All tools share the same connection, timeouts, and command queue. The core `run_moo_command` and `run_moo_eval` tools also use the selected account's MOO permissions.

To expose both tool sets on one account, use `config/combined.tools.json`. Lab tools then use the `lab-` prefix, including `lab-hello`. For a lab MOO and a separate Sindome MOO, configure two server instances with their own connection settings.
