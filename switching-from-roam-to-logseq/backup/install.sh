#!/bin/bash
# Install (or reinstall) the hourly Logseq backup: copies logseq-backup.sh to ~/Library/Scripts
# (launchd cannot read ~/Documents without Full Disk Access, so the agent runs the copy), the
# plist to ~/Library/LaunchAgents, then reloads the agent com.elityre.logseq-backup by
# bootout + bootstrap (never pkill). Idempotent; safe to rerun after editing either file.
#   install.sh            install and (re)load
#   install.sh --status   show whether the agent is loaded and the last log lines
set -euo pipefail
cd "$(dirname "$0")"
LABEL="com.elityre.logseq-backup"
PLIST_SRC="$PWD/$LABEL.plist"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT_DST="$HOME/Library/Scripts/logseq-backup.sh"
LOG="$HOME/Library/Logs/logseq-backup.log"

if [ "${1:-}" = "--status" ]; then
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 && echo "$LABEL: loaded" || echo "$LABEL: not loaded"
  diff -q logseq-backup.sh "$SCRIPT_DST" >/dev/null 2>&1 && echo "installed script matches the repo" || echo "installed script DIFFERS from the repo (rerun install.sh)"
  tail -5 "$LOG" 2>/dev/null
  exit 0
fi

bash -n logseq-backup.sh
plutil -lint "$PLIST_SRC" >/dev/null
mkdir -p "$HOME/Library/Scripts" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 755 logseq-backup.sh "$SCRIPT_DST"
install -m 644 "$PLIST_SRC" "$PLIST_DST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
launchctl print "gui/$(id -u)/$LABEL" >/dev/null && echo "$LABEL loaded; runs hourly. Log: $LOG"
