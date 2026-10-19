// html-revisor client. Directives live in the file on disk; this script edits them through PUT,
// and tells the server when a box closes (Done) through POST.
(function () {
  'use strict';

  var directives = {};      // id -> text, the full current set
  var markdowns = {};       // id -> markdown of each scope, as the server last saw it
  var committed = {};       // id -> markdown of each scope at the file's last commit, for Revert
  var edits = {};           // id -> markdown typed for a scope in this tab, not yet answered
  var bases = {};           // id -> base: the element's content as the server last saw it
  var markers = {};         // id -> marker element
  var box = null;           // the open directive box, if any
  var boxId = null;         // id of the element the open box is for
  var boxOpened = null;     // what the open box opened with: {session, directive, markdown}; markdown only for a scope
  var saveTimer = null;
  var saving = false;       // a PUT is in flight
  var unsent = [];          // changes not yet sent, oldest first: {kind: 'directive'|'markdown'|'done', id}
  var version = null;       // fingerprint of the file as this tab last saw it
  var changedOnDisk = false; // a save found the file changed by someone else
  var inFlight = null;      // the change the PUT in flight carries
  var savedDirectives = {}; // id -> directive text as the file on disk holds it, for telemetry

  try {
    var data = document.getElementById('hrv-directives');
    directives = JSON.parse(data.textContent) || {};
    for (var d0 in directives) savedDirectives[d0] = directives[d0];
    version = data.getAttribute('data-version');
    bases = JSON.parse(document.getElementById('hrv-bases').textContent) || {};
    markdowns = JSON.parse(document.getElementById('hrv-markdown').textContent) || {};
    committed = JSON.parse(document.getElementById('hrv-committed').textContent) || {};
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

  var SPACE = /[ \t\n\r\f]+/g;   // the whitespace HTML collapses; not U+00A0

  // A scope edits as markdown; the server sent the markdown of each one.
  function isScope(id) {
    return typeof markdowns[id] === 'string';
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
  var flashed = null;       // the element the docket just stepped to; its marks show for a moment
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

  // Each marker sits outside its element's box and flush against it: it never covers what it
  // marks, and a gap would make it read as a neighbor's. It covers the crop mark at that corner.
  // Its pencil tip points down-right at the element. The first choice is the left side,
  // top-aligned with the element's first line; with no room there, above the top-left corner.
  // A marker that would land on one already placed steps outward, further left or further up.
  // Inner elements go first, so a section and its first paragraph show two markers side by side.
  var TILE = 20, STEP = TILE + 2;

  function overlaps(a, b) {
    return a.x < b.x + TILE && b.x < a.x + TILE && a.y < b.y + TILE && b.y < a.y + TILE;
  }

  function markerSpot(rect, placed) {
    var x = rect.left + window.scrollX, y = rect.top + window.scrollY;
    var spot = { x: x - TILE, y: y };
    var dx = -STEP, dy = 0;
    if (spot.x < 2) {
      spot = { x: Math.max(2, x - TILE / 2), y: y - TILE };
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

  // A tip from stepping stays until the next click.
  document.addEventListener('mousedown', hideTip, true);

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

  // ---- the docket ----

  // Bottom right of the window. It counts the directives, steps through them in document order,
  // and holds a save error or the stale-file warning. Its icon and count switch review mode.
  var current = null;       // id of the element last stepped to or clicked
  var problem = null;       // the save error or stale warning the docket shows, if any
  var flashTimer = null;

  var docket = document.createElement('div');
  docket.className = 'hrv-docket';
  var docketMsg = document.createElement('div');
  docketMsg.className = 'hrv-docket-msg';
  var docketMain = document.createElement('div');
  docketMain.className = 'hrv-docket-main';
  var docketCount = document.createElement('span');
  docketMain.appendChild(icon());
  docketMain.appendChild(docketCount);
  docketMain.addEventListener('click', function () { setReviewing(!reviewing); });
  docket.appendChild(docketMsg);
  docket.appendChild(docketMain);
  docket.appendChild(stepButton('↑', 'Previous directive (⌥↑)', -1));
  docket.appendChild(stepButton('↓', 'Next directive (⌥↓)', 1));
  layer.appendChild(docket);

  function stepButton(arrow, title, dir) {
    var b = document.createElement('div');
    b.className = 'hrv-step';
    b.textContent = arrow;
    b.title = title;
    b.addEventListener('click', function () { step(dir); });
    return b;
  }

  function updateDocket() {
    var n = directiveCount();
    docketCount.textContent = n + (n === 1 ? ' directive' : ' directives') + (reviewing ? '' : ' · review off');
    docketMsg.textContent = problem || '';
    docketMain.title = reviewing
      ? 'Review mode: click to hide the marks and read the page'
      : 'Review mode is off: click to leave directives again';
    docket.className = 'hrv-docket' + (n === 0 ? ' hrv-none' : '') + (reviewing ? '' : ' hrv-off') +
      (problem ? ' hrv-error' : '');
  }

  function showProblem(text) {
    problem = text;
    updateDocket();
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
  // and show its crop marks for a moment. Its marker's tip shows what it says, until the next click,
  // so you can read through the directives without opening each one. Wraps around at the ends.
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
    closeBox('step');
    current = target.getAttribute('data-hrv');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashed = target;
    positionHover();
    showTip(current);
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
    if (!on) closeBox('review off');
    if (on) document.documentElement.removeAttribute('data-hrv-review');
    else document.documentElement.setAttribute('data-hrv-review', 'off');
    layer.classList.toggle('hrv-reading', !on);
    positionHover();
    updateDocket();
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

  // ---- telemetry ----

  // When the server has telemetry on, the client records spans for its saves and posts them to
  // the server, which sends them on with its own. No SDK: a span is a plain object, and the
  // server makes an OTel span with the same IDs and times. Off, startSpan returns null and
  // nothing is recorded.
  var tracing = !!document.querySelector('#hrv-directives[data-telemetry]');
  var finished = [];        // ended spans, not yet posted
  var flushTimer = null;

  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  function clock() { return performance.timeOrigin + performance.now(); }

  // A span without a parent starts a trace. kind 'client' marks a span that a server span continues.
  function startSpan(name, parent, attributes, kind) {
    if (!tracing) return null;
    return {
      name: name, kind: kind,
      traceId: parent ? parent.traceId : randomHex(16), spanId: randomHex(8),
      parentSpanId: parent ? parent.spanId : undefined,
      start: clock(), attributes: attributes || {}, events: []
    };
  }

  // A moment in a span. Honeycomb draws it as a dot on the span's bar.
  function addEvent(span, name, attributes) {
    if (span && !span.end) span.events.push({ name: name, time: clock(), attributes: attributes || {} });
  }

  // Honeycomb caps a string attribute at 64 KB; the length attribute beside it keeps the full count.
  function capped(s) { return s.length > 50000 ? s.slice(0, 50000) : s; }

  // Ending a span twice keeps the first end.
  function endSpan(span, error) {
    if (!span || span.end) return;
    span.end = clock();
    if (error) span.error = String(error);
    finished.push(span);
    if (!flushTimer) flushTimer = setTimeout(flushSpans, 2000);
  }

  function flushSpans() {
    clearTimeout(flushTimer);
    flushTimer = null;
    if (finished.length === 0) return;
    var body = JSON.stringify(finished);
    finished = [];
    navigator.sendBeacon('/.hrv/spans', new Blob([body], { type: 'application/json' }));
  }
  // A tab going away may not fire pagehide; hidden is the last moment it reliably sees.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flushSpans();
  });
  window.addEventListener('pagehide', flushSpans);

  // ---- saving ----

  function directiveCount() {
    var n = 0;
    for (var id in directives) if (hasText(id)) n++;
    return n;
  }

  // Mark a change to send. A change already waiting sends the latest value, once. Each change
  // is a trace, from when it goes out until its answer is applied; the edits before that are times.
  // session names the box it came from.
  function addUnsent(kind, id, session) {
    var now = clock();
    for (var i = 0; i < unsent.length; i++) {
      if (unsent[i].kind === kind && unsent[i].id === id) {
        unsent[i].lastEdit = now;
        return unsent[i].edits++;
      }
    }
    unsent.push({ kind: kind, id: id, session: session, edits: 1, firstEdit: now, lastEdit: now });
  }

  // The span for a change going out: how long it waited, and the scope's content before and after.
  function startSave(change) {
    var span = startSpan('save ' + change.kind, null, { 'hrv.change.kind': change.kind, 'hrv.scope.id': change.id });
    if (!span) return null;
    var a = span.attributes, el = elementFor(change.id);
    a['hrv.box.session'] = change.session;
    a['hrv.edits'] = change.edits;
    a['hrv.wait.ms'] = span.start - change.firstEdit;
    a['hrv.quiet.ms'] = span.start - change.lastEdit;
    if (el) {
      a['hrv.element'] = el.localName;
      a['hrv.html.before'] = capped(el.outerHTML);
      a['hrv.html.before.length'] = el.outerHTML.length;
    }
    var markdown = change.kind === 'markdown';
    var before = (markdown ? markdowns[change.id] : savedDirectives[change.id]) || '';
    var after = (markdown ? edits[change.id] : directives[change.id]) || '';
    a['hrv.' + change.kind + '.before'] = capped(before);
    a['hrv.' + change.kind + '.before.length'] = before.length;
    a['hrv.' + change.kind + '.after'] = capped(after);
    a['hrv.' + change.kind + '.after.length'] = after.length;
    // The scope's directive once this save lands, so every save shows what was asked of the scope.
    a['hrv.directive'] = capped(markdown ? savedDirectives[change.id] || '' : after);
    return span;
  }

  function bodyFor(change) {
    var body = { id: change.id, base: bases[change.id] || '' };
    body[change.kind] = change.kind === 'markdown' ? edits[change.id] : (directives[change.id] || '');
    return body;
  }

  // A markdown save answers with the HTML that replaced the scope. The page takes it, and the
  // markdown of the scopes around it. Elements the edit deleted take their directives with them.
  // If the scope's own element went (a list typed into a paragraph), its ID moves to the one
  // that holds it now, and so do its directive, the box, and changes not yet sent.
  function applyScope(id, data) {
    var el = elementFor(id);
    if (el) el.replaceWith(fragmentFor(el, data.html));
    for (var k in data.markdowns) markdowns[k] = data.markdowns[k];
    if (data.id && data.id !== id) moveId(id, data.id);
    for (var d in directives) {
      if (!elementFor(d)) {
        delete directives[d];
        syncMarker(d);
      }
    }
    if (box && !elementFor(boxId)) dropBox();
    else if (box) {
      box.querySelector('.hrv-what').textContent = describe(elementFor(boxId));
      box.hrvSyncActions();   // a scope that moved to a new ID has no commit to revert to
    }
    updateDocket();
    schedulePosition();
  }

  // A template parses as HTML, where an SVG <text> is an unknown element that doesn't draw.
  // Inside an SVG, parse in the parent's context so new elements land in its namespace.
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function fragmentFor(el, html) {
    var parent = el.parentNode;
    if (parent && parent.namespaceURI === SVG_NS) {
      var range = document.createRange();
      range.selectNode(el);
      return range.createContextualFragment(html);
    }
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content;
  }

  function moveId(from, to) {
    if (hasText(from) && !hasText(to)) directives[to] = directives[from];
    delete directives[from];
    syncMarker(from);
    syncMarker(to);
    if (from in edits) edits[to] = edits[from];
    delete edits[from];
    unsent.forEach(function (c) { if (c.id === from) c.id = to; });
    if (boxId === from) boxId = to;
    if (current === from) current = to;
  }

  // One PUT at a time, one change per PUT. When a PUT ends, the next change goes out.
  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (saving || unsent.length === 0) return;
    saving = true;
    var change = unsent.shift();
    if (change.kind === 'done') return sendDone(change);
    var failed = false;
    var fromBox = !!box;   // a save made while a box is open reports in the box
    inFlight = change;
    change.span = startSave(change);
    var put = startSpan('PUT', change.span, { 'hrv.queued': unsent.length }, 'client');
    var apply = null;
    var headers = { 'Content-Type': 'application/json' };
    if (put) headers.traceparent = '00-' + put.traceId + '-' + put.spanId + '-01';
    fetch(location.pathname, {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(bodyFor(change))
    }).then(function (res) {
      if (put) put.attributes['http.response.status_code'] = res.status;
      endSpan(put);
      apply = startSpan('apply', change.span);
      if (res.ok || res.status === 412) return res.json();
      return res.text().then(function (t) {
        throw new Error(t || ('HTTP ' + res.status));
      });
    }).then(function (data) {
      if (!data.ok) {
        // A conflict: we weren't taking turns. Say so; the reload is up to the human.
        failed = 'conflict: ' + data.error;
        boxStatus('not saved');
        showProblem('not saved: ' + data.error + '. Copy what you wrote, then reload to see the page as it is now');
        return;
      }
      for (var id in data.bases) bases[id] = data.bases[id];
      if (change.kind === 'directive') savedDirectives[change.id] = directives[change.id] || '';
      if (change.kind === 'markdown') applyScope(change.id, data);
      if (change.span && typeof data.html === 'string') {
        change.span.attributes['hrv.html.after'] = capped(data.html);
        change.span.attributes['hrv.html.after.length'] = data.html.length;
      }
      if (data.before !== version) changedOnDisk = true;
      version = data.after;
      showProblem(changedOnDisk ? 'the page changed on disk; reload to see it' : null);
      // A newer edit, waiting or queued, keeps the box at "saving…".
      if (fromBox && box && unsent.length === 0 && !saveTimer) boxStatus('saved');
    }).catch(function (err) {
      failed = 'save failed: ' + (err && err.message ? err.message : err);
      endSpan(put, failed);
      addUnsent(change.kind, change.id, change.session); // a later edit retries it
      boxStatus('');
      showProblem(failed);
    }).then(function () {
      endSpan(apply);
      endSpan(change.span, failed);
      saving = false;
      inFlight = null;
      if (!failed) saveNow();
    });
  }

  // Done: tell the server what the box opened with. It goes out after the box's changes, so the
  // server compares it with what they left in the file, and announces what changed. Its span,
  // started when the box closed, ends with whether the server announced.
  function sendDone(change) {
    var span = change.span;
    var body = { id: change.id, directive: change.opened.directive };
    if (typeof change.opened.markdown === 'string') body.markdown = change.opened.markdown;
    var headers = { 'Content-Type': 'application/json' };
    if (span) headers.traceparent = '00-' + span.traceId + '-' + span.spanId + '-01';
    var failed = false;
    fetch(location.pathname, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (res) {
      if (span) span.attributes['http.response.status_code'] = res.status;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      if (span) span.attributes['hrv.announced'] = !!data.announced;
    }).catch(function (err) {
      // A lost Done is an Announcement not made; the page and the file are fine.
      failed = 'done failed: ' + (err && err.message ? err.message : err);
    }).then(function () {
      endSpan(span, failed);
      saving = false;
      saveNow();
    });
  }

  function scheduleSave(kind, id) {
    addUnsent(kind, id, boxOpened && boxOpened.session);
    boxStatus('saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 400);
  }

  // ---- directive box ----

  var MAC = /Mac|iPhone|iPad/.test(navigator.platform);
  var HINT = (MAC ? '⌘↵' : 'Ctrl+Enter') + ' or esc to close';
  // Clear's hotkey: Option-Command-Backspace (Ctrl+Alt+Backspace elsewhere). In a textarea,
  // ⌘⌫ and ⌥⌫ delete text, and the browser takes ⌘⇧⌫; nothing claims this one.
  var CLEAR_KEY = MAC ? '⌥⌘⌫' : 'Ctrl+Alt+Backspace';
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

  function setDirective(id, text) {
    if (text.trim() === '') delete directives[id];
    else directives[id] = text;
    syncMarker(id);
    updateDocket();
  }

  // Commit and close the open box: Done. by says what closed it, for telemetry: it goes on the
  // done span, and a close while a save is going is an event on that save's span too.
  function closeBox(by) {
    if (!box) return;
    var id = boxId;
    var ta = box.querySelector('textarea.hrv-directive');
    setDirective(boxId, ta.value);
    var span = startSpan('done', null, {
      'hrv.box.session': boxOpened.session, 'hrv.scope.id': id, 'hrv.close.by': by, 'hrv.queued': unsent.length
    }, 'client');
    unsent.push({ kind: 'done', id: id, opened: boxOpened, span: span });
    dropBox();
    saveNow();
    if (inFlight) addEvent(inFlight.span, 'close box', { 'hrv.close.by': by, 'hrv.scope.id': id, 'hrv.pending': unsent.length });
  }

  // Close the box without committing: its element is gone, and its directive with it.
  function dropBox() {
    clearTimeout(statusTimer);
    box.remove();
    box = null;
    boxId = null;
    boxOpened = null;
    positionCrop(selectedCrop, null);
    positionHover();
  }

  // Replace a field's text as if typed: it saves like typing, and the browser's undo takes it back.
  function typeOver(textArea, text) {
    textArea.focus();
    textArea.select();
    var typed = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
    if (!typed) {
      textArea.value = text;
      textArea.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // Empty the directive and leave the box open, so work in the Content field goes on.
  function clearDirective(ta) {
    typeOver(ta, '');
  }

  // Put back the scope's markdown at the last commit.
  function revert(textArea, id) {
    typeOver(textArea, committed[id]);
  }

  function openBox(id) {
    if (box && boxId === id) {
      box.querySelector('textarea.hrv-directive').focus();
      return;
    }
    closeBox('open other');
    var el = elementFor(id);
    if (!el) return;
    boxId = id;
    boxOpened = { session: randomHex(8), directive: directives[id] || '' };
    if (isScope(id)) boxOpened.markdown = markdowns[id];
    box = document.createElement('div');
    box.className = 'hrv-box';
    // A screen reader announces the box as a dialog named for its element, and each field by its label.
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', describe(el));

    var head = document.createElement('div');
    head.className = 'hrv-head';
    var what = document.createElement('span');
    what.className = 'hrv-what';
    what.textContent = describe(el);
    head.appendChild(icon());
    head.appendChild(what);
    box.appendChild(head);

    // A scope gets a field for its markdown above the directive. The page shows each edit when
    // the server answers the save; blank markdown is not applied. A save can give the scope a
    // new ID, so the handlers read boxId, not id.
    // Each field's action sits on its label's line and shows only when it has something to do:
    // Revert when the content differs from the last commit, Clear when there is a directive.
    var textArea = null;
    var revertButton = null;
    if (isScope(id)) {
      textArea = document.createElement('textarea');
      textArea.className = 'hrv-text';
      textArea.setAttribute('aria-label', 'Content');
      textArea.value = markdowns[id];
      textArea.addEventListener('input', function () {
        fit(textArea);
        schedulePosition();
        syncActions();
        if (textArea.value.replace(SPACE, '') === '') return;
        edits[boxId] = textArea.value;
        scheduleSave('markdown', boxId);
      });
      revertButton = fieldAction('Revert', 'Put back the content this had at the last commit', function () {
        revert(textArea, boxId);
      });
      box.appendChild(label('Content', revertButton));
      box.appendChild(textArea);
    }

    var ta = document.createElement('textarea');
    ta.className = 'hrv-directive';
    ta.setAttribute('aria-label', 'Directive');
    ta.value = directives[id] || '';
    ta.placeholder = 'Directive for this element';
    ta.addEventListener('input', function () {
      fit(ta);
      schedulePosition();
      syncActions();
      setDirective(boxId, ta.value);
      scheduleSave('directive', boxId);
    });
    var clearButton = fieldAction('Clear', 'Clear the directive (' + CLEAR_KEY + ')', function () {
      clearDirective(ta);
    });
    box.appendChild(label('Directive', clearButton));
    box.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        closeBox('key');
      } else if (e.key === 'Backspace' && e.altKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        clearDirective(ta);
      } else {
        wrapTab(e);
      }
    });

    function syncActions() {
      if (revertButton) revertButton.hidden = typeof committed[boxId] !== 'string' || textArea.value === committed[boxId];
      clearButton.hidden = ta.value.trim() === '';
    }
    box.hrvSyncActions = syncActions;
    syncActions();

    var hint = document.createElement('div');
    hint.className = 'hrv-hint';
    hint.textContent = HINT;

    var done = button();
    done.className = 'hrv-btn hrv-done';
    done.textContent = 'Done';
    done.title = 'Close the box. Typing saves.';
    done.addEventListener('click', function () { closeBox('done'); });

    var row = document.createElement('div');
    row.className = 'hrv-row';
    row.appendChild(hint);
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

  function label(text, action) {
    var div = document.createElement('div');
    div.className = 'hrv-label';
    div.textContent = text;
    if (action) div.appendChild(action);
    return div;
  }

  function fieldAction(text, title, onClick) {
    var b = button();
    b.className = 'hrv-btn hrv-quiet hrv-field-action';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  // A real button, so Tab stops on it and Enter and Space press it. type=button keeps it from
  // submitting a form on the page.
  function button() {
    var b = document.createElement('button');
    b.type = 'button';
    return b;
  }

  // Tab and Shift-Tab go round the box's fields and buttons in order, Revert, Content, Clear,
  // Directive, Done, and wrap at the ends. Esc is the way out. A hidden action takes no stop.
  function wrapTab(e) {
    if (e.key !== 'Tab' || e.altKey || e.metaKey || e.ctrlKey) return;
    var stops = Array.prototype.filter.call(box.querySelectorAll('textarea, button'), function (s) {
      return !s.hidden;
    });
    var first = stops[0], last = stops[stops.length - 1];
    var at = document.activeElement;
    if (e.shiftKey ? at === first || !box.contains(at) : at === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }

  // ---- click handling ----

  // Capture phase on document, so page handlers and link navigation lose.
  document.addEventListener('click', function (e) {
    if (inLayer(e.target) || !reviewing) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var el = targetElement(e.target);
    if (!el) {
      closeBox('click away');
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    current = el.getAttribute('data-hrv');
    openBox(current);
  }, true);

  // ---- start ----

  for (var id in directives) syncMarker(id);
  updateDocket();
})();
