# Your report page

Your page is `away/<agent>.html`. It's scratch for Jess's review; she deletes `away/` afterward, so anything that must last goes in commit messages, CLAUDE.md, or yaks. The scaffold made it with your name, yaks, plan, and files. Only you edit it, apart from one marker the coordinator fills after your merge. The coordinator reads it and links it from `index.html`; don't edit `index.html`.

## Sections

Each section is a `<section>` with this id and class, in this order. To change a section, Edit its contents; keep the ids, classes, and order.

1. `status`: `<p class="status-value">` holds one of `planned`, `working`, `merged-ready`, `blocked`, `abandoned`. `<p class="status-why">` holds one line on why.
2. `plan`: your yaks, the work, and the files you may touch. When the plan changes, revise it and say why in the Log.
3. `log`: one `<li>` per entry, newest last, 1 to 3 lines each. Start with the date and time: `<li>2026-10-24 14:05: ...</li>`.
4. `guesses`: one block per guess, in this shape:

   ```html
   <div id="guess-short-name" class="guess">
     <p><strong>Guess:</strong> what you chose.</p>
     <p><strong>Why:</strong> what made you choose it.</p>
     <p><strong>If wrong:</strong> what to change, with file names.</p>
   </div>
   ```

   The id starts `guess-` and stays fixed once written, so links to it hold. Replace "None yet." with the first block.
5. `result`: commits (short hash and subject), the tests you ran with their pass counts, and what changed for a user.
6. `diff`: holds only `<!-- coordinator: diff -->`. Leave it alone. After your merge, the coordinator replaces it with a link to your merge on GitHub, since the merge commit doesn't exist until then.
7. `gotchas`: things that tripped you, one `<li>` each, as candidates for CLAUDE.md fixes. Say what would have saved the time.
8. `new-yaks`: each yak you added, as `<li><code>full-yak-id</code>: name</li>`.

## When to update

- At the start: status `working`, and a Log entry.
- After each commit: a Log entry with the short hash.
- When you make a guess: a Guesses block and a Log entry.
- At the end: status (`merged-ready` when the suite is green and the branch is ready for the coordinator), Result, Gotchas, and New yaks.

## How the update travels

The page update rides along in your own commits on your branch: edit the page, then commit it with the code change it describes. A status change with no code change gets its own small commit. The coordinator merges your branch, page and all.

If the repo has rules for HTML files it serves or formats, follow them on your page too. In html-revisor, that means running the formatter and then cleanup, so the page has no `data-hrv` attributes; after that, Read the page before your next Edit.

## Writing

Plain, direct sentences. No adverbs. Name files and yak IDs in `<code>`. No JS, and no external links except the diff link; relative links to the other pages here are fine.
