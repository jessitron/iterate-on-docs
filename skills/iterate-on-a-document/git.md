# Git setups

The loop in `SKILL.md` commits at each turn, so `git diff HEAD~1` can separate the user's edits
from the agent's. Where those commits go is up to the user's process. Pick one setup at the
start, tell the user which one and why in a sentence, and switch if they ask.

Whatever the setup, commit the document's path alone (`git commit <file>`), so work in progress
elsewhere in the tree stays out of the loop's commits.

## Choose

Take the first that fits:

1. The project's agent instructions (`CLAUDE.md`, `AGENTS.md`, or similar) or `CONTRIBUTING`
   say how to commit: follow them, using the closest setup below.
2. The file is not in a git repository: **Shadow**.
3. The current branch is not the default branch: **In place**. The user already has a way to
   land that branch.
4. `git log --merges -10` on the default branch shows merge commits: **Branch and merge**.
5. History on the default branch is linear: **Squash**.
6. Unsure: **Shadow**. It touches the user's repository least.

## In place

Commit on the current branch. At the end, leave the commits as they are.

## Squash

Before the first commit, record the starting commit: `git rev-parse HEAD`. Commit on the current
branch. At the end, if every commit since the start is the loop's and none is pushed, run
`git reset --soft <start>` and make one commit whose message summarizes what changed in the
document. Otherwise leave the commits and tell the user why.

## Branch and merge

Record the current branch. Create a branch for the loop: `git switch -c iterate/<file-stem>`.
Commit there. At the end, switch back and merge with a kept merge commit:
`git merge --no-ff iterate/<file-stem>`, with a message that summarizes what changed in the
document. Then delete the loop branch. `git log --first-parent` shows the loop as one commit,
and the turns stay one level down.

## Shadow

Keep the turn commits in a repository outside the project, so the file stays where it is (links,
the user's editor, and the HTML server keep working) and the project's history never sees them.

```sh
SHADOW="${TMPDIR:-/tmp}/iterate-<file-stem>.git"
git --git-dir="$SHADOW" --work-tree=<file's directory> init
```

Every git command in the loop takes both flags, for example
`git --git-dir="$SHADOW" --work-tree=<dir> diff HEAD~1`. Shell variables may not survive between
commands, so write the path out in full each time. Add the document alone; never `add -A`.

At the end, if the file is in a project repository, it shows there as one modified file. Offer
to commit it with a message that summarizes what changed. The system's temp cleanup removes the shadow repository later.
