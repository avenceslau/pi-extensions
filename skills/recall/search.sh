#!/usr/bin/env bash
# Usage: search.sh [-n sessions] [-k hits] [-p project] [-s since] [-a] <regex>
#   -n  stop after this many matching sessions (default 15)
#   -k  matching messages printed per session (default 5)
#   -p  only sessions whose cwd contains this substring
#   -s  only sessions modified on or after this date (YYYY-MM-DD)
#   -a  include the session written in the last two minutes (normally the one asking)
set -euo pipefail

sessions_dir=${PI_SESSIONS_DIR:-$HOME/.pi/agent/sessions}
max_sessions=15
hits_per_session=5
project=""
since=""
include_current=false
while getopts n:k:p:s:a opt; do
  case $opt in
    n) max_sessions=$OPTARG ;;
    k) hits_per_session=$OPTARG ;;
    p) project=$OPTARG ;;
    s) since=$OPTARG ;;
    a) include_current=true ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))
pattern=${1:?usage: search.sh [-n sessions] [-k hits] [-p project] [-s since] [-a] <regex>}

since_epoch=0
[[ -n $since ]] && since_epoch=$(date -j -f %Y-%m-%d "$since" +%s)
recent_epoch=$(($(date +%s) - 120))

found=0
while read -r mtime file; do
  ((found >= max_sessions)) && break
  ((mtime < since_epoch)) && continue
  [[ $include_current == false ]] && ((mtime > recent_epoch)) && continue
  header=$(head -n 8 "$file" | jq -rs '
    (map(select(.type == "session")) | first) as $s
    | (map(select(.type == "session_info")) | first | .name // "") as $name
    | "\($s.timestamp)\t\($s.cwd)\t\($name)"')
  IFS=$'\t' read -r started cwd name <<<"$header"
  [[ $name =~ ^[A-Za-z0-9_-]+#[0-9a-f]{8}$ ]] && continue
  [[ -n $project && $cwd != *"$project"* ]] && continue
  hits=$(jq -r --arg re "$pattern" --argjson k "$hits_per_session" -n '
    [inputs
      | select(.type == "message" and (.message.role == "user" or .message.role == "assistant"))
      | .timestamp as $t | .message.role as $role
      | (.message.content | if type == "string" then . else map(select(.type == "text") | .text) | join("\n") end) as $text
      | ($text | [match($re; "i")] | first) as $m
      | select($m != null)
      | ([0, $m.offset - 200] | max) as $from
      | "  \($t) \($role): …\($text[$from:$m.offset + 300] | gsub("\\s+"; " "))…"]
    | .[:$k] | .[]' "$file" 2>/dev/null || true)
  [[ -z $hits ]] && continue
  found=$((found + 1))
  printf '## %s  %s%s\n  file: %s\n%s\n\n' "$started" "$cwd" "${name:+  ($name)}" "$file" "$hits"
done < <(rg -l -i --glob '*.jsonl' -e "$pattern" "$sessions_dir" 2>/dev/null | xargs stat -f '%m %N' | sort -rn)

((found == 0)) && echo "No matching sessions for /$pattern/." || true
