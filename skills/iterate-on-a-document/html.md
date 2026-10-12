# HTML steps

The loop in `SKILL.md` names five moments where HTML needs more. Paths here resolve from this
skill's base directory. The tool is html-revisor; it needs Node 20 or later and nothing else.

## Start

1. Run in the background: `node ../../html-revisor/server.mjs <directory holding the file> --port 0`.
2. It prints `html-revisor: http://localhost:<port>/ serving <dir>`. The page URL is that address
   plus the file's path under `<dir>`.
3. Tidy the file (below) and commit the rewrite as its own commit, so later diffs show only the
   user's changes.

## Hand off

Give the user the page URL instead of the file path. Tell them to reload the page, then click any
element to leave a directive on it or change its wording. Their directives and edits save into
the file. They can also edit the file by hand.

## Tidy

Run `node ../../html-revisor/formatter.mjs <file>` before every commit. It rewrites the file into
the formatting the server applies on each page load, so formatting lands in the commit that
caused it and never reads as the user's next edit. It prints nothing when all is well. If it
exits nonzero, fix what it prints on stderr and run it again.

## Find directives

Run `grep -n '<!-- *@AI:' <file>`. A page that talks about directives holds the bare `@AI:` in
its text, so grep for the HTML comment form. Each directive is about the element that contains
it as its first child — or, just before a void or raw-text element, about that next element. The
full list of those elements is under "Directive format" in `../../html-revisor/README.md`.

## End

Stop the server.
