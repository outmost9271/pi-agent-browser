import { isAbsolute, join, relative, resolve, basename } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FILE_VALUE_FLAGS = new Set([
  "--config", "--profile", "--state", "--ca-cert", "--download-path", "--screenshot-dir",
  "--executable-path", "--extension", "--init-script", "--output", "--path", "--baseline", "--action-policy",
]);
// Global value options must be removed before locating the command, just as upstream does.
const VALUE_FLAGS = new Set([...FILE_VALUE_FLAGS, "--session", "--namespace", "--cdp", "--session-name", "--restore-save",
  "--restore-check-url", "--restore-check-text", "--restore-check-fn", "--proxy", "--proxy-bypass", "--headers",
  "--user-agent", "--args", "--provider", "-p", "--device", "--engine", "--color-scheme", "--model", "--idle-timeout",
  "--allowed-domains", "--confirm-actions", "--max-output", "--screenshot-quality", "--screenshot-format", "--enable",
  "--allowed-origins", "--timeout", "--quality", "--format", "--load", "--url", "--fn", "--text"]);
export interface PathMapping { hostPath: string; containerPath: string; direction: "input" | "output" | "both" }
export interface MapperContext {
  hostBase: string; hostCwd: string; containerCwd: string;
  mounts: Array<{host: string; container: string}>;
  stagingHostDir: string; stagingContainerDir: string;
  paths: Map<string, string>;
  reportedPaths: Map<string, string>;
}
export function createDefaultMapperContext(hostCwd: string, requestId = randomUUID()): MapperContext {
  if (!/^[a-zA-Z0-9-]+$/.test(requestId)) throw new Error("Invalid request ID");
  const hostBase = "/docker/agent-browser";
  return {hostBase, hostCwd: resolve(hostCwd), containerCwd: mapHostCwdToContainer(resolve(hostCwd), hostBase),
    mounts: [
      {host: `${hostBase}/data`, container: "/home/agent/.agent-browser"},
      {host: `${hostBase}/profiles`, container: "/profiles"},
      {host: `${hostBase}/downloads`, container: "/downloads"},
      {host: `${hostBase}/screenshots`, container: "/screenshots"},
      {host: `${hostBase}/config/agent-browser.json`, container: "/etc/agent-browser/config.json"},
    ], stagingHostDir: `${hostBase}/.cache/staging/${requestId}`, stagingContainerDir: `/tmp/piab-staging/${requestId}`, paths: new Map(), reportedPaths: new Map()};
}
export function mapHostCwdToContainer(cwd: string, base: string): string {
  for (const [name, target] of [["data", "/home/agent/.agent-browser"], ["profiles", "/profiles"], ["downloads", "/downloads"], ["screenshots", "/screenshots"]]) {
    const root = join(base, name!);
    if (cwd === root || cwd.startsWith(root + "/")) return join(target!, relative(root, cwd));
  }
  return "/tmp/piab-workspace";
}
export function hostToContainerPath(path: string, ctx: MapperContext): string {
  const abs = resolve(ctx.hostCwd, path);
  for (const m of ctx.mounts) if (abs === m.host || abs.startsWith(m.host + "/")) return join(m.container, relative(m.host, abs));
  if (!ctx.paths.has(abs)) ctx.paths.set(abs, join(ctx.stagingContainerDir, createHash("sha256").update(abs).digest("hex").slice(0, 20), basename(abs) || "root"));
  const target = ctx.paths.get(abs)!;
  ctx.reportedPaths.set(target, abs);
  return target;
}
export function containerToHostPath(path: string, ctx: MapperContext): string | null {
  for (const [container, host] of ctx.reportedPaths) if (path === container || path.startsWith(container + "/")) return join(host, relative(container, path));
  for (const m of ctx.mounts) if (path === m.container || path.startsWith(m.container + "/")) return join(m.host, relative(m.container, path));
  return null;
}
export interface MappedArgs { mappedArgv: string[]; inputFiles: string[]; outputFiles: string[]; directoryFiles: string[]; deferredFiles: string[] }

export function commandTokens(argv: string[]): Array<{value: string; index: number}> {
  const out: Array<{value: string; index: number}> = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("-")) { if (!token.includes("=") && VALUE_FLAGS.has(token)) i++; continue; }
    out.push({value: token, index: i});
  }
  return out;
}

export function mapArgvPaths(argv: string[], ctx: MapperContext): MappedArgs {
  const result: MappedArgs = {mappedArgv: [...argv], inputFiles: [], outputFiles: [], directoryFiles: [], deferredFiles: []};
  const tokens = commandTokens(argv);
  const command = tokens[0]?.value;
  const commandIndex = tokens[0]?.index ?? -1;
  const sub = tokens[1]?.value;
  const positions = tokens.slice(1);
  const map = (index: number, direction: "input" | "output" | "directory" | "deferred", value = argv[index]!, flag?: string) => {
    if (!value) throw new Error("Empty file path");
    const mapped = hostToContainerPath(value, ctx);
    result.mappedArgv[index] = flag ? `${flag}=${mapped}` : mapped;
    result[direction === "input" ? "inputFiles" : direction === "output" ? "outputFiles" : direction === "deferred" ? "deferredFiles" : "directoryFiles"].push(value);
  };
  // Raw batch rows use upstream's command-string tokenizer, not a JSON argument.
  if (command === "batch") {
    for (let i = commandIndex + 1; i < argv.length; i++) {
      if (argv[i] === "--bail") continue;
      const row = mapArgvPaths(tokenizeCommand(argv[i]!), ctx);
      result.mappedArgv[i] = row.mappedArgv.map(quoteToken).join(" ");
      mergeFiles(result, row);
    }
    return result;
  }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-")) continue;
    const eq = token.indexOf("="); const flag = eq < 0 ? token : token.slice(0, eq);
    if (!FILE_VALUE_FLAGS.has(flag)) { if (eq < 0 && VALUE_FLAGS.has(flag)) i++; continue; }
    const index = eq < 0 ? ++i : i;
    const value = eq < 0 ? argv[index] : token.slice(eq + 1);
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    const direction = ["--output", "--path"].includes(flag) ? "output" : ["--download-path", "--screenshot-dir", "--profile"].includes(flag) ? "directory" : "input";
    // Profiles have lifetime beyond one invocation; require an explicit persistent bind mount.
    if (flag === "--profile" && !ctx.mounts.some(m => resolve(ctx.hostCwd, value) === m.host || resolve(ctx.hostCwd, value).startsWith(m.host + "/")))
      throw new Error("--profile must use /docker/agent-browser/profiles (persistent shared storage)");
    if (flag === "--executable-path" || flag === "--extension") throw new Error(`${flag} cannot be staged safely; configure the container image instead`);
    map(index, direction, value, eq < 0 ? undefined : flag);
  }
  const apply = (pos: number, direction: "input" | "output" | "deferred") => { const p = positions[pos]; if (p) map(p.index, direction); };
  if (command === "upload") { for (let p = 1; p < positions.length; p++) apply(p, "input"); }
  else if (command === "download") apply(1, "output");
  else if (command === "pdf") apply(0, "output");
  else if (command === "screenshot") {
    // Native: selector prefixes consume first operand; otherwise extension/slash detects a destination.
    const first = positions[0]?.value;
    const selector = first && !first.startsWith("./") && !first.startsWith("../") && /^[.#@]/.test(first);
    if (positions[1]) apply(1, "output");
    else if (!selector && first && (/\.(png|jpg|jpeg|webp)$/.test(first) || first.includes("/"))) apply(0, "output");
  } else if (command === "state" && ["save", "load"].includes(sub || "")) apply(1, sub === "save" ? "output" : "input");
  else if (command === "cookies" && sub === "import") apply(1, "input");
  else if (["trace", "profiler"].includes(command || "") && sub === "stop") apply(1, "output");
  else if (command === "record" && ["start", "restart"].includes(sub || "")) apply(1, "deferred");
  else if (command === "wait") {
    // Native prioritizes URL/load/fn/text modes over download.
    if (!["--url", "--load", "--fn", "--text"].some(f => argv.includes(f))) {
      const i = argv.findIndex(a => a === "--download" || a === "-d");
      if (i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("-")) map(i + 1, "output");
    }
  }
  if (["open", "goto", "navigate"].includes(command || "")) {
    const p = positions[0];
    if (p?.value.startsWith("file://")) {
      const url = new URL(p.value); const file = fileURLToPath(url);
      const mapped = pathToFileURL(hostToContainerPath(file, ctx)); mapped.search = url.search; mapped.hash = url.hash;
      result.mappedArgv[p.index] = mapped.href; result.inputFiles.push(file);
    }
  }
  return result;
}
function mergeFiles(target: MappedArgs, source: MappedArgs) {
  for (const key of ["inputFiles", "outputFiles", "directoryFiles", "deferredFiles"] as const) target[key].push(...source[key]);
}
export function rewriteBatchJson(batchJson: string, ctx: MapperContext): MappedArgs & {json: string} {
  const rows: unknown = JSON.parse(batchJson);
  if (!Array.isArray(rows) || !rows.every(row => Array.isArray(row) && row.every(t => typeof t === "string"))) throw new Error("batch stdin must be a JSON array of token arrays");
  const result: MappedArgs = {mappedArgv: [], inputFiles: [], outputFiles: [], directoryFiles: [], deferredFiles: []};
  const mapped = rows.map(row => { const r = mapArgvPaths(row, ctx); mergeFiles(result, r); return r.mappedArgv; });
  return {...result, json: JSON.stringify(mapped)};
}
export function tokenizeCommand(text: string): string[] {
  const tokens: string[] = []; let token = ""; let quote = ""; let escaped = false; let started = false;
  for (const c of text) {
    if (escaped) { token += c; escaped = false; started = true; }
    else if (c === "\\" && quote !== "'") { escaped = true; started = true; }
    else if (quote) { if (c === quote) quote = ""; else token += c; }
    else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === " ") { if (started) { tokens.push(token); token = ""; started = false; } }
    else { token += c; started = true; }
  }
  if (quote || escaped) throw new Error("Unterminated batch command quote/escape");
  if (started) tokens.push(token);
  return tokens;
}
function quoteToken(token: string): string { return '"' + token.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"'; }
