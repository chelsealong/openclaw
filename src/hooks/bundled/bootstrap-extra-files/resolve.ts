// Pure config resolver for the bundled bootstrap-extra-files hook. Reused by
// the runtime handler and by `openclaw doctor`, which never loads hook code,
// so both see the same configured extra files.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  loadExtraBootstrapFilesWithDiagnostics,
  type ExtraBootstrapLoadDiagnostic,
  type WorkspaceBootstrapFile,
} from "../../../agents/workspace.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveHookConfig } from "../../config.js";

const HOOK_KEY = "bootstrap-extra-files";

/** Resolve legacy and current config keys for extra bootstrap file patterns. */
function resolveExtraBootstrapPatterns(hookConfig: Record<string, unknown>): string[] {
  const fromPaths = normalizeTrimmedStringList(hookConfig.paths);
  if (fromPaths.length > 0) {
    return fromPaths;
  }
  const fromPatterns = normalizeTrimmedStringList(hookConfig.patterns);
  if (fromPatterns.length > 0) {
    return fromPatterns;
  }
  return normalizeTrimmedStringList(hookConfig.files);
}

/**
 * Resolves the extra bootstrap files the bundled hook would inject, without
 * dispatching the hook itself. Callers that never load hook code still see
 * the same files the runtime handler would append.
 */
export async function resolveConfiguredExtraBootstrapFiles(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
}): Promise<{ files: WorkspaceBootstrapFile[]; diagnostics: ExtraBootstrapLoadDiagnostic[] }> {
  const hookConfig = resolveHookConfig(params.config, HOOK_KEY);
  if (!hookConfig || hookConfig.enabled === false) {
    return { files: [], diagnostics: [] };
  }
  const patterns = resolveExtraBootstrapPatterns(hookConfig as Record<string, unknown>);
  if (patterns.length === 0) {
    return { files: [], diagnostics: [] };
  }
  return loadExtraBootstrapFilesWithDiagnostics(params.workspaceDir, patterns);
}
