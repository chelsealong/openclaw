/**
 * Canonical identity of the scheduler agent tool. Single source of truth for
 * every name-keyed consumer (policy lists, factory descriptors, runtime
 * observers, prompts); never spell the tool name as a string literal.
 */
export const AUTOMATIONS_TOOL_NAME = "cron";

/** True when a tool name refers to the scheduler tool. */
export function isAutomationsToolName(name: string): boolean {
  return name === AUTOMATIONS_TOOL_NAME;
}
