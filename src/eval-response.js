// Live capture requires a line ending so a partial TCP chunk cannot masquerade
// as the final line. Parsing can also consume already-trimmed captures.
export function endsWithTraceback(output, requireLineEnding = false) {
  return requireLineEnding
    ? /(?:^|\n)[ \t]*\(End of traceback\)[ \t]*\r?\n[ \t\r\n]*$/.test(output)
    : /(?:^|\n)[ \t]*\(End of traceback\)[ \t\r\n]*$/.test(output);
}
