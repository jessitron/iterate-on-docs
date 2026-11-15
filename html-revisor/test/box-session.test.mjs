// One box session is one change and one turn: its saves are drafts, and its Done announces what
// the session did, nothing of the agent's. Your directive lands whatever the agent did meanwhile.
// The two cases from the trial come first, by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer, idOf, announcements } from './acceptance-lib.mjs';

// The agent's change, as change.mjs sends it.
async function agent(s, body) {
  const answer = await (await s.put('page.html', body)).json();
  assert.ok(answer.ok, JSON.stringify(answer));
  return answer;
}
const version = async (s, id) => (await (await fetch(`${s.base}page.html?scope=${id}`, { headers: { Accept: 'application/json' } })).json()).version;
const replace = async (s, id, html) => agent(s, { change: 'replace', id, version: await version(s, id), html });

// Done, and the Announcement it printed, or null when it printed none.
async function done(s, body) {
  const before = announcements(s.stdout).length;
  const { announced } = await (await s.done('page.html', body)).json();
  return announced ? announcements(s.stdout)[before] : null;
}

test('trial case: lost in conflict. The agent replaces the paragraph under the open box; her directive lands, and Done says what she saw', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const p = idOf(document, 'p');
    const session = 'lost-in-conflict';
    const { version: now } = await replace(s, p, '<p>First paragraph, by the agent</p>');
    for (const typed of ['is this', 'is this a rule', 'is this a rule or a policy?']) {
      const res = await s.put('page.html', { id: p, base: bases[p], directive: typed, session });
      assert.equal(res.status, 200, `each draft lands: ${typed}`);
    }
    assert.match(s.read('page.html'), /<!-- @AI: is this a rule or a policy\? -->\s*First paragraph, by the agent/);
    assert.doesNotMatch(s.stdout, /conflict/);
    const announced = await done(s, { id: p, session, directive: '', saw: bases[p] });
    assert.deepEqual(announced, {
      page: '/page.html', id: p, element: 'p', heading: 'Title',
      directive: { before: '', after: 'is this a rule or a policy?' }, thread: announced.thread, saw: bases[p], version: now,
    });
    assert.notEqual(announced.saw, announced.version, 'her words are about older content');
    assert.equal(announced.revision, undefined);
  }));

test('trial case: echo. A box opened before an agent edit and closed after, with no edit of hers, announces nothing', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const p = idOf(document, 'p');
    await replace(s, p, '<p>First paragraph, by the agent</p>');
    assert.equal(await done(s, { id: p, session: 'echo', directive: '', saw: bases[p] }), null);
    assert.equal(announcements(s.stdout).length, 0);
  }));

test('the revision is hers alone, whether the agent changed the scope before, between, or after her saves', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const [p, q] = [...document.querySelectorAll('p')].map((e) => e.getAttribute('data-hrv'));

    // Before: the tab took the agent's change in, then she edited on top of it.
    const { version: agents } = await replace(s, p, '<p>Agent first</p>');
    const before = await (await s.put('page.html', { id: p, base: agents, markdown: 'Agent first, mine', session: 'before' })).json();
    assert.deepEqual((await done(s, { id: p, session: 'before', directive: '', saw: before.bases[p] })).revision, { before: 'Agent first', after: 'Agent first, mine' });

    // Between and after: her first save lands, the agent changes the scope, her next is refused,
    // and the agent changes it again.
    const first = await (await s.put('page.html', { id: q, base: bases[q], markdown: 'Second, mine', session: 'between' })).json();
    await replace(s, q, '<p>Second, the agent\'s</p>');
    assert.equal((await s.put('page.html', { id: q, base: first.bases[q], markdown: 'Second, mine again', session: 'between' })).status, 412);
    const { version: last } = await replace(s, q, '<p>Second, the agent\'s again</p>');
    const announced = await done(s, { id: q, session: 'between', directive: '', saw: first.bases[q] });
    assert.deepEqual(announced.revision, { before: 'Second **bold** paragraph', after: 'Second, mine' });
    assert.deepEqual([announced.saw, announced.version], [first.bases[q], last]);
  }));

test('typed, then undone in one session: no revision', () =>
  withServer(async (s) => {
    const { document, bases } = await s.page('page.html');
    const p = idOf(document, 'p');
    const typed = await (await s.put('page.html', { id: p, base: bases[p], markdown: 'First paragraph, edited', session: 'undo' })).json();
    const undone = await (await s.put('page.html', { id: p, base: typed.bases[p], markdown: 'First paragraph', session: 'undo' })).json();
    assert.equal(await done(s, { id: p, session: 'undo', directive: '', saw: undone.bases[p] }), null);
  }));

test('the agent removes the element under the open box: her directive lands on the nearest ancestor, and Done names it and where it came from', () =>
  withServer(async (s) => {
    s.write('page.html', s.read('page.html').replace('<ul>', '<section><h2>Items</h2><!-- @AI: tighten --><ul>').replace('</ul>', '</ul></section>'));
    const { document, bases } = await s.page('page.html');
    const [li, ul, section, body] = ['li', 'ul', 'section', 'body'].map((sel) => idOf(document, sel));
    const ancestors = [ul, section, body];
    const session = 'gone';
    await s.put('page.html', { id: li, base: bases[li], directive: 'louder', session, ancestors });
    const { version: v } = await (await fetch(`${s.base}page.html?scope=${ul}`, { headers: { Accept: 'application/json' } })).json();
    await agent(s, { change: 'remove', id: ul, version: v });
    assert.match(s.read('page.html'), /<!-- @AI: tighten\s*-->\s*<!-- @AI: louder -->|<!-- @AI: tighten\nlouder -->/, 'step 2: her words moved up with the list');
    const res = await (await s.put('page.html', { id: li, base: bases[li], directive: 'louder, please', session, ancestors })).json();
    assert.deepEqual([res.id, res.from, res.directive], [section, li, 'tighten\nlouder, please'], 'the draft replaced the one that moved');
    const announced = await done(s, { id: li, session, directive: '', saw: bases[li], ancestors });
    assert.deepEqual(announced, {
      page: '/page.html', id: section, from: li, element: 'section', heading: 'Title',
      directive: { before: '', after: 'louder, please' }, thread: announced.thread, saw: bases[li], version: announced.version,
    });
    assert.notEqual(announced.saw, announced.version);
  }));
