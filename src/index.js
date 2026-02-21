import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import winston from "winston";

dotenv.config();

const DONE_MARKER = "### Done ###";
const LIST_TIMEOUT_MS = 15000;
const LOGIN_TIMEOUT_MS = 10000;
const LOGIN_IDLE_MS = 500;
const DEFAULT_IDLE_CAPTURE_MS = 1000;
const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = 2000;

function readEnv(keys) {
  for (const key of keys) {
    if (process.env[key]) {
      return process.env[key];
    }
  }

  return undefined;
}

const config = {
  host: readEnv(["moo-hostname", "MOO_HOSTNAME"]),
  port: Number(readEnv(["moo-port", "MOO_PORT"])),
  username: readEnv(["moo-user", "MOO_USER"]),
  password: readEnv(["moo-password", "MOO_PASSWORD"]),
  idleCaptureMs: Number(
    readEnv(["moo-idle-ms", "MOO_IDLE_MS"]) ?? DEFAULT_IDLE_CAPTURE_MS
  ),
  firstResponseTimeoutMs: Number(
    readEnv([
      "moo-first-response-timeout-ms",
      "MOO_FIRST_RESPONSE_TIMEOUT_MS"
    ]) ?? DEFAULT_FIRST_RESPONSE_TIMEOUT_MS
  )
};

const missingConfig = Object.entries(config)
  .filter(([key, value]) => {
    if (key === "port") {
      return Number.isNaN(value) || value <= 0;
    }

    return !value;
  })
  .map(([key]) => key);

if (missingConfig.length > 0) {
  throw new Error(
    `Missing or invalid config fields: ${missingConfig.join(
      ", "
    )}. Set them in .env using moo-hostname/moo-port/moo-user/moo-password.`
  );
}

if (!Number.isFinite(config.idleCaptureMs) || config.idleCaptureMs <= 0) {
  throw new Error("Invalid idle capture timeout. Set moo-idle-ms (or MOO_IDLE_MS) to a positive number.");
}

if (
  !Number.isFinite(config.firstResponseTimeoutMs) ||
  config.firstResponseTimeoutMs <= 0
) {
  throw new Error(
    "Invalid first response timeout. Set moo-first-response-timeout-ms (or MOO_FIRST_RESPONSE_TIMEOUT_MS) to a positive number."
  );
}

fs.mkdirSync("logs", { recursive: true });

const metadataString = (info) => {
  const metadata = info.metadata ?? {};
  const pairs = Object.entries(metadata);
  if (pairs.length === 0) {
    return "";
  }

  const rendered = pairs.map(([key, value]) => {
    if (typeof value === "string") {
      return `${key}=${value}`;
    }
    return `${key}=${JSON.stringify(value)}`;
  });

  return ` | ${rendered.join(" ")}`;
};

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.metadata({
    fillExcept: ["level", "message", "timestamp"]
  }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}${metadataString(info)}`
  )
);

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp(),
  winston.format.metadata({
    fillExcept: ["level", "message", "timestamp"]
  }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}${metadataString(info)}`
  )
);

const logger = winston.createLogger({
  level: "info",
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
      stderrLevels: ["error", "warn", "info", "http", "verbose", "debug", "silly"],
      consoleWarnLevels: []
    }),
    new winston.transports.File({ filename: "logs/mcp.log", format: fileFormat })
  ]
});

class MooTelnetSession {
  constructor({ host, port, username, password, logger: log }) {
    this.host = host;
    this.port = port;
    this.username = username;
    this.password = password;
    this.logger = log;

    this.socket = null;
    this.connected = false;
    this.loggedIn = false;
    this.pending = null;
    this.buffer = "";
    this.commandQueue = Promise.resolve();
  }

  async connectAndLogin() {
    this.socket = net.createConnection({
      host: this.host,
      port: this.port
    });

    this.socket.setEncoding("binary");
    this.socket.on("data", (chunk) => this.onData(Buffer.from(chunk, "binary")));
    this.socket.on("error", (error) => {
      this.logger.error("MOO socket error", { event: "moo_socket_error", error: error.message });
    });
    this.socket.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.loggedIn = false;

      if (wasConnected) {
        this.logger.error("MOO connection closed", { event: "moo_connection_closed" });
      }
    });

    await once(this.socket, "connect");
    this.connected = true;
    this.logger.info("Connected to MOO", {
      event: "moo_connected",
      host: this.host,
      port: this.port
    });

    this.sendLine(`connect ${this.username} ${this.password}`);
    const loginOutput = await this.readUntilIdle(LOGIN_TIMEOUT_MS, LOGIN_IDLE_MS);

    const loginFailed = /incorrect|different password|no such player|invalid|denied|failed/i.test(
      loginOutput
    );

    if (loginFailed) {
      this.loggedIn = false;
      this.logger.error("MOO login failed", { event: "moo_login_failed", output: loginOutput });
      return;
    }

    this.loggedIn = true;
    this.logger.info("Logged into MOO", { event: "moo_logged_in", user: this.username });
  }

  onData(bufferChunk) {
    const cleanBuffer = this.filterTelnetNegotiation(bufferChunk);
    if (cleanBuffer.length === 0) {
      return;
    }

    const text = cleanBuffer.toString("utf8");
    this.buffer += text;
    this.tryResolvePending();
  }

  filterTelnetNegotiation(chunk) {
    const IAC = 255;
    const DONT = 254;
    const DO = 253;
    const WONT = 252;
    const WILL = 251;
    const SB = 250;
    const SE = 240;

    const output = [];
    const responses = [];

    for (let i = 0; i < chunk.length; i += 1) {
      const byte = chunk[i];
      if (byte !== IAC) {
        output.push(byte);
        continue;
      }

      const command = chunk[i + 1];
      if (command === SB) {
        i += 2;
        while (i < chunk.length) {
          if (chunk[i] === IAC && chunk[i + 1] === SE) {
            i += 1;
            break;
          }
          i += 1;
        }
        continue;
      }

      const option = chunk[i + 2];
      if (command === DO || command === DONT) {
        responses.push(Buffer.from([IAC, WONT, option]));
        i += 2;
        continue;
      }

      if (command === WILL || command === WONT) {
        responses.push(Buffer.from([IAC, DONT, option]));
        i += 2;
        continue;
      }

      i += 1;
    }

    if (responses.length > 0 && this.socket && this.connected) {
      this.socket.write(Buffer.concat(responses));
    }

    return Buffer.from(output);
  }

  async runCommand(command, timeoutMs = LIST_TIMEOUT_MS) {
    return this.enqueue(async () => {
      if (!this.socket || !this.connected) {
        throw new Error("MOO connection is not open.");
      }

      const requestId = randomUUID();
      const payload = `${command.trim()}\n`;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending && this.pending.requestId === requestId) {
            this.pending = null;
          }
          reject(new Error(`Timed out waiting for command completion marker: ${DONE_MARKER}`));
        }, timeoutMs);

        this.pending = {
          requestId,
          marker: DONE_MARKER,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          }
        };

        this.socket.write(payload, (error) => {
          if (!error) {
            this.tryResolvePending();
            return;
          }

          if (this.pending && this.pending.requestId === requestId) {
            this.pending = null;
          }
          clearTimeout(timer);
          reject(error);
        });
      });
    });
  }

  async runCommandUntil(command, isComplete, timeoutMs = LIST_TIMEOUT_MS) {
    return this.enqueue(async () => {
      if (!this.socket || !this.connected) {
        throw new Error("MOO connection is not open.");
      }

      const requestId = randomUUID();
      const payload = `${command.trim()}\n`;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending && this.pending.requestId === requestId) {
            this.pending = null;
          }
          reject(new Error("Timed out waiting for command completion."));
        }, timeoutMs);

        this.pending = {
          requestId,
          marker: null,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
          isComplete
        };

        this.socket.write(payload, (error) => {
          if (!error) {
            this.tryResolvePending();
            return;
          }

          if (this.pending && this.pending.requestId === requestId) {
            this.pending = null;
          }
          clearTimeout(timer);
          reject(error);
        });
      });
    });
  }

  async runCommandCaptureUntilIdle(command, idleMs, firstResponseTimeoutMs) {
    return this.enqueue(async () => {
      if (!this.socket || !this.connected) {
        throw new Error("MOO connection is not open.");
      }

      this.buffer = "";
      this.sendLine(command);

      const start = Date.now();
      let lastChangeAt = start;
      let started = false;
      let seenLength = this.buffer.length;

      while (true) {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });

        const now = Date.now();
        const currentLength = this.buffer.length;

        if (currentLength !== seenLength) {
          seenLength = currentLength;
          lastChangeAt = now;
          if (currentLength > 0) {
            started = true;
          }
        }

        if (!started && now - start >= firstResponseTimeoutMs) {
          return { output: "", timed_out_waiting_for_first_line: true };
        }

        if (started && now - lastChangeAt >= idleMs) {
          const output = this.buffer.trim();
          this.buffer = "";
          return { output, timed_out_waiting_for_first_line: false };
        }
      }
    });
  }

  enqueue(work) {
    this.commandQueue = this.commandQueue.then(work, work);
    return this.commandQueue;
  }

  sendLine(line) {
    if (!this.socket || !this.connected) {
      throw new Error("MOO connection is not open.");
    }
    this.socket.write(`${line.trim()}\n`);
  }

  async readUntilIdle(timeoutMs, idleMs) {
    const start = Date.now();
    let lastChange = Date.now();
    let previousLength = this.buffer.length;

    while (Date.now() - start < timeoutMs) {
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });

      if (this.buffer.length !== previousLength) {
        previousLength = this.buffer.length;
        lastChange = Date.now();
      }

      if (Date.now() - lastChange >= idleMs) {
        const output = this.buffer.trim();
        this.buffer = "";
        return output;
      }
    }

    const output = this.buffer.trim();
    this.buffer = "";
    return output;
  }

  tryResolvePending() {
    if (!this.pending) {
      return;
    }

    if (typeof this.pending.isComplete === "function") {
      const outcome = this.pending.isComplete(this.buffer);
      if (!outcome?.done) {
        return;
      }

      const consumed = Number.isInteger(outcome.consumedChars)
        ? Math.max(0, outcome.consumedChars)
        : this.buffer.length;
      const result = this.buffer.slice(0, consumed);
      this.buffer = this.buffer.slice(consumed);

      const { resolve } = this.pending;
      this.pending = null;
      resolve(result.trim());
      return;
    }

    const markerIndex = this.buffer.indexOf(this.pending.marker);
    if (markerIndex === -1) {
      return;
    }

    const result = this.buffer.slice(0, markerIndex);
    this.buffer = this.buffer.slice(markerIndex + this.pending.marker.length);

    const { resolve } = this.pending;
    this.pending = null;
    resolve(result.trim());
  }

  close() {
    if (this.socket) {
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }

    this.connected = false;
    this.loggedIn = false;
  }
}

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

function parseEvalOutput(rawOutput, evalCommand) {
  const normalized = rawOutput.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");
  const returnIndex = lines.findLastIndex((line) => line.trim().length > 0);

  if (returnIndex === -1 || !/^\s*=>/.test(lines[returnIndex])) {
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

function validateInput(args) {
  const objectRef = String(args?.object ?? "").trim();
  const verbName = String(args?.verb ?? "").trim();

  if (!/^(\$[A-Za-z0-9_]+|#\d+)$/.test(objectRef)) {
    throw new Error("`object` must be a cored reference like `$string_utils` or object id like `#1234`.");
  }

  if (!/^[A-Za-z_]+$/.test(verbName)) {
    throw new Error("`verb` must use letters/underscores only (no numbers).");
  }

  return { objectRef, verbName };
}

const mooSession = new MooTelnetSession({
  host: config.host,
  port: config.port,
  username: config.username,
  password: config.password,
  logger
});

await mooSession.connectAndLogin();

const server = new Server(
  {
    name: "moo-mcp",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_moo_verb_source",
        description: "Fetches source code for a MOO verb via @list and parses source vs VMS notes.",
        inputSchema: {
          type: "object",
          properties: {
            object: {
              type: "string",
              description: "Cored object ref like `$string_utils` or object id like `#1234`."
            },
            verb: {
              type: "string",
              description: "Verb name (letters/underscores only)."
            }
          },
          required: ["object", "verb"],
          additionalProperties: false
        }
      },
      {
        name: "run_moo_eval",
        description:
          "Runs an eval expression on the MOO (for example `;parent(#22664)`) and returns body + return value.",
        inputSchema: {
          type: "object",
          properties: {
            eval: {
              type: "string",
              description: "Raw eval command to send to MOO, typically starting with `;`."
            }
          },
          required: ["eval"],
          additionalProperties: false
        }
      },
      {
        name: "run_moo_command",
        description:
          "Runs a raw MOO command and captures output until no new input arrives for a configured idle period.",
        inputSchema: {
          type: "object",
          properties: {
            command: {
              type: "string",
              description: "Raw command to send to MOO."
            }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (
    request.params.name !== "get_moo_verb_source" &&
    request.params.name !== "run_moo_eval" &&
    request.params.name !== "run_moo_command"
  ) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }

  const requestId = randomUUID();

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

    if (!mooSession.connected || !mooSession.loggedIn) {
      const message = "MOO session is not logged in.";
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
      const output = await mooSession.runCommand(`@list ${objectRef}:${verbName}`);
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

    if (!mooSession.connected || !mooSession.loggedIn) {
      const result = {
        error: true,
        reason: "MOO session is not logged in.",
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

  if (!mooSession.connected || !mooSession.loggedIn) {
    const result = {
      error: true,
      reason: "MOO session is not logged in.",
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
        const match = /(^|\r?\n)(\s*=>[^\r\n]*)(\r?\n|$)/m.exec(buffer);
        if (!match) {
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
      logger.error("Failed to parse eval output", {
        event: "tool_eval_parse_error",
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
});

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  logger.info("Shutting down MOO MCP server", { event: "shutdown" });
  mooSession.close();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
