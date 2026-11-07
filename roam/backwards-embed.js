/**
 * Backwards embed for Roam Research (roam/js).
 *
 * Trigger "Backwards embed" while editing a block (type a slash trigger such as /bembed,
 * or use the command palette, hotkey, or block context menu), pick a page from the
 * filtered list, and the script:
 *   1. creates a new block on that page (top-level, at the end; or nested under the
 *      first block matching one of CONFIG.parentBlockNames, tried in order);
 *   2. inserts {{[[embed-path]]: ((new-uid))}} (an embed with a source breadcrumb at
 *      the top; plain "embed" via CONFIG.embedKind) into the block you triggered it from;
 *   3. puts the cursor inside the embedded block so you can start typing.
 *
 * Install: on any page create a block containing exactly  {{[[roam/js]]}}  , nest a
 * child block under it holding a javascript code block with this file's contents,
 * and accept the "Yes I know what I'm doing" prompt. Reload the graph.
 */
(function () {
  const CONFIG = {
    // Nest the new block under a parent block on the target page. The names are tried
    // in order: the first name that matches a block on the page wins (case-insensitive;
    // "[[x]]", "#x", "#[[x]]" and a trailing colon also match). Set to [] to always
    // append at the top level of the page.
    parentBlockNames: ["Global notes:", "General notes:", "Notes:"],
    // If none of those blocks exists on the page, create the first name (true) or fall
    // back to appending at the top level (false).
    createParentIfMissing: false,
    // true: embed the parent block itself (with all its children in one embed) instead
    // of a single new block; a new child is only created when the parent has none.
    // false: always create a new block under the parent and embed just that block.
    embedParentWithChildren: false,
    // Text of the new block. Leave "" to start empty.
    newBlockText: "",
    // "embed-path" shows a breadcrumb (source page > parent block) at the top of the
    // embed; "embed" is a plain embed. Only affects embeds made by this command.
    embedKind: "embed-path",
    // Command-palette hotkey. Roam format, e.g. "ctrl-shift-e", "alt-e".
    hotkey: "ctrl-alt-e",
    // Slash triggers: typing one of these at the start of a block or after a space opens
    // the picker (case-insensitive); the trigger text is removed from the block. Roam
    // has no API for adding entries to its own "/" menu, so the trigger fires as soon as
    // the text is complete. Set to [] to disable.
    slashTriggers: ["/bembed", "/backwards embed"],
    // Show journal (daily-notes) pages in the picker.
    includeJournalPages: true,
  };

  const LABEL = "Backwards embed";
  const api = window.roamAlphaAPI;
  if (!api) return;
  if (window.__backwardsEmbedLoaded) return;
  window.__backwardsEmbedLoaded = true;

  // ---------- helpers ----------
  const uidFromTextareaId = (id) => (id && id.length > 9 ? id.slice(-9) : null);

  // Remember the most recently focused block in case the command palette steals focus.
  let lastFocused = null;
  document.addEventListener(
    "focusin",
    (e) => {
      const t = e.target;
      if (t && t.tagName === "TEXTAREA" && t.classList.contains("rm-block-input")) {
        lastFocused = { uid: uidFromTextareaId(t.id), textarea: t, at: Date.now() };
      }
    },
    true
  );

  function normaliseName(s) {
    return String(s || "")
      .trim()
      .replace(/^#/, "")
      .replace(/^\[\[(.*)\]\]$/, "$1")
      .replace(/:$/, "")
      .trim()
      .toLowerCase();
  }

  const sortedChildren = (b) => [...((b && b[":block/children"]) || [])].sort((a, c) => (a[":block/order"] || 0) - (c[":block/order"] || 0));

  function findParentBlock(children, wanted) {
    for (const b of sortedChildren({ ":block/children": children })) {
      if (normaliseName(b[":block/string"]) === wanted) return b;
      const inner = findParentBlock(b[":block/children"], wanted);
      if (inner) return inner;
    }
    return null;
  }

  // Accepts the list, or a single string for older configs.
  function parentNames() {
    const raw = CONFIG.parentBlockNames !== undefined ? CONFIG.parentBlockNames : CONFIG.parentBlockName;
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map((n) => String(n || "").trim()).filter((n) => normaliseName(n));
  }

  async function getOrCreatePage(title) {
    const existing = api.pull("[:block/uid]", [":node/title", title]);
    if (existing && existing[":block/uid"]) return existing[":block/uid"];
    const uid = api.util.generateUID();
    await api.data.page.create({ page: { title, uid } });
    return uid;
  }

  async function newBlock(parentUid) {
    const uid = api.util.generateUID();
    await api.data.block.create({
      location: { "parent-uid": parentUid, order: "last" },
      block: { string: CONFIG.newBlockText, uid },
    });
    return uid;
  }

  // Returns { embedUid, focusUid, focusAtEnd }.
  async function resolveOnPage(title) {
    const pageUid = await getOrCreatePage(title);
    let parent = null;
    const names = parentNames();
    if (names.length) {
      const page = api.pull("[:block/uid {:block/children [:block/uid :block/string :block/order {:block/children ...}]}]", [":block/uid", pageUid]);
      const children = page && page[":block/children"];
      for (const name of names) {
        parent = findParentBlock(children, normaliseName(name));
        if (parent) break;
      }
      if (!parent && CONFIG.createParentIfMissing) {
        const uid = api.util.generateUID();
        await api.data.block.create({
          location: { "parent-uid": pageUid, order: "last" },
          block: { string: names[0], uid },
        });
        parent = { ":block/uid": uid, ":block/children": [] };
      }
    }
    if (parent && CONFIG.embedParentWithChildren) {
      const kids = sortedChildren(parent);
      if (kids.length) {
        return { embedUid: parent[":block/uid"], focusUid: kids[kids.length - 1][":block/uid"], focusAtEnd: true };
      }
      const uid = await newBlock(parent[":block/uid"]);
      return { embedUid: parent[":block/uid"], focusUid: uid, focusAtEnd: false };
    }
    const uid = await newBlock(parent ? parent[":block/uid"] : pageUid);
    return { embedUid: uid, focusUid: uid, focusAtEnd: false };
  }

  function currentBlockString(uid, textarea, override) {
    if (override) return override;
    if (textarea && textarea.isConnected && uidFromTextareaId(textarea.id) === uid) {
      return { text: textarea.value, cursor: textarea.selectionStart };
    }
    const b = api.pull("[:block/string]", [":block/uid", uid]);
    const text = (b && b[":block/string"]) || "";
    return { text, cursor: text.length };
  }

  // Roam keeps the editing textarea mounted even when it loses focus, so a blur does
  // not end editing. Escape does; a click outside the block is the fallback.
  function exitEditMode(textarea) {
    const ta = textarea && textarea.isConnected ? textarea : document.querySelector("textarea.rm-block-input");
    if (ta) {
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    }
    setTimeout(() => {
      if (!document.querySelector("textarea.rm-block-input")) return;
      const outside = document.querySelector(".roam-article") || document.body;
      for (const type of ["mousedown", "mouseup", "click"]) {
        outside.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
    }, 80);
  }

  function embeddedBlockElement(uid) {
    // Prefer the copy rendered inside an embed (the block may also be on the current page).
    const all = [...document.querySelectorAll(`[id^="block-input-"][id$="-${uid}"]`)];
    const inEmbed = all.filter((el) => el.closest(".rm-embed-container, .rm-embed-path-container, [class*='rm-embed']"));
    const pick = inEmbed.length ? inEmbed : all;
    return pick.length ? pick[pick.length - 1] : null;
  }

  function focusEmbeddedBlock(uid, atEnd, tries = 0) {
    const el = embeddedBlockElement(uid);
    if (!el) {
      if (tries < 30) setTimeout(() => focusEmbeddedBlock(uid, atEnd, tries + 1), 100);
      return;
    }
    // id = block-input-<window-id>-<uid>
    const windowId = el.id.slice("block-input-".length, -(uid.length + 1));
    const arg = { location: { "block-uid": uid, "window-id": windowId } };
    if (atEnd) {
      const b = api.pull("[:block/string]", [":block/uid", uid]);
      const len = ((b && b[":block/string"]) || "").length;
      arg.selection = { start: len, end: len };
    }
    const viaApi = api.ui.setBlockFocusAndSelection(arg);
    Promise.resolve(viaApi).then(() => {
      setTimeout(() => {
        const ta = document.activeElement;
        if (ta && ta.tagName === "TEXTAREA" && uidFromTextareaId(ta.id) === uid) return;
        clickBlock(embeddedBlockElement(uid));
      }, 150);
    }).catch(() => clickBlock(embeddedBlockElement(uid)));
  }

  function clickBlock(el) {
    if (!el) return;
    const target = el.querySelector(".rm-block-text, .roam-block") || el;
    for (const type of ["mousedown", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  async function doBackwardsEmbed(target, title) {
    title = title.trim();
    if (!title) return;
    const { text, cursor } = currentBlockString(target.uid, target.textarea, target.override);
    const { embedUid, focusUid, focusAtEnd } = await resolveOnPage(title);
    const embed = `{{[[${CONFIG.embedKind || "embed"}]]: ((${embedUid}))}}`;
    let next;
    if (!text.trim()) next = embed;
    else {
      const before = text.slice(0, cursor), after = text.slice(cursor);
      const sep1 = before && !/\s$/.test(before) ? " " : "";
      const sep2 = after && !/^\s/.test(after) ? " " : "";
      next = before + sep1 + embed + sep2 + after;
    }
    await api.data.block.update({ block: { uid: target.uid, string: next } });
    // Leave edit mode so the embed renders, then put the cursor in the embedded block.
    exitEditMode(target.textarea);
    setTimeout(() => focusEmbeddedBlock(focusUid, focusAtEnd), 250);
  }

  // ---------- page picker ----------
  function allPageTitles() {
    const rows = api.q("[:find ?t :where [?p :node/title ?t]]");
    let titles = rows.map((r) => r[0]);
    if (!CONFIG.includeJournalPages) {
      const journal = /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}(st|nd|rd|th), \d{4}$/;
      titles = titles.filter((t) => !journal.test(t));
    }
    return titles;
  }

  function rank(titles, query) {
    const q = query.trim().toLowerCase();
    if (!q) return titles.slice(0, 40);
    const starts = [], contains = [];
    for (const t of titles) {
      const l = t.toLowerCase();
      if (l.startsWith(q)) starts.push(t);
      else if (l.includes(q)) contains.push(t);
    }
    const byLen = (a, b) => a.length - b.length;
    return starts.sort(byLen).concat(contains.sort(byLen)).slice(0, 40);
  }

  function showPicker(onPick) {
    document.getElementById("backwards-embed-picker")?.remove();
    const titles = allPageTitles();
    const exact = new Set(titles.map((t) => t.toLowerCase()));

    const overlay = document.createElement("div");
    overlay.id = "backwards-embed-picker";
    overlay.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.25);display:flex;align-items:flex-start;justify-content:center;padding-top:12vh;";
    const box = document.createElement("div");
    box.style.cssText = "background:#fff;color:#202b33;min-width:420px;max-width:600px;width:50vw;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,0.35);font-size:14px;overflow:hidden;";
    const input = document.createElement("input");
    input.placeholder = "Backwards embed to page…";
    input.style.cssText = "width:100%;box-sizing:border-box;padding:12px 14px;border:none;border-bottom:1px solid #e1e8ed;font-size:16px;outline:none;";
    const list = document.createElement("div");
    list.style.cssText = "max-height:50vh;overflow-y:auto;";
    box.append(input, list);
    overlay.append(box);
    document.body.append(overlay);

    // Drafts are never lost: the query is saved as you type and comes back (selected, so typing
    // replaces it) the next time the picker opens; it is cleared only when a page is chosen.
    const DRAFT_KEY = "backwards-embed:query";
    const draft = { get: () => { try { return localStorage.getItem(DRAFT_KEY) || ""; } catch (e) { return ""; } },
      set: (v) => { try { if (v) localStorage.setItem(DRAFT_KEY, v); else localStorage.removeItem(DRAFT_KEY); } catch (e) {} } };
    input.value = draft.get();

    let items = [], selected = 0;
    function render() {
      const q = input.value;
      items = rank(titles, q);
      const trimmed = q.trim();
      if (trimmed && !exact.has(trimmed.toLowerCase())) items.push({ create: trimmed });
      if (selected >= items.length) selected = Math.max(0, items.length - 1);
      list.innerHTML = "";
      items.forEach((it, i) => {
        const row = document.createElement("div");
        row.textContent = typeof it === "string" ? it : `Create page "${it.create}"`;
        row.style.cssText = `padding:8px 14px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${i === selected ? "background:#e7f1fb;" : ""}${typeof it !== "string" ? "font-style:italic;color:#5c7080;" : ""}`;
        row.addEventListener("mousemove", () => { if (selected !== i) { selected = i; render(); } });
        row.addEventListener("mousedown", (e) => { e.preventDefault(); choose(i); });
        list.append(row);
      });
      const sel = list.children[selected];
      if (sel) sel.scrollIntoView({ block: "nearest" });
    }
    function close() { overlay.remove(); }
    function choose(i) {
      const it = items[i];
      if (it === undefined) return;
      draft.set(""); // submitted: the draft has done its job
      close();
      onPick(typeof it === "string" ? it : it.create);
    }
    input.addEventListener("input", () => { draft.set(input.value); selected = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); selected = Math.min(selected + 1, items.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selected = Math.max(selected - 1, 0); render(); }
      else if (e.key === "Enter") { e.preventDefault(); choose(selected); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
      e.stopPropagation();
    });
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    render();
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  // ---------- entry points ----------
  function resolveTarget(fromMenu) {
    if (fromMenu && fromMenu["block-uid"]) return { uid: fromMenu["block-uid"], textarea: null };
    const focused = api.ui.getFocusedBlock && api.ui.getFocusedBlock();
    if (focused && focused["block-uid"]) {
      const ta = document.activeElement && document.activeElement.tagName === "TEXTAREA" ? document.activeElement : (lastFocused && lastFocused.textarea);
      return { uid: focused["block-uid"], textarea: ta };
    }
    if (lastFocused && lastFocused.uid && Date.now() - lastFocused.at < 60000) return { uid: lastFocused.uid, textarea: lastFocused.textarea };
    return null;
  }

  function run(fromMenu, explicitTarget) {
    const target = explicitTarget || resolveTarget(fromMenu);
    if (!target) {
      window.iziToast ? iziToast.warning({ message: "Backwards embed: put the cursor in a block first." }) : alert("Backwards embed: put the cursor in a block first.");
      return;
    }
    showPicker((title) => doBackwardsEmbed(target, title).catch((e) => { console.error("[backwards-embed]", e); alert("Backwards embed failed: " + e.message); }));
  }

  // ---------- slash trigger ----------
  function matchTrigger(before) {
    const lower = before.toLowerCase();
    for (const raw of CONFIG.slashTriggers || []) {
      const t = String(raw || "").toLowerCase();
      if (!t || !lower.endsWith(t)) continue;
      const start = lower.length - t.length;
      if (start === 0 || /\s/.test(lower[start - 1])) return t.length;
    }
    return 0;
  }

  // Set a React-controlled textarea's value so Roam picks the change up.
  function setTextareaValue(ta, value, cursor) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    ta.setSelectionRange(cursor, cursor);
  }

  let handlingTrigger = false;
  document.addEventListener(
    "input",
    (e) => {
      if (handlingTrigger) return;
      const ta = e.target;
      if (!ta || ta.tagName !== "TEXTAREA" || !ta.classList.contains("rm-block-input")) return;
      const uid = uidFromTextareaId(ta.id);
      if (!uid) return;
      const cursor = ta.selectionStart;
      const before = ta.value.slice(0, cursor);
      const len = matchTrigger(before);
      if (!len) return;
      const text = before.slice(0, -len) + ta.value.slice(cursor);
      const at = cursor - len;
      handlingTrigger = true;
      setTimeout(() => {
        try {
          setTextareaValue(ta, text, at);
        } finally {
          handlingTrigger = false;
        }
        // Give Roam a tick to close its own "/" popup before the picker takes focus.
        setTimeout(() => run(null, { uid, textarea: ta, override: { text, cursor: at } }), 50);
      }, 0);
    },
    true
  );

  api.ui.commandPalette.addCommand({ label: LABEL, callback: () => run(null), "default-hotkey": CONFIG.hotkey });
  if (api.ui.blockContextMenu) {
    api.ui.blockContextMenu.addCommand({ label: LABEL, callback: (ctx) => run(ctx) });
  }
  window.backwardsEmbed = { run, config: CONFIG };
  console.log("[backwards-embed] loaded");
})();
