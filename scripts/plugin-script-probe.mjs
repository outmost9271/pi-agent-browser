// Diagnose the installed plugin's sandbox independently of the conversation tool host.
// This probe neither opens a browser nor changes any Pi configuration.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync} from 'node:fs';
const root=process.env.PIAB_PLUGIN_ROOT || '/agent-pi/config/npm/node_modules/pi-agent-browser-native';
const {runAgentBrowserScript}=await import(pathToFileURL(join(root,'dist/extensions/agent-browser/lib/input-modes/script.js')).href);
const result=await runAgentBrowserScript({
  code:'emit({check:"sandbox-only",ok:true});', timeoutMs:5000,
  dispatch:async()=>{throw new Error('Sandbox-only probe must not dispatch any browser call');},
});
const output='/docker/agent-browser/.cache/functional-regression/results';
mkdirSync(output,{recursive:true});writeFileSync(join(output,'standalone-script-probe.json'),JSON.stringify(result,null,2));
assert.equal(result.ok,true,result.error);assert.deepEqual(result.data,{check:'sandbox-only',ok:true});
console.log('Installed plugin sandbox passed independently; this does not certify the conversation tool host.');
