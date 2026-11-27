// macOS sandbox rules that refuse reads of .env and .dev.vars files; kept free of pi imports so the local-agents CLI
// can use them outside pi.
export const ENV_FILE_READ_DENY_RULES =
  '(deny file-read* (regex #".*/[.]env([.][^/]*)?$"))(deny file-read* (regex #".*/[.]dev[.]vars([.][^/]*)?$"))';
