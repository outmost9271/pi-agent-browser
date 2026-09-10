#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

const DEBUG = process.env.PIAB_DEBUG === "1";
function log(...args) { if (DEBUG) console.error("[supervisor]", ...args); }

let cdpGateway = null;
let shuttingDown = false;

function startCdpGateway() {
  if (cdpGateway) return;
  log("Starting CDP gateway");
  const proc = spawn("node", ["/opt/piab/cdp-gateway.mjs"], {
    stdio: ["ignore", "inherit", "inherit"],
    env: process.env,
  });
  cdpGateway = proc;
  proc.on("exit", (code, sig) => {
    log(`CDP gateway exited code=${code} sig=${sig}`);
    cdpGateway = null;
    if (!shuttingDown) {
      setTimeout(startCdpGateway, 2000);
    }
  });
  proc.on("error", (e) => {
    console.error("[supervisor] CDP gateway spawn error", e);
    cdpGateway = null;
  });
}

function handleSignal(sig) {
  shuttingDown = true;
  log(`Received ${sig}, shutting down`);
  if (cdpGateway) {
    try { cdpGateway.kill(sig); } catch {}
  }
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));

// Ensure required dirs
try { mkdirSync("/tmp/piab-staging", { recursive: true }); } catch {}
try { mkdirSync("/home/agent/workspace", { recursive: true }); } catch {}
try { mkdirSync("/home/agent/.agent-browser/cdp-profile", { recursive: true }); } catch {}

startCdpGateway();

// Keep alive: tail /dev/null equivalent, but we also supervise
// Use interval to keep event loop alive
setInterval(() => {}, 1000000);

console.error("[supervisor] started, pid", process.pid);
