import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPluginNativeReferenceNamespace } from "./plugin-native-reference.js";
import type {
  PluginNativeArtifactFact,
  PluginNativeNamespaceFact,
} from "./plugin-source-admission.types.js";

describe("assertPluginNativeReferenceNamespace", () => {
  let root = "";
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("walks a shared companion directory once per validation pass", () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-reference-")));
    const capturedRoot = path.join(root, "captured");
    const content = path.join(capturedRoot, "content");
    const generation = path.join(root, "generation");
    fs.mkdirSync(content, { recursive: true });
    fs.mkdirSync(generation);
    const names = ["a.node", "b.node", "c.node"];
    const namespace: PluginNativeNamespaceFact = {
      sourceDirectory: root,
      capturedRoot,
      managed: true,
      members: {},
    };
    const facts = names.map((name) => {
      fs.writeFileSync(path.join(content, name), name);
      fs.linkSync(path.join(content, name), path.join(generation, name));
      namespace.members[name] = {
        source: path.join(content, name),
        sourceIdentity: "",
        capturedIdentity: "",
        boundaryChecked: true,
        contentHash: "unused",
        sizeBytes: name.length,
      };
      return {
        target: path.join(generation, name),
        fact: {
          capturedPath: path.join(content, name),
          namespace: "ns",
        } as PluginNativeArtifactFact,
      };
    });
    const walk = (cache?: Set<string>) => {
      const realpath = vi.spyOn(fs, "realpathSync");
      for (const { target, fact } of facts) {
        assertPluginNativeReferenceNamespace(target, fact, namespace, root, undefined, cache);
      }
      const calls = realpath.mock.calls.length;
      realpath.mockRestore();
      return calls;
    };
    expect(walk()).toBe(9);
    expect(walk(new Set())).toBe(3);
  });
});
