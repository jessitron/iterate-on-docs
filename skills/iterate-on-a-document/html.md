# HTML steps

The loop in `SKILL.md` names six moments where HTML needs more. Paths here resolve from this
skill's base directory. The tool is html-revisor; it needs Node 20 or later and nothing else.

While you're writing an HTML document, here are some tips:

- put a <section> tag around each section, with a heading and paragraphs etc inside. Then html-revisor lets people edit at the section level as well.
- Draw diagrams in SVG. People can edit the labels, and they can add directives to each shape or the diagram as a whole.

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

Stop the server. Then run `node ../../html-revisor/cleanup.mjs <file>`. It takes out what the
tool left in the page: directives and the element IDs (`data-hrv`, `data-hrv-next`), formatting
kept. It prints each directive it removed as `<file>: <text>`; tell the user about those, since
saying "good enough" left them unaddressed. Commit the result. The next iteration on the page
hands out IDs afresh, so two iterations on one page don't collide.

## Report bugs

If the server crashes or the user complains about it, offer to file an issue at
https://github.com/jessitron/html-revisor/issues. Include the commit named in
`../../html-revisor/VENDORED.md`. Issues are public: leave the user's document out.
