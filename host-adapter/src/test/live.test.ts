import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const base='/docker/agent-browser';
const entry=fileURLToPath(new URL('../index.js',import.meta.url));
const enabled=process.env.PIAB_INTEGRATION==='1';
// 默认跑隔离测试容器；PIAB_TEST_CONTAINER 可指向正式容器以验证已部署镜像。
const container=process.env.PIAB_TEST_CONTAINER || 'piab-functional-regression';
const namespace='adapter-live-review';
const output=join(base,'.cache','live-regression');
async function invoke(session:string,args:string[],stdin?:unknown,extraEnv:Record<string,string>={}){
  return new Promise<{code:number|null;data:any;stderr:string}>((resolve,reject)=>{
    const child=spawn(process.execPath,[entry,'--host-adapter-cwd',base,'--namespace',namespace,'--session',session,'--json',...args],{env:{...process.env,PIAB_CONTAINER:container,...extraEnv},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('close',code=>{let data;try{data=JSON.parse(stdout);}catch{}resolve({code,data,stderr});});
    child.stdin.end(stdin===undefined?'':typeof stdin==='string'?stdin:JSON.stringify(stdin));
  });
}
async function ok(session:string,args:string[],stdin?:unknown){const r=await invoke(session,args,stdin);assert.equal(r.code,0,JSON.stringify(r));assert.notEqual(r.data?.success,false,JSON.stringify(r));return r.data;}
test('isolated image: files, batch ordering, upload lifetime, recording, state, cleanup',{skip:!enabled,timeout:180000},async()=>{
  mkdirSync(output,{recursive:true});const session='files';
  try{
    await ok(session,['batch','--bail'],[
      ['open','file://'+base+'/host-adapter/test-fixtures/fixture.html'],
      ['upload','#file',base+'/host-adapter/test-fixtures/upload.txt'],
      ['screenshot','.panel',join(output,'element.png')],
      ['pdf',join(output,'page.pdf')],
      ['state','save',join(output,'state')],['state','load',join(output,'state')],
    ]);
    const value=await ok(session,['eval','--stdin'],"document.querySelector('#file').files[0].text()");assert.ok(JSON.stringify(value).includes('regression-upload'));
    assert.equal(readFileSync(join(output,'element.png')).subarray(1,4).toString(),'PNG');assert.equal(readFileSync(join(output,'page.pdf')).subarray(0,4).toString(),'%PDF');
    await ok(session,['download','#dl',join(output,'download.txt')]);assert.equal(readFileSync(join(output,'download.txt'),'utf8'),'regression-download');
    await ok(session,['record','start',join(output,'record.webm')]);
    const stopped=await ok(session,['batch','--bail'],[['get','url'],['record','stop']]);
    assert.equal(stopped[1].result.path,join(output,'record.webm'));assert.ok(readFileSync(join(output,'record.webm')).length>100);
    await ok(session,['batch','--bail',`trace start`,`get title`,`trace stop ${join(output,'trace.json')}`]);assert.ok(existsSync(join(output,'trace.json')));
  }finally{await ok(session,['close']);}
});
test('isolated image: successful artifacts survive a later batch failure',{skip:!enabled,timeout:60000},async()=>{
  const session='partial';try{
    await ok(session,['open','about:blank']);
    const artifact=join(output,'partial.png');
    const r=await invoke(session,['batch','--bail'],[['screenshot',artifact],['not-a-real-command']]);
    assert.equal(r.code,1);assert.equal(readFileSync(artifact).subarray(1,4).toString(),'PNG');assert.equal(r.data[0].success,true);assert.equal(r.data[1].success,false);
  }finally{await ok(session,['close']);}
});
test('isolated image: concurrent same-basename outputs remain distinct',{skip:!enabled,timeout:120000},async()=>{
  try{
    const texts=['red','blue']; await Promise.all(texts.map(async text=>{
      await ok(text,['open','about:blank']);await ok(text,['eval','--stdin'],`document.title=${JSON.stringify(text)};document.body.style.background=${JSON.stringify(text)}`);
      const path=join(output,text,'report.png');await ok(text,['screenshot',path]);assert.ok(existsSync(path));
      const title=await ok(text,['get','title']);assert.ok(JSON.stringify(title).includes(text));
    }));
    assert.notDeepEqual(readFileSync(join(output,'red','report.png')),readFileSync(join(output,'blue','report.png')));
  }finally{await Promise.all(['red','blue'].map(s=>ok(s,['close'])));}
});
test('isolated image: SIGTERM cancellation finishes inside the 2s plugin watchdog window',{skip:!enabled,timeout:60000},async()=>{
  const session='sigterm';
  const survivor='sigterm-survivor';
  const dockerOut=async(args:string[])=>new Promise<string>((resolve,reject)=>{
    const child=spawn('docker',args,{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('error',reject);child.on('close',()=>resolve(out.trim()));
  });
  const pidFile=`/home/agent/.agent-browser/namespaces/${namespace}/run/${session}.pid`;
  try{
    await ok(survivor,['open','about:blank']);
    await ok(session,['open','about:blank']);
    const pid=await dockerOut(['exec',container,'cat',pidFile]);assert.match(pid,/^[0-9]+$/,`missing daemon pid file: ${pid}`);
    const child=spawn(process.execPath,[entry,'--host-adapter-cwd',base,'--namespace',namespace,'--session',session,'--json','wait','30000'],{env:{...process.env,PIAB_CONTAINER:container},stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',d=>stderr+=d);
    await new Promise(r=>setTimeout(r,1200));
    const started=Date.now();const code:number|null=await new Promise(resolve=>{child.on('close',c=>resolve(c));child.kill('SIGTERM');});
    const elapsed=Date.now()-started;
    assert.ok(elapsed<1900,`cleanup exceeded the plugin window: ${elapsed}ms`);
    assert.equal(code,130,stderr);assert.match(stderr,/cancelled session stopped/);
    assert.equal(await dockerOut(['exec',container,'sh','-c',`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`]),'dead');
    assert.ok(JSON.stringify(await ok(survivor,['get','url'])).includes('about:blank'));
  }finally{await ok(survivor,['close']);}
});
test('isolated image: deadline closes only the cancelled session',{skip:!enabled,timeout:60000},async()=>{
  try{
    await ok('cancel',['open','about:blank']);await ok('survivor',['open','about:blank']);await ok('survivor',['eval','--stdin'],"document.title='survivor-marker'");
    const r=await invoke('cancel',['wait','10000'],undefined,{PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS:'1500'});assert.equal(r.code,124,r.stderr);assert.match(r.stderr,/cancelled session stopped/);
    assert.ok(JSON.stringify(await ok('survivor',['get','title'])).includes('survivor-marker'));
  }finally{await Promise.all(['cancel','survivor'].map(s=>ok(s,['close'])));}
});
