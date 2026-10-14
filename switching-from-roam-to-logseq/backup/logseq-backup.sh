#!/bin/bash
# Hourly backup of the Logseq graph (spec Part V, decided 2026-09-05):
#   1. commit any change in ~/Documents/main-logseq-graph (its own git history)
#   2. push to the private GitHub repo Etyre/main-logseq-graph
#   3. mirror to ~/Backups/logseq (outside iCloud): a bare mirror with the full
#      history plus a plain copy of the current files
# Runs from ~/Library/Scripts (launchd agent com.elityre.logseq-backup); this file
# in the repo is the source, copy it there after editing:
#   cp switching-from-roam-to-logseq/backup/logseq-backup.sh ~/Library/Scripts/
set -u
GRAPH="$HOME/Documents/main-logseq-graph"
BACKUPS="$HOME/Backups/logseq"
LOG="$HOME/Library/Logs/logseq-backup.log"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

cd "$GRAPH" || { log "graph folder not found: $GRAPH"; exit 1; }
# iCloud conflict copies ("name 2.md") are noise: never back them up
find . -path ./.git -prune -o -name '* [0-9].md' -print 2>/dev/null | while read -r f; do
  base="${f% [0-9].md}.md"
  [ -e "$base" ] && rm -f "$f" && log "removed iCloud conflict copy: $f"
done

git add -A >> "$LOG" 2>&1
if git diff --cached --quiet; then
  log "nothing to commit"
else
  git commit -q -m "backup $(date '+%F %H:%M')" >> "$LOG" 2>&1 && log "committed $(git diff --stat HEAD~1 | tail -1)"
fi
if git push -q origin main >> "$LOG" 2>&1; then log "pushed to GitHub"; else log "PUSH FAILED (see above)"; fi

mkdir -p "$BACKUPS"
MIRROR="$BACKUPS/main-logseq-graph.git"
if [ ! -d "$MIRROR" ]; then
  git clone -q --mirror "$GRAPH" "$MIRROR" >> "$LOG" 2>&1 && log "mirror created at $MIRROR"
else
  git -C "$MIRROR" fetch -q --prune "$GRAPH" '+refs/heads/*:refs/heads/*' >> "$LOG" 2>&1 && log "mirror updated"
fi
rsync -a --delete --exclude .git --exclude 'logseq/bak' --exclude 'logseq/.recycle' "$GRAPH/" "$BACKUPS/main-logseq-graph/" >> "$LOG" 2>&1 && log "file copy updated at $BACKUPS/main-logseq-graph"
