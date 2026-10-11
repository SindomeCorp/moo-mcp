import assert from "node:assert/strict";
import test from "node:test";
import { captureSearchResponse, searchResponseResult } from "../src/search-response.js";
import { buildSearchCommand } from "../src/search-command.js";

const empty = '{"ok":1,"results":[],"meta":{"returned":0}}';
const parse = text => { try { const p=JSON.parse(text); return p && typeof p === "object" && !Array.isArray(p) ? p : null; } catch { return null; } };
const payload = result => JSON.parse(result.content[0].text);
async function simulate(events, options={}) {
  let clock=0, output="", connected=true, cursor=0;
  const advance=()=>{
    while(cursor<events.length && events[cursor].at<=clock){
      const event=events[cursor++];
      if(event.close) connected=false;
      output+=event.text??"";
    }
  };
  advance();
  return captureSearchResponse({ readOutput:()=>output, isConnected:()=>connected,
    idleMs:100, firstResponseTimeoutMs:2000, totalTimeoutMs:15000,
    now:()=>clock, sleep:async ms=>{clock+=ms;advance();}, ...options });
}

test("delayed first response within budget stays successful, including valid empty results",async()=>{
  const c=await simulate([{at:1900,text:empty}]);
  const r=searchResponseResult(c,parse);
  assert.equal(r.isError,false);assert.deepEqual(payload(r),JSON.parse(empty));
  assert.equal(c.capture.first_response_ms,1900);assert.equal(c.capture.elapsed_ms,2000);
  assert.equal(c.capture.stop_reason,"idle");assert.equal(c.capture.completion_confirmed,false);
  assert.deepEqual(r._meta.moo_capture,c.capture);
});

test("no output and first output past deadline report timeout, without calling JSON parser",async()=>{
  for(const events of [[],[{at:2050,text:empty}]]){
    const c=await simulate(events);
    const r=searchResponseResult(c,()=>{throw new Error("must not parse a timeout");});
    assert.equal(r.isError,true);assert.equal(payload(r).error,"moo_response_timeout");
    assert.equal(c.capture.elapsed_ms,2000);assert.equal(c.capture.timed_out_waiting_for_first_line,true);
    assert.equal(c.capture.received_chars,0);assert.equal(payload(r).response_preview,"");
  }
});

test("synchronous first output is recognized; whitespace alone is not a valid empty result",async()=>{
  assert.equal(searchResponseResult(await simulate([{at:0,text:empty}]),parse).isError,false);
  const r=searchResponseResult(await simulate([{at:0,text:" \r\n"}]),parse);
  assert.equal(payload(r).error,"moo_empty_response");
});

test("partial JSON at idle has explicit incomplete diagnostics and retained output",async()=>{
  for(const partial of ['{"ok":1,"results":[', '{"detail":"unfinished', 'notice\n{"ok":']){
    const c=await simulate([{at:50,text:partial}]);const p=payload(searchResponseResult(c,parse));
    assert.equal(p.error,"moo_incomplete_response");assert.equal(p.response_preview,partial);
    assert.equal(p.capture.stop_reason,"idle");assert.equal(p.capture.timed_out,false);
  }
});

test("complete but invalid JSON is distinct from timeout and incomplete output",async()=>{
  for(const invalid of ['{"ok":}', 'not JSON', '{"a":]}', '[1,2]']){
    const r=searchResponseResult(await simulate([{at:50,text:invalid}]),parse);
    assert.equal(payload(r).error,"moo_invalid_json");
  }
});

test("continuous output has a bounded total deadline and preserves partial diagnostics",async()=>{
  const events=Array.from({length:100},(_,i)=>({at:i*50,text:i===0?'{"detail":"':"x"}));
  const c=await simulate(events,{totalTimeoutMs:500});
  const p=payload(searchResponseResult(c,parse));
  assert.equal(p.error,"moo_response_timeout");assert.equal(c.capture.stop_reason,"total_timeout");
  assert.equal(c.capture.elapsed_ms,500);assert.equal(c.capture.timed_out_waiting_for_first_line,false);
  assert.ok(p.response_preview.startsWith('{"detail":"'));assert.ok(c.capture.received_chars>0);
});

test("disconnect preserves partial response and is not reported as a JSON error",async()=>{
  const c=await simulate([{at:50,text:'{"ok":'},{at:100,close:true}]);
  const p=payload(searchResponseResult(c,parse));
  assert.equal(p.error,"moo_connection_closed");assert.equal(p.response_preview,'{"ok":');
});

test("total deadline can precede first-response wait and never reports false success",async()=>{
  const c=await simulate([],{totalTimeoutMs:500});
  assert.equal(c.capture.stop_reason,"total_timeout");assert.equal(c.capture.elapsed_ms,500);
  const withJson={...c,output:empty};
  assert.equal(payload(searchResponseResult(withJson,parse)).error,"moo_response_timeout");
});

test("MOO-reported command failures retain their exact payload with MCP isError",async()=>{
  for(const failure of [{ok:0,error:"search_failed",detail:"Property not found"},
    {ok:0,error:"invalid_property_filter"},{error:"permission_denied"}]){
    const r=searchResponseResult(await simulate([{at:50,text:JSON.stringify(failure)}]),parse);
    assert.equal(r.isError,true);assert.deepEqual(payload(r),failure);assert.equal(r._meta.moo_capture.stop_reason,"idle");
  }
});

test("bounded preview flags truncation, retains wait metadata and redacts before slicing",async()=>{
  const secret="test-secret-value";
  const c=await simulate([{at:50,text:'{"detail":"'+secret+'\x1b[31m'+"x".repeat(1100)}]);
  const p=payload(searchResponseResult(c,parse,{secrets:[secret],previewLimit:40}));
  assert.equal(p.preview_truncated,true);assert.equal(p.response_preview.length,40);
  assert.ok(p.response_preview.includes("[REDACTED]"));assert.ok(!p.response_preview.includes(secret));
  assert.ok(!p.response_preview.includes("\x1b"));assert.equal(p.preview_limit_chars,40);
  assert.equal(p.capture.first_response_timeout_ms,2000);assert.equal(p.capture.idle_capture_ms,100);
  assert.equal(p.capture.total_timeout_ms,15000);assert.equal(p.capture.received_chars,c.output.length);
});

test("fragmented successful response and existing serializer remain compatible",async()=>{
  assert.equal(buildSearchCommand({type:"things",name:"TERRA armband",limit:3,extra_filters:["backend=cache"]}),
    '@search-json things n="TERRA armband" limit=3 backend=cache');
  const c=await simulate([{at:50,text:empty.slice(0,10)},{at:100,text:empty.slice(10)}]);
  assert.deepEqual(payload(searchResponseResult(c,parse)),JSON.parse(empty));
});
