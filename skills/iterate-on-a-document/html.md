# HTML steps

The loop in `SKILL.md` names six moments where HTML needs more. Paths here resolve from this
skill's base directory. The tool is html-revisor; it needs Node 20 or later and nothing else.

## Start

Run in the background: `node ../../html-revisor/server.mjs <file> --port 0`. It formats the file
(the same as Tidy, below) and prints `html-revisor: <page URL> serving <dir>`. The commit that
follows holds the formatting, so later diffs show only the user's changes. If formatting fails,
the server exits 1 with `<file>: <problem>` on stderr; fix that and start it again.

## Hand off

Give the user the page URL instead of the file path. Tell them to reload the page, then click a
block, a link, an image, or part of an SVG to leave a directive on it or change its wording.
Their directives and edits save into the file. They can also edit the file by hand.

## Tidy

Run `node ../../html-revisor/formatter.mjs <file>` before every commit. It rewrites the file into
the formatting the server applies on each page load, so formatting lands in the commit that
caused it and never reads as the user's next edit. It also writes element IDs: `data-hrv="<n>"`
on each element the user can pick, and `data-hrv-next` on `<html>`. The first run on a page is
one noisy diff. It prints nothing when all is well. If it exits nonzero, fix what it prints on
stderr and run it again.

## Edit

Leave `data-hrv` and `data-hrv-next` attributes alone: don't change, copy, or remove them. A new
element needs none; the formatter gives it one. An open browser tab saves by these IDs.

## Find directives

Run `grep -n '<!-- *@AI:' <file>`. A page that talks about directives holds the bare `@AI:` in
its text, so grep for the HTML comment form. Each directive is about the element that contains
it as its first child — or, just before a void or raw-text element, about that next element. The
full list of those elements is under "Directive format" in `../../html-revisor/README.md`.

## End

Stop the server.
