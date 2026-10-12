---
name: iterate-on-a-document
description: >-
  Refine a markdown or HTML document with the user by trading turns until they say it is good
  enough. The user edits the file and adds `@AI: <command>` directives — for HTML, by
  clicking elements in the browser — and the agent commits their edits, applies them
  everywhere they fit, and carries out the commands. Use when the user says "iterate on this
  doc", "let's trade turns on this file", or wants to refine a document by editing it themselves.
---

# Iterate on a document

Goal: hand a document back and forth with the user until they say it is good enough, treating
their edits as normative and executing their inline commands.

The loop commits at each turn so every change is legible in git history. It expects the file to
be in a git repository. If it is not, ask the user whether to run `git init` in its directory, or
to name a repository to work in.

Markdown and HTML share the loop. HTML differs in how the user takes a turn and in keeping the
file's formatting stable; the steps marked **HTML** cover that. Skip them for markdown.

## Procedure

0. Commit the file before iterating.
   **HTML:** start the HTML server, then set the baseline:
   - Run in the background: `node <server> <directory holding the file> --port 0`, where
     `<server>` is `../../html-with-comments/server.mjs` resolved from this skill's base
     directory. It needs Node 20 or later and nothing else.
   - It prints `html-notes: http://localhost:<port>/ serving <dir>`. The page URL is that address
     plus the file's path under `<dir>`.
   - Fetch the page URL once (`curl -s -o /dev/null <url>`). The server rewrites the file into
     its normalized formatting on each load. Commit that rewrite as its own commit.
   - From here on, fetch the page URL before every commit in the loop. Formatting then lands in
     the commit that caused it and never reads as the user's next edit.
1. Tell the user to take their turn. Give them the full path to the file. Tell them to make any
   edits they like, and to add `@AI: <command>` directives anywhere in the document.
   **HTML:** give them the page URL instead. Tell them to reload the page, then click any element
   to leave a directive on it, or to change its wording. Their directives and edits save into
   the file. They can also edit the file by hand.
2. Wait. The user's turn ends when they respond.
3. If the user says "good enough", "move on", or equivalent, stop. **HTML:** stop the server.
4. Commit the user's edits as they are, before making any changes.
5. Read the user's edits (`git diff HEAD~1` shows them). Treat each as normative but not
   complete: apply it to every other step or situation in the document where it fits.
6. Commit that generalization.
7. Find every `@AI: <command>` directive in the document. Group commands that belong together
   into batches.
   **HTML:** run `grep -n '<!-- *@AI:' <file>`. A page that talks about directives holds the
   bare `@AI:` in its text, so grep for the HTML comment form. Each directive is an HTML comment,
   `<!-- @AI: ... -->`, about the element that contains it as its first child — or, just before
   a void or raw-text element, about that next element. The full list of those elements is under
   "Directive format" in `../../html-with-comments/README.md`.
8. For each batch: interpret and execute the commands, remove that batch's directives from the
   document, then commit the result.
   **HTML:** edit the file in place. Never regenerate it from scratch while
   `grep -c '<!-- *@AI:'` is above 0, or unresolved directives are lost.
9. Summarize the actions you took, in brief.
10. Go to step 1.
