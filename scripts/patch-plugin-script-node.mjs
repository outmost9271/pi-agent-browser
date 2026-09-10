#!/usr/bin/env node
// 修复 pi-agent-browser-native 的 script 模式在 Node SEA 宿主下无法启动沙箱 worker 的问题。
//
// 背景：插件用 `spawn(process.execPath, [...])` 启动 script-worker。宿主的 Pi 是可执行
// 打包程序（SEA）时，process.execPath 指向 Pi 自身而不是 Node 运行时，worker 永远不会
// 发出 ready，script 调用只能等超时。此脚本把该 spawn 改为解析一个真实 Node：
//   PIAB_SCRIPT_NODE（绝对路径）→ fnm 受控别名 → /usr/local/bin/node → /usr/bin/node
//   → 最后回退 process.execPath（普通 Node 宿主行为不变）。
//
// 幂等：已打补丁则跳过。上游版本升级会重写 dist，届时重跑本脚本即可（verify-functional.sh 会调用）。
import {accessSync, constants, readFileSync, statSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root=process.env.PIAB_PLUGIN_ROOT || '/agent-pi/config/npm/node_modules/pi-agent-browser-native';
const target=join(root,'dist','extensions','agent-browser','lib','input-modes','script.js');
const MARKER='resolveScriptWorkerRuntime';
const IMPORT_ANCHOR='import { existsSync } from "node:fs";';
const IMPORT_REPLACEMENT='import { accessSync, constants, existsSync, statSync } from "node:fs";';
const SPAWN_ANCHOR='spawn(process.execPath, [';
const SPAWN_REPLACEMENT='spawn(resolveScriptWorkerRuntime(), [';
const RUNTIME_FUNCTION=`function resolveScriptWorkerRuntime() {
    const candidates = [
        process.env.PIAB_SCRIPT_NODE,
        "/pi/node/tool/fnm/aliases/default/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for (const candidate of candidates) {
        if (typeof candidate !== "string" || !candidate.startsWith("/")) continue;
        try {
            if (statSync(candidate).isFile()) {
                accessSync(candidate, constants.X_OK);
                return candidate;
            }
        }
        catch { }
    }
    // A single-executable-application host points process.execPath at its own binary, which is not Node.
    return process.execPath;
}
`;
let source=readFileSync(target,'utf8');
if(source.includes(MARKER)){console.log(`already patched: ${target}`);process.exit(0);}
for(const [anchor,label] of [[IMPORT_ANCHOR,'node:fs import'],[SPAWN_ANCHOR,'worker spawn']]) {
  if(!source.includes(anchor)){console.error(`anchor missing (${label}); upstream layout changed, review before patching: ${target}`);process.exit(1);}
}
source=source.replace(IMPORT_ANCHOR,IMPORT_REPLACEMENT);
source=source.replace(SPAWN_ANCHOR,SPAWN_REPLACEMENT);
source=source.replace('function resolveScriptWorkerPath() {',RUNTIME_FUNCTION+'function resolveScriptWorkerPath() {');
writeFileSync(target,source);
try{accessSync(target,constants.W_OK);}catch{console.error(`warning: ${target} is not writable`);}
console.log(`patched: ${target}`);
