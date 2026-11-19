import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { createTools } from "./core-tools.js";
import { commandContext } from "./moo-session.js";

const validator = new AjvJsonSchemaValidator();
const singleLine = value => typeof value === "string" && !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value);
const fail = message => { throw new Error(message); };
const result = (value, isError = false) => ({
  isError, content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
});

function configuredTool(definition, context) {
  const { command, response = "text", ...tool } = definition;
  if (!Array.isArray(command) || command.length === 0 || !["text", "json"].includes(response)) {
    fail(`Invalid command or response mode for ${tool.name}`);
  }
  for (const part of command) {
    if (typeof part === "string") {
      if (!singleLine(part)) fail(`Command literals must be single-line for ${tool.name}`);
    } else if (!part || typeof part !== "object" || Array.isArray(part) ||
      typeof part.argument !== "string" || !Object.hasOwn(tool.inputSchema?.properties ?? {}, part.argument) ||
      !["raw", "moo-string"].includes(part.encoding) ||
      Object.keys(part).some(key => !["argument", "encoding"].includes(key))) {
      fail(`Invalid command argument segment for ${tool.name}`);
    }
  }
  return { tool, async call(request) {
    const args = request.params.arguments ?? {};
    const rendered = command.map(part => {
      if (typeof part === "string") return part;
      const value = args[part.argument];
      if (!["string", "number", "boolean"].includes(typeof value) || !singleLine(String(value))) {
        fail(`Command argument ${part.argument} must be a single-line scalar value`);
      }
      const text = String(value);
      return part.encoding === "moo-string" ? `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : text;
    }).join("");
    if (!rendered.trim()) fail("Configured command must not be empty");
    await context.mooSession.ensureConnectedAndLoggedIn();
    if (response === "text") {
      const captured = await context.mooSession.runCommandCaptureUntilIdle(
        rendered, context.config.idleCaptureMs, context.config.firstResponseTimeoutMs
      );
      return result({ output: captured.output });
    }
    let parsed;
    let validJson = false;
    const captured = await context.mooSession.runSearchCapture(
      rendered, context.config.idleCaptureMs, context.config.firstResponseTimeoutMs,
      context.config.searchTimeoutMs, capture => {
        try { parsed = JSON.parse(capture.output); validJson = true; }
        catch { /* The queue retires the uncertain stream before another command runs. */ }
        return validJson;
      }
    );
    if (captured.capture.stop_reason !== "idle") {
      return result({ error: "MOO response capture did not complete", capture: captured.capture }, true);
    }
    if (!validJson) return result({ error: "Configured command did not return valid JSON" }, true);
    return result(parsed, Boolean(parsed && typeof parsed === "object" &&
      (parsed.error || parsed.ok === 0 || parsed.ok === false)));
  } };
}

// Module paths are local and resolved relative to the configuration file.
// Modules execute trusted operator code; client tool arguments never select a module.
export async function loadToolRegistry({ configPath, context }) {
  const registrations = new Map();
  const add = (tool, call) => {
    if (!tool || typeof tool.name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || typeof tool.description !== "string" ||
      tool.inputSchema?.type !== "object" || typeof call !== "function") fail("Invalid tool registration");
    if (registrations.has(tool.name)) fail(`Duplicate tool name: ${tool.name}`);
    const validate = validator.getValidator(tool.inputSchema);
    registrations.set(tool.name, { tool, call, validate });
  };
  const addModule = module => {
    if (!module || !Array.isArray(module.tools) || typeof module.callTool !== "function") {
      fail("Tool module must return tools and callTool");
    }
    for (const tool of module.tools) {
      add(tool, (request, extra) => module.callTool(request, extra));
    }
  };

  async function loadConfig(configFile, ancestors = []) {
    const absolutePath = path.resolve(configFile);
    const canonicalPath = await realpath(absolutePath);
    if (ancestors.includes(canonicalPath)) fail(`Circular tools configuration: ${absolutePath}`);
    const relativePath = file => path.resolve(path.dirname(absolutePath), file);
    const config = JSON.parse(await readFile(absolutePath, "utf8"));
    if (!config || config.version !== 1 ||
      Object.keys(config).some(key => !["version", "includes", "modules", "tools"].includes(key)) ||
      ["includes", "modules", "tools"].some(key => config[key] !== undefined && !Array.isArray(config[key]))) {
      fail(`Invalid tools configuration (expected version 1): ${absolutePath}`);
    }
    for (const include of config.includes ?? []) {
      if (typeof include !== "string" || !include.trim()) {
        fail(`Invalid tools configuration include: ${absolutePath}`);
      }
      await loadConfig(relativePath(include), [...ancestors, canonicalPath]);
    }
    for (const modulePath of config.modules ?? []) {
      if (typeof modulePath !== "string" || !modulePath.trim()) fail("Module paths must be non-empty local paths");
      const module = await import(pathToFileURL(relativePath(modulePath)).href);
      if (typeof module.createTools !== "function") fail("Tool module must export createTools(context)");
      addModule(await module.createTools(context));
    }
    for (const definition of config.tools ?? []) {
      const { tool, call } = configuredTool(definition, context);
      add(tool, call);
    }
  }

  addModule(createTools(context));
  if (configPath !== undefined) await loadConfig(configPath);
  return {
    tools: [...registrations.values()].map(entry => entry.tool),
    async callTool(request, extra) {
      const entry = registrations.get(request.params.name);
      if (!entry) throw new Error(`Unknown tool: ${request.params.name}`);
      const active = commandContext.getStore();
      if (active) {
        active.toolName = entry.tool.name;
        active.connectionId = extra?.sessionId ?? "stdio";
      }
      const validation = entry.validate(request.params.arguments ?? {});
      if (!validation.valid) return result({ error: "Invalid tool arguments", details: validation.errorMessage }, true);
      try { return await entry.call(request, extra); }
      catch (error) { return result({ error: error.message }, true); }
    }
  };
}
