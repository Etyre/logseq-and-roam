/**
 * Roam-style inline checkboxes for Logseq (file graphs).
 *
 * Renders the macro  {{renderer :cb, todo, <id>}}  /  {{renderer :cb, done, <id>}}
 * as a small clickable rounded-square checkbox that can appear anywhere in a block, any number of
 * times. Clicking flips todo <-> done by rewriting that one macro in the block's
 * content (the <id> tells the macros in a block apart). Visually distinct from
 * Logseq's own TODO marker on purpose.
 *
 * The migration converts Roam blocks with several `{{[[TODO]]}}` / `{{[[DONE]]}}`
 * (or one not at the start) to this macro; the reverse conversion is one-to-one.
 *
 * Slash command "checkbox" inserts a new one at the cursor.
 */

const KEY = "roam-inline-checkbox";

function macroRegex(id) {
  // {{renderer :cb, todo, k7f2}}  (whitespace-tolerant)
  return new RegExp("\\{\\{renderer\\s+:cb\\s*,\\s*(todo|done)\\s*,\\s*" + escapeRe(id) + "\\s*\\}\\}", "i");
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function newId() {
  return Math.random().toString(36).slice(2, 6);
}

function main() {
  logseq.provideStyle(`
    .rcb {
      display: inline-block; width: 1.05em; height: 1.05em; margin: 0 0.25em -0.15em 0;
      border: 2px solid var(--ls-primary-text-color, #555); border-radius: 0.3em;
      cursor: pointer; vertical-align: baseline; box-sizing: border-box; position: relative;
      opacity: 0.85;
    }
    .rcb:hover { opacity: 1; box-shadow: 0 0 0 2px rgba(120,120,120,0.25); }
    .rcb.rcb-done { background: var(--ls-link-text-color, #2f6fed); border-color: var(--ls-link-text-color, #2f6fed); }
    .rcb.rcb-done::after {
      content: ""; position: absolute; left: 0.3em; top: 0.05em; width: 0.28em; height: 0.55em;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg);
    }
  `);

  logseq.provideModel({
    async toggle(e) {
      const uuid = e.dataset.uuid;
      const id = e.dataset.id;
      const block = await logseq.Editor.getBlock(uuid);
      if (!block) return;
      const re = macroRegex(id);
      const m = block.content.match(re);
      if (!m) {
        logseq.UI.showMsg("Checkbox not found in block; edit the block to refresh", "warning");
        return;
      }
      const next = m[1].toLowerCase() === "todo" ? "done" : "todo";
      const content = block.content.replace(re, `{{renderer :cb, ${next}, ${id}}}`);
      await logseq.Editor.updateBlock(uuid, content);
    },
  });

  logseq.App.onMacroRendererSlotted(({ slot, payload }) => {
    const args = payload.arguments || [];
    if ((args[0] || "").trim() !== ":cb") return;
    const state = (args[1] || "todo").trim().toLowerCase() === "done" ? "done" : "todo";
    let id = (args[2] || "").trim();
    if (!id) {
      // A macro without an id can't be told apart from its twins; give it one.
      id = newId();
      logseq.Editor.getBlock(payload.uuid).then((b) => {
        if (!b) return;
        const c = b.content.replace(/\{\{renderer\s+:cb\s*,\s*(todo|done)\s*\}\}/i, `{{renderer :cb, $1, ${id}}}`);
        if (c !== b.content) logseq.Editor.updateBlock(payload.uuid, c);
      });
      return;
    }
    logseq.provideUI({
      key: `${KEY}-${slot}`,
      slot,
      reset: true,
      template: `<a class="rcb rcb-${state}" title="${state === "done" ? "done — click to reopen" : "todo — click to complete"}"
                    data-on-click="toggle" data-uuid="${payload.uuid}" data-id="${id}"></a>`,
    });
  });

  logseq.Editor.registerSlashCommand("checkbox", async () => {
    await logseq.Editor.insertAtEditingCursor(`{{renderer :cb, todo, ${newId()}}} `);
  });

  console.log("[roam-inline-checkbox] loaded");
}

logseq.ready(main).catch(console.error);
