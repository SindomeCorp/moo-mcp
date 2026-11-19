import { loadToolRegistry } from "./tool-registry.js";
import fs from "node:fs";
import { sanitizeLogInfo } from "./sanitized-log.js";
import { MooTelnetSession, commandContext } from "./moo-session.js";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import winston from "winston";

dotenv.config();

const DEFAULT_IDLE_CAPTURE_MS = 1000;
const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = 2000;
const SHUTDOWN_GRACE_MS = 2000;
const DEFAULT_MCP_MODE = "stdio";
const DEFAULT_HTTP_HOST = "127.0.0.1";
const DEFAULT_HTTP_PORT = 3000;

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
  searchTimeoutMs: Number(readEnv(["moo-search-timeout-ms", "MOO_SEARCH_TIMEOUT_MS"]) ?? 15000),
  mcpMode: String(readEnv(["mcp-mode", "MCP_MODE"]) ?? DEFAULT_MCP_MODE).trim(),
  mcpHttpHost: String(
    readEnv(["mcp-http-host", "MCP_HTTP_HOST"]) ?? DEFAULT_HTTP_HOST
  ).trim(),
  mcpHttpPort: Number(
    readEnv(["mcp-http-port", "MCP_HTTP_PORT"]) ?? DEFAULT_HTTP_PORT
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

if (!Number.isInteger(config.searchTimeoutMs) || config.searchTimeoutMs < 1 || config.searchTimeoutMs > 120000) {
  throw new Error("Invalid search timeout. Set moo-search-timeout-ms (or MOO_SEARCH_TIMEOUT_MS) to 1..120000 milliseconds.");
}

if (config.mcpMode !== "stdio" && config.mcpMode !== "http_shared") {
  throw new Error("Invalid MCP mode. Set mcp-mode (or MCP_MODE) to `stdio` or `http_shared`.");
}

if (!Number.isFinite(config.mcpHttpPort) || config.mcpHttpPort <= 0 || config.mcpHttpPort > 65535) {
  throw new Error("Invalid MCP HTTP port. Set mcp-http-port (or MCP_HTTP_PORT) to a valid port number.");
}

if (config.mcpMode === "http_shared") {
  const allowedLocalHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!allowedLocalHosts.has(config.mcpHttpHost)) {
    throw new Error(
      "http_shared mode is localhost-only. Set mcp-http-host (or MCP_HTTP_HOST) to 127.0.0.1, localhost, or ::1."
    );
  }
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
  format: winston.format(sanitizeLogInfo)(),
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
      stderrLevels: ["error", "warn", "info", "http", "verbose", "debug", "silly"],
      consoleWarnLevels: []
    }),
    new winston.transports.File({ filename: "logs/mcp.log", format: fileFormat })
  ]
});
const baseLogger = logger;


const mooSession = new MooTelnetSession({
  host: config.host,
  port: config.port,
  username: config.username,
  password: config.password,
  logger,
  connectTimeoutMs: 10000,
  captureTimeoutMs: 30000
});

const registry = await loadToolRegistry({
  configPath: readEnv(["moo-tools-config", "MOO_TOOLS_CONFIG"]),
  context: { config, mooSession, logger: baseLogger }
});

await mooSession.connectAndLogin();

const listToolsHandler = async () => ({ tools: registry.tools });
const callToolHandler = (request, extra) => registry.callTool(request, extra);

function createConfiguredServer() {
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

  server.setRequestHandler(ListToolsRequestSchema, listToolsHandler);
  server.setRequestHandler(CallToolRequestSchema, (request, extra) =>
    commandContext.run({ signal: extra.signal, requestId: randomUUID(), rpcRequestId: extra.requestId }, () => callToolHandler(request, extra)));

  return server;
}

let httpServer = null;
let httpSessions = null;
let shutdownPromise = null;

if (config.mcpMode === "stdio") {
  const server = createConfiguredServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("MCP server started in stdio mode", {
    event: "mcp_server_started",
    pid: process.pid,
    mode: "stdio"
  });
} else {
  const app = createMcpExpressApp({ host: config.mcpHttpHost });
  const sessions = new Map();
  httpSessions = sessions;

  const isInitializeRequestBody = (body) => {
    if (!body) {
      return false;
    }

    if (Array.isArray(body)) {
      return body.some((message) => message?.method === "initialize");
    }

    return body?.method === "initialize";
  };

  const buildSession = async () => {
    const session = { id: null, transport: null, server: null };
    const nextTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        session.id = sessionId;
        sessions.set(sessionId, session);
        logger.info("HTTP MCP session created", {
          event: "mcp_session_created",
          connectionId: sessionId
        });
      }
    });
    nextTransport.onerror = (error) => {
      logger.error("HTTP MCP transport error", {
        event: "http_mcp_transport_error",
        connectionId: session.id ?? "pending",
        error: error.message
      });
    };
    nextTransport.onclose = () => {
      logger.warn("HTTP MCP transport closed", {
        event: "http_mcp_transport_closed",
        connectionId: session.id ?? "pending"
      });
      if (session.id && sessions.get(session.id) === session) {
        sessions.delete(session.id);
      }
    };

    const sessionServer = createConfiguredServer();
    await sessionServer.connect(nextTransport);

    session.transport = nextTransport;
    session.server = sessionServer;
    return session;
  };

  const writeJsonRpcSessionError = (req, res, status, message) => {
    if (res.headersSent) {
      return;
    }

    logger.warn("HTTP MCP session rejected", { event: "http_mcp_session_rejected", stage: "session", status, requestId: randomUUID() });
    res.status(status).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message
      },
      id: rpcRequestId(req.body)
    });
  };

  const rpcRequestId = (body) => body && !Array.isArray(body) &&
    (typeof body.id === "string" || typeof body.id === "number") ? body.id : null;

  const mcpHandler = async (req, res) => {
    try {
      const initializeRequest = req.method === "POST" && isInitializeRequestBody(req.body);
      if (initializeRequest) {
        const session = await buildSession();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      if (!sessionId || !String(sessionId).trim()) {
        writeJsonRpcSessionError(req, res, 400, "Bad Request: Mcp-Session-Id header is required");
        return;
      }

      const session = sessions.get(String(sessionId).trim());
      if (!session) {
        writeJsonRpcSessionError(req, res, 404, "Session not found");
        return;
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error("HTTP MCP request handling failed", {
        event: "http_mcp_request_error",
        error: error.message
      });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error"
          },
          id: rpcRequestId(req.body)
        });
      }
    }
  };

  // Support both `/mcp` and `/` for client compatibility.
  app.post("/mcp", mcpHandler);
  app.get("/mcp", mcpHandler);
  app.delete("/mcp", mcpHandler);
  app.post("/", mcpHandler);
  app.get("/", mcpHandler);
  app.delete("/", mcpHandler);

  await new Promise((resolve, reject) => {
    httpServer = app.listen(config.mcpHttpPort, config.mcpHttpHost, (error) => {
      if (error) {
        reject(error);
        return;
      }

      logger.info("MCP server started in http_shared mode", {
        event: "mcp_server_started",
        pid: process.pid,
        mode: "http_shared",
        host: config.mcpHttpHost,
        port: config.mcpHttpPort,
        path: "/mcp"
      });
      resolve();
    });
  });
}

const shutdown = async (signal = "unknown") => {
  if (shutdownPromise) {
    logger.warn("Shutdown already in progress; ignoring duplicate signal", {
      event: "shutdown_duplicate_signal",
      signal
    });
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    logger.info("Shutting down MOO MCP server", { event: "shutdown", signal });
    const withTimeout = async (promise, label, timeoutMs = SHUTDOWN_GRACE_MS) => {
      return Promise.race([
        promise,
        new Promise((resolve) => {
          setTimeout(() => {
            logger.warn("Shutdown step timed out; continuing", {
              event: "shutdown_step_timeout",
              signal,
              step: label,
              timeoutMs
            });
            resolve();
          }, timeoutMs);
        })
      ]);
    };

    if (httpSessions) {
      const closePromises = [];
      for (const session of httpSessions.values()) {
        if (session?.transport) {
          closePromises.push(
            withTimeout(
              session.transport.close().catch(() => undefined),
              `session_transport_close:${session.id ?? "unknown"}`
            )
          );
        }
      }
      await Promise.all(closePromises);
      httpSessions.clear();
    }
    if (httpServer) {
      await withTimeout(
        new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
        "http_server_close"
      );
    }
    mooSession.close("server_shutdown");
    process.exit(0);
  })().catch((error) => {
    logger.error("Shutdown failed", {
      event: "shutdown_error",
      signal,
      error: error.message
    });
    process.exit(1);
  });

  return shutdownPromise;
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

if (config.mcpMode === "stdio") {
  process.stdin.once("end", () => {
    void shutdown("stdin_eof");
  });
}
