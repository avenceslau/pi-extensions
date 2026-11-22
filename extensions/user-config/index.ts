import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshUserConfig, userConfigPath } from "../shared/config.ts";

// Reads ~/.pi/agent/pi-extensions.ts at session start and /reload, so edits apply after /reload.
export default function userConfig(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await refreshUserConfig();
    } catch (error) {
      ctx.ui.notify(`Ignoring ${userConfigPath()}: ${String(error)}`, "error");
    }
  });
}
