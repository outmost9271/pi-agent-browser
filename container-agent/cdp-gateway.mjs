#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { findChromeBinary, rewriteDiscovery } from "./gateway-utils.mjs";

const INTERNAL_PORT = parseInt(process.env.PIAB_CDP_INTERNAL_PORT || "9223", 10);
const INTERNAL_HOST = "127.0.0.1";
const GATEWAY_PORT = parseInt(process.env.PIAB_CDP_GATEWAY_PORT || "9222", 10);
const GATEWAY_HOST = process.env.PIAB_CDP_GATEWAY_HOST || "0.0.0.0";
const GATEWAY_ADVERTISED_HOST = "127.0.0.1";
const CHROME_BIN = process.env.CHROME_BIN;
const USER_DATA_DIR = process.env.PIAB_CDP_USER_DATA || "/tmp/cdp-gateway-profile";
const DEBUG = process.env.PIAB_DEBUG === "1";

function log(...args) {
  if (DEBUG) console.error("[cdp-gateway]", ...args);
}
function info(...args) {
  console.error("[cdp-gateway]", ...args);
}

let chromeProcess = null;
let internalWsUrl = null;
let gatewayServer = null;

async function findChrome() {
  return findChromeBinary(CHROME_BIN);
}

async function tryFetchExistingChrome() {
  try {
    const res = await fetch(`http://${INTERNAL_HOST}:${INTERNAL_PORT}/json/version`, {signal: AbortSignal.timeout(3000)});
    if (res.ok) {
      const data = await res.json();
      if (data.webSocketDebuggerUrl) {
        internalWsUrl = data.webSocketDebuggerUrl;
        info(`Reusing existing Chrome at ${INTERNAL_HOST}:${INTERNAL_PORT} ws=${internalWsUrl}`);
        return true;
      }
    }
  } catch {}
  return false;
}

function launchChrome() {
  return new Promise(async (resolve, reject) => {
    // First, try to reuse existing
    if (await tryFetchExistingChrome()) {
      resolve(null);
      return;
    }
    // Clean up stale SingletonLock if present but no Chrome running
    try {
      const lockPath = `${USER_DATA_DIR}/SingletonLock`;
      if (existsSync(lockPath)) {
        // Check if Chrome is not running (we already tried fetch and it failed)
        rmSync(lockPath, { force: true });
        info(`Removed stale SingletonLock at ${lockPath}`);
      }
    } catch {}

    const bin = await findChrome();
    if (!bin) {
      reject(new Error(`Chrome binary not found at ${CHROME_BIN}`));
      return;
    }
    const args = [
      `--remote-debugging-port=${INTERNAL_PORT}`,
      `--remote-debugging-address=${INTERNAL_HOST}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--headless=new",
      "--window-size=1280,720",
      "--hide-scrollbars",
      ...(process.env.PIAB_REQUIRE_SANDBOX === "1" ? [] : ["--no-sandbox"]),
    ];
    if (process.env.PIAB_REQUIRE_SANDBOX === "1") {
      const forbidden = ["--no-sandbox", "--disable-setuid-sandbox", "--disable-namespace-sandbox", "--disable-seccomp-filter-sandbox", "--disable-gpu-sandbox", "--single-process", "--no-zygote"];
      for (const f of forbidden) {
        if (args.includes(f)) {
          reject(new Error(`PIAB_REQUIRE_SANDBOX conflicts with ${f}`));
          return;
        }
      }
    }

    info(`Launching chrome: ${bin} ${args.join(" ")}`);
    try { mkdirSync(USER_DATA_DIR, { recursive: true }); } catch {}
    const proc = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    chromeProcess = proc;
    let stderrBuf = "";
    let resolved = false;

    proc.stderr.on("data", (d) => {
      const s = d.toString();
      stderrBuf += s;
      log("chrome stderr:", s.trim());
      const match = stderrBuf.match(/ws:\/\/[^\s]+/);
      if (match && !resolved) {
        internalWsUrl = match[0];
        info(`Discovered internal WS URL: ${internalWsUrl}`);
        resolved = true;
        resolve(proc);
      }
    });
    proc.stdout.on("data", (d) => log("chrome stdout:", d.toString().trim()));
    proc.on("error", (e) => {
      if (!resolved) reject(e);
    });
    proc.on("exit", (code, sig) => {
      info(`Chrome exited code=${code} sig=${sig}`);
      chromeProcess = null;
      if (!resolved) reject(new Error(`Chrome exited prematurely code=${code} stderr=${stderrBuf.slice(0,2000)}`));
      else {
        if (!shuttingDown) {
          info("Restarting chrome in 2s...");
          setTimeout(() => launchChrome().catch(e => info("Restart failed:", e)), 2000);
        }
      }
    });
    setTimeout(() => {
      if (!resolved) reject(new Error(`Timeout waiting for Chrome DevTools URL, stderr=${stderrBuf.slice(0, 2000)}`));
    }, 15000);
  });
}

let shuttingDown = false;

async function proxyJsonRequest(req, res, path) {
  const targetUrl = `http://${INTERNAL_HOST}:${INTERNAL_PORT}${path}`;
  log(`Proxying ${req.method} ${path} -> ${targetUrl}`);
  try {
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: { "Host": `${INTERNAL_HOST}:${INTERNAL_PORT}` },
      signal: AbortSignal.timeout(10000),
    });
    const body = await upstream.text();
    const rewritten = rewriteDiscovery(body, INTERNAL_PORT, GATEWAY_PORT, GATEWAY_ADVERTISED_HOST);
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") || "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(rewritten);
  } catch (e) {
    log("Proxy error:", e);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
  }
}

function startGateway() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${GATEWAY_ADVERTISED_HOST}:${GATEWAY_PORT}`);
    const path = url.pathname + url.search;
    log(`${req.method} ${path}`);
    if (path.startsWith("/json/") || path === "/json" || path === "/json/list" || path === "/json/version") {
      await proxyJsonRequest(req, res, path);
      return;
    }
    if (path === "/json/new") {
      const targetUrl = `http://${INTERNAL_HOST}:${INTERNAL_PORT}/json/new${url.search}`;
      try {
        const upstream = await fetch(targetUrl, { method: req.method });
        const body = await upstream.text();
        let rewritten = body.replaceAll(`ws://${INTERNAL_HOST}:${INTERNAL_PORT}`, `ws://${GATEWAY_ADVERTISED_HOST}:${GATEWAY_PORT}`);
        rewritten = rewritten.replaceAll(`:${INTERNAL_PORT}`, `:${GATEWAY_PORT}`);
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") || "application/json" });
        res.end(rewritten);
      } catch (e) {
        if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: String(e) })); }
      }
      return;
    }
    await proxyJsonRequest(req, res, path);
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${GATEWAY_ADVERTISED_HOST}:${GATEWAY_PORT}`);
    let targetPath = url.pathname + url.search;
    const targetUrl = `ws://${INTERNAL_HOST}:${INTERNAL_PORT}${targetPath}`;
    log(`WebSocket upgrade ${req.url} -> ${targetUrl}`);

    // Create upstream WebSocket with error handling to not crash gateway
    let upstreamWs;
    try {
      upstreamWs = new WebSocket(targetUrl);
    } catch (e) {
      log("Failed to create upstream WS:", e);
      socket.destroy();
      return;
    }
    let clientWs = null;
    const pendingClientMessages = [];
    const pendingUpstreamMessages = [];

    upstreamWs.on("open", () => {
      log(`Upstream WS open ${targetUrl}, flushing ${pendingClientMessages.length} pending`);
      for (const {data, isBinary} of pendingClientMessages.splice(0)) {
        log(`Flushing pending Client -> Upstream ${data.toString().slice(0,100)}`);
        try { upstreamWs.send(data, { binary: isBinary }); } catch (e) { log("Flush send error", e); }
      }
    });
    upstreamWs.on("message", (data, isBinary) => {
      log(`Upstream -> Client message ${data.toString().slice(0,200)}`);
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        try { clientWs.send(data, { binary: isBinary }); } catch (e) { log("Client send error", e); }
      } else {
        pendingUpstreamMessages.push({ data, isBinary });
      }
    });
    upstreamWs.on("close", (code, reason) => {
      log("Upstream WS close", code);
      if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        if (code === 1006 || code === 1005) clientWs.terminate();
        else try { clientWs.close(code, reason); } catch { clientWs.terminate(); }
      }
    });
    upstreamWs.on("error", (e) => {
      log("Upstream WS error", e);
      if (clientWs && clientWs.readyState === WebSocket.OPEN) try { clientWs.close(1011, String(e)); } catch {}
      else try { socket.destroy(); } catch {}
    });

    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(req, socket, head, (ws) => {
      clientWs = ws;
      log("Client WS open", req.url);
      for (const { data, isBinary } of pendingUpstreamMessages.splice(0)) try { ws.send(data, { binary: isBinary }); } catch {}
      ws.on("message", (data, isBinary) => {
        const txt = data.toString().slice(0,200);
        log(`Client -> Upstream message ${txt} binary=${isBinary} upstream=${upstreamWs.readyState}`);
        if (upstreamWs.readyState === WebSocket.OPEN) {
          try { upstreamWs.send(data, { binary: isBinary }); } catch (e) { log("Upstream send error", e); }
        } else {
          pendingClientMessages.push({data, isBinary});
          log(`Buffered, now ${pendingClientMessages.length} pending`);
        }
      });
      ws.on("close", (code, reason) => {
        log("Client WS close", code);
        if (upstreamWs.readyState === WebSocket.CONNECTING || code === 1006 || code === 1005) upstreamWs.terminate();
        else if (upstreamWs.readyState === WebSocket.OPEN) try { upstreamWs.close(code, reason); } catch { upstreamWs.terminate(); }
      });
      ws.on("error", (e) => {
        log("Client WS error", e);
        try { upstreamWs.close(1011, String(e)); } catch {}
      });
    });

    // Handle upgrade errors
    wss.on("error", (e) => log("WSS error:", e));
  });

  server.listen(GATEWAY_PORT, GATEWAY_HOST, () => {
    info(`listening on ${GATEWAY_HOST}:${GATEWAY_PORT} -> internal ${INTERNAL_HOST}:${INTERNAL_PORT} ws=${internalWsUrl}`);
  });
  server.on("error", (e) => {
    info(`Gateway server error: ${e}`);
    process.exit(1);
  });
  gatewayServer = server;
  return server;
}

async function main() {
  try { mkdirSync(USER_DATA_DIR, { recursive: true }); } catch {}
  try {
    await launchChrome();
  } catch (e) {
    info("failed to launch chrome:", e);
    // If we failed but existing chrome might still be there, try to start gateway anyway if we can fetch
    if (await tryFetchExistingChrome()) {
      info("Using existing Chrome despite launch failure");
    } else {
      process.exit(1);
    }
  }
  startGateway();
}

process.on("SIGTERM", () => {
  shuttingDown = true;
  info("SIGTERM, shutting down");
  if (chromeProcess) try { chromeProcess.kill("SIGTERM"); } catch {}
  if (gatewayServer) gatewayServer.close();
  setTimeout(() => process.exit(0), 2000);
});
process.on("SIGINT", () => {
  shuttingDown = true;
  if (chromeProcess) try { chromeProcess.kill("SIGTERM"); } catch {}
  if (gatewayServer) gatewayServer.close();
  setTimeout(() => process.exit(0), 2000);
});
process.on("uncaughtException", (e) => { info("uncaughtException", e); });
process.on("unhandledRejection", (e) => { info("unhandledRejection", e); });

main().catch((e) => {
  info("fatal", e);
  process.exit(1);
});
