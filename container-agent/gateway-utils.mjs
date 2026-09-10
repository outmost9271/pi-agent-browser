import { accessSync, constants, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function findChromeBinary(explicit, roots = ['/home/agent/.agent-browser/browsers', '/root/.agent-browser/browsers']) {
  const executable = path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };
  if (explicit) return executable(explicit) ? explicit : null;
  if (executable('/opt/piab/browser/chrome')) return '/opt/piab/browser/chrome';
  for (const root of roots) {
    let entries; try { entries = readdirSync(root).sort((a,b) => b.localeCompare(a, undefined, {numeric:true})); } catch { continue; }
    for (const entry of entries) {
      if (!entry.startsWith('chrome-')) continue;
      for (const path of [join(root, entry, 'chrome'), join(root, entry, 'chrome-linux64', 'chrome')]) if (executable(path)) return path;
    }
  }
  return ['/usr/bin/google-chrome', '/usr/bin/chromium'].find(executable) || null;
}
export function rewriteDiscovery(body, internalPort, publicPort, host = '127.0.0.1') {
  let parsed; try { parsed = JSON.parse(body); } catch { return body; }
  const rewrite = object => {
    if (!object || typeof object !== 'object') return;
    if (Array.isArray(object)) { object.forEach(rewrite); return; }
    // Never replace port-like strings in page titles, page URLs or user content.
    for (const key of ['webSocketDebuggerUrl', 'devtoolsFrontendUrl', 'devtoolsFrontendUrlCompat']) {
      if (typeof object[key] === 'string') object[key] = object[key].replaceAll(`127.0.0.1:${internalPort}`, `${host}:${publicPort}`).replaceAll(`localhost:${internalPort}`, `${host}:${publicPort}`);
    }
  };
  rewrite(parsed); return JSON.stringify(parsed);
}
