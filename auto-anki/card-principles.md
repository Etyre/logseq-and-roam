# How Eli makes Anki cards — principles distilled from the Roam graph

Source: export `eli-2026-09-04-20-14-54.json`. 7,047 `#ankify` blocks on 1,268 pages (2020–2026);
1,012 are template placeholders, leaving 6,035 real notes (5,841 content cards). Evidence: statistics
over all cards, full reads of 90 pages (2,000+ cards in context, including what was NOT carded), Eli's
own meta pages (My spaced repetition systems…, My Anki patterns, An Opinionated Guide…), and the
2023–2026 `#[[auto-anki]]` trials where GPT drafted cards and Eli kept 84, rejected 84 and wrote 17
replacements. Ranked by confidence × how much it changes which cards get written.

## Selection — which facts become cards

1. **Only settled, source-derived facts. Never Eli's own thoughts, plans, logs, opinions, or the author's argument.** 0 of hundreds of reflective blocks are carded, even ones written in cloze syntax. Explicit: "I think this might be an important thing to internalize, but I won't do it by making spaced repetition cards." Other people's claims are carded only as attributed claims ("Kissinger claims…", "Drexler predicts…").
2. **Definitions of named terms are carded almost automatically** when the term is discrete and understood ("Supermodular good:", "What is quantization?", "POMDP:"). Lists of names not yet understood are refused ("This quote is not really helpful, because it is only the names for things"); unresolved terms stay as untagged stubs ("What is mTOR").
3. **One or two headline magnitudes per topic, rounded; incidental and exact numbers skipped.** "About a third", "About 75 million" (source: 76M), "{2}%" (source: 2.2%). Exact figures get suspended: "I don't think knowing the exact number will ever help me." Tables collapse into comparisons ("Hydrogen is {more} than {twice} that of {gasoline}"). Own rule (2021): "I should be memorizing numbers in orders of magnitude."
4. **The causal "why" sits next to the fact.** A short, settled mechanism gets its own card, usually beside the bare fact ("When bond prices fall, interest rates {rise}" + "Why is it that when bond prices fall, interest rates rise?"). 19% of question cards are why/how. In the GPT trials, 13 of 20 why/how drafts were kept versus half of the what/who/when drafts; murky mechanisms ("unclear to me") get no card.
5. **Surprise is the trigger; the already-known is skipped.** Carded facts are the ones marked "?!", "Huh", "Wait, what? How?" (polio rising with sanitation, suicide > homicide). Passages marked "Yep, not news", "I know all this", "he hasn't said anything new" produce nothing.
6. **The thesis, not the support.** Card a source's central claim or key distinction; skip narrative colour, supporting arguments and the author's examples (examples survive only as recognition items, e.g. Spy the Lie phrase → category). Long argument pages (Kissinger, Why We're Polarized) yield ~12 cards over hundreds of lines.
7. **People: one salient attribute for central actors, nothing for secondary names.** Noyce gets 5 cards, Grove none. Biographies card character traits heavily (Hoover: taciturn, thin-skinned, "bluntest man in Europe") over event sequences.
8. **Verify first, card the verified value, attribute the source.** Doubted claims get a "Fact checking" child and the corrected number is what gets tagged; uncertain items are left untagged or `#ir`, doubted cards struck or suspended. Own rule: "Record the data, not the inference"; volatile facts carry a date ("In November 2023…", "as of 2022"); news and current events are skipped as not evergreen.
9. **Procedures and skills become task cards, not text recall.** Exercise URL, "Prove…", "Draw…", "Explain why…", "Rehearse the TAP: …", with an attempt log on the page; only 1–3-step how-tos and command↔meaning pairs are carded as text ("git branch -M main" → meaning).
10. **Be sparing.** ~5% of a page's blocks; roughly 1 card per 6–7 lines of book notes; median 4–5 real cards on an ordinary page; 398 of 551 source pages have no content cards at all. Own conclusion (2025): cut new cards, 5 a day.
11. **Own misses become cards.** A missed part is split into its own card ("when I get a card partially right I split out a new card with just the part that I missed"); confusable items get distinguisher cards.

## Form — how a card is written

12. **Two forms, often both for one fact:** 67% Basic (prompt block + child answer), 33% cloze. Cloze dominates on quoted/conceptual text, Basic on lectures and lists.
13. **Redundancy by design: one fact → 2–4 cards.** Cloze + Q/A, forward + reverse (date→event and event→date), both polarities ("thin wires {more} resistance" / "thick wires {less}"), coarse + fine. 3,817 of 5,841 cards share their parent with another card; Missouri Compromise gets 9.
14. **Short.** Front median 10 words, 41% ≤ 8 words; answer median ~5 words, one line. Lists become child bullets with a count cue in the prompt ("[two things]", "[3 brain regions]"). Stated aim: "fewer than 8 syllables if possible", less full sentences.
15. **Cloze shape:** one declarative sentence, subject visible as the cue, the terminal payload hidden (55% of deletions are a single word). `{1:…}` groups reveal a set together (398 cards); separate indices split independent recalls; digits are clozed individually for dates ("194{7}", "{4}{7}{6}"); `::category` hints are rare (82) and added after a miss ("{cold::hot/cold}").
16. **Prompt templates:** "What is/was X?"; bare "Term:" (374); sentence stem ending "…" with the answer starting "…" (208); "X =" for formulas. A scope anchor opens the prompt when needed ("In 1900,", "JS:", "In RL,", "Plan A:") and the discriminating word is underlined ("__yearly__", "__first__", "__range__"; 187 cards). GPT drafts were rejected when the prompt was vague or fragmentary ("What does the lecture examine?", "What did peasants gain by relocating?").
17. **Own words, fast.** Rephrase the source into plain compressed speech; verbatim only for quotable lines and recognition phrases; typos tolerated. `[[Page links]]` when the concept has a page (329 cards). Caveats stay inside the answer ("I haven't tested this though").
18. **Recognition drills:** image front → name/category (names and faces, body-language gifs, supply/demand graphs), many cards sharing one answer.

## Placement and process

19. **A card is a child of a `[[compression]]` block nested under the source paragraph, quote or LLM answer** (75–100% on source pages); concept pages keep a `Meta > Cards` section; every source page/chapter carries a placeholder card. Drafts are written first and `#ankify` is the commitment step (`#ir` = compressed, not yet carded). Cards are often added on a later pass, after rehearsal; suspend rather than delete.

## What the GPT-draft trials add (84 kept / 84 rejected / 17 rewritten)

- Rejected: one paragraph shattered into 8–12 fragment questions (Jan 2 2026: 12 drafts, 0 kept); trivia (Coxey's start date, hometown, "3 to 4 days per week"); answers that only restate the premise; "It is not specified"; meta questions about the lecture.
- Kept: the definition, the one memorable number, the causal "why", the comparison, the surprising detail.
- Rewritten: fragments merged into one card with a two-bullet answer ("How did the business leaders of the first half of the 20th century differ from those of the second?"), relationships turned into clozes ("Hooks and html attributes all take {1:pointers to functions}, not {1:function calls}"), the missing "why" added ("How is the wobble of a star, caused by a hot Jupiter, detected?").
