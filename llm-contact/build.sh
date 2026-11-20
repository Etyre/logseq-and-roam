#!/bin/bash
# Generate llm-contact.js from the shared LLM-inbox files, so the browser-side code
# (Roam roam/js blocks, Logseq plugin iframes: no filesystem, no python) carries the
# preamble, the contact_eli and note_to_eli tools, the note acknowledgement and the confirm-step wording
# word for word. Idempotent; re-run whenever ~/Documents/agent-coding/shared/llm-system-prompt-preamble.md,
# contact_eli_tool.json, note_to_eli_tool.json or llm_contact.py changes (auto-anki/build.sh and claude-chat/build.sh call it).
set -euo pipefail
cd "$(dirname "$0")"
trap 'rm -f llm-contact.js.tmp' EXIT
SHARED="$HOME/Documents/agent-coding/shared"
PREAMBLE="$SHARED/llm-system-prompt-preamble.md"
TOOL="$SHARED/contact_eli_tool.json"
[ -f "$PREAMBLE" ] || { echo "missing $PREAMBLE" >&2; exit 1; }
[ -f "$TOOL" ] || { echo "missing $TOOL" >&2; exit 1; }
NOTE_TOOL="$SHARED/note_to_eli_tool.json"
[ -f "$NOTE_TOOL" ] || { echo "missing $NOTE_TOOL" >&2; exit 1; }
# The confirm question and decision tool are defined in llm_contact.py only, which needs python >= 3.10
# (/usr/bin/python3 is 3.9 and cannot import it).
PY=""
for c in /opt/homebrew/bin/python3 python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "ERROR: no python >= 3.10 found (tried /opt/homebrew/bin/python3, python3.10 to 3.13, python3); llm-contact.js not rebuilt" >&2; exit 1; }
CONFIRM="$("$PY" "$SHARED/llm_contact.py" confirm-constants)" || { echo "ERROR: $PY $SHARED/llm_contact.py confirm-constants failed; llm-contact.js not rebuilt" >&2; exit 1; }
# The text that answers a note_to_eli call, and llm_contact.py's own copy of that tool (compared with the json file below).
NOTE="$(PYTHONDONTWRITEBYTECODE=1 "$PY" -c 'import json, sys; sys.path.insert(0, sys.argv[1]); import llm_contact as l; print(json.dumps({"tool": l.NOTE_TOOL, "result_text": l.NOTE_RESULT_TEXT}))' "$SHARED")" || { echo "ERROR: could not read NOTE_TOOL / NOTE_RESULT_TEXT from $SHARED/llm_contact.py; llm-contact.js not rebuilt" >&2; exit 1; }
node - "$PREAMBLE" "$TOOL" "$CONFIRM" "$NOTE_TOOL" "$NOTE" > llm-contact.js.tmp <<'EOF'
const fs = require("fs");
const [preamblePath, toolPath, confirmJson, noteToolPath, noteJson] = process.argv.slice(2);
const confirm = JSON.parse(confirmJson);
for (const k of ["question", "keep_working", "decision_tool", "send_value", "keep_value"]) if (!confirm[k]) throw new Error("confirm-constants has no " + k);
// an empty list is valid (the step is then off for every model); a missing one means an old llm_contact.py
if (!Array.isArray(confirm.confirm_models) || confirm.confirm_models.some((m) => typeof m !== "string" || !m)) throw new Error("confirm-constants has no confirm_models list (update shared/llm_contact.py)");
const preamble = fs.readFileSync(preamblePath, "utf8").trim();
const tool = JSON.parse(fs.readFileSync(toolPath, "utf8"));
if (confirm.contact_tool_name !== tool.name) throw new Error("llm_contact.py and contact_eli_tool.json disagree on the tool name");
const noteTool = JSON.parse(fs.readFileSync(noteToolPath, "utf8"));
const note = JSON.parse(noteJson);
if (!note.result_text || JSON.stringify(note.tool) !== JSON.stringify(noteTool)) throw new Error("llm_contact.py and note_to_eli_tool.json disagree on the note tool (or NOTE_RESULT_TEXT is empty)");
if (noteTool.name === tool.name) throw new Error("the note tool and the contact tool have the same name");
if (/```/.test(preamble) || /```/.test(JSON.stringify(tool)) || /```/.test(confirmJson) || /```/.test(noteJson)) throw new Error("three backticks would end a roam/js code block");
process.stdout.write(fs.readFileSync("template.js", "utf8")
  .replace("__PREAMBLE__", JSON.stringify(preamble))
  .replace("__CONTACT_TOOL__", JSON.stringify(tool, null, 2).split("\n").join("\n  "))
  .replace("__NOTE_TOOL__", () => JSON.stringify(noteTool, null, 2).split("\n").join("\n  "))
  .replace("__NOTE_RESULT_TEXT__", () => JSON.stringify(note.result_text))
  .replace("__CONFIRM__", () => JSON.stringify(confirm, null, 2).split("\n").join("\n  "))
  .replace("__DATE__", new Date().toISOString().slice(0, 10)));
EOF
mv llm-contact.js.tmp llm-contact.js # only a complete build replaces the old copy
node -e "require('./llm-contact.js'); const c = globalThis.LlmContact; if (!c.PREAMBLE.startsWith('This note is from Eli')) throw new Error('bad preamble');"
node test.js >/dev/null
echo "built llm-contact/llm-contact.js"
