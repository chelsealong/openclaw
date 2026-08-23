import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadOpenClawPluginCliRegistry } from "../../src/plugins/loader.js";
import {
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "../../src/plugins/loader.test-fixtures.js";

const diffsRoot = path.dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

describe("diffs cli metadata entry", () => {
  it("loads without a runtime when discovered as an installed (non-bundled) plugin", async () => {
    useNoBundledPlugins();
    const registry = await loadOpenClawPluginCliRegistry({
      cache: false,
      config: {
        plugins: {
          load: { paths: [diffsRoot] },
          allow: ["diffs"],
        },
      },
    });

    const diffs = registry.plugins.find((entry) => entry.id === "diffs");
    expect(diffs?.status).toBe("loaded");
    expect(diffs?.error).toBeUndefined();
  });
});
