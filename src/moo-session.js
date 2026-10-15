import net from "node:net";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { captureSearchResponse } from "./search-response.js";
export const commandContext = new AsyncLocalStorage();
const DONE_MARKER = "### Done ###";
const LIST_TIMEOUT_MS = 15000;
const LOGIN_TIMEOUT_MS = 10000;
const LOGIN_IDLE_MS = 500;
const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000;
const KEEP_ALIVE_TEXT = "#$# Ping!";
export class MooTelnetSession {
  constructor({ host, port, username, password, logger: log, connectTimeoutMs = 10000, captureTimeoutMs = 30000, queueTimeoutMs = 30000, createConnection = net.createConnection }) {
    this.connectTimeoutMs = connectTimeoutMs;
    this.captureTimeoutMs = captureTimeoutMs;
    this.queueTimeoutMs = queueTimeoutMs;
    this.createConnection = createConnection;
    this.activeWork = false;
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
    this.pendingQueueDepth = 0;
  }

  async connectAndLogin() {
    this.close();
    this.buffer = "";

    const socket = this.createConnection({ host: this.host, port: this.port });
    this.socket = socket;
    socket.setEncoding("binary");
    socket.on("data", (chunk) => {
      if (this.socket === socket) this.onData(Buffer.from(chunk, "binary"));
    });
    socket.on("error", () => {
      if (this.socket === socket) {
        this.logger.error("MOO socket error", { event: "moo_socket_error", stage: "socket" });
        this.close();
      }
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.logger.warn("MOO connection closed", { event: "moo_connection_closed" });
      this.close();
    });
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("connect", connected);
          socket.off("error", failed);
          socket.off("close", closed);
        };
        const connected = () => { cleanup(); resolve(); };
        const failed = () => { cleanup(); reject(new Error("MOO TCP connection failed.")); };
        const closed = () => { cleanup(); reject(new Error("MOO TCP connection closed.")); };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("MOO TCP connect deadline exceeded."));
          socket.destroy();
        }, this.connectTimeoutMs);
        socket.once("connect", connected);
        socket.once("error", failed);
        socket.once("close", closed);
      });
      this.connected = true;
      this.logger.info("Connected to MOO", { event: "moo_connected", stage: "connect" });
      this.buffer = "";
      this.sendLine(`connect ${this.username} ${this.password}`);
      const loginOutput = await this.readUntilIdle(LOGIN_TIMEOUT_MS, LOGIN_IDLE_MS);
      if (/incorrect|different password|no such player|invalid|denied|failed/i.test(loginOutput)) {
        throw new Error("MOO login rejected.");
      }
      if (!this.connected) throw new Error("MOO connection closed during login.");
      // Compatibility: absence of a known failure assumes readiness, including silence.
      // This is not authentication proof; the first tool command establishes usability.
      this.loggedIn = true;
      this.startKeepAlive();
      this.logger.info("MOO login readiness assumed", { event: "moo_login_readiness_assumed", stage: "login" });
    } catch (error) {
      this.close();
      this.logger.warn("MOO connection/login failed", { event: "moo_login_failed", stage: "connect_login" });
      throw error;
    }
  }

  async ensureConnectedAndLoggedIn() {
    if (this.socket && this.connected && this.loggedIn) {
      return;
    }

    return this.enqueue(async () => {
      if (this.socket && this.connected && this.loggedIn) return;
      this.logger.warn("MOO session unavailable; reconnecting", { event: "moo_reconnect_attempt" });
      await this.connectAndLogin();
      this.logger.info("MOO session reconnected", { event: "moo_reconnect_success" });
    });
  }

  startKeepAlive() {
    this.stopKeepAlive();

    this.keepAliveTimer = setInterval(() => {
      if (!this.socket || !this.connected || !this.loggedIn || this.pending || this.activeWork) {
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

      this.buffer = "";
      const requestId = randomUUID();
      const payload = `${command.trim()}\n`;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending && this.pending.requestId === requestId) {
            this.pending = null;
          }
          this.close();
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

        const socket = this.socket;
        socket.write(payload, (error) => {
          if (this.socket !== socket) return;
          if (!error) {
            this.tryResolvePending();
            return;
          }

          if (this.pending && this.pending.requestId === requestId) {
            this.pending = null;
          }
          clearTimeout(timer);
          this.close();
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

      this.buffer = "";
      const requestId = randomUUID();
      const payload = `${command.trim()}\n`;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.pending && this.pending.requestId === requestId) {
            this.pending = null;
          }
          this.close();
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

        const socket = this.socket;
        socket.write(payload, (error) => {
          if (this.socket !== socket) return;
          if (!error) {
            this.tryResolvePending();
            return;
          }

          if (this.pending && this.pending.requestId === requestId) {
            this.pending = null;
          }
          clearTimeout(timer);
          this.close();
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
        if (!this.connected) throw new Error("MOO connection closed during capture; completion unknown.");
        if (now - start >= Math.max(this.captureTimeoutMs, firstResponseTimeoutMs + idleMs)) {
          this.close();
          throw new Error("MOO total capture deadline exceeded; completion unknown. No retry performed.");
        }
        const currentLength = this.buffer.length;

        if (currentLength !== seenLength) {
          seenLength = currentLength;
          lastChangeAt = now;
          if (currentLength > 0) {
            started = true;
          }
        }

        if (!started && now - start >= firstResponseTimeoutMs) {
          this.close();
          throw new Error("MOO first response deadline exceeded; completion unknown. No retry performed.");
        }

        if (started && now - lastChangeAt >= idleMs) {
          const output = this.buffer.trim();
          this.buffer = "";
          return { output, timed_out_waiting_for_first_line: false };
        }
      }
    });
  }

  async runSearchCapture(command, idleMs, firstResponseTimeoutMs, totalTimeoutMs, validateCapture = () => true) {
    return this.enqueue(async () => {
      if (!this.socket || !this.connected) throw new Error("MOO connection is not open.");
      this.buffer = "";
      this.sendLine(command);
      const captured = await captureSearchResponse({
        readOutput: () => this.buffer,
        isConnected: () => this.connected,
        idleMs, firstResponseTimeoutMs, totalTimeoutMs
      });
      this.buffer = "";
      try {
        if (captured.capture.stop_reason !== "idle" || !validateCapture(captured)) this.close();
      } catch (error) {
        this.close();
        throw error;
      }
      return captured;
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
        if (!this.connected) throw new Error("MOO connection closed during capture; completion unknown.");
        if (now - start >= Math.max(this.captureTimeoutMs, firstResponseTimeoutMs + idleMs)) {
          this.close();
          throw new Error("MOO total capture deadline exceeded; completion unknown. No retry performed.");
        }
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
          this.close();
          throw new Error("MOO first response deadline exceeded; completion unknown. No retry performed.");
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
    const context = commandContext.getStore() ?? {};
    const { signal, requestId = randomUUID() } = context;
    const remainingQueueMs = Math.max(0, this.queueTimeoutMs - (context.queueWaitMs ?? 0));
    const enqueuedAt = Date.now();
    this.pendingQueueDepth += 1;
    let state = "queued", resolveResult, rejectResult;
    const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    const diagnostic = (event, stage) => this.logger.info("MOO command lifecycle", {
      event, stage, requestId, queueWaitMs: Date.now() - enqueuedAt,
      queueDepth: this.pendingQueueDepth
    });
    const cancelQueued = (error, event) => {
      if (state !== "queued") return;
      state = "expired";
      this.pendingQueueDepth -= 1;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      diagnostic(event, "queue");
      rejectResult(error);
    };
    const abort = () => {
      if (state === "queued") cancelQueued(new Error("MOO command cancelled before execution."), "moo_command_cancelled");
      else if (state === "running") this.close();
    };
    const timer = setTimeout(() => cancelQueued(
      new Error("MOO busy: command waited 30 seconds in queue and was not executed."),
      "moo_queue_timeout"), remainingQueueMs);
    signal?.addEventListener("abort", abort, { once: true });
    diagnostic("moo_command_enqueued", "queue");
    if (signal?.aborted) abort();
    const wrappedWork = async () => {
      if (state !== "queued") return;
      // Timers can be delayed by event-loop work; also enforce expiry at dequeue.
      if (Date.now() - enqueuedAt >= remainingQueueMs) {
        cancelQueued(new Error("MOO busy: queue deadline exceeded; command was not executed."), "moo_queue_timeout");
        return;
      }
      state = "running";
      clearTimeout(timer);
      const startedAt = Date.now();
      context.queueWaitMs = (context.queueWaitMs ?? 0) + startedAt - enqueuedAt;
      this.activeWork = true;
      diagnostic("moo_command_dequeued", "execution");
      try {
        const value = await work();
        if (signal?.aborted) throw new Error("MOO command cancelled; completion unknown. No retry performed.");
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      } finally {
        state = "finished";
        this.activeWork = false;
        this.pendingQueueDepth -= 1;
        signal?.removeEventListener("abort", abort);
        this.logger.info("MOO command finished", { event: "moo_command_finished", stage: "execution",
          requestId, queueWaitMs: startedAt - enqueuedAt, durationMs: Date.now() - startedAt });
      }
    };
    this.commandQueue = this.commandQueue.then(wrappedWork, wrappedWork);
    return result;
  }

  sendLine(line) {
    if (!this.socket || !this.connected) {
      throw new Error("MOO connection is not open.");
    }
    const socket = this.socket;
    socket.write(`${line.trim()}\n`, error => {
      if (error && this.socket === socket) this.close();
    });
  }

  async readUntilIdle(timeoutMs, idleMs) {
    const start = Date.now();
    let lastChange = Date.now();
    let previousLength = this.buffer.length;

    while (Date.now() - start < timeoutMs) {
      if (!this.connected) throw new Error("MOO connection closed during login drain.");
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

    throw new Error("MOO login drain deadline exceeded.");
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
    this.buffer = "";
  }
}
