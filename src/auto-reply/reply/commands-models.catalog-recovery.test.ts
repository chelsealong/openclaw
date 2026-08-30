// Boundary proof for the /models browse catalog read recovering from a config hot-reload
// replacing the prepared owner mid-read, instead of surfacing a retryable failure that repeats
// against the same stale snapshot (openclaw#133166).
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreparedModelCatalogConfigReplacedError } from "../../agents/prepared-model-catalog.errors.js";
import { loadModelsBrowseCatalogSnapshot } from "./commands-models.js";

const catalogMocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  loadPublishedOwner: vi.fn(),
}));

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogSnapshot: catalogMocks.loadSnapshot,
  loadPublishedPreparedModelCatalogOwnerSnapshot: catalogMocks.loadPublishedOwner,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadModelsBrowseCatalogSnapshot", () => {
  it("returns the exact-config snapshot when the prepared owner matches", async () => {
    const snapshot = { entries: [], routeVariants: [] };
    catalogMocks.loadSnapshot.mockResolvedValueOnce(snapshot);

    await expect(loadModelsBrowseCatalogSnapshot({ readOnly: true })).resolves.toBe(snapshot);
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });

  it("recovers via the published owner when the prepared config was replaced mid-read", async () => {
    catalogMocks.loadSnapshot.mockRejectedValueOnce(
      new PreparedModelCatalogConfigReplacedError("/tmp/agent-dir"),
    );
    const publishedCatalog = { entries: [], routeVariants: [] };
    catalogMocks.loadPublishedOwner.mockResolvedValueOnce({ modelCatalog: publishedCatalog });

    await expect(loadModelsBrowseCatalogSnapshot({ readOnly: true })).resolves.toBe(
      publishedCatalog,
    );
  });

  it("does not mask unrelated failures", async () => {
    const error = new Error("boom");
    catalogMocks.loadSnapshot.mockRejectedValueOnce(error);

    await expect(loadModelsBrowseCatalogSnapshot({ readOnly: true })).rejects.toBe(error);
    expect(catalogMocks.loadPublishedOwner).not.toHaveBeenCalled();
  });
});
