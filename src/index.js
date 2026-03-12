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
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;
const KEEP_ALIVE_TEXT = "#$# Ping!";
const DEFAULT_IDLE_CAPTURE_MS = 1000;
const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = 2000;
const DEFAULT_CODE_SEARCH_TIMEOUT_MS = 15000;

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
  ),
  codeSearchTimeoutMs: Number(
    readEnv(["moo-code-search-timeout-ms", "MOO_CODE_SEARCH_TIMEOUT_MS"]) ??
      DEFAULT_CODE_SEARCH_TIMEOUT_MS
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

if (!Number.isFinite(config.codeSearchTimeoutMs) || config.codeSearchTimeoutMs <= 0) {
  throw new Error(
    "Invalid code-search timeout. Set moo-code-search-timeout-ms (or MOO_CODE_SEARCH_TIMEOUT_MS) to a positive number."
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
    this.keepAliveTimer = null;
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
      this.stopKeepAlive();

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
    this.startKeepAlive();
    this.logger.info("Logged into MOO", { event: "moo_logged_in", user: this.username });
  }

  startKeepAlive() {
    this.stopKeepAlive();

    this.keepAliveTimer = setInterval(() => {
      if (!this.socket || !this.connected || !this.loggedIn || this.pending) {
        return;
      }

      this.socket.write(`${KEEP_ALIVE_TEXT}\n`, (error) => {
        if (error) {
          this.logger.warn("Failed to send MOO keep alive", {
            event: "moo_keep_alive_failed",
            error: error.message
          });
          return;
        }

        this.logger.debug("MOO keep alive sent", { event: "moo_keep_alive_sent" });
      });
    }, KEEP_ALIVE_INTERVAL_MS);
  }

  stopKeepAlive() {
    if (!this.keepAliveTimer) {
      return;
    }

    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
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
    this.stopKeepAlive();

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

function parseEvalOutput(rawOutput, evalCommand) {
  const normalized = rawOutput.replace(/\r\n/g, "\n").trim();
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

function parseVerbInfoOutput(rawOutput, arg) {
  const normalized = rawOutput.replace(/\r\n/g, "\n").trim();
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

function truncateResponse(rawOutput) {
  return String(rawOutput ?? "").slice(0, 500);
}

function parseJsonObjectOutput(rawOutput) {
  const normalized = rawOutput.replace(/\r\n/g, "\n").trim();
  let parsed;

  try {
    parsed = JSON.parse(normalized);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  return parsed;
}

function validateVerbInfoArg(rawArg) {
  const arg = String(rawArg ?? "").trim();
  const usage =
    "Usage: `obj:verb_spec` where obj is `#1234` or `$cored_ref`, separator is `:` or `::`, and verb_spec uses letters/underscores with optional `*` (for example `#24608:outgoing_bridges`, `#24608:send_*`, `#24608::outgoing_bridges`).";

  if (!arg) {
    throw new Error(`\`arg\` must be a non-empty string. ${usage}`);
  }

  const pattern = /^(\$[A-Za-z0-9_]+|#\d+)::?([A-Za-z_][A-Za-z0-9_*]*)$/;
  if (!pattern.test(arg)) {
    throw new Error(`Invalid \`arg\`. ${usage}`);
  }

  return arg;
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
        name: "verb-data",
        description:
          "Runs @verb-data <arg> where arg is obj:verb_spec (for example `#1234:look`, `#24608:send_*`, or `#24608::outgoing_bridges`), parses JSON response, and enriches source.code from source.code_lines when available.",
        inputSchema: {
          type: "object",
          properties: {
            arg: {
              type: "string",
              description:
                "Required format: `obj:verb_spec` where obj is `#1234` or `$cored_ref`, separator is `:` or `::`, and verb_spec uses letters/underscores with optional `*` (e.g. `#22664:foo`, `#24608:send_*`, or `#24608::outgoing_bridges`)."
            }
          },
          required: ["arg"],
          additionalProperties: false
        }
      },
      {
        name: "verbs-json",
        description:
          "Runs @verbs-json <arg> where arg is `#1234` or `$cored_ref`, and returns the parsed JSON object.",
        inputSchema: {
          type: "object",
          properties: {
            arg: {
              type: "string",
              description:
                "Object reference in the format `#1234` or `$cored_ref` (for example `#15840` or `$string_utils`)."
            }
          },
          required: ["arg"],
          additionalProperties: false
        }
      },
      {
        name: "props-json",
        description:
          "Runs @props-json <arg> where arg is `#1234` or `$cored_ref`, and returns the parsed JSON object.",
        inputSchema: {
          type: "object",
          properties: {
            arg: {
              type: "string",
              description:
                "Object reference in the format `#1234` or `$cored_ref` (for example `#15840` or `$string_utils`)."
            }
          },
          required: ["arg"],
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
      },
      {
        name: "run_moo_code_search",
        description:
          "Runs @code-search <pattern> on the MOO (optionally with --scope), converts the response to a JSON object, and returns it as `value`.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Pattern text to search with @code-search."
            },
            scope: {
              type: "string",
              description: "Optional scope target like `#98` or `$su`, sent as `--scope=<value>`."
            },
            include_descendants: {
              type: "boolean",
              description:
                "Optional flag; only accepted value is `true`, and it can only be used with `scope`."
            },
            max_matches: {
              type: "integer",
              description:
                "Optional maximum match count. Must be an integer greater than 0; sent as `--max_matches=<integer>`."
            },
            count_only: {
              type: "boolean",
              description:
                "Optional flag; only accepted value is `true`, sent as `--count_only=true`."
            },
            match_type: {
              type: "string",
              description:
                "Optional match type. Allowed values: `simple` (default) or `regex`; sent as `--match_type=<value>`."
            }
          },
          required: ["pattern"],
          additionalProperties: false
        }
      },
      {
        name: "prop-search",
        description:
          "Runs @prop-grep-json <pattern> on the MOO with required --scope and the same options as run_moo_code_search, converts the response to a JSON object, and returns it as `value`.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Pattern text to search with @prop-grep-json."
            },
            scope: {
              type: "string",
              description: "Required scope target like `#98` or `$su`, sent as `--scope=<value>`."
            },
            include_descendants: {
              type: "boolean",
              description:
                "Optional flag; only accepted value is `true`, and it can only be used with `scope`."
            },
            max_matches: {
              type: "integer",
              description:
                "Optional maximum match count. Must be an integer greater than 0; sent as `--max_matches=<integer>`."
            },
            count_only: {
              type: "boolean",
              description:
                "Optional flag; only accepted value is `true`, sent as `--count_only=true`."
            },
            match_type: {
              type: "string",
              description:
                "Optional match type. Allowed values: `simple` (default) or `regex`; sent as `--match_type=<value>`."
            }
          },
          required: ["pattern", "scope"],
          additionalProperties: false
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (
    request.params.name !== "get_moo_verb_source" &&
    request.params.name !== "verb-data" &&
    request.params.name !== "verbs-json" &&
    request.params.name !== "props-json" &&
    request.params.name !== "run_moo_eval" &&
    request.params.name !== "run_moo_command" &&
    request.params.name !== "run_moo_code_search" &&
    request.params.name !== "prop-search"
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

    if (!mooSession.connected || !mooSession.loggedIn) {
      const result = {
        error: true,
        reason: "MOO session is not logged in.",
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

  if (request.params.name === "verbs-json" || request.params.name === "props-json") {
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
    const command = commandName === "verbs-json" ? `@verbs-json ${arg}` : `@props-json ${arg}`;

    logger.info("MOO object JSON requested", {
      event: "tool_object_json_request",
      requestId,
      commandName,
      arg
    });

    if (!mooSession.connected || !mooSession.loggedIn) {
      const result = { error: "MOO session is not logged in." };
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
        const result = {
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

    if (!mooSession.connected || !mooSession.loggedIn) {
      const result = {
        error: "MOO session is not logged in."
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
        config.codeSearchTimeoutMs
      );

      let parsed;
      try {
        parsed = JSON.parse(captured.output);
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
