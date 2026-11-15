// The tab's notices: green crop marks on content that changed since you last saw it, the check
// tile that acks one, and the docket's row of changes. A file of its own, so it runs beside the
// other tab tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer, openTab, until } from './client-lib.mjs';

// The agent's edit, as it makes one: text replaced in the file, IDs kept.
const agentEdit = (s, from, to) => s.write('page.html', s.read('page.html').replace(from, to));

const stateOf = async (s) => (await fetch(`${s.base}/page.html`, { headers: { Accept: 'application/json' } })).json();

function marks(tab) {
  const ids = (selector) => [...tab.layer.querySelectorAll(selector)].map((m) => m.getAttribute('data-for'));
  return {
    tiles: ids('.hrv-seen'),
    crops: tab.layer.querySelectorAll('.hrv-crop.hrv-notice').length,
  };
}
const changes = (tab) => tab.layer.querySelector('.hrv-docket-main.hrv-row3 > span:last-of-type').textContent;
const changing = (tab) => tab.docket().classList.contains('hrv-changing');

test('notices: a reload shows a mark on what changed since the last load, and the docket counts it', () =>
  withServer(async (s) => {
    const first = await openTab(s, 'page.html');
    assert.deepEqual(marks(first), { tiles: [], crops: 0 }, 'the first load is what you saw');
    assert.ok(!changing(first), 'no changes: no row');
    first.close();
    agentEdit(s, 'First paragraph', 'First paragraph, edited');
    const tab = await openTab(s, 'page.html');
    const p = tab.idOf('p');
    assert.deepEqual(marks(tab), { tiles: [p], crops: 1 });
    assert.equal(tab.layer.querySelector('.hrv-seen').title, 'Seen: take this mark off');
    assert.ok(changing(tab));
    assert.equal(changes(tab), '1 change');
    tab.close();
  }));

test('notices: the check tile sits in the marker\'s spot, and beside the marker when there is one', () =>
  withServer(async (s) => {
    (await openTab(s, 'page.html')).close();
    agentEdit(s, 'First paragraph', 'First paragraph, edited');
    const tab = await openTab(s, 'page.html');
    // No layout in the tab: every element sits at (100, 50), the layer at the origin.
    tab.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this === tab.layer
        ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
        : { left: 100, top: 50, right: 300, bottom: 70, width: 200, height: 20 };
    };
    const tile = tab.layer.querySelector(`.hrv-seen[data-for="${tab.idOf('p')}"]`);
    tab.open('p');
    tab.type('shorter');
    assert.equal(tab.marker('p').style.left, '80px', 'the marker takes the spot left of the first line');
    assert.equal(tile.style.left, '58px', 'the check tile steps outward beside it');
    assert.equal(tile.style.top, '50px');
    tab.type('');
    assert.equal(tile.style.left, '80px', 'alone, it takes the marker\'s spot');
    tab.close();
  }));

test('notices: an edit on disk marks the open tab without a reload; the check tile acks it, and the other tab hears', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const other = await openTab(s, 'page.html');
    const p = tab.idOf('p');
    agentEdit(s, 'First paragraph', 'First paragraph, edited');
    await until(() => marks(tab).tiles.length === 1 && marks(other).tiles.length === 1);
    await until(() => tab.el('p').textContent === 'First paragraph, edited');
    assert.equal(tab.message(), '', 'the change shows: no reload');
    tab.click(tab.layer.querySelector(`.hrv-seen[data-for="${p}"]`));
    assert.deepEqual(marks(tab), { tiles: [], crops: 0 }, 'the mark goes at once');
    assert.equal(tab.box(), null, 'the tile opens no box');
    await until(async () => (await stateOf(s)).notices.length === 0);
    await until(() => marks(other).tiles.length === 0);
    assert.ok(!changing(other));
    tab.close();
    other.close();
  }));

test('notices: the docket steps through the changes in page order, and its check acks them all', () =>
  withServer(async (s) => {
    (await openTab(s, 'page.html')).close();
    agentEdit(s, '>Title<', '>Heading<');
    agentEdit(s, '>two</li>', '>deux</li>');
    const tab = await openTab(s, 'page.html');
    assert.equal(changes(tab), '2 changes');
    const [up, down] = [...tab.layer.querySelectorAll('.hrv-step.hrv-row3')];
    assert.equal(down.title, 'Next change');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'h1');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'li');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'h1', 'wraps around');
    tab.click(up);
    assert.equal(tab.steppedTo(), 'li');
    const all = tab.layer.querySelector('.hrv-seen-all');
    assert.equal(all.title, 'Seen all: take every mark off');
    tab.click(all);
    assert.deepEqual(marks(tab), { tiles: [], crops: 0 });
    assert.ok(!changing(tab), 'the row hides');
    assert.ok(!tab.docket().classList.contains('hrv-off'), 'the check is no review switch');
    await until(async () => (await stateOf(s)).notices.length === 0);
    tab.close();
  }));

test('notices: a directive takes the mark off its element, without a reload; your markdown save takes it off too', () =>
  withServer(async (s) => {
    (await openTab(s, 'page.html')).close();
    agentEdit(s, 'First paragraph', 'First paragraph, edited');
    s.write('page.html', s.read('page.html').replace('>Title<', '>Heading<').replace('>one<', '>uno<'));
    const tab = await openTab(s, 'page.html');
    const [h1, p, li] = ['h1', 'p', 'li'].map((sel) => tab.idOf(sel));
    assert.deepEqual(marks(tab).tiles, [h1, p, li]);
    tab.open('p');
    tab.type('shorter');
    await until(() => s.read('page.html').includes('@AI: shorter') && marks(tab).tiles.length === 2);
    assert.deepEqual(marks(tab).tiles, [h1, li], 'the directive is an ack of its element');
    tab.done();
    tab.open('li');
    tab.type('one again', tab.content());
    await until(() => marks(tab).tiles.length === 1);
    tab.done();
    assert.deepEqual((await stateOf(s)).notices.map((n) => n.id), [h1]);
    tab.close();
  }));
