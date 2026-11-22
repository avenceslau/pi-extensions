import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { refreshUserConfig, userConfigPath } from "../shared/config.ts";

type UserConfigApi = Pick<ExtensionAPI, "on">;
type RefreshUserConfig = () => ReturnType<typeof refreshUserConfig>;

// Load before session_start so every extension sees user overrides in its first handler.
export default async function userConfig(
  pi: UserConfigApi,
  refresh: RefreshUserConfig = refreshUserConfig,
): Promise<void> {
  try {
    await refresh();
  } catch (error) {
    pi.on("session_start", (_event, ctx) => {
      ctx.ui.notify(`Ignoring ${userConfigPath()}: ${String(error)}`, "error");
    });
  }
}
