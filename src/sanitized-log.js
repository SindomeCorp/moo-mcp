// Logs describe lifecycle, never command arguments, response text, or exception messages.
const labels = new Set(['event', 'stage', 'requestId', 'connectionId', 'mode', 'signal', 'stop_reason',
  'socketId', 'reason', 'toolName', 'errorCode']);
const measures = new Set(['queueWaitMs', 'queueDepth', 'queueDepthAtDequeue', 'durationMs', 'status',
  'pid', 'socketAgeMs', 'receiveIdleMs', 'sendIdleMs', 'bytesRead', 'bytesWritten', 'bufferedChars',
  'activeWork', 'loggedIn', 'localPort', 'hadError', 'timeoutMs',
  'elapsed_ms', 'first_response_ms', 'first_response_timeout_ms', 'idle_capture_ms', 'total_timeout_ms',
  'received_chars', 'timed_out_waiting_for_first_line', 'timed_out', 'completion_confirmed', 'isError']);
export function sanitizeLogInfo(info) {
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'message') continue;
    if (key === 'status' && ['success', 'error', 'cancelled'].includes(info[key])) continue;
    if (labels.has(key) && typeof info[key] === 'string') continue;
    if (measures.has(key) && (typeof info[key] === 'number' || typeof info[key] === 'boolean' || info[key] === null)) continue;
    delete info[key];
  }
  info.message = info.event ?? 'mcp_event';
  return info;
}
