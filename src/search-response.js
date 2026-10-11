// Search-only capture. The caller owns the connection, queue, send and buffer.
export async function captureSearchResponse({ readOutput, isConnected,
  idleMs, firstResponseTimeoutMs, totalTimeoutMs,
  now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const start = now();
  let previous = readOutput(), lastChange = start;
  let firstResponse = previous.length ? 0 : null;
  const finish = (reason, output) => ({
    output,
    capture: {
      stop_reason: reason,
      elapsed_ms: now() - start,
      first_response_ms: firstResponse,
      first_response_timeout_ms: firstResponseTimeoutMs,
      idle_capture_ms: idleMs,
      total_timeout_ms: totalTimeoutMs,
      received_chars: output.length,
      timed_out_waiting_for_first_line: reason === "first_response_timeout",
      timed_out: reason === "first_response_timeout" || reason === "total_timeout",
      completion_confirmed: false
    }
  });
  while (true) {
    const output = readOutput(), elapsed = now() - start;
    if (output !== previous) {
      previous = output;
      lastChange = now();
      if (firstResponse === null && output.length) firstResponse = elapsed;
    }
    if (!isConnected()) return finish("connection_closed", output);
    if (firstResponse === null && elapsed >= firstResponseTimeoutMs) {
      return finish("first_response_timeout", output);
    }
    if (firstResponse !== null && now() - lastChange >= idleMs) {
      return finish("idle", output);
    }
    if (elapsed >= totalTimeoutMs) return finish("total_timeout", output);
    const deadline = Math.min(totalTimeoutMs - elapsed,
      firstResponse === null ? firstResponseTimeoutMs - elapsed : idleMs - (now() - lastChange));
    await sleep(Math.max(1, Math.min(50, deadline)));
  }
}

// A lexical indication of unfinished JSON, not proof that more bytes will arrive.
function hasUnclosedJson(text) {
  const start = text.indexOf("{");
  if (start < 0) return false;
  const stack = [];
  let quoted = false, escaped = false;
  for (const c of text.slice(start)) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{" || c === "[") stack.push(c);
    else if (c === "}" || c === "]") {
      if (stack.pop() !== (c === "}" ? "{" : "[")) return false;
      if (!stack.length) return false;
    }
  }
  return quoted || stack.length > 0;
}

export function searchResponseResult(captured, parseJson, { secrets = [], previewLimit = 1000 } = {}) {
  const output = String(captured.output ?? "");
  const capture = captured.capture;
  let preview = output;
  for (const secret of secrets) {
    if (secret) preview = preview.split(String(secret)).join("[REDACTED]");
  }
  preview = preview.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const diagnostic = (error, detail) => ({
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error, detail, capture,
      response_preview: preview.slice(0, previewLimit),
      preview_truncated: preview.length > previewLimit,
      preview_limit_chars: previewLimit }, null, 2) }]
  });
  if (capture.timed_out) return diagnostic("moo_response_timeout",
    "Response capture timed out; command completion is unknown. No retry was performed.");
  if (capture.stop_reason === "connection_closed") return diagnostic("moo_connection_closed",
    "Connection closed during response capture; command completion is unknown.");
  if (!output.trim()) return diagnostic("moo_empty_response", "Capture ended without a JSON response.");
  const parsed = parseJson(output);
  if (!parsed) return diagnostic(hasUnclosedJson(output) ? "moo_incomplete_response" : "moo_invalid_json",
    "Capture ended at an idle boundary without a valid JSON object; this does not confirm command completion.");
  // Retain the MOO's error and detail, rather than relabeling it as invalid input/JSON.
  const failed = parsed.ok === 0 || parsed.ok === false || Boolean(parsed.error);
  return {
    isError: failed,
    content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }],
    _meta: { moo_capture: capture }
  };
}
