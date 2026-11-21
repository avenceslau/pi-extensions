#!/usr/bin/env bash
# Usage: session-signals.sh [cwd substring]
# Prints one JSON object per signal from every main Pi session:
#   {kind: "user", ...}      what the user typed (corrections, repeated instructions)
#   {kind: "decision", ...}  audit_decision outcomes from the post-change audit ledger, once each
#   {kind: "tool_error", ...} failed or blocked tool calls
# Subagent sessions (named <agentType>#<8 hex>) are skipped.
set -euo pipefail

project=${1:-}
sessions_dir=${PI_SESSIONS_DIR:-$HOME/.pi/agent/sessions}

find "$sessions_dir" -name '*.jsonl' -print0 |
  xargs -0 stat -f '%m %N' | sort -n |
  while read -r _ file; do
    name=$(head -n 8 "$file" | jq -r 'select(.type == "session_info") | .name' | head -n 1)
    [[ $name =~ ^[A-Za-z0-9_-]+#[0-9a-f]{8}$ ]] && continue
    cwd=$(head -n 1 "$file" | jq -r .cwd)
    [[ -n $project && $cwd != *"$project"* ]] && continue
    jq -c --arg file "$file" --arg cwd "$cwd" '
      def text: if type == "string" then . else map(select(.type == "text") | .text) | join("\n") end;
      if .type == "message" and .message.role == "user" then
        (.message.content | text) as $t
        | select($t | test("^\\s*(<skill |Audit only the changes|Settled decisions)") | not)
        | {kind: "user", at: .timestamp, text: $t[0:800]}
      elif .type == "custom" and .customType == "post-change-audit:ledger" then
        {kind: "decision", at: .timestamp, id: .data.id, decision: .data.decision,
         path: .data.file, claim: (.data.claim // "")[0:400], reason: (.data.reason // "")[0:300]}
      elif .type == "message" and .message.role == "toolResult" and .message.isError == true then
        {kind: "tool_error", at: .timestamp, tool: .message.toolName, text: (.message.content | text)[0:300]}
      else empty end
      | . + {cwd: $cwd, file: $file}' "$file" 2>/dev/null || true
  done |
  awk '{ key = $0; if ($0 ~ /"kind":"decision"/) { sub(/"at":"[^"]*",/, "", key) } if (!seen[key]++) print }'
