import test from 'node:test';
import assert from 'node:assert/strict';
import { endsWithTraceback } from '../src/eval-response.js';

test('traceback capture waits for the complete final line across arbitrary fragments', () => {
  for (const newline of ['\n', '\r\n']) {
    const response = ['#123:test, line 2: Task ran out of ticks', '... called from #456:eval', '(End of traceback)', ''].join(newline);
    for (let i = 0; i < response.length; i++) {
      assert.equal(endsWithTraceback(response.slice(0, i), true), false, `premature completion at character ${i}`);
    }
    assert.equal(endsWithTraceback(response, true), true);
    assert.equal(endsWithTraceback(response.trim()), true, 'parser recognizes the trimmed capture');
    assert.equal(endsWithTraceback(response + newline + ' \t', true), true, 'trailing whitespace is harmless');
  }
});

test('traceback terminator must occupy the final line, not appear inside a value or other text', () => {
  for (const output of [
    '=> "(End of traceback)"\n',
    'prefix (End of traceback)\n',
    '(End of traceback) suffix\n',
    '(End of traceback)\nmore output\n',
    '#123:test: error\n(End of trace',
    '(end of traceback)\n'
  ]) assert.equal(endsWithTraceback(output, true), false, output);
});
