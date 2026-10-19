// Stdout, for an agent watching the output. Tier III.

// Announcements go to stdout, one line of JSON each. Every JSON line starts with {, and no
// other line does.
export function announce(announcement) {
  console.log(JSON.stringify(announcement));
}
