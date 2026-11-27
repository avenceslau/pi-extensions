// Quotes text as one POSIX shell word.
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}
