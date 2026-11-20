// MOO command words: spaces separate words, quotes group them, and a backslash
// escapes the next character (ToastStunt parse_cmd.cc:parse_into_words).
function checkedString(value, field) {
  const text = value == null ? "" : String(value);
  // Reject before trimming, including line breaks that could submit commands.
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)) {
    throw new Error(`${field} must not contain control characters or line separators.`);
  }
  return text.trim();
}

export function serializeSearchValue(value, field) {
  const text = checkedString(value, field);
  if (!/[ "\\]/u.test(text)) return text;
  return `"${text.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

// Type, limit, and array shape are validated by the tool handler before calling.
export function buildSearchCommand(args) {
  if (args.help === true) return "@search-json --help";
  const parts = ["@search-json", serializeSearchValue(args.type, "type")];
  for (const [key, field] of [
    ["n", "name"], ["l", "location"], ["p", "parent"], ["a", "sic"],
    ["prop", "prop"], ["mutex", "mutex"], ["w", "moved_by"]
  ]) {
    const value = serializeSearchValue(args[field], field);
    if (value) parts.push(`${key}=${value}`);
  }
  if (args.generics_only === true) parts.push("-g");
  if (args.mementos_only === true) parts.push("-m");
  if (args.limit !== undefined) parts.push(`limit=${Number(args.limit)}`);
  // Explicit raw-token interface: preserve existing quoting and token syntax.
  for (const token of args.extra_filters ?? []) {
    parts.push(checkedString(token, "extra_filters"));
  }
  return parts.join(" ");
}
