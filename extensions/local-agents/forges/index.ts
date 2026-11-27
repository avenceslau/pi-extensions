import type { Forge } from "../../shared/config-types.ts";
import { githubClient } from "./github.ts";
import { gitlabClient } from "./gitlab.ts";
import type { ForgeClient } from "./types.ts";

export function forgeClient(
  url: string,
  forges: Record<string, Forge>,
  isBot: (username: string) => boolean,
): ForgeClient {
  const [host, ...rest] = url.replace(/^https?:\/\//, "").split("/");
  const project = rest.join("/");
  const kind = host === "github.com" ? "github" : forges[host];

  if (!kind || !project) {
    throw new Error(
      `Cannot tell the forge of ${url}; add its host to the forges config`,
    );
  }

  return kind === "github"
    ? githubClient(host, project, isBot)
    : gitlabClient(host, project, isBot);
}
