import { randomUUID } from "node:crypto";
import { commandContext } from "../src/moo-session.js";
import { parseEvalOutput } from "../src/core-tools.js";

const LIST_TIMEOUT_MS = 15000;

export function truncateResponse(rawOutput) {
  return String(rawOutput ?? "").slice(0, 500);
}

export function parseJsonObjectOutput(rawOutput) {
  const normalized = sanitizeJsonText(rawOutput);
  const extracted = extractFirstJsonObjectText(normalized);
  const candidates = [normalized];
  if (extracted && extracted !== normalized) {
    candidates.push(extracted);
  }

  let parsed = null;
  for (const candidate of candidates) {
    parsed = tryParseJsonObject(candidate);
    if (parsed) {
      break;
    }

    const repaired = escapeRawNewlinesInsideJsonStrings(candidate);
    if (repaired !== candidate) {
      parsed = tryParseJsonObject(repaired);
      if (parsed) {
        break;
      }
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed;
}

function tryParseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function escapeRawNewlinesInsideJsonStrings(text) {
  const input = String(text ?? "");
  let output = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inString) {
      if (escaped) {
        output += char;
        escaped = false;
        continue;
      }

      if (char === "\\") {
        output += char;
        escaped = true;
        continue;
      }

      if (char === "\"") {
        output += char;
        inString = false;
        continue;
      }

      if (char === "\r") {
        if (input[i + 1] === "\n") {
          i += 1;
        }
        output += "\\n";
        continue;
      }

      if (char === "\n") {
        output += "\\n";
        continue;
      }

      output += char;
      continue;
    }

    output += char;
    if (char === "\"") {
      inString = true;
      escaped = false;
    }
  }

  return output;
}

function extractFirstJsonObjectText(text) {
  const input = String(text ?? "");
  for (let start = 0; start < input.length; start += 1) {
    if (input[start] !== "{") {
      continue;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < input.length; i += 1) {
      const char = input[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        depth += 1;
        continue;
      }

      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          return input.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

export function sanitizeJsonText(rawOutput) {
  const ansiPattern =
    /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
  const escParenTerminalCodePattern = /\u001B\([^)]*\)/g;
  const escapedEscParenTerminalCodePattern = /\\+u001[bB]\([^)]*\)/g;
  const danglingEscParenTerminalCodePattern = /\u001B\([^\r\n]*/g;
  const danglingEscapedEscParenTerminalCodePattern = /\\+u001[bB]\([^\r\n]*/g;
  const brokenColorFragmentPattern =
    /(?:\u001B\[|\u009B)\d{1,3}(?:[;:]\d{1,3})*[A-Za-z]?/g;
  const webclientColorTagPattern = /\(\d{3}\|\d{3}\|[0-9A-Za-z]{7}\)/g;

  let text = String(rawOutput ?? "").replace(/\r\n/g, "\n");
  let previous;

  do {
    previous = text;
    text = text
      .replace(ansiPattern, "")
      .replace(escParenTerminalCodePattern, "")
      .replace(escapedEscParenTerminalCodePattern, "")
      .replace(danglingEscParenTerminalCodePattern, "")
      .replace(danglingEscapedEscParenTerminalCodePattern, "")
      .replace(brokenColorFragmentPattern, "")
      .replace(webclientColorTagPattern, "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  } while (text !== previous);

  return text.trim();
}

function validateVbJsonArg(rawArg) {
  const usage = "`arg` must be a positive integer bug id or the string `last`.";

  if (typeof rawArg === "number") {
    if (!Number.isInteger(rawArg) || rawArg <= 0) {
      throw new Error(usage);
    }
    return String(rawArg);
  }

  const arg = String(rawArg ?? "").trim();
  if (!arg) {
    throw new Error(usage);
  }

  if (/^last$/i.test(arg)) {
    return "last";
  }

  if (!/^\d+$/.test(arg)) {
    throw new Error(usage);
  }

  const numeric = Number.parseInt(arg, 10);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new Error(usage);
  }

  return String(numeric);
}

function validateBugsJsonArg(rawArg) {
  if (rawArg === undefined || rawArg === null) {
    return "";
  }

  const arg = String(rawArg).trim();
  if (!arg) {
    return "";
  }

  const normalized = arg.toLowerCase();
  if (
    normalized === "new" ||
    normalized === "unassigned" ||
    normalized === "assigned" ||
    normalized === "resolved" ||
    normalized === "mine"
  ) {
    return normalized;
  }

  if (arg.length < 3) {
    throw new Error(
      "`arg` search text must be at least 3 characters, or one of: `new`, `unassigned`, `assigned`, `resolved`, `mine`."
    );
  }

  return arg;
}

function escapeMooString(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"");
}

function textToMooStringList(rawText) {
  const text = String(rawText ?? "");
  if (text.length === 0) {
    return "{}";
  }

  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length === 0) {
    return "{}";
  }

  const encoded = lines.map((line) => `"${escapeMooString(line)}"`);
  return `{${encoded.join(", ")}}`;
}

function toMooStringLiteral(value) {
  return `"${escapeMooString(value)}"`;
}

function validateSubmitBotBody(rawBody) {
  if (typeof rawBody === "string") {
    if (!rawBody.trim()) {
      throw new Error("`body` must be a non-empty string or a non-empty array of strings.");
    }
    return textToMooStringList(rawBody);
  }

  if (Array.isArray(rawBody)) {
    if (rawBody.length === 0) {
      throw new Error("`body` array must contain at least one string.");
    }

    const parts = rawBody.map((entry, index) => {
      if (typeof entry !== "string") {
        throw new Error(`\`body[${index}]\` must be a string.`);
      }
      return toMooStringLiteral(entry);
    });
    return `{${parts.join(", ")}}`;
  }

  throw new Error("`body` must be a string or an array of strings.");
}

function validateOptionalTracebackJsonText(rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return toMooStringLiteral("");
  }

  if (typeof rawValue !== "string") {
    throw new Error("`traceback_json_text` must be a string when provided.");
  }

  if (rawValue.length === 0) {
    return toMooStringLiteral("");
  }

  let parsed;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("`traceback_json_text` must be valid JSON text when provided.");
  }

  return toMooStringLiteral(JSON.stringify(parsed));
}

function parseNextUnreviewedBugResult(returnValueRaw) {
  const value = String(returnValueRaw ?? "").trim().toLowerCase();

  if (value === "false" || value === "0") {
    return { hasBug: false, bugId: null };
  }

  if (!/^\d+$/.test(value)) {
    throw new Error("Unexpected return value from bot_get_next_unreviewed_bug().");
  }

  const bugId = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(bugId) || bugId <= 0) {
    return { hasBug: false, bugId: null };
  }

  return { hasBug: true, bugId };
}

function validatePositiveInteger(value, fieldName) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`\`${fieldName}\` must be a positive integer.`);
    }
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  throw new Error(`\`${fieldName}\` must be a positive integer.`);
}


export function createTools({ config, mooSession, logger: baseLogger }) {
  const tools = [
    {
      "name": "vb-json",
      "description": "Runs @vb-json <id|last> to fetch bug details and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": [
              "integer",
              "string"
            ],
            "description": "Bug id as a positive integer (for example `12345`) or the string `last` for the last viewed bug."
          }
        },
        "required": [
          "arg"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "bugs-json",
      "description": "Runs @bugs-json with an optional state/search argument and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "arg": {
            "type": "string",
            "description": "Optional: one of `new`, `unassigned`, `assigned`, `resolved`, `mine`, or a search string (minimum 3 characters). Omit for open unresolved bugs."
          }
        },
        "additionalProperties": false
      }
    },
    {
      "name": "get-next-unreviewed-bug",
      "description": "Runs `;$kaiju:bot_get_next_unreviewed_bug()` and returns JSON with the next unreviewed bug id, or an error when none are available.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "next-unreviewed-traceback-json",
      "description": "Runs `@next-unreviewed-traceback-json` with no arguments and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      }
    },
    {
      "name": "resolve-traceback",
      "description": "Runs `@resolve-traceback <id>` where `id` is an integer, and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "id": {
            "type": "integer",
            "description": "Traceback id as an integer."
          }
        },
        "required": [
          "id"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "view-traceback-json",
      "description": "Runs `@view-traceback-json <traceback_id>` and returns the parsed JSON object.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "traceback_id": {
            "type": "integer",
            "description": "Traceback id as a positive integer."
          }
        },
        "required": [
          "traceback_id"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "submit_bug",
      "description": "Runs `;$kaiju:bot_submit_bug(SUBJECT, BODY, TRACEBACK_JSON_TEXT)` where subject is a string, body is a string or list of strings, and optional traceback_json_text must be valid JSON text (multi-line accepted and normalized to one line).",
      "inputSchema": {
        "type": "object",
        "properties": {
          "subject": {
            "type": "string",
            "description": "Required non-empty subject string (max 255 characters).",
            "maxLength": 255
          },
          "body": {
            "description": "Required body as either a string or an array of strings.",
            "oneOf": [
              {
                "type": "string"
              },
              {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            ]
          },
          "traceback_json_text": {
            "type": "string",
            "description": "Optional JSON text string for traceback data. Must be valid JSON; multi-line input is accepted and normalized to a single-line JSON string."
          }
        },
        "required": [
          "subject",
          "body"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "submit_bug_comment",
      "description": "Runs `;$kaiju:bot_submit_comment(<bug_id>, <moo_comment_list>)` where comment text is converted internally into a MOO list of strings.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "bug_id": {
            "type": "integer",
            "description": "Bug id as a positive integer."
          },
          "comment": {
            "type": "string",
            "description": "Comment text. Newlines are preserved and converted into a MOO list of strings."
          }
        },
        "required": [
          "bug_id",
          "comment"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "update-llm-reviewed-timestamp",
      "description": "Runs `;$error:update_llm_reviewed_timestamp(traceback_id)` and returns success when return value is non-zero.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "traceback_id": {
            "type": "integer",
            "description": "Traceback id as a positive integer."
          }
        },
        "required": [
          "traceback_id"
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

    if (request.params.name === "vb-json") {
      let arg;
      try {
        arg = validateVbJsonArg(request.params.arguments?.arg);
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

      logger.info("MOO vb-json requested", {
        event: "tool_vb_json_request",
        requestId,
        arg
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_vb_json_not_logged_in",
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
          `@vb-json ${arg}`,
          config.idleCaptureMs,
          config.firstResponseTimeoutMs
        );
        const parsed = parseJsonObjectOutput(captured.output);
        if (!parsed) {
          const result = {
            error: "unable to parse result into json",
            truncated_response: truncateResponse(captured.output)
          };
          logger.error("Failed to parse @vb-json output", {
            event: "tool_vb_json_parse_error",
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

        logger.info("Successfully executed @vb-json", {
          event: "tool_vb_json_success",
          requestId,
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
        logger.error("@vb-json execution failed", {
          event: "tool_vb_json_execution_error",
          requestId,
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

    if (request.params.name === "bugs-json") {
      let arg;
      try {
        arg = validateBugsJsonArg(request.params.arguments?.arg);
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

      logger.info("MOO bugs-json requested", {
        event: "tool_bugs_json_request",
        requestId,
        arg: arg || undefined
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_bugs_json_not_logged_in",
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
        const command = arg ? `@bugs-json ${arg}` : "@bugs-json";
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
          logger.error("Failed to parse @bugs-json output", {
            event: "tool_bugs_json_parse_error",
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

        logger.info("Successfully executed @bugs-json", {
          event: "tool_bugs_json_success",
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
        logger.error("@bugs-json execution failed", {
          event: "tool_bugs_json_execution_error",
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

    if (request.params.name === "get-next-unreviewed-bug") {
      const evalCommand = ";$kaiju:bot_get_next_unreviewed_bug()";

      logger.info("MOO next unreviewed bug requested", {
        event: "tool_next_unreviewed_bug_request",
        requestId
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = {
          error: true,
          reason: error.message || "MOO session is not logged in."
        };
        logger.error("MOO session is not logged in.", {
          event: "tool_next_unreviewed_bug_not_logged_in",
          requestId
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
        const output = await mooSession.runCommandUntil(
          evalCommand,
          (buffer) => {
            const normalized = buffer.replace(/\r\n/g, "\n");
            const match = /(^|\r?\n)(\s*=>[^\r\n]*)(\r?\n|$)/m.exec(buffer);
            if (!match) {
              if (
                /(?:^|\n)(?:Line\s+\d+:\s+[^\n]*\n)+\d+\s+error(?:s)?\.\s*$/i.test(normalized)
              ) {
                return { done: true };
              }
              return { done: false };
            }

            const returnStart = match.index + match[1].length;
            const returnEnd = returnStart + match[2].length + match[3].length;
            const trailing = buffer.slice(returnEnd).trim();
            if (trailing.length > 0) {
              return { done: false };
            }

            return { done: true, consumedChars: returnEnd };
          },
          LIST_TIMEOUT_MS
        );
        const parsedEval = parseEvalOutput(output, evalCommand);
        if (parsedEval.error) {
          logger.error("Failed to parse eval output for next unreviewed bug", {
            event: "tool_next_unreviewed_bug_eval_parse_error",
            requestId
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(parsedEval, null, 2)
              }
            ]
          };
        }

        let parsedResult;
        try {
          parsedResult = parseNextUnreviewedBugResult(parsedEval.return_value);
        } catch (error) {
          const result = {
            error: true,
            reason: error.message || "Unexpected return value from bot_get_next_unreviewed_bug().",
            return_value: parsedEval.return_value,
            response_body: parsedEval.response_body,
            raw_output: output
          };
          logger.error("Unexpected next unreviewed bug return value", {
            event: "tool_next_unreviewed_bug_unexpected_return",
            requestId,
            returnValue: parsedEval.return_value
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

        if (!parsedResult.hasBug) {
          const result = {
            error: true,
            reason: "No unreviewed bug is available."
          };
          logger.info("No unreviewed bug available", {
            event: "tool_next_unreviewed_bug_none",
            requestId
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

        const result = {
          bug_id: parsedResult.bugId
        };
        logger.info("Found next unreviewed bug", {
          event: "tool_next_unreviewed_bug_success",
          requestId,
          bugId: parsedResult.bugId
        });
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        const result = {
          error: true,
          reason: error.message
        };
        logger.error("Next unreviewed bug command failed", {
          event: "tool_next_unreviewed_bug_execution_error",
          requestId,
          error: error.message
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
    }

    if (request.params.name === "next-unreviewed-traceback-json") {
      const command = "@next-unreviewed-traceback-json";

      logger.info("MOO next-unreviewed-traceback-json requested", {
        event: "tool_next_unreviewed_traceback_json_request",
        requestId
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_next_unreviewed_traceback_json_not_logged_in",
          requestId
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
          logger.error("Failed to parse @next-unreviewed-traceback-json output", {
            event: "tool_next_unreviewed_traceback_json_parse_error",
            requestId
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

        logger.info("Successfully executed @next-unreviewed-traceback-json", {
          event: "tool_next_unreviewed_traceback_json_success",
          requestId
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
        logger.error("@next-unreviewed-traceback-json execution failed", {
          event: "tool_next_unreviewed_traceback_json_execution_error",
          requestId,
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

    if (request.params.name === "resolve-traceback") {
      let tracebackId;
      try {
        tracebackId = validatePositiveInteger(request.params.arguments?.id, "id");
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

      const command = `@resolve-traceback ${tracebackId}`;

      logger.info("MOO resolve-traceback requested", {
        event: "tool_resolve_traceback_request",
        requestId,
        id: tracebackId
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_resolve_traceback_not_logged_in",
          requestId,
          id: tracebackId
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
          logger.error("Failed to parse @resolve-traceback output", {
            event: "tool_resolve_traceback_parse_error",
            requestId,
            id: tracebackId
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

        logger.info("Successfully executed @resolve-traceback", {
          event: "tool_resolve_traceback_success",
          requestId,
          id: tracebackId
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
        logger.error("@resolve-traceback execution failed", {
          event: "tool_resolve_traceback_execution_error",
          requestId,
          id: tracebackId,
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

    if (request.params.name === "view-traceback-json") {
      let tracebackId;
      try {
        tracebackId = validatePositiveInteger(request.params.arguments?.traceback_id, "traceback_id");
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

      const command = `@view-traceback-json ${tracebackId}`;

      logger.info("MOO view-traceback-json requested", {
        event: "tool_view_traceback_json_request",
        requestId,
        tracebackId
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = { error: error.message || "MOO session is not logged in." };
        logger.error("MOO session is not logged in.", {
          event: "tool_view_traceback_json_not_logged_in",
          requestId,
          tracebackId
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
          logger.error("Failed to parse @view-traceback-json output", {
            event: "tool_view_traceback_json_parse_error",
            requestId,
            tracebackId
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

        logger.info("Successfully executed @view-traceback-json", {
          event: "tool_view_traceback_json_success",
          requestId,
          tracebackId
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
        logger.error("@view-traceback-json execution failed", {
          event: "tool_view_traceback_json_execution_error",
          requestId,
          tracebackId,
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

    if (request.params.name === "submit_bug") {
      let subjectLiteral;
      let bodyLiteral;
      let tracebackJsonTextLiteral;

      try {
        const subject = String(request.params.arguments?.subject ?? "");
        if (!subject.trim()) {
          throw new Error("`subject` must be a non-empty string.");
        }
        if (subject.length > 255) {
          throw new Error("`subject` must be at most 255 characters.");
        }

        subjectLiteral = toMooStringLiteral(subject);
        bodyLiteral = validateSubmitBotBody(request.params.arguments?.body);
        tracebackJsonTextLiteral = validateOptionalTracebackJsonText(
          request.params.arguments?.traceback_json_text
        );
      } catch (error) {
        const result = {
          error: true,
          reason: error.message
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

      const evalCommand = `;$kaiju:bot_submit_bug(${subjectLiteral}, ${bodyLiteral}, ${tracebackJsonTextLiteral})`;

      logger.info("MOO submit_bot requested", {
        event: "tool_submit_bot_request",
        requestId
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = {
          error: true,
          reason: error.message || "MOO session is not logged in."
        };
        logger.error("MOO session is not logged in.", {
          event: "tool_submit_bot_not_logged_in",
          requestId
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
        const output = await mooSession.runCommandUntil(
          evalCommand,
          (buffer) => {
            const normalized = buffer.replace(/\r\n/g, "\n");
            const match = /(^|\r?\n)(\s*=>[^\r\n]*)(\r?\n|$)/m.exec(buffer);
            if (!match) {
              if (
                /(?:^|\n)(?:Line\s+\d+:\s+[^\n]*\n)+\d+\s+error(?:s)?\.\s*$/i.test(normalized)
              ) {
                return { done: true };
              }
              return { done: false };
            }

            const returnStart = match.index + match[1].length;
            const returnEnd = returnStart + match[2].length + match[3].length;
            const trailing = buffer.slice(returnEnd).trim();
            if (trailing.length > 0) {
              return { done: false };
            }

            return { done: true, consumedChars: returnEnd };
          },
          LIST_TIMEOUT_MS
        );

        const parsedEval = parseEvalOutput(output, evalCommand);
        if (parsedEval.error) {
          logger.error("Failed to parse eval output for submit_bot", {
            event: "tool_submit_bot_eval_error",
            requestId
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(parsedEval, null, 2)
              }
            ]
          };
        }

        logger.info("Successfully executed submit_bot", {
          event: "tool_submit_bot_success",
          requestId
        });

        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(parsedEval, null, 2)
            }
          ]
        };
      } catch (error) {
        logger.error("submit_bot execution failed", {
          event: "tool_submit_bot_execution_error",
          requestId,
          error: error.message
        });
        const result = {
          error: true,
          reason: error.message
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

    if (request.params.name === "submit_bug_comment") {
      let bugId;
      let comment;

      try {
        bugId = validatePositiveInteger(request.params.arguments?.bug_id, "bug_id");
        comment = String(request.params.arguments?.comment ?? "");
        if (!comment.trim()) {
          throw new Error("`comment` must be a non-empty string.");
        }
      } catch (error) {
        const result = {
          error: true,
          reason: error.message
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

      const commentList = textToMooStringList(comment);
      const evalCommand = `;$kaiju:bot_submit_comment(${bugId}, ${commentList})`;

      logger.info("MOO submit bug comment requested", {
        event: "tool_submit_bug_comment_request",
        requestId,
        bugId
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = {
          error: true,
          reason: error.message || "MOO session is not logged in.",
          bug_id: bugId
        };
        logger.error("MOO session is not logged in.", {
          event: "tool_submit_bug_comment_not_logged_in",
          requestId,
          bugId
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
        const output = await mooSession.runCommandUntil(
          evalCommand,
          (buffer) => {
            const normalized = buffer.replace(/\r\n/g, "\n");
            const match = /(^|\r?\n)(\s*=>[^\r\n]*)(\r?\n|$)/m.exec(buffer);
            if (!match) {
              if (
                /(?:^|\n)(?:Line\s+\d+:\s+[^\n]*\n)+\d+\s+error(?:s)?\.\s*$/i.test(normalized)
              ) {
                return { done: true };
              }
              return { done: false };
            }

            const returnStart = match.index + match[1].length;
            const returnEnd = returnStart + match[2].length + match[3].length;
            const trailing = buffer.slice(returnEnd).trim();
            if (trailing.length > 0) {
              return { done: false };
            }

            return { done: true, consumedChars: returnEnd };
          },
          LIST_TIMEOUT_MS
        );
        const parsedEval = parseEvalOutput(output, evalCommand);
        if (parsedEval.error) {
          logger.error("Failed to submit bug comment", {
            event: "tool_submit_bug_comment_eval_error",
            requestId,
            bugId
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(parsedEval, null, 2)
              }
            ]
          };
        }

        const returnValue = String(parsedEval.return_value ?? "").trim().toLowerCase();
        if (returnValue === "false" || returnValue === "0") {
          const result = {
            error: true,
            reason: "bot_submit_comment returned false.",
            bug_id: bugId,
            return_value: parsedEval.return_value,
            response_body: parsedEval.response_body,
            raw_output: output
          };
          logger.error("bot_submit_comment returned false", {
            event: "tool_submit_bug_comment_false",
            requestId,
            bugId
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

        const result = {
          bug_id: bugId,
          return_value: parsedEval.return_value,
          response_body: parsedEval.response_body
        };
        logger.info("Successfully submitted bug comment", {
          event: "tool_submit_bug_comment_success",
          requestId,
          bugId
        });
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        const result = {
          error: true,
          reason: error.message,
          bug_id: bugId
        };
        logger.error("submit_bug_comment execution failed", {
          event: "tool_submit_bug_comment_execution_error",
          requestId,
          bugId,
          error: error.message
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
    }

    if (request.params.name === "update-llm-reviewed-timestamp") {
      let tracebackId;
      try {
        tracebackId = validatePositiveInteger(request.params.arguments?.traceback_id, "traceback_id");
      } catch (error) {
        const result = {
          error: true,
          reason: error.message
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

      const evalCommand = `;$error:update_llm_reviewed_timestamp(${tracebackId})`;

      logger.info("MOO update llm reviewed timestamp requested", {
        event: "tool_update_llm_reviewed_timestamp_request",
        requestId,
        tracebackId
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = {
          error: true,
          reason: error.message || "MOO session is not logged in.",
          traceback_id: tracebackId
        };
        logger.error("MOO session is not logged in.", {
          event: "tool_update_llm_reviewed_timestamp_not_logged_in",
          requestId,
          tracebackId
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
        const output = await mooSession.runCommandUntil(
          evalCommand,
          (buffer) => {
            const normalized = buffer.replace(/\r\n/g, "\n");
            const match = /(^|\r?\n)(\s*=>[^\r\n]*)(\r?\n|$)/m.exec(buffer);
            if (!match) {
              if (
                /(?:^|\n)(?:Line\s+\d+:\s+[^\n]*\n)+\d+\s+error(?:s)?\.\s*$/i.test(normalized)
              ) {
                return { done: true };
              }
              return { done: false };
            }

            const returnStart = match.index + match[1].length;
            const returnEnd = returnStart + match[2].length + match[3].length;
            const trailing = buffer.slice(returnEnd).trim();
            if (trailing.length > 0) {
              return { done: false };
            }

            return { done: true, consumedChars: returnEnd };
          },
          LIST_TIMEOUT_MS
        );
        const parsedEval = parseEvalOutput(output, evalCommand);
        if (parsedEval.error) {
          logger.error("Failed to update llm reviewed timestamp", {
            event: "tool_update_llm_reviewed_timestamp_eval_error",
            requestId,
            tracebackId
          });
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(parsedEval, null, 2)
              }
            ]
          };
        }

        const returnValue = String(parsedEval.return_value ?? "").trim().toLowerCase();
        if (returnValue === "false" || returnValue === "0") {
          const result = {
            error: true,
            reason: "update_llm_reviewed_timestamp returned failure.",
            traceback_id: tracebackId,
            return_value: parsedEval.return_value,
            response_body: parsedEval.response_body,
            raw_output: output
          };
          logger.error("update_llm_reviewed_timestamp returned failure", {
            event: "tool_update_llm_reviewed_timestamp_false",
            requestId,
            tracebackId
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

        const result = {
          traceback_id: tracebackId,
          return_value: parsedEval.return_value,
          response_body: parsedEval.response_body
        };
        logger.info("Successfully updated llm reviewed timestamp", {
          event: "tool_update_llm_reviewed_timestamp_success",
          requestId,
          tracebackId
        });
        return {
          isError: false,
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      } catch (error) {
        const result = {
          error: true,
          reason: error.message,
          traceback_id: tracebackId
        };
        logger.error("update_llm_reviewed_timestamp execution failed", {
          event: "tool_update_llm_reviewed_timestamp_execution_error",
          requestId,
          tracebackId,
          error: error.message
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
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  };
  return { tools, callTool: callToolHandler };
}
