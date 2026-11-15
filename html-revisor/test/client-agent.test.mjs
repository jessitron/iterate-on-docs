// The tab shows the agent's changes without a reload: each verb swaps in what changed, keeps
// the elements it didn't touch, wears a notice, and waits for an open box on what it touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withServer, openTab, until } from './client-lib.mjs';

// The agent's change, as change.mjs sends it. read gives the scope's version.
const read = async (s, id) => (await fetch(`${s.base}/page.html?scope=${id}`, { headers: { Accept: 'application/json' } })).json();
async function agent(s, body) {
  const res = await fetch(`${s.base}/page.html`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const answer = await res.json();
  assert.ok(answer.ok, JSON.stringify(answer));
  return answer;
}
const replace = async (s, id, html) => agent(s, { change: 'replace', id, version: (await read(s, id)).version, html });

const tiles = (tab) => [...tab.layer.querySelectorAll('.hrv-seen')].map((t) => t.getAttribute('data-for'));
const texts = (tab, selector) => [...tab.document.querySelectorAll(selector)].map((e) => e.textContent.trim());

test('an agent replace shows in the tab with no reload, wears a notice, and leaves the rest of the page as it was', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const p = tab.idOf('p');
    const [h1, ul] = [tab.el('h1'), tab.el('ul')];
    await replace(s, p, '<p>First paragraph, <em>by the agent</em></p>');
    await until(() => tab.el(`[data-hrv="${p}"] em`));
    assert.equal(tab.el(`[data-hrv="${p}"]`).textContent, 'First paragraph, by the agent');
    assert.ok(tab.el('h1') === h1 && tab.el('ul') === ul, 'untouched elements stay the same nodes');
    await until(() => tiles(tab).includes(p));
    assert.equal(tab.message(), '');
    tab.open(`[data-hrv="${p}"]`);
    assert.equal(tab.content().value, 'First paragraph, *by the agent*', 'its markdown came with it');
    tab.type('First paragraph, mine', tab.content());
    await until(() => s.read('page.html').includes('First paragraph, mine'));
    assert.equal(tab.message(), '', 'a save on it lands');
    tab.close();
  }));

test('the agent\'s because shows in the tip beside the check tile, on hover and on stepping to the change', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    // No layout in the tab: give every element a place, so the marks show.
    tab.window.HTMLElement.prototype.getBoundingClientRect = function () {
      return this === tab.layer
        ? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
        : { left: 100, top: 50, right: 300, bottom: 70, width: 200, height: 20 };
    };
    const [h1, p] = [tab.idOf('h1'), tab.idOf('p')];
    const tile = (id) => tab.layer.querySelector(`.hrv-seen[data-for="${id}"]`);
    const tip = tab.layer.querySelector('.hrv-tip');
    const hover = (node, type) => node.dispatchEvent(new tab.window.Event(type));
    await agent(s, { change: 'replace', id: p, version: (await read(s, p)).version, html: '<p>Shorter</p>', because: 'shorter, as you asked' });
    await replace(s, h1, '<h1>Agent title</h1>');
    await until(() => tile(p) && tile(h1) && tile(p).getAttribute('aria-label') !== 'Seen: take this mark off');
    assert.equal(tile(p).title, '', 'our tip says it; the browser\'s tooltip stays out of the way');
    assert.equal(tile(p).getAttribute('aria-label'), 'shorter, as you asked Seen: take this mark off');
    assert.equal(tile(h1).title, 'Seen: take this mark off', 'a change with no because keeps the plain tooltip');
    hover(tile(p), 'mouseenter');
    assert.equal(tip.style.display, 'block');
    assert.equal(tip.textContent, 'shorter, as you asked', 'the agent\'s words alone');
    assert.ok(tip.classList.contains('hrv-tip-reply'), 'the agent\'s words wear its green rule');
    hover(tile(p), 'mouseleave');
    assert.equal(tip.style.display, 'none');
    hover(tile(h1), 'mouseenter');
    assert.equal(tip.style.display, 'none', 'nothing said: no tip');
    const down = [...tab.layer.querySelectorAll('.hrv-step.hrv-row3')][1];
    tab.click(down);
    assert.equal(tab.steppedTo(), 'h1');
    assert.equal(tip.style.display, 'none');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'p');
    assert.equal(tip.firstChild.textContent, 'shorter, as you asked', 'stepping to the change shows it');
    tab.click(tile(p));
    await until(() => !tile(p));
    assert.equal(tip.style.display, 'none', 'acked: the tip goes with the mark');
    tab.close();
  }));

test('add, remove, and move show; a moved element is the same node', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const [h1, ul] = [tab.idOf('h1'), tab.idOf('ul')];
    const [one, two] = [...tab.document.querySelectorAll('li')];
    const added = await agent(s, { change: 'add', where: 'into', id: ul, html: '<li>three</li>' });
    await until(() => texts(tab, 'li').length === 3);
    assert.deepEqual(texts(tab, 'li'), ['one', 'two', 'three']);
    assert.ok(tab.document.querySelectorAll('li')[0] === one, 'the items it kept are its own');
    await until(() => tiles(tab).includes(added.ids[0]));
    await agent(s, { change: 'move', id: one.getAttribute('data-hrv'), where: 'after', to: added.ids[0] });
    await until(() => texts(tab, 'li')[2] === 'one');
    assert.ok(tab.document.querySelectorAll('li')[2] === one, 'moved, not made again');
    const id2 = two.getAttribute('data-hrv');
    await agent(s, { change: 'remove', id: id2, version: (await read(s, id2)).version });
    await until(() => texts(tab, 'li').length === 2);
    assert.ok(!two.isConnected);
    const section = await agent(s, { change: 'add', where: 'after', id: h1, html: '<section><h2>New</h2><p>Fresh</p></section>' });
    await until(() => tab.el('section'));
    assert.equal(tab.el('section').getAttribute('data-hrv'), section.id);
    await until(() => tiles(tab).includes(section.id));
    tab.close();
  }));

test('a directive the agent\'s HTML carried over shows its marker on the swapped-in element', () =>
  withServer(async (s) => {
    s.write('page.html', s.read('page.html').replace('<ul>', '<section><ul>').replace('</ul>', '</ul></section>'));
    const tab = await openTab(s, 'page.html');
    const li = tab.idOf('li');
    tab.open('li');
    tab.type('louder');
    tab.done();
    await until(() => s.read('page.html').includes('@AI: louder'));
    const section = tab.idOf('section');
    await replace(s, section, '<section><h2>Items</h2></section>');
    await until(() => tab.el('section h2'));
    assert.equal(tab.el('li'), null, 'the item went');
    await until(() => tab.layer.querySelector(`.hrv-marker[data-for="${section}"]`));
    assert.ok(!tab.layer.querySelector(`.hrv-marker[data-for="${li}"]`));
    assert.equal(tab.count(), '1 directive', 'your words moved up to the section');
    tab.close();
  }));

test('an open box holds the swap of its element until it closes; a change beside it shows at once', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const p = tab.idOf('p');
    const el = tab.el('p');
    tab.open('p');
    tab.type('a directive saves while it waits');
    await until(() => tab.hint() === 'saved');
    await replace(s, p, '<p>By the agent</p>');
    await until(() => tab.message() === 'this element changed; close the box to see it');
    assert.equal(tab.el('p').textContent, 'First paragraph', 'nothing changes under the box');
    await replace(s, tab.idOf('h1'), '<h1>Agent title</h1>');
    await until(() => tab.el('h1').textContent === 'Agent title');
    assert.ok(tab.el('p') === el && tab.box(), 'the box stays open on its element');
    tab.done();
    await until(() => tab.el('p').textContent === 'By the agent');
    assert.ok(tab.el('p') === el, 'the same element: only its content changed');
    assert.ok(s.read('page.html').includes('@AI: a directive saves while it waits -->'), 'the one before the change stays');
    tab.close();
  }));

// The trial's case: lost in conflict. The tab holds the swap and the old base; the directive
// lands anyway, and Done says the version she saw.
test('the held box saves its directive, and Done announces it with the version she saw', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const p = tab.idOf('p');
    const saw = (await read(s, p)).version;
    tab.open('p');
    const { version } = await replace(s, p, '<p>By the agent</p>');
    await until(() => tab.message() === 'this element changed; close the box to see it');
    tab.type('is this a rule');
    await until(() => tab.hint() === 'saved');
    tab.type('is this a rule or a policy?');
    await until(() => s.read('page.html').includes('<!-- @AI: is this a rule or a policy? -->'));
    assert.match(s.read('page.html'), /<!-- @AI: is this a rule or a policy\? -->\s*By the agent/, 'the agent\'s content stays');
    assert.equal(tab.message(), 'this element changed; close the box to see it', 'no refusal');
    tab.done();
    await until(() => s.announcements().length === 1);
    const announced = s.announcements()[0];
    assert.deepEqual([announced.directive, announced.saw, announced.version, announced.revision], [{ before: '', after: 'is this a rule or a policy?' }, saw, version, undefined]);
    await until(() => tab.el('p').textContent === 'By the agent');
    tab.close();
  }));

// The trial's case: echo.
test('a box opened before the agent\'s change and closed after it, with nothing of hers, announces nothing', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const p = tab.idOf('p');
    tab.open('p');
    await replace(s, p, '<p>By the agent</p>');
    await until(() => tab.message() === 'this element changed; close the box to see it');
    tab.done();
    await until(() => tab.el('p').textContent === 'By the agent');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(s.announcements().length, 0);
    tab.close();
  }));

// The PUTs the tab sent, by kind, from its spans.
const puts = async (tab, kind) => (await tab.spans()).filter((span) => span.name === `save ${kind}`);

test('a content save refused under the held box says so once, sends no more, keeps the field, and the directive still saves', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const p = tab.idOf('p');
    tab.open('p');
    await replace(s, p, '<p>By the agent</p>');
    await until(() => tab.message() === 'this element changed; close the box to see it');
    tab.type('First paragraph, mine', tab.content());
    await until(() => tab.hint() === 'not saved');
    const refusal = 'this changed while your box was open, so your content edit didn\'t save: copy it, then close the box to see the change';
    assert.equal(tab.message(), refusal);
    tab.type('First paragraph, mine, more', tab.content());
    tab.type('First paragraph, mine, more still', tab.content());
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(tab.content().value, 'First paragraph, mine, more still', 'what she typed stays to copy');
    tab.type('say why');
    await until(() => s.read('page.html').includes('<!-- @AI: say why -->'));
    assert.equal(tab.message(), refusal, 'the message stays while the box is open');
    assert.match(s.read('page.html'), /By the agent/);
    await until(async () => (await puts(tab, 'directive')).length === 1);
    assert.equal((await puts(tab, 'markdown')).length, 1, 'one refused PUT, and no more');
    tab.done();
    await until(() => tab.el('p').textContent === 'By the agent');
    assert.equal(tab.message(), '');
    tab.close();
  }, { telemetry: true }));

test('the element under the open box is gone: her directive lands on the element around it, and the marker moves there', () =>
  withServer(async (s) => {
    s.write('page.html', s.read('page.html').replace('<ul>', '<section><h2>Items</h2><ul>').replace('</ul>', '</ul></section>'));
    const tab = await openTab(s, 'page.html');
    const [li, ul, section] = [tab.idOf('li'), tab.idOf('ul'), tab.idOf('section')];
    tab.open('li');
    await agent(s, { change: 'remove', id: ul, version: (await read(s, ul)).version });
    await until(() => tab.message() === 'this element changed; close the box to see it');
    tab.type('louder');
    await until(() => tab.layer.querySelector(`.hrv-marker[data-for="${section}"]`));
    assert.equal(tab.message(), 'this element is gone; your directive is on the section around it');
    assert.match(s.read('page.html'), new RegExp(`<section data-hrv="${section}">\\s*<!-- @AI: louder -->`));
    tab.type('louder, please');
    await until(() => s.read('page.html').includes('<!-- @AI: louder, please -->'));
    assert.equal(s.read('page.html').match(/@AI/g).length, 1, 'each draft replaces the last');
    tab.done();
    await until(() => !tab.el('ul'));
    await until(() => !tab.layer.querySelector(`.hrv-marker[data-for="${li}"]`));
    assert.ok(tab.layer.querySelector(`.hrv-marker[data-for="${section}"]`), 'the marker is on the section');
    assert.equal(tab.count(), '1 directive');
    await until(() => s.announcements().length === 1);
    assert.deepEqual([s.announcements()[0].id, s.announcements()[0].from], [section, li]);
    tab.close();
  }));

test('a box on an element whose parent changed stays open: the element is kept', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const li = tab.el('li');
    tab.open('li');
    await agent(s, { change: 'add', where: 'into', id: tab.idOf('ul'), html: '<li>three</li>' });
    await until(() => texts(tab, 'li').length === 3);
    assert.ok(tab.el('li') === li && tab.box(), 'the box is still on its item');
    assert.equal(tab.message(), '');
    tab.close();
  }));

test('a swapped element keeps its marker and Revert', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const ul = tab.idOf('ul');
    tab.open('ul');
    tab.type('more items');
    tab.done();
    await until(() => s.read('page.html').includes('@AI: more items'));
    await agent(s, { change: 'add', where: 'into', id: ul, html: '<li>three</li>' });
    await until(() => texts(tab, 'li').length === 3);
    assert.ok(tab.marker('ul'), 'the list keeps its marker');
    assert.equal(tab.count(), '1 directive');
    tab.close();
  }));
