// html-revisor client. Directives live in the file on disk; this script edits them through PUT.
(function () {
  'use strict';

  var directives = {};      // id -> text, the full current set
  var texts = {};           // id -> new text of each text element edited in this tab
  var bases = {};           // id -> base: the element's content as the server last saw it
  var markers = {};         // id -> marker element
  var box = null;           // the open directive box, if any
  var boxId = null;         // id of the element the open box is for
  var saveTimer = null;
  var saving = false;       // a PUT is in flight
  var unsent = [];          // changes not yet sent, oldest first: {kind: 'directive'|'text', id}
  var version = null;       // fingerprint of the file as this tab last saw it
  var changedOnDisk = false; // a save found the file changed by someone else

  try {
    var data = document.getElementById('hrv-directives');
    directives = JSON.parse(data.textContent) || {};
    version = data.getAttribute('data-version');
    bases = JSON.parse(document.getElementById('hrv-bases').textContent) || {};
  } catch (e) {
    directives = directives || {};
  }

  var layer = document.createElement('div');
  layer.id = 'hrv-layer';
  document.body.appendChild(layer);

  // ---- helpers ----

  function hasText(id) {
    return typeof directives[id] === 'string' && directives[id].trim() !== '';
  }

  function elementFor(id) {
    return document.querySelector('[data-hrv="' + id + '"]');
  }

  function inLayer(node) {
    return node instanceof Node && layer.contains(node);
  }

  // The nearest element with an ID, never html or body.
  function targetElement(node) {
    if (!(node instanceof Element)) return null;
    var el = node.closest('[data-hrv]');
    if (!el || el === document.documentElement || el === document.body) return null;
    return el;
  }

  // An element holding only text, so the box can edit it without losing markup.
  // Same rule as isTextElement on the server.
  var NOT_TEXT = ('area base br col embed hr img input link meta param source track wbr ' +
    'title iframe xmp noembed noframes script style template textarea').split(' ');
  var SPACE = /[ \t\n\r\f]+/g;   // the whitespace HTML collapses; not U+00A0

  function isTextElement(el) {
    var kids = el.childNodes;
    if (NOT_TEXT.indexOf(el.localName) >= 0 || kids.length === 0) return false;
    for (var i = 0; i < kids.length; i++) if (kids[i].nodeType !== 3) return false;
    return el.textContent.replace(SPACE, '') !== '';
  }

  // The text as the reader sees it. Outside pre, layout whitespace collapses.
  function shownText(el) {
    if (el.localName === 'pre') return el.textContent;
    return el.textContent.replace(SPACE, ' ').trim();
  }

  // Where the layer's origin sits in the document. Zero unless body is positioned.
  function layerOrigin() {
    var r = layer.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY };
  }

  function isHidden(rect) {
    return rect.width === 0 && rect.height === 0;
  }

  // The html-revisor icon, for every UI element the tool adds.
  function icon() {
    var span = document.createElement('span');
    span.className = 'hrv-icon';
    return span;
  }

  // ---- crop marks ----

  // How far outside the element's box its crop marks sit, from client.css.
  var cropGap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hrv-crop-gap')) || 4;

  function makeCrop(className) {
    var crop = document.createElement('div');
    crop.className = className;
    crop.style.display = 'none';
    layer.appendChild(crop);
    return crop;
  }

  // Cover the element's box plus the gap, kept inside the document so it adds no scrolling.
  function positionCrop(crop, el) {
    var rect = el ? el.getBoundingClientRect() : null;
    if (!rect || isHidden(rect)) { crop.style.display = 'none'; return; }
    var doc = document.documentElement;
    var o = layerOrigin();
    var x = rect.left + window.scrollX, y = rect.top + window.scrollY;
    var right = Math.min(x + rect.width + cropGap, Math.max(doc.scrollWidth, x + rect.width));
    var bottom = Math.min(y + rect.height + cropGap, Math.max(doc.scrollHeight, y + rect.height));
    var left = Math.max(0, x - cropGap), top = Math.max(0, y - cropGap);
    crop.style.display = 'block';
    crop.style.left = left - o.x + 'px';
    crop.style.top = top - o.y + 'px';
    crop.style.width = right - left + 'px';
    crop.style.height = bottom - top + 'px';
  }

  // ---- hover ----

  var hovered = null;
  var flashed = null;       // the element the pill just stepped to; its marks show for a moment
  var reviewing = true;     // review mode: hover marks, copy cursor, click to open, markers
  var hoverCrop = makeCrop('hrv-crop');
  var selectedCrop = makeCrop('hrv-crop hrv-selected');

  // The open box's element shows its heavier marks instead. Out of review mode, only a step shows marks.
  function positionHover() {
    var el = flashed || (reviewing ? hovered : null);
    positionCrop(hoverCrop, el && el !== elementFor(boxId) ? el : null);
  }

  function setHover(el) {
    if (el === hovered) return;
    hovered = el;
    positionHover();
  }

  // Over a marker, its element shows crop marks too.
  document.addEventListener('mouseover', function (e) {
    if (!inLayer(e.target)) { setHover(targetElement(e.target)); return; }
    var marker = e.target.closest('.hrv-marker');
    setHover(marker ? elementFor(marker.getAttribute('data-for')) : null);
  }, true);

  document.addEventListener('mouseout', function (e) {
    if (!e.relatedTarget) setHover(null);
  }, true);

  // ---- markers ----

  // Each marker sits outside its element's box, clear of the crop marks, so it never covers what
  // it marks. Its pencil tip points down-right at the element. The first choice is the left side,
  // top-aligned with the element's first line; with no room there, above the top-left corner.
  // A marker that would land on one already placed steps outward, further left or further up.
  // Inner elements go first, so a section and its first paragraph show two markers side by side.
  var TILE = 20, STEP = TILE + 2;
  var markerGap = cropGap + 3;     // clear of the heavier crop marks too

  function overlaps(a, b) {
    return a.x < b.x + TILE && b.x < a.x + TILE && a.y < b.y + TILE && b.y < a.y + TILE;
  }

  function markerSpot(rect, placed) {
    var x = rect.left + window.scrollX, y = rect.top + window.scrollY;
    var spot = { x: x - markerGap - TILE, y: y };
    var dx = -STEP, dy = 0;
    if (spot.x < 2) {
      spot = { x: Math.max(2, x - TILE / 2), y: y - markerGap - TILE };
      dx = 0; dy = -STEP;
    }
    for (var i = 0; i < 20 && placed.some(function (p) { return overlaps(p, spot); }); i++) {
      if (spot.x + dx < 2 || spot.y + dy < 2) break;
      spot = { x: spot.x + dx, y: spot.y + dy };
    }
    return { x: Math.max(2, spot.x), y: Math.max(2, spot.y) };
  }

  function positionMarkers() {
    var o = layerOrigin();
    var els = [];
    for (var id in markers) {
      var el = elementFor(id);
      var rect = el && el.getBoundingClientRect();
      if (!rect || isHidden(rect)) { markers[id].style.display = 'none'; continue; }
      els.push({ id: id, el: el, rect: rect });
    }
    // Later in the document first, so a child places before its parent.
    els.sort(function (a, b) {
      return a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1;
    });
    var placed = [];
    els.forEach(function (m) {
      var spot = markerSpot(m.rect, placed);
      placed.push(spot);
      var marker = markers[m.id];
      marker.style.display = 'block';
      marker.style.left = spot.x - o.x + 'px';
      marker.style.top = spot.y - o.y + 'px';
    });
    positionTip();
  }

  // Our own tooltip, in the material: the directive text, beside the marker under the pointer.
  var tip = document.createElement('div');
  tip.className = 'hrv-tip';
  tip.style.display = 'none';
  layer.appendChild(tip);
  var tipId = null;

  function showTip(id) {
    tipId = id;
    positionTip();
  }

  function hideTip() {
    tipId = null;
    tip.style.display = 'none';
  }

  // Above the marker, left edges aligned; below it with no room above. Kept inside the window.
  function positionTip() {
    var marker = tipId && markers[tipId];
    if (!marker || marker.style.display === 'none' || !hasText(tipId)) { hideTip(); return; }
    tip.textContent = directives[tipId];
    tip.style.display = 'block';
    var o = layerOrigin();
    var m = marker.getBoundingClientRect();
    var viewW = document.documentElement.clientWidth;
    var width = tip.offsetWidth, height = tip.offsetHeight;
    var left = Math.max(8, Math.min(m.left, viewW - width - 8));
    var top = m.top - height - 6;
    if (top < 8) top = m.bottom + 6;
    tip.style.left = left + window.scrollX - o.x + 'px';
    tip.style.top = top + window.scrollY - o.y + 'px';
  }

  // ---- directive box placement ----
  // The box opens beside its element, never over it: below, above, right, or left, the first
  // with room in the viewport. The side it gets stays while it still fits, so the box doesn't
  // flip as the element grows under typing. When no side fits (a tall element, a narrow screen),
  // the box pins to the viewport edge farthest from the visible part of the element.
  // Along the other axis it starts at the element's edge, shifts to stay in view, and keeps
  // overlapping the element's span so the notch can point at it.

  var BOX_MARGIN = 8;   // between the box and the viewport edge
  var BOX_GAP = 16;     // between the element and the box: the crop gap, the notch, air
  var NOTCH_END = 12;   // the notch stays this far from the box's corners

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(n, hi));
  }

  // The middle of the overlap of [a0,a1] and [b0,b1], or of [a0,a1] if they don't meet.
  function overlapMiddle(a0, a1, b0, b1) {
    var lo = Math.max(a0, b0), hi = Math.min(a1, b1);
    return lo <= hi ? (lo + hi) / 2 : (a0 + a1) / 2;
  }

  function positionBox() {
    if (!box) return;
    var el = elementFor(boxId);
    if (!el) return;
    var r = el.getBoundingClientRect();
    if (isHidden(r)) return;
    var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
    var m = BOX_MARGIN, g = BOX_GAP;
    var w = Math.min(320, vw - 2 * m);
    box.style.width = w + 'px';
    var h = box.offsetHeight;

    var fits = {
      below: r.bottom + g + h <= vh - m,
      above: r.top - g - h >= m,
      right: r.right + g + w <= vw - m,
      left: r.left - g - w >= m
    };
    var side = fits[box.hrvSide] ? box.hrvSide : null;
    ['below', 'above', 'right', 'left'].forEach(function (s) {
      if (!side && fits[s]) side = s;
    });
    var pointing = side;   // which side of the element the box is on, for the notch
    if (side) box.hrvSide = side;
    else {
      var visTop = clamp(r.top, 0, vh), visBottom = clamp(r.bottom, 0, vh);
      pointing = (visTop + visBottom) / 2 > vh / 2 ? 'above' : 'below';
    }

    var left, top;
    if (pointing === 'below' || pointing === 'above') {
      left = clamp(r.left, m, vw - m - w);
      left = clamp(left, r.left - w + 2 * NOTCH_END, r.right - 2 * NOTCH_END);
      if (!side) top = pointing === 'above' ? m : vh - m - h;
      else top = side === 'below' ? r.bottom + g : r.top - g - h;
      box.style.setProperty('--hrv-notch',
        clamp(overlapMiddle(r.left, r.right, Math.max(0, left), Math.min(vw, left + w)) - left, NOTCH_END, w - NOTCH_END) + 'px');
    } else {
      left = side === 'right' ? r.right + g : r.left - g - w;
      top = clamp(r.top, m, vh - m - h);
      top = clamp(top, r.top - h + 2 * NOTCH_END, r.bottom - 2 * NOTCH_END);
      box.style.setProperty('--hrv-notch',
        clamp(overlapMiddle(r.top, r.bottom, Math.max(0, top), Math.min(vh, top + h)) - top, NOTCH_END, h - NOTCH_END) + 'px');
    }
    box.setAttribute('data-side', pointing);

    var origin = layer.getBoundingClientRect();
    box.style.left = left - origin.left + 'px';
    box.style.top = top - origin.top + 'px';
  }

  function positionAll() {
    positionMarkers();
    positionBox();
    positionCrop(selectedCrop, box ? elementFor(boxId) : null);
    positionHover();
  }

  var frame = 0;
  function schedulePosition() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      positionAll();
    });
  }

  // Make the marker match the directive text. A marker added or removed can move the others.
  function syncMarker(id) {
    if (hasText(id)) {
      var marker = markers[id];
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'hrv-marker';
        marker.setAttribute('data-for', id);
        marker.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          hideTip();
          openBox(id);
        });
        marker.addEventListener('mouseenter', function () { showTip(id); });
        marker.addEventListener('mouseleave', hideTip);
        layer.appendChild(marker);
        markers[id] = marker;
      }
      marker.setAttribute('aria-label', directives[id]);
    } else if (markers[id]) {
      markers[id].remove();
      delete markers[id];
    }
    positionMarkers();
  }

  window.addEventListener('scroll', schedulePosition, { passive: true });
  window.addEventListener('resize', schedulePosition);
  if (window.ResizeObserver) new ResizeObserver(schedulePosition).observe(document.body);

  // ---- the pill ----

  // Bottom right of the window. It counts the directives, steps through them in document order,
  // and holds a save error or the stale-file warning. Its icon and count switch review mode.
  var current = null;       // id of the element last stepped to or clicked
  var problem = null;       // the save error or stale warning the pill shows, if any
  var flashTimer = null;

  var pill = document.createElement('div');
  pill.className = 'hrv-pill';
  var pillMsg = document.createElement('div');
  pillMsg.className = 'hrv-pill-msg';
  var pillMain = document.createElement('div');
  pillMain.className = 'hrv-pill-main';
  var pillCount = document.createElement('span');
  pillMain.appendChild(icon());
  pillMain.appendChild(pillCount);
  pillMain.addEventListener('click', function () { setReviewing(!reviewing); });
  pill.appendChild(pillMsg);
  pill.appendChild(pillMain);
  pill.appendChild(stepButton('↑', 'Previous directive (⌥↑)', -1));
  pill.appendChild(stepButton('↓', 'Next directive (⌥↓)', 1));
  layer.appendChild(pill);

  function stepButton(arrow, title, dir) {
    var b = document.createElement('div');
    b.className = 'hrv-step';
    b.textContent = arrow;
    b.title = title;
    b.addEventListener('click', function () { step(dir); });
    return b;
  }

  function updatePill() {
    var n = directiveCount();
    pillCount.textContent = n + (n === 1 ? ' directive' : ' directives') + (reviewing ? '' : ' · review off');
    pillMsg.textContent = problem || '';
    pillMain.title = reviewing
      ? 'Review mode: click to hide the marks and read the page'
      : 'Review mode is off: click to leave directives again';
    pill.className = 'hrv-pill' + (n === 0 ? ' hrv-none' : '') + (reviewing ? '' : ' hrv-off') +
      (problem ? ' hrv-error' : '');
  }

  function showProblem(text) {
    problem = text;
    updatePill();
  }

  // Elements with directives, in document order.
  function directiveElements() {
    var els = [];
    for (var id in directives) {
      var el = hasText(id) && elementFor(id);
      if (el) els.push(el);
    }
    return els.sort(function (a, b) { return follows(a, b) ? -1 : 1; });
  }

  function follows(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // Scroll the next (dir 1) or previous (dir -1) directive's element to the middle of the window
  // and show its crop marks for a moment. Wraps around at the ends.
  function step(dir) {
    var els = directiveElements();
    if (!els.length) return;
    var from = current !== null && elementFor(current);
    var target = null;
    if (dir > 0) {
      for (var i = 0; i < els.length && !target; i++) if (!from || follows(from, els[i])) target = els[i];
      target = target || els[0];
    } else {
      for (var j = els.length - 1; j >= 0 && !target; j--) if (!from || follows(els[j], from)) target = els[j];
      target = target || els[els.length - 1];
    }
    closeBox();
    current = target.getAttribute('data-hrv');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashed = target;
    positionHover();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      flashed = null;
      positionHover();
    }, 2000);
  }

  // Review mode off reads the page clean: no marks, no copy cursor, clicks go to the page.
  // The cursor rule is the one place this reaches the page: an attribute on the html element.
  function setReviewing(on) {
    reviewing = on;
    if (!on) closeBox();
    if (on) document.documentElement.removeAttribute('data-hrv-review');
    else document.documentElement.setAttribute('data-hrv-review', 'off');
    layer.classList.toggle('hrv-reading', !on);
    positionHover();
    updatePill();
  }

  // ⌥↓ and ⌥↑ step, unless the reader is typing somewhere.
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    var t = e.target;
    if (t instanceof Element && (t.isContentEditable || t.closest('input, textarea, select'))) return;
    e.preventDefault();
    step(e.key === 'ArrowDown' ? 1 : -1);
  });

  // ---- saving ----

  function directiveCount() {
    var n = 0;
    for (var id in directives) if (hasText(id)) n++;
    return n;
  }

  // Mark a change to send. A change already waiting sends the latest value, once.
  function addUnsent(kind, id) {
    for (var i = 0; i < unsent.length; i++) {
      if (unsent[i].kind === kind && unsent[i].id === id) return;
    }
    unsent.push({ kind: kind, id: id });
  }

  function bodyFor(change) {
    var body = { id: change.id, base: bases[change.id] || '' };
    body[change.kind] = change.kind === 'text' ? texts[change.id] : (directives[change.id] || '');
    return body;
  }

  // One PUT at a time, one change per PUT. When a PUT ends, the next change goes out.
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (saving || unsent.length === 0) return;
    saving = true;
    var change = unsent.shift();
    var failed = false;
    var fromBox = !!box;   // a save made while a box is open reports in the box
    fetch(location.pathname, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyFor(change))
    }).then(function (res) {
      if (res.ok || res.status === 412) return res.json();
      return res.text().then(function (t) {
        throw new Error(t || ('HTTP ' + res.status));
      });
    }).then(function (data) {
      if (!data.ok) {
        // A conflict: we weren't taking turns. Say so; the reload is up to the human.
        failed = true;
        boxStatus('not saved');
        showProblem('not saved: ' + data.error + '. Copy what you wrote, then reload to see the page as it is now');
        return;
      }
      for (var id in data.bases) bases[id] = data.bases[id];
      if (data.before !== version) changedOnDisk = true;
      version = data.after;
      showProblem(changedOnDisk ? 'the page changed on disk; reload to see it' : null);
      // A newer edit, waiting or queued, keeps the box at "saving…".
      if (fromBox && box && unsent.length === 0 && !saveTimer) boxStatus('saved');
    }).catch(function (err) {
      failed = true;
      addUnsent(change.kind, change.id); // a later edit retries it
      boxStatus('');
      showProblem('save failed: ' + (err && err.message ? err.message : err));
    }).then(function () {
      saving = false;
      if (!failed) saveNow();
    });
  }

  function scheduleSave(kind, id) {
    addUnsent(kind, id);
    boxStatus('saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  // ---- directive box ----

  var MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  var HINT = (MAC ? '⌘↵' : 'Ctrl+Enter') + ' or esc to close';
  // Delete's hotkey: Option-Command-Backspace (Ctrl+Alt+Backspace elsewhere). In a textarea,
  // ⌘⌫ and ⌥⌫ delete text, and the browser takes ⌘⇧⌫; nothing claims this one.
  var DELETE_KEY = MAC ? '⌥⌘⌫' : 'Ctrl+Alt+Backspace';
  var statusTimer = null;

  // The box footer's words: the hint, or the save status while one is current.
  function boxStatus(text) {
    if (!box) return;
    var hint = box.querySelector('.hrv-hint');
    clearTimeout(statusTimer);
    hint.textContent = text || HINT;
    hint.className = 'hrv-hint' + (text ? ' hrv-status' : '');
    if (text === 'saved') statusTimer = setTimeout(function () { boxStatus(''); }, 2000);
  }

  // What the header calls the element: its tag, then the start of its text.
  // An element with no text falls back to its alt, aria-label, or title.
  function describe(el) {
    var text = (el.textContent || '').replace(SPACE, ' ').trim() ||
      el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (text.length > 80) text = text.slice(0, 80);
    return el.localName + (text ? ' · ' + text : '');
  }

  // Grow a textarea to fit its text; CSS max-height caps it, and past that it scrolls.
  function fit(ta) {
    ta.style.height = '0px';
    ta.style.height = ta.scrollHeight + ta.offsetHeight - ta.clientHeight + 'px';
  }

  // The Text field wears the element's own font, so editing feels like editing the page.
  // Size stays between 12 and 20px: a hero heading would crowd the box, a footnote strain the eye.
  function wearFont(ta, el) {
    var cs = getComputedStyle(el);
    ta.style.fontFamily = cs.fontFamily;
    ta.style.fontStyle = cs.fontStyle;
    ta.style.fontWeight = cs.fontWeight;
    ta.style.fontSize = Math.max(12, Math.min(20, parseFloat(cs.fontSize) || 13)) + 'px';
    ta.style.lineHeight = '1.35';
  }

  function setDirective(id, text) {
    if (text.trim() === '') delete directives[id];
    else directives[id] = text;
    syncMarker(id);
    updatePill();
  }

  // Commit and close the open box.
  function closeBox() {
    if (!box) return;
    var ta = box.querySelector('textarea.hrv-directive');
    var id = boxId;
    setDirective(id, ta.value);
    clearTimeout(statusTimer);
    box.remove();
    box = null;
    boxId = null;
    positionCrop(selectedCrop, null);
    positionHover();
    saveNow();
  }

  function deleteDirective(ta, id) {
    ta.value = '';
    setDirective(id, '');
    addUnsent('directive', id);
    closeBox();
  }

  function openBox(id) {
    if (box && boxId === id) {
      box.querySelector('textarea.hrv-directive').focus();
      return;
    }
    closeBox();
    var el = elementFor(id);
    if (!el) return;
    boxId = id;
    box = document.createElement('div');
    box.className = 'hrv-box';

    var head = document.createElement('div');
    head.className = 'hrv-head';
    var what = document.createElement('span');
    what.className = 'hrv-what';
    what.textContent = describe(el);
    head.appendChild(icon());
    head.appendChild(what);
    box.appendChild(head);

    // Text elements get a field for their text above the directive.
    // The page shows each edit at once; blank text is not applied.
    var textArea = null;
    if (isTextElement(el)) {
      textArea = document.createElement('textarea');
      textArea.className = 'hrv-text';
      textArea.value = shownText(el);
      wearFont(textArea, el);
      textArea.addEventListener('input', function () {
        fit(textArea);
        schedulePosition();
        if (textArea.value.replace(SPACE, '') === '') return;
        el.textContent = textArea.value;
        texts[id] = textArea.value;
        what.textContent = describe(el);
        scheduleSave('text', id);
      });
      box.appendChild(label('Text'));
      box.appendChild(textArea);
      box.appendChild(label('Directive'));
    }

    var ta = document.createElement('textarea');
    ta.className = 'hrv-directive';
    ta.value = directives[id] || '';
    ta.placeholder = 'Directive for this element';
    ta.addEventListener('input', function () {
      fit(ta);
      schedulePosition();
      setDirective(id, ta.value);
      scheduleSave('directive', id);
    });
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        closeBox();
      } else if (e.key === 'Backspace' && e.altKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        deleteDirective(ta, id);
      }
    });

    var hint = document.createElement('div');
    hint.className = 'hrv-hint';
    hint.textContent = HINT;

    var del = document.createElement('div');
    del.className = 'hrv-btn hrv-quiet';
    del.textContent = 'Delete';
    del.title = 'Delete the directive (' + DELETE_KEY + ')';
    del.addEventListener('click', function () { deleteDirective(ta, id); });

    var done = document.createElement('div');
    done.className = 'hrv-btn hrv-done';
    done.textContent = 'Done';
    done.title = 'Close the box. Typing saves.';
    done.addEventListener('click', closeBox);

    var row = document.createElement('div');
    row.className = 'hrv-row';
    row.appendChild(hint);
    row.appendChild(del);
    row.appendChild(done);

    box.appendChild(ta);
    box.appendChild(row);
    // Keep keystrokes in the box away from the page's own shortcuts.
    ['keydown', 'keyup', 'keypress'].forEach(function (type) {
      box.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    layer.appendChild(box);
    if (textArea) fit(textArea);
    fit(ta);
    // The box's height changes as its fields grow; placement measures it each time.
    if (window.ResizeObserver) new ResizeObserver(schedulePosition).observe(box);
    positionBox();
    positionCrop(selectedCrop, el);
    positionHover();
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  function label(text) {
    var div = document.createElement('div');
    div.className = 'hrv-label';
    div.textContent = text;
    return div;
  }

  // ---- click handling ----

  // Capture phase on document, so page handlers and link navigation lose.
  document.addEventListener('click', function (e) {
    if (inLayer(e.target) || !reviewing) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var el = targetElement(e.target);
    if (!el) {
      closeBox();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    current = el.getAttribute('data-hrv');
    openBox(current);
  }, true);

  // ---- start ----

  for (var id in directives) syncMarker(id);
  updatePill();
})();
