#!/bin/bash
# Generate llm-contact.js from the shared LLM-inbox files, so the browser-side code
# (Roam roam/js blocks, Logseq plugin iframes: no filesystem, no python) carries the
# preamble, the contact_eli tool and the confirm-step wording word for word. Idempotent;
# re-run whenever ~/Documents/agent-coding/shared/llm-system-prompt-preamble.md,
# contact_eli_tool.json or llm_contact.py changes (auto-anki/build.sh and claude-chat/build.sh call it).
set -euo pipefail
cd "$(dirname "$0")"
trap 'rm -f llm-contact.js.tmp' EXIT
SHARED="$HOME/Documents/agent-coding/shared"
PREAMBLE="$SHARED/llm-system-prompt-preamble.md"
TOOL="$SHARED/contact_eli_tool.json"
[ -f "$PREAMBLE" ] || { echo "missing $PREAMBLE" >&2; exit 1; }
[ -f "$TOOL" ] || { echo "missing $TOOL" >&2; exit 1; }
# The confirm question and decision tool are defined in llm_contact.py only, which needs python >= 3.10
# (/usr/bin/python3 is 3.9 and cannot import it).
PY=""
for c in /opt/homebrew/bin/python3 python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 10))' 2>/dev/null; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "ERROR: no python >= 3.10 found (tried /opt/homebrew/bin/python3, python3.10 to 3.13, python3); llm-contact.js not rebuilt" >&2; exit 1; }
CONFIRM="$("$PY" "$SHARED/llm_contact.py" confirm-constants)" || { echo "ERROR: $PY $SHARED/llm_contact.py confirm-constants failed; llm-contact.js not rebuilt" >&2; exit 1; }
node - "$PREAMBLE" "$TOOL" "$CONFIRM" > llm-contact.js.tmp <<'EOF'
const fs = require("fs");
const [preamblePath, toolPath, confirmJson] = process.argv.slice(2);
const confirm = JSON.parse(confirmJson);
for (const k of ["question", "keep_working", "decision_tool", "send_value", "keep_value"]) if (!confirm[k]) throw new Error("confirm-constants has no " + k);
// an empty list is valid (the step is then off for every model); a missing one means an old llm_contact.py
if (!Array.isArray(confirm.confirm_models) || confirm.confirm_models.some((m) => typeof m !== "string" || !m)) throw new Error("confirm-constants has no confirm_models list (update shared/llm_contact.py)");
const preamble = fs.readFileSync(preamblePath, "utf8").trim();
const tool = JSON.parse(fs.readFileSync(toolPath, "utf8"));
if (confirm.contact_tool_name !== tool.name) throw new Error("llm_contact.py and contact_eli_tool.json disagree on the tool name");
if (/```/.test(preamble) || /```/.test(JSON.stringify(tool)) || /```/.test(confirmJson)) throw new Error("three backticks would end a roam/js code block");
process.stdout.write(fs.readFileSync("template.js", "utf8")
  .replace("__PREAMBLE__", JSON.stringify(preamble))
  .replace("__CONTACT_TOOL__", JSON.stringify(tool, null, 2).split("\n").join("\n  "))
  .replace("__CONFIRM__", () => JSON.stringify(confirm, null, 2).split("\n").join("\n  "))
  .replace("__DATE__", new Date().toISOString().slice(0, 10)));
EOF
mv llm-contact.js.tmp llm-contact.js # only a complete build replaces the old copy
node -e "require('./llm-contact.js'); const c = globalThis.LlmContact; if (!c.PREAMBLE.startsWith('This note is from Eli')) throw new Error('bad preamble');"
node test.js >/dev/null
echo "built llm-contact/llm-contact.js"
