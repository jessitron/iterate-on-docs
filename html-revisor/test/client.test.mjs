// The client in the tab (client-lib.mjs): threads, the docket, and focus. The sync engine's
// tests are in client-sync.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withServer, openTab, until, reply } from './client-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the tab: typing in the box saves the directive into the file', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    assert.ok(tab.box(), 'a box opens');
    tab.type('say more');
    await until(() => s.read('page.html').includes('<!-- @AI: say more -->'));
    tab.done();
    assert.equal(tab.box(), null);
    assert.ok(tab.marker('p'), 'the paragraph has a marker');
    tab.close();
  }));

test('the tab: a reply to a closed box turns its marker to the bubble, without a reload', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    tab.type('add a diagram');
    tab.done();
    await until(() => s.read('page.html').includes('<!-- @AI: add a diagram -->'));
    await reply(s, 'page.html', tab.idOf('p'), 'Added one.');
    await until(() => tab.marker('p').classList.contains('hrv-answered'));
    tab.close();
  }));

// The turns of the file's thread on the paragraph, in order.
const turnsInFile = (text) => [...text.matchAll(/<!-- (@AI|@Human): (.*?) -->/g)].map((m) => [m[1], m[2]]);

test('a reply to the open box joins its thread; what you add after it is one new turn', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    assert.equal(tab.label(), 'Directive');
    tab.type('add a diagram');
    await until(() => s.read('page.html').includes('<!-- @AI: add a diagram -->'));
    await reply(s, 'page.html', tab.idOf('p'), 'Added one.');
    await until(() => tab.turns().length === 2);
    assert.deepEqual(tab.turns(), [['you', 'add a diagram'], ['agent', 'Added one.']]);
    assert.equal(tab.field().value, '', 'what you sent went up into the thread');
    assert.equal(tab.label(), 'You');
    assert.ok(tab.button('Resolve'), 'Resolve shows once there is a thread');
    assert.equal(tab.message(), '', 'no notice to close the box');
    tab.type('and a caption');
    await until(() => s.read('page.html').includes('and a caption'));
    tab.done();
    await until(() => s.announcements().length === 1);
    assert.deepEqual(turnsInFile(s.read('page.html')), [['@AI', 'add a diagram'], ['@Human', 'Added one.'], ['@AI', 'and a caption']]);
    assert.deepEqual(s.announcements()[0].directive, { before: '', after: 'and a caption' }, 'Done tells what you added since the reply');
    tab.close();
  }));

test('Done after a reply came into the open box, with nothing added, announces nothing new', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    tab.type('add a diagram');
    tab.done();
    await until(() => s.announcements().length === 1);
    tab.open('p');
    await reply(s, 'page.html', tab.idOf('p'), 'Added one.');
    await until(() => tab.turns().at(-1)[1] === 'Added one.');
    tab.done();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.announcements().length, 1);
    tab.close();
  }));

test('a turn typed before the tab heard of a reply is refused, and what was past the sent turn goes after the reply, once', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    tab.type('add a diagram');
    await until(() => s.read('page.html').includes('<!-- @AI: add a diagram -->'));
    tab.deafen();
    await reply(s, 'page.html', tab.idOf('p'), 'Added one.');
    tab.type('add a diagram with arrows');
    await until(() => tab.turns().length === 2);
    assert.equal(tab.field().value, 'with arrows');
    await until(() => s.read('page.html').includes('with arrows'));
    assert.deepEqual(turnsInFile(s.read('page.html')), [['@AI', 'add a diagram'], ['@Human', 'Added one.'], ['@AI', 'with arrows']]);
    assert.equal(tab.message(), '');
    tab.close();
  }));

test('a closed box whose last turn was refused for a reply sends what is left, then Done announces it', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    tab.type('add a diagram');
    await until(() => s.read('page.html').includes('<!-- @AI: add a diagram -->'));
    tab.deafen();
    await reply(s, 'page.html', tab.idOf('p'), 'Added one.');
    tab.type('add a diagram with arrows');
    tab.done();
    await until(() => s.announcements().length === 1);
    assert.deepEqual(turnsInFile(s.read('page.html')), [['@AI', 'add a diagram'], ['@Human', 'Added one.'], ['@AI', 'with arrows']]);
    assert.deepEqual(s.announcements()[0].directive, { before: '', after: 'with arrows' });
    assert.equal(tab.message(), '');
    tab.close();
  }));

test('working: your turn is last and its box closed; the box shows the agent working, and the field adds a turn', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    tab.type('add a diagram');
    assert.ok(!tab.marker('p').classList.contains('hrv-working'), 'the pencil while you write');
    tab.done();
    const working = () => tab.marker('p').classList.contains('hrv-working');
    assert.ok(working(), 'closed, the agent has it');
    assert.equal(tab.marker('p').getAttribute('aria-label'), 'Agent working on: add a diagram');
    await until(() => s.announcements().length === 1);

    tab.open('p');
    assert.deepEqual(tab.turns(), [['you', 'add a diagram'], ['agent', 'working']]);
    assert.ok(tab.layer.querySelector('.hrv-box .hrv-turn.hrv-agent .hrv-dots'), 'the agent\'s turn shows the squares');
    assert.ok(tab.layer.querySelector('.hrv-box .hrv-head .hrv-icon').classList.contains('hrv-icon-working'));
    assert.equal(tab.field().value, '', 'what you sent stays as you wrote it; the field is your next turn');
    assert.equal(tab.label(), 'You');
    assert.ok(tab.button('Resolve'));
    assert.ok(!working(), 'open, it is the pencil again');
    tab.type('and a caption');
    await until(() => s.read('page.html').includes('and a caption'));
    assert.match(s.read('page.html'), /<!-- @AI: add a diagram\nand a caption -->/);
    tab.done();
    await until(() => s.announcements().length === 2);
    assert.deepEqual(s.announcements()[1].directive, { before: 'add a diagram', after: 'add a diagram\nand a caption' });
    assert.ok(working());

    await reply(s, 'page.html', tab.idOf('p'), 'Added both.');
    await until(() => tab.marker('p').classList.contains('hrv-answered'));
    assert.ok(!working(), 'the reply ends it');
    tab.open('p');
    assert.deepEqual(tab.turns(), [['you', 'add a diagram\nand a caption'], ['agent', 'Added both.']]);
    assert.ok(!tab.layer.querySelector('.hrv-box .hrv-head .hrv-icon').classList.contains('hrv-icon-working'));
    tab.close();
  }));

test('the docket counts new replies in a second row, steps through them, and rings green when one comes', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const row2 = () => tab.layer.querySelector('.hrv-docket-main.hrv-row2').textContent;
    const stacked = () => tab.docket().classList.contains('hrv-stacked');
    for (const selector of ['h1', 'p', 'li']) {
      tab.open(selector);
      tab.type('look here');
      tab.done();
    }
    await until(() => s.announcements().length === 3);
    assert.ok(!stacked(), 'no new replies: one row');
    await reply(s, 'page.html', tab.idOf('li'), 'Looked.');
    await until(stacked);
    assert.equal(row2(), '1 new reply');
    assert.ok(tab.docket().classList.contains('hrv-arrived'), 'a green ring');
    await reply(s, 'page.html', tab.idOf('h1'), 'Seen.');
    await until(() => row2() === '2 new replies');
    const [up, down] = [...tab.layer.querySelectorAll('.hrv-step.hrv-row2')];
    assert.equal(down.title, 'Next new reply');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'h1', 'the first new reply in the page');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'li', 'the paragraph, with no reply, is skipped');
    tab.click(down);
    assert.equal(tab.steppedTo(), 'h1', 'wraps around');
    tab.click(up);
    assert.equal(tab.steppedTo(), 'li');
    await until(() => !tab.docket().classList.contains('hrv-arrived'), 3000);
    tab.open('li');
    tab.type('thanks');
    assert.equal(row2(), '1 new reply', 'a turn takes it off the second row');
    tab.close();
  }));

test('review off: the docket hides its arrows, and ⌥↓ goes to the page', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    tab.type('look here');
    tab.done();
    const altDown = () => {
      const e = new tab.window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(e, { key: 'ArrowDown', altKey: true });
      tab.document.body.dispatchEvent(e);
    };
    altDown();
    assert.equal(tab.steppedTo(), 'p', 'review on, it steps');
    tab.click(tab.layer.querySelector('.hrv-docket-main'));
    assert.ok(tab.docket().classList.contains('hrv-off'));
    const steps = tab.steps();
    altDown();
    assert.equal(tab.steps(), steps, 'review off, no step');
    const css = fs.readFileSync(path.join(here, '..', 'client.css'), 'utf8');
    assert.match(css, /\.hrv-docket\.hrv-off \.hrv-step \{ display: none; \}/, 'the arrows hide');
    tab.close();
  }));

test('a marker click sets where the docket steps from, as a click on its element does', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    for (const selector of ['h1', 'p', 'li']) {
      tab.open(selector);
      tab.type('look here');
      tab.done();
    }
    tab.click(tab.marker('h1'));
    assert.ok(tab.box(), 'the marker opens a box');
    const [, down] = [...tab.layer.querySelectorAll('.hrv-step:not(.hrv-row2)')];
    tab.click(down);
    assert.equal(tab.steppedTo(), 'p', 'the next directive after the heading');
    tab.close();
  }));

// A dialog gives focus back to what opened it, so Tab goes on from the element, not the top.
// assert.ok, not equal, on elements: a failing equal prints the whole linkedom tree and hangs.
test('Done, Esc, and Cmd-Enter give focus back to the element, which keeps no tabindex after', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const key = (init) => {
      const e = new tab.window.Event('keydown', { bubbles: true, cancelable: true });
      Object.assign(e, init);
      tab.field().dispatchEvent(e);
    };
    const closers = {
      Done: () => tab.done(),
      Esc: () => key({ key: 'Escape' }),
      'Cmd-Enter': () => key({ key: 'Enter', metaKey: true }),
    };
    for (const [how, close] of Object.entries(closers)) {
      tab.open('p');
      assert.ok(tab.document.activeElement === tab.field(), 'the box has focus');
      close();
      assert.equal(tab.box(), null);
      assert.ok(tab.document.activeElement === tab.el('p'), `${how}: focus is on the paragraph`);
      tab.open('h1');
      assert.equal(tab.el('p').hasAttribute('tabindex'), false, `${how}: the paragraph leaves no tabindex`);
      tab.done();
      assert.ok(tab.document.activeElement === tab.el('h1'));
    }
    tab.close();
  }));

test('a link takes focus back as it is, and an element the save replaces keeps it', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'demo.html');
    const link = 'a[href="other.html"]';
    tab.open(link);
    tab.done();
    assert.ok(tab.document.activeElement === tab.el(link));
    assert.equal(tab.el(link).getAttribute('tabindex'), null, 'a link needs none');
    tab.open('h1');
    tab.type('A new title', tab.layer.querySelector('.hrv-box textarea.hrv-text'));
    tab.done();
    await until(() => s.read('demo.html').includes('A new title') && tab.el('h1').textContent.includes('A new title'));
    assert.ok(tab.document.activeElement === tab.el('h1'), 'the new heading has focus');
    tab.close();
  }));

test('a reply stays new through opening the box and reloading, until you add a turn or Resolve', () =>
  withServer(async (s) => {
    const storage = new Map();
    const tab = await openTab(s, 'page.html', { storage });
    tab.open('p');
    tab.type('add a diagram');
    tab.done();
    await until(() => s.announcements().length === 1);
    await reply(s, 'page.html', tab.idOf('p'), 'Added one.');
    const isNew = (t) => t.marker('p').classList.contains('hrv-answered');
    await until(() => isNew(tab));
    tab.open('p');
    tab.done();
    assert.ok(isNew(tab), 'opening the box leaves it new');
    tab.close();
    const again = await openTab(s, 'page.html', { storage });
    assert.ok(isNew(again), 'a reload too');
    assert.equal(storage.size, 0, 'the browser keeps nothing');
    again.open('p');
    again.type('and a caption');
    assert.ok(!isNew(again), 'a turn of yours makes it yours to wait on');
    again.type('');
    assert.ok(isNew(again), 'emptying the turn brings it back');
    again.click(again.button('Resolve'));
    assert.equal(again.marker('p'), null, 'Resolve ends the thread');
    again.close();
  }));

// A literal <p> typed in a paragraph's Content box is raw HTML, and a paragraph can't hold one:
// the file splits it into paragraphs. The box goes on editing all of them, so each later save
// replaces them instead of adding a copy beside them.
test('a <p> typed in the Content box splits the paragraph; the next saves replace the split, not copy it', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    const content = () => tab.layer.querySelector('.hrv-box textarea.hrv-text');
    const paragraphs = () => (s.read('page.html').match(/<p[ >]/g) ?? []).length;
    const before = paragraphs();
    const saves = ['I edited a <p>, with newlines', 'I edited a <p>, with newlines, and', 'I edited a <p>, with newlines, and got'];
    for (const text of saves) {
      tab.type(text, content());
      await until(() => s.read('page.html').includes(text.split('<p>')[1] + '</p>'));
    }
    assert.equal(s.read('page.html').split(', with newlines').length - 1, 1, 'one copy of the text after the <p>');
    assert.equal(paragraphs(), before + 2, 'the split made two more paragraphs, once');
    const shown = () => [...tab.document.querySelectorAll('p')].map((p) => p.textContent.trim());
    await until(() => shown().includes(', with newlines, and got'));
    assert.deepEqual(shown(), ['I edited a', ', with newlines, and got', '', 'Second bold paragraph'], 'the tab shows one copy too');
    tab.type('I edited a paragraph', content());
    await until(() => s.read('page.html').includes('I edited a paragraph'));
    assert.equal(paragraphs(), before, 'markdown without the <p> puts back one paragraph');
    await until(() => shown()[0] === 'I edited a paragraph');
    assert.deepEqual(shown(), ['I edited a paragraph', 'Second bold paragraph'], 'and so does the tab');
    assert.ok(tab.box(), 'the box stays open');
    tab.close();
  }));
