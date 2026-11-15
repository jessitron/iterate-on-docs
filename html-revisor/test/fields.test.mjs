// Fields: which elements hold a value the user writes, and that value as the file holds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, serialize } from '../domain/canonical.mjs';
import { fieldsIn, fieldType, fieldValueOf, fitsField, setField, labelOf } from '../domain/fields.mjs';

const doc = (body) => parse(`<html><head><title>t</title></head><body>${body}</body></html>`);
const roundTrip = (d) => parse(serialize(d));

test('fields are inputs, textareas, and selects; buttons, hidden inputs, file pickers, and passwords are not', () => {
  const d = doc('<input><input type="Checkbox"><input type="submit"><input type="hidden"><input type="file"><input type="password"><button>b</button><textarea></textarea><select></select>');
  assert.deepEqual(fieldsIn(d.body).map(fieldType), ['text', 'checkbox', 'textarea', 'select']);
});

test('a text input, a checkbox, a textarea, and a select write their values and read them back', () => {
  const d = doc('<input name="q"><input type="checkbox"><textarea>old</textarea><select><option>One</option><option value="b" selected>Two</option></select>');
  const [text, box, area, select] = fieldsIn(d.body);
  assert.deepEqual([text, box, area, select].map(fieldValueOf), ['', false, 'old', 'b']);
  setField(text, 'say "hi"');
  setField(box, true);
  setField(area, 'a &amp; b </textarea><p>not a paragraph');
  setField(select, 'One');
  const back = fieldsIn(roundTrip(d).body);
  assert.deepEqual(back.map(fieldValueOf), ['say "hi"', true, 'a &amp; b </textarea><p>not a paragraph', 'One']);
  assert.equal(roundTrip(d).querySelectorAll('p').length, 0, 'a typed </textarea> stays text');
});

test('checking a radio unchecks the others of its name in its form, and no other', () => {
  const d = doc('<form><input type="radio" name="a" checked><input type="radio" name="a"><input type="radio" name="b" checked></form><input type="radio" name="a" checked>');
  const [one, two, other, outside] = fieldsIn(d.body);
  const changed = setField(two, true);
  assert.ok(changed.length === 2 && changed[0] === two && changed[1] === one, 'it gives the radios it changed');
  assert.deepEqual([one, two, other, outside].map(fieldValueOf), [false, true, true, true]);
});

test('a select with none selected reads as its first option, as a browser shows it', () => {
  const d = doc('<select><option>small</option><option>large</option></select><select multiple><option>a</option></select>');
  assert.deepEqual(fieldsIn(d.body).map(fieldValueOf), ['small', []]);
});

test('a multiple select takes an array of option values', () => {
  const d = doc('<select multiple><option>a</option><option>b</option><option>c</option></select>');
  const [select] = fieldsIn(d.body);
  assert.ok(!fitsField(select, 'a'));
  assert.ok(fitsField(select, ['a', 'c']));
  setField(select, ['a', 'c']);
  assert.deepEqual(fieldValueOf(select), ['a', 'c']);
});

test('a field\'s label is the label around it or the one that names it', () => {
  const d = doc('<label><input type="checkbox"> Buy  milk</label><label for="w">Weight</label><input id="w"><input>');
  assert.deepEqual(fieldsIn(d.body).map(labelOf), ['Buy milk', 'Weight', null]);
});
