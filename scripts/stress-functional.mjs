#!/usr/bin/env node
// 对已部署容器做 open → snapshot 稳定性压测（经宿主机适配器，即插件实际使用的同一路径）。
//
// 用法：
//   node scripts/stress-functional.mjs [--iterations 100] [--concurrency 1] [--fresh]
//                                        [--container pi-agent-browser] [--namespace piab-stress]
// 默认每个并发通道复用同一会话（常规使用形态）；--fresh 每次迭代新建会话（含 Chrome 冷启动）。
// 断言：全部调用 success=true；任何失败都会打印并让退出码非 0。结束时关闭测试会话。
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
const args=process.argv.slice(2);
const option=(name,fallback)=>{const index=args.indexOf('--'+name);return index>=0?args[index+1]:fallback;};
const flag=name=>args.includes('--'+name);
const iterations=Number(option('iterations','100'));
const concurrency=Number(option('concurrency','1'));
const fresh=flag('fresh');
const container=option('container',process.env.PIAB_CONTAINER||'pi-agent-browser');
const namespace=option('namespace','piab-stress');
const prefix=option('session-prefix','stress-'+randomUUID().slice(0,8));
const adapter=join(dirname(fileURLToPath(import.meta.url)),'..','host-adapter','dist','index.js');
function call(session,args){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[adapter,'--host-adapter-cwd','/docker/agent-browser','--namespace',namespace,'--session',session,'--json',...args],{env:{...process.env,PIAB_CONTAINER:container},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
    child.on('error',e=>resolve({ok:false,error:e.message}));
    child.on('close',code=>{let data;try{data=JSON.parse(out);}catch{}resolve({ok:code===0&&data?.success!==false,code,error:err.slice(0,300)});});
  });
}
const samples=[];
async function round(session){
  const started=Date.now();
  const open=await call(session,['open','about:blank']);
  const snapshot=await call(session,['snapshot','-i']);
  samples.push({session,ms:Date.now()-started,ok:open.ok&&snapshot.ok,detail:open.ok?snapshot.error:open.error});
  if(!open.ok) console.error(`open failed for ${session}: ${open.error}`);
  if(!snapshot.ok) console.error(`snapshot failed for ${session}: ${snapshot.error}`);
}
const started=Date.now();
await Promise.all([...Array(concurrency).keys()].map(async lane=>{
  if(fresh){
    for(let i=lane;i<iterations;i+=concurrency){const session=`${prefix}-${i}`;await round(session);const close=await call(session,['close']);if(!close.ok)console.error(`close failed for ${session}: ${close.error}`);}
    return;
  }
  const session=`${prefix}-lane${lane}`;
  for(let i=lane;i<iterations;i+=concurrency) await round(session);
  const close=await call(session,['close']);
  if(!close.ok) console.error(`close failed for ${session}: ${close.error}`);
}));
const failures=samples.filter(s=>!s.ok);
const durations=samples.map(s=>s.ms).sort((a,b)=>a-b);
const total=Date.now()-started;
console.log(JSON.stringify({container,namespace,iterations,concurrency,fresh,rounds:samples.length,failures:failures.length,totalMs:total,perRound:{minMs:durations[0],p50Ms:durations[Math.floor(durations.length/2)],maxMs:durations.at(-1),avgMs:Math.round(durations.reduce((a,b)=>a+b,0)/durations.length)}},null,2));
if(failures.length){console.error('failure samples:',JSON.stringify(failures.slice(0,5)));process.exitCode=1;}
