#!/bin/bash
# Cloud sessions only: install npm dependencies and the Remotion Claude Code plugin.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
npm install --no-audit --no-fund

if ! claude plugin marketplace list 2>/dev/null | grep -q 'remotion-dev/claude-code-plugin'; then
  claude plugin marketplace add remotion-dev/claude-code-plugin
fi

if ! claude plugin list 2>/dev/null | grep -q 'remotion@remotion'; then
  claude plugin install remotion@remotion
fi
