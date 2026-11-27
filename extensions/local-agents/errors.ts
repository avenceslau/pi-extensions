export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The `code` of a Node.js system error, such as ENOENT.
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }

  return String(error.code);
}
