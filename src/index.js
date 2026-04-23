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
    this.reconnectPromise = null;
  }

  async connectAndLogin() {
    this.close();
    this.buffer = "";

    this.socket = net.createConnection({
      host: this.host,
      port: this.port
    });

    this.socket.setEncoding("binary");
    this.socket.on("data", (chunk) => this.onData(Buffer.from(chunk, "binary")));
    this.socket.on("error", (error) => {
      this.logger.error("MOO socket error", { event: "moo_socket_error", error: error.message });
      this.rejectPending(error);
    });
    this.socket.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.loggedIn = false;
      this.stopKeepAlive();
      this.rejectPending(new Error("MOO connection closed."));

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

  async ensureConnectedAndLoggedIn() {
    if (this.socket && this.connected && this.loggedIn) {
      return;
    }

    if (!this.reconnectPromise) {
      this.reconnectPromise = this.enqueue(async () => {
        if (this.socket && this.connected && this.loggedIn) {
          return;
        }

        this.logger.warn("MOO session unavailable; reconnecting", {
          event: "moo_reconnect_attempt"
        });
        await this.connectAndLogin();

        if (!this.socket || !this.connected || !this.loggedIn) {
          throw new Error("MOO session is not logged in.");
        }

        this.logger.info("MOO session reconnected", { event: "moo_reconnect_success" });
      }).finally(() => {
        this.reconnectPromise = null;
      });
    }

    return this.reconnectPromise;
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

  async runCommandCaptureFragmentsUntilIdle(command, idleMs, firstResponseTimeoutMs) {
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
      const fragments = [];

      while (true) {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });

        const now = Date.now();
        const currentLength = this.buffer.length;

        if (currentLength !== seenLength) {
          const rawFragment = this.buffer.slice(seenLength, currentLength);
          const nextFragment = rawFragment
            .replace(/(?:\r?\n)+$/g, "");
          fragments.push(nextFragment);
          seenLength = currentLength;
          lastChangeAt = now;
          if (currentLength > 0) {
            started = true;
          }
        }

        if (!started && now - start >= firstResponseTimeoutMs) {
          return {
            output: "",
            timed_out_waiting_for_first_line: true
          };
        }

        if (started && now - lastChangeAt >= idleMs) {
          this.buffer = "";
          return {
            output: fragments.join(""),
            timed_out_waiting_for_first_line: false
          };
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

  rejectPending(error) {
    if (!this.pending) {
      return;
    }

    const { reject } = this.pending;
    this.pending = null;
    reject(error);
  }

  close() {
    this.stopKeepAlive();
    this.rejectPending(new Error("MOO connection closed."));

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

function truncateResponse(rawOutput) {
  return String(rawOutput ?? "").slice(0, 500);
}

function parseJsonObjectOutput(rawOutput) {
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

function sanitizeJsonText(rawOutput) {
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
              description: "Verb name as any non-empty string."
            }
          },
          required: ["object", "verb"],
          additionalProperties: false
        }
      },
      {
        name: "verb-data",
        description:
          "Runs @verb-data <arg> where arg is obj:verb_spec (for example `#1234:look`, `#24608:@asdf`, or `#24608::\"_asdf\"`), parses JSON response, and enriches source.code from source.code_lines when available.",
        inputSchema: {
          type: "object",
          properties: {
            arg: {
              type: "string",
              description:
                "Required format: `obj:verb_spec` where obj is `#1234` or `$cored_ref`, separator is `:` or `::`, and `verb_spec` is any non-empty string (e.g. `#22664:foo`, `#24608:@asdf`, or `#24608::\"_asdf\"`)."
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
        name: "contents",
        description:
          "Runs @contents <arg> where arg is `#1234` or `$cored_ref`, and returns the parsed JSON object.",
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
        name: "location",
        description:
          "Runs @location-json <arg> where arg is `#1234` or `$cored_ref`, and returns the parsed JSON object.",
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
        name: "vb-json",
        description:
          "Runs @vb-json <id|last> to fetch bug details and returns the parsed JSON object.",
        inputSchema: {
          type: "object",
          properties: {
            arg: {
              type: ["integer", "string"],
              description:
                "Bug id as a positive integer (for example `12345`) or the string `last` for the last viewed bug."
            }
          },
          required: ["arg"],
          additionalProperties: false
        }
      },
      {
        name: "bugs-json",
        description:
          "Runs @bugs-json with an optional state/search argument and returns the parsed JSON object.",
        inputSchema: {
          type: "object",
          properties: {
            arg: {
              type: "string",
              description:
                "Optional: one of `new`, `unassigned`, `assigned`, `resolved`, `mine`, or a search string (minimum 3 characters). Omit for open unresolved bugs."
            }
          },
          additionalProperties: false
        }
      },
      {
        name: "show-json",
        description:
          "Runs @show-json <arg>.<property> where arg is `#1234` or `$cored_ref` and property is optional, then joins fragmented output and returns parsed JSON.",
        inputSchema: {
          type: "object",
          properties: {
            arg: {
              type: "string",
              description:
                "Object reference in the format `#1234` or `$cored_ref` (for example `#15840` or `$slither`)."
            },
            property: {
              type: "string",
              description:
                "Optional property name to append as `<arg>.<property>` when calling `@show-json`."
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
    request.params.name !== "contents" &&
    request.params.name !== "location" &&
    request.params.name !== "vb-json" &&
    request.params.name !== "bugs-json" &&
    request.params.name !== "show-json" &&
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
        config.codeSearchTimeoutMs
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
