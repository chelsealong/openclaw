// Diffs plugin module implements lightweight cli metadata behavior.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "diffs",
  name: "Diffs",
  description: "OpenClaw read-only diff viewer plugin and file renderer for agents.",
  register() {
    // Diffs has no CLI commands. This entry only exists so lightweight CLI
    // metadata capture stops here instead of falling through to plugin.ts,
    // which requires a full runtime (api.runtime.state.openBlobStore).
  },
});
