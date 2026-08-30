// Boundary proof for the /models browse catalog read recovering from a config hot-reload
// replacing the prepared owner mid-read, instead of surfacing a retryable failure that repeats
// against the same stale snapshot (openclaw#133166). The recovery must rebuild the whole browse
// result from the replacement owner's own config, not mix it with the stale caller-supplied cfg.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreparedModelCatalogConfigReplacedError } from "../../agents/prepared-model-catalog.errors.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const catalogMocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  loadPublishedOwner: vi.fn(),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogSnapshot: catalogMocks.loadSnapshot,
  loadPublishedPreparedModelCatalogOwnerSnapshot: catalogMocks.loadPublishedOwner,
}));

const { buildPreparedModelsProviderData } = await import("./commands-models.js");

const staleCfg = {
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
} as OpenClawConfig;

const replacementCfg = {
  agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
} as OpenClawConfig;

afterEach(() => {
  vi.clearAllMocks();
});

describe("/models browse catalog recovery", () => {
  it("returns the exact-config snapshot when the prepared owner matches", async () => {
    catalogMocks.loadSnapshot.mockResolvedValueOnce({
      entries: [{ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" }],
      routeVariants: [],
    });

    const data = await buildPreparedModelsProviderData(staleCfg);

    expect(data.byProvider.get("anthropic")).toEqual(new Set(["claude-opus-4-5"]));
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });

  it("rebuilds the whole browse result from the replacement owner's config, not the stale cfg", async () => {
    catalogMocks.loadSnapshot
      .mockRejectedValueOnce(new PreparedModelCatalogConfigReplacedError("/tmp/agent-dir"))
      .mockResolvedValueOnce({
        entries: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }],
        routeVariants: [],
      });
    catalogMocks.loadPublishedOwner.mockResolvedValueOnce({ config: replacementCfg });

    const data = await buildPreparedModelsProviderData(staleCfg);

    // The recovered menu reflects the replacement generation end-to-end: its catalog entry
    // and its resolved default both come from replacementCfg, never staleCfg's stale anthropic
    // default that the new config already removed.
    expect(data.resolvedDefault).toEqual({ provider: "openai", model: "gpt-5.6-luna" });
    expect(data.byProvider.get("anthropic")).toBeUndefined();
    expect(data.byProvider.get("openai")).toEqual(new Set(["gpt-5.6-luna"]));
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(1);
    expect(catalogMocks.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(catalogMocks.loadSnapshot.mock.calls[1]?.[0]).toMatchObject({ config: replacementCfg });
  });

  it("does not mask unrelated failures", async () => {
    const error = new Error("boom");
    catalogMocks.loadSnapshot.mockRejectedValueOnce(error);

    await expect(buildPreparedModelsProviderData(staleCfg)).rejects.toBe(error);
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });
});
