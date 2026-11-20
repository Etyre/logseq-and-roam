/**
 * Auto-anki for Roam Research (roam/js). Requires core.js above it in the same file
 * (roam/auto-anki.js is built from both by auto-anki/build.sh).
 *
 * Tag a block with one of CONFIG.homeTags, or type /cards in it (CONFIG.slashTriggers; also
 * "Auto-anki: make cards here" in the command palette and the block menu), which adds the
 * tag and runs at once. The block's parent and its siblings (with their descendants) are
 * the source material; its children are the Anki notes the LLM writes (under labelled
 * headings once there are more than a few, see CONFIG.grouping). Trigger an update
 * with the small button on the block, the command palette ("Auto-anki: update cards")
 * or the block context menu. Notes you edit turn a different colour and are never
 * touched by the LLM again.
 *
 * First run "Auto-anki: set API key" from the command palette (stored in this browser's
 * localStorage, never in the graph).
 */
(function () {
  const CONFIG = {
    homeTags: ["auto-generate cards", "LLM-generated cards"],
    slashTriggers: ["/cards"], // typing one of these in a block tags it with the first home tag and makes the cards at once
    offTags: ["auto-anki off"], // add one of these to a home block to switch it off
    templateTags: ["roam/templates", "SmartBlock"], // home blocks under one of these (a template definition) are off
    ankifyTag: "ankify",
    tagNewCards: false, // false: cards are written without the ankify tag and you tag the ones you want in Anki; true: every new card is tagged
    model: "claude-opus-5-5",
    effort: "high", // low | medium | high | xhigh | max
    extraInstructions: "", // free text appended to every request, e.g. deck or style preferences
    // More than `threshold` notes -> the notes are organised under labelled heading blocks
    // (at most two levels deep); every leaf heading holds between `min` and `max` notes.
    grouping: { threshold: 6, min: 2, max: 6 },
    autoUpdate: false, // regenerate on its own once the content has been quiet for quietMinutes
    quietMinutes: 3,
    showStateBlock: false, // show the hidden "#auto-anki-state" bookkeeping block
    hotkey: "", // e.g. "ctrl-alt-k" for the update command
    promptPage: "auto-anki/prompt", // page holding the instructions to the model; empty/missing = built-in
    examplesPage: "auto-anki/examples", // page where your edits/deletions are collected as examples for the model
  };

  const api = window.roamAlphaAPI;
  const core = window.AutoAnkiCore;
  if (!api || !core) return;
  if (window.__autoAnkiLoaded) return;
  window.__autoAnkiLoaded = true;
  core.settings.homeTags = CONFIG.homeTags;
  core.settings.offTags = CONFIG.offTags;
  core.settings.examplesPage = CONFIG.examplesPage;
  core.settings.ankifyTag = CONFIG.ankifyTag;

  const KEY_STORAGE = "auto-anki:apiKey";
  const apiKey = () => localStorage.getItem(KEY_STORAGE) || "";
  const toast = (msg, kind) => (window.iziToast ? iziToast[kind || "info"]({ message: msg, timeout: 6000 }) : console.log("[auto-anki]", msg));

  // ---------- adapter: graph read/write through roamAlphaAPI ----------
  const TREE = "[:block/uid :block/string :block/order {:block/children ...}]";
  const sortKids = (b) => [...((b && b[":block/children"]) || [])].sort((x, y) => (x[":block/order"] || 0) - (y[":block/order"] || 0));
  const toTree = (b) => ({ uid: b[":block/uid"], text: b[":block/string"] || "", children: sortKids(b).map(toTree) });

  const adapter = {
    async getBlock(uid) {
      const b = api.pull(`[:block/uid :block/string :block/order {:block/children ${TREE}} {:block/page [:node/title]} {:block/_children [:block/uid]}]`, [":block/uid", uid]);
      if (!b) return null;
      const t = toTree(b);
      t.pageTitle = b[":block/page"] && b[":block/page"][":node/title"];
      const p = b[":block/_children"];
      t.parentUid = p && p[0] && p[0][":block/uid"];
      return t;
    },
    async getSiblingTrees(uid) {
      const home = await this.getBlock(uid);
      if (!home || !home.parentUid) return [];
      const parent = api.pull(`[:block/uid {:block/children ${TREE}}]`, [":block/uid", home.parentUid]);
      return sortKids(parent).map(toTree).filter((t) => t.uid !== uid && !core.isHome(t.text));
    },
    async getParentText(uid) {
      // a top-level block's parent is the page, which has no string: the page title is sent separately
      const b = api.pull("[{:block/_children [:block/string]}]", [":block/uid", uid]);
      const p = b && b[":block/_children"];
      return (p && p[0] && p[0][":block/string"]) || "";
    },
    async createBlock(parentUid, text, where) {
      const uid = api.util.generateUID();
      let order = "last";
      if (where && where.before) {
        const b = api.pull("[:block/order]", [":block/uid", where.before]);
        if (b && typeof b[":block/order"] === "number") order = b[":block/order"];
      }
      await api.data.block.create({ location: { "parent-uid": parentUid, order }, block: { string: text, uid } });
      return uid;
    },
    async updateBlock(uid, text) { await api.data.block.update({ block: { uid, string: text } }); },
    async deleteBlock(uid) { await api.data.block.delete({ block: { uid } }); },
    async moveBlock(uid, parentUid, where) {
      let order = "last";
      if (where && where.before) {
        const b = api.pull("[:block/order]", [":block/uid", where.before]);
        if (b && typeof b[":block/order"] === "number") order = b[":block/order"];
      }
      await api.data.block.move({ location: { "parent-uid": parentUid, order }, block: { uid } });
    },
    async collapse(uid) { await api.data.block.update({ block: { uid, open: false } }); },
    async readPageTrees(title) {
      const p = api.pull(`[:block/uid {:block/children ${TREE}}]`, [":node/title", title]);
      return p ? sortKids(p).map(toTree) : null;
    },
    async writePageTrees(title, trees) {
      let p = api.pull("[:block/uid]", [":node/title", title]);
      if (!p) { const uid = api.util.generateUID(); await api.data.page.create({ page: { title, uid } }); p = { ":block/uid": uid }; }
      const put = async (parentUid, nodes) => { for (const n of nodes) { const uid = await this.createBlock(parentUid, n.text, { last: true }); await put(uid, n.children || []); } };
      await put(p[":block/uid"], trees);
    },
    async openPage(title) { await api.ui.mainWindow.openPage({ page: { title } }); },
    async isInTemplate(uid) {
      const b = api.pull("[{:block/parents [:block/string]}]", [":block/uid", uid]);
      const want = CONFIG.templateTags.map((t) => t.toLowerCase());
      return ((b && b[":block/parents"]) || []).some((p) => core.lowerTags(p[":block/string"]).some((t) => want.includes(t)));
    },
    async appendToPage(title, text) {
      let p = api.pull("[:block/uid]", [":node/title", title]);
      if (!p) { const uid = api.util.generateUID(); await api.data.page.create({ page: { title, uid } }); p = { ":block/uid": uid }; }
      return this.createBlock(p[":block/uid"], text, { last: true });
    },
    notify(msg, kind) { toast(msg, kind); },
    progress(homeUid, n) { // cards written so far while the answer streams in
      const c = homeContainers().find((x) => uidOf(x) === homeUid);
      const el = c && c.querySelector(":scope > .auto-anki-bar .auto-anki-count");
      if (el) el.textContent = `${n} written…`;
    },
  };

  // ---------- styling ----------
  const style = document.createElement("style");
  style.textContent = `
    .roam-block-container[data-auto-anki="home"] { border: 2px solid #8e7cc3; border-radius: 6px; background: rgba(142,124,195,0.07); margin: 6px 0 6px -4px; padding: 4px 4px 4px 4px; position: relative; }
    .roam-block-container[data-auto-anki="home"] > .rm-block-main { padding-right: 150px; }
    .roam-block-container[data-auto-anki="off"] { border: 1px dashed #b8b8b8; border-radius: 6px; margin: 6px 0 6px -4px; padding: 4px; }
    .roam-block-container[data-auto-anki="frozen"] > .rm-block-main { border-left: 3px solid #e0a030; margin-left: -6px; padding-left: 3px; background: rgba(224,160,48,0.10); border-radius: 3px; }
    .roam-block-container[data-auto-anki="frozen"] > .rm-block-children { border-left-color: #e0a030; }
    .auto-anki-bar { position: absolute; top: 4px; right: 6px; display: flex; align-items: center; gap: 6px; z-index: 5; }
    .auto-anki-bar .auto-anki-count { font-size: 11px; line-height: 16px; color: #5b4a99; white-space: nowrap; }
    .auto-anki-bar .auto-anki-dot { width: 8px; height: 8px; border-radius: 50%; background: #b8b8b8; }
    .auto-anki-bar .auto-anki-dot.stale { background: #e0a030; }
    .auto-anki-bar .auto-anki-dot.busy { background: #8e7cc3; animation: auto-anki-pulse 1s infinite alternate; }
    .auto-anki-bar button { font-size: 11px; line-height: 16px; padding: 0 6px; border: 1px solid #8e7cc3; border-radius: 3px; background: #fff; color: #5b4a99; cursor: pointer; }
    .auto-anki-bar button:hover { background: #8e7cc3; color: #fff; }
    @keyframes auto-anki-pulse { from { opacity: 0.4 } to { opacity: 1 } }
    ${CONFIG.showStateBlock ? "" : `.roam-block-container[data-page-links*="${core.STATE_TAG}"] { display: none !important; }`}
  `;
  document.head.appendChild(style);

  // ---------- DOM decoration ----------
  const uidOf = (container) => {
    const el = container.querySelector(':scope > .rm-block-main [id^="block-input-"]');
    return el ? el.id.slice(-9) : null;
  };
  const homeContainers = () => [...document.querySelectorAll(".roam-block-container[data-page-links]")].filter((c) => {
    const links = c.getAttribute("data-page-links") || "";
    return core.settings.homeTags.some((t) => links.toLowerCase().includes(JSON.stringify(t.toLowerCase()).slice(1, -1)));
  });

  const statusCache = new Map(); // homeUid -> {stale, frozen:Set, count}

  // "12 cards", or "12 cards · 3 edited" when some are frozen; blank until the first status read
  const countLabel = (st) => (st && typeof st.count === "number" ? `${st.count} card${st.count === 1 ? "" : "s"}${st.frozen && st.frozen.size ? ` · ${st.frozen.size} edited` : ""}` : "");

  function decorate() {
    for (const c of homeContainers()) {
      const uid = uidOf(c);
      if (!uid) continue;
      const st = statusCache.get(uid);
      if (st && st.off) { c.setAttribute("data-auto-anki", "off"); c.querySelector(":scope > .auto-anki-bar")?.remove(); continue; }
      c.setAttribute("data-auto-anki", "home");
      let bar = c.querySelector(":scope > .auto-anki-bar");
      if (!bar) {
        bar = document.createElement("div");
        bar.className = "auto-anki-bar";
        bar.innerHTML = `<span class="auto-anki-count"></span><span class="auto-anki-dot"></span><button type="button" title="Update cards">↻</button>`;
        bar.querySelector("button").addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); update(uid); });
        c.appendChild(bar);
      }
      bar.querySelector(".auto-anki-count").textContent = countLabel(st);
      const dot = bar.querySelector(".auto-anki-dot");
      dot.className = "auto-anki-dot" + (core.isBusy(uid) ? " busy" : st && st.stale ? " stale" : "");
      const frozen = (st && st.frozen) || new Set();
      for (const child of c.querySelectorAll(":scope > .rm-block-children .roam-block-container")) {
        const cu = uidOf(child);
        if (cu && frozen.has(cu)) child.setAttribute("data-auto-anki", "frozen");
        else if (child.getAttribute("data-auto-anki") === "frozen") child.removeAttribute("data-auto-anki");
      }
      if (!st) refreshStatus(uid);
    }
  }

  let refreshing = new Set();
  async function refreshStatus(uid) {
    if (refreshing.has(uid) || core.isBusy(uid)) return;
    refreshing.add(uid);
    try {
      const r = await core.refresh(adapter, uid);
      if (r) {
        statusCache.set(uid, { stale: r.stale, frozen: r.frozen, off: !!r.off, count: r.notes.length });
        if (CONFIG.autoUpdate && r.stale && !r.off) scheduleAuto(uid);
      }
    } catch (e) { console.error("[auto-anki] refresh", e); }
    finally { refreshing.delete(uid); decorate(); }
  }

  // ---------- live watching ----------
  const watched = new Map(); // parentUid -> callback
  const timers = new Map();
  function watchParents() {
    for (const c of homeContainers()) {
      const uid = uidOf(c);
      if (!uid) continue;
      const b = api.pull("[{:block/_children [:block/uid]}]", [":block/uid", uid]);
      const parentUid = b && b[":block/_children"] && b[":block/_children"][0] && b[":block/_children"][0][":block/uid"];
      if (!parentUid || watched.has(parentUid)) continue;
      const cb = () => {
        clearTimeout(timers.get(uid));
        timers.set(uid, setTimeout(() => { statusCache.delete(uid); refreshStatus(uid); }, 1500));
      };
      try {
        api.data.addPullWatch(`[:block/string {:block/children ...}]`, `[:block/uid "${parentUid}"]`, cb);
        watched.set(parentUid, cb);
      } catch (e) { console.warn("[auto-anki] pull watch failed", e); }
    }
  }

  const autoTimers = new Map();
  function scheduleAuto(uid) {
    clearTimeout(autoTimers.get(uid));
    autoTimers.set(uid, setTimeout(() => {
      const st = statusCache.get(uid);
      if (st && st.stale && !core.isBusy(uid)) update(uid, true);
    }, Math.max(0.5, CONFIG.quietMinutes) * 60000));
  }

  let domTimer = null;
  new MutationObserver(() => { clearTimeout(domTimer); domTimer = setTimeout(() => { decorate(); watchParents(); }, 300); })
    .observe(document.body, { childList: true, subtree: true });
  setTimeout(() => { decorate(); watchParents(); }, 1000);

  // ---------- update ----------
  async function update(uid, quiet) {
    if (!apiKey()) { toast("Auto-anki: set the API key first (command palette → Auto-anki: set API key)", "warning"); return; }
    if (core.isBusy(uid)) return;
    decorate();
    try {
      const run = core.runUpdate(adapter, uid, { apiKey: apiKey(), model: CONFIG.model, effort: CONFIG.effort, ankifyTag: CONFIG.ankifyTag, tagCards: CONFIG.tagNewCards, extraInstructions: CONFIG.extraInstructions, promptPage: CONFIG.promptPage, grouping: CONFIG.grouping });
      decorate(); // the core marked the block busy: show the pulsing dot while Claude works
      const r = await run;
      statusCache.delete(uid);
      if (r.contact) return; // Claude asked for Eli: the core recorded it and said so; nothing was written
      if (!quiet) toast(`Auto-anki: ${r.created} new, ${r.updated} updated, ${r.deleted} removed`, "success");
    } catch (e) {
      console.error("[auto-anki]", e);
      toast("Auto-anki failed: " + e.message, "error");
    } finally {
      refreshStatus(uid);
    }
  }

  function homeFromUid(uid) {
    // the block itself or its nearest ancestor with a home tag
    let cur = uid, guard = 0;
    while (cur && guard++ < 50) {
      const b = api.pull("[:block/uid :block/string {:block/_children [:block/uid]}]", [":block/uid", cur]);
      if (!b) return null;
      if (core.isHome(b[":block/string"])) return cur;
      const p = b[":block/_children"];
      cur = p && p[0] && p[0][":block/uid"];
    }
    return null;
  }

  function runCommand(ctx) {
    let uid = null;
    if (ctx && ctx["block-uid"]) uid = homeFromUid(ctx["block-uid"]);
    if (!uid) { const f = api.ui.getFocusedBlock && api.ui.getFocusedBlock(); if (f && f["block-uid"]) uid = homeFromUid(f["block-uid"]); }
    if (!uid) { const hs = homeContainers().map(uidOf).filter(Boolean); if (hs.length === 1) uid = hs[0]; }
    if (!uid) { toast("Auto-anki: put the cursor in a tagged block (or its cards) first", "warning"); return; }
    update(uid);
  }

  // ---------- make cards here: the typed trigger and the command ----------
  const isBlockTextarea = (t) => t && t.tagName === "TEXTAREA" && t.classList.contains("rm-block-input");
  const uidFromTextareaId = (id) => (id && id.length > 9 ? id.slice(-9) : null);
  const blockText = (uid) => { const b = api.pull("[:block/string]", [":block/uid", uid]); return (b && b[":block/string"]) || ""; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Tag the block as a home block and run. `ta` is the block's textarea while it is being edited. */
  async function makeCardsHere(uid, ta, text) {
    if (core.isBusy(uid)) return;
    const tagged = core.tagAsHome(text);
    if (ta && ta.isConnected) {
      // Roam owns the textarea: write through it and leave edit mode, or its copy would overwrite ours
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, tagged);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
      await sleep(80);
      if (document.querySelector("textarea.rm-block-input")) {
        // Escape went to Roam's own "/" menu instead of ending the edit: click outside (same fallback as Claude in Roam)
        const outside = document.querySelector(".roam-article") || document.body;
        for (const type of ["mousedown", "mouseup", "click"]) outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      for (let i = 0; i < 15 && blockText(uid) !== tagged; i++) await sleep(100);
    }
    // the run rewrites the home block from what is stored, so the tag must be there before it starts
    if (blockText(uid) !== tagged) await adapter.updateBlock(uid, tagged);
    decorate();
    update(uid);
  }

  const triggered = new Map(); // uid -> time: the input event repeats while Roam re-renders
  document.addEventListener("input", (e) => {
    const ta = e.target;
    if (!isBlockTextarea(ta)) return;
    const uid = uidFromTextareaId(ta.id);
    if (!uid) return;
    const value = ta.value, cursor = ta.selectionStart;
    const len = core.slashTriggerAt(value.slice(0, cursor), CONFIG.slashTriggers);
    if (!len) return;
    if (Date.now() - (triggered.get(uid) || 0) < 5000) return;
    triggered.set(uid, Date.now());
    const text = value.slice(0, cursor - len) + value.slice(cursor);
    setTimeout(() => makeCardsHere(uid, ta, text).catch((err) => { console.error("[auto-anki]", err); toast("Auto-anki failed: " + err.message, "error"); }), 0);
  }, true);

  function makeHereCommand(ctx) {
    const f = api.ui.getFocusedBlock && api.ui.getFocusedBlock();
    const uid = (ctx && ctx["block-uid"]) || (f && f["block-uid"]);
    if (!uid) { toast("Auto-anki: put the cursor in a block first", "warning"); return; }
    const home = homeFromUid(uid);
    if (home) { update(home); return; } // already inside a card section: same as "update cards"
    const ta = [...document.querySelectorAll("textarea.rm-block-input")].find((t) => uidFromTextareaId(t.id) === uid);
    makeCardsHere(uid, ta, ta ? ta.value : blockText(uid)).catch((err) => { console.error("[auto-anki]", err); toast("Auto-anki failed: " + err.message, "error"); });
  }

  function askKey() {
    const overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;";
    overlay.innerHTML = `<div style="background:#fff;padding:16px;border-radius:6px;min-width:420px;box-shadow:0 8px 40px rgba(0,0,0,0.35);font-size:14px;">
      <div style="margin-bottom:8px;">Anthropic API key (kept in this browser only)</div>
      <input type="password" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:4px;" placeholder="sk-ant-…" />
      <div style="margin-top:10px;text-align:right;"><button class="c">Cancel</button> <button class="s" style="margin-left:6px;">Save</button></div></div>`;
    const input = overlay.querySelector("input");
    input.value = apiKey();
    const close = () => overlay.remove();
    overlay.querySelector(".c").onclick = close;
    overlay.querySelector(".s").onclick = () => { const v = input.value.trim(); if (v) localStorage.setItem(KEY_STORAGE, v); else localStorage.removeItem(KEY_STORAGE); close(); toast("Auto-anki: key saved", "success"); };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") overlay.querySelector(".s").click(); if (e.key === "Escape") close(); e.stopPropagation(); });
    document.body.appendChild(overlay);
    setTimeout(() => input.focus(), 0);
  }

  const cmd = { label: "Auto-anki: update cards", callback: () => runCommand(null) };
  if (CONFIG.hotkey) cmd["default-hotkey"] = CONFIG.hotkey;
  api.ui.commandPalette.addCommand(cmd);
  api.ui.commandPalette.addCommand({ label: "Auto-anki: make cards here", callback: () => makeHereCommand(null) });
  api.ui.commandPalette.addCommand({ label: "Auto-anki: set API key", callback: askKey });
  api.ui.commandPalette.addCommand({ label: "Auto-anki: open examples", callback: () => adapter.openPage(CONFIG.examplesPage) });
  // records kept in this browser when Claude asked for Eli; paste into `llm_contact.py report` (README)
  api.ui.commandPalette.addCommand({ label: "Auto-anki: copy LLM inbox records", callback: async () => {
    const r = await window.LlmContact.copyRecords();
    toast(r.count ? `${r.count} LLM inbox record(s) ${r.copied ? "copied as JSON lines" : "printed to the console (clipboard unavailable)"}` : "No LLM inbox records in this browser", "info");
  } });
  // contact_eli messages Claude said were task remarks (confirm step): never sent, kept so they can be audited (README)
  api.ui.commandPalette.addCommand({ label: "Auto-anki: copy unconfirmed LLM messages", callback: async () => {
    const r = await window.LlmContact.copyUnconfirmed();
    toast(r.count ? `${r.count} unconfirmed message(s) ${r.copied ? "copied as JSON lines" : "printed to the console (clipboard unavailable)"}` : "No unconfirmed LLM messages in this browser", "info");
  } });
  api.ui.commandPalette.addCommand({ label: "Auto-anki: edit prompt", callback: async () => {
    try {
      const existing = await adapter.readPageTrees(CONFIG.promptPage);
      if (!existing || !core.promptFromTrees(existing)) await adapter.writePageTrees(CONFIG.promptPage, core.defaultPromptTrees());
      await adapter.openPage(CONFIG.promptPage);
    } catch (e) { console.error("[auto-anki]", e); toast("Auto-anki: could not open the prompt page: " + e.message, "error"); }
  } });
  if (api.ui.blockContextMenu) api.ui.blockContextMenu.addCommand({ label: "Auto-anki: update cards", callback: (ctx) => runCommand(ctx) });
  if (api.ui.blockContextMenu) api.ui.blockContextMenu.addCommand({ label: "Auto-anki: make cards here", callback: (ctx) => makeHereCommand(ctx) });
  window.autoAnki = { update, config: CONFIG, adapter, core };
  console.log("[auto-anki] loaded");
})();
