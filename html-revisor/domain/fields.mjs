// Fields: the inputs, textareas, and selects in a page, whose values the user's changes write
// into the file. Tier II, pure functions over a DOM.
//
// A field's value, as the file holds it:
//   checkbox, radio: true or false, the checked attribute
//   select: the value of the selected option, the first with none; for a multiple select, an
//     array of the selected ones
//   textarea: its text. linkedom reads a textarea's text raw, where a browser decodes character
//     references in it, so the file holds & and < escaped, and a typed </textarea> stays text.
//   any other input: its value attribute, '' without one
// Buttons, hidden inputs, file pickers, and passwords are no fields: they hold nothing to write.

const NOT_FIELDS = ['button', 'submit', 'reset', 'image', 'hidden', 'file', 'password'];

export const FIELD = `input:not(${NOT_FIELDS.map((t) => `[type="${t}" i]`).join(', ')}), textarea, select`;

export const isField = (el) => el?.nodeType === 1 && el.matches(FIELD);

export const fieldsIn = (root) => [...root.querySelectorAll(FIELD)];

// The input's type, lowercase, text when it has none; textarea and select name themselves.
export function fieldType(el) {
  if (el.localName !== 'input') return el.localName;
  return (el.getAttribute('type') || 'text').toLowerCase();
}

const ticks = (el) => ['checkbox', 'radio'].includes(fieldType(el));

const optionValue = (o) => o.getAttribute('value') ?? o.textContent.replace(/[ \t\n\r\f]+/g, ' ').trim();

export function fieldValueOf(el) {
  if (ticks(el)) return el.hasAttribute('checked');
  if (el.localName === 'textarea') return decoded(el.textContent);
  if (el.localName === 'select') {
    const options = [...el.querySelectorAll('option')];
    const chosen = options.filter((o) => o.hasAttribute('selected')).map(optionValue);
    // A select with none selected shows its first option, as a browser does.
    return el.hasAttribute('multiple') ? chosen : chosen[0] ?? (options[0] ? optionValue(options[0]) : '');
  }
  return el.getAttribute('value') ?? '';
}

const REFERENCES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decoded = (text) => text.replace(/&(amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi, (m, name, dec, hex) =>
  dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : REFERENCES[name.toLowerCase()]);

const multiple = (el) => el.localName === 'select' && el.hasAttribute('multiple');

// Whether value is the shape this field takes, and that shape in words.
export function fitsField(el, value) {
  if (ticks(el)) return typeof value === 'boolean';
  if (multiple(el)) return Array.isArray(value) && value.every((v) => typeof v === 'string');
  return typeof value === 'string';
}

export const fieldShape = (el) => ticks(el) ? 'true or false' : multiple(el) ? 'an array of option values' : 'a string';

// Write value into the field. Gives the elements it changed: a radio checked unchecks the others
// of its group, the radios of the same name in the same form.
export function setField(el, value) {
  if (ticks(el)) {
    const group = fieldType(el) === 'radio' && value ? radioGroup(el).filter((r) => r !== el && r.hasAttribute('checked')) : [];
    group.forEach((r) => r.removeAttribute('checked'));
    if (value) el.setAttribute('checked', '');
    else el.removeAttribute('checked');
    return [el, ...group];
  }
  if (el.localName === 'textarea') el.textContent = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  else if (el.localName === 'select') {
    const wanted = new Set([value].flat());
    let one = false;
    for (const o of el.querySelectorAll('option')) {
      const pick = wanted.has(optionValue(o)) && (el.hasAttribute('multiple') || !one);
      one ||= pick;
      if (pick) o.setAttribute('selected', '');
      else o.removeAttribute('selected');
    }
  } else el.setAttribute('value', value);
  return [el];
}

function radioGroup(el) {
  const name = el.getAttribute('name');
  if (!name) return [el];
  const form = el.closest('form');
  return [...el.ownerDocument.querySelectorAll('input[type="radio" i]')]
    .filter((r) => r.getAttribute('name') === name && r.closest('form') === form);
}

// The text of the field's label: the label around it, or the one whose for names its id. Null
// when it has none.
export function labelOf(el) {
  const id = el.getAttribute('id');
  const label = el.closest('label') ?? (id ? [...el.ownerDocument.querySelectorAll('label[for]')].find((l) => l.getAttribute('for') === id) : null);
  if (!label) return null;
  const copy = label.cloneNode(true);
  copy.querySelectorAll(FIELD).forEach((f) => f.remove());
  return copy.textContent.replace(/[ \t\n\r\f]+/g, ' ').trim() || null;
}
