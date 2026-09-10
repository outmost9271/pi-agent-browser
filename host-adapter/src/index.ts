#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, statSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { resolve, join, dirname, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createDefaultMapperContext, mapArgvPaths, rewriteBatchJson, hostToContainerPath, commandTokens, tokenizeCommand, type MappedArgs } from "./path-mapper.js";
import { buildContainerEnv, envToDockerArgs } from "./env.js";
import { rewriteResult } from "./result-mapper.js";
import { CANCEL_DAEMON_SCRIPT, CANCEL_SESSION_SCRIPT, sanitizeNamespace } from "./cancellation.js";

const BASE = "/docker/agent-browser";
const MAX_BYTES = 64 * 1024 * 1024;
let cancelled = false;
let deadline = Infinity;
let releaseSessionLock: (() => void) | undefined;
async function lockSession(path: string) {
  mkdirSync(dirname(path), {recursive: true, mode: 0o700});
  while (true) {
    try { mkdirSync(path, {mode: 0o700}); writeFileSync(join(path, 'pid'), String(process.pid)); releaseSessionLock = () => rmSync(path, {recursive: true, force: true}); return; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try { const pid = Number(readFileSync(join(path, 'pid'), 'utf8')); if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid session lock'); try { process.kill(pid, 0); } catch (e) { stale = (e as NodeJS.ErrnoException).code === 'ESRCH'; } }
      catch { stale = Date.now() - statSync(path).mtimeMs > 5000; }
      if (stale) { rmSync(path, {recursive: true, force: true}); continue; }
      if (cancelled || Date.now() >= deadline) throw new Error('Session lock deadline exceeded');
      await new Promise(r => setTimeout(r, 50));
    }
  }
}
const active = new Set<ReturnType<typeof spawn>>();
const onSignal = () => { cancelled = true; for (const child of active) child.kill("SIGTERM"); };
process.on("SIGTERM", onSignal); process.on("SIGINT", onSignal);

async function run(args: string[], input?: Buffer, cleanup = false, limit?: number, outputFile?: string): Promise<{code: number; stdout: Buffer; stderr: Buffer}> {
  if (!cleanup && (cancelled || Date.now() >= deadline)) throw new Error(cancelled ? "Request cancelled" : "Request deadline exceeded");
  const remaining = cleanup ? 8000 : Math.max(1, deadline - Date.now());
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, {stdio: ["pipe", "pipe", "pipe"]}); active.add(child);
    const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0; let failure: Error | undefined;
    const kill = (message: string) => { failure ??= new Error(message); child.kill("SIGTERM"); };
    const timer = setTimeout(() => kill("Request deadline exceeded"), Math.min(remaining, limit ?? remaining));
    let forceTimer: NodeJS.Timeout | undefined;
    child.on("exit", () => { if (forceTimer) clearTimeout(forceTimer); });
    const escalation = setInterval(() => { if (failure || (!cleanup && cancelled)) { if (!forceTimer) forceTimer = setTimeout(() => child.kill("SIGKILL"), 500); } }, 50);
    const collect = (target: Buffer[], data: Buffer) => { bytes += data.length; if (bytes > MAX_BYTES) kill("Process output exceeds 64 MiB"); else target.push(data); };
    let outputFinished: Promise<void> = Promise.resolve();
    if (outputFile) {
      const sink = createWriteStream(outputFile, {flags: 'wx', mode: 0o600});
      outputFinished = finished(sink).catch(error => { failure = error; child.kill('SIGTERM'); });
      child.stdout.pipe(sink);
    } else child.stdout.on("data", d => collect(stdout, d));
    child.stderr.on("data", d => collect(stderr, d));
    child.stdin.on("error", e => { if ((e as NodeJS.ErrnoException).code !== "EPIPE") kill(String(e)); });
    child.on("error", e => { failure = e; });
    child.on("close", async code => {
      await outputFinished;
      clearTimeout(timer); clearInterval(escalation); if (forceTimer) clearTimeout(forceTimer); active.delete(child);
      if (failure || (!cleanup && cancelled)) reject(failure ?? new Error("Request cancelled"));
      else resolvePromise({code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr)});
    });
    child.stdin.end(input);
  });
}
async function checked(args: string[], input?: Buffer, cleanup = false) {
  const result = await run(args, input, cleanup);
  if (result.code !== 0) throw new Error(`docker ${args[0]} failed (${result.code}): ${result.stderr.toString().slice(0, 1500)}`);
  return result;
}
function flagValue(argv: string[], name: string, fallback = ""): string {
  let value = fallback;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === name) value = argv[++i] ?? ""; else if (argv[i]?.startsWith(name + "=")) value = argv[i]!.slice(name.length + 1); }
  return value;
}
async function main() {
  const raw = process.argv.slice(2); const argv: string[] = [];
  let cwd = process.cwd(); let outputPath: string | undefined = process.env.PIAB_OUTPUT_PATH;
  let mode: "normal" | "script" | "cdp" = process.env.PIAB_MODE === "script" ? "script" : "normal";
  // Internal options are accepted only as a leading prefix, never removed from literal page data.
  let i = 0;
  while (raw[i]?.startsWith("--host-adapter-")) {
    const option = raw[i++]!; const value = raw[i++]; if (value === undefined) throw new Error(`Missing ${option} value`);
    if (option === "--host-adapter-cwd") cwd = resolve(value);
    else if (option === "--host-adapter-outputPath") outputPath = value;
    else if (option === "--host-adapter-mode" && ["normal", "script", "cdp"].includes(value)) mode = value as typeof mode;
    else throw new Error(`Unknown adapter option: ${option}`);
  }
  argv.push(...raw.slice(i));
  const timeout = Number(process.env.PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS || 120000);
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid process timeout");
  deadline = Date.now() + timeout;
  const requestId = randomUUID(); const ctx = createDefaultMapperContext(cwd, requestId);
  const container = process.env.PIAB_CONTAINER || "pi-agent-browser";
  let stdin = Buffer.alloc(0);
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []; let size = 0;
    const timer = setTimeout(() => process.stdin.destroy(new Error("stdin deadline exceeded")), Math.max(1, deadline - Date.now()));
    try { for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_BYTES) throw new Error("stdin exceeds 64 MiB"); chunks.push(Buffer.from(chunk)); } }
    finally { clearTimeout(timer); }
    stdin = Buffer.concat(chunks);
  }
  const mapped = mapArgvPaths(argv, ctx);
  const tokens = commandTokens(argv); const cmd = tokens[0]?.value;
  const rawRows = cmd === "batch" ? argv.slice((tokens[0]?.index ?? 0) + 1).filter(t => t !== "--bail") : [];
  let rows = cmd === "batch" && rawRows.length ? rawRows.map(tokenizeCommand) : [argv];
  if (cmd === "batch" && !rawRows.length) {
    rows = JSON.parse(stdin.toString());
    const batch = rewriteBatchJson(stdin.toString(), ctx); stdin = Buffer.from(batch.json);
    for (const key of ["inputFiles", "outputFiles", "directoryFiles", "deferredFiles"] as const) mapped[key].push(...batch[key]);
  }
  let hasGeneratedInputs = false;
  if (cmd === 'batch') {
    const produced = new Set<string>(); const generatedInputs = new Set<string>(); const required = new Set<string>();
    for (const row of rows) {
      const plan = mapArgvPaths(row, ctx);
      for (const input of plan.inputFiles) { const abs = resolve(cwd, input); (produced.has(abs) ? generatedInputs : required).add(abs); }
      for (const output of plan.outputFiles) produced.add(resolve(cwd, output));
    }
    hasGeneratedInputs = generatedInputs.size > 0;
    mapped.inputFiles = mapped.inputFiles.filter(p => !generatedInputs.has(resolve(cwd, p)) || required.has(resolve(cwd, p)));
  }
  const hostEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) hostEnv[key] = value;
  const env = buildContainerEnv({hostEnv, mode});
  const envPaths: Record<string, string> = { AGENT_BROWSER_CONFIG: "--config", AGENT_BROWSER_PROFILE: "--profile", AGENT_BROWSER_STATE: "--state", AGENT_BROWSER_CA_CERT: "--ca-cert", AGENT_BROWSER_ACTION_POLICY: "--action-policy", AGENT_BROWSER_DOWNLOAD_PATH: "--download-path", AGENT_BROWSER_SCREENSHOT_DIR: "--screenshot-dir", AGENT_BROWSER_EXECUTABLE_PATH: "--executable-path" };
  for (const [key, flag] of Object.entries(envPaths)) {
    if (!hostEnv[key] || !env[key]) continue;
    const pathArgs = mapArgvPaths([flag, env[key]!, "open", "about:blank"], ctx);
    env[key] = pathArgs.mappedArgv[1]!;
    for (const field of ["inputFiles", "outputFiles", "directoryFiles", "deferredFiles"] as const) mapped[field].push(...pathArgs[field]);
  }
  // Socket directories are runtime IPC, not files to copy. Stable short container-local names preserve identity across calls.
  if (hostEnv.AGENT_BROWSER_SOCKET_DIR) env.AGENT_BROWSER_SOCKET_DIR = `/tmp/piab-s-${createHash("sha256").update(resolve(cwd, hostEnv.AGENT_BROWSER_SOCKET_DIR)).digest("hex").slice(0, 16)}`;
  delete env.PI_AGENT_BROWSER_SOCKET_DIR;
  // No preflight docker round trip: a stopped container surfaces through the exec below, and the
  // adapter must never silently start or replace a production container.
  const exec = ["exec", "-i", ...envToDockerArgs(env), container];
  const mkdir = async (...paths: string[]) => { await checked(["exec", container, "mkdir", "-p", ...paths]); };
  const shared = (path: string) => ctx.mounts.some(m => resolve(cwd, path) === m.host || resolve(cwd, path).startsWith(m.host + "/"));
  async function stage(host: string, target: string): Promise<void> {
    const st = lstatSync(host); // Missing inputs fail before browser execution.
    if (st.isSymbolicLink()) throw new Error(`Input symlinks are not supported: ${host}`);
    if (st.isDirectory()) { await mkdir(target); for (const file of readdirSync(host)) await stage(join(host, file), join(target, file)); }
    else if (st.isFile()) { await mkdir(dirname(target)); await checked(["exec", "-i", container, "sh", "-c", 'umask 077; cat > "$1"', "piab-stage", target], readFileSync(host)); }
    else throw new Error(`Input must be a regular file or directory: ${host}`);
  }
  async function retrieve(host: string, target: string) {
    const abs = resolve(cwd, host);
    if (!shared(host)) {
      mkdirSync(dirname(abs), {recursive: true}); const temp = `${abs}.piab-${requestId}`;
      try {
        // Docker's archive API cannot read all tmpfs mounts; stream from the running mount namespace instead.
        const copied = await run(['exec', container, 'cat', '--', target], undefined, false, undefined, temp);
        if (copied.code !== 0) throw new Error(`Output transfer failed for ${host}: ${copied.stderr.toString()}`);
        if (!statSync(temp).isFile()) throw new Error(`Output is not a file: ${host}`);
        renameSync(temp, abs);
      }
      finally { rmSync(temp, {force: true}); }
    }
    const st = statSync(abs); if (!st.isFile() || st.size === 0) throw new Error(`Missing or empty output: ${abs}`);
  }
  const namespace = sanitizeNamespace(flagValue(argv, "--namespace", env.AGENT_BROWSER_NAMESPACE || ""));
  const session = flagValue(argv, "--session", env.AGENT_BROWSER_SESSION || "default");
  const identity = createHash("sha256").update(JSON.stringify([container, env.AGENT_BROWSER_SOCKET_DIR, namespace, session])).digest("hex");
  await lockSession(join(BASE, '.cache', 'adapter-locks', identity));
  const assetsFile = join(BASE, '.cache', 'adapter-sessions', identity + '.json');
  let assets: string[] = existsSync(assetsFile) ? JSON.parse(readFileSync(assetsFile, 'utf8')) : [];
  const validStaging = (path: string) => /^\/tmp\/piab-staging\/[a-f0-9-]{36}$/.test(path);
  if (!Array.isArray(assets) || assets.some(p => !validStaging(p))) throw new Error('Invalid session asset journal');
  const saveAssets = () => { mkdirSync(dirname(assetsFile), {recursive: true, mode: 0o700}); const temp = assetsFile + '.' + requestId; writeFileSync(temp, JSON.stringify(assets), {mode: 0o600}); renameSync(temp, assetsFile); };
  const hasStagedInputs = hasGeneratedInputs || mapped.inputFiles.some(path => !shared(path));
  const retainSessionAssets = hasStagedInputs || mapped.deferredFiles.length > 0;
  if (assets.length >= 256 && retainSessionAssets) throw new Error('Session staging budget reached; close this session before continuing');
  const journalDir = join(BASE, ".cache", "recordings"); const journal = join(journalDir, identity + ".json");
  type Recording = {host: string; container: string; staging: string};
  let recording: Recording | undefined = existsSync(journal) ? JSON.parse(readFileSync(journal, "utf8")) : undefined;
  if (recording) {
    const sharedRecording = shared(recording.host) && hostToContainerPath(recording.host, ctx) === recording.container;
    if (!validStaging(recording.staging) || (!sharedRecording && !recording.container.startsWith(recording.staging + '/'))) throw new Error('Invalid recording journal');
    ctx.reportedPaths.set(recording.container, recording.host);
  }
  const deferred = mapped.deferredFiles.map(host => ({host: resolve(cwd, host), container: hostToContainerPath(host, ctx), staging: ctx.stagingContainerDir}));
  const recordActions = rows.map(row => commandTokens(row).map(t => t.value)).filter(t => t[0] === "record").map(t => t[1]);
  // Mixing recording lifecycle with continue-on-error makes completion unknowable; require separate calls or fail-fast batches.
  if (cmd === "batch" && recordActions.length && !argv.includes("--bail")) throw new Error("Recording batches require --bail");
  if (outputPath && [...mapped.inputFiles, ...mapped.outputFiles, ...mapped.deferredFiles].some(p => resolve(cwd, p) === resolve(cwd, outputPath!))) throw new Error("outputPath conflicts with browser artifact");
  let launched = false; let keepStaging = false; let success = false; let cancellationHandled = false;
  const lease = `/tmp/piab-request-${requestId}`;
  let upstreamResult: Awaited<ReturnType<typeof run>> | undefined;
  try {
    // One mkdir round trip for the working directory, the socket directory and every output directory.
    const ensureDirs = new Set<string>([ctx.containerCwd, env.AGENT_BROWSER_SOCKET_DIR!]);
    for (const path of new Set(mapped.inputFiles)) { if (!existsSync(resolve(cwd, path))) throw new Error(`Input does not exist: ${path}`); if (!shared(path)) await stage(resolve(cwd, path), hostToContainerPath(path, ctx)); }
    for (const path of new Set([...mapped.outputFiles, ...mapped.deferredFiles])) ensureDirs.add(dirname(hostToContainerPath(path, ctx)));
    for (const path of new Set(mapped.directoryFiles)) {
      if (!shared(path)) throw new Error(`Persistent output directory must be a bind-mounted host path: ${path}`);
      ensureDirs.add(hostToContainerPath(path, ctx));
    }
    await mkdir(...ensureDirs);
    // The container PID is recorded before exec, in its own process group. It remains addressable if docker exec is killed.
    if (retainSessionAssets) { assets.push(ctx.stagingContainerDir); saveAssets(); keepStaging = true; }
    launched = true;
    // setsid forks when docker exec already made it a process-group leader. --wait is
    // mandatory: otherwise its parent exits zero before the actual browser command finishes.
    const result = await run([...exec, "setsid", "--wait", "sh", "-c", 'umask 077; cd "$1" || { echo "cannot enter working directory: $1" >&2; exit 71; }; echo $$ > "$2"; shift 2; exec agent-browser "$@"', "piab-request", ctx.containerCwd, lease, ...mapped.mappedArgv], stdin);
    upstreamResult = result;
    if (result.code !== 0 && /is not running|No such container|Cannot connect to the Docker daemon/.test(result.stderr.toString())) console.error(`[host-adapter] container ${container} is unavailable; start it explicitly (docker compose up -d)`);
    let upstreamSuccess = result.code === 0;
    let response: any;
    try { response = JSON.parse(result.stdout.toString()); if (response.success === false || (Array.isArray(response) && response.some(row => row.success === false))) upstreamSuccess = false; }
    catch {
      if (argv.includes('--json') && cmd !== 'upgrade') {
        upstreamSuccess = false;
        result.stdout = Buffer.from(JSON.stringify({success:false,error:'Upstream exited without a valid JSON result; command completion is unverified'}));
      }
    }
    if (upstreamSuccess || (cmd === 'batch' && Array.isArray(response))) {
      const plans = rows.filter(row => row.length).map(row => ({row, plan: mapArgvPaths(row, ctx)}));
      const completed = upstreamSuccess ? plans : response.filter((row: any) => row.success === true).flatMap((row: any) => {
        const match = plans.find(p => JSON.stringify(p.plan.mappedArgv) === JSON.stringify(row.command)); return match ? [match] : [];
      });
      const outputs = upstreamSuccess ? mapped.outputFiles : completed.flatMap((p: any) => p.plan.outputFiles);
      for (const path of new Set<string>(outputs)) await retrieve(path, hostToContainerPath(path, ctx));
      const completedActions = completed.flatMap((p: any) => { const t = commandTokens(p.row).map(t => t.value); return t[0] === 'record' ? [t[1]] : []; });
      const completedDeferred = completed.flatMap((p: any) => p.plan.deferredFiles).map((host: string) => ({host: resolve(cwd, host), container: hostToContainerPath(host, ctx), staging: ctx.stagingContainerDir}));
      let next = 0;
      for (const action of completedActions) {
        if (action === "stop" || action === "restart") {
          if (recording) { await retrieve(recording.host, recording.container); if (recording.staging !== ctx.stagingContainerDir && !assets.includes(recording.staging)) await checked(["exec", container, "rm", "-rf", "--", recording.staging], undefined, true); recording = undefined; }
        }
        if (action === "start" || action === "restart") recording = completedDeferred[next++];
      }
      if (completedActions.length) {
        mkdirSync(journalDir, {recursive: true, mode: 0o700});
        if (recording) { const temp = journal + "." + requestId; writeFileSync(temp, JSON.stringify(recording), {mode: 0o600}); renameSync(temp, journal); keepStaging ||= recording.staging === ctx.stagingContainerDir; }
        else rmSync(journal, {force: true});
      }
      const lastCommand = commandTokens(upstreamSuccess ? (rows.at(-1) || []) : (response.at(-1)?.success === true ? response.at(-1).command : [])).map(t => t.value);
      if (['close', 'quit', 'exit'].includes(lastCommand[0] || '')) {
        for (const directory of assets) await checked(['exec', container, 'rm', '-rf', '--', directory], undefined, true);
        assets = []; saveAssets(); keepStaging = false;
        if (recording) { await checked(['exec', container, 'rm', '-rf', '--', recording.staging], undefined, true); rmSync(journal, {force: true}); }
      }
      if (upstreamSuccess && outputPath) { const dest = resolve(cwd, outputPath); mkdirSync(dirname(dest), {recursive: true}); writeFileSync(dest, rewriteResult(result.stdout, ctx), {mode: 0o600}); }
      success = true;
    } else if (recordActions.length && deferred.length) {
      // A failed recording start can still have started work. Preserve evidence for manual cleanup, never delete its destination.
      keepStaging = true;
      console.error(`[host-adapter] recording batch failed; retained staging ${ctx.stagingContainerDir}`);
    }
    process.stdout.write(rewriteResult(result.stdout, ctx)); process.stderr.write(result.stderr); process.exitCode = upstreamSuccess ? result.code : (result.code || 1);
  } catch (error) {
    if (launched && (cancelled || Date.now() >= deadline)) {
      // One container round trip: stop the CLI group, try a 1s graceful close, then terminate the
      // identity-verified daemon. The plugin SIGKILLs its child 2s after SIGTERM, so a second exec
      // would not finish in time. Killing the CLI alone does not cancel work its daemon already accepted.
      try {
        if (!/^[\p{Alphabetic}\p{Number}_-]*$/u.test(session) || !/^[\p{Alphabetic}\p{Number}_-]*$/u.test(namespace)) throw new Error('Unsafe cancellation session identity');
        const socketRoot = namespace ? join(env.AGENT_BROWSER_SOCKET_DIR!, 'namespaces', namespace, 'run') : env.AGENT_BROWSER_SOCKET_DIR!;
        const cleanup = await run(['exec', ...envToDockerArgs(env), '-e', 'PIAB_KILL_JS=' + CANCEL_DAEMON_SCRIPT, container, 'sh', '-c', CANCEL_SESSION_SCRIPT, 'piab-cancel', lease, join(socketRoot, session + '.pid'), session, namespace, ctx.stagingContainerDir, ...assets], undefined, true);
        cancellationHandled = true;
        const verdict = cleanup.stdout.toString().trim();
        if (cleanup.code === 0 && verdict.includes('cleanup-complete')) { assets = []; saveAssets(); keepStaging = false; console.error('[host-adapter] cancelled session stopped; already-dispatched external actions cannot be rolled back'); }
        else { keepStaging = true; console.error(`[host-adapter] cancellation cleanup unconfirmed (exit ${cleanup.code}: ${verdict || cleanup.stderr.toString().slice(0, 300)}); do not retry mutations until the session is inspected`); }
      } catch (e) { console.error(`[host-adapter] cancellation cleanup unconfirmed (${e instanceof Error ? e.message : e}); do not retry mutations until the session is inspected`); }
    }
    if (upstreamResult) {
      let upstream: unknown; try { upstream = JSON.parse(rewriteResult(upstreamResult.stdout, ctx).toString()); } catch { upstream = upstreamResult.stdout.toString(); }
      process.stdout.write(JSON.stringify({success: false, error: String(error), data: {upstream}}) + '\n');
    }
    throw error;
  } finally {
    if (launched && !cancellationHandled) {
      // One round trip for both the request lease and (unless the session still needs it) request staging.
      await checked(["exec", container, "sh", "-c", 'if [ -f "$1" ]; then p=$(cat "$1"); case "$p" in ""|*[!0-9]*) ;; *) if [ -r /proc/$p/cmdline ] && tr "\\0" " " < /proc/$p/cmdline | grep -q agent-browser; then kill -TERM -"$p" 2>/dev/null || true; fi;; esac; rm -f "$1"; fi; if [ "$2" = drop ]; then rm -rf -- "$3"; fi', "piab-cleanup", lease, keepStaging ? "keep" : "drop", ctx.stagingContainerDir], undefined, true).catch(e => { console.error(`[host-adapter] request cleanup failed: ${e}`); if (success) process.exitCode = 1; });
    }
  }
}
main().catch(error => { console.error(`[host-adapter] ${error.stack || error}`); process.exitCode = cancelled ? 130 : Date.now() >= deadline ? 124 : 1; }).finally(() => { releaseSessionLock?.(); process.off("SIGTERM", onSignal); process.off("SIGINT", onSignal); });
