import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { MooTelnetSession, commandContext } from '../src/moo-session.js';
import { sanitizeLogInfo } from '../src/sanitized-log.js';
const logger = { info(){}, warn(){}, error(){}, debug(){} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const make = options => new MooTelnetSession({ host:'127.0.0.1', port:1, username:'fake', password:'fake', logger, ...options });
test('queued work expires promptly while active work remains blocked and never executes', async () => {
  const s=make({queueTimeoutMs:30}); let release, executed=false;
  const first=s.enqueue(()=>new Promise(r=>release=r));
  await sleep(1);
  const second=s.enqueue(()=>{executed=true});
  await assert.rejects(second,/busy/);
  assert.equal(executed,false); assert.equal(s.pendingQueueDepth,1);
  release(); await first; await s.commandQueue;
  assert.equal(executed,false); assert.equal(s.pendingQueueDepth,0);
});
test('queued cancellation never executes; running cancellation closes stream without replay', async()=>{
  const s=make(); let release, executed=false;
  const first=s.enqueue(()=>new Promise(r=>release=r)); await sleep(1);
  const controller=new AbortController();
  const second=commandContext.run({signal:controller.signal},()=>s.enqueue(()=>executed=true));
  controller.abort(); await assert.rejects(second,/cancelled/); release(); await first; await s.commandQueue;
  assert.equal(executed,false);
});
test('TCP connect deadline destroys hanging socket and cleans transient listeners', async()=>{
  const socket=new EventEmitter(); socket.setEncoding=()=>{}; socket.end=()=>{};
  socket.destroy=()=>{socket.destroyed=true; queueMicrotask(()=>socket.emit('close'));};
  const s=make({connectTimeoutMs:15,createConnection:()=>socket});
  await assert.rejects(s.connectAndLogin(),/deadline/);
  assert.equal(socket.destroyed,true); assert.equal(socket.listenerCount('connect'),0);
  assert.equal(s.connected,false);
});
async function fake(t, onLine, options = {}){
  const sockets=new Set();
  const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    let buffer=''; socket.on('data',data=>{buffer+=data; let i; while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);onLine(socket,line);}});
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{for(const socket of sockets)socket.destroy();server.close();});
  const s=make({port:server.address().port, ...options});t.after(()=>s.close());return s;
}
test('markerless banner login and reconnect ignore stale old socket close',async t=>{
  const s=await fake(t,(socket,line)=>{if(line.startsWith('connect '))socket.write('Synthetic greeting\n');});
  await s.connectAndLogin(); assert.equal(s.loggedIn,true);
  const old=s.socket; await s.connectAndLogin(); old.emit('close');
  assert.equal(s.loggedIn,true); assert.equal(s.connected,true);
});
test('login rejection does not log server content and closes socket',async t=>{
  const s=await fake(t,(socket)=>socket.write('incorrect password private-output\n'));
  await assert.rejects(s.connectAndLogin(),/rejected/); assert.equal(s.loggedIn,false);assert.equal(s.socket,null);
});
test('silent markerless login assumes readiness after idle without probe commands',async t=>{
  const lines=[];const s=await fake(t,(_socket,line)=>lines.push(line));
  const started=Date.now();await s.connectAndLogin();
  assert.ok(Date.now()-started>=500);assert.equal(s.loggedIn,true);
  assert.deepEqual(lines,['connect fake fake']);
});
test('disconnect during markerless login rejects and clears readiness',async t=>{
  const s=await fake(t,socket=>socket.destroy());
  await assert.rejects(s.connectAndLogin(),/closed/);assert.equal(s.loggedIn,false);assert.equal(s.socket,null);
});
test('continuous login output hits bounded drain deadline and closes',async t=>{
  const s=await fake(t,socket=>{const timer=setInterval(()=>socket.write('banner chunk\n'),25);socket.on('close',()=>clearInterval(timer));});
  await assert.rejects(s.connectAndLogin(),/login drain deadline/);assert.equal(s.loggedIn,false);assert.equal(s.socket,null);
});
test('marker deadline discards late bytes and never retries command',async t=>{
  let calls=0;
  const s=await fake(t,(socket,line)=>{if(line.startsWith('connect '))socket.write('Synthetic greeting\n');else{calls++;setTimeout(()=>{if(!socket.destroyed)socket.write('late ### Done ###');},60);}});
  await s.connectAndLogin();await assert.rejects(s.runCommand('fake-command',20),/Timed out/);
  assert.equal(s.connected,false);await sleep(70);assert.equal(s.buffer,'');assert.equal(calls,1);
});
test('both legacy capture loops bound continuous data and discard uncertain stream',async t=>{
  for(const method of ['runCommandCaptureUntilIdle','runCommandCaptureFragmentsUntilIdle']){
    const s=await fake(t,(socket,line)=>{if(line.startsWith('connect '))socket.write('Synthetic greeting\n');else{const timer=setInterval(()=>socket.write('x'),5);socket.on('close',()=>clearInterval(timer));}});
    await s.connectAndLogin();s.captureTimeoutMs=80;
    await assert.rejects(s[method]('fake-command',20,20),/total capture/);assert.equal(s.connected,false);
  }
});
test('active explicit cancellation aborts marker read and queue recovers',async t=>{
  const s=await fake(t,(socket,line)=>{if(line.startsWith('connect '))socket.write('Synthetic greeting\n');});
  await s.connectAndLogin();const controller=new AbortController();
  const result=commandContext.run({signal:controller.signal},()=>s.runCommand('fake-command'));
  await sleep(10);controller.abort();await assert.rejects(result,/closed|cancelled/);
  assert.equal(s.connected,false);assert.equal(s.pendingQueueDepth,0);
});

test('banner followed by delayed known rejection never assumes readiness',async t=>{
  const s=await fake(t,(socket)=>{socket.write('Synthetic greeting\n');setTimeout(()=>socket.write('denied\n'),80);});
  await assert.rejects(s.connectAndLogin(),/rejected/);assert.equal(s.loggedIn,false);
});
test('queue wait budget is shared across preflight and command',async()=>{
  const s=make({queueTimeoutMs:60});let release;
  const blocker=s.enqueue(()=>new Promise(r=>release=r));await sleep(1);
  const ctx={};let execute=false;
  const preflight=commandContext.run(ctx,()=>s.enqueue(()=>{}));
  await sleep(40);release();await blocker;await preflight;
  const nextBlock=s.enqueue(()=>new Promise(r=>release=r));await sleep(1);
  const command=commandContext.run(ctx,()=>s.enqueue(()=>execute=true));
  await assert.rejects(command,/busy/);assert.equal(execute,false);
  release();await nextBlock;await s.commandQueue;assert.equal(execute,false);
});
test('empty legacy response is an error and retires stream',async t=>{
  const s=await fake(t,(socket,line)=>{if(line.startsWith('connect '))socket.write('Synthetic greeting\n');});
  await s.connectAndLogin();await assert.rejects(s.runCommandCaptureUntilIdle('fake-command',10,10),/first response/);
  assert.equal(s.connected,false);
});
test('callback-only partial write errors retire marker and idle streams',async()=>{
  for(const method of ['runCommand','runCommandUntil','runCommandCaptureUntilIdle']){
    const s=make();s.connected=true;s.loggedIn=true;
    const socket={write(_payload,callback){queueMicrotask(()=>callback(new Error('fake write failure')));},end(){},destroy(){}};
    s.socket=socket;
    const result=method==='runCommandUntil'?s[method]('fake',()=>({done:false}),100):s[method]('fake',100,100);
    await assert.rejects(result,/failure|closed/);assert.equal(s.connected,false);
  }
});
test('cancel during login closes socket; next explicit reconnect succeeds',async t=>{
  let attempts=0;
  const s=await fake(t,(socket,line)=>{if(line.startsWith('connect ') && ++attempts>1)socket.write('Synthetic greeting\n');});
  const controller=new AbortController();const result=commandContext.run({signal:controller.signal},()=>s.ensureConnectedAndLoggedIn());
  await sleep(40);controller.abort();await assert.rejects(result,/closed|cancelled/);assert.equal(s.connected,false);
  await s.ensureConnectedAndLoggedIn();assert.equal(s.loggedIn,true);assert.equal(attempts,2);
});
test('queue deadline is checked even before overdue timer callback runs',async()=>{
  const s=make({queueTimeoutMs:10});let ran=false;
  const result=s.enqueue(()=>ran=true);const until=Date.now()+20;while(Date.now()<until){}
  await assert.rejects(result,/busy/);assert.equal(ran,false);
  assert.equal(make().queueTimeoutMs,30000);
});
test('incomplete search validation retires socket before next queued work can start',async t=>{
  const s=await fake(t,(socket,line)=>{if(line.startsWith('connect '))socket.write('Synthetic greeting\n');else socket.write('{partial');});
  await s.connectAndLogin();
  const result=s.runSearchCapture('fake-search',10,100,200,()=>false);
  let nextConnected;
  const next=s.enqueue(()=>{nextConnected=s.connected;});
  await result;await next;assert.equal(nextConnected,false);
});

function diagnosticLogger(records) {
  return Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level =>
    [level, (message, metadata) => records.push(sanitizeLogInfo({ level, message, ...metadata }))]));
}

test('timeout and remote EOF have distinct correlated diagnostics without response contents', async t => {
  const records = [];
  const s = await fake(t, (socket, line) => {
    if (line.startsWith('connect ')) socket.write('Synthetic private greeting\n');
    else if (line === 'remote-end') socket.end('private remote disconnect message\n');
    else socket.write('private incomplete response\n');
  }, { logger: diagnosticLogger(records) });
  await s.connectAndLogin();
  const firstSocketId = s.socketId;
  await assert.rejects(commandContext.run({ requestId: 'timeout-request', connectionId: 'client-a', toolName: 'run_moo_command' },
    () => s.runCommand('private command', 30)), /Timed out/);
  const timeout = records.find(record => record.reason === 'marker_timeout');
  assert.equal(timeout.socketId, firstSocketId, 'timeout identifies the retired socket');
  assert.equal(timeout.requestId, 'timeout-request', 'timeout identifies the active request');
  assert.equal(timeout.connectionId, 'client-a', 'timeout identifies the MCP session');
  assert.equal(timeout.timeoutMs, 30, 'timeout records its deadline');
  assert.ok(timeout.bufferedChars > 0, 'timeout records that incomplete output arrived');
  assert.equal(records.find(record => record.event === 'moo_command_finished').status, 'error');

  await s.ensureConnectedAndLoggedIn();
  const secondSocketId = s.socketId;
  assert.notEqual(secondSocketId, firstSocketId, 'reconnect gets a new socket identity');
  await assert.rejects(commandContext.run({ requestId: 'remote-request', connectionId: 'client-b' },
    () => s.runCommand('remote-end', 1000)), /closed/);
  const remote = records.find(record => record.reason === 'remote_close');
  assert.equal(remote.socketId, secondSocketId, 'remote close identifies the new socket');
  assert.equal(remote.requestId, 'remote-request', 'remote event uses current work, not the connection creator');
  assert.ok(records.some(record => record.event === 'moo_socket_end'), 'remote EOF is recorded separately');
  assert.equal(records.filter(record => record.event === 'moo_connection_closed').length, 2, 'one closure record per retired socket');
  assert.equal(JSON.stringify(records).includes('private'), false, 'diagnostics never include command or response text');
});

test('active cancellation logs its own reason and does not close a replacement socket', async t => {
  const records = [];
  const s = await fake(t, (socket, line) => {
    if (line.startsWith('connect ')) socket.write('Synthetic greeting\n');
  }, { logger: diagnosticLogger(records) });
  await s.connectAndLogin();
  const old = s.socket;
  const controller = new AbortController();
  const pending = commandContext.run({ requestId: 'cancel-request', signal: controller.signal }, () => s.runCommand('private command'));
  await sleep(10);
  controller.abort();
  await assert.rejects(pending, /closed|cancelled/);
  assert.equal(records.find(record => record.reason === 'request_cancelled').requestId, 'cancel-request');
  assert.equal(records.find(record => record.event === 'moo_command_finished').status, 'cancelled');
  await s.ensureConnectedAndLoggedIn();
  old.emit('close');
  assert.equal(s.connected, true, 'late close from retired socket cannot kill replacement');
  assert.equal(records.filter(record => record.event === 'moo_connection_closed').length, 1);
});

test('socket error diagnostics retain known codes and drop arbitrary error content', async t => {
  const records = [];
  const s = await fake(t, socket => socket.write('Synthetic greeting\n'), { logger: diagnosticLogger(records) });
  for (const [code, expected] of [['ECONNRESET', 'ECONNRESET'], ['private error code', 'unknown']]) {
    await s.connectAndLogin();
    s.socket.emit('error', Object.assign(new Error('private error message'), { code }));
    assert.equal(records.filter(record => record.reason === 'socket_error').at(-1).errorCode, expected);
    assert.equal(s.connected, false);
  }
  assert.equal(JSON.stringify(records).includes('private'), false);
});

test('concurrent MCP contexts share one login and serialize commands on one socket', async t => {
  let logins = 0, inFlight = 0, maxInFlight = 0;
  const commands = [];
  const s = await fake(t, (socket, line) => {
    if (line.startsWith('connect ')) {
      logins++;
      socket.write('Synthetic greeting\n');
    } else {
      commands.push(line);
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      setTimeout(() => {
        inFlight--;
        socket.write(`${line} ### Done ###\n`);
      }, 10);
    }
  });
  const results = await Promise.all(['a', 'b', 'c'].map(connectionId => commandContext.run({ connectionId }, async () => {
    await s.ensureConnectedAndLoggedIn();
    return s.runCommand(connectionId, 1000);
  })));
  assert.deepEqual(results, ['a', 'b', 'c'], 'each client receives its own result');
  assert.equal(logins, 1, 'concurrent reconnect preflights open exactly one MOO login');
  assert.equal(maxInFlight, 1, 'MOO commands never overlap');
  assert.deepEqual(commands, ['a', 'b', 'c'], 'each command executes exactly once');
});

test('idle remote disconnect is not attributed to the request that opened the socket', async t => {
  const records = [];
  let remote;
  const s = await fake(t, socket => {
    remote = socket;
    socket.write('Synthetic greeting\n');
  }, { logger: diagnosticLogger(records) });
  await commandContext.run({ requestId: 'old-request', connectionId: 'old-client' }, () => s.ensureConnectedAndLoggedIn());
  const closed = new Promise(resolve => s.socket.once('close', resolve));
  remote.end();
  await closed;
  const diagnostic = records.find(record => record.reason === 'remote_close');
  assert.equal(diagnostic.activeWork, false, 'connection was idle');
  assert.equal(diagnostic.requestId, undefined, 'old opener is not reported as active work');
  assert.equal(diagnostic.connectionId, undefined, 'old client is not blamed for idle EOF');
});

test('ToastCore post-login callback permission warning does not reject authentication', async t => {
  const warning = 'Confunc failed: Permission denied.\r\n';
  const s = await fake(t, socket => socket.write(warning + 'Last connected recently.\r\n'));
  await s.connectAndLogin();
  assert.equal(s.loggedIn, true);

  const rejected = await fake(t, socket => socket.write(warning + 'Either that player does not exist, or has a different password.\r\n'));
  await assert.rejects(rejected.connectAndLogin(), /login rejected/);
});
