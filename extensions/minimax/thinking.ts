// MiniMax thinking policy keeps M3 active by default while preserving M2.x leak prevention.
import type { ProviderThinkingProfile } from "openclaw/plugin-sdk/plugin-entry";

const BUDGET_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
const ADAPTIVE_THINKING_LEVELS = ["off", "adaptive"] as const;
const EFFORT_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function resolveMinimaxThinkingProfile(
  modelId: string,
): ProviderThinkingProfile | undefined {
  if (/^MiniMax-M3\.1(\b|[-])/i.test(modelId)) {
    // M3.1 requires adaptive thinking; the provider rejects disabled thinking with HTTP 400,
    // so unlike M3 it has no "off" level, and it exposes graded effort instead.
    return {
      levels: EFFORT_THINKING_LEVELS.map((id) => ({ id })),
      defaultLevel: "max",
    };
  }
  if (/^MiniMax-M3(\b|[-.])/i.test(modelId)) {
    return {
      levels: ADAPTIVE_THINKING_LEVELS.map((id) => ({ id })),
      defaultLevel: "adaptive",
    };
  }
  if (/^MiniMax-M2(?:\b|[-.])/i.test(modelId)) {
    return {
      levels: BUDGET_THINKING_LEVELS.map((id) => ({ id })),
      defaultLevel: "off",
    };
  }
  return undefined;
}
