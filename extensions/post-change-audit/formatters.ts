import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";

// The first match wins, so a leftover Prettier config does not override the formatter that replaced it.
const JS_FORMATTERS = [
  {
    name: "oxfmt",
    dependency: "oxfmt",
    configs: [".oxfmtrc.json", ".oxfmtrc.jsonc"],
    args: ["--write", "--no-error-on-unmatched-pattern"],
  },
  {
    name: "biome",
    dependency: "@biomejs/biome",
    configs: ["biome.json", "biome.jsonc"],
    args: ["format", "--write", "--files-ignore-unknown=true", "--no-errors-on-unmatched"],
  },
  {
    name: "dprint",
    dependency: "dprint",
    configs: ["dprint.json", ".dprint.json", "dprint.jsonc", ".dprint.jsonc"],
    args: ["fmt", "--allow-no-files"],
  },
  {
    name: "prettier",
    dependency: "prettier",
    configs: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.yaml",
      ".prettierrc.yml",
      ".prettierrc.js",
      ".prettierrc.cjs",
      ".prettierrc.mjs",
      "prettier.config.js",
      "prettier.config.cjs",
      "prettier.config.mjs",
    ],
    args: ["--write", "--ignore-unknown"],
  },
];

const PackageManifestSchema = Type.Object({
  dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  devDependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
  scripts: Type.Optional(Type.Record(Type.String(), Type.String())),
});

interface FormatterRun {
  name: string;
  command: string;
  args: string[];
}

async function jsFormatter(root: string): Promise<(typeof JS_FORMATTERS)[number] | undefined> {
  const manifest: unknown = await readFile(join(root, "package.json"), "utf8").then(JSON.parse, () => undefined);
  const { dependencies = {}, devDependencies = {}, scripts = {} } = Value.Check(PackageManifestSchema, manifest)
    ? manifest
    : {};

  return JS_FORMATTERS.find((formatter) => {
    return (
      formatter.configs.some((config) => existsSync(join(root, config))) ||
      formatter.dependency in dependencies ||
      formatter.dependency in devDependencies ||
      Object.values(scripts).some((script) => new RegExp(`\\b${formatter.name}\\b`).test(script))
    );
  });
}

// rustfmt defaults to the 2015 edition when run on files outside cargo.
async function rustEdition(root: string): Promise<string> {
  const manifest = await readFile(join(root, "Cargo.toml"), "utf8").catch(() => "");
  return /^edition\s*=\s*"(\d{4})"/m.exec(manifest)?.[1] ?? "2021";
}

export async function formatterRuns(root: string, paths: string[]): Promise<FormatterRun[]> {
  const files = paths.filter((path) => existsSync(join(root, path)));
  const rust = files.filter((file) => file.endsWith(".rs"));
  const go = files.filter((file) => file.endsWith(".go"));
  const rest = files.filter((file) => !rust.includes(file) && !go.includes(file));
  const runs: FormatterRun[] = [];

  const formatter = rest.length > 0 ? await jsFormatter(root) : undefined;
  if (formatter) {
    const local = join(root, "node_modules", ".bin", formatter.name);
    runs.push({
      name: formatter.name,
      command: existsSync(local) ? local : formatter.name,
      args: [...formatter.args, ...rest],
    });
  }
  if (rust.length > 0) {
    runs.push({
      name: "rustfmt",
      command: "rustfmt",
      args: ["--edition", await rustEdition(root), ...rust],
    });
  }
  if (go.length > 0) {
    runs.push({
      name: "gofmt",
      command: "gofmt",
      args: ["-w", ...go],
    });
  }
  return runs;
}
