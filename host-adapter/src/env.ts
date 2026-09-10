/**
 * Explicit environment contract for container execution.
 * Only allowlisted env vars are forwarded; secrets are handled via stdin where possible.
 * This mirrors upstream 0.36.0 known env vars.
 */

export const ALLOWED_ENV_VARS = new Set([
  // Core
  "TZ",
  "AGENT_BROWSER_SOCKET_DIR",
  "AGENT_BROWSER_DEFAULT_TIMEOUT",
  "AGENT_BROWSER_IDLE_TIMEOUT_MS",
  "AGENT_BROWSER_AUTOSAVE_INTERVAL_MS",
  "AGENT_BROWSER_STATE_EXPIRE_DAYS",
  "AGENT_BROWSER_CONFIG",
  "PI_AGENT_BROWSER_SOCKET_DIR",
  "PI_AGENT_BROWSER_PROCESS_TIMEOUT_MS",
  // Browser
  "AGENT_BROWSER_EXECUTABLE_PATH",
  "AGENT_BROWSER_ARGS",
  "AGENT_BROWSER_USER_AGENT",
  "AGENT_BROWSER_PROXY",
  "AGENT_BROWSER_PROXY_BYPASS",
  "AGENT_BROWSER_HEADERS",
  "AGENT_BROWSER_IGNORE_HTTPS_ERRORS",
  "AGENT_BROWSER_CA_CERT",
  "AGENT_BROWSER_ALLOW_FILE_ACCESS",
  "AGENT_BROWSER_CDP",
  "AGENT_BROWSER_AUTO_CONNECT",
  "AGENT_BROWSER_PIN_TAB",
  "AGENT_BROWSER_DEVICE",
  "AGENT_BROWSER_HIDE_SCROLLBARS",
  "AGENT_BROWSER_WEBGPU",
  "AGENT_BROWSER_NO_WEBMCP",
  "AGENT_BROWSER_DOWNLOAD_PATH",
  "AGENT_BROWSER_SCREENSHOT_DIR",
  "AGENT_BROWSER_SCREENSHOT_QUALITY",
  "AGENT_BROWSER_SCREENSHOT_FORMAT",
  "AGENT_BROWSER_ANNOTATE",
  "AGENT_BROWSER_COLOR_SCHEME",
  "AGENT_BROWSER_CONTENT_BOUNDARIES",
  "AGENT_BROWSER_MAX_OUTPUT",
  "AGENT_BROWSER_ALLOWED_DOMAINS",
  "AGENT_BROWSER_ACTION_POLICY",
  "AGENT_BROWSER_CONFIRM_ACTIONS",
  "AGENT_BROWSER_CONFIRM_INTERACTIVE",
  "AGENT_BROWSER_ENGINE",
  "AGENT_BROWSER_IDLE_TIMEOUT",
  "AGENT_BROWSER_NO_AUTO_DIALOG",
  "AGENT_BROWSER_MODEL",
  "AGENT_BROWSER_PLUGINS",
  // Namespace/session
  "AGENT_BROWSER_NAMESPACE",
  "AGENT_BROWSER_SESSION",
  "AGENT_BROWSER_RESTORE",
  // Vault / state
  "AGENT_BROWSER_STATE",
  "AGENT_BROWSER_PROFILE",
  // Custom for this deployment
  "PIAB_REQUIRE_SANDBOX",
  // For debugging, allow RUST_LOG but not arbitrary
  "RUST_LOG",
]);

// Denylist: proxy leakage prevention (runtime should not inherit host proxy)
export const DENIED_RUNTIME_PROXY_VARS = new Set([
  "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY",
  "ALL_PROXY", "all_proxy",
]);

// Variables that should be cleared when script mode isolation requires it
export const SCRIPT_ISOLATION_CLEAR_VARS = new Set([
  "AGENT_BROWSER_PROFILE",
  "AGENT_BROWSER_STATE",
  "AGENT_BROWSER_RESTORE",
  "AGENT_BROWSER_CDP",
  "AGENT_BROWSER_AUTO_CONNECT",
  "AGENT_BROWSER_NAMESPACE",
  "AGENT_BROWSER_PROXY",
  "AGENT_BROWSER_PROXY_BYPASS",
  "AGENT_BROWSER_HEADERS",
  "AGENT_BROWSER_CA_CERT",
]);

export interface EnvBuildOptions {
  hostEnv: Record<string, string>;
  cliEnvOverrides?: Record<string, string | undefined>; // from extension's env param
  mode?: "normal" | "script" | "cdp";
  explicitConfigPath?: string;
}

export function buildContainerEnv(opts: EnvBuildOptions): Record<string, string> {
  const out: Record<string, string> = {};

  // Start from host env, only allowlisted
  for (const [k, v] of Object.entries(opts.hostEnv)) {
    if (ALLOWED_ENV_VARS.has(k)) {
      out[k] = v;
    }
  }

  // Remove runtime proxy leakage
  for (const k of DENIED_RUNTIME_PROXY_VARS) {
    delete out[k];
  }

  // Apply overrides (including deletion via undefined)
  if (opts.cliEnvOverrides) {
    for (const [k, v] of Object.entries(opts.cliEnvOverrides)) {
      if (v === undefined) {
        delete out[k];
      } else {
        // Only allow allowlisted overrides, but also permit PIAB_*
        if (ALLOWED_ENV_VARS.has(k) || k.startsWith("PIAB_") || k.startsWith("AGENT_BROWSER_")) {
          out[k] = v;
        }
      }
    }
  }

  // Mode-specific isolation
  if (opts.mode === "script") {
    for (const k of SCRIPT_ISOLATION_CLEAR_VARS) {
      // docker exec inherits the container's configured environment: deletion alone is not isolation.
      out[k] = "";
    }
    // Ensure script uses isolated session
    out["AGENT_BROWSER_IDLE_TIMEOUT_MS"] = out["AGENT_BROWSER_IDLE_TIMEOUT_MS"] || "3600000";
  }

  // Ensure config points to mounted base config if not overridden
  if (!out["AGENT_BROWSER_CONFIG"]) {
    out["AGENT_BROWSER_CONFIG"] = "/etc/agent-browser/config.json";
  }
  if (opts.explicitConfigPath) {
    out["AGENT_BROWSER_CONFIG"] = opts.explicitConfigPath;
  }

  // Enforce trusted defaults
  if (!out["AGENT_BROWSER_SOCKET_DIR"]) {
    out["AGENT_BROWSER_SOCKET_DIR"] = "/home/agent/.agent-browser";
  }
  // State expire days should be via env, not config
  if (!out["AGENT_BROWSER_STATE_EXPIRE_DAYS"]) {
    out["AGENT_BROWSER_STATE_EXPIRE_DAYS"] = "30";
  }
  if (!out["AGENT_BROWSER_AUTOSAVE_INTERVAL_MS"]) {
    out["AGENT_BROWSER_AUTOSAVE_INTERVAL_MS"] = "30000";
  }
  if (!out["PIAB_REQUIRE_SANDBOX"]) {
    out["PIAB_REQUIRE_SANDBOX"] = "1";
  }

  return out;
}

export function envToDockerArgs(env: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    args.push("-e", `${k}=${v}`);
  }
  // Explicitly clear denied proxy vars in container
  for (const k of DENIED_RUNTIME_PROXY_VARS) {
    args.push("-e", `${k}=`);
  }
  return args;
}
