/**
 * Random page (Logseq file graphs). Replaces the roam/js "random page" button from
 * Eli's Roam graph: a toolbar button, a command-palette entry and the shortcut Alt+R
 * (the Roam script's key) open a random non-journal page.
 */

async function randomPage() {
  let rows;
  try {
    rows = await logseq.DB.datascriptQuery(
      `[:find ?name :where [?p :block/name ?name] [?p :block/original-name] (not [?p :block/journal? true])]`
    );
  } catch (e) {
    console.error("[random-page] query failed", e);
    return;
  }
  const names = (rows || []).map((r) => r[0]).filter(Boolean);
  if (!names.length) return;
  const name = names[Math.floor(Math.random() * names.length)];
  logseq.App.pushState("page", { name });
}

function main() {
  logseq.provideModel({ randomPage });
  logseq.App.registerUIItem("toolbar", {
    key: "random-page",
    template: `<a class="button" data-on-click="randomPage" title="Random page (Alt+R)" style="display:flex;align-items:center;justify-content:center;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="16" cy="8" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="1.4" fill="currentColor" stroke="none"/><circle cx="16" cy="16" r="1.4" fill="currentColor" stroke="none"/></svg></a>`,
  });
  logseq.App.registerCommandPalette(
    { key: "random-page", label: "Random page", keybinding: { binding: "alt+r", mode: "global" } },
    randomPage
  );
  console.log("[random-page] loaded");
}

logseq.ready(main).catch(console.error);
