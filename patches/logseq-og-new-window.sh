#!/bin/bash
# Logseq OG 1.0.0 patches for extra windows (2026-09-05). Idempotent; keeps a backup of
# the original file. Re-run after reinstalling the app.
#
#   bash logseq-og-new-window.sh          fast mode: Cmd+N fix + skip the cache persist
#   bash logseq-og-new-window.sh --safe   Cmd+N fix only (Logseq persists the cache
#                                         before every new window, as designed)
#
# 1. File > New Window (Cmd+N) did nothing on macOS: the compiled main script calls
#    `.$isFocused$()` (a method name mangled by the build) instead of `.isFocused()`.
# 2. (fast mode) New Window and `logseq://new-window/<graph>?page=...` links first
#    re-wrote the whole graph cache (~5 s on a 300k-block graph). Skipping it makes
#    windows appear at once, but a window that started from a stale cache can write
#    an older copy of a page over a newer one (seen 2026-09-05 as a "modified on
#    disk" conflict). Use --safe unless that is understood and handled.
#
# Run it yourself (the assistant's tooling refuses to edit application bundles):
#     bash ~/Documents/agent-coding/logseq-and-roam/patches/logseq-og-new-window.sh [--safe]
set -e
F="/Applications/Logseq-OG.app/Contents/Resources/app/electron.js"
[ -f "$F" ] || { echo "not found: $F"; exit 1; }
[ -f "$F.orig-1.0.0" ] || cp -p "$F" "$F.orig-1.0.0"
# always start from the pristine file so the two modes do not stack
cp -p "$F.orig-1.0.0" "$F"
perl -pi -e 's/\.\$isFocused\$\(/.isFocused(/g' "$F"
if [ "${1:-}" != "--safe" ]; then
  perl -pi -e 's/\$electron\$handler\$broadcast_persist_graph_BANG_\$\$\(\$graph_name\$jscomp\$13\$\$\)/Promise.resolve(null)/g' "$F"
  perl -pi -e 's/\$electron\$handler\$broadcast_persist_graph_BANG_\$\$\(\$graph_name\$jscomp\$12\$\$\) : null/Promise.resolve(null) : null/g' "$F"
  echo "mode: fast (persist skipped)"
else
  echo "mode: safe (persist kept)"
fi
echo "isFocused fixed: $(grep -c '\.isFocused(' "$F")"
echo "persist calls left in the window handlers (fast wants 0, safe wants 2): $(grep -c 'broadcast_persist_graph_BANG_\$\$(\$graph_name\$jscomp\$1[23]\$\$)' "$F")"
echo "done; quit and relaunch Logseq OG"
