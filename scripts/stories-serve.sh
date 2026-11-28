#!/usr/bin/env bash
# Local build for the user-story suite: TreFolders (mock chain, VITE_E2E=1) + staged TrePen/TreGrid, served by vite preview.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${STORIES_PORT:-4183}"
collab="${COLLAB_DIR:-$root/../collab-edit}"
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  (cd "$collab" && BUILD_ONLY=1 node --disable-warning=ExperimentalWarning --experimental-strip-types p2p/serve.ts >/dev/null)
  (cd "$root/apps/trefolders" && VITE_E2E=1 pnpm exec vite build >/dev/null)
  node "$root/scripts/stage-editors.mjs" "$collab/p2p/dist" >/dev/null
fi
cd "$root/apps/trefolders" && exec pnpm exec vite preview --host 127.0.0.1 --port "$port" --strictPort
