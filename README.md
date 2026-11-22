# pi-extensions

Pi extensions, agents, skills and prompts for reviewed, restrained agent work: a post-change audit, a hygiene linter,
auto-retry with model failover, guards for subagents, and review helpers. Everything specific to one organization,
such as model gateways, internal tools and extra auditors, comes from [config](#config) and from other packages
through [extension points](#audit-contributions).

```sh
pi install git:github.com/avenceslau/pi-extensions
```

Run `/reload` in Pi after updating the package.

## Development

`npm run check` runs the extension and Worker tests, applies the vendored anti-slop rules to all owned TypeScript,
and runs the Worker's Oxfmt, Durability lint and TSRS checks. The anti-slop warning ceiling prevents the current
migration baseline from growing; `npm run lint:report` prints those findings. Readable-spacing and Worker durability
rules already fail immediately.

## Host your own Clef endpoint

The [Clef-only Worker](workers/clef/README.md) uses Workers AI and AI Gateway behind Cloudflare Access,
with a 24-hour email-authenticated session and no Cloudflare API token stored in Pi.
The Worker denies requests until you finish the documented Access setup.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/avenceslau/pi-extensions/tree/main/workers/clef)

## Config

`extensions/shared/config.ts` gives the extensions one config: what installed packages contribute, overridden by
`~/.pi/agent/pi-extensions.ts`. Without either, each extension falls back as its section says. A package
contributes by listening on the `pi-extensions:config` event and calling `contribute`:

```ts
pi.events.on("pi-extensions:config", (request) => request.contribute({ forges: { "git.example.com": "gitlab" } }));
```

The user config is a TypeScript module whose default export is the config, typed by `PiExtensionsConfig` from
`extensions/shared/config-types.ts`, which imports nothing, so editors resolve it without this package's dependencies:

```ts
// ~/.pi/agent/pi-extensions.ts
import type { PiExtensionsConfig } from "./git/github.com/avenceslau/pi-extensions/extensions/shared/config-types.ts";

export default {
  clef: {
    url: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef`,
    auth: { header: "authorization", token: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
  },
  models: {
    primary: ["provider/model-a", "provider/model-b"],
    subagent: ["provider/model-a"],
    subagentForbidden: ["expensive"],
    unavailable: "\\b526\\b",
    agents: { "comment-review": "provider/model-b" },
  },
  forges: { "git.example.com": "gitlab" },
  agentRoles: { readOnly: ["security-review"], review: ["security-review"] },
} satisfies PiExtensionsConfig;
```

`extensions/user-config/index.ts` reads it at session start, so edits apply after `/reload`. Node strips its types, so it
can use only erasable syntax (no `enum` or parameter properties). Contributions and the file are checked against
the same schema at runtime; an invalid file is ignored with an error naming the offending field.

`clef` is [Clef](https://developers.cloudflare.com/ai/models/@cf/cloudflare/clef/), Cloudflare's decision model on
Workers AI, which the hygiene linter and the audit ask yes/no questions about code. The example runs it on your own
Cloudflare account through the Workers AI REST API, with an API token that can run Workers AI models; set
`model: "clef-flash"` for the smaller, faster model. `auth.command` runs a program that prints the token instead,
for tokens that expire. Without `clef`, the judged hygiene rules are skipped and the audit runs its fallbacks.

A later source replaces `clef` whole, overrides `models`, `models.agents` and `forges` key by key, and adds to the `agentRoles` lists.

## Opening reviews

`/pr [branch]` opens the branch's pull or merge request in the browser through `gh` or `glab`, using the branch's
upstream remote, then `origin`, then any other remote. `github.com` and `gitlab.com` work as they are; other hosts
need an entry under `forges` in the [config](#config), such as `{ "forges": { "git.example.com": "gitlab" } }`.

## Side sessions, focus, spend and other helpers

- `/btw <question>` opens a forked Pi session in a Herdr pane to the right, with the question already asked, so the
  main session keeps going; `/merge` in the side session sends its answer back. The side session runs on
  `models.extensions.btw` from the [config](#config), or on the parent's model.
- `session-focus/` shows `Working on <feature> | Doing <task>` below the prompt. Each message you send goes, in the
  background, to `models.extensions["session-focus"]` together with the current label, and that model updates it
  through a `set_focus` tool; without that model the label changes only through `/focus feature <text>`,
  `/focus task <text>` and `/focus clear`. The label is stored in the session, so it survives `/resume` and follows
  `/tree` branches.
- `/spend` shows what your sessions cost, from the usage recorded in their session files.
- `compact-footer/` replaces the footer with a compact one: directory and branch, token counts, cache hit rate,
  cost, context use against the window, and the model with its thinking level.
- `bash-timeout/` makes `timeout` a required parameter of the `bash` tool.
- `rex-agent-status/` reports working, blocked, finished and failed states to Rex when Pi runs in a Rex block.
- `repo-codemode/` adds `repo_search`, which finds repositories under `~/projects` and falls back to the current
  repository's GitHub or GitLab forge, and `repo_execute`, which runs JavaScript against them in a QuickJS sandbox.

## Skills and prompts

The package ships these skills from `skills/` and prompt commands from `prompts/`:

- `code-restraint`, `refactoring`, `pr-description` and `glab`, loaded by the model when a task matches.
- `bro`, `recall` and `affirmations`, which only run when you call them (`disable-model-invocation`).
- `/remember <what we talked about>` searches past Pi sessions for that conversation and says how to reopen it.
- `/affirmations` reads every main session and the human comments on every merged review in the repositories listed in `~/.config/affirmations/repos` (one `host/path` per line), and proposes moving each recurring correction into the harness, a judged hygiene rule, or a deterministic rule. It writes the report to `~/.plans/affirmations/<date>.md` and implements only the items you pick. Merged reviews are cached in `~/.cache/affirmations/reviews`.

The skills' scripts use macOS `date` and `stat` flags.

## Manual modes

Subagents and code review are enabled at the start of every session.

```text
/subagents on|off|status
/review on|off|status
```

Press `Ctrl+Shift+A` to toggle both modes together. The slash commands still control each mode independently. Scheduled subagents remain disabled.

## Auto-retry and failover

`auto-retry/` replaces pi's built-in retry, so keep `retry.enabled: false` in `settings.json`. When a response fails with `stopReason: "error"`, the retry happens at `agent_before_settle`, inside the same run, so `session.prompt()` (and with it a subagent's run) does not return until the retry finishes. Transient errors (connection errors and resets, timeouts, `terminated`, cut-off streams, `This operation was aborted`, overloaded, 500/502/503/504, and genuine 429 rate limits) are retried on the same model with backoff from 2 seconds doubling to a 2-minute cap. Errors that mean a provider is broken fail over immediately: an error matching `models.unavailable` (such as a gateway's 526) marks that model unavailable, and 401, `invalid_token`, API key resolution failures, and a 429 spending limit mark the whole provider unavailable. Three consecutive transient failures on one provider also fail over. Unavailable marks last 10 minutes and are shared by every session in the process, including subagents. Failover switches to the next healthy model after the current one, notifies, and continues the run; when none is healthy, transient errors keep backing off on the current model and provider failures stop with a notification. Context overflow, 400 `invalid_request_error`, and unrecognized errors are never retried, and aborted responses are left alone.

The primary chain is `models.primary` from the [config](#config). Subagent sessions, recognized by their `<agentType>#<8 hex>` session name, use `models.subagent`, without any model matching `models.subagentForbidden`. Comma-separated `provider/modelId` lists in `PI_FAILOVER_MODELS` and `PI_SUBAGENT_FAILOVER_MODELS` override them. With no chain, failures retry on the current model only. Press `Esc` during the backoff to cancel it; typing a message cancels it as well. Retry messages and the failed responses are hidden from the model's context.

## Subagent guard

`subagent-guard/` applies rules by subagent type, read from the session name pi-subagents assigns:

- `research`, `Explore`, `review`, `code-restraint-review`, `comment-review`, `refactor-review`, `shepherd-refactor-review`, `Plan`, and the types listed under `agentRoles.readOnly` in the [config](#config) are read-only: `write` and `edit` are blocked, as are bash commands that change git state (commit, reset, checkout, push, stash, rebase, merge, worktree add/remove, tag, and similar), `sed -i`, `perl -pi`, `rm`, `mv`, and redirects into files other than `/dev/null`, `/tmp`, and the macOS temp directories. On macOS every other bash command runs under `sandbox-exec` with writes denied under `$HOME` except caches (`~/Library/Caches`, `~/.cache`, `~/.npm`, `~/.local/share/pnpm`, `~/.cargo`, `~/go`, `~/.bun`).
- `correctness-review` may write files but cannot change git history or state.
- No subagent may use autoresearch's experiment tools.
- Writer subagents lock the Git checkout they first edit until they settle; another subagent that tries to edit the same checkout is told to run with `isolation: "worktree"`. The main session is never locked.

The main session cannot launch review agents through the `Agent` tool: `correctness-review`, `review`, `code-restraint-review`, `refactor-review`, `shepherd-refactor-review`, `comment-review`, and the types listed under `agentRoles.review` are always blocked there, whatever the user's message says, because reviews run only from the post-change audit or from the user's `/audit`, `/correctness`, and `/review-mr` commands. Those spawn their reviewers over pi-subagents' event bus, which the guard does not see, and subagent sessions are not restricted. The main session also cannot spawn an agent with the same prompt, after collapsing whitespace, as one it spawned in the last 10 minutes; resumes are exempt, and a spawn that failed or that another extension blocked can be retried.

In the main session, reading a subagent's `tasks/<id>.output` transcript with `read` or `bash`, or stopping the agent, marks its result as read so pi-subagents does not deliver the completion notification on top. An `Agent` call whose `model` argument would be silently overridden by the agent file's `model:` frontmatter (`.pi/agents`, `.agents/agents`, then `~/.pi/agent/agents`) is blocked, as is any call whose effective model (the pin, then the `model` argument, then `models.agents[type]`, then the session's model) matches `models.subagentForbidden`. A requested name that is part of the pinned model, such as `opus`, is accepted. A call with neither a pin nor a `model` argument gets `models.agents[type]` as its `model`; the post-change audit and Shepherd pass the same model when they spawn their agents.

## Post-change audit

Press `Ctrl+Shift+R` (or run `/audit`) when the session is idle to have the `post-change-audit` extension review the changes this session made, regardless of size. The footer shows `audit:ctrl+shift+r` next to the mode indicators as a reminder.

Every audit spawns the auditors other packages contribute (see [Audit contributions](#audit-contributions)) and runs the [hygiene linter](#hygiene-linter) in process over the scoped diff, in place of `code-restraint-review`; on fix rounds it lints only the hunks since the previous audit, and it drops formatter-owned rules when a formatter ran. Its code-restraint diagnostics arrive as `CR1`, `CR2`, ... and its refactor-rule diagnostics as `HR1`, `HR2`, ..., with the linter's own rule names such as `refactor/tangled-branching`, and Clef-judged ones carry their probability in the message. When any Clef call fails, the local diagnostics are still delivered, and for diffs of at least 50 changed lines `code-restraint-review` runs as well.

Once the linter has run, the audit spawns `refactor-review` and, when the linter found at least one comment, `comment-review`. `refactor-review` is not gated on the linter: on 20 recorded audits, no gate on its diagnostics and the change size caught 13 of the 15 changes where refactor-review made a valid finding without running it on 18 of the 20, because the findings it missed were short or cross-file repetition, a shadowed name, and logic in the wrong function. Its prompt lists the linter's diagnostics and comment candidates by file and line as already reported, and tells it not to review comments at all. Its findings are also filtered: one whose rule names nesting, tangled branching, cognitive complexity, responsibilities or a long function is dropped when it overlaps a `refactor/tangled-branching`, `refactor/mixed-responsibilities` or `code-restraint/deep-nesting` diagnostic on the same file; one whose rule names duplication or repeated or copied code is dropped when it overlaps a `refactor/duplication` diagnostic; and one whose rule names a comment is dropped when it overlaps a comment candidate. Dropped findings are listed in refactor-review's notes.

`comment-review` judges every comment the scoped diff added, and every unchanged comment directly above or inside a statement whose lines changed; no kind is exempt, doc comments, `SAFETY:` notes and TODOs included (tool directives such as `// @ts-expect-error` and `// eslint-disable` are not comments to the linter). Its prompt gives each comment's id, file, lines, whether it was added or left stale, and the enclosing function or statement clamped to 12 lines before and 30 after, with comments whose excerpts overlap sharing one. For each it returns `delete`; `replace`, with the code change that makes the comment unnecessary (a rename, an extracted function, an assertion, a test); or `keep`, only with a reason the code cannot express (an external constraint, a linked bug or ticket, a specification or protocol detail, or the reason for a counterintuitive choice). `delete` and `replace` become warnings `CM1`, `CM2`, ... with rule `code-restraint/comment` on the comment's exact lines; `keep` verdicts are listed with their reasons in the reviewer's notes. Verdicts are cached in `~/.cache/pi-hygiene/clef.sqlite` by a SHA-256 of the prompt version, whether the comment is added or stale, its text, and its excerpt, so a comment already judged in the same code is not sent again and keeps its verdict. Up to 50 comments go to one agent and at most three agents run, splitting by file in path order; past 150, added comments go first and the rest are named in the notes as not judged. The agent definition ships in this package's `agents/comment-review.md`, which `package.json` declares to pi-subagents under `pi-subagents.agents`, so `pi install` and `pi update` provide it: the model `models.agents["comment-review"]` names (the session's model without one) at medium thinking, at most 8 turns, only `read`, `grep`, `find`, `ls` and `report_findings`, and only the `post-change-audit` extension loaded. `agents/` also holds `Explore`, `Plan`, `research`, `general-purpose`, `review`, `refactor-review`, `code-restraint-review` and `shepherd-refactor-review`, none pinned to a model; a file of the same name in `.pi/agents`, `.agents/agents` or `~/.pi/agent/agents` still wins over them.

The audit covers only paths the session touched: files written with `edit` or `write`, and files whose `git status` entry or content hash changed across a `bash` call. Subagents, including nested ones, report the paths they touch to the root session, so one audit covers all delegated work, while uncommitted edits from other sessions in the same worktree stay out. Each audit recomputes its base as the merge base of `HEAD` and `origin/<parent>`, where the parent is the Shirei stack base when the branch is a tracked stack branch (from `~/.local/share/shirei/state.json`) and origin's default branch otherwise; it fetches the parent first (10-second limit) and falls back to the local ref. It then snapshots `HEAD` plus the touched paths into a throwaway index and diffs only those paths, so rebases and pulls never bring upstream commits into the audit. When the session has touched nothing in its repository, `/audit` covers the uncommitted changes there. Before diffing, the audit runs the repository's formatter on the touched files: the first of oxfmt, Biome, dprint, or Prettier configured at the repository root or listed in its `package.json` (preferring `node_modules/.bin`), plus `rustfmt` for `.rs` and `gofmt` for `.go` files; a missing formatter is skipped with a notification, and reviewers are told not to report layout the formatter owns.

Reviewers report through a `report_findings` tool that this extension registers only in auditor sessions, so a late final message (for example after an extension's notification) cannot replace the findings; a reviewer that finishes without calling it is reported as a failure, and its final message is passed on, truncated, as that reviewer's `text` with status `no-report`. The tool refuses a report that no audit is waiting for, and says so when the requesting session still runs an older copy of this extension (for example after `pi update` without `/reload`). Findings are sent back as a follow-up turn whose content is one minified JSON document kept small for the model's context: diagnostics as rows under a `cols` header (`id`, `line`, `sev`, `rule`, `msg`, `fix`, and `frame` in stacks), grouped by file and sorted by line. `id` is the reviewer's prefix and a number (a contributed auditor's own prefix, `CR1` code restraint and the linter's code-restraint rules, `HR1` the linter's refactor rules, `CM1` comments, `R1` refactoring, `C1` correctness); a reviewer that already wrote its id that way keeps it, and any other id is replaced by the finding's position in the report. `line` is a number, or `line:column-endLine` when a reviewer gave a span; `sev` is `e` (critical and high), `w` (medium), or `i` (low); `rule` is namespaced by reviewer and slugged from its rule name, such as `code-restraint/one-use-helper`, except that a rule already written as `namespace/name`, as the linter and `comment-review` write them, is kept; fixes are cut to five lines, and unset trailing cells are left out. The rest is the round, one-line instructions, settled decisions, the names of clean reviewers, and the status of any reviewer that failed, did not report, or left notes or batches; empty fields are omitted. The diff commands and the sorted diagnostics with uncut fixes travel in the message's `details`, which only the renderer sees; messages without them, such as those from older sessions, are shown as raw content. The TUI renders it like linter output grouped by file with a `✖ 3 problems (1 error, 2 warnings)` summary, collapsed beyond 15 lines; `Ctrl+O` expands it with the full fixes, the diff commands, and the pretty-printed JSON the model received. The agent records each outcome with `audit_decision` (`fixed` or `declined`, with a reason); findings left undecided count as fixed when the next audit starts. Decisions are kept on the session branch (the 30 most recent, persisted as `post-change-audit:ledger` entries and rebuilt on reload) and listed to later reviewers as settled, and later audits also point reviewers at the hunks that changed since the previous audit, so fix rounds do not flip-flop. The agent is told never to add formatter-ignore comments or formatter config changes to satisfy a finding. Touched paths are cleared once an audit completes.

The audit also spawns `correctness-review` for scoped diffs of 100 or more changed lines when Clef rates the scoped diff as needing one (probability at least 0.8). It runs at most once per user message (not on fix rounds, and not while an earlier one is still running), at medium thinking with a 30-turn cap, reading and reasoning only, without writing or running tests; those are left to `/correctness`. It runs beside the other auditors but delivers its findings in a separate follow-up, so the rest of the audit does not wait for it and later audits can start while it runs; a new user message does not cancel it. It sees that diff at the configured Clef URL (see [Config](#config); a JWT from the token command is reused until five minutes before it expires), with JWTs, GitHub, GitLab and AWS keys, private keys, and `token=`-style values redacted, and flags concurrency, ordering, retries, timers, caching, storage, state machines, failure paths, and cleanup while passing documentation, renames, dependency bumps, and test-only changes. Clef rejects a state over 65,529 tokens instead of truncating it, so the diff is cut to 200,000 characters and cut in half once more when Clef still rejects it; the notification with the score says when Clef saw a truncated diff. When Clef is unreachable, it runs for every scoped diff of 100 or more changed lines. For `/correctness` and `/review-mr`, each repository's section of its prompt also gets the context other packages contribute, such as a worktree to write tests in; contributed context is released when the review ends.

Run `/correctness [what to focus on]` when the session is idle to run `correctness-review` on demand, without asking Clef. It covers what `/audit` would, the paths the session touched diffed against the freshly computed merge base, or the uncommitted changes when the session touched nothing in its repository, but always the whole change rather than the hunks since the last audit; it does not run formatters and leaves the touched paths for the next audit. It uses the same contributed context and `report_findings` path, passes the trailing text to the reviewer as the user's request, and delivers findings in the same JSON message with `C` ids for `audit_decision`. It refuses to start while an audit or another `/correctness` runs, while the session or non-audit background subagents are busy, or when `/subagents` or `/review` is off; turning either off cancels it. While it runs, the automatic audit does not start and `/audit` refuses. The main agent cannot spawn `correctness-review` itself (see [Subagent guard](#subagent-guard)).

Run `/review-mr <link> [what to focus on]` to run the auditors on a GitHub pull request or GitLab merge request someone else authored (github.com, gitlab.com, and hosts named under `forges` in the [config](#config) only; at most three links per command). Authorship is checked with `gh api user` / `glab api user`, and messages are never scanned for review links. When the linked review is open, the extension walks its stack through the forge API: down through the open review whose source branch is its target until the default branch, and up through the open review that targets its source branch, stopping when a branch has no open review or more than one, at ten frames. The repository is cached as a blobless bare clone under `~/.cache/pi-post-change-audit/repos`, and the top frame's head is checked out into a temporary detached worktree diffed against its merge base with the bottom frame's target branch. The stack is reviewed once, with a frame table giving each frame's own diff, and every finding names its frame; links into a stack that is already under review are skipped. Instead of the local audit set, a review gets `correctness-review` (always, with contributed context), the hygiene linter over the whole review diff, `comment-review`, and `refactor-review` with a scope-creep pass, with `code-restraint-review` only as the Clef fallback; each sees the title, description, and the command, and is told never to comment on the review, edit it, or push. The findings come back as the same JSON message, with instructions to write the review: a short verdict, correctness findings with where, what happens, proof, production reachability, and what to ask for, disproved doubts, a scope-creep table with a proposed split, numbered refactorability, code-restraint and comment items, and where the tests and batches are. There are no fix rounds. Turning off `/subagents` or `/review` cancels running reviews and stops new ones.

The automatic audit is on by default; press `Ctrl+Shift+S` to toggle it for the session (the footer shows `auto-audit:on|off`). When on, the audit runs once the root session settles with no non-audit background subagents still running, so the main session and every subagent are done, and only when the session or a subagent changed files since the root session last settled: a turn that edits nothing starts no audit, and work left unaudited, for example after the fix-round limit, waits for the next turn that edits files. It skips deltas under 50 changed lines and runs at most two fix rounds per user message; findings go back to the root session. While it is on, touched paths accumulate across user messages until an audit covers them, including edits background subagents made before the message; while it is off, each user message clears them, so `/audit` covers only the latest message. Only a user message cancels an in-flight audit; extension pushes and subagent notifications that wake the agent do not. A user message that asks for no review (for example "no code review", "skip the audit", "don't review this") turns the automatic audit off until the next user message: the work done meanwhile is marked as audited instead of being reviewed later, and the footer shows `audit:skipped (opt-out)`. A message of 12 or more characters that the keywords miss is also sent to Clef in the background as soon as it arrives, and it counts as an opt-out when Clef rates it at least 0.6 as asking to skip the review; the automatic audit waits at most 3 seconds for that answer, a notification gives the Clef score when Clef was the reason, and a Clef failure or timeout falls back to the keywords with at most one warning per session. `/audit` and `Ctrl+Shift+R` still work. Worktrees of isolated subagents that were removed before the audit are skipped, since their changes live on a branch. The audit shortcut refuses to run while non-audit background subagents run, and auditor subagents are never audited.

## Audit contributions

Other packages add to the post-change audit by listening on the `post-change-audit:contributions` event, which the
audit emits each time it starts:

```ts
pi.events.on("post-change-audit:contributions", (request) => {
  request.addAuditor({ type: "security-review", title: "Security", idPrefix: "SX", focus: "Audit the changes for injection." });
  request.addCorrectnessContext(async (change, { signal, notify }) => ({
    lines: [`Test worktree: ${await makeWorktree(change.root, change.current, signal)}`],
    instructions: "List every test run URL with its result in batches.",
    release: async () => removeWorktree(),
  }));
});
```

A contributed auditor runs beside the built-in ones on every audit of the session's changes; its agent definition
must allow `ext:post-change-audit/report_findings`, and its findings get its `idPrefix`. Correctness context is asked
for once per repository, only by `/correctness` and `/review-mr`; its `lines` join that repository's section, each
distinct `instructions` is added once, and `release` runs when the review ends. The types are in
`extensions/post-change-audit/contributions.ts`.

## Hygiene linter

`extensions/hygiene` lints changed code against the code-restraint and refactoring rules. Exact local checks cover same-line bodies, deep nesting, swallowed errors, short, ceremony and generic names (placeholders such as `data` or `tmp`, time and size constants without a unit, booleans that do not read as a question), magic offsets, unnamed numbers, duplication, forwarding chains, flat file clusters, and dense lines (info only). Clef judges candidates the parsers build in short snippets batched across files: new names, shown with the added lines that use them, asked whether they are coined or undescriptive. It also judges options, one-use helpers, trivial wrappers (both info only, averaged over two wordings), tangled branching, long functions, and branches in tests in windows of nearby code. Files without a parser, and rules without a candidate builder, get questions about spans of added lines that are halved while Clef keeps flagging them. States are redacted, kept under 200K characters, and sent 64 questions per call; answers are cached in `~/.cache/pi-hygiene/clef.sqlite` by rule, rule version, candidate text, and question, so unchanged code keeps its verdict.

Comments are not judged by the linter. The `code-restraint/comment` rule is checked by the post-change audit's [`comment-review` agent](#post-change-audit); the linter only builds its candidates, from the TypeScript parser, the Rust comment lexer, or, for Go, Python, C-family, shell, Ruby and Lua files, a lexer that skips string literals, with consecutive line comments merged into one. `/hygiene` and `hygiene_lint` report how many comments were left to it, and `--json` includes the candidates. One rule covers added and stale comments because the agent gives both the same three verdicts and the finding names one rule; the trait file holds the requirement, the examples and the fix the agent's prompt quotes.

```text
/hygiene [ref | paths...]
node --experimental-strip-types extensions/hygiene/cli.ts [--diff file|-] [--root dir] [paths...] [--json] [--check] [--fail-on error|warning|info] [--no-clef]
```

The `hygiene_lint` tool takes `paths`, a `diff`, or a `base` ref; with none, it and `/hygiene` lint the uncommitted changes plus untracked files. `--check` exits 1 when a diagnostic is at or above `--fail-on` (default `warning`). Each rule is a TypeScript trait file (`name`, `version`, `subject`, `requirement`, `purpose`, `candidate`, `check` (`local`, `clef`, `agent` or `llm`), `category`, `severity`, `fix`, a `probabilityThreshold` for clef rules, and optionally `sizeThreshold` for local rules, `alternate`, `skipWhenFormatted` and `body`) that lives in `extensions/hygiene/traits/<group>/`, next to the linter, so rules are reviewed and shipped with it; the `Trait` type in `extensions/hygiene/traits.ts` checks each file, and a new file must be added to the `TRAITS` list there. Bump `version` after editing a rule to drop its cached answers.

TypeScript parsing needs the package's `typescript` dependency, which `pi install` and `pi update` install; in a checkout, run `npm install`. Rust parsing uses a `syn` program built on first use with `cargo build --release --offline` into `~/.cache/pi-hygiene`; without cargo or the crates in the local cargo cache, Rust files get only the parser-free checks and the output says so. Clef is called through `extensions/shared/clef.ts`, the same caller the audit uses, at the URL and with the token from the `clef` config; without one, or with `--no-clef`, only the local rules run and `/hygiene` says so. Outside pi the CLI reads `clef` from `~/.pi/agent/pi-extensions.ts` only, since packages contribute config only inside pi.

## Shepherd

Shepherd monitors selected open GitHub pull requests and GitLab merge requests that have registered Shirei worktrees.

```text
/shepherd start
/shepherd select
/shepherd status
/shepherd refresh
/shepherd dispatch [review] [instructions]
/shepherd retry [review]
/shepherd stop
```

Starting Shepherd discovers eligible reviews and opens a selector. Workers run in the existing review worktree, automatically rebase onto the review target when needed, and never push. Interrupted Shepherd rebases can be resumed by dispatching the review again. Any completed worker changes trigger parallel read-only correctness and refactoring reviews through `@tintinweb/pi-subagents`. Correctness findings can drive at most three corrective loops; unresolved, failed, or refactoring-only work is reported back to the coordinator. Correctness reviewers are capped at 35 turns, refactoring reviewers at 20, and workers at 80. CI retries require confirmation and are limited to two attempts per job and review HEAD.

Shepherd also registers `shepherd_status`, `shepherd_dispatch`, and `shepherd_retry_ci` for agent-driven coordination.
