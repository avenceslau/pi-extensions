# pi-extensions

A collection of Pi extensions, agents, skills, and prompts for code quality, reviews, model failover, subagent safety, and session utilities.

```sh
pi install git:github.com/avenceslau/pi-extensions
```

Run `/reload` after installing or updating the package.

## Features

### Reviews and code quality

- **Post-change audit** reviews changes made in the session. Run `/audit` or press `Ctrl+Shift+R`; automatic audits are enabled by default and can be toggled with `Ctrl+Shift+S`.
- **Hygiene linter** checks changed code against code-restraint and refactoring rules. Run `/hygiene` or use `hygiene_lint`.
- **On-demand reviews:** `/correctness [focus]` checks correctness; `/review-mr <link> [focus]` reviews someone else's GitHub PR or GitLab MR.

### Session tools

- `/pr [branch]` opens a pull or merge request in a browser.
- `/plannotator-last` annotates the latest assistant response; `/plannotator-review [PR URL]` reviews current changes or a GitHub/GitLab review. The agent can invoke the same flows through `plannotator_last` and `plannotator_review`. Install the CLI first with `curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal`.
- `/btw <question>` starts a side session; `/merge` sends its answer back.
- `start_bug_fix` lets the agent hand a bug unrelated to its task to a new Pi session, in its own tab of the Rex session `bugs` (created when missing). `models.extensions["bug-fix"]` picks its model; otherwise it uses the current one.
- `/focus feature <text>`, `/focus task <text>`, and `/focus clear` manage the session label. A configured model can update it automatically.
- `/spend` summarizes session costs.
- `compact-footer/` shows directory, branch, token and cost usage, context use, and model details.
- `bash-timeout/` requires a timeout when calling the `bash` tool.
- `repo_search` and `repo_execute` search repositories and inspect them in a QuickJS sandbox.
- `rex/` reports session state to Rex; `rex-agent-status/` reports agent state when Pi runs in a Rex block.

### Skills and agents

The package includes read-only and review agents in `agents/`, plus the `code-restraint`, `refactoring`, `pr-description`, and `glab` skills. The `bro`, `recall`, and `affirmations` skills run only when explicitly invoked. `/remember <topic>` searches previous Pi sessions. `/affirmations` summarizes recurring feedback from sessions and merged reviews.

Subagent and review modes are enabled at session start:

```text
/subagents on|off|status
/review on|off|status
```

Press `Ctrl+Shift+A` to toggle both modes. Scheduled subagents remain disabled.

## Configuration

Installed packages can contribute configuration defaults. The user config at `~/.pi/agent/pi-extensions.ts` overrides them and is loaded at session start; run `/reload` after editing it.

```ts
import type { PiExtensionsConfig } from "./git/github.com/avenceslau/pi-extensions/extensions/shared/config-types.ts";

export default {
  clef: {
    url: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef`,
    auth: {
      header: "authorization",
      token: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
    },
  },
  models: {
    primary: ["provider/model-a", "provider/model-b"],
    subagent: ["provider/model-a"],
    subagentForbidden: ["expensive"],
    agents: { "comment-review": "provider/model-b" },
  },
  forges: { "git.example.com": "gitlab" },
  agentRoles: {
    readOnly: ["security-review"],
    review: ["security-review"],
  },
  sessionFocus: { backend: "rex" },
} satisfies PiExtensionsConfig;
```

- `clef` configures [Cloudflare Clef](https://developers.cloudflare.com/ai/models/@cf/cloudflare/clef/) for judged hygiene rules and audit triage. It accepts a URL and either `auth` credentials or an `auth.command` that prints a token. Clef is optional.
- `models.primary` and `models.subagent` set model failover chains. `models.subagentForbidden` excludes models from subagents; `models.agents` assigns models by agent type.
- `forges` maps additional hostnames to `github` or `gitlab`.
- `agentRoles.readOnly` and `agentRoles.review` add subagent types to the corresponding restrictions.
- `sessionFocus.backend` selects the session-focus display integration.
- `btw.backend` selects the `/btw` pane backend (`"herdr"` by default, or `"rex"`).
- `localAgents` configures each [local agent](#local-agents) by name.

Other packages can contribute defaults through the `pi-extensions:config` event. Later contributions replace `clef`, override model and forge keys, and extend the `agentRoles` lists.

## Post-change audit

The audit checks session changes, formats touched files with an available configured formatter, and runs the hygiene linter and review agents. Automatic audits run after changes when the session and its subagents settle; they skip changes under 50 lines and allow up to two fix rounds, counted across user messages until an audit comes back clean. Use `/audit` to review smaller changes or to check again after the limit.

Other packages can add auditors or review context through `post-change-audit:contributions`. See `extensions/post-change-audit/contributions.ts` for the API.

## Hygiene linter

The linter checks changed code for issues such as deep nesting, swallowed errors, unclear names, magic numbers, duplication, forwarding chains, and dense lines. Clef can judge additional candidates. Comments are reviewed by the audit's `comment-review` agent rather than the linter.

Use it in Pi or directly from a checkout:

```text
/hygiene [ref | paths...]
```

```sh
node --experimental-strip-types extensions/hygiene/cli.ts [--diff file|-] [--root dir] [paths...] [--json] [--check] [--fail-on error|warning|info] [--no-clef]
```

With no arguments, `/hygiene` and `hygiene_lint` check uncommitted changes and untracked files. The standalone CLI requires paths or `--diff`. `--check` exits with status 1 when a finding meets the `--fail-on` threshold (default: `warning`). Add new rule traits under `extensions/hygiene/traits/`, register them in `extensions/hygiene/traits.ts`, and increment a rule's `version` when changing it to invalidate cached judgments.

## Local agents

`extensions/local-agents/` runs agents on your machine from launchd. Each agent is a set of checks, plain code that runs on a schedule and needs no model, and the playbooks they start. A check returns triggers. Each new trigger starts a fresh pi session in a Rex tab of a session named after the agent, in a Shirei worktree. Runs for the same merge request share its tab, labelled `!123 - title` (GitLab) or `#123 - title` (GitHub). The tab and its clean worktrees are removed once the merge request closes.

`todai` is the first agent. For each configured repository it:

- rebases your merge requests that have conflicts and force-pushes them, asking only when the rebase needs a decision;
- prepares answers to new review comments on your merge requests and waits for you;
- lints new commits on other people's merge requests and reports when there is an error or 10 or more warnings;
- investigates every new CI failure on the default branch or an open merge request, and offers a merge request that fixes flaky ones;
- once an hour, from 10:00 to 19:00 on weekdays, picks one slow or slower CI job and offers a merge request that speeds it up.

A check's first run records what already exists without starting anything, so an agent acts only on what changes after you install it.

```ts
export default {
  forges: { "git.example.com": "gitlab" },
  localAgents: {
    todai: {
      repositories: [
        {
          url: "github.com/owner/repo",
          path: "~/projects/repo",
          commands: ["pnpm test **", "pnpm --filter * test **"],
          setup: ["pnpm", "install", "--frozen-lockfile"],
        },
      ],
      model: "provider/model",
      extensions: ["~/path/to/provider-extension.ts"],
      maxRunningAgents: 3,
      ignoredAuthors: ["^ci-bot$"],
    },
  },
} satisfies PiExtensionsConfig;
```

```sh
node --experimental-strip-types extensions/local-agents/cli.ts install todai [--config package-config.ts]...
node --experimental-strip-types extensions/local-agents/cli.ts tick todai --dry-run [--check conflicts]...
node --experimental-strip-types extensions/local-agents/cli.ts uninstall todai
```

`install` runs `tick` every five minutes and logs to `~/.pi/agent/local-agents/<agent>/tick.log`. Outside pi, packages cannot contribute config through the event bus, so pass their config modules with `--config`; the user config is merged on top. `--dry-run` prints the triggers without starting runs or saving state.

Agent sessions load no extensions, skills, prompt templates, MCP servers, or context files beyond the guard, Rex status, auto-retry, and the configured `extensions`. The guard enforces each playbook's limits:

- Only the playbook's tools are available, and file tools only reach the worktree.
- Bash only runs commands matching the playbook's patterns: read-only commands, git, read-only `gh` and `glab`, and, for playbooks that change code, the repository's `commands`. Substitutions, variables, subshells, heredocs, and redirections to files are refused.
- Bash runs in a macOS sandbox that can write only to the worktree, the repository's git directory, temporary directories, and build caches. Environment files are unreadable outside the worktree.
- Before a playbook that runs the repository's code, the repository's `setup` command, such as `["pnpm", "install", "--frozen-lockfile"]`, installs dependencies in the same sandbox, and the prompt lists the `commands` the agent may run to build and test.
- Pushing, opening a merge request, and commenting go through the `push_branch`, `open_merge_request`, and `post_comment` tools. Only the rebase playbook pushes without asking. Reviews of other people's merge requests never run their code.

Add an agent under `extensions/local-agents/<name>/` and register it in `cli.ts`.

## Model failover and subagent safety

`auto-retry/` replaces Pi's built-in retry, so set `retry.enabled: false` in `settings.json`. Transient errors retry with backoff; provider failures can switch to the next healthy model. Set model chains in the [configuration](#configuration), or override them with `PI_FAILOVER_MODELS` and `PI_SUBAGENT_FAILOVER_MODELS` (comma-separated `provider/modelId` values).

`subagent-guard/` restricts agents by type. Read-only agents cannot edit files or run commands that change Git state. Review agents are launched through the audit and review commands, not the main session's `Agent` tool. Use `isolation: "worktree"` for parallel writer agents.

## Host a Clef endpoint

The [Clef Worker](workers/clef/README.md) uses Workers AI and AI Gateway behind Cloudflare Access, with a 24-hour email-authenticated session and no Cloudflare API token stored in Pi. Follow its setup guide before deployment.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/avenceslau/pi-extensions/tree/main/workers/clef)

## Development

```sh
npm ci
npm ci --prefix workers/clef
npm run check
```

`npm run check` runs formatting, type checks, tests, and repository-specific lint rules. CI runs these checks in separate workflows.
