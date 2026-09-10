import { buildContainerEnv } from "./dist/env.js";

const hostEnv = {
  AGENT_BROWSER_PROFILE: "/profiles/default",
  AGENT_BROWSER_CDP: "http://127.0.0.1:9222",
  AGENT_BROWSER_STATE: "/tmp/state.json",
  AGENT_BROWSER_PROXY: "http://proxy.example.com:8080",
  AGENT_BROWSER_CONFIG: "/etc/agent-browser/config.json",
  HOME: "/root",
  PIAB_REQUIRE_SANDBOX: "1",
};

console.log("=== normal 模式 ===");
const normal = buildContainerEnv({ hostEnv, mode: "normal" });
console.log("profile:", normal.AGENT_BROWSER_PROFILE);
console.log("cdp:", normal.AGENT_BROWSER_CDP);
console.log("state:", normal.AGENT_BROWSER_STATE);
console.log("proxy:", normal.AGENT_BROWSER_PROXY);
console.log("config:", normal.AGENT_BROWSER_CONFIG);

console.log("\n=== script 隔离模式 ===");
const script = buildContainerEnv({ hostEnv, mode: "script" });
console.log("profile:", script.AGENT_BROWSER_PROFILE);
console.log("cdp:", script.AGENT_BROWSER_CDP);
console.log("state:", script.AGENT_BROWSER_STATE);
console.log("proxy:", script.AGENT_BROWSER_PROXY);
console.log("config:", script.AGENT_BROWSER_CONFIG);
console.log("namespace:", script.AGENT_BROWSER_NAMESPACE);

console.log("\n=== 验证 ===");
const checks = [
  ["script 模式应清除 profile", script.AGENT_BROWSER_PROFILE === ""],
  ["script 模式应清除 cdp", script.AGENT_BROWSER_CDP === ""],
  ["script 模式应清除 state", script.AGENT_BROWSER_STATE === ""],
  ["script 模式应清除 proxy", script.AGENT_BROWSER_PROXY === ""],
  ["script 模式应保留 config", script.AGENT_BROWSER_CONFIG === "/etc/agent-browser/config.json"],
  ["normal 模式应保留 profile", normal.AGENT_BROWSER_PROFILE === "/profiles/default"],
  ["normal 模式应保留 cdp", normal.AGENT_BROWSER_CDP === "http://127.0.0.1:9222"],
];

let ok = true;
for (const [msg, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${msg}`);
  if (!pass) ok = false;
}
console.log(ok ? "\n全部通过" : "\n有失败");
process.exit(ok ? 0 : 1);
