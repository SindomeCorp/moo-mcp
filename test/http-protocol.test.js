import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
for (const sindome of [false, true]) {
test(`HTTP session errors, eval tracebacks, connection reuse and raw timeout behavior (${sindome ? 'Sindome' : 'core'})`,async t=>{
  const sockets=new Set();let calls=0, logins=0;
  const traceback = '#123:test, line 2: Task ran out of ticks\r\nprivate traceback detail\r\n(End of traceback)\r\n';
  const moo=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    let buffer='';
    socket.on('data',data=>{
      buffer+=data;let i;
      while((i=buffer.indexOf('\n'))>=0){
        const line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        if(line.startsWith('connect ')){logins++;socket.write('Synthetic greeting\n');}
        else if(line===';traceback-test;'){
          socket.write(traceback.slice(0,-7));
          setTimeout(()=>socket.write('back)\r'),20);
          setTimeout(()=>socket.write('\n'),40);
        } else if(line===';return 42;') socket.write('=> 42\r\n');
        else if(line===';compile-test;') socket.write('Line 1:  syntax error\r\n1 error.\r\n');
        else calls++;
      }
    });
  });
  await new Promise(r=>moo.listen(0,'127.0.0.1',r));
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const cwd=await mkdtemp(path.join(os.tmpdir(),'moo-protocol-'));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../src/index.js',import.meta.url))],{cwd,env:{PATH:process.env.PATH,MOO_HOSTNAME:'127.0.0.1',MOO_PORT:String(moo.address().port),MOO_USER:'fake',MOO_PASSWORD:'fake',MCP_MODE:'http_shared',MCP_HTTP_PORT:String(port),MOO_FIRST_RESPONSE_TIMEOUT_MS:'200',MOO_IDLE_MS:'20',...(sindome ? { MOO_TOOLS_CONFIG: fileURLToPath(new URL('../config/sindome.tools.json.example',import.meta.url)) } : {})},stdio:['ignore','ignore','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGKILL');await once(child,'exit');}for(const s of sockets)s.destroy();await new Promise(r=>moo.close(r));await rm(cwd,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('fake server startup timeout')),5000);child.stderr.on('data',data=>{text+=data;if(text.includes('mcp_server_started')){clearTimeout(timer);resolve();}});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`startup exited ${code}`));});});
  const rpc=async(body,session,signal)=>fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',signal,headers:{'Content-Type':'application/json','Accept':'application/json, text/event-stream',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify(body)});
  for(const id of [0,'probe']){const missing=await rpc({jsonrpc:'2.0',id,method:'server/discover'});assert.equal(missing.status,400);assert.equal((await missing.json()).id,id);}
  const unknown=await rpc({jsonrpc:'2.0',id:2,method:'tools/list'},'unknown');assert.equal(unknown.status,404);assert.equal((await unknown.json()).id,2);
  const initialized=await rpc({jsonrpc:'2.0',id:3,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fake-test',version:'1'}}});assert.equal(initialized.status,200);const session=initialized.headers.get('mcp-session-id');assert.ok(session);assert.equal((await initialized.json()).id,3);
  assert.equal((await rpc({jsonrpc:'2.0',method:'notifications/initialized'},session)).status,202);
  const list=await rpc({jsonrpc:'2.0',id:4,method:'tools/list'},session);const tools=(await list.json()).result.tools;
  if(sindome) assert.equal(tools.length,24);
  else assert.deepEqual(tools.map(tool=>tool.name).sort(),['run_moo_command','run_moo_eval']);
  const unsupported=await rpc({jsonrpc:'2.0',id:'discovery',method:'server/discover'},session);const err=await unsupported.json();assert.equal(err.id,'discovery');assert.equal(err.error.code,-32601);
  const evalCall = async (id, code) => {
    const response = await rpc({jsonrpc:'2.0',id,method:'tools/call',params:{name:'run_moo_eval',arguments:{eval:code}}},session,AbortSignal.timeout(2500));
    assert.equal(response.status,200);
    return (await response.json()).result;
  };
  const failedEval = await evalCall('traceback',';traceback-test;');
  assert.equal(failedEval.isError,true,'completed traceback is an MCP error');
  const failure = JSON.parse(failedEval.content[0].text);
  assert.equal(failure.error,true);
  assert.equal(failure.reason,traceback.replaceAll('\r\n','\n').trim(),'error contains the full traceback');
  assert.equal(failure.raw_output,traceback.trim(),'raw traceback remains available for review');
  assert.equal(failure.eval,';traceback-test;');
  const goodEval = await evalCall('after-traceback',';return 42;');
  assert.equal(goodEval.isError,false,'a completed traceback does not poison the queue');
  assert.equal(JSON.parse(goodEval.content[0].text).return_value,'42');
  const compilerEval = await evalCall('compile-error',';compile-test;');
  assert.equal(compilerEval.isError,true,'compiler errors still complete normally');
  assert.match(JSON.parse(compilerEval.content[0].text).reason,/1 error\./);
  assert.equal(logins,1,'handled MOO errors reuse the existing socket without reconnecting');
  const rawPending=rpc({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'run_moo_command',arguments:{command:'fake-no-output'}}},session);
  const deadline=Date.now()+1000;while(calls===0 && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.equal(calls,1);
  const cancelHttp=new AbortController();
  const queued=rpc({jsonrpc:'2.0',id:'cancel-queued',method:'tools/call',params:{name:'run_moo_command',arguments:{command:'must-never-execute'}}},session,cancelHttp.signal).catch(error=>error);
  await new Promise(r=>setTimeout(r,20));
  assert.equal((await rpc({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'cancel-queued'}},session)).status,202);
  cancelHttp.abort();await queued;
  const raw=await rawPending;const result=await raw.json();assert.equal(result.result.isError,true);assert.match(result.result.content[0].text,/first response deadline/);assert.equal(calls,1);
  const logs=await readFile(path.join(cwd,'logs/mcp.log'),'utf8');
  for(const secret of ['fake-no-output','Synthetic greeting','connect fake fake','private traceback detail']) assert.equal(logs.includes(secret),false);
  assert.match(logs,/moo_command_finished/);assert.match(logs,/queueWaitMs=/);
  assert.match(logs,/tool_eval_runtime_error/,'runtime tracebacks have a distinct lifecycle event');
  const deleted=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'DELETE',headers:{'Mcp-Session-Id':session}});assert.equal(deleted.status,200);
  const expired=await rpc({jsonrpc:'2.0',id:6,method:'tools/list'},session);assert.equal(expired.status,404);
});

}
