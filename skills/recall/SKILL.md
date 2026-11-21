---
name: recall
description: Search past Pi sessions for an earlier conversation the user describes and report when it happened, what was said or decided, and how to reopen it.
disable-model-invocation: true
---

# Recall

The user wants to find an earlier conversation. Their description follows this skill as the request. If there is none, ask what to look for and stop.

Sessions are JSONL files under `~/.pi/agent/sessions/<encoded cwd>/`. Each starts with a `session` entry (`timestamp`, `cwd`), then a `session_info` entry with the session name; conversation turns are `message` entries whose `message.role` is `user` or `assistant`. Subagent sessions are named `<agentType>#<8 hex>` and are not conversations with the user.

## Search

Run `search.sh` from this skill's directory (`<skill dir>` below). It lists matching main sessions, newest first, with excerpts of the matching user and assistant messages, and skips subagent sessions and the session asking.

```sh
<skill dir>/search.sh 'durable object.*alarm'
<skill dir>/search.sh -p billing -s 2026-10-01 'retry budget'
```

1. Turn the description into two to four case-insensitive regexes: the distinctive terms, their synonyms and spellings (`rate.?limit`, `ratelimit`), identifiers, ticket numbers, file names. Skip words every session contains (`test`, `fix`, `code`).
2. Run the most specific one first. When the user names a project, a time ("last week", "in October") or a repository, pass `-p` and `-s`.
3. Too many hits: add a second term to the regex (`a.*b|b.*a`) or narrow with `-p` and `-s`. No hits: broaden the terms, drop the filters, then try `-n 40`.
4. For the two or three best sessions, read around the hits to confirm they are the conversation meant and to recover what was concluded:

   ```sh
   jq -r 'select(.type == "message" and (.message.role == "user" or .message.role == "assistant"))
     | "\(.timestamp) \(.message.role): \(.message.content | if type == "string" then . else map(select(.type == "text") | .text) | join(" ") end | .[0:1500])"' <file> | less
   ```

   Use `rg -n` on the file to jump to a term. Read assistant text, not tool output, unless the user asks about a command or its result.

## Report

For each matching conversation, newest first, at most three:

- when (local date and time) and where (`cwd`, branch if mentioned, session name);
- what was discussed and what was decided or left open, in two to five lines, quoting the user's own words when they matter;
- how to reopen it: `pi --session <file>`, or `pi --fork <file>` to branch from it.

Say plainly when nothing matched, which regexes and filters you tried, and offer a broader search. Do not resume, edit or delete sessions.
