import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The CLI runs under plain Node from the installed package, where only `dependencies` are installed: pi's own
// packages and dev dependencies are missing there, even though they resolve in a development checkout.

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const RUNTIME_IMPORT =
  /^(?:import|export)(?!\s+type\b)[^'"]*?\bfrom\s+["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

function packageName(specifier: string): string {
  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function runtimePackages(entry: string): Set<string> {
  const packages = new Set<string>();
  const visited = new Set<string>();
  const pending = [entry];

  while (pending.length > 0) {
    const file = pending.pop();

    if (file === undefined || visited.has(file)) {
      continue;
    }

    visited.add(file);

    for (const match of readFileSync(file, "utf8").matchAll(RUNTIME_IMPORT)) {
      const specifier = match[1] ?? match[2];

      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier));
      } else {
        packages.add(packageName(specifier));
      }
    }
  }

  return packages;
}

test("the local-agents CLI imports only Node builtins and the package's dependencies", () => {
  const manifest: { dependencies: Record<string, string> } = JSON.parse(
    readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8"),
  );

  const available = new Set([
    ...Object.keys(manifest.dependencies),
    ...builtinModules,
  ]);

  const missing = [
    ...runtimePackages(join(PACKAGE_ROOT, "extensions/local-agents/cli.ts")),
  ].filter((name) => !name.startsWith("node:") && !available.has(name));

  assert.deepEqual(missing, []);
});
