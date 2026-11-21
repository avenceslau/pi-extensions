import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { git, LITERAL_PATHSPECS } from "./git.ts";

const FETCH_TIMEOUT_MS = 10_000;
const SHIREI_STATE = join(homedir(), ".local", "share", "shirei", "state.json");

const ShireiStateSchema = Type.Object({
  stack_branches: Type.Optional(
    Type.Array(
      Type.Object({
        repo: Type.String(),
        branch: Type.String(),
        base: Type.String(),
      }),
    ),
  ),
});

export interface RepoChange {
  root: string;
  base: string;
  baseDescription: string;
  current: string;
  // The tree the previous audit saw, when it differs from current.
  previous?: string;
  // Empty when the whole tree is under review.
  paths: string[];
  files: string;
  lines: number;
  // Formatters applied to the changed files right before the audit.
  formatters: string[];
}

interface AuditBase {
  tree: string;
  description: string;
}

// The file may not exist yet, so its nearest existing ancestor locates the repository.
export async function locateFile(file: string): Promise<{ root: string; path: string } | undefined> {
  let dir = dirname(file);
  while (!existsSync(dir)) {
    dir = dirname(dir);
  }

  const output = await git(dir, ["rev-parse", "--show-toplevel", "--show-prefix"]).catch(() => undefined);
  if (!output) {
    return undefined;
  }
  const [root = "", prefix = ""] = output.split("\n");
  return { root, path: `${prefix}${relative(dir, file)}` };
}

// Maps each path git reports as changed or untracked to its status and content hash,
// so comparing two states shows which paths a command changed.
export async function worktreeState(root: string): Promise<Map<string, string>> {
  const status = await git(
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { untrimmed: true },
  );
  const state = new Map<string, string>();
  const fields = status.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.length < 4) {
      continue;
    }

    const code = field.slice(0, 2);
    state.set(field.slice(3), code);
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(code)) {
      i += 1;
      state.set(fields[i] ?? "", `${code} source`);
    }
  }

  const files = [...state.keys()].filter((path) => {
    return statSync(join(root, path), { throwIfNoEntry: false })?.isFile();
  });
  if (files.length === 0) {
    return state;
  }
  const hashes = (await git(root, ["hash-object", "--", ...files])).split("\n");
  files.forEach((path, i) => state.set(path, `${state.get(path)} ${hashes[i]}`));
  return state;
}

export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path));
}

// The snapshot is HEAD plus the given paths as they are on disk, so uncommitted work from other
// sessions in the same worktree stays out of it. Paths missing from both HEAD and disk are skipped,
// because `git add` rejects them; diffing against the snapshot still shows them as deleted.
export async function snapshotPaths(root: string, paths: string[]): Promise<string> {
  const index = join(tmpdir(), `pi-post-change-audit-${randomUUID()}`);
  const env = {
    GIT_INDEX_FILE: index,
    ...LITERAL_PATHSPECS,
  };

  try {
    await git(root, ["read-tree", "HEAD"], { env }).catch(() => git(root, ["read-tree", "--empty"], { env }));
    // Without paths, ls-files would list the whole worktree.
    if (paths.length === 0) {
      return await git(root, ["write-tree"], { env });
    }

    const present = await git(
      root,
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths],
      { env },
    );
    const existing = present.split("\0").filter(Boolean);
    if (existing.length > 0) {
      await git(root, ["add", "-A", "--", ...existing], { env });
    }
    return await git(root, ["write-tree"], { env });
  } finally {
    await rm(index, { force: true });
  }
}

async function stackParent(root: string, branch: string): Promise<string | undefined> {
  const state: unknown = await readFile(SHIREI_STATE, "utf8").then(JSON.parse, () => undefined);
  if (!Value.Check(ShireiStateSchema, state)) {
    return undefined;
  }

  const commonDir = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  for (const entry of state.stack_branches ?? []) {
    if (entry.branch !== branch) {
      continue;
    }
    const entryCommonDir = await git(
      entry.repo,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    ).catch(() => undefined);
    if (entryCommonDir === commonDir) {
      return entry.base;
    }
  }
  return undefined;
}

// Recomputed for every audit, so a rebase or pull between audits never brings upstream commits into the diff.
export async function auditBase(root: string): Promise<AuditBase> {
  const branch = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "");
  const originHead = await git(root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]).catch(() => "");
  const stackBase = branch ? await stackParent(root, branch) : undefined;
  const parent = stackBase ?? (originHead.replace(/^origin\//, "") || "main");
  await git(
    root,
    ["fetch", "--quiet", "origin", parent],
    {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeout: FETCH_TIMEOUT_MS,
    },
  ).catch(() => undefined);

  for (const ref of [`origin/${parent}`, parent]) {
    const commit = await git(root, ["merge-base", "HEAD", ref]).catch(() => undefined);
    if (commit) {
      return {
        tree: await git(root, ["rev-parse", `${commit}^{tree}`]),
        description: `${commit}, the merge base of HEAD and ${ref}`,
      };
    }
  }

  // Without an upstream to compare with, the audit covers the uncommitted changes.
  const head = await git(root, ["rev-parse", "-q", "--verify", "HEAD^{tree}"]).catch(() => {
    return git(root, ["hash-object", "-t", "tree", "/dev/null"]);
  });
  return { tree: head, description: "HEAD" };
}
