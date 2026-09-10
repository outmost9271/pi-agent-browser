import { containerToHostPath, type MapperContext } from './path-mapper.js';
// Preserve page text/URLs verbatim. Only transport metadata and argv operands are mapped back.
const PATH_KEYS = new Set(['path','file','filePath','outputPath','downloadPath','screenshotPath','tracePath','recordingPath','absolutePath','requestedPath','resolvedPath']);
export function rewriteResult(stdout: Buffer, ctx: MapperContext): Buffer {
  let value: unknown; try { value = JSON.parse(stdout.toString()); } catch { return stdout; }
  const operand = (text: string) => {
    const eq = text.startsWith('--') ? text.indexOf('=') : -1;
    if (eq > 0) { const path=containerToHostPath(text.slice(eq+1),ctx); return path ? text.slice(0,eq+1)+path : text; }
    return containerToHostPath(text,ctx) || text;
  };
  function walk(value: unknown, key = ''): unknown {
    if (typeof value === 'string') return PATH_KEYS.has(key) ? operand(value) : value;
    if (Array.isArray(value)) return value.map(v => (key === 'command' || key === 'args' || key === 'files') && typeof v === 'string' ? operand(v) : walk(v));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v,k)]));
    return value;
  }
  return Buffer.from(JSON.stringify(walk(value))+'\n');
}
