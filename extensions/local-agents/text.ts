import { createHash } from "node:crypto";

const SLUG_CHARACTERS = 50;
const HASH_CHARACTERS = 10;

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, SLUG_CHARACTERS);
}

export function shortHash(text: string): string {
  return createHash("sha1")
    .update(text)
    .digest("hex")
    .slice(0, HASH_CHARACTERS);
}

export function truncate(text: string, maxCharacters: number): string {
  return text.length > maxCharacters
    ? `${text.slice(0, maxCharacters)}…`
    : text;
}
