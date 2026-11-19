import { randomUUID } from "node:crypto";
import { commandContext } from "./moo-session.js";
import { endsWithTraceback } from "./eval-response.js";

const LIST_TIMEOUT_MS = 15000;
export function parseEvalOutput(rawOutput, evalCommand) {
  const normalized = rawOutput.replace(/\r\n/g, "\n").trim();
  if (endsWithTraceback(rawOutput)) {
    return {
      error: true,
      reason: normalized,
      eval: evalCommand,
      raw_output: rawOutput
    };
  }
  const compilerErrorMatch = normalized.match(/[\s\S]*\n\d+\s+error(?:s)?\.\s*$/i);
  if (compilerErrorMatch) {
    return {
      error: true,
      reason: normalized,
      eval: evalCommand,
      raw_output: rawOutput
    };
  }

  const exceptionMatch = normalized.match(
    /(?:^|\n)(You had an exception:\s+.+)\s*$/i
  );
  if (exceptionMatch) {
    return {
      error: true,
      reason: exceptionMatch[1],
      eval: evalCommand,
      raw_output: rawOutput
    };
  }

  const lines = normalized.split("\n");
  const returnIndex = lines.findLastIndex((line) => line.trim().length > 0);
  const syntaxErrorMatch = normalized.match(
    /(?:^|\n)((?:Line\s+\d+:\s+[^\n]*\n)+\d+\s+error(?:s)?\.)\s*$/i
  );

  if (returnIndex === -1 || !/^\s*=>/.test(lines[returnIndex])) {
    if (syntaxErrorMatch) {
      return {
        error: true,
        reason: syntaxErrorMatch[1],
        eval: evalCommand,
        raw_output: rawOutput
      };
    }

    return {
      error: true,
      reason: "Unexpected eval response format (missing final return line).",
      eval: evalCommand,
      raw_output: rawOutput
    };
  }

  const returnLine = lines[returnIndex].trim();
  const returnValue = returnLine.replace(/^\s*=>\s?/, "");
  const responseBody = lines.slice(0, returnIndex).join("\n").trim();

  return {
    error: false,
    eval: evalCommand,
    response_body: responseBody,
    return_value: returnValue
  };
}


export function createTools({ config, mooSession, logger: baseLogger }) {
  const tools = [
    {
      "name": "run_moo_eval",
      "description": "Runs a single-line MOO eval command (usually starting with ;) and returns output and the final => return value. Requires programmer permissions and a compatible eval response format.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "eval": {
            "type": "string",
            "description": "Raw eval command to send to MOO, typically starting with `;`."
          }
        },
        "required": [
          "eval"
        ],
        "additionalProperties": false
      }
    },
    {
      "name": "run_moo_command",
      "description": "Runs a raw MOO command and captures output until the configured idle period. Follow your MOO’s rules for programming and saving source.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "command": {
            "type": "string",
            "description": "Raw command to send to MOO."
          }
        },
        "required": [
          "command"
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

    if (request.params.name === "run_moo_command") {
      const command = String(request.params.arguments?.command ?? "").trim();
      if (!command) {
        const result = {
          error: true,
          reason: "`command` must be a non-empty string.",
          command: "",
          output: ""
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

      logger.info("MOO raw command requested", {
        event: "tool_raw_command_request",
        requestId,
        command
      });

      try {
        await mooSession.ensureConnectedAndLoggedIn();
      } catch (error) {
        const result = {
          error: true,
          reason: error.message || "MOO session is not logged in.",
          command,
          output: ""
        };
        logger.error("MOO session is not logged in.", {
          event: "tool_raw_command_not_logged_in",
          requestId,
          command
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

        const parsed = {
          error: false,
          command,
          output: captured.output,
          timed_out_waiting_for_first_line: captured.timed_out_waiting_for_first_line,
          idle_capture_ms: config.idleCaptureMs,
          first_response_timeout_ms: config.firstResponseTimeoutMs
        };

        logger.info("Successfully executed raw command", {
          event: "tool_raw_command_success",
          requestId,
          command,
          timedOutFirstLine: captured.timed_out_waiting_for_first_line
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
        logger.error("Raw command execution failed", {
          event: "tool_raw_command_execution_error",
          requestId,
          command,
          error: error.message
        });

        const result = {
          error: true,
          reason: error.message,
          command,
          output: ""
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

    const evalCommand = String(request.params.arguments?.eval ?? "").trim();
    if (!evalCommand) {
      const result = {
        error: true,
        reason: "`eval` must be a non-empty string.",
        eval: "",
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

    logger.info("MOO eval requested", {
      event: "tool_eval_request",
      requestId,
      eval: evalCommand
    });

    try {
      await mooSession.ensureConnectedAndLoggedIn();
    } catch (error) {
      const result = {
        error: true,
        reason: error.message || "MOO session is not logged in.",
        eval: evalCommand,
        raw_output: ""
      };

      logger.error("MOO session is not logged in.", {
        event: "tool_eval_not_logged_in",
        requestId,
        eval: evalCommand
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
          if (endsWithTraceback(buffer, true)) return { done: true };
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
      const parsed = parseEvalOutput(output, evalCommand);

      if (parsed.error) {
        const runtimeTraceback = endsWithTraceback(output);
        logger.error(runtimeTraceback ? "MOO eval returned a traceback" : "Failed to parse eval output", {
          event: runtimeTraceback ? "tool_eval_runtime_error" : "tool_eval_parse_error",
          requestId,
          eval: evalCommand
        });
      } else {
        logger.info("Successfully executed eval", {
          event: "tool_eval_success",
          requestId,
          eval: evalCommand
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
      logger.error("Eval execution failed", {
        event: "tool_eval_execution_error",
        requestId,
        eval: evalCommand,
        error: error.message
      });

      const result = {
        error: true,
        reason: error.message,
        eval: evalCommand,
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
  };
  return { tools, callTool: callToolHandler };
}
