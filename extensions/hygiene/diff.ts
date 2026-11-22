export interface ChangedFile {
  path: string;
  // A for a new file, M otherwise. Deleted files have no new path and are dropped.
  status: "A" | "M";
  added: Set<number>;
  changedLines: number;
}

const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface HunkCursor {
  oldRemaining: number;
  newRemaining: number;
  newLine: number;
}

function readHunkLine(file: ChangedFile, cursor: HunkCursor, line: string): void {
  if (line.startsWith("\\")) {
    return;
  }

  if (line.startsWith("+")) {
    file.added.add(cursor.newLine);
    file.changedLines += 1;
    cursor.newLine += 1;
    cursor.newRemaining -= 1;

    return;
  }

  if (line.startsWith("-")) {
    file.changedLines += 1;
    cursor.oldRemaining -= 1;

    return;
  }

  cursor.newLine += 1;
  cursor.newRemaining -= 1;
  cursor.oldRemaining -= 1;
}

// Reads a unified git diff. Hunk line counts decide where each hunk ends, so an added line
// that itself starts with "+++" or "diff --git" is not taken for a header.
export function parseDiff(diffText: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | undefined;

  const cursor: HunkCursor = {
    oldRemaining: 0,
    newRemaining: 0,
    newLine: 0,
  };

  for (const line of diffText.split("\n")) {
    if (cursor.oldRemaining > 0 || cursor.newRemaining > 0) {
      if (current) {
        readHunkLine(current, cursor, line);
      }

      continue;
    }

    if (line.startsWith("diff --git ")) {
      current = {
        path: "",
        status: "M",
        added: new Set(),
        changedLines: 0,
      };
      files.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("new file mode")) {
      current.status = "A";
    } else if (line.startsWith("+++ ") && line !== "+++ /dev/null") {
      current.path = line.slice("+++ b/".length);
    } else if (line.startsWith("rename to ")) {
      current.path = line.slice("rename to ".length);
    }

    const hunk = HUNK_HEADER.exec(line);

    if (hunk) {
      const [, oldCount, newStart, newCount] = hunk;
      cursor.oldRemaining = Number(oldCount ?? 1);
      cursor.newLine = Number(newStart);
      cursor.newRemaining = Number(newCount ?? 1);
    }
  }

  return files.filter((file) => file.path !== "");
}

// Contiguous runs of added lines, for checks that have no parser-built candidates.
export function addedRuns(file: ChangedFile): { line: number; endLine: number }[] {
  const runs: { line: number; endLine: number }[] = [];

  for (const line of [...file.added].sort((a, b) => a - b)) {
    const last = runs.at(-1);

    if (last && line === last.endLine + 1) {
      last.endLine = line;
      continue;
    }

    runs.push({ line, endLine: line });
  }

  return runs;
}

export function countAdded(added: Set<number>, line: number, endLine: number): number {
  let count = 0;

  for (let current = line; current <= endLine; current += 1) {
    if (added.has(current)) {
      count += 1;
    }
  }

  return count;
}
