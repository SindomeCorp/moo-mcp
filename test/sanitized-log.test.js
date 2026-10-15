import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeLogInfo } from '../src/sanitized-log.js';
test('diagnostics retain correlation and timings while dropping command, output and error content',()=>{
  const result=sanitizeLogInfo({level:'error',message:'private message',event:'moo_command_finished',requestId:'generated-id',stage:'execution',queueWaitMs:30,durationMs:10,command:'private command',eval:'private eval',output:'private response',error:'private exception',password:'private credential',user:'private identity'});
  assert.equal(JSON.stringify(result).includes('private'),false);
  assert.equal(result.requestId,'generated-id');assert.equal(result.durationMs,10);assert.equal(result.message,'moo_command_finished');
});
