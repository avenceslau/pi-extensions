import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const EXCLUDED_GLOBS = [
  "!**/.git/**",
  "!**/.env",
  "!**/.env.*",
  "!**/.dev.vars",
  "!**/.dev.vars.*",
  "!**/node_modules/**",
  "!**/target/**",
  "!**/vendor/**",
  "!**/dist/**",
  "!**/build/**",
  "!**/.next/**",
  "!**/coverage/**",
];

export interface LocalSearchResult {
  id: string;
  paths: string[];
}

export interface RemoteSearchResult {
  project: string;
  paths: string[];
}

export interface SearchResult {
  local: LocalSearchResult[];
  remote: RemoteSearchResult[];
  remoteAttempted: boolean;
  remoteForge?: Forge;
  remoteHost?: string;
}

export interface RepoInfo {
  id: string;
  origin?: string;
  branch?: string;
  commit?: string;
}

export interface GrepResult {
  matches: Array<{ path: string; line: number; text: string }>;
  limited: boolean;
}

export interface ReadResult {
  path: string;
  start: number;
  end: number;
  nextLine?: number;
  text: string;
  truncated: boolean;
}

interface LocalRepo {
  id: string;
  root: string;
}

type Forge = "github" | "gitlab";

interface CurrentRemote {
  forge: Forge;
  host: string;
  project: string;
  url: string;
  normalized: string;
}

interface ParsedRemote {
  host: string;
  project: string;
  normalized: string;
}

interface RepoServiceOptions {
  projectsRoot?: string;
  contextRoot?: string;
  runner?: CommandRunner;
}

interface CommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  limited: boolean;
  timedOut: boolean;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => Promise<CommandResult>;

export async function runCommand(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const maxBytes = options.maxBytes ?? 1024 * 1024;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let limited = false;
    let timedOut = false;
    let settled = false;

    const stop = () => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");

          return;
        } catch {
          // Fall through to killing the direct process.
        }
      }

      child.kill("SIGKILL");
    };

    const append = (current: Buffer, chunk: Buffer) => {
      if (current.length >= maxBytes) {
        limited = true;
        stop();

        return current;
      }

      const remaining = maxBytes - current.length;

      if (chunk.length > remaining) {
        limited = true;
        stop();
      }

      return Buffer.concat([current, chunk.subarray(0, remaining)]);
    };

    const onAbort = () => stop();

    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stop();
        }, options.timeoutMs)
      : undefined;

    if (options.signal?.aborted) {
      stop();
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeout) {
        clearTimeout(timeout);
      }

      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;

      if (timeout) {
        clearTimeout(timeout);
      }

      options.signal?.removeEventListener("abort", onAbort);

      if (options.signal?.aborted) {
        reject(new Error("Repository operation cancelled"));

        return;
      }

      resolvePromise({
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        limited,
        timedOut,
      });
    });
  });
}

function assertText(value: string, name: string, maxLength: number) {
  if (!value || value.length > maxLength || value.includes("\0")) {
    throw new Error(
      `${name} must contain 1-${maxLength} characters and no NUL bytes`,
    );
  }
}

function parseRemote(origin: string): ParsedRemote | undefined {
  const trimmed = origin.trim();
  let host: string;
  let project: string;

  if (!trimmed.includes("://")) {
    const ssh = trimmed.match(/^(?:[^@/:]+@)?([^:]+):(.+)$/);

    if (!ssh) {
      return undefined;
    }

    host = ssh[1]!;
    project = ssh[2]!;
  } else {
    try {
      const url = new URL(trimmed);
      host = url.protocol === "ssh:" ? url.hostname : url.host;
      project = url.pathname;
    } catch {
      return undefined;
    }
  }

  project = project.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = project.split("/");

  if (
    !host ||
    segments.length < 2 ||
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(segment) ||
        segment === "." ||
        segment === "..",
    )
  ) {
    return undefined;
  }

  return {
    host: host.toLowerCase(),
    project,
    normalized: `${host}/${project}`.toLowerCase(),
  };
}

function normalizeOrigin(origin: string): string | undefined {
  return parseRemote(origin)?.normalized;
}

function canonicalRemoteUrl(
  origin: string,
  expectedHost: string,
): string | undefined {
  const parsed = parseRemote(origin);

  if (!parsed || parsed.host !== expectedHost) {
    return undefined;
  }

  return `https://${parsed.host}/${parsed.project}`;
}

function isProtectedRepositoryPath(path: string): boolean {
  const segments = path.split(/[\\/]/).map((segment) => segment.toLowerCase());
  const filename = segments.at(-1);

  return (
    segments.includes(".git") ||
    filename === ".env" ||
    filename?.startsWith(".env.") === true ||
    filename === ".dev.vars" ||
    filename?.startsWith(".dev.vars.") === true
  );
}

function safeJson<T>(text: string, label: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${label} returned invalid or truncated JSON`);
  }
}

function commandError(label: string, result: CommandResult): Error {
  const detail = (result.stderr || result.stdout).trim().slice(0, 500);

  if (result.timedOut) {
    return new Error(`${label} timed out`);
  }

  return new Error(detail ? `${label} failed: ${detail}` : `${label} failed`);
}

export class RepoService {
  readonly projectsRoot: string;
  private readonly contextRoot: string;
  private readonly runner: CommandRunner;
  private readonly projectCache = new Map<number, string>();
  private cloneQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RepoServiceOptions = {}) {
    this.projectsRoot =
      options.projectsRoot ?? join(process.env.HOME ?? "", "projects");
    this.contextRoot = options.contextRoot ?? process.cwd();
    this.runner = options.runner ?? runCommand;
  }

  private async repos(): Promise<Map<string, LocalRepo>> {
    const repos = new Map<string, LocalRepo>();
    let entries;

    try {
      entries = await readdir(this.projectsRoot, { withFileTypes: true });
    } catch {
      return repos;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const root = join(this.projectsRoot, entry.name);

      try {
        const gitEntry = await lstat(join(root, ".git"));

        if (!gitEntry.isDirectory() && !gitEntry.isFile()) {
          continue;
        }

        repos.set(entry.name, { id: entry.name, root: await realpath(root) });
      } catch {
        continue;
      }
    }

    return repos;
  }

  private async repo(id: string): Promise<LocalRepo> {
    assertText(id, "Repository id", 200);
    const repo = (await this.repos()).get(id);

    if (!repo) {
      throw new Error(`Unknown local repository: ${id}`);
    }

    return repo;
  }

  private async git(repo: LocalRepo, args: string[], signal?: AbortSignal) {
    const result = await this.runner("git", ["-C", repo.root, ...args], {
      signal,
      timeoutMs: 5000,
      maxBytes: 64 * 1024,
    });

    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async list(): Promise<Array<{ id: string }>> {
    return [...(await this.repos()).keys()].sort().map((id) => ({ id }));
  }

  async info(id: string, signal?: AbortSignal): Promise<RepoInfo> {
    const repo = await this.repo(id);

    const [origin, branch, commit] = await Promise.all([
      this.git(repo, ["config", "--get", "remote.origin.url"], signal),
      this.git(repo, ["branch", "--show-current"], signal),
      this.git(repo, ["rev-parse", "HEAD"], signal),
    ]);

    const safeOrigin = origin ? normalizeOrigin(origin) : undefined;

    return {
      id,
      ...(safeOrigin ? { origin: safeOrigin } : {}),
      ...(branch ? { branch } : {}),
      ...(commit ? { commit } : {}),
    };
  }

  async search(
    query: string,
    includeRemote = false,
    signal?: AbortSignal,
  ): Promise<SearchResult> {
    assertText(query, "Search query", 200);
    const repos = await this.repos();
    const lowerQuery = query.toLowerCase();
    const pathsByRepo = new Map<string, Set<string>>();

    for (const id of repos.keys()) {
      if (id.toLowerCase().includes(lowerQuery)) {
        pathsByRepo.set(id, new Set());
      }
    }

    if (repos.size > 0) {
      const fileArgs = ["--files"];

      for (const glob of EXCLUDED_GLOBS) {
        fileArgs.push("--glob", glob);
      }

      fileArgs.push("--", this.projectsRoot);

      const fileResult = await this.runner("rg", fileArgs, {
        signal,
        timeoutMs: 12_000,
        maxBytes: 1024 * 1024,
      });

      if (
        fileResult.code === 0 ||
        fileResult.code === 1 ||
        fileResult.limited
      ) {
        for (const line of fileResult.stdout.split("\n")) {
          if (!line || !line.toLowerCase().includes(lowerQuery)) {
            continue;
          }

          const rel = relative(
            this.projectsRoot,
            isAbsolute(line) ? line : resolve(line),
          );
          const [id, ...rest] = rel.split(sep);

          if (!repos.has(id) || rest.length === 0) {
            continue;
          }

          const paths = pathsByRepo.get(id) ?? new Set<string>();

          if (paths.size < 3) {
            paths.add(rest.join("/"));
          }

          pathsByRepo.set(id, paths);
        }
      }

      const args = [
        "--files-with-matches",
        "--fixed-strings",
        "--ignore-case",
        "--max-filesize",
        "2M",
      ];

      for (const glob of EXCLUDED_GLOBS) {
        args.push("--glob", glob);
      }

      args.push("--", query, this.projectsRoot);

      const result = await this.runner("rg", args, {
        signal,
        timeoutMs: 12_000,
        maxBytes: 256 * 1024,
      });

      if (
        result.code === 0 ||
        result.code === 1 ||
        result.limited ||
        result.timedOut
      ) {
        for (const line of result.stdout.split("\n")) {
          if (!line) {
            continue;
          }

          const rel = relative(
            this.projectsRoot,
            isAbsolute(line) ? line : resolve(line),
          );
          const [id, ...rest] = rel.split(sep);

          if (!repos.has(id) || rest.length === 0) {
            continue;
          }

          const paths = pathsByRepo.get(id) ?? new Set<string>();

          if (paths.size < 3) {
            paths.add(rest.join("/"));
          }

          pathsByRepo.set(id, paths);
        }
      } else {
        throw commandError("Local source search", result);
      }
    }

    const local = [...pathsByRepo.entries()]
      .map(([id, paths]) => ({ id, paths: [...paths] }))
      .sort(
        (a, b) => b.paths.length - a.paths.length || a.id.localeCompare(b.id),
      )
      .slice(0, 15);

    const remoteAttempted = includeRemote || local.length === 0;
    const currentRemote = remoteAttempted
      ? await this.discoverCurrentRemote(signal)
      : undefined;
    const remote = currentRemote
      ? await this.remoteSearch(query, currentRemote, signal)
      : [];

    return {
      local,
      remote,
      remoteAttempted,
      ...(currentRemote
        ? { remoteForge: currentRemote.forge, remoteHost: currentRemote.host }
        : {}),
    };
  }

  private async discoverCurrentRemote(
    signal?: AbortSignal,
  ): Promise<CurrentRemote | undefined> {
    const originResult = await this.runner(
      "git",
      ["-C", this.contextRoot, "remote", "get-url", "origin"],
      { signal, timeoutMs: 5000, maxBytes: 64 * 1024 },
    );

    if (originResult.code !== 0) {
      return undefined;
    }

    const origin = parseRemote(originResult.stdout);

    if (!origin) {
      return undefined;
    }

    const repositoryUrl = `https://${origin.host}/${origin.project}`;

    const inspections = await Promise.allSettled([
      this.runner(
        "gh",
        ["repo", "view", repositoryUrl, "--json", "nameWithOwner,url"],
        {
          env: { ...process.env, GH_HOST: origin.host },
          signal,
          timeoutMs: 10_000,
          maxBytes: 512 * 1024,
        },
      ),
      this.runner("glab", ["repo", "view", repositoryUrl, "--output", "json"], {
        env: { ...process.env, GITLAB_HOST: origin.host },
        signal,
        timeoutMs: 10_000,
        maxBytes: 2 * 1024 * 1024,
      }),
    ]);

    if (signal?.aborted) {
      throw new Error("Repository operation cancelled");
    }

    const githubResult =
      inspections[0].status === "fulfilled" ? inspections[0].value : undefined;
    const gitlabResult =
      inspections[1].status === "fulfilled" ? inspections[1].value : undefined;

    const candidates: CurrentRemote[] = [];

    if (githubResult?.code === 0) {
      const repository = safeJson<{ nameWithOwner?: string; url?: string }>(
        githubResult.stdout,
        "GitHub repository lookup",
      );

      if (
        repository.url &&
        normalizeOrigin(repository.url) === origin.normalized
      ) {
        candidates.push({
          forge: "github",
          host: origin.host,
          project: origin.project,
          url: canonicalRemoteUrl(repository.url, origin.host)!,
          normalized: origin.normalized,
        });
      }
    }

    if (gitlabResult?.code === 0) {
      const repository = safeJson<{
        path_with_namespace?: string;
        web_url?: string;
      }>(gitlabResult.stdout, "GitLab repository lookup");

      if (
        repository.web_url &&
        normalizeOrigin(repository.web_url) === origin.normalized
      ) {
        candidates.push({
          forge: "gitlab",
          host: origin.host,
          project: origin.project,
          url: canonicalRemoteUrl(repository.web_url, origin.host)!,
          normalized: origin.normalized,
        });
      }
    }

    if (candidates.length > 1) {
      throw new Error(
        `Both gh and glab identified the current origin ${origin.normalized}`,
      );
    }

    return candidates[0];
  }

  private async remoteSearch(
    query: string,
    remote: CurrentRemote,
    signal?: AbortSignal,
  ): Promise<RemoteSearchResult[]> {
    return remote.forge === "github"
      ? this.githubSearch(query, remote, signal)
      : this.gitlabSearch(query, remote, signal);
  }

  private async githubSearch(
    query: string,
    remote: CurrentRemote,
    signal?: AbortSignal,
  ): Promise<RemoteSearchResult[]> {
    const env = { ...process.env, GH_HOST: remote.host };

    const [nameResult, codeResult] = await Promise.all([
      this.runner(
        "gh",
        ["search", "repos", query, "--json", "fullName,url", "--limit", "20"],
        {
          env,
          signal,
          timeoutMs: 20_000,
          maxBytes: 2 * 1024 * 1024,
        },
      ),
      this.runner(
        "gh",
        [
          "search",
          "code",
          query,
          "--json",
          "path,repository,url",
          "--limit",
          "20",
        ],
        {
          env,
          signal,
          timeoutMs: 20_000,
          maxBytes: 2 * 1024 * 1024,
        },
      ),
    ]);

    if (nameResult.code !== 0 && codeResult.code !== 0) {
      throw commandError(`GitHub search on ${remote.host}`, codeResult);
    }

    const matches = new Map<string, Set<string>>();

    if (nameResult.code === 0) {
      const repositories = safeJson<Array<{ fullName?: string; url?: string }>>(
        nameResult.stdout,
        "GitHub repository search",
      );

      for (const repository of repositories) {
        const url = repository.url
          ? canonicalRemoteUrl(repository.url, remote.host)
          : undefined;

        if (url) {
          matches.set(url, new Set());
        }
      }
    }

    if (codeResult.code === 0) {
      const results = safeJson<
        Array<{ path?: string; repository?: { url?: string } }>
      >(codeResult.stdout, "GitHub code search");

      for (const result of results) {
        const url = result.repository?.url
          ? canonicalRemoteUrl(result.repository.url, remote.host)
          : undefined;

        if (!url) {
          continue;
        }

        const paths = matches.get(url) ?? new Set<string>();

        if (result.path && paths.size < 3) {
          paths.add(result.path);
        }

        matches.set(url, paths);
      }
    }

    return [...matches.entries()]
      .map(([project, paths]) => ({ project, paths: [...paths] }))
      .sort(
        (a, b) =>
          b.paths.length - a.paths.length || a.project.localeCompare(b.project),
      )
      .slice(0, 15);
  }

  private async gitlabSearch(
    query: string,
    remote: CurrentRemote,
    signal?: AbortSignal,
  ): Promise<RemoteSearchResult[]> {
    const env = { ...process.env, GITLAB_HOST: remote.host };

    const [nameResult, blobResult] = await Promise.all([
      this.runner(
        "glab",
        [
          "repo",
          "search",
          "--search",
          query,
          "--output",
          "json",
          "--per-page",
          "20",
        ],
        { env, signal, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 },
      ),
      this.runner(
        "glab",
        [
          "api",
          "search",
          "--hostname",
          remote.host,
          "--method",
          "GET",
          "--raw-field",
          "scope=blobs",
          "--raw-field",
          `search=${query}`,
          "--raw-field",
          "per_page=20",
        ],
        { signal, timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 },
      ),
    ]);

    if (nameResult.code !== 0 && blobResult.code !== 0) {
      throw commandError(`GitLab search on ${remote.host}`, blobResult);
    }

    const matches = new Map<string, Set<string>>();

    if (nameResult.code === 0) {
      const projects = safeJson<Array<{ web_url?: string }>>(
        nameResult.stdout,
        "GitLab project search",
      );

      for (const project of projects) {
        const url = project.web_url
          ? canonicalRemoteUrl(project.web_url, remote.host)
          : undefined;

        if (url) {
          matches.set(url, new Set());
        }
      }
    }

    if (blobResult.code === 0) {
      const blobs = safeJson<Array<{ project_id?: number; path?: string }>>(
        blobResult.stdout,
        "GitLab code search",
      );
      const ids = [
        ...new Set(
          blobs.flatMap((blob) => (blob.project_id ? [blob.project_id] : [])),
        ),
      ].slice(0, 5);

      for (const id of ids) {
        await this.resolveGitLabProject(id, remote, signal);
      }

      for (const blob of blobs) {
        if (!blob.project_id) {
          continue;
        }

        const project = this.projectCache.get(blob.project_id);

        if (!project) {
          continue;
        }

        const paths = matches.get(project) ?? new Set<string>();

        if (blob.path && paths.size < 3) {
          paths.add(blob.path);
        }

        matches.set(project, paths);
      }
    }

    return [...matches.entries()]
      .map(([project, paths]) => ({ project, paths: [...paths] }))
      .sort(
        (a, b) =>
          b.paths.length - a.paths.length || a.project.localeCompare(b.project),
      )
      .slice(0, 15);
  }

  private async resolveGitLabProject(
    id: number,
    remote: CurrentRemote,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const cached = this.projectCache.get(id);

    if (cached) {
      return cached;
    }

    const result = await this.runner(
      "glab",
      ["api", `projects/${id}`, "--hostname", remote.host],
      { signal, timeoutMs: 10_000, maxBytes: 512 * 1024 },
    );

    if (result.code !== 0) {
      return undefined;
    }

    const project = safeJson<{ web_url?: string }>(
      result.stdout,
      "GitLab project lookup",
    );
    const url = project.web_url
      ? canonicalRemoteUrl(project.web_url, remote.host)
      : undefined;

    if (url) {
      this.projectCache.set(id, url);
    }

    return url;
  }

  async files(id: string, glob?: string, signal?: AbortSignal) {
    const repo = await this.repo(id);

    if (glob !== undefined) {
      assertText(glob, "File glob", 200);
    }

    const args = ["--files"];

    if (glob) {
      args.push("--glob", glob);
    }

    for (const excluded of EXCLUDED_GLOBS) {
      args.push("--glob", excluded);
    }

    args.push("--", repo.root);

    const result = await this.runner("rg", args, {
      signal,
      timeoutMs: 10_000,
      maxBytes: 256 * 1024,
    });

    if (result.code !== 0 && result.code !== 1 && !result.limited) {
      throw commandError("Repository file listing", result);
    }

    const paths = result.stdout
      .split("\n")
      .filter(Boolean)
      .map((path) =>
        relative(repo.root, isAbsolute(path) ? path : resolve(path))
          .split(sep)
          .join("/"),
      )
      .filter((path) => !isProtectedRepositoryPath(path))
      .slice(0, 500);

    return {
      paths,
      limited:
        result.limited ||
        result.stdout.split("\n").filter(Boolean).length > 500,
    };
  }

  async grep(
    id: string,
    query: string,
    glob?: string,
    signal?: AbortSignal,
  ): Promise<GrepResult> {
    assertText(query, "Grep query", 300);

    if (glob !== undefined) {
      assertText(glob, "File glob", 200);
    }

    const repo = await this.repo(id);
    const args = [
      "--json",
      "--fixed-strings",
      "--line-number",
      "--max-filesize",
      "2M",
    ];

    if (query === query.toLowerCase()) {
      args.push("--ignore-case");
    }

    if (glob) {
      args.push("--glob", glob);
    }

    for (const excluded of EXCLUDED_GLOBS) {
      args.push("--glob", excluded);
    }

    args.push("--", query, repo.root);

    const result = await this.runner("rg", args, {
      signal,
      timeoutMs: 10_000,
      maxBytes: 512 * 1024,
    });

    if (result.code !== 0 && result.code !== 1 && !result.limited) {
      throw commandError("Repository grep", result);
    }

    const matches: GrepResult["matches"] = [];

    for (const line of result.stdout.split("\n")) {
      if (!line || matches.length >= 100) {
        continue;
      }

      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: {
            path?: { text?: string };
            line_number?: number;
            lines?: { text?: string };
          };
        };

        if (
          event.type !== "match" ||
          !event.data?.path?.text ||
          !event.data.line_number
        ) {
          continue;
        }

        const path = relative(repo.root, event.data.path.text)
          .split(sep)
          .join("/");

        if (isProtectedRepositoryPath(path)) {
          continue;
        }

        matches.push({
          path,
          line: event.data.line_number,
          text: (event.data.lines?.text ?? "").trimEnd().slice(0, 500),
        });
      } catch {
        continue;
      }
    }

    return { matches, limited: result.limited || matches.length >= 100 };
  }

  async read(
    id: string,
    path: string,
    start = 1,
    lines = 200,
  ): Promise<ReadResult> {
    assertText(path, "File path", 1000);
    const pathSegments = path.split(/[\\/]/);

    if (isAbsolute(path) || pathSegments.includes("..")) {
      throw new Error("File path must stay within the repository");
    }

    if (isProtectedRepositoryPath(path)) {
      throw new Error(
        "Repository metadata and environment files cannot be read",
      );
    }

    if (
      !Number.isInteger(start) ||
      start < 1 ||
      !Number.isInteger(lines) ||
      lines < 1 ||
      lines > 400
    ) {
      throw new Error("start must be >= 1 and lines must be between 1 and 400");
    }

    const repo = await this.repo(id);
    const target = await realpath(resolve(repo.root, path));

    if (target !== repo.root && !target.startsWith(`${repo.root}${sep}`)) {
      throw new Error("File path escapes the repository");
    }

    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);

    try {
      const fileStat = await file.stat();

      if (!fileStat.isFile() || fileStat.size > 2 * 1024 * 1024) {
        throw new Error("File must be a regular text file no larger than 2MB");
      }

      const content = await file.readFile();

      if (content.includes(0)) {
        throw new Error("Binary files cannot be read");
      }

      const allLines = content.toString("utf8").split("\n");
      const selected: string[] = [];
      let bytes = 0;

      for (const line of allLines.slice(start - 1, start - 1 + lines)) {
        const lineBytes =
          Buffer.byteLength(line) + (selected.length > 0 ? 1 : 0);

        if (lineBytes > 64 * 1024 && selected.length === 0) {
          throw new Error("A single source line exceeds the 64KB read limit");
        }

        if (bytes + lineBytes > 64 * 1024) {
          break;
        }

        selected.push(line);
        bytes += lineBytes;
      }

      const end = start + selected.length - 1;
      const truncated = end < allLines.length;

      return {
        path,
        start,
        end,
        ...(truncated ? { nextLine: end + 1 } : {}),
        text: selected.join("\n"),
        truncated,
      };
    } finally {
      await file.close();
    }
  }

  async clone(
    project: string,
    allowedProjects: ReadonlySet<string>,
    dest?: string,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    project: string;
    cloned: boolean;
    alreadyLocal: boolean;
  }> {
    assertText(project, "Repository URL", 1000);

    if (!allowedProjects.has(project)) {
      throw new Error(
        "Repository must come from a prior remote search in this session branch",
      );
    }

    const parsedProject = parseRemote(project);

    if (!parsedProject || !project.startsWith("https://")) {
      throw new Error(
        "Repository must be an HTTPS URL returned by remote search",
      );
    }

    const currentRemote = await this.discoverCurrentRemote(signal);

    if (!currentRemote || parsedProject.host !== currentRemote.host) {
      throw new Error(
        "Repository URL must use the current repository's remote host",
      );
    }

    const destination = dest ?? basename(parsedProject.project);

    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(destination) ||
      destination === "." ||
      destination === ".."
    ) {
      throw new Error(
        "Destination must be one safe directory name under ~/projects",
      );
    }

    const task = async () => {
      const expectedOrigin = parsedProject.normalized;

      for (const repo of (await this.repos()).values()) {
        const origin = await this.git(
          repo,
          ["config", "--get", "remote.origin.url"],
          signal,
        );

        if (origin && normalizeOrigin(origin) === expectedOrigin) {
          return { id: repo.id, project, cloned: false, alreadyLocal: true };
        }
      }

      const projectsRoot = await realpath(this.projectsRoot);
      const target = join(projectsRoot, destination);

      try {
        await mkdir(target);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          throw new Error(`Destination already exists: ${target}`);
        }

        throw error;
      }

      const reservedTarget = await realpath(target);

      if (!reservedTarget.startsWith(`${projectsRoot}${sep}`)) {
        throw new Error("Clone destination escapes the projects root");
      }

      const command = currentRemote.forge === "github" ? "gh" : "glab";

      const env = {
        ...process.env,
        ...(currentRemote.forge === "github"
          ? { GH_HOST: currentRemote.host }
          : { GITLAB_HOST: currentRemote.host }),
      };

      try {
        const result = await this.runner(
          command,
          ["repo", "clone", project, reservedTarget],
          {
            env,
            signal,
            timeoutMs: 120_000,
            maxBytes: 2 * 1024 * 1024,
          },
        );

        if (result.code !== 0) {
          throw commandError("Repository clone", result);
        }

        const gitEntry = await lstat(join(reservedTarget, ".git"));

        if (!gitEntry.isDirectory() && !gitEntry.isFile()) {
          throw new Error(
            "Clone completed without a Git repository at the destination",
          );
        }

        const clonedOrigin = await this.git(
          { id: destination, root: reservedTarget },
          ["config", "--get", "remote.origin.url"],
          signal,
        );

        if (!clonedOrigin || normalizeOrigin(clonedOrigin) !== expectedOrigin) {
          throw new Error(
            "Cloned repository origin does not match the authorized remote repository",
          );
        }

        return { id: destination, project, cloned: true, alreadyLocal: false };
      } catch (error) {
        await rm(reservedTarget, { recursive: true, force: true });
        throw error;
      }
    };

    const result = this.cloneQueue.then(task, task);
    this.cloneQueue = result.catch(() => undefined);

    return result;
  }
}
