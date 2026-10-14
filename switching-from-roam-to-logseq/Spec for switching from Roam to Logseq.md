I have been using Roam for years, and I want to switch to Logseq.

To do this, I want to recreate all the functionality that I’ve built up in Roam, from software addons, etc.

I want to do this step by step and carefully, making sure that I don't  break anything, and that everything works. 

I

The first and most important thing: 

I currently use Ankify\_Roam to sync between Roam and my Anki Decks. I need to make it so that all of those anki cards are linked to the relevant blocks in Logseq in addition to in Roam.

First, I want to create Ankify\_Logseq, a version of Ankify\_Roam that has the exact same functionality (with one additional feature, see below), but which syncs between Logseq and Anki. . Do this in the directory title ankify_logseq.

The feature that I want to add to to ankify\_logseq: Each note should list the UID of the block that corresponds to that note, and *also* the UID of the parent of the block that corresponds to that note. That way, I can include a link that opens to not just the block of that note, but the block that contains all sibling notes.

II

Then we need to pair all of the existing cards in Anki that were created by Ankify\_Roam with the corresponding blocks in Logseq. My recommended way to do this is, instead of *replacing* the the roam UID with the logseq UID, we make each anki note have multiple fields, one that has the UID of the block that corresponds to the note in Roam, and the other that has the UID of the corresponding block in logseq.

(I have already added the field “logseq uid” the Roam Basic and Roam Cloze note types.

This way, I never break the existing connection between roam blocks and anki notes (which is one of the major risks of this transition).

In principle, I should be able to switch back and forth between keeping my Anki decks synced to Roam or synced to Logseq. (Though, of course, if I make new cards in one database but not the other, an additional step will be needed to sync between the Roam database and the Logseq database.)

We will need to write a program to pair anki notes with the relevant block in logseq. Probably the way that program should work is it should iterate through all of the Roam Cloze and Roam Basic notes. For each one, it should take the roam UID, use that to identify the corresponding block in Rome, and then use the context of that page to identify the UID of the mirrored block in logseq, grab that logseq UID (and the logseq UID of the parent of that block), and put it back on the Anki note. But I’m open to proposals for other workflows that might work better.

Do this work in the directory titled switching-from-roam-to-logseq.

III

Some anki notes in roam have web and desktop links to blocks in roam. 

* Placeholder card for this page:  
  * \[\[electric motor\]\]   
    Web link: [https://roamresearch.com/\#/app/eli/page/kSOqX5rMN](https://roamresearch.com/#/app/eli/page/kSOqX5rMN)   
    Desktop link: roam://\#/app/eli/page/kNzkrXI3G   
    \#ankify \#\[\[ankify\_roam: deck="Spaced Learning Projects \- removed decks::Concepts"\]\] {{\[\[roam/render\]\]:((nU1XMzhKA)) "Block UID" }} \#\[\[ankify\_roam: suspend=True\]\]

After porting my roam database into logseq, we should add a logseq desktop link to the corresponding block in logseq.

Do this work in the directory titled switching-from-roam-to-logseq.

IV

In my roam database, there are some block embeds in roam that have double double-parentheses, like this: 

{{\[\[embed\]\]: ((((HpoFEiw2k))))}}

Roam renders these as if there were only the required two sets of parentheses, but logseq gets confused by this syntax.

The best thing to do would be to cause logseq to parse these lines. But second best is to go through and remove two sets of paratheses from each embed line that has this pattern.

Do this work in the directory titled switching-from-roam-to-logseq.

V

I currently back up my roam database to github using roam-to-git. I want to set up similar github backups of logseq.

Additionally, I want to set up some kind of local backup for my logseq database.

VI

I have a number of Roam render and Roam JS code blocks that are performing some function in my Roam database.

We want to rebuild them all in whatever the native format is for log seq, so that those code blocks can do the same thing in the logsake database. 

(These are on, or linked to the \[\[roam/render\]\] and \[\[roam/js\]\] pages.)

Do this work in the directory titled switching-from-roam-to-logseq.

VII

I have a number of templates in Roam, including templates that rely on custom smart blocks. I want to recreate all of these templates, including recreating their smart block functionality in Logseq. 

Do this work in the directory titled switching-from-roam-to-logseq.

VIII

I have written a script, relying on some external code, that automatically imports transcripts from Ottr onto each of the following roam pages:

* \[\[Otter auto-imported transcripts (no folder)\]\]  
* \[\[Otter auto-import walking journal transcripts\]\]  
* \[\[Otter auto-imported audio notes transcripts\]\]

(Although notably, some part of that workflow has stopped working in recent months, and so those pages are not fully up to date with Otter.) 

I want to recreate that functionality for Logseq. On some regular basis (every day?), some software should go use the otter api to grab the otter transcripts and put them on the relevant pages, in the desired format.

IX

In the process of doing this, you should also be on the lookout for additional functionality that I've forgotten about that we need to rebuild in order to recreate all the functionality that I have in Roam in Logseq.



Do you have any questions about any of this?