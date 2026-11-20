import { randomUUID } from "node:crypto";
import { commandContext } from "../src/moo-session.js";
import { parseJsonObjectOutput, sanitizeJsonText, truncateResponse } from "./sindome.js";
import { buildSearchCommand } from "../src/search-command.js";
import { searchResponseResult } from "../src/search-response.js";

function buildErrorResult(reason, rawOutput, objectRef, verbName) {
  return {
    error: true,
    reason,
    object: objectRef,
    verbname: verbName,
    raw_output: rawOutput
  };
}

function parseVerbListing(rawOutput, objectRef, verbName) {
  const normalized = rawOutput.replace(/\r\n/g, "\n").trim();
  const missingVerbMatch = normalized.match(
    /(?:^|\n)(That object does not define that verb\.)\s*$/i
  );
  if (missingVerbMatch) {
    return buildErrorResult(
      missingVerbMatch[1],
      rawOutput,
      objectRef,
      verbName
    );
  }

  const permissionDeniedMatch = normalized.match(
    /(?:^|\n)([^:\n]+:[^\n]+)\s+--\s+Permission denied\s*$/i
  );
  if (permissionDeniedMatch) {
    return buildErrorResult(
      `Permission denied listing ${permissionDeniedMatch[1]}.`,
      rawOutput,
      objectRef,
      verbName
    );
  }

  const lines = normalized.split("\n");
  const signaturePattern =
    /^(\$[A-Za-z0-9_]+|#\d+):(?:"([^"]+)"|([^\s]+))\s*(.*)$/;
  const signatureIndex = lines.findIndex((line) =>
    signaturePattern.test(line.trim())
  );
  const signatureLine = signatureIndex >= 0 ? lines[signatureIndex].trim() : "";
  const signature = signatureLine.match(signaturePattern);
  if (!signature) {
    return buildErrorResult("Unexpected @list response format.", rawOutput, objectRef, verbName);
  }

  const [, object, quotedVerbNames, singleVerbName, parsedArgs = ""] = signature;
  const parsedVerb = quotedVerbNames ?? singleVerbName ?? "";
  const verbAliases = parsedVerb.split(/\s+/).filter(Boolean);
  const notesIndex = lines.findIndex(
    (line, index) => index > signatureIndex && line.trim() === "VMS NOTES"
  );
  if (notesIndex === -1 || signatureIndex === -1 || notesIndex <= signatureIndex) {
    return buildErrorResult(
      "Missing VMS NOTES section in @list response.",
      rawOutput,
      objectRef,
      verbName
    );
  }

  const sourceLines = lines
    .slice(signatureIndex + 1, notesIndex)
    .map((line) => line.replace(/^\s*\d+:\s?/, ""));
  const sourceCode = sourceLines.join("\n").trim();
  const vmsNotes = lines.slice(notesIndex).join("\n").trim();

  return {
    error: false,
    object,
    verbname: parsedVerb,
    verb_aliases: verbAliases,
    verb_args: parsedArgs.trim(),
    source_code: sourceCode,
    vms_notes: vmsNotes
  };
}

function parseVerbInfoOutput(rawOutput, arg) {
  const normalized = sanitizeJsonText(rawOutput);
  let parsed;

  try {
    parsed = JSON.parse(normalized);
  } catch {
    return {
      error: true,
      reason: "Got back invalid JSON from the MOO.",
      arg,
      truncated_response: truncateResponse(rawOutput),
      raw_output: rawOutput
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      error: true,
      reason: "Got back invalid JSON from the MOO (expected a JSON object).",
      arg,
      truncated_response: truncateResponse(rawOutput),
      raw_output: rawOutput
    };
  }

  const source = parsed.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const codeLines = source.code_lines;
    if (Array.isArray(codeLines) && codeLines.every((line) => typeof line === "string")) {
      source.code = codeLines.join("\n");
    }
  }

  return {
    error: false,
    arg,
    verb_info: parsed
  };
}

function validateVerbInfoArg(rawArg) {
  const arg = String(rawArg ?? "").trim();
  const usage =
    "Usage: `obj:verb_spec` where obj is `#1234` or `$cored_ref`, separator is `:` or `::`, and `verb_spec` is any non-empty string (for example `#24608:outgoing_bridges`, `#24608:@asdf`, `#24608::\"_asdf\"`).";

  if (!arg) {
    throw new Error(`\`arg\` must be a non-empty string. ${usage}`);
  }

  const match = arg.match(/^(\$[A-Za-z0-9_]+|#\d+)(::?)([\s\S]+)$/);
  if (!match) {
    throw new Error(`Invalid \`arg\`. ${usage}`);
  }

  const objectRef = match[1];
  const separator = match[2];
  const verbSpec = match[3].trim();
  if (!verbSpec) {
    throw new Error(`Invalid \`arg\`. ${usage}`);
  }

  return `${objectRef}${separator}${verbSpec}`;
}

function validateObjectRefArg(rawArg) {
  const arg = String(rawArg ?? "").trim();

  if (!arg) {
    throw new Error("`arg` must be a non-empty string.");
  }

  if (!/^(\$[A-Za-z0-9_]+|#\d+)$/.test(arg)) {
    throw new Error("`arg` must be a cored reference like `$string_utils` or object id like `#1234`.");
  }

  return arg;
}

function validateInput(args) {
  const objectRef = String(args?.object ?? "").trim();
  const verbName = String(args?.verb ?? "").trim();

  if (!/^(\$[A-Za-z0-9_]+|#\d+)$/.test(objectRef)) {
    throw new Error("`object` must be a cored reference like `$string_utils` or object id like `#1234`.");
  }

  if (!verbName) {
    throw new Error("`verb` must be a non-empty string.");
  }

  return { objectRef, verbName };
}

function formatListVerbSpec(verbName) {
  if (/^[A-Za-z0-9_]+$/.test(verbName)) {
    return verbName;
  }

  return JSON.stringify(verbName);
}


// These tools use the existing Sindome command contracts.
export function createTools({ config, mooSession, logger: baseLogger }) {
  const codeSearchTimeoutMs = Number(
    process.env["moo-code-search-timeout-ms"] || process.env.MOO_CODE_SEARCH_TIMEOUT_MS || 15000
  );
  if (!Number.isFinite(codeSearchTimeoutMs) || codeSearchTimeoutMs <= 0) {
    throw new Error("Invalid code-search timeout. Set moo-code-search-timeout-ms (or MOO_CODE_SEARCH_TIMEOUT_MS) to a positive number.");
  }
  const tools = [
    {
      "name": "get_moo_verb_source",
      "description": "Fetches source code for a MOO verb via @list and parses source vs VMS notes. Returns source_code separately from vms_notes: source_code alone is not a complete upload, and the rendered VMS NOTES heading is not MOO source. Before every full-source edit, including documentation/readability edits, capture complete original source and retain all existing bottom VMS NOTE strings, VMS VERSION, and Last modified annotations verbatim as upload input. If annotations are missing or conflicting, stop and reconcile before programming. Edit only the intended body; never assume save reconstructs omitted history. Use @program, full source with preserved annotations, dot, and one-line VMS note; let normal VMS save add the current note and update version/attribution. Immediately read back full source and verify retained note history, current note, updated attribution, and a nondecreasing version incremented as expected; executable-code and metadata checks alone are insufficient.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "object": {
            "type": "string",
            "description": "Cored object ref like `$string_utils` or object id like `#1234`."
          },
          "verb": {
            "type": "string",
            "description": "Verb name as any non-empty string."
          }
        },
        "required": [
          "object",
          "verb"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "verb-data",
      "description": "Runs @verb-data <arg> where arg is obj:verb_spec (for example `#1234:look`, `#24608:@asdf`, or `#24608::\"_asdf\"`), parses JSON response, and enriches source.code from source.code_lines when available. Before every full-source edit, including documentation/readability edits, capture complete original source and retain all existing bottom VMS NOTE strings, VMS VERSION, and Last modified annotations verbatim as upload input. If annotations are missing or conflicting, stop and reconcile before programming. Edit only the intended body; never assume save reconstructs omitted history. Use @program, full source with preserved annotations, dot, and one-line VMS note; let normal VMS save add the current note and update version/attribution. Immediately read back full source and verify retained note history, current note, updated attribution, and a nondecreasing version incremented as expected; executable-code and metadata checks alone are insufficient.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Required format: `obj:verb_spec` where obj is `#1234` or `$cored_ref`, separator is `:` or `::`, and `verb_spec` is any non-empty string (e.g. `#22664:foo`, `#24608:@asdf`, or `#24608::\"_asdf\"`)."
          }
        },
        "required": [
          "arg"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "verbs-json",
      "description": "Runs @verbs-json <arg> where arg is `#1234` or `$cored_ref`, and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Object reference in the format `#1234` or `$cored_ref` (for example `#15840` or `$string_utils`)."
          }
        },
        "required": [
          "arg"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "props-json",
      "description": "Runs @props-json <arg> where arg is `#1234` or `$cored_ref`, and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Object reference in the format `#1234` or `$cored_ref` (for example `#15840` or `$string_utils`)."
          }
        },
        "required": [
          "arg"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "contents",
      "description": "Runs @contents <arg> where arg is `#1234` or `$cored_ref`, and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Object reference in the format `#1234` or `$cored_ref` (for example `#15840` or `$string_utils`)."
          }
        },
        "required": [
          "arg"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "location",
      "description": "Runs @location-json <arg> where arg is `#1234` or `$cored_ref`, and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Object reference in the format `#1234` or `$cored_ref` (for example `#15840` or `$string_utils`)."
          }
        },
        "required": [
          "arg"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "cored_json",
      "description": "Runs @cored-json with an optional arg and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Optional argument string. When omitted or empty, runs `@cored-json`."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "defines_verb_json",
      "description": "Runs @defines-verb-json with an optional arg and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Verb name to search for. When omitted or empty, runs `@defines-verb-json` to preserve verb-side usage errors."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "defines_prop_json",
      "description": "Runs @defines-prop-json with an optional arg and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Property name to search for. When omitted or empty, runs `@defines-prop-json` to preserve verb-side usage errors."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "show-json",
      "description": "Runs @show-json <arg>.<property> where arg is `#1234` or `$cored_ref` and property is optional, then joins fragmented output and returns parsed JSON.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Object reference in the format `#1234` or `$cored_ref` (for example `#15840` or `$slither`)."
          },
          "property": {
            "type": "string",
            "description": "Optional property name to append as `<arg>.<property>` when calling `@show-json`."
          }
        },
        "required": [
          "arg"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "search-json",
      "description": "Runs @search-json --help or @search-json <type> [filters], then parses and returns the JSON object response. Typed filter strings are literal values: do not add command quotes. Control characters and line separators are rejected.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "help": {
            "type": "boolean",
            "description": "When true, runs `@search-json --help`."
          },
          "type": {
            "type": "string",
            "description": "Search type when `help` is not true. Canonical values: `rooms`, `exits`, `npcs`, `players`, `players-all`, `avatars`, `vehicles`, `jobs`, `attacks`, `channels`, `wares`, `things`."
          },
          "name": {
            "type": "string",
            "description": "Optional name filter, sent as `n=<value>`."
          },
          "location": {
            "type": "string",
            "description": "Optional location filter, sent as `l=<value>`."
          },
          "parent": {
            "type": "string",
            "description": "Optional parent filter, sent as `p=<value>`."
          },
          "sic": {
            "type": "string",
            "description": "Optional SIC filter, sent as `a=<value>`."
          },
          "prop": {
            "type": "string",
            "description": "Optional property filter, sent as `prop=<value>`."
          },
          "mutex": {
            "type": "string",
            "description": "Optional mutex filter, sent as `mutex=<value>`."
          },
          "moved_by": {
            "type": "string",
            "description": "Optional moved-by filter, sent as `w=<value>`."
          },
          "generics_only": {
            "type": "boolean",
            "description": "Optional flag; when true appends `-g`."
          },
          "mementos_only": {
            "type": "boolean",
            "description": "Optional flag; when true appends `-m`."
          },
          "limit": {
            "type": "integer",
            "description": "Optional positive integer limit, sent as `limit=<value>`."
          },
          "extra_filters": {
            "type": "array",
            "description": "Optional additional filter tokens appended as-is.",
            "items": {
              "type": "string"
            }
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "run_moo_code_search",
      "description": "Runs @code-search <pattern> on the MOO (optionally with --scope), converts the response to a JSON object, and returns it as `value`.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "Pattern text to search with @code-search."
          },
          "scope": {
            "type": "string",
            "description": "Optional scope target like `#98` or `$su`, sent as `--scope=<value>`."
          },
          "include_descendants": {
            "type": "boolean",
            "description": "Optional flag; only accepted value is `true`, and it can only be used with `scope`."
          },
          "max_matches": {
            "type": "integer",
            "description": "Optional maximum match count. Must be an integer greater than 0; sent as `--max_matches=<integer>`."
          },
          "count_only": {
            "type": "boolean",
            "description": "Optional flag; only accepted value is `true`, sent as `--count_only=true`."
          },
          "match_type": {
            "type": "string",
            "description": "Optional match type. Allowed values: `simple` (default) or `regex`; sent as `--match_type=<value>`."
          }
        },
        "required": [
          "pattern"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "prop-search",
      "description": "Runs @prop-grep-json <pattern> on the MOO with required --scope and the same options as run_moo_code_search, converts the response to a JSON object, and returns it as `value`.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "pattern": {
            "type": "string",
            "description": "Pattern text to search with @prop-grep-json."
          },
          "scope": {
            "type": "string",
            "description": "Required scope target like `#98` or `$su`, sent as `--scope=<value>`."
          },
          "include_descendants": {
            "type": "boolean",
            "description": "Optional flag; only accepted value is `true`, and it can only be used with `scope`."
          },
          "max_matches": {
            "type": "integer",
            "description": "Optional maximum match count. Must be an integer greater than 0; sent as `--max_matches=<integer>`."
          },
          "count_only": {
            "type": "boolean",
            "description": "Optional flag; only accepted value is `true`, sent as `--count_only=true`."
          },
          "match_type": {
            "type": "string",
            "description": "Optional match type. Allowed values: `simple` (default) or `regex`; sent as `--match_type=<value>`."
          }
        },
        "required": [
          "pattern",
          "scope"
        ],
        "additionalProperties": false
      }
    }
  ];
  const callToolHandler = async (request, extra) => {
    const connectionId = extra?.sessionId ?? "stdio";
    const logger = baseLogger.child({ connectionId });

    if (!tools.some(tool => tool.name === request.params.name)) {
      throw new Error(`Unknown tool: ${request.params.name}`);
    }

    // Only record validated tool names; arguments and command contents stay private.
    const context = commandContext.getStore();
    if (context) {
      context.connectionId = connectionId;
      context.toolName = request.params.name;
    }
    const requestId = commandContext.getStore()?.requestId ?? randomUUID();

    if (request.params.name === "get_moo_verb_source") {
      let objectRef;
      let verbName;

      try {
        ({ objectRef, verbName } = validateInput(request.params.arguments));
      } catch (error) {
        logger.error("Tool input validation failed", {
          event: "tool_validation_error",
          requestId,
          error: error.message
        });

        const result = buildErrorResult(error.message, "", "", "");
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      logger.info("MOO verb source requested", {
        event: "tool_request",
        requestId,
        object: objectRef,
        verb: verbName
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const message = error.message || "MOO session is not logged in.";
        logger.error(message, {
          event: "tool_request_not_logged_in",
          requestId,
          object: objectRef,
          verb: verbName
        });

        const result = buildErrorResult(message, "", objectRef, verbName);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        const output = await mooSession.runCommand(
          `@list ${objectRef}:${formatListVerbSpec(verbName)}`
        );
        const parsed = parseVerbListing(output, objectRef, verbName);

        if (parsed.error) {
          logger.error("Failed to parse @list output", {
            event: "tool_parse_error",
            requestId,
            object: objectRef,
            verb: verbName
          });
        } else {
          logger.info("Successfully fetched verb source", {
            event: "tool_success",
            requestId,
            object: objectRef,
            verb: verbName
          });
        }

        return {
          isError: Boolean(parsed.error),
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error("Command execution failed", {
          event: "tool_execution_error",
          requestId,
          object: objectRef,
          verb: verbName,
          error: error.message
        });

        const result = buildErrorResult(error.message, "", objectRef, verbName);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    if (request.params.name === "verb-data") {
      let arg;
      try {
        arg = validateVerbInfoArg(request.params.arguments?.arg);
      } catch (error) {
        const result = {
          error: true,
          reason: error.message,
          arg: String(request.params.arguments?.arg ?? "").trim(),
          raw_output: ""
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      logger.info("MOO verb info requested", {
        event: "tool_verb_info_request",
        requestId,
        arg
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = {
          error: true,
          reason: error.message || "MOO session is not logged in.",
          arg,
          raw_output: ""
        };
        logger.error("MOO session is not logged in.", {
          event: "tool_verb_info_not_logged_in",
          requestId,
          arg
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        const captured = await mooSession.runCommandCaptureUntilIdle(
          `@verb-data ${arg}`,
          config.idleCaptureMs,
          config.firstResponseTimeoutMs
        );
        const parsed = parseVerbInfoOutput(captured.output, arg);

        if (parsed.error) {
          logger.error("Failed to parse @verb-data output", {
            event: "tool_verb_info_parse_error",
            requestId,
            arg
          });
        } else {
          logger.info("Successfully executed @verb-data", {
            event: "tool_verb_info_success",
            requestId,
            arg
          });
        }

        return {
          isError: Boolean(parsed.error),
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error("@verb-data execution failed", {
          event: "tool_verb_info_execution_error",
          requestId,
          arg,
          error: error.message
        });

        const result = {
          error: true,
          reason: error.message,
          arg,
          raw_output: ""
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    if (
      request.params.name === "verbs-json" ||
      request.params.name === "props-json" ||
      request.params.name === "contents" ||
      request.params.name === "location"
    ) {
      let arg;
      try {
        arg = validateObjectRefArg(request.params.arguments?.arg);
      } catch (error) {
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const commandName = request.params.name;
      let command;
      if (commandName === "verbs-json") {
        command = `@verbs-json ${arg}`;
      } else if (commandName === "props-json") {
        command = `@props-json ${arg}`;
      } else if (commandName === "contents") {
        command = `@contents-json ${arg}`;
      } else {
        command = `@location-json ${arg}`;
      }

      logger.info("MOO object JSON requested", {
        event: "tool_object_json_request",
        requestId,
        commandName,
        arg
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_object_json_not_logged_in",
          requestId,
          commandName,
          arg
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        const captured = await mooSession.runCommandCaptureUntilIdle(
          command,
          config.idleCaptureMs,
          config.firstResponseTimeoutMs
        );
        const parsed = parseJsonObjectOutput(captured.output);
        if (!parsed) {
          const isNewJsonCommand =
            commandName === "contents" || commandName === "location";
          const result = isNewJsonCommand
            ? { error: "unable to parse result into json" }
            : {
                error: "unable to parse result into json",
                truncated_response: truncateResponse(captured.output)
              };
          logger.error("Failed to parse object JSON output", {
            event: "tool_object_json_parse_error",
            requestId,
            commandName,
            arg
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        logger.info("Successfully executed object JSON command", {
          event: "tool_object_json_success",
          requestId,
          commandName,
          arg
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error("Object JSON command execution failed", {
          event: "tool_object_json_execution_error",
          requestId,
          commandName,
          arg,
          error: error.message
        });
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    if (request.params.name === "cored_json") {
      const argRaw = request.params.arguments?.arg;
      if (argRaw !== undefined && argRaw !== null && typeof argRaw !== "string") {
        const result = { error: "`arg` must be a string when provided." };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const arg = String(argRaw ?? "").trim();
      const command = arg ? `@cored-json ${arg}` : "@cored-json";

      logger.info("MOO cored-json requested", {
        event: "tool_cored_json_request",
        requestId,
        arg: arg || undefined
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_cored_json_not_logged_in",
          requestId,
          arg: arg || undefined
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        const captured = await mooSession.runCommandCaptureUntilIdle(
          command,
          config.idleCaptureMs,
          config.firstResponseTimeoutMs
        );
        const parsed = parseJsonObjectOutput(captured.output);
        if (!parsed) {
          const result = {
            error: "unable to parse result into json",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error("Failed to parse @cored-json output", {
            event: "tool_cored_json_parse_error",
            requestId,
            arg: arg || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        if (
          !Object.prototype.hasOwnProperty.call(parsed, "arg") ||
          !Object.prototype.hasOwnProperty.call(parsed, "mode") ||
          !Object.prototype.hasOwnProperty.call(parsed, "count") ||
          !Object.prototype.hasOwnProperty.call(parsed, "records")
        ) {
          const result = {
            error: "unexpected @cored-json response shape",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error("Invalid @cored-json JSON shape", {
            event: "tool_cored_json_parse_error",
            requestId,
            arg: arg || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        logger.info("Successfully executed @cored-json", {
          event: "tool_cored_json_success",
          requestId,
          arg: arg || undefined
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error("@cored-json execution failed", {
          event: "tool_cored_json_execution_error",
          requestId,
          arg: arg || undefined,
          error: error.message
        });
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    if (request.params.name === "defines_verb_json") {
      const argRaw = request.params.arguments?.arg;
      if (argRaw !== undefined && argRaw !== null && typeof argRaw !== "string") {
        const result = { error: "`arg` must be a string when provided." };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const arg = String(argRaw ?? "").trim();
      const command = arg ? `@defines-verb-json ${arg}` : "@defines-verb-json";

      logger.info("MOO defines-verb-json requested", {
        event: "tool_defines_verb_json_request",
        requestId,
        arg: arg || undefined
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_defines_verb_json_not_logged_in",
          requestId,
          arg: arg || undefined
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        const captured = await mooSession.runCommandCaptureUntilIdle(
          command,
          config.idleCaptureMs,
          config.firstResponseTimeoutMs
        );
        const parsed = parseJsonObjectOutput(captured.output);
        if (!parsed) {
          const result = {
            error: "unable to parse result into json",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error("Failed to parse @defines-verb-json output", {
            event: "tool_defines_verb_json_parse_error",
            requestId,
            arg: arg || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
          logger.info("@defines-verb-json returned verb-side error payload", {
            event: "tool_defines_verb_json_verb_error",
            requestId,
            arg: arg || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(parsed, null, 2)
              }
            ]
          };
        }

        if (
          !Object.prototype.hasOwnProperty.call(parsed, "query") ||
          !Object.prototype.hasOwnProperty.call(parsed, "result_count") ||
          !Object.prototype.hasOwnProperty.call(parsed, "results")
        ) {
          const result = {
            error: "unexpected @defines-verb-json response shape",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error("Invalid @defines-verb-json JSON shape", {
            event: "tool_defines_verb_json_parse_error",
            requestId,
            arg: arg || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        logger.info("Successfully executed @defines-verb-json", {
          event: "tool_defines_verb_json_success",
          requestId,
          arg: arg || undefined
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error("@defines-verb-json execution failed", {
          event: "tool_defines_verb_json_execution_error",
          requestId,
          arg: arg || undefined,
          error: error.message
        });
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    if (request.params.name === "defines_prop_json") {
      const argRaw = request.params.arguments?.arg;
      if (argRaw !== undefined && argRaw !== null && typeof argRaw !== "string") {
        const result = { error: "`arg` must be a string when provided." };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const arg = String(argRaw ?? "").trim();
      const command = arg ? `@defines-prop-json ${arg}` : "@defines-prop-json";

      logger.info("MOO defines-prop-json requested", {
        event: "tool_defines_prop_json_request",
        requestId,
        arg: arg || undefined
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_defines_prop_json_not_logged_in",
          requestId,
          arg: arg || undefined
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        const captured = await mooSession.runCommandCaptureUntilIdle(
          command,
          config.idleCaptureMs,
          config.firstResponseTimeoutMs
        );
        const parsed = parseJsonObjectOutput(captured.output);
        if (!parsed) {
          const result = {
            error: "unable to parse result into json",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error("Failed to parse @defines-prop-json output", {
            event: "tool_defines_prop_json_parse_error",
            requestId,
            arg: arg || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        if (Object.prototype.hasOwnProperty.call(parsed, "error")) {
          logger.info("@defines-prop-json returned verb-side error payload", {
            event: "tool_defines_prop_json_verb_error",
            requestId,
            arg: arg || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(parsed, null, 2)
              }
            ]
          };
        }

        if (
          !Object.prototype.hasOwnProperty.call(parsed, "query") ||
          !Object.prototype.hasOwnProperty.call(parsed, "result_count") ||
          !Object.prototype.hasOwnProperty.call(parsed, "results")
        ) {
          const result = {
            error: "unexpected @defines-prop-json response shape",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error("Invalid @defines-prop-json JSON shape", {
            event: "tool_defines_prop_json_parse_error",
            requestId,
            arg: arg || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        logger.info("Successfully executed @defines-prop-json", {
          event: "tool_defines_prop_json_success",
          requestId,
          arg: arg || undefined
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error("@defines-prop-json execution failed", {
          event: "tool_defines_prop_json_execution_error",
          requestId,
          arg: arg || undefined,
          error: error.message
        });
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    if (request.params.name === "show-json") {
      let arg;
      try {
        arg = validateObjectRefArg(request.params.arguments?.arg);
      } catch (error) {
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const propertyRaw = request.params.arguments?.property;
      const property = propertyRaw == null ? "" : String(propertyRaw).trim();
      if (propertyRaw !== undefined && property.length === 0) {
        const result = { error: "`property` must be a non-empty string when provided." };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const commandArg = property ? `${arg}.${property}` : arg;
      const command = `@show-json ${commandArg}`;

      logger.info("MOO show-json requested", {
        event: "tool_show_json_request",
        requestId,
        arg,
        property: property || undefined
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_show_json_not_logged_in",
          requestId,
          arg,
          property: property || undefined
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        const captured = await mooSession.runCommandCaptureFragmentsUntilIdle(
          command,
          config.idleCaptureMs,
          config.firstResponseTimeoutMs
        );
        const parsed = parseJsonObjectOutput(captured.output);

        if (!parsed) {
          const result = {
            error: "unable to parse result into json",
            message: sanitizeJsonText(captured.output)
          };
          logger.error("Failed to parse @show-json output", {
            event: "tool_show_json_parse_error",
            requestId,
            arg,
            property: property || undefined
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        logger.info("Successfully executed @show-json", {
          event: "tool_show_json_success",
          requestId,
          arg,
          property: property || undefined
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(parsed, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error("@show-json execution failed", {
          event: "tool_show_json_execution_error",
          requestId,
          arg,
          property: property || undefined,
          error: error.message
        });
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    if (request.params.name === "search-json") {
      const args = request.params.arguments ?? {};
      const help = args.help === true;
      const typeRaw = args.type;
      const type = typeRaw == null ? "" : String(typeRaw).trim();
      const supportedTypes = new Set([
        "rooms",
        "exits",
        "npcs",
        "players",
        "players-all",
        "avatars",
        "vehicles",
        "jobs",
        "attacks",
        "channels",
        "wares",
        "things"
      ]);

      if (!help && !type) {
        const result = {
          error: "`type` must be a non-empty string when `help` is not true."
        };
        logger.error("search-json validation failed", {
          event: "tool_search_json_validation_error",
          requestId,
          help
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (!help && !supportedTypes.has(type)) {
        const result = {
          error:
            "`type` must be one of: rooms, exits, npcs, players, players-all, avatars, vehicles, jobs, attacks, channels, wares, things."
        };
        logger.error("search-json validation failed", {
          event: "tool_search_json_validation_error",
          requestId,
          help,
          type
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const limitRaw = args.limit;
      const hasLimit = limitRaw !== undefined;
      const limit = Number(limitRaw);
      if (hasLimit && (!Number.isInteger(limit) || limit <= 0)) {
        const result = {
          error: "`limit` must be a positive integer."
        };
        logger.error("search-json validation failed", {
          event: "tool_search_json_validation_error",
          requestId,
          help,
          type: type || undefined,
          limit: limitRaw
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const extraFiltersRaw = args.extra_filters;
      if (extraFiltersRaw !== undefined && !Array.isArray(extraFiltersRaw)) {
        const result = {
          error: "`extra_filters` must be an array of non-empty strings."
        };
        logger.error("search-json validation failed", {
          event: "tool_search_json_validation_error",
          requestId,
          help,
          type: type || undefined
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      const extraFilters = (extraFiltersRaw ?? []).map((filter) => String(filter).trim());
      if (extraFilters.some((filter) => filter.length === 0)) {
        const result = {
          error: "`extra_filters` must be an array of non-empty strings."
        };
        logger.error("search-json validation failed", {
          event: "tool_search_json_validation_error",
          requestId,
          help,
          type: type || undefined
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      let command;
      try {
        command = buildSearchCommand(args);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ error: error.message }) }]
        };
      }

      logger.info("MOO search-json requested", {
        event: "tool_search_json_request",
        requestId,
        help,
        type: help ? undefined : type,
        command
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_search_json_not_logged_in",
          requestId,
          help,
          type: help ? undefined : type
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        let result;
        const captured = await mooSession.runSearchCapture(
          command,
          config.idleCaptureMs,
          config.firstResponseTimeoutMs,
          config.searchTimeoutMs,
          capture => {
            result = searchResponseResult(capture, parseJsonObjectOutput, { secrets: [config.password] });
            const diagnostic = result.isError ? JSON.parse(result.content[0].text) : {};
            return !["moo_incomplete_response", "moo_invalid_json", "moo_empty_response"].includes(diagnostic.error);
          }
        );
        // Non-idle captures already retired the stream inside the queue.
        result ??= searchResponseResult(captured, parseJsonObjectOutput, { secrets: [config.password] });
        logger.info("MOO search-json capture finished", {
          event: "tool_search_json_capture",
          requestId,
          help,
          type: help ? undefined : type,
          isError: result.isError,
          ...captured.capture
        });
        return result;
      } catch (error) {
        logger.error("@search-json execution failed", {
          event: "tool_search_json_execution_error",
          requestId,
          help,
          type: help ? undefined : type,
          error: error.message
        });
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    if (request.params.name === "run_moo_code_search" || request.params.name === "prop-search") {
      const isPropSearch = request.params.name === "prop-search";
      const toolName = isPropSearch ? "prop-search" : "code-search";
      const commandName = isPropSearch ? "@prop-grep-json" : "@code-search";
      const eventPrefix = isPropSearch ? "tool_prop_search" : "tool_code_search";
      const pattern = String(request.params.arguments?.pattern ?? "").trim();
      const scopeRaw = request.params.arguments?.scope;
      const scope = scopeRaw == null ? "" : String(scopeRaw).trim();
      const includeDescendantsRaw = request.params.arguments?.include_descendants;
      const includeDescendants = includeDescendantsRaw === true;
      const maxMatchesRaw = request.params.arguments?.max_matches;
      const hasMaxMatches = maxMatchesRaw !== undefined;
      const maxMatches = Number(maxMatchesRaw);
      const countOnlyRaw = request.params.arguments?.count_only;
      const countOnly = countOnlyRaw === true;
      const matchTypeRaw = request.params.arguments?.match_type;
      const matchType = String(matchTypeRaw ?? "simple").trim().toLowerCase();

      if (!pattern) {
        const result = {
          error: "`pattern` must be a non-empty string."
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (isPropSearch && !scope) {
        const result = {
          error: "`scope` must be a non-empty string."
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (includeDescendantsRaw !== undefined && includeDescendantsRaw !== true) {
        const result = {
          error: "`include_descendants` only accepts the value `true`."
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (includeDescendants && !scope) {
        const result = {
          error: "option can only be used in conjunction with --scope"
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (scope && !/^(\$[A-Za-z0-9_]+|#\d+)$/.test(scope)) {
        const result = {
          error: "`scope` must look like `#98` or `$su`."
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (
        hasMaxMatches &&
        (!Number.isInteger(maxMatches) || maxMatches <= 0)
      ) {
        const result = {
          error: "`max_matches` must be an integer greater than 0."
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (countOnlyRaw !== undefined && countOnlyRaw !== true) {
        const result = {
          error: "count_only only accepts a boolean true for the argument."
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      if (matchType !== "simple" && matchType !== "regex") {
        const result = {
          error: "`match_type` must be either `simple` or `regex`."
        };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      logger.info(`MOO ${toolName} requested`, {
        event: `${eventPrefix}_request`,
        requestId,
        pattern,
        scope: scope || undefined,
        includeDescendants,
        maxMatches: hasMaxMatches ? maxMatches : undefined,
        countOnly,
        matchType
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = {
          error: error.message || "MOO session is not logged in."
        };
        logger.error("MOO session is not logged in.", {
          event: `${eventPrefix}_not_logged_in`,
          requestId,
          pattern,
          scope: scope || undefined,
          includeDescendants,
          maxMatches: hasMaxMatches ? maxMatches : undefined,
          countOnly,
          matchType
        });
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      try {
        let command = `${commandName} ${JSON.stringify(pattern)}`;
        if (scope) {
          command += ` --scope=${scope}`;
        }
        if (includeDescendants) {
          command += " --include_descendants=true";
        }
        if (hasMaxMatches) {
          command += ` --max_matches=${maxMatches}`;
        }
        if (countOnly) {
          command += " --count_only=true";
        }
        command += ` --match_type=${matchType}`;
        const captured = await mooSession.runCommandCaptureUntilIdle(
          command,
          config.idleCaptureMs,
          codeSearchTimeoutMs
        );

        let parsed;
        try {
          parsed = JSON.parse(sanitizeJsonText(captured.output));
        } catch {
          const result = {
            error: "unable to convert result to json",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error(`Failed to parse ${commandName} output`, {
            event: `${eventPrefix}_parse_error`,
            requestId,
            pattern,
            scope: scope || undefined,
            includeDescendants,
            maxMatches: hasMaxMatches ? maxMatches : undefined,
            countOnly,
            matchType
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          const result = {
            error: "unable to convert result to json",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error(`Invalid ${commandName} JSON type`, {
            event: `${eventPrefix}_parse_error`,
            requestId,
            pattern,
            scope: scope || undefined,
            includeDescendants,
            maxMatches: hasMaxMatches ? maxMatches : undefined,
            countOnly,
            matchType
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          };
        }

        logger.info(`Successfully executed ${commandName}`, {
          event: `${eventPrefix}_success`,
          requestId,
          pattern,
          scope: scope || undefined,
          includeDescendants,
          maxMatches: hasMaxMatches ? maxMatches : undefined,
          countOnly,
          matchType
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify({ value: parsed }, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error(`${commandName} execution failed`, {
          event: `${eventPrefix}_execution_error`,
          requestId,
          pattern,
          scope: scope || undefined,
          includeDescendants,
          maxMatches: hasMaxMatches ? maxMatches : undefined,
          countOnly,
          matchType,
          error: error.message
        });
        const result = { error: error.message };
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  };
  return { tools, callTool: callToolHandler };
}
