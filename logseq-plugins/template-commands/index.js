/**
 * Template commands (Logseq file graphs): SmartBlock-style commands for Logseq
 * templates. Logseq expands its own `<% today %>` / `<% current page %>` on
 * insertion; this plugin expands `{%NAME:args%}` tokens (Roam's `<%…%>` delimiters are eaten by Logseq's own template engine, so ours differ) in blocks that
 * were just inserted (from a template, a template button, or typed by hand), and
 * lifts a freshly inserted "metadata" block into page properties.
 *
 * Commands (args separated by commas; tokens nest, inner first):
 *   Cursor/output   CURSOR - NOBLOCKOUTPUT (delete the block if it ends up empty)
 *   This block/page CURRENTPAGENAME - PAGELINK - BLOCKLINK - BLOCKREF (((this block)))
 *   Parent (block the template was inserted under)
 *                   PARENTTEXT - PARENTLINK - PARENTREF - PARENTPAGE
 *   Dates/times     DATE (today's journal link) - DATE:<natural language> (tomorrow,
 *                   yesterday, 3 days ago, 2 weeks from now, next friday, last monday,
 *                   in 1 month, 2026-09-05) - DATEPLAIN:<nl> (no brackets) - TIME - TIMEAMPM
 *   Random          RANDOMNUMBER:a,b - RANDOMBLOCK - RANDOMBLOCKFROM:page -
 *                   RANDOMBLOCKMENTION:page - RANDOMPAGE - RANDOMCHILDOF:((ref)) or page
 *   Input/variables INPUT:prompt[,default] - SET:name,value - GET:name - HAS:name
 *   Flow            IF:condition,then[,else] (condition is JavaScript) -
 *                   IFDAYOFWEEK:1-7 list,text (1 = Monday) - REPEAT:n,text (GET:ITERATION)
 *   Text            CONCAT:a,b,... - UPPER:text - LOWER:text - TRIM:text
 *   Blocks          CHILDREN:((ref)) (refs of its children) - SMARTBLOCK:template name
 *                   (insert another template's blocks after this one)
 *   Code            JAVASCRIPT:code - J:code  (async allowed; `ctx` = {block, page, parent,
 *                   graph, vars}, `logseq` = the plugin API; return value is inserted)
 *
 * Buttons: {{renderer :template-button, Caption, Template name}} renders a button that
 * inserts that template's blocks right after the button's block.
 *
 * Blocks inside template definitions (an ancestor has `template::`) are never touched.
 */

const ATTR_LINE = /^([A-Za-z][\w.\-]*)::[ \t]?(.*)$/;
const vars = {};
const recent = new Set();     // uuids seen in recent onChanged batches (an insertion)
let cursorTarget = null;
let queue = [];
let timer = null;

// ---------------------------------------------------------------- helpers

async function graphName() {
  const g = await logseq.App.getCurrentGraph();
  return g && g.name;
}

async function insideTemplateDefinition(block) {
  let b = block;
  for (let i = 0; i < 40 && b; i++) {
    if (b.properties && b.properties.template !== undefined) return true;
    const pid = b.parent && b.parent.id;
    if (!pid || (b.page && pid === b.page.id)) return false;
    b = await logseq.Editor.getBlock(pid);
  }
  return false;
}

async function ensureId(uuid) {
  const b = await logseq.Editor.getBlock(uuid);
  if (b && !(b.properties && b.properties.id)) await logseq.Editor.upsertBlockProperty(uuid, "id", uuid);
  return uuid;
}

function firstLine(content) {
  return (content || "").split("\n").filter((l) => l.trim() && !ATTR_LINE.test(l.trim()))[0] || "";
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function parentOfInsertion(block) {
  let b = block;
  for (let i = 0; i < 40 && b; i++) {
    const pid = b.parent && b.parent.id;
    if (!pid || (b.page && pid === b.page.id)) return null;
    const parent = await logseq.Editor.getBlock(pid);
    if (!parent) return null;
    if (!recent.has(parent.uuid)) return parent;
    b = parent;
  }
  return null;
}

// ---- dates
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
function pad(n) { return String(n).padStart(2, "0"); }
function formatDate(d, fmt) {
  // the subset of date-fns tokens Logseq's journal formats use
  return fmt.replace(/yyyy|MMMM|MMM|MM|M|dd|do|d|EEEE|EEE|E/g, (t) => ({
    yyyy: String(d.getFullYear()), MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1), M: String(d.getMonth() + 1), dd: pad(d.getDate()), do: ordinal(d.getDate()),
    d: String(d.getDate()), EEEE: DAYS[d.getDay()], EEE: DAYS[d.getDay()].slice(0, 3), E: DAYS[d.getDay()].slice(0, 3),
  })[t]);
}
function parseNaturalDate(text) {
  const s = (text || "").trim().toLowerCase();
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (!s || s === "today" || s === "now") return d;
  if (s === "tomorrow") { d.setDate(d.getDate() + 1); return d; }
  if (s === "yesterday") { d.setDate(d.getDate() - 1); return d; }
  let m = s.match(/^(?:in\s+)?(\d+)\s*(day|week|month|year)s?(?:\s+(ago|from now|hence|later))?$/);
  if (m) {
    const n = parseInt(m[1], 10) * (m[3] === "ago" ? -1 : 1);
    if (m[2] === "day") d.setDate(d.getDate() + n);
    else if (m[2] === "week") d.setDate(d.getDate() + 7 * n);
    else if (m[2] === "month") d.setMonth(d.getMonth() + n);
    else d.setFullYear(d.getFullYear() + n);
    return d;
  }
  m = s.match(/^(next|last|this)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (m) {
    const target = DAYS.findIndex((x) => x.toLowerCase() === m[2]);
    let diff = (target - d.getDay() + 7) % 7;
    if (m[1] === "next" && diff === 0) diff = 7;
    if (m[1] === "last") diff = diff === 0 ? -7 : diff - 7;
    d.setDate(d.getDate() + diff); return d;
  }
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const p = new Date(text);
  return isNaN(p) ? d : p;
}
async function journalTitle(d) {
  const cfg = await logseq.App.getUserConfigs();
  return formatDate(d, (cfg && cfg.preferredDateFormat) || "MMM do, yyyy");
}

// ---- tokenizer: `<%NAME:args%>` with nesting
function findToken(s, from = 0) {
  const i = s.indexOf("{%", from);
  if (i < 0) return null;
  let depth = 0, j = i;
  while (j < s.length) {
    if (s.startsWith("{%", j)) { depth++; j += 2; }
    else if (s.startsWith("%}", j)) { depth--; j += 2; if (depth === 0) return { start: i, end: j, inner: s.slice(i + 2, j - 2) }; }
    else j++;
  }
  return null;
}
function splitArgs(s) {
  // top-level commas only (not inside nested tokens, brackets or parens)
  const out = []; let depth = 0, cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (s.startsWith("{%", i)) { depth++; cur += "{%"; i++; continue; }
    if (s.startsWith("%}", i)) { depth--; cur += "%}"; i++; continue; }
    if (c === "[" || c === "(" || c === "{") depth++;
    if (c === "]" || c === ")" || c === "}") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
const LAZY = new Set(["REPEAT", "IF", "IFDAYOFWEEK", "JAVASCRIPT", "J"]);

async function expandLogseqVars(text, ctx) {
  // Logseq's own template variables, for templates the plugin inserted itself
  const re = /<%\s*([^%]*?)\s*%>/g;
  let out = "", last = 0, m;
  while ((m = re.exec(text))) {
    const v = m[1].trim().toLowerCase();
    let rep;
    if (v === "current page") rep = ctx.page ? `[[${ctx.page.originalName || ctx.page.name}]]` : "";
    else if (v === "time") rep = await runCommand("TIME", "", ctx);
    else rep = `[[${await journalTitle(parseNaturalDate(v))}]]`;
    out += text.slice(last, m.index) + rep; last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

async function expandText(text, ctx) {
  if (text.includes("<%")) text = await expandLogseqVars(text, ctx);
  // repeatedly expand the first token; nested args are expanded before the command
  // unless the command is lazy (it decides what to evaluate)
  let guard = 0;
  while (guard++ < 500) {
    const t = findToken(text);
    if (!t) break;
    const colon = t.inner.indexOf(":");
    const name = (colon < 0 ? t.inner : t.inner.slice(0, colon)).trim().toUpperCase();
    let argText = colon < 0 ? "" : t.inner.slice(colon + 1);
    if (!LAZY.has(name) && argText.includes("{%")) argText = await expandText(argText, ctx);
    let out;
    try { out = await runCommand(name, argText, ctx); }
    catch (e) { console.error("[template-commands]", name, e); out = ""; }
    if (out === undefined || out === null) out = "";
    text = text.slice(0, t.start) + String(out) + text.slice(t.end);
  }
  return text;
}

async function runCommand(name, argText, ctx) {
  const args = splitArgs(argText).map((a) => a.trim());
  const graph = ctx.graph;
  switch (name) {
    case "CURSOR": ctx.cursor = true; return " CURSOR ";
    case "NOBLOCKOUTPUT": ctx.noOutput = true; return "";
    case "CURRENTPAGENAME": return ctx.page ? (ctx.page.originalName || ctx.page.name) : "";
    case "CURRENTPAGE": return ctx.page ? `[[${ctx.page.originalName || ctx.page.name}]]` : "";
    case "PAGELINK": return ctx.page ? `logseq://graph/${graph}?page=${encodeURIComponent(ctx.page.originalName || ctx.page.name)}` : "";
    case "BLOCKLINK": return `logseq://graph/${graph}?block-id=${await ensureId(ctx.block.uuid)}`;
    case "BLOCKREF": return `((${await ensureId(ctx.block.uuid)}))`;
    case "PARENTTEXT": return ctx.parent ? firstLine(ctx.parent.content) : "";
    case "PARENTLINK": return ctx.parent ? `logseq://graph/${graph}?block-id=${await ensureId(ctx.parent.uuid)}` : "";
    case "PARENTREF": return ctx.parent ? `((${await ensureId(ctx.parent.uuid)}))` : "";
    case "PARENTPAGE": { const p = ctx.parent && ctx.parent.page && (await logseq.Editor.getPage(ctx.parent.page.id)); return p ? `[[${p.originalName || p.name}]]` : ""; }
    case "DATE": return `[[${await journalTitle(parseNaturalDate(argText))}]]`;
    case "DATEPLAIN": return await journalTitle(parseNaturalDate(argText));
    case "TIME": { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
    case "TIMEAMPM": { const d = new Date(); const h = d.getHours() % 12 || 12; return `${h}:${pad(d.getMinutes())} ${d.getHours() < 12 ? "AM" : "PM"}`; }
    case "RANDOMNUMBER": { const a = parseInt(args[0], 10) || 0, b = parseInt(args[1], 10) || 1; return String(Math.floor(Math.random() * (b - a + 1)) + a); }
    case "RANDOMBLOCK": return refToRandom(await queryBlocks(`[:find (pull ?b [:block/uuid :block/content]) :where [?b :block/content ?c] [(not= ?c "")] [?b :block/page ?p]]`));
    case "RANDOMBLOCKFROM": return refToRandom(await queryBlocks(`[:find (pull ?b [:block/uuid :block/content]) :where [?b :block/page ?p] [?p :block/name "${lname(argText)}"] [?b :block/content ?c] [(not= ?c "")]]`));
    case "RANDOMBLOCKMENTION": return refToRandom(await queryBlocks(`[:find (pull ?b [:block/uuid :block/content]) :where [?b :block/refs ?r] [?r :block/name "${lname(argText)}"] [?b :block/content ?c] [(not= ?c "")]]`));
    case "RANDOMCHILDOF": {
      const m = argText.match(/\(\(([0-9a-f-]{36})\)\)/);
      const rows = m
        ? await queryBlocks(`[:find (pull ?c [:block/uuid :block/content]) :where [?b :block/uuid #uuid "${m[1]}"] [?c :block/parent ?b]]`)
        : await queryBlocks(`[:find (pull ?c [:block/uuid :block/content]) :where [?p :block/name "${lname(argText)}"] [?c :block/parent ?p]]`);
      return refToRandom(rows);
    }
    case "RANDOMPAGE": {
      const rows = await logseq.DB.datascriptQuery(`[:find ?n :where [?p :block/original-name ?n] (not [?p :block/journal? true])]`);
      const names = (rows || []).map((r) => r[0]).filter(Boolean);
      return names.length ? `[[${names[Math.floor(Math.random() * names.length)]}]]` : "";
    }
    case "INPUT": { const v = window.prompt(args[0] || "Input", args[1] || ""); return v === null ? "" : v; }
    case "SET": ctx.vars[args[0]] = args.slice(1).join(","); return "";
    case "GET": return ctx.vars[args[0]] !== undefined ? ctx.vars[args[0]] : (vars[args[0]] !== undefined ? vars[args[0]] : "");
    case "HAS": return ctx.vars[args[0]] !== undefined || vars[args[0]] !== undefined ? "true" : "false";
    case "IF": {
      const cond = await expandText(args[0] || "", ctx);
      let ok;
      try { ok = !!(new Function("ctx", "logseq", `return (${cond});`))(ctx, logseq); } catch (e) { ok = /^(true|yes|1)$/i.test(cond.trim()); }
      return await expandText(ok ? (args[1] || "") : (args[2] || ""), ctx);
    }
    case "IFDAYOFWEEK": {
      const today = ((new Date().getDay() + 6) % 7) + 1;   // 1 = Monday ... 7 = Sunday
      const days = (args[0] || "").split(/[\s,]+/).map((x) => parseInt(x, 10));
      return days.includes(today) ? await expandText(args.slice(1).join(","), ctx) : "";
    }
    case "REPEAT": {
      const n = parseInt(await expandText(args[0] || "0", ctx), 10) || 0;
      const body = args.slice(1).join(",");
      const texts = [];
      for (let i = 1; i <= n; i++) {
        ctx.vars.ITERATION = String(i);
        texts.push(await expandText(body, ctx));
      }
      delete ctx.vars.ITERATION;
      ctx.siblings.push(...texts);      // become sibling blocks after this one
      return "";
    }
    case "CONCAT": return args.join("");
    case "UPPER": return argText.toUpperCase();
    case "LOWER": return argText.toLowerCase();
    case "TRIM": return argText.trim();
    case "CHILDREN": {
      const m = argText.match(/\(\(([0-9a-f-]{36})\)\)/);
      if (!m) return "";
      const b = await logseq.Editor.getBlock(m[1], { includeChildren: true });
      const out = [];
      for (const c of (b && b.children) || []) out.push(`((${await ensureId(c.uuid || c[1])}))`);
      return out.join(" ");
    }
    case "SMARTBLOCK": ctx.templates.push(argText.trim()); return "";
    case "JAVASCRIPT": case "J": {
      const fn = new Function("ctx", "logseq", `return (async () => { ${argText} })();`);
      const v = await fn(ctx, logseq);
      return v === undefined ? "" : String(v);
    }
    default: return `{%${name}${argText ? ":" + argText : ""}%}`;   // unknown: leave as is
  }
}

function lname(s) { return (s || "").trim().toLowerCase().replace(/"/g, '\\"'); }
async function queryBlocks(q) {
  const rows = await logseq.DB.datascriptQuery(q);
  return (rows || []).map((r) => r[0]).filter((b) => b && b.uuid && !/^[A-Za-z][\w.\-]*::/.test(b.content || "") && !/^\s*$/.test(b.content || ""));
}
async function refToRandom(rows) {
  if (!rows.length) return "";
  const pick = rows[Math.floor(Math.random() * rows.length)];
  return `((${await ensureId(pick.uuid)}))`;
}

// ---- template blocks -> batch for insertBatchBlock
async function templateBatch(name) {
  const rows = await logseq.DB.datascriptQuery(`[:find (pull ?b [:block/uuid]) :where [?b :block/properties ?p] [(get ?p :template) ?t] [(= ?t "${name.replace(/"/g, '\\"')}")]]`);
  const root = rows && rows[0] && rows[0][0];
  if (!root) { logseq.UI.showMsg(`No template named "${name}"`, "warning"); return null; }
  const full = await logseq.Editor.getBlock(root.uuid, { includeChildren: true });
  const strip = (content) => (content || "").split("\n").filter((l) => !/^(id|template|template-including-parent)::/.test(l.trim())).join("\n");
  const conv = (b) => ({ content: strip(b.content), children: (b.children || []).map((c) => conv(c)) });
  const includeParent = !(full.properties && String(full.properties["template-including-parent"]) === "false");
  return includeParent ? [conv(full)] : (full.children || []).map((c) => conv(c));
}

async function insertTemplateAfter(uuid, name, replaceIfEmpty = false) {
  const batch = await templateBatch(name);
  if (!batch || !batch.length) return;
  await logseq.Editor.insertBatchBlock(uuid, batch, { sibling: true, before: false });
  if (replaceIfEmpty) {
    // typed "/name" in an empty block: the template takes that block's place
    const cur = await logseq.Editor.getBlock(uuid);
    if (cur && !(cur.content || "").trim() && !(cur.properties && Object.keys(cur.properties).length)) {
      await logseq.Editor.removeBlock(uuid);
    }
  }
}

async function registerTemplateSlashCommands() {
  // one slash command per template: "/sour" + Enter inserts "Source page template"
  // (decided 2026-09-05: the Roam "jj" habit; Logseq offers plugins only the slash menu)
  let rows = [];
  try {
    rows = await logseq.DB.datascriptQuery(`[:find ?t :where [?b :block/properties ?p] [(get ?p :template) ?t]]`);
  } catch (e) { console.error("[template-commands] template query failed", e); }
  const names = [...new Set((rows || []).map((r) => r[0]).filter((n) => typeof n === "string" && n.trim()))].sort();
  for (const name of names) {
    logseq.Editor.registerSlashCommand(name, async () => {
      const cur = await logseq.Editor.getCurrentBlock();
      if (!cur) return;
      await logseq.Editor.exitEditingMode(true);
      await insertTemplateAfter(cur.uuid, name, true);
    });
  }
  console.log("[template-commands] registered", names.length, "template slash commands");
}

// ---------------------------------------------------------------- per-block expansion

async function expandBlock(block) {
  block = { ...block };
  const content = block.content || "";
  if (!content.includes("{%") && !content.includes("<%")) return;
  if (await insideTemplateDefinition(block)) return;
  const page = block.page && (await logseq.Editor.getPage(block.page.id));
  const ctx = { block, page, parent: null, graph: await graphName(), vars, cursor: false, noOutput: false, siblings: [], templates: [] };
  if (/\{%PARENT(TEXT|LINK|REF|PAGE)%\}/i.test(content)) ctx.parent = await parentOfInsertion(block);
  let out = await expandText(content, ctx);
  let cursorPos = -1;
  // if this block is being edited, the editor's own text would overwrite our update
  try {
    const editing = await logseq.Editor.checkEditing();
    if (editing && editing === block.uuid) await logseq.Editor.exitEditingMode(true);
  } catch (e) { /* older API */ }
  const ci = out.indexOf(" CURSOR ");
  if (ci >= 0) { cursorPos = ci; out = out.replace(" CURSOR ", ""); }
  if (out !== content) {
    await logseq.Editor.updateBlock(block.uuid, out);
    if (!out.trim()) {
      // Logseq ignores an update to empty content: check, and rebuild the block if needed
      const again = await logseq.Editor.getBlock(block.uuid);
      if (again && (again.content || "").trim()) {
        const props = Object.entries(again.properties || {}).filter(([k]) => k !== "id");
        if (props.length) await logseq.Editor.updateBlock(block.uuid, "");
        const fresh = await logseq.Editor.getBlock(block.uuid);
        if (fresh && (fresh.content || "").trim()) {
          const nb = await logseq.Editor.insertBlock(block.uuid, "", { sibling: true, before: true });
          await logseq.Editor.removeBlock(block.uuid);
          if (nb) block = nb;
        }
      }
    }
  }
  let after = block.uuid;
  for (const t of ctx.siblings) {
    const nb = await logseq.Editor.insertBlock(after, t, { sibling: true, before: false });
    if (nb) after = nb.uuid;
  }
  for (const name of ctx.templates) await insertTemplateAfter(after, name);
  if (ctx.noOutput && !out.trim()) { await logseq.Editor.removeBlock(block.uuid); return; }
  if (cursorPos >= 0) cursorTarget = { uuid: block.uuid, pos: cursorPos };
}

// ---- metadata block -> page properties (same rule as the converter's lift)
async function liftMetadata(block) {
  if ((block.content || "").trim().toLowerCase() !== "metadata") return;
  if (await insideTemplateDefinition(block)) return;
  const full = await logseq.Editor.getBlock(block.uuid, { includeChildren: true });
  if (!full || !full.children || !full.children.length) return;
  const page = await logseq.Editor.getPage(block.page.id);
  if (!page) return;
  const props = [], toRemove = [];
  for (const ch of full.children) {
    const c = ch.uuid ? ch : await logseq.Editor.getBlock(ch[1]);
    const lines = (c.content || "").split("\n").filter((l) => l.trim() && !/^id::/.test(l.trim()));
    const text = (lines[0] || "").trim();
    const m = text.match(ATTR_LINE) || text.match(/^(Subtitle):[ \t]*(.*)$/i);
    if (!m || lines.length > 1) continue;
    props.push([m[1].toLowerCase(), m[2].trim()]);
    toRemove.push(c);
  }
  if (!props.length) return;
  for (const c of toRemove) {
    const kids = ((await logseq.Editor.getBlock(c.uuid, { includeChildren: true })) || {}).children || [];
    let after = block.uuid;
    for (const k of kids) {
      const ku = k.uuid || k[1];
      await logseq.Editor.moveBlock(ku, after, { sibling: true, before: false });
      after = ku;
    }
    await logseq.Editor.removeBlock(c.uuid);
  }
  const tree = await logseq.Editor.getPageBlocksTree(page.name);
  const first = tree && tree[0];
  const lines = props.map(([k, v]) => `${k}:: ${v}`);
  if (first && first["preBlock?"]) await logseq.Editor.updateBlock(first.uuid, first.content.trimEnd() + "\n" + lines.join("\n"));
  else if (first) await logseq.Editor.insertBlock(first.uuid, lines.join("\n"), { sibling: true, before: true });
  const rest = await logseq.Editor.getBlock(block.uuid, { includeChildren: true });
  if (rest && !(rest.children && rest.children.length)) await logseq.Editor.removeBlock(block.uuid);
}

async function process() {
  const items = queue; queue = [];
  for (const b of items) { try { await expandBlock(b); } catch (e) { console.error("[template-commands] expand failed", e); } }
  for (const b of items) { try { await liftMetadata(b); } catch (e) { console.error("[template-commands] lift failed", e); } }
  if (cursorTarget) {
    const t = cursorTarget; cursorTarget = null;
    await new Promise((r) => setTimeout(r, 150));
    try { await logseq.Editor.editBlock(t.uuid, { pos: t.pos }); } catch (e) { /* gone */ }
  }
  setTimeout(() => recent.clear(), 5000);
}

// ---------------------------------------------------------------- main

function main() {
  logseq.provideStyle(`
    .tbutton { display: inline-block; padding: 0.05em 0.6em; margin: 0 0.15em; border-radius: 0.35em;
      border: 1px solid var(--ls-border-color, #ccc); background: var(--ls-secondary-background-color, #f2f2f2);
      color: var(--ls-primary-text-color, #333); font-size: 0.9em; line-height: 1.5; cursor: pointer; user-select: none; }
    .tbutton:hover { filter: brightness(0.95); }
  `);
  logseq.provideModel({
    async runTemplateButton(e) { await insertTemplateAfter(e.dataset.uuid, e.dataset.template); },
  });
  logseq.App.onMacroRendererSlotted(({ slot, payload }) => {
    const args = payload.arguments || [];
    if ((args[0] || "").trim() !== ":template-button") return;
    const caption = (args[1] || "").trim(), name = args.slice(2).join(",").trim() || caption;
    logseq.provideUI({
      key: `template-button-${slot}`, slot, reset: true,
      template: `<a class="tbutton" data-on-click="runTemplateButton" data-uuid="${payload.uuid}" data-template="${esc(name)}" title="insert template ${esc(name)}">${esc(caption)}</a>`,
    });
  });
  // typing "/" then a few letters filters this list, the way "<%" did in Roam
  const TOKENS = [
    ["CURSOR", "{%CURSOR%}"], ["NOBLOCKOUTPUT", "{%NOBLOCKOUTPUT%}"],
    ["CURRENTPAGENAME", "{%CURRENTPAGENAME%}"], ["CURRENTPAGE (link)", "{%CURRENTPAGE%}"], ["PAGELINK", "{%PAGELINK%}"], ["BLOCKLINK", "{%BLOCKLINK%}"], ["BLOCKREF", "{%BLOCKREF%}"],
    ["PARENTTEXT", "{%PARENTTEXT%}"], ["PARENTLINK", "{%PARENTLINK%}"], ["PARENTREF", "{%PARENTREF%}"], ["PARENTPAGE", "{%PARENTPAGE%}"],
    ["DATE (today)", "{%DATE%}"], ["DATE: natural language", "{%DATE:tomorrow%}"], ["DATEPLAIN", "{%DATEPLAIN:today%}"], ["TIME", "{%TIME%}"], ["TIMEAMPM", "{%TIMEAMPM%}"],
    ["RANDOMNUMBER", "{%RANDOMNUMBER:1,100%}"], ["RANDOMBLOCK", "{%RANDOMBLOCK%}"], ["RANDOMBLOCKFROM page", "{%RANDOMBLOCKFROM:page name%}"],
    ["RANDOMBLOCKMENTION page", "{%RANDOMBLOCKMENTION:page name%}"], ["RANDOMPAGE", "{%RANDOMPAGE%}"], ["RANDOMCHILDOF", "{%RANDOMCHILDOF:((block ref))%}"],
    ["INPUT prompt", "{%INPUT:Question?,default%}"], ["SET variable", "{%SET:name,value%}"], ["GET variable", "{%GET:name%}"], ["HAS variable", "{%HAS:name%}"],
    ["IF condition", "{%IF:condition,then,else%}"], ["IFDAYOFWEEK", "{%IFDAYOFWEEK:1 2 3 4 5,text%}"], ["REPEAT", "{%REPEAT:{%INPUT:How many?%},Item {%GET:ITERATION%}%}"],
    ["CONCAT", "{%CONCAT:a,b%}"], ["UPPER", "{%UPPER:text%}"], ["LOWER", "{%LOWER:text%}"], ["TRIM", "{%TRIM:text%}"],
    ["CHILDREN of block", "{%CHILDREN:((block ref))%}"], ["SMARTBLOCK: insert template", "{%SMARTBLOCK:Template name%}"], ["JAVASCRIPT", "{%J:return 1 + 1;%}"],
  ];
  for (const [label, text] of TOKENS) {
    logseq.Editor.registerSlashCommand("SB " + label, async () => { await logseq.Editor.insertAtEditingCursor(text); });
  }
  logseq.Editor.registerSlashCommand("template button", async () => {
    await logseq.Editor.insertAtEditingCursor("{{renderer :template-button, Caption, Template name}} ");
  });
  logseq.DB.onChanged(({ blocks }) => {
    for (const b of blocks || []) {
      if (!b || !b.uuid) continue;
      recent.add(b.uuid);
      const c = b.content || "";
      if (((c.includes("{%") || c.includes("<%")) && !/^\s*template::/m.test(c)) || c.trim().toLowerCase() === "metadata") queue.push(b);
    }
    if (queue.length) { clearTimeout(timer); timer = setTimeout(process, 400); }
  });
  setTimeout(registerTemplateSlashCommands, 4000);
  logseq.App.onCurrentGraphChanged(() => setTimeout(registerTemplateSlashCommands, 4000));
  console.log("[template-commands] loaded");
}

logseq.ready(main).catch(console.error);
