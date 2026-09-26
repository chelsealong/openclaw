import { describe, expect, it } from "vitest";
import {
  preparedSyntheticAuthProviderScope,
  scopeSyntheticAuthProviderRefs,
} from "./prepared-model-runtime.synthetic-auth.js";

describe("preparedSyntheticAuthProviderScope", () => {
  it("includes claude-cli's native auth namespace when anthropic is scoped", () => {
    const scope = preparedSyntheticAuthProviderScope(["anthropic"]);
    expect(scope.has("claude-cli")).toBe(true);
  });

  it("does not add claude-cli for an unrelated provider scope", () => {
    const scope = preparedSyntheticAuthProviderScope(["openai"]);
    expect(scope.has("claude-cli")).toBe(false);
  });
});

describe("scopeSyntheticAuthProviderRefs", () => {
  it("keeps claude-cli's ref when only anthropic is requested", () => {
    const refs = scopeSyntheticAuthProviderRefs(
      ["anthropic", "claude-cli", "openai", "codex"],
      ["anthropic"],
    );
    expect(refs).toEqual(["anthropic", "claude-cli"]);
  });
});
