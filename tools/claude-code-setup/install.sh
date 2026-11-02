#!/usr/bin/env bash
# Installs the Claude Code project configuration and the CI workflow into this repository.
# Run once from the repository root on your Mac:  bash tools/claude-code-setup/install.sh
# Existing files are never overwritten unless you pass --force.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
SRC="tools/claude-code-setup"
FORCE="${1:-}"

copy() {
  local from="$1" to="$2"
  if [[ -e "$to" && "$FORCE" != "--force" ]]; then
    echo "skip (exists): $to"
  else
    mkdir -p "$(dirname "$to")"
    cp "$from" "$to"
    echo "installed: $to"
  fi
}

while IFS= read -r file; do
  copy "$file" ".claude/${file#"$SRC/dot-claude/"}"
done < <(find "$SRC/dot-claude" -type f)
copy "$SRC/dot-github/workflows/ci.yml" ".github/workflows/ci.yml"

echo
echo "Done. Review with: git status && git diff --stat"
echo "Then commit: git add .claude .github && git commit -m 'Add Claude Code project configuration and CI'"
