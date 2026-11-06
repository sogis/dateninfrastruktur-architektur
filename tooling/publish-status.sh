#!/usr/bin/env bash
set -euo pipefail
state=refs/heads/architecture-status
remote="$(git ls-remote origin "$state")"
if test -n "$remote"; then
  git fetch --no-tags origin "$state"
  parent="$(git rev-parse FETCH_HEAD)"
  git show "$parent:status.json" > "$RUNNER_TEMP/previous-status.json"
  parents=(-p "$parent")
else
  parents=()
fi

if node tooling/hosted-status.mjs "$RUNNER_TEMP/publish/site/verification.json" \
  "$RUNNER_TEMP/publish/observation/status.json" "$RUNNER_TEMP/previous-status.json" \
  "$RUNNER_TEMP/publish/site/status.json" contracts/hosted-runtime-evidence.json; then
  blob="$(git hash-object -w "$RUNNER_TEMP/publish/site/status.json")"
  tree="$(printf '100644 blob %s\tstatus.json\n' "$blob" | git mktree)"
  candidate="$(git -c user.name='GitHub Actions' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit-tree "$tree" "${parents[@]}" -m "Architecture observation $GITHUB_RUN_NUMBER.$GITHUB_RUN_ATTEMPT")"
  git push origin "$candidate:$state"
  test "$(git ls-remote origin "$state" | cut -f1)" = "$candidate"
  printf 'publish=true\n' >> "$GITHUB_OUTPUT"
else
  result=$?
  test "$result" -eq 3
fi
