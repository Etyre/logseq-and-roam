#!/bin/bash
# Hourly backup of the Logseq graph (spec Part V, decided 2026-09-05):
#   1. commit any change in ~/Documents/main-logseq-graph (its own git history)
#   2. push to the private GitHub repo Etyre/main-logseq-graph
#   3. mirror to ~/Backups/logseq (outside iCloud): a bare mirror with the full
#      history plus a plain copy of the current files
# Runs from ~/Library/Scripts (launchd agent com.elityre.logseq-backup, plist next to this
# file); this file in the repo is the source. `backup/install.sh` copies both into place and
# reloads the agent. Config: optional ~/Library/Application Support/LogseqBackup/config.env
# (GRAPH=, BACKUPS= override the defaults below). Log: ~/Library/Logs/logseq-backup.log,
# one timestamped line per step; launchd's own stdout/stderr go to logseq-backup.launchd.log.
#   --dry-run   report what would be committed, pushed and mirrored without changing anything
set -u
GRAPH="$HOME/Documents/main-logseq-graph"
BACKUPS="$HOME/Backups/logseq"
LOG="$HOME/Library/Logs/logseq-backup.log"
CONFIG="$HOME/Library/Application Support/LogseqBackup/config.env"
[ -f "$CONFIG" ] && . "$CONFIG"
DRY=0; [ "${1:-}" = "--dry-run" ] && { DRY=1; LOG=/dev/stdout; }
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

cd "$GRAPH" || { log "graph folder not found: $GRAPH"; exit 1; }
# iCloud conflict copies ("name 2.md" next to "name.md") are noise, but so named is also a real page
# ("Python 3.md" next to "Python.md"), and until 2026-11-20 this step deleted both kinds. Now a file is
# taken for a conflict copy only when git has never tracked it AND its content is identical to the base
# file (as it is now or as last committed); it is then moved out of the graph to
# $BACKUPS/conflict-copies, never deleted. Anything else is left alone and backed up like any page.
find . -path ./.git -prune -o -name '* [0-9].md' -print 2>/dev/null | while read -r f; do
  base="${f% [0-9].md}.md"
  [ -e "$base" ] || continue
  git ls-files --error-unmatch -- "$f" >/dev/null 2>&1 && continue
  if cmp -s "$f" "$base" || git show "HEAD:${base#./}" 2>/dev/null | cmp -s - "$f"; then
    if [ "$DRY" = 1 ]; then log "[dry-run] would move iCloud conflict copy out of the graph: $f"
    else
      mkdir -p "$BACKUPS/conflict-copies"
      mv "$f" "$BACKUPS/conflict-copies/$(date '+%Y%m%d-%H%M%S')-$(basename "$f")" && log "moved iCloud conflict copy to $BACKUPS/conflict-copies: $f"
    fi
  else
    log "left in place (looks like a conflict copy but differs from $base; check it by hand): $f"
  fi
done

if [ "$DRY" = 1 ]; then
  log "[dry-run] graph: $GRAPH  backups: $BACKUPS  config: $([ -f "$CONFIG" ] && echo "$CONFIG" || echo none)"
  n=$(git status --porcelain | wc -l | tr -d ' ')
  log "[dry-run] would commit $n changed file(s):"; git status --porcelain | head -20 >> "$LOG"
  log "[dry-run] would push to $(git remote get-url origin 2>/dev/null || echo '(no origin remote)')"
  log "[dry-run] would update mirror $BACKUPS/main-logseq-graph.git and file copy $BACKUPS/main-logseq-graph"
  rsync -an --delete --exclude .git --exclude 'logseq/bak' --exclude 'logseq/.recycle' --stats "$GRAPH/" "$BACKUPS/main-logseq-graph/" 2>/dev/null | grep -E 'Number of (regular files transferred|deleted files)' | sed 's/^/[dry-run] rsync: /' >> "$LOG"
  log "[dry-run] done; nothing was changed"
  exit 0
fi

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
