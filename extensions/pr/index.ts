import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type Forge } from "../shared/config.ts";

const DEFAULT_FORGES: Record<string, Forge> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
};

interface RemoteTarget {
  forge: Forge;
  repository: string;
}

function parseRemote(
  remoteUrl: string,
): { host: string; path: string } | undefined {
  if (remoteUrl.includes("://")) {
    try {
      const url = new URL(remoteUrl);

      return {
        host: url.hostname.toLowerCase(),
        path: url.pathname.replace(/^\//, "").replace(/\.git$/, ""),
      };
    } catch {
      return undefined;
    }
  }

  const match = remoteUrl.match(/^(?:[^@]+@)?([^:]+):(.+)$/);

  if (!match) {
    return undefined;
  }

  return {
    host: match[1].toLowerCase(),
    path: match[2].replace(/^\//, "").replace(/\.git$/, ""),
  };
}

// gh takes HOST/OWNER/REPO and glab a repository URL, so both reach any host the config names.
export function targetForRemote(
  remoteUrl: string,
  forges: Record<string, Forge>,
): RemoteTarget | undefined {
  const remote = parseRemote(remoteUrl);

  if (!remote?.path) {
    return undefined;
  }

  switch (forges[remote.host] ?? DEFAULT_FORGES[remote.host]) {
    case "github":
      return { forge: "github", repository: `${remote.host}/${remote.path}` };
    case "gitlab":
      return {
        forge: "gitlab",
        repository: `https://${remote.host}/${remote.path}`,
      };
    default:
      return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pr", {
    description:
      "Open the GitHub pull request or GitLab merge request for a branch",
    handler: async (args, ctx) => {
      const requestedBranch = args.trim();

      if (/\s/.test(requestedBranch)) {
        ctx.ui.notify("Usage: /pr [branch]", "warning");

        return;
      }

      const repository = await pi.exec(
        "git",
        ["rev-parse", "--is-inside-work-tree"],
        {
          cwd: ctx.cwd,
          timeout: 5_000,
        },
      );

      if (repository.code !== 0 || repository.stdout.trim() !== "true") {
        ctx.ui.notify("/pr must be run inside a Git repository", "warning");

        return;
      }

      const cwd = ctx.cwd;

      let branch = requestedBranch;

      if (!branch) {
        const currentBranch = await pi.exec(
          "git",
          ["branch", "--show-current"],
          {
            cwd,
            timeout: 5_000,
          },
        );

        branch = currentBranch.stdout.trim();

        if (currentBranch.code !== 0 || !branch) {
          ctx.ui.notify("Usage: /pr <branch> (HEAD is detached)", "warning");

          return;
        }
      }

      const branchCheck = await pi.exec(
        "git",
        ["check-ref-format", "--branch", branch],
        {
          cwd,
          timeout: 5_000,
        },
      );

      if (branchCheck.code !== 0) {
        ctx.ui.notify(
          branchCheck.stderr.trim() || `Invalid branch name: ${branch}`,
          "warning",
        );

        return;
      }

      const upstream = await pi.exec(
        "git",
        [
          "for-each-ref",
          "--format=%(upstream:remotename)",
          `refs/heads/${branch}`,
        ],
        { cwd, timeout: 5_000 },
      );

      const remotes = await pi.exec("git", ["remote"], { cwd, timeout: 5_000 });

      const remoteNames = remotes.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);

      const candidates = [
        upstream.stdout.trim(),
        "origin",
        ...remoteNames,
      ].filter(
        (value, index, values) =>
          value && value !== "." && values.indexOf(value) === index,
      );

      const forges = loadConfig(pi).forges ?? {};
      let target: RemoteTarget | undefined;

      for (const remote of candidates) {
        const url = await pi.exec("git", ["remote", "get-url", remote], {
          cwd,
          timeout: 5_000,
        });

        if (url.code !== 0) {
          continue;
        }

        target = targetForRemote(url.stdout.trim(), forges);

        if (target) {
          break;
        }
      }

      if (!target) {
        ctx.ui.notify(
          "No GitHub or GitLab remote found; add other hosts under forges in ~/.pi/agent/pi-extensions.ts",
          "warning",
        );

        return;
      }

      const command = target.forge === "github" ? "gh" : "glab";

      const commandArgs =
        target.forge === "github"
          ? ["pr", "view", branch, "--web", "--repo", target.repository]
          : ["mr", "view", branch, "--web", "--repo", target.repository];

      const reviewName =
        target.forge === "github" ? "pull request" : "merge request";

      ctx.ui.setStatus("open-pr", `Opening ${reviewName} for ${branch}…`);

      try {
        const result = await pi.exec(command, commandArgs, {
          cwd,
          timeout: 30_000,
        });

        if (result.code === 0 && !result.killed) {
          ctx.ui.notify(`Opened ${reviewName} for ${branch}`, "info");

          return;
        }

        const details = result.stderr.trim() || result.stdout.trim();

        const message = details
          ? `Could not open ${reviewName} for ${branch}: ${details}`
          : `No ${reviewName} found for ${branch}`;

        ctx.ui.notify(message, "warning");
      } catch (error) {
        ctx.ui.notify(
          `Could not open ${reviewName}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      } finally {
        ctx.ui.setStatus("open-pr", undefined);
      }
    },
  });
}
