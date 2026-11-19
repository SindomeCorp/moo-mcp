import { randomUUID } from "node:crypto";

const prefix = "MOO-MCP ";

function decode(line, id) {
  if (!line.startsWith(prefix)) return null;
  try {
    const response = JSON.parse(line.slice(prefix.length));
    return response?.id === id ? response : null;
  } catch {
    return null;
  }
}

const string = { type: "string" };
const integer = { type: "integer" };
const boolean = { type: "boolean" };
const objectRef = { ...string, description: "A numbered MOO object or $system reference." };
const scan = { scope: objectRef, include_descendants: boolean, limit: integer,
  cursor: integer, offset: integer, count_only: boolean };
const selector = { object: objectRef, verb: { type: ["string", "integer"] },
  mode: { enum: ["local", "resolved"] } };
const grep = { ...scan, pattern: string, match_type: { enum: ["simple", "regex"] } };
const definitions = [
  ["hello", "Identify the attached feature and supported operations.", {}, []],
  ["verb-data", "Read a complete verb by local slot, alias, or callable name.", selector, ["object", "verb"]],
  ["get_moo_verb_source", "Return complete, unmodified verb source and metadata.", selector, ["object", "verb"]],
  ["verbs-json", "List local verb metadata by numbered slot.", { object: objectRef }, ["object"]],
  ["props-json", "List readable property metadata without reading values.", { object: objectRef }, ["object"]],
  ["show-json", "Inspect an object and readable property values.", { object: objectRef, property: string }, ["object"]],
  ["contents", "List immediate contents.", { object: objectRef }, ["object"]],
  ["location", "Follow the object's containment chain.", { object: objectRef }, ["object"]],
  ["cored_json", "List readable object-valued properties on #0.", { arg: string }, []],
  ["defines_verb_json", "Find readable direct verb definitions.", { ...scan, pattern: string }, ["pattern"]],
  ["defines_prop_json", "Find readable direct property definitions.", { ...scan, pattern: string }, ["pattern"]],
  ["search-json", "Search by name, object kind, parent, or location.", {
    ...scan, type: string, name: string, parent: objectRef, location: objectRef,
  }, []],
  ["run_moo_code_search", "Search readable verb source by line.", grep, ["pattern"]],
  ["prop-search", "Search readable locally declared property values.", grep, ["scope", "pattern"]],
];

export function createTools({ config, mooSession }) {
  const tools = definitions.map(([name, description, properties, required]) => ({
    name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false }
  }));

  async function callTool({ params: { name, arguments: args = {} } }) {
    const id = randomUUID();
    const op = name === "get_moo_verb_source" ? "verb-data" : name;
    const payload = JSON.stringify({ id, op, params: args }).replace(/[\u007f-\uffff]/g,
      char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
    if (payload.length > 8192) throw new Error("Feature request exceeds 8192 characters.");

    let packet;
    await mooSession.ensureConnectedAndLoggedIn();
    await mooSession.runCommandUntil("@mcp " + payload, buffer => {
      let consumedChars = 0;
      for (const line of buffer.split("\n").slice(0, -1)) {
        consumedChars += line.length + 1;
        packet = decode(line, id);
        if (packet) return { done: true, consumedChars };
      }
      return { done: false };
    }, config.searchTimeoutMs);

    if (packet?.ok !== true && packet?.ok !== false) {
      throw new Error("Invalid reply from the ToastStunt lab feature.");
    }
    const data = packet.ok ? packet.result : packet.error;
    if (op === "hello" && packet.ok && data?.protocol !== 1) {
      throw new Error("Unsupported ToastStunt lab feature protocol.");
    }
    if (op === "verb-data" && packet.ok) data.source.code = data.source.code_lines.join("\n");
    return { isError: !packet.ok, content: [{ type: "text", text: JSON.stringify(data) }] };
  }

  return { tools, callTool };
}
