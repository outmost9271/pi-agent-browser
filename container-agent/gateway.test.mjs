import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {findChromeBinary,rewriteDiscovery} from './gateway-utils.mjs';
const root='/docker/agent-browser/.cache/gateway-tests';
test('Chrome discovery is version independent and checks executability',()=>{
  mkdirSync(root,{recursive:true});const dir=mkdtempSync(join(root,'case-'));
  try{const path=join(dir,'chrome-999.1','chrome');mkdirSync(join(dir,'chrome-999.1'));writeFileSync(path,'#!/bin/sh\n',{mode:0o755});assert.equal(findChromeBinary(undefined,[dir]),path);assert.equal(findChromeBinary(join(dir,'missing'),[dir]),null);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('CDP discovery rewrites only connection metadata',()=>{
  const original={url:'http://example.test:9223',title:'value:9223',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/browser/a'};
  const result=JSON.parse(rewriteDiscovery(JSON.stringify([original]),9223,9224));
  assert.equal(result[0].url,original.url);assert.equal(result[0].title,original.title);assert.equal(result[0].webSocketDebuggerUrl,'ws://127.0.0.1:9224/devtools/browser/a');
});
test('isolated built image serves HTTP discovery and browser WebSocket', {skip: process.env.PIAB_GATEWAY_LIVE!=='1',timeout:15000},async()=>{
  const data=await (await fetch('http://127.0.0.1:9224/json/version',{signal:AbortSignal.timeout(5000)})).json();
  assert.match(data.webSocketDebuggerUrl,/^ws:\/\/127\.0\.0\.1:9224\//);
  const ws=new WebSocket(data.webSocketDebuggerUrl);
  try{
    const result=await new Promise((resolve,reject)=>{
      ws.addEventListener('error',()=>reject(new Error('WebSocket error')));
      ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method:'Browser.getVersion'})));
      ws.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.id===1)resolve(value);});
    });
    assert.ok(result.result.product.includes('Chrome'));
  }finally{ws.close();}
});
