import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const CACHE_PATH = join(homedir(), ".cache", "pi-hygiene", "clef.sqlite");
// Several pi sessions may write at once.
const BUSY_TIMEOUT_MS = 5_000;
const TABLES = {
  answers: {
    column: "probability",
    type: "REAL",
  },
  comment_verdicts: {
    column: "verdict",
    type: "TEXT",
  },
} as const;

type Table = keyof typeof TABLES;

export interface KeyValueCache<Value> {
  get(key: string): Value | undefined;
  set(entries: [string, Value][]): void;
  close(): void;
}

// Clef probabilities by question key. A cached answer also keeps the verdict on unchanged code stable across audits.
export type AnswerCache = KeyValueCache<number>;
// comment-review verdicts as JSON, by a hash of the comment, the code around it and the prompt version.
export type VerdictCache = KeyValueCache<string>;

function memoryCache<Value>(): KeyValueCache<Value> {
  const values = new Map<string, Value>();
  return {
    get: (key) => values.get(key),
    set: (entries) => {
      for (const [key, value] of entries) {
        values.set(key, value);
      }
    },
    close: () => undefined,
  };
}

function sqliteCache<Value extends number | string>(database: DatabaseSync, table: Table): KeyValueCache<Value> {
  const { column, type } = TABLES[table];
  database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, ${column} ${type} NOT NULL, created INTEGER NOT NULL)`,
  );
  const select = database.prepare(`SELECT ${column} AS value FROM ${table} WHERE key = ?`);
  const insert = database.prepare(`INSERT OR REPLACE INTO ${table} (key, ${column}, created) VALUES (?, ?, ?)`);
  return {
    get: (key) => {
      const value = select.get(key)?.value;
      return typeof value === "number" || typeof value === "string" ? (value as Value) : undefined;
    },
    set: (entries) => {
      if (entries.length === 0) {
        return;
      }
      const now = Date.now();
      database.exec("BEGIN");
      try {
        for (const [key, value] of entries) {
          insert.run(key, value, now);
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => database.close(),
  };
}

// Falls back to a cache that lasts for this run when node:sqlite is missing or the file cannot be opened.
async function openCache<Value extends number | string>(table: Table): Promise<{ cache: KeyValueCache<Value>; problem?: string }> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    mkdirSync(dirname(CACHE_PATH), { recursive: true });
    return { cache: sqliteCache<Value>(new DatabaseSync(CACHE_PATH), table) };
  } catch (error) {
    return {
      cache: memoryCache<Value>(),
      problem: `The hygiene cache at ${CACHE_PATH} is unavailable (${String(error)}); results are kept for this run only.`,
    };
  }
}

export function openAnswerCache(): Promise<{ cache: AnswerCache; problem?: string }> {
  return openCache<number>("answers");
}

export function openVerdictCache(): Promise<{ cache: VerdictCache; problem?: string }> {
  return openCache<string>("comment_verdicts");
}
