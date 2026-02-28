#!/usr/bin/env bash
# =============================================================================
# browser-verify-test.sh — Quick sanity check for browser tools inside sandbox
#
# Run with:
#   docker run --rm gooseherd/sandbox:default bash < scripts/browser-verify-test.sh
# Or:
#   docker run --rm -v "$(pwd)/scripts:/scripts:ro" gooseherd/sandbox:default bash /scripts/browser-verify-test.sh
#
# For full browser verification testing, use:
#   npx tsx scripts/test-browser-verify.ts <preview-url> [task]
# =============================================================================
set -euo pipefail

echo "=== Sandbox Browser Tools Check ==="

# 1. Chromium
echo -n "Chromium: "
chromium --version 2>/dev/null || echo "NOT FOUND"

# 2. Playwright
echo -n "Playwright: "
npx --no-install playwright --version 2>/dev/null || echo "NOT FOUND"

# 3. Pa11y
echo -n "Pa11y: "
npx --no-install pa11y --version 2>/dev/null || echo "NOT FOUND"

# 4. Stagehand
echo -n "Stagehand: "
node -e "try { require('@browserbasehq/stagehand'); console.log('installed') } catch { console.log('NOT FOUND') }" 2>/dev/null

# 5. Node
echo -n "Node: "
node --version

echo ""
echo "=== All checks complete ==="
