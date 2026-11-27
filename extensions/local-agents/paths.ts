import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";

export function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return homedir() + path.slice(1);
  }

  return path;
}

export function isInside(root: string, path: string): boolean {
  const offset = relative(root, path);

  return !offset.startsWith("..") && !isAbsolute(offset);
}

export function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
