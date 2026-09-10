import { statSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface ArtifactVerification {
  hostPath: string;
  containerPath: string;
  exists: boolean;
  isFile: boolean;
  size: number;
  mtime: number;
  hostExists: boolean;
  hostIsFile: boolean;
  hostSize: number;
  consistent: boolean;
  error?: string;
}

export function verifyArtifact(hostPath: string, containerPath: string, hostCwd: string): ArtifactVerification {
  const absHost = isAbsolute(hostPath) ? hostPath : resolve(hostCwd, hostPath);
  let hostExists = false;
  let hostIsFile = false;
  let hostSize = 0;
  let hostMtime = 0;
  try {
    const st = statSync(absHost);
    hostExists = true;
    hostIsFile = st.isFile();
    hostSize = st.size;
    hostMtime = st.mtimeMs;
  } catch {}

  // Container path verification would require docker exec stat; for host adapter we verify host side
  // and assume container side will be checked via docker exec call
  return {
    hostPath: absHost,
    containerPath,
    exists: hostExists,
    isFile: hostIsFile,
    size: hostSize,
    mtime: hostMtime,
    hostExists,
    hostIsFile,
    hostSize,
    consistent: hostExists && hostIsFile && hostSize > 0,
  };
}

// Check outputPath conflict with browser artifacts
export function checkOutputPathConflict(outputPath: string | undefined, artifactPaths: string[]): string | undefined {
  if (!outputPath) return undefined;
  const absOutput = resolve(outputPath);
  for (const a of artifactPaths) {
    const absArtifact = resolve(a);
    if (absOutput === absArtifact) {
      return `outputPath ${outputPath} conflicts with browser artifact ${a}`;
    }
  }
  return undefined;
}

// Ensure parent dir exists for outputPath
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";

export async function ensureOutputParentDir(outputPath: string): Promise<void> {
  const dir = dirname(resolve(outputPath));
  await mkdir(dir, { recursive: true, mode: 0o755 });
}
