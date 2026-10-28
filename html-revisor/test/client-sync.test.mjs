// The client's sync engine in the tab (client-lib.mjs): what a save's answer does to the page,
// the box, and the docket, what the tab does when the file changes under it, and two tabs on
// one page. These pin what the client does today, ahead of moving it into tiers. Each test names
// the line of README's "Manual client checklist" it stands for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { withServer, openTab, until } from './client-lib.mjs';

const RELOAD = 'the page changed on disk; reload to see it';

// Make the server's root a repository and commit everything in it, as it stands.
function commitAll(dir) {
  const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  run('add', '.');
  run('commit', '-q', '-m', 'turn');
}

// Checklist: "Typing in the Content field changes the file within about half a second, and the
// page when the save answers."
test('a markdown save puts the answer\'s HTML in the page, and the box stays on the element', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    const id = tab.idOf('p');
    tab.type('First paragraph, **edited**', tab.content());
    assert.equal(tab.hint(), 'saving…');
    await until(() => tab.el(`[data-hrv="${id}"] strong`));
    assert.match(s.read('page.html'), /First paragraph, <strong>edited<\/strong>/);
    assert.equal(tab.el('p').innerHTML, 'First paragraph, <strong>edited</strong>', 'the HTML the server wrote, not the markdown');
    assert.equal(tab.idOf('p'), id, 'the paragraph keeps its ID');
    assert.equal(tab.layer.querySelector('.hrv-box .hrv-what').textContent, 'p · First paragraph, edited', 'the header reads the new text');
    await until(() => tab.hint() === 'saved');
    tab.type('First paragraph, **edited** twice', tab.content());
    await until(() => s.read('page.html').includes('twice'));
    assert.equal(s.read('page.html').split('First paragraph').length - 1, 1, 'the second save replaces the first');
    assert.equal(tab.message(), '');
    tab.close();
  }));

// Checklist: "Type a list's markdown into one sentence: the list becomes a paragraph, the box
// stays open on it, and the list's own directive moves to it."
test('a list typed into a sentence: the box, the directive, and the next save follow the ID that holds it now', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('ul');
    const listId = tab.idOf('ul');
    tab.type('tidy this');
    await until(() => s.read('page.html').includes('<!-- @AI: tidy this -->'));
    tab.type('one and two', tab.content());
    await until(() => !tab.el('ul'));
    const holder = [...tab.document.querySelectorAll('p')].at(-1);
    assert.equal(holder.textContent.trim(), 'one and two');
    const id = holder.getAttribute('data-hrv');
    assert.ok(tab.box(), 'the box stays open');
    assert.equal(tab.layer.querySelector('.hrv-box .hrv-what').textContent, 'p · one and two');
    assert.notEqual(id, listId, 'the paragraph is a new element, with an ID of its own');
    assert.equal(tab.layer.querySelector(`.hrv-marker[data-for="${listId}"]`), null, 'no marker on the old ID');
    assert.ok(tab.layer.querySelector(`.hrv-marker[data-for="${id}"]`), 'the directive\'s marker is on the paragraph');
    assert.match(s.read('page.html'), new RegExp(`<p data-hrv="${id}">\\s*<!-- @AI: tidy this -->\\s*one and two`));
    tab.type('tidy this, please');
    await until(() => s.read('page.html').includes('<!-- @AI: tidy this, please -->'));
    tab.type('one and two and three', tab.content());
    await until(() => s.read('page.html').includes('one and two and three'));
    assert.doesNotMatch(s.read('page.html'), /one and two</, 'the next save replaced the paragraph, not added one');
    assert.equal(tab.message(), '');
    tab.close();
  }));

// Checklist: "Edit one element in the file on disk while the tab is open, then type a directive
// on that element: the docket says it wasn't saved and suggests a reload, the box's footer says
// `not saved`, the file stays untouched, and the box keeps your text."
test('412: a directive on an element changed on disk is not saved, and the box keeps its text', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    s.write('page.html', s.read('page.html').replace('First paragraph', 'First paragraph, from an editor'));
    await until(() => tab.message() === RELOAD);
    assert.equal(tab.el('p').textContent, 'First paragraph', 'the tab can\'t show it without a reload');
    const onDisk = s.read('page.html');
    tab.open('p');
    tab.type('say more');
    await until(() => tab.hint() === 'not saved');
    assert.match(tab.message(), /^not saved: .+\. Copy what you wrote, then reload to see the page as it is now$/);
    assert.equal(s.read('page.html'), onDisk, 'the file is untouched');
    assert.equal(tab.field().value, 'say more');
    assert.ok(tab.marker('p'), 'the marker shows what you typed');
    tab.type('say more, again');
    await until(() => tab.hint() === 'not saved');
    assert.equal(s.read('page.html'), onDisk, 'each try is refused');
    tab.close();
  }));

// Checklist: "Edit a different element on disk: without typing, the docket says the page changed
// on disk. Type a directive: it saves."
test('another element changed on disk: the docket says the page changed, and a directive still saves', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    s.write('page.html', s.read('page.html').replace('Title', 'Title, from an editor'));
    await until(() => tab.message() === RELOAD);
    tab.open('p');
    tab.type('say more');
    await until(() => tab.hint() === 'saved');
    assert.ok(s.read('page.html').includes('<!-- @AI: say more -->'));
    assert.ok(s.read('page.html').includes('Title, from an editor'), 'the save keeps the other edit');
    assert.equal(tab.message(), RELOAD, 'the notice stays');
    assert.equal(tab.el('h1').textContent, 'Title', 'the heading shows after a reload');
    tab.close();
  }));

// Checklist: "Add `<!-- @AI: … -->` to an element on disk: its marker shows without a reload.
// Delete it: the marker goes."
test('a directive added on disk shows its marker without a reload, and deleting it takes the marker away', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    const page = s.read('page.html');
    s.write('page.html', page.replace('>First paragraph', '><!-- @AI: from the agent -->First paragraph'));
    await until(() => tab.marker('p'));
    assert.equal(tab.marker('p').getAttribute('aria-label'), 'Agent working on: from the agent');
    assert.equal(tab.count(), '1 directive');
    assert.equal(tab.message(), '', 'a directive is no content change: no reload notice');
    tab.open('p');
    assert.deepEqual(tab.turns(), [['you', 'from the agent'], ['agent', 'working']], 'the box opens on it');
    tab.done();
    s.write('page.html', page);
    await until(() => !tab.marker('p'));
    assert.equal(tab.count(), '0 directives');
    tab.close();
  }));

// The README's Live notice: "A change on disk to the open box's directive alone waits until the
// box closes."
test('the open box\'s directive changed on disk: the docket says so, and it shows when the box closes', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    tab.type('say more');
    await until(() => tab.hint() === 'saved');
    s.write('page.html', s.read('page.html').replace('@AI: say more', '@AI: say less'));
    await until(() => tab.message() === 'this directive changed on disk; close the box to see it');
    assert.equal(tab.field().value, 'say more', 'nothing changes under your typing');
    tab.done();
    await until(() => tab.marker('p').getAttribute('aria-label') === 'Agent working on: say less');
    assert.equal(tab.message(), '');
    assert.ok(s.read('page.html').includes('<!-- @AI: say less -->'), 'Done writes nothing over it');
    tab.close();
  }));

// Checklist: "While writing a new directive, Clear (or emptying the text, or `⌥⌘⌫` in the box)
// removes the directive and the marker. Clear shows only when there is a directive, in both
// boxes, and its tooltip names the hotkey. Clear leaves the box open with the Content field as
// you left it, and `⌘Z` brings the directive back."
// ⌘Z is the browser's undo of typeOver's execCommand; linkedom has neither, so it isn't here.
test('Clear, and ⌥⌘⌫, take the directive and its marker away and leave the box open', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    const clear = () => tab.button('Clear');
    assert.ok(clear().hidden, 'no directive, no Clear');
    assert.equal(clear().title, 'Clear the directive (⌥⌘⌫)');
    tab.type('First paragraph, edited', tab.content());
    const ways = {
      Clear: () => tab.click(clear()),
      '⌥⌘⌫': () => {
        const e = new tab.window.Event('keydown', { bubbles: true, cancelable: true });
        Object.assign(e, { key: 'Backspace', altKey: true, metaKey: true });
        tab.field().dispatchEvent(e);
      },
    };
    for (const [how, clearIt] of Object.entries(ways)) {
      tab.type('say more');
      assert.ok(!clear().hidden, `${how}: Clear shows`);
      await until(() => s.read('page.html').includes('<!-- @AI: say more -->'));
      clearIt();
      assert.equal(tab.field().value, '', `${how}: the field empties`);
      assert.equal(tab.marker('p'), null, `${how}: the marker goes`);
      assert.ok(clear().hidden, `${how}: Clear hides`);
      await until(() => !s.read('page.html').includes('@AI'));
      assert.ok(tab.box(), `${how}: the box stays open`);
      assert.equal(tab.content().value, 'First paragraph, edited', `${how}: Content as you left it`);
    }
    tab.close();
  }));

// Checklist: "In a committed page, Revert shows on the Content line only after you change a
// scope. Clicking it puts the committed markdown back and saves. Delete a list item, then Revert
// the list: the item returns."
// ⌘Z taking the revert back is the browser's undo, out of the tab's reach.
test('Revert shows once a scope differs from the commit, and puts the committed markdown back', () =>
  withServer(async (s) => {
    commitAll(s.dir);
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    const revert = () => tab.button('Revert');
    assert.ok(revert().hidden, 'as committed, no Revert');
    tab.type('First paragraph, edited', tab.content());
    assert.ok(!revert().hidden, 'changed, Revert shows');
    await until(() => s.read('page.html').includes('First paragraph, edited'));
    tab.click(revert());
    assert.equal(tab.content().value, 'First paragraph');
    assert.ok(revert().hidden);
    await until(() => !s.read('page.html').includes('edited') && tab.el('p').textContent === 'First paragraph');
    tab.done();

    tab.open('ul');
    assert.equal(tab.content().value, '- one\n- two');
    tab.type('- one', tab.content());
    await until(() => !s.read('page.html').includes('>two</li>'));
    tab.click(revert());
    await until(() => s.read('page.html').includes('>two</li>'));
    assert.deepEqual([...tab.document.querySelectorAll('li')].map((li) => li.textContent), ['one', 'two'], 'the item returns');
    tab.close();
  }));

// Checklist: "Opening a second box commits and closes the first."
test('opening a second box commits the first: its Done goes out after its save, and the box moves', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    tab.type('say more');
    tab.open('h1');
    assert.equal(tab.layer.querySelectorAll('.hrv-box').length, 1);
    assert.equal(tab.layer.querySelector('.hrv-box .hrv-what').textContent, 'h1 · Title');
    assert.ok(tab.marker('p').classList.contains('hrv-working'), 'the first box\'s turn is the agent\'s');
    await until(() => s.announcements().length === 1);
    assert.ok(s.read('page.html').includes('<!-- @AI: say more -->'), 'its save landed before its Done');
    assert.equal(s.announcements()[0].id, tab.idOf('p'));
    assert.deepEqual(s.announcements()[0].directive, { before: '', after: 'say more' });
    tab.close();
  }));

// Checklist: "With two tabs on one page, a directive typed in one shows its marker in the other."
test('two tabs: a directive typed in one shows its marker in the other, and the other can add to it', () =>
  withServer(async (s) => {
    const one = await openTab(s, 'page.html');
    const two = await openTab(s, 'page.html');
    one.open('p');
    one.type('say more');
    await until(() => two.marker('p'));
    assert.equal(two.marker('p').getAttribute('aria-label'), 'Agent working on: say more');
    assert.equal(two.count(), '1 directive');
    assert.equal(two.message(), '', 'a directive is no reason to reload');
    one.done();
    two.open('p');
    assert.deepEqual(two.turns(), [['you', 'say more'], ['agent', 'working']]);
    two.type('and a caption');
    await until(() => s.read('page.html').includes('<!-- @AI: say more\nand a caption -->'));
    two.done();
    await until(() => one.marker('p').getAttribute('aria-label') === 'Agent working on: say more\nand a caption');
    one.close();
    two.close();
  }));

// A markdown save in one tab is content the other can't show: it says to reload, as for an
// edit on disk, and a save there on that element is refused.
test('two tabs: a markdown save in one asks the other to reload', () =>
  withServer(async (s) => {
    const one = await openTab(s, 'page.html');
    const two = await openTab(s, 'page.html');
    one.open('p');
    one.type('First paragraph, edited', one.content());
    await until(() => two.message() === RELOAD);
    assert.equal(two.el('p').textContent, 'First paragraph');
    two.open('p');
    two.type('say more');
    await until(() => two.hint() === 'not saved');
    two.open('h1');
    two.type('a better title');   // an element the other tab left alone saves
    await until(() => s.read('page.html').includes('<!-- @AI: a better title -->'));
    one.close();
    two.close();
  }));

// Checklist: "Stopping the server and typing shows `save failed: ...` on the docket; restarting
// and typing again saves and clears it."
// The tab's live notices go on through this; a stopped server would end them too.
test('server down: "save failed", then typing again once it is back saves the latest text', () =>
  withServer(async (s) => {
    const tab = await openTab(s, 'page.html');
    tab.open('p');
    s.down = true;
    tab.type('say more');
    await until(() => tab.message().startsWith('save failed'));
    assert.equal(tab.message(), 'save failed: Failed to fetch');
    assert.ok(tab.docket().classList.contains('hrv-error'));
    assert.equal(tab.hint(), '⌘↵ or esc to close', 'the footer goes back to the hint');
    tab.type('say more, please');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(tab.message(), 'save failed: Failed to fetch', 'still down');
    s.down = false;
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!s.read('page.html').includes('@AI'), 'nothing retries until you type');
    tab.type('say more, please, now');
    await until(() => tab.hint() === 'saved');
    assert.ok(s.read('page.html').includes('<!-- @AI: say more, please, now -->'));
    assert.equal(tab.message(), '', 'the error clears');
    assert.ok(!tab.docket().classList.contains('hrv-error'));
    tab.close();
  }));
