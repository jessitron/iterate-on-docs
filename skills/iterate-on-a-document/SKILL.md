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
to name a repository to work in. If it is inconvenient to commit in the current repository, create a scratch one.

For HTML, each **HTML:** mark names a section of `html.md` to do at that point. Markdown needs
nothing more.

## Procedure

0. **HTML:** Start. Commit the file.
1. Tell the user to take their turn. Give them the full path to the file. Tell them to make any
   edits they like, and to add `@AI: <command>` directives anywhere in the document.
   **HTML:** Hand off.
2. Wait. The user's turn ends when they respond.
3. If the user says "good enough", "move on", or equivalent, stop. **HTML:** End.
4. Commit the user's edits as they are, before making any changes.
5. Read the user's edits (`git diff HEAD~1` shows them). Treat each as normative but not
   complete: apply it to every other step or situation in the document where it fits.
6. Commit that generalization.
7. Find every `@AI: <command>` directive in the document. **HTML:** Find directives.
   Group commands that belong together into batches.
8. For each batch: interpret and execute the commands, remove that batch's directives from the
   document, then commit the result.
9. Summarize the actions you took, in brief.
10. Go to step 1.

Edit the file in place. Never regenerate it from scratch while directives remain, or the
unresolved ones are lost. **HTML:** Edit, and Tidy before every commit.
