#!/usr/bin/env bash
# Collect CodeRabbit's review comments on a PR as a flat markdown list.
#
# Two sources: inline review comments (anchored to a file and line — the
# actionable ones) and the top-level review bodies (summaries). Only comments
# authored by coderabbitai[bot] are taken; anything else on the PR is ignored.
# Output is one `- ` bullet per comment so the workflow can tell "found
# something" from "nothing to do" with a simple grep.
set -euo pipefail

PR="${1:?usage: gather-coderabbit.sh <pr-number>}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

echo "# CodeRabbit review comments for PR #$PR"
echo

# Inline (line-anchored) comments — the ones worth acting on. `line` is the
# current position; fall back to the original line when a comment is on an
# outdated diff.
gh api --paginate "repos/$REPO/pulls/$PR/comments" \
  --jq '.[]
        | select(.user.login == "coderabbitai[bot]")
        | "- **" + .path + ":" + ((.line // .original_line // 0) | tostring) + "** "
          + (.body | gsub("[\r\n]+"; " ") | .[0:1200])' \
  || true

# Top-level review summaries, in case a whole-PR note carries something the
# inline comments do not.
gh api --paginate "repos/$REPO/pulls/$PR/reviews" \
  --jq '.[]
        | select(.user.login == "coderabbitai[bot]")
        | select((.body // "") != "")
        | "- (review summary) " + (.body | gsub("[\r\n]+"; " ") | .[0:1200])' \
  || true
