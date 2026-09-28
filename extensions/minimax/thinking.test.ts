import { describe, expect, it } from "vitest";
import { resolveMinimaxThinkingProfile } from "./thinking.js";

describe("resolveMinimaxThinkingProfile", () => {
  it("gives M3 an off/adaptive menu", () => {
    expect(resolveMinimaxThinkingProfile("MiniMax-M3")).toEqual({
      levels: [{ id: "off" }, { id: "adaptive" }],
      defaultLevel: "adaptive",
    });
  });

  it("gives M3.1 a graded effort menu with no off level, defaulting to max", () => {
    expect(resolveMinimaxThinkingProfile("MiniMax-M3.1-Flash-Preview")).toEqual({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
      defaultLevel: "max",
    });
  });
});
