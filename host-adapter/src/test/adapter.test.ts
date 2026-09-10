import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDefaultMapperContext, mapArgvPaths, hostToContainerPath, rewriteBatchJson, tokenizeCommand } from '../path-mapper.js';
import { buildContainerEnv, envToDockerArgs } from '../env.js';
import { rewriteResult } from '../result-mapper.js';
import { CANCEL_DAEMON_SCRIPT, sanitizeNamespace } from '../cancellation.js';
const base = '/docker/agent-browser';
const ctx = () => createDefaultMapperContext(base);

test('upload maps every file, never the selector', () => {
  const r = mapArgvPaths(['upload', '.file', '/tmp/a.txt', '/tmp/b.txt'], ctx());
  assert.equal(r.mappedArgv[1], '.file'); assert.deepEqual(r.inputFiles, ['/tmp/a.txt','/tmp/b.txt']);
});
test('screenshot native operand grammar', () => {
  for (const args of [['.panel','/tmp/a.png'], ['--full','/tmp/a.png'], ['#panel','--full','/tmp/a.png'], ['./a.png'], ['../a.png'], ['.hidden/a.png','/tmp/a.png']]) {
    const r = mapArgvPaths(['screenshot',...args],ctx()); assert.equal(r.outputFiles.length,1); assert.equal(r.outputFiles[0],args.at(-1));
  }
  assert.deepEqual(mapArgvPaths(['screenshot','.panel'],ctx()).outputFiles,[]);
});
test('global value options do not become commands', () => {
  for (const flag of ['--user-agent','--args','--device','--provider','--enable']) assert.deepEqual(mapArgvPaths([flag,'literal','screenshot','/tmp/a.png'],ctx()).outputFiles,['/tmp/a.png']);
});
test('request and source identities isolate staging and prevent traversal', () => {
  const c = ctx(); const paths = ['/tmp/a/report.pdf','/tmp/b/report.pdf','../../secret','/tmp/report.pdf'].map(p=>hostToContainerPath(p,c));
  assert.equal(new Set(paths).size,4); assert.ok(paths.every(p=>p.startsWith(c.stagingContainerDir+'/')));
  assert.notEqual(hostToContainerPath('/tmp/a/report.pdf',ctx()), paths[0]);
});
test('extensionless state files and shared profiles', () => {
  assert.deepEqual(mapArgvPaths(['state','save','sessionstate'],ctx()).outputFiles,['sessionstate']);
  assert.throws(()=>mapArgvPaths(['--profile','/tmp/profile','open','about:blank'],ctx()),/persistent/);
  assert.equal(mapArgvPaths(['--profile',base+'/profiles/work','open','about:blank'],ctx()).mappedArgv[1],'/profiles/work');
});
test('batch stdin uses same grammar for flags, upload, state, recording', () => {
  const r = rewriteBatchJson(JSON.stringify([['screenshot','--full','/tmp/a.png'],['upload','#file','/tmp/a.txt'],['state','save','statefile'],['record','start','/tmp/a.webm']]),ctx());
  assert.deepEqual(r.outputFiles,['/tmp/a.png','statefile']); assert.deepEqual(r.inputFiles,['/tmp/a.txt']); assert.deepEqual(r.deferredFiles,['/tmp/a.webm']);
});
test('raw batch strings preserve literal whitespace and quotes', () => {
  const r = mapArgvPaths(['batch','--bail',`fill '#name' 'a "b" c'`,'screenshot --full /tmp/a.png'],ctx());
  assert.deepEqual(tokenizeCommand(r.mappedArgv[2]!),['fill','#name','a "b" c']); assert.deepEqual(r.outputFiles,['/tmp/a.png']);
});
test('file URLs decode spaces and preserve fragments', () => {
  const r=mapArgvPaths(['open','file:///tmp/a%20b.html?x=1#fragment'],ctx());
  assert.deepEqual(r.inputFiles,['/tmp/a b.html']); assert.ok(r.mappedArgv[1]!.endsWith('a%20b.html?x=1#fragment'));
});
test('script clears inherited container settings and every proxy spelling',()=>{
  const env=buildContainerEnv({hostEnv:{AGENT_BROWSER_PROFILE:'/secret'},mode:'script'});
  assert.equal(env.AGENT_BROWSER_PROFILE,''); assert.ok(envToDockerArgs(env).includes('ALL_PROXY='));
});

const entry=fileURLToPath(new URL('../index.js',import.meta.url));
function fixture(){
  const root=join(base,'.cache','adapter-tests'); mkdirSync(root,{recursive:true});
  const dir=mkdtempSync(join(root,'case-')); const log=join(dir,'calls.jsonl');
  const fake=`#!${process.execPath}
import fs from 'node:fs';
const args=process.argv.slice(2); let input=''; for await(const c of process.stdin) input+=c;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({args,input})+'\\n');
if(args[0]==='inspect') console.log('true');
else if(args.includes('cat')) { if(process.env.FAKE_FAIL_CP==='1')process.exit(9); process.stdout.write('artifact'); }
else if(args.includes('setsid')) { if(process.env.FAKE_DELAY==='1')await new Promise(r=>setTimeout(r,5000)); console.log(JSON.stringify({success:process.env.FAKE_JSON_FAILURE!=='1',data:{ok:true}})); }
else if(args.includes('close')) console.log(JSON.stringify({success:true,data:{closed:true}}));
else if(args.includes('piab-cancel')) { console.log('cleanup-complete'); }
`;
  writeFileSync(join(dir,'docker'),fake,{mode:0o755});
  return {dir,log, clean:()=>rmSync(dir,{recursive:true,force:true})};
}
async function invoke(f: ReturnType<typeof fixture>, args:string[],stdin='',env:Record<string,string>={}) {
  return new Promise<{code:number|null;stderr:string}>((res,rej)=>{
    const child=spawn(process.execPath,[entry,'--host-adapter-cwd',base,...args],{env:{...process.env,PATH:f.dir+':'+process.env.PATH,FAKE_LOG:f.log,PIAB_CONTAINER:'fake-'+f.dir.split('/').at(-1),...env},stdio:['pipe','ignore','pipe']});
    let stderr='';child.stderr.on('data',d=>stderr+=d);child.on('error',rej);child.on('close',code=>res({code,stderr}));child.stdin.end(stdin);
  });
}
function calls(f:ReturnType<typeof fixture>):Array<{args:string[];input:string}>{return existsSync(f.log)?readFileSync(f.log,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];}
test('batch input staging occurs before the browser call',async()=>{
  const f=fixture();try{
    const path=join(f.dir,'input.html');writeFileSync(path,'<h1>fresh</h1>');
    const r=await invoke(f,['batch','--bail'],JSON.stringify([['open','file://'+path],['screenshot',join(f.dir,'out.png')]]));assert.equal(r.code,0,r.stderr);
    const rows=calls(f); const stage=rows.findIndex(r=>r.input==='<h1>fresh</h1>');const browser=rows.findIndex(r=>r.args.includes('setsid'));
    assert.ok(stage>=0 && stage<browser);assert.ok(rows[browser]!.input.includes('/tmp/piab-staging/'));
    assert.equal(rows[browser]!.args[rows[browser]!.args.indexOf('setsid')+1],'--wait');
  }finally{f.clean();}
});
test('eval stdin resembling batch JSON is never rewritten',async()=>{
  const f=fixture();try{
    const input='[["screenshot","/tmp/a.png"]]'; const r=await invoke(f,['eval','--stdin'],input);assert.equal(r.code,0,r.stderr);
    assert.equal(calls(f).find(r=>r.args.includes('setsid'))!.input,input);
  }finally{f.clean();}
});
test('ignored stdin cannot stage files when raw batch rows are present',async()=>{
  const f=fixture();try{
    const r=await invoke(f,['batch','get title'],'[["upload","#file","/nonexistent"]]');assert.equal(r.code,0,r.stderr);
    assert.ok(!calls(f).some(r=>r.args.includes('piab-stage')));
  }finally{f.clean();}
});
test('missing inputs and failed artifact retrieval fail the call',async()=>{
  const f=fixture();try{
    let r=await invoke(f,['upload','#file',join(f.dir,'missing')]);assert.equal(r.code,1);assert.ok(!calls(f).some(r=>r.args.includes('setsid')));
    r=await invoke(f,['screenshot',join(f.dir,'out.png')],'',{FAKE_FAIL_CP:'1'});assert.equal(r.code,1);assert.ok(!existsSync(join(f.dir,'out.png')));
  }finally{f.clean();}
});
test('environment config is staged before invocation',async()=>{
  const f=fixture();try{
    const path=join(f.dir,'config.json');writeFileSync(path,'{}');const r=await invoke(f,['get','title'],'',{AGENT_BROWSER_CONFIG:path});assert.equal(r.code,0,r.stderr);
    const args=calls(f).find(r=>r.args.includes('setsid'))!.args; assert.ok(args.some(a=>a.startsWith('AGENT_BROWSER_CONFIG=/tmp/piab-staging/')));
  }finally{f.clean();}
});
test('artifact metadata and batch argv are host paths, page text remains unchanged',()=>{
  const c=ctx();const host='/tmp/report.pdf';const container=hostToContainerPath(host,c);
  const data=JSON.parse(rewriteResult(Buffer.from(JSON.stringify({data:{path:container,text:container,results:[{command:['pdf',container],data:{path:container}}]}})),c).toString());
  assert.equal(data.data.path,host);assert.equal(data.data.text,container);assert.equal(data.data.results[0].command[1],host);
});
test('JSON failure with zero exit code is still failure',async()=>{
  const f=fixture();try{const r=await invoke(f,['screenshot',join(f.dir,'out.png')],'',{FAKE_JSON_FAILURE:'1'});assert.equal(r.code,1);assert.ok(!calls(f).some(r=>r.args.includes('cat')));}finally{f.clean();}
});
test('generated batch inputs do not require preexisting host files',async()=>{
  const f=fixture();try{const path=join(f.dir,'newstate');const r=await invoke(f,['batch','--bail'],JSON.stringify([['state','save',path],['state','load',path]]));assert.equal(r.code,0,r.stderr);}finally{f.clean();}
});
test('input staging survives until session close',async()=>{
  const f=fixture();try{
    const path=join(f.dir,'input.txt');writeFileSync(path,'keep');
    let r=await invoke(f,['upload','#file',path]);assert.equal(r.code,0,r.stderr);
    assert.ok(calls(f).some(r=>r.args.includes('piab-cleanup') && r.args.includes('keep')));
    r=await invoke(f,['close']);assert.equal(r.code,0,r.stderr);
    assert.ok(calls(f).some(r=>r.args.includes('piab-cleanup') && r.args.includes('drop')));
  }finally{f.clean();}
});
test('recording metadata can refer to a previous request without changing new destinations',()=>{
  const c=ctx();c.reportedPaths.set('/tmp/piab-staging/old/video.webm','/tmp/video.webm');
  const mapped=hostToContainerPath('/tmp/video.webm',c);assert.notEqual(mapped,'/tmp/piab-staging/old/video.webm');
  const result=JSON.parse(rewriteResult(Buffer.from(JSON.stringify({data:{path:'/tmp/piab-staging/old/video.webm'}})),c).toString());assert.equal(result.data.path,'/tmp/video.webm');
});
test('namespace identity follows upstream normalization',()=>{
  assert.equal(sanitizeNamespace('Next Dev Loop: /Users/me/worktree!'),'next-dev-loop-users-me-worktree');assert.equal(sanitizeNamespace('--A___B--'),'a_b');
});
test('forced cleanup refuses a PID belonging to a non-daemon process',async()=>{
  const f=fixture();try{
    const pid=join(f.dir,'pid');writeFileSync(pid,String(process.pid));
    const r=await new Promise<{code:number|null;stderr:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,['-e',CANCEL_DAEMON_SCRIPT,pid,'not-a-daemon'],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>resolve({code,stderr}));
    });assert.equal(r.code,1);assert.match(r.stderr,/identity mismatch/);
  }finally{f.clean();}
});
test('deadline triggers exact-session cleanup and nonzero status',async()=>{
  const f=fixture();try{
    const r=await invoke(f,['--namespace','review','--session','cancel','wait','5000'],'',{FAKE_DELAY:'1',PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS:'1000'});
    assert.equal(r.code,124,r.stderr);
    const cancel=calls(f).filter(r=>r.args.includes('piab-cancel'));assert.equal(cancel.length,1);
    const args=cancel[0]!.args;assert.ok(args.includes('cancel')&&args.includes('review'));assert.ok(args.some(a=>a.includes('cleanup-complete')));
    assert.match(r.stderr,/cancelled session stopped/);
    assert.ok(!calls(f).some(r=>r.args.includes('agent-browser')&&r.args.includes('close')&&!r.args.includes('piab-cancel')));
  }finally{f.clean();}
});
