/**
 * Canonical identity of the scheduler agent tool. Single source of truth for
 * every name-keyed consumer (policy lists, factory descriptors, runtime
 * observers, prompts); never spell the tool name as a string literal.
 */
export const AUTOMATIONS_TOOL_NAME = "automations";

/**
 * Pre-rename tool name still present in persisted allow/deny config and old
 * transcripts. Policy matching aliases it to the canonical id (RFC 0026);
 * removing it breaks configs written before the rename.
 */
export const LEGACY_AUTOMATIONS_TOOL_NAMES = ["cron"] as const;

/** True when a tool name refers to the scheduler tool, including legacy names. */
export function isAutomationsToolName(name: string): boolean {
  return (
    name === AUTOMATIONS_TOOL_NAME ||
    (LEGACY_AUTOMATIONS_TOOL_NAMES as readonly string[]).includes(name)
  );
}
