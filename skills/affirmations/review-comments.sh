#!/usr/bin/env bash
# Usage: review-comments.sh <host/path>...
# Prints one JSON object per human review comment on every merged review:
# {repo, review, url, review_author, author, path, line, created, body}
# Each merged review's comments are cached in ~/.cache/affirmations/reviews, so later runs fetch only new reviews.
set -euo pipefail

(($# > 0)) || { echo "usage: review-comments.sh <host/path>..." >&2; exit 2; }
cache_dir=${XDG_CACHE_HOME:-$HOME/.cache}/affirmations/reviews

is_human='(.author // "" | test("bot|^gsa_|^ghost$|^renovate|^dependabot|^gitlab-"; "i") | not)'

# Retries a request three times; on failure reports it and prints nothing, so a flaky review is skipped, not duplicated.
fetch() {
  local output attempt
  for attempt in 1 2 3; do
    if output=$("$@"); then
      printf '%s\n' "$output"
      return
    fi
    sleep $((attempt * 2))
  done
  echo "skipped after 3 failures: ${*: -1}" >&2
  return 1
}

# Prints a review's cached comments, or runs the remaining arguments to fetch them and caches the result.
cached() {
  local file=$cache_dir/$1.ndjson output
  shift
  if [[ -f $file ]]; then
    cat "$file"
    return
  fi
  output=$("$@") || return 0
  mkdir -p "$(dirname "$file")"
  printf '%s\n' "$output" | grep -v '^$' >"$file" || true
  if [[ -n $output ]]; then
    printf '%s\n' "$output"
  fi
}

gitlab_review() {
  local host=$1 encoded=$2 project=$3 iid=$4 url=$5 review_author=$6 notes
  notes=$(fetch glab api --hostname "$host" --paginate --output ndjson \
    "projects/$encoded/merge_requests/$iid/notes?per_page=100") || return 1
  [[ -z $notes ]] && return
  jq -c --arg repo "$host/$project" --arg url "$url" --arg review_author "$review_author" --argjson iid "$iid" '
    select(.system == false)
    | {repo: $repo, review: $iid, url: $url, review_author: $review_author, author: .author.username,
       path: .position.new_path, line: .position.new_line, created: .created_at, body}' <<<"$notes" |
    jq -c "select($is_human and .author != .review_author)"
}

github_review() {
  local host=$1 repo=$2 number=$3 url=$4 review_author=$5 comments reviews issue_comments
  comments=$(fetch env GH_HOST="$host" gh api --paginate "repos/$repo/pulls/$number/comments?per_page=100" \
    --jq '.[] | {author: .user.login, type: .user.type, path, line, created: .created_at, body}') || return 1
  reviews=$(fetch env GH_HOST="$host" gh api --paginate "repos/$repo/pulls/$number/reviews?per_page=100" \
    --jq '.[] | select(.body != "") | {author: .user.login, type: .user.type, path: null, line: null, created: .submitted_at, body}') || return 1
  issue_comments=$(fetch env GH_HOST="$host" gh api --paginate "repos/$repo/issues/$number/comments?per_page=100" \
    --jq '.[] | {author: .user.login, type: .user.type, path: null, line: null, created: .created_at, body}') || return 1
  printf '%s\n%s\n%s\n' "$comments" "$reviews" "$issue_comments" | { grep -v '^$' || true; } |
    jq -c --arg repo "$host/$repo" --arg url "$url" --arg review_author "$review_author" --argjson number "$number" '
      select(.type != "Bot")
      | {repo: $repo, review: $number, url: $url, review_author: $review_author, author, path, line, created, body}' |
    jq -c "select($is_human and .author != .review_author)"
}

gitlab_comments() {
  local host=$1 project=$2 encoded
  encoded=$(jq -rn --arg p "$project" '$p | @uri')
  fetch glab api --hostname "$host" --paginate --output ndjson \
    "projects/$encoded/merge_requests?state=merged&per_page=100" |
    jq -r '[.iid, .web_url, .author.username] | @tsv' |
    while IFS=$'\t' read -r iid url review_author; do
      cached "$host/$project/$iid" gitlab_review "$host" "$encoded" "$project" "$iid" "$url" "$review_author"
    done
}

github_comments() {
  local host=$1 repo=$2
  fetch env GH_HOST="$host" gh pr list -R "$repo" --state merged --limit 100000 \
    --json number,url,author --jq '.[] | [.number, .url, .author.login] | @tsv' |
    while IFS=$'\t' read -r number url review_author; do
      cached "$host/$repo/$number" github_review "$host" "$repo" "$number" "$url" "$review_author"
    done
}

for target in "$@"; do
  host=${target%%/*}
  path=${target#*/}
  case $host in
    github.com | *github*) github_comments "$host" "$path" || echo "incomplete: $target" >&2 ;;
    *) gitlab_comments "$host" "$path" || echo "incomplete: $target" >&2 ;;
  esac
done
