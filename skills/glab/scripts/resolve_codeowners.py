#!/usr/bin/env python3
"""Resolve CODEOWNERS for the current branch's changed files to a reviewer list.

Prints a comma-separated GitLab username list to stdout, suitable for
`glab mr create --reviewer "$(resolve_codeowners.py)"`. Empty stdout (exit 0)
if no CODEOWNERS file, no changed files, or no resolvable owners.

Usage: resolve_codeowners.py [--target REF]
  --target  Target branch ref (default: origin/HEAD, else origin/main)
"""

import argparse
import fnmatch
import json
import subprocess
import sys
from pathlib import Path


def parse_rules(path):
    rules = []
    for raw in path.read_text().splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        # GitLab section headers don't define rules: [Section], ^[Section], [Section][N]
        if line.startswith("[") or line.startswith("^["):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        rules.append((parts[0], parts[1:]))
    return rules


def owners_for_files(rules, files):
    out = set()
    for f in files:
        # CODEOWNERS semantics: last matching rule wins per file
        last = None
        for pat, owners in rules:
            anchored = pat[1:] if pat.startswith("/") else pat
            anchored = anchored + "**" if anchored.endswith("/") else anchored
            if fnmatch.fnmatch(f, anchored) or fnmatch.fnmatch(f, anchored + "/**"):
                last = owners
        if last:
            out.update(last)
    return out


def expand(owner):
    if not owner.startswith("@"):
        return []
    handle = owner[1:]
    if "/" not in handle:
        return [handle]
    encoded = handle.replace("/", "%2F")
    try:
        # Direct members only — matches how GitLab expands @group codeowners
        # (inherited members from parent groups are NOT added as reviewers).
        raw = subprocess.check_output(
            ["glab", "api", f"groups/{encoded}/members"],
            text=True, stderr=subprocess.DEVNULL,
        )
        return [m["username"] for m in json.loads(raw) if m.get("state") == "active"]
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        print(f"warn: cannot resolve group {owner}", file=sys.stderr)
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target")
    args = ap.parse_args()

    co = next(
        (p for p in map(Path, ("CODEOWNERS", ".gitlab/CODEOWNERS", "docs/CODEOWNERS")) if p.is_file()),
        None,
    )
    if not co:
        return

    target = args.target
    if not target:
        try:
            target = subprocess.check_output(
                ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
                text=True, stderr=subprocess.DEVNULL,
            ).strip().replace("refs/remotes/", "")
        except subprocess.CalledProcessError:
            target = "origin/main"

    diff = subprocess.check_output(
        ["git", "diff", "--name-only", f"{target}...HEAD"], text=True,
    )
    files = [line for line in diff.splitlines() if line]
    if not files:
        return

    usernames = set()
    for o in owners_for_files(parse_rules(co), files):
        usernames.update(expand(o))

    try:
        me = json.loads(subprocess.check_output(
            ["glab", "api", "user"], text=True, stderr=subprocess.DEVNULL,
        )).get("username")
        if me:
            usernames.discard(me)
    except (subprocess.CalledProcessError, json.JSONDecodeError):
        pass

    sys.stdout.write(",".join(sorted(usernames)))


if __name__ == "__main__":
    main()
