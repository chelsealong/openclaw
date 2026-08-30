// Boundary proof for the /models browse catalog read recovering from a config hot-reload
// replacing the prepared owner mid-read, instead of surfacing a retryable failure that repeats
// against the same stale snapshot (openclaw#133166).
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

const cfg = {
  agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
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

    const data = await buildPreparedModelsProviderData(cfg);

    expect(data.byProvider.get("anthropic")).toEqual(new Set(["claude-opus-4-5"]));
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });

  it("recovers via the published owner when the prepared config was replaced mid-read", async () => {
    catalogMocks.loadSnapshot.mockRejectedValueOnce(
      new PreparedModelCatalogConfigReplacedError("/tmp/agent-dir"),
    );
    catalogMocks.loadPublishedOwner.mockResolvedValueOnce({
      modelCatalog: {
        entries: [{ provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus" }],
        routeVariants: [],
      },
    });

    const data = await buildPreparedModelsProviderData(cfg);

    expect(data.byProvider.get("anthropic")).toEqual(new Set(["claude-opus-4-5"]));
    expect(catalogMocks.loadPublishedOwner).toHaveBeenCalledTimes(1);
  });

  it("does not mask unrelated failures", async () => {
    const error = new Error("boom");
    catalogMocks.loadSnapshot.mockRejectedValueOnce(error);

    await expect(buildPreparedModelsProviderData(cfg)).rejects.toBe(error);
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });
});
