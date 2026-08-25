/**
 * Sandbox media path resolution helpers.
 *
 * Bridges media references through sandbox filesystems while enforcing workspace-only boundaries when required.
 */
import path from "node:path";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { createBoundedOutboundMediaReadFile } from "../media/bounded-read-file.js";
import type { OutboundMediaReadFile } from "../media/load-options.js";
import { resolveMediaReferenceSandboxPath } from "../media/media-reference.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge, SandboxResolvedPath } from "./sandbox/fs-bridge.js";
import { isPathInsideContainerRoot, normalizeContainerPathCore } from "./sandbox/path-utils.js";

export type SandboxedBridgeMediaPathConfig = {
  root: string;
  bridge: SandboxFsBridge;
  workspaceOnly?: boolean;
};

export function createSandboxBridgeReadFile(params: {
  sandbox: Pick<SandboxedBridgeMediaPathConfig, "root" | "bridge">;
}): OutboundMediaReadFile {
  return createBoundedOutboundMediaReadFile(
    async (filePath, options) =>
      await params.sandbox.bridge.readFile({
        filePath,
        cwd: params.sandbox.root,
        maxBytes: options?.maxBytes,
      }),
  );
}

export async function resolveSandboxedBridgeMediaPath(params: {
  sandbox: SandboxedBridgeMediaPathConfig;
  mediaPath: string;
  inboundFallbackDir?: string;
}): Promise<{ resolved: string; rewrittenFrom?: string }> {
  const mediaPathInfo = params.inboundFallbackDir
    ? resolveMediaReferenceSandboxPath(params.mediaPath, params.inboundFallbackDir)
    : { resolved: params.mediaPath };
  const filePath = /^file:/iu.test(mediaPathInfo.resolved)
    ? safeFileURLToPath(mediaPathInfo.resolved, "linux")
    : mediaPathInfo.resolved;
  const rewrittenFrom = mediaPathInfo.rewrittenFrom;
  if (rewrittenFrom) {
    const stat = await params.sandbox.bridge.stat({
      filePath,
      cwd: params.sandbox.root,
    });
    if (!stat) {
      throw new Error(`Sandbox media reference is not staged: ${rewrittenFrom}`);
    }
  }
  const enforceWorkspaceBoundary = async (resolved: SandboxResolvedPath) => {
    if (!params.sandbox.workspaceOnly) {
      return;
    }
    if (resolved.hostPath) {
      await assertSandboxPath({
        filePath: resolved.hostPath,
        cwd: params.sandbox.root,
        root: params.sandbox.root,
      });
      return;
    }
    const workspaceRoot = params.sandbox.bridge.resolvePath({
      filePath: params.sandbox.root,
      cwd: params.sandbox.root,
    });
    if (
      !isPathInsideContainerRoot(
        normalizeContainerPathCore(workspaceRoot.containerPath),
        normalizeContainerPathCore(resolved.containerPath),
      )
    ) {
      throw new Error(`Sandbox path escapes workspace root: ${resolved.containerPath}`);
    }
  };

  const resolveDirect = () =>
    params.sandbox.bridge.resolvePath({
      filePath,
      cwd: params.sandbox.root,
    });
  const resolveInboundFallback = async (err: unknown) => {
    const fallbackDir = params.inboundFallbackDir?.trim();
    if (!fallbackDir) {
      throw err;
    }
    const fallbackPath = path.join(fallbackDir, path.basename(filePath));
    try {
      const stat = await params.sandbox.bridge.stat({
        filePath: fallbackPath,
        cwd: params.sandbox.root,
      });
      if (!stat) {
        throw err;
      }
    } catch {
      throw err;
    }
    const resolvedFallback = params.sandbox.bridge.resolvePath({
      filePath: fallbackPath,
      cwd: params.sandbox.root,
    });
    await enforceWorkspaceBoundary(resolvedFallback);
    return {
      resolved: resolvedFallback.hostPath ?? resolvedFallback.containerPath,
      rewrittenFrom: filePath,
    };
  };
  try {
    const resolved = resolveDirect();
    await enforceWorkspaceBoundary(resolved);
    // A bare handle with no directory component (e.g. an opaque upload id)
    // resolves syntactically fine under the workspace root even when no such
    // file exists there; only existence, not resolution, can tell it apart
    // from a real workspace-relative filename, so check it before trusting
    // the direct path over the staged inbound fallback.
    if (
      !rewrittenFrom &&
      params.inboundFallbackDir?.trim() &&
      path.basename(filePath) === filePath
    ) {
      const directStat = await params.sandbox.bridge
        .stat({ filePath, cwd: params.sandbox.root })
        .catch(() => null);
      if (!directStat) {
        return await resolveInboundFallback(
          new Error(`Sandbox media reference not found: ${filePath}`),
        );
      }
    }
    return {
      resolved: resolved.hostPath ?? resolved.containerPath,
      ...(rewrittenFrom ? { rewrittenFrom } : {}),
    };
  } catch (err) {
    return await resolveInboundFallback(err);
  }
}
