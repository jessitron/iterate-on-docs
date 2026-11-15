// Flipping through changes by key: once you step through the docket's changes row, ↓ and n go
// to the next change, ↑ and p to the previous, space takes the mark off, and Enter takes it off
// and goes on. c starts at the first change, d steps through the directives. A file of its own,
// so it runs beside the other tab tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer, openTab, until } from './client-lib.mjs';

// The agent's edit, as it makes one: text replaced in the file, IDs kept.
const agentEdit = (s, from, to) => s.write('page.html', s.read('page.html').replace(from, to));

const stateOf = async (s) => (await fetch(`${s.base}/page.html`, { headers: { Accept: 'application/json' } })).json();

const tiles = (tab) => [...tab.layer.querySelectorAll('.hrv-seen')].map((m) => m.getAttribute('data-for'));

// A key on the page, from target (the body when not given). Gives true when the tab took it.
function press(tab, key, init = {}, target = tab.document.body) {
  const e = new tab.window.Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(e, { key }, init);
  target.dispatchEvent(e);
  return e.defaultPrevented;
}

// Three changes: the h1, the ul's own content (its class), and a li inside the ul.
async function threeChanges(s) {
  (await openTab(s, 'page.html')).close();
  agentEdit(s, '>Title<', '>Heading<');
  agentEdit(s, /<ul( [^>]*)?>/, '<ul$1 class="list">');
  agentEdit(s, '>two</li>', '>deux</li>');
  const tab = await openTab(s, 'page.html');
  assert.equal(tiles(tab).length, 3);
  return tab;
}

const rowButtons = (tab) => [...tab.layer.querySelectorAll('.hrv-step.hrv-row3')];

test('flip: the changes row steps inner changes first, then the one around them', () =>
  withServer(async (s) => {
    const tab = await threeChanges(s);
    const [up, down] = rowButtons(tab);
    tab.click(down);
    assert.equal(tab.steppedTo(), 'h1');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'li', 'the li inside the ul comes first');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'ul');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'h1', 'wraps around');
    tab.click(up);
    assert.equal(tab.steppedTo(), 'ul');
    tab.click(up);
    assert.equal(tab.steppedTo(), 'li');
    tab.close();
  }));

test('flip: after the changes row, ↓ and n go to the next change, ↑ and p to the previous', () =>
  withServer(async (s) => {
    const tab = await threeChanges(s);
    const steps = tab.steps();
    assert.ok(!press(tab, 'ArrowDown'), 'not flipping: ↓ is the page\'s');
    assert.ok(!press(tab, 'n'));
    assert.equal(tab.steps(), steps);
    tab.click(rowButtons(tab)[1]);
    assert.equal(tab.steppedTo(), 'h1');
    assert.ok(press(tab, 'ArrowDown'), 'flipping: ↓ is ours');
    assert.equal(tab.steppedTo(), 'li');
    assert.ok(press(tab, 'n'));
    assert.equal(tab.steppedTo(), 'ul');
    assert.ok(press(tab, 'ArrowUp'));
    assert.equal(tab.steppedTo(), 'li');
    assert.ok(press(tab, 'p'));
    assert.equal(tab.steppedTo(), 'h1');
    tab.close();
  }));

test('flip: c starts at the first change; space takes its mark off and stays', () =>
  withServer(async (s) => {
    const tab = await threeChanges(s);
    const h1 = tab.idOf('h1');
    assert.ok(press(tab, 'c'));
    assert.equal(tab.steppedTo(), 'h1');
    press(tab, 'ArrowDown');
    assert.equal(tab.steppedTo(), 'li');
    assert.ok(press(tab, 'c'), 'c again goes back to the first');
    assert.equal(tab.steppedTo(), 'h1');
    const steps = tab.steps();
    assert.ok(press(tab, ' '));
    assert.ok(!tiles(tab).includes(h1), 'its mark comes off');
    assert.equal(tab.steps(), steps, 'and it stays');
    await until(async () => !(await stateOf(s)).notices.some((n) => n.id === h1));
    press(tab, 'ArrowDown');
    assert.equal(tab.steppedTo(), 'li', 'the next goes on from where it stayed');
    tab.close();
  }));

test('flip: Enter takes the mark off and goes to the next change, until none are left', () =>
  withServer(async (s) => {
    const tab = await threeChanges(s);
    press(tab, 'c');
    assert.ok(press(tab, 'Enter'));
    assert.equal(tab.steppedTo(), 'li');
    assert.equal(tiles(tab).length, 2);
    press(tab, 'Enter');
    assert.equal(tab.steppedTo(), 'ul');
    assert.deepEqual(tiles(tab), [tab.idOf('ul')]);
    const steps = tab.steps();
    press(tab, 'Enter');
    assert.deepEqual(tiles(tab), []);
    assert.equal(tab.steps(), steps, 'none left: it stays');
    await until(async () => (await stateOf(s)).notices.length === 0);
    assert.ok(!press(tab, 'ArrowDown'), 'no changes left: ↓ is the page\'s again');
    tab.close();
  }));

test('flip: Enter on a change around ones you passed takes their marks too, and goes on', () =>
  withServer(async (s) => {
    const tab = await threeChanges(s);
    press(tab, 'c');
    press(tab, 'ArrowDown');
    press(tab, 'ArrowDown');
    assert.equal(tab.steppedTo(), 'ul');
    press(tab, 'Enter');
    assert.deepEqual(tiles(tab), [tab.idOf('h1')], 'the li\'s mark goes with the ul\'s at once');
    assert.equal(tab.steppedTo(), 'h1', 'wraps around to the one left');
    await until(async () => (await stateOf(s)).notices.length === 1);
    tab.close();
  }));

test('flip: Escape or a click elsewhere ends it', () =>
  withServer(async (s) => {
    const tab = await threeChanges(s);
    press(tab, 'c');
    assert.ok(!press(tab, 'Escape'), 'Escape ends it and leaves the page its default');
    assert.ok(!press(tab, 'ArrowDown'));
    assert.ok(!press(tab, 'Enter'));
    assert.equal(tiles(tab).length, 3);
    press(tab, 'c');
    tab.click(tab.layer.querySelector('.hrv-docket-msg'));
    assert.ok(!press(tab, 'ArrowDown'), 'a click elsewhere ends it');
    tab.close();
  }));

test('flip: keys go to the page with a modifier held, with review off, or while typing', () =>
  withServer(async (s) => {
    const tab = await threeChanges(s);
    press(tab, 'c');
    const steps = tab.steps();
    for (const mod of ['metaKey', 'ctrlKey', 'shiftKey']) {
      assert.ok(!press(tab, 'ArrowDown', { [mod]: true }), mod);
      assert.ok(!press(tab, ' ', { [mod]: true }), mod);
    }
    assert.equal(tab.steps(), steps);
    const typing = tab.document.createElement('input');
    tab.document.body.appendChild(typing);
    assert.ok(!press(tab, 'ArrowDown', {}, typing), 'an input keeps its keys');
    assert.ok(!press(tab, 'c', {}, typing));
    assert.equal(tiles(tab).length, 3);
    tab.click(tab.layer.querySelector('.hrv-docket-main'));
    assert.ok(tab.docket().classList.contains('hrv-off'));
    assert.ok(!press(tab, 'c'), 'review off: c is the page\'s');
    assert.ok(!press(tab, 'ArrowDown'));
    assert.equal(tab.steps(), steps);
    tab.close();
  }));

test('flip: d steps through the directives; with a box open, c and d are the box\'s', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('li');
    tab.type('look here');
    tab.done();
    tab.open('h1');
    tab.type('and here');
    assert.ok(!press(tab, 'd'), 'a box is open');
    assert.ok(!press(tab, 'c'));
    tab.done();
    assert.ok(press(tab, 'd'));
    assert.equal(tab.steppedTo(), 'li', 'from the h1 the box was on, the next directive');
    press(tab, 'd');
    assert.equal(tab.steppedTo(), 'h1');
    assert.ok(!press(tab, 'ArrowDown'), 'd is no flipping through changes');
    assert.ok(!press(tab, 'c'), 'no changes: c is the page\'s');
    tab.close();
  }));
