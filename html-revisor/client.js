// html-revisor client. Directives live in the file on disk; this script edits them through PUT,
// and tells the server when a box closes (Done) through POST. An event stream from the server
// tells it when the file changes, and it catches up (Live notice).
(function () {
  'use strict';

  var directives = {};      // id -> text, the full current set: each element's open turn
  var threads = {};         // id -> [{prefix, text}], the settled turns of each thread with a reply
  var markdowns = {};       // id -> markdown of each scope, as the server last saw it
  var committed = {};       // id -> markdown of each scope at the file's last commit, for Revert
  var edits = {};           // id -> markdown typed for a scope in this tab, not yet answered
  var spills = {};          // id -> {session, ids}: the other elements a box's last save made, which its next save replaces
  var bases = {};           // id -> base: the element's content as the server last saw it
  var markers = {};         // id -> marker element
  var box = null;           // the open directive box, if any
  var boxId = null;         // id of the element the open box is for
  var boxOpened = null;     // what the open box opened with: {session, directive, markdown}; markdown only for a scope
  var boxSent = '';         // the open turn the box opened on: sent, so it shows in the thread, and the field adds to it
  var saveTimer = null;
  var saving = false;       // a PUT is in flight
  var unsent = [];          // changes not yet sent, oldest first: {kind: 'directive'|'markdown'|'done', id}
  var version = null;       // fingerprint of the file as this tab last saw it
  var changedOnDisk = false; // a save found the file changed by someone else
  var inFlight = null;      // the change the PUT in flight carries
  var savedDirectives = {}; // id -> directive text as the file on disk holds it
  var boxBehind = false;    // the file changed the open box's directive; it catches up when the box closes

  try {
    var data = document.getElementById('hrv-directives');
    directives = JSON.parse(data.textContent) || {};
    for (var d0 in directives) savedDirectives[d0] = directives[d0];
    version = data.getAttribute('data-version');
    threads = JSON.parse(document.getElementById('hrv-threads').textContent) || {};
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

  // An open thread: a directive, or turns the agent has answered. Resolve ends it.
  function hasThread(id) {
    return hasText(id) || !!threads[id];
  }

  // A reply is the agent's turn; the prefix names who the words are for.
  var REPLY = '@Human';

  // What was said last on the element: your open turn, or the thread's last turn.
  function lastSaid(id) {
    if (hasText(id)) return { text: directives[id], reply: false };
    var turn = threads[id] && threads[id][threads[id].length - 1];
    return turn ? { text: turn.text, reply: turn.prefix === REPLY } : null;
  }

  // A new reply: the agent spoke last, so it's your turn. It stays new until you add a turn or
  // Resolve; opening the box changes nothing. The file says it, so a reload and every tab agree.
  function isNewReply(id) {
    var said = lastSaid(id);
    return !!said && said.reply;
  }

  // Working: your turn is the last one, and its box is closed, so the agent has it. Every page
  // has an agent today. The file says it; the agent's reply ends it.
  function isWorking(id) {
    return hasText(id) && id !== boxId;
  }

  // Your open turn as the file will hold it: the turn the box opened on, then what the field adds.
  function joinTurn(sent, added) {
    return sent.trim() && added.trim() ? sent + '\n' + added : sent.trim() ? sent : added;
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

  // Our own tooltip, in the material: what was said last, beside the marker under the pointer.
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
    var said = tipId && lastSaid(tipId);
    if (!marker || marker.style.display === 'none' || !said) { hideTip(); return; }
    tip.textContent = said.text;
    tip.className = 'hrv-tip' + (said.reply ? ' hrv-tip-reply' : '');
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

  // The box is 320px wide and its fields grow to 240px, until you drag the grip in its corner:
  // across for width, down for field height. Content then holds that height even when short.
  // The dragged size holds for every box, across reloads; a double-click on the grip goes back.
  var BOX_WIDTH = 320, FIELD_MAX = 240;
  var SIZE_KEY = 'hrv-box-size';
  var boxSize = readBoxSize();

  function readBoxSize() {
    try { return JSON.parse(localStorage.getItem(SIZE_KEY)) || null; } catch (e) { return null; }
  }

  function saveBoxSize() {
    try {
      if (boxSize) localStorage.setItem(SIZE_KEY, JSON.stringify(boxSize));
      else localStorage.removeItem(SIZE_KEY);
    } catch (e) { /* storage off: the size holds for this tab only */ }
  }

  function applyBoxSize() {
    if (!box) return;
    box.classList.toggle('hrv-sized', !!boxSize);
    box.style.setProperty('--hrv-field-max', (boxSize ? boxSize.field : FIELD_MAX) + 'px');
    box.querySelectorAll('textarea').forEach(fit);
    positionBox();
  }

  function grip() {
    var g = document.createElement('span');
    g.className = 'hrv-grip';
    g.title = 'Drag to resize the box. Double-click for the usual size.';
    var start = null;
    g.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      var field = boxSize ? boxSize.field : FIELD_MAX;
      start = { x: e.clientX, y: e.clientY, width: box.offsetWidth, field: field };
    });
    g.addEventListener('pointermove', function (e) {
      if (!start) return;
      var vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight;
      boxSize = {
        width: Math.round(clamp(start.width + e.clientX - start.x, 240, vw - 2 * BOX_MARGIN)),
        field: Math.round(clamp(start.field + e.clientY - start.y, 56, vh * 0.8))
      };
      applyBoxSize();
    });
    function end() {
      if (!start) return;
      start = null;
      saveBoxSize();
    }
    g.addEventListener('pointerup', end);
    g.addEventListener('pointercancel', end);
    g.addEventListener('dblclick', function () {
      boxSize = null;
      saveBoxSize();
      applyBoxSize();
    });
    return g;
  }

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
    var w = Math.min(boxSize ? boxSize.width : BOX_WIDTH, vw - 2 * m);
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

  // Make the marker match the thread: a pencil, or a bubble for a new reply.
  // A marker added or removed can move the others.
  function syncMarker(id) {
    if (hasThread(id)) {
      var marker = markers[id];
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'hrv-marker';
        marker.setAttribute('data-for', id);
        marker.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          hideTip();
          current = id;
          openBox(id);
        });
        marker.addEventListener('mouseenter', function () { showTip(id); });
        marker.addEventListener('mouseleave', hideTip);
        layer.appendChild(marker);
        markers[id] = marker;
      }
      var fresh = isNewReply(id), working = isWorking(id);
      marker.classList.toggle('hrv-answered', fresh);
      marker.classList.toggle('hrv-working', working);
      marker.setAttribute('aria-label', (fresh ? 'New reply: ' : working ? 'Agent working on: ' : '') + lastSaid(id).text);
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
  // The second row counts new replies, threads where the agent spoke last, and steps through
  // them. It shows only when there is one.
  var repliesMain = document.createElement('div');
  repliesMain.className = 'hrv-docket-main hrv-row2';
  var replyIcon = document.createElement('span');
  replyIcon.className = 'hrv-icon-reply';
  var repliesCount = document.createElement('span');
  repliesMain.appendChild(replyIcon);
  repliesMain.appendChild(repliesCount);
  repliesMain.addEventListener('click', function () { setReviewing(!reviewing); });
  docket.appendChild(repliesMain);
  docket.appendChild(stepButton('↑', 'Previous new reply', -1, isNewReply)).classList.add('hrv-row2');
  docket.appendChild(stepButton('↓', 'Next new reply', 1, isNewReply)).classList.add('hrv-row2');
  layer.appendChild(docket);

  function stepButton(arrow, title, dir, only) {
    var b = document.createElement('div');
    b.className = 'hrv-step';
    b.textContent = arrow;
    b.title = title;
    b.addEventListener('click', function () { step(dir, only); });
    return b;
  }

  function newReplyCount() {
    return Object.keys(markers).filter(isNewReply).length;
  }

  function updateDocket() {
    var n = directiveCount(), r = newReplyCount();
    docketCount.textContent = n + (n === 1 ? ' directive' : ' directives') + (reviewing ? '' : ' · review off');
    repliesCount.textContent = r + (r === 1 ? ' new reply' : ' new replies');
    docketMsg.textContent = problem || '';
    docketMain.title = repliesMain.title = reviewing
      ? 'Review mode: click to hide the marks and read the page'
      : 'Review mode is off: click to leave directives again';
    docket.className = 'hrv-docket' + (n === 0 ? ' hrv-none' : '') + (r > 0 ? ' hrv-stacked' : '') +
      (reviewing ? '' : ' hrv-off') + (problem ? ' hrv-error' : '') + (arrived ? ' hrv-arrived' : '');
  }

  // A reply just came: the docket takes a green ring for 2 s, since its element may be off screen.
  var arrived = false;
  var arrivedTimer = null;
  function replyArrived() {
    arrived = true;
    clearTimeout(arrivedTimer);
    arrivedTimer = setTimeout(function () {
      arrived = false;
      updateDocket();
    }, 2000);
    updateDocket();
  }

  var problemIsNotice = false;   // the docket shows a notice, not an error

  function showProblem(text, isNotice) {
    problem = text;
    problemIsNotice = !!(text && isNotice);
    updateDocket();
  }

  // What the docket says when the file changed under the tab: content it can't show without a
  // reload, or a change on disk to the directive in the open box, which shows when the box closes.
  function notice() {
    if (changedOnDisk) return 'the page changed on disk; reload to see it';
    if (boxBehind) return 'this directive changed on disk; close the box to see it';
    return null;
  }

  // A notice takes the docket's message unless an error holds it.
  function showNotice() {
    if (problem && !problemIsNotice) return;
    showProblem(notice(), true);
  }

  // Elements with open threads, in document order; only those that pass only(id), if given.
  function directiveElements(only) {
    var els = [];
    for (var id in markers) {
      var el = elementFor(id);
      if (el && (!only || only(id))) els.push(el);
    }
    return els.sort(function (a, b) { return follows(a, b) ? -1 : 1; });
  }

  function follows(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // Scroll the next (dir 1) or previous (dir -1) directive's element to the middle of the window
  // and show its crop marks for a moment. Its marker's tip shows what it says, until the next click,
  // so you can read through the directives without opening each one. Wraps around at the ends.
  // only narrows the steps, to new replies for the docket's second row.
  function step(dir, only) {
    var els = directiveElements(only);
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

  // ⌥↓ and ⌥↑ step, unless the reader is typing somewhere. Review off, they go to the page,
  // as the docket's arrows hide: there are no marks to step to.
  document.addEventListener('keydown', function (e) {
    if (!reviewing || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
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

  // The docket counts open threads: a directive, or turns the agent answered.
  function directiveCount() {
    return Object.keys(markers).length;
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
    if (change.kind === 'resolve') return span;
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

  // A directive save carries the replies the tab has seen on the element, so the server refuses
  // one typed before a reply came in, instead of writing it again after the reply.
  function bodyFor(change) {
    var body = { id: change.id, base: bases[change.id] || '' };
    if (change.kind === 'resolve') body.resolve = true;
    else body[change.kind] = change.kind === 'markdown' ? edits[change.id] : (directives[change.id] || '');
    if (change.kind === 'directive') body.replies = repliesSeen(change.id);
    var spill = spills[change.id];
    if (change.kind === 'markdown' && spill && spill.session === change.session) body.spill = spill.ids;
    return body;
  }

  function repliesSeen(id) {
    return (threads[id] || []).filter(function (t) { return t.prefix === REPLY; }).length;
  }

  // A markdown save answers with the HTML that replaced the scope. The page takes it, and the
  // markdown of the scopes around it. Elements the edit deleted take their directives with them.
  // If the scope's own element went (a list typed into a paragraph), its ID moves to the one
  // that holds it now, and so do its directive, the box, and changes not yet sent.
  // A save can make elements beside the scope's own (a <p> typed in a paragraph splits it): the
  // box's next save replaces them too, so the page takes its HTML in place of all of them.
  function applyScope(id, data, session, sent) {
    var el = elementFor(id);
    var focused = el && el.contains(document.activeElement);
    if (el) replaceRun([el].concat((sent || []).map(elementFor).filter(Boolean)), fragmentFor(el, data.html));
    for (var k in data.markdowns) markdowns[k] = data.markdowns[k];
    if (data.id && data.id !== id) moveId(id, data.id);
    if (focused) returnFocus(elementFor(data.id || id));   // focus came back here on close
    delete spills[id];
    if (data.id && data.spill && data.spill.length) spills[data.id] = { session: session, ids: data.spill };
    for (var d in markers) {
      if (!elementFor(d)) {
        delete directives[d];
        delete threads[d];
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

  // The fragment goes where the first of the elements was; they and everything between them go.
  function replaceRun(els, fragment) {
    var first = els[0], last = els[0];
    els.forEach(function (e) {
      if (e.parentNode !== first.parentNode) return;
      if (first.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING) first = e;
      if (last.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) last = e;
    });
    while (first !== last && first.nextSibling && first.nextSibling !== last) first.parentNode.removeChild(first.nextSibling);
    if (first !== last) last.remove();
    first.replaceWith(fragment);
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
    if (threads[from] && !threads[to]) threads[to] = threads[from];
    delete directives[from];
    delete threads[from];
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
    if (change.kind === 'refresh') return refresh(change);
    var failed = false;
    var fromBox = !!box;   // a save made while a box is open reports in the box
    inFlight = change;
    change.span = startSave(change);
    var put = startSpan('PUT', change.span, { 'hrv.queued': unsent.length }, 'client');
    var apply = null;
    var headers = { 'Content-Type': 'application/json' };
    if (put) headers.traceparent = '00-' + put.traceId + '-' + put.spanId + '-01';
    var body = bodyFor(change);
    fetch(location.pathname, {
      method: 'PUT',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (res) {
      if (put) put.attributes['http.response.status_code'] = res.status;
      endSpan(put);
      apply = startSpan('apply', change.span);
      if (res.ok || res.status === 412) return res.json();
      return res.text().then(function (t) {
        throw new Error(t || ('HTTP ' + res.status));
      });
    }).then(function (data) {
      if (!data.ok && typeof data.replies === 'number') {
        // A reply came in before this turn landed: catch up first, then send what's left of it.
        unsent.unshift({ kind: 'refresh', target: null, retry: { id: change.id, text: body.directive } });
        return;
      }
      if (!data.ok) {
        // A conflict: we weren't taking turns. Say so; the reload is up to the human.
        failed = 'conflict: ' + data.error;
        boxStatus('not saved');
        showProblem('not saved: ' + data.error + '. Copy what you wrote, then reload to see the page as it is now');
        return;
      }
      for (var id in data.bases) bases[id] = data.bases[id];
      if (change.kind === 'directive') savedDirectives[change.id] = body.directive;
      if (change.kind === 'resolve') savedDirectives[change.id] = '';
      if (change.kind === 'markdown') applyScope(change.id, data, change.session, body.spill);
      if (change.span && typeof data.html === 'string') {
        change.span.attributes['hrv.html.after'] = capped(data.html);
        change.span.attributes['hrv.html.after.length'] = data.html.length;
      }
      // The file changed since this tab last saw it: catch up on what else changed.
      if (data.before !== version) addRefresh(null);
      version = data.after;
      showProblem(notice(), true);
      // A newer edit, waiting or queued, keeps the box at "saving…".
      // A catch-up waiting is no save: the notice of this very save queues one.
      if (fromBox && box && !saveTimer && !unsent.some(function (c) { return c.kind !== 'refresh'; })) boxStatus('saved');
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

  // ---- live notice ----

  // The server tells the tab of every change to the file: the tab's saves and other tabs',
  // the agent's replies, and edits that go around the server. Each notice names the file's
  // version after it; a version the tab holds already, its own save's, is no news. Otherwise
  // the tab fetches the page's state and catches up. The fetch takes its turn in the queue of
  // saves, so the state it reads includes the tab's saves before it, and an answer to one of them
  // can't land on top of it.
  function listen() {
    if (!window.EventSource) return;
    var events = new EventSource(location.pathname);
    events.addEventListener('change', function (e) {
      var heard;
      try { heard = JSON.parse(e.data); } catch (err) { return; }
      if (heard.version === version) return;
      addRefresh(heard.version);
      if (!saving && !saveTimer) saveNow();
    });
  }

  // Queue a catch-up to the version named, or to whatever the file holds when version is null.
  // One waits at a time, aimed at the newest.
  function addRefresh(target) {
    for (var i = 0; i < unsent.length; i++) {
      if (unsent[i].kind === 'refresh') {
        if (unsent[i].target !== null) unsent[i].target = target;
        return;
      }
    }
    unsent.push({ kind: 'refresh', target: target });
  }

  function refresh(change) {
    if (change.target !== null && change.target === version) {
      saving = false;
      return saveNow();
    }
    var span = startSpan('refresh', null, { 'hrv.version.before': version || '', 'hrv.version.target': change.target || '' }, 'client');
    var headers = { Accept: 'application/json' };
    if (span) headers.traceparent = '00-' + span.traceId + '-' + span.spanId + '-01';
    var failed = false;
    fetch(location.pathname, { headers: headers, cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (state) {
      var caught = applyState(state, change.retry);
      if (span) {
        span.attributes['hrv.changed'] = caught.changed;
        span.attributes['hrv.updated'] = caught.updated;
      }
    }).catch(function (err) {
      // The next notice, or the next save's answer, tries again.
      failed = 'refresh failed: ' + (err && err.message ? err.message : err);
    }).then(function () {
      endSpan(span, failed);
      saving = false;
      saveNow();
    });
  }

  // A change for id waits to go out: the state from the server doesn't have it yet.
  function waiting(id) {
    return unsent.some(function (c) { return c.id === id && c.kind !== 'done'; });
  }

  // Take the file's threads, so markers and the docket match it: a reply turns its marker to the
  // bubble, a directive the agent removed takes its marker away. A thread that changed under
  // the open box shows in the box, and the field keeps what you typed past what the file had
  // (turnInBox). The box's directive changed on disk waits until the box closes, so nothing
  // changes under the user's typing, and so does an element with a change of the tab's waiting
  // to go out. Content the tab can't show (an element whose base changed) keeps its old base,
  // so a save there is refused, and the docket says to reload. retry is a turn the server
  // refused because a reply came in first: {id, text}.
  function applyState(state, retry) {
    var ids = {}, updated = 0, later = false, came = false;
    [directives, threads, state.directives, state.threads].forEach(function (m) {
      for (var k in m) ids[k] = true;
    });
    for (var id in ids) {
      var there = !!elementFor(id);   // an element new to the file shows after a reload
      var directive = there ? state.directives[id] : undefined;
      var thread = there ? state.threads[id] : undefined;
      var threadNow = JSON.stringify(thread || null) !== JSON.stringify(threads[id] || null);
      if (thread && extendsThread(thread, threads[id] || []) && (id === boxId || !waiting(id))) came = true;
      if (id === boxId) {
        if (threadNow) {
          turnInBox(thread, directive || '');
          updated++;
        } else if ((directive || '') !== (savedDirectives[id] || '')) boxBehind = true;
        continue;
      }
      var retried = retry && retry.id === id;
      if (!retried && !threadNow && (directive || '') === (directives[id] || '')) continue;
      if (waiting(id)) { later = true; continue; }
      var left = retried ? pastSent(retry.text, savedDirectives[id] || '') : '';
      if (directive) directives[id] = directive;
      else delete directives[id];
      savedDirectives[id] = directive || '';
      if (thread) threads[id] = thread;
      else delete threads[id];
      if (retried) sendLeft(id, left, directive || '');
      syncMarker(id);
      updated++;
    }
    var changed = Array.prototype.some.call(document.querySelectorAll('[data-hrv]'), function (el) {
      var k = el.getAttribute('data-hrv');
      return !inLayer(el) && state.bases[k] !== bases[k];
    });
    if (changed) changedOnDisk = true;
    version = state.version;
    if (later) addRefresh(null);
    if (came) replyArrived();
    updateDocket();
    showNotice();
    return { changed: changed, updated: updated };
  }

  // The thread changed under the open box. It shows in the box. A reply after the turns the file
  // held settles them: they go up into the thread, and the field keeps what you typed past them,
  // to send as your next turn. Done then tells what you added since the reply.
  function turnInBox(thread, directive) {
    var ta = box.querySelector('textarea.hrv-directive');
    var grew = !!thread && extendsThread(thread, threads[boxId] || []);
    if (thread) threads[boxId] = thread;
    else delete threads[boxId];
    if (grew) {
      var left = pastSent(joinTurn(boxSent, ta.value), savedDirectives[boxId] || '');
      savedDirectives[boxId] = directive;
      boxOpened.directive = directive;
      boxSent = directive;
      if (left !== ta.value) {
        ta.value = left;
        fit(ta);
      }
      setDirective(boxId, joinTurn(boxSent, left));
      if (left.trim()) scheduleSave('directive', boxId);
    }
    box.hrvSyncActions();
    box.hrvShowThread();
    syncMarker(boxId);
  }

  function extendsThread(now, before) {
    return now.length > before.length && JSON.stringify(now.slice(0, before.length)) === JSON.stringify(before);
  }

  // What you typed past the turn the file held, sent: that turn is settled now, under a reply.
  function pastSent(typed, sent) {
    var s = sent.replace(/\s+$/, '');
    if (!s) return typed;
    if (typed.trim() === s.trim()) return '';
    if (typed.indexOf(s) === 0) return typed.slice(s.length).replace(/^\s+/, '');
    return typed;
  }

  // A closed box's turn the server refused, because a reply came first: what's left of it goes
  // out next, ahead of the box's Done, and Done tells what's new since the reply.
  function sendLeft(id, left, now) {
    var session = null;
    unsent.forEach(function (c) {
      if (c.kind !== 'done' || c.id !== id) return;
      c.opened.directive = now;
      session = c.opened.session;
    });
    if (!left.trim()) return;
    directives[id] = left;
    var t = clock();
    unsent.unshift({ kind: 'directive', id: id, session: session, edits: 1, firstEdit: t, lastEdit: t });
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
    setDirective(boxId, joinTurn(boxSent, ta.value));
    var span = startSpan('done', null, {
      'hrv.box.session': boxOpened.session, 'hrv.scope.id': id, 'hrv.close.by': by, 'hrv.queued': unsent.length
    }, 'client');
    unsent.push({ kind: 'done', id: id, opened: boxOpened, span: span });
    dropBox();
    if (by === 'done' || by === 'key' || by === 'resolve') returnFocus(elementFor(id));
    syncMarker(id);   // closed, a turn of yours is the agent's to work on
    // The file changed this directive while the box was open: catch up, after the box's saves.
    if (boxBehind) {
      boxBehind = false;
      addRefresh(null);
    }
    saveNow();
    if (inFlight) addEvent(inFlight.span, 'close box', { 'hrv.close.by': by, 'hrv.scope.id': id, 'hrv.pending': unsent.length });
  }

  // Focus goes back to the element the box was for, as a dialog gives it back to what opened it,
  // so Tab goes on from there. An element that can't take focus (a p, a section) holds
  // tabindex=-1 until focus leaves it, so the page keeps no mark.
  function returnFocus(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    if (document.activeElement === el) return;
    el.setAttribute('tabindex', '-1');
    el.addEventListener('blur', function drop() {
      el.removeAttribute('tabindex');
      el.removeEventListener('blur', drop);
    });
    el.focus({ preventScroll: true });
  }

  // Close the box without committing: its element is gone, and its directive with it.
  function dropBox() {
    clearTimeout(statusTimer);
    box.remove();
    box = null;
    boxId = null;
    boxOpened = null;
    boxSent = '';
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

  // The turns, one block each: who said it, then what. A turn {working: true} is the agent's
  // while it works: three green squares and the word.
  function threadView(turns) {
    var view = document.createElement('div');
    view.className = 'hrv-thread';
    turns.forEach(function (turn) {
      var agent = turn.working || turn.prefix === REPLY;
      var div = document.createElement('div');
      div.className = 'hrv-turn' + (agent ? ' hrv-agent' : '');
      var who = document.createElement('span');
      who.className = 'hrv-who';
      who.textContent = agent ? 'agent' : 'you';
      var says = document.createElement('span');
      says.className = 'hrv-says';
      if (turn.working) {
        var dots = document.createElement('span');
        dots.className = 'hrv-dots';
        says.appendChild(dots);
        says.appendChild(document.createTextNode('working'));
      } else says.textContent = turn.text;
      div.appendChild(who);
      div.appendChild(says);
      view.appendChild(div);
    });
    return view;
  }

  // Resolve: the thread ends, directive and replies, and the box closes. It goes out after the
  // box's other changes.
  function resolveThread(ta) {
    var id = boxId;
    ta.value = '';
    boxSent = '';
    delete threads[id];
    addUnsent('resolve', id, boxOpened.session);
    closeBox('resolve');
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
    boxSent = directives[id] || '';
    boxOpened = { session: randomHex(8), directive: boxSent };
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
    var headIcon = icon();
    head.appendChild(headIcon);
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

    // Once the agent has replied, the thread shows above your field, and what you type is your
    // next turn. The turns before it stay as written. Until then, the field is the directive.
    // A reply that comes in while the box is open joins the thread here (showThread).
    // A turn of yours the box opens on was sent when its box closed: it shows in the thread, the
    // agent's working on it, and the field adds a turn after it.
    var thread = null;
    var ta = document.createElement('textarea');
    ta.className = 'hrv-directive';
    ta.addEventListener('input', function () {
      fit(ta);
      schedulePosition();
      syncActions();
      setDirective(boxId, joinTurn(boxSent, ta.value));
      scheduleSave('directive', boxId);
    });
    var clearButton = fieldAction('Clear', '', function () {
      clearDirective(ta);
    });
    var fieldLabel = label('Directive', clearButton);
    box.appendChild(fieldLabel);
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
    var resolve = button();
    resolve.className = 'hrv-btn';
    resolve.textContent = 'Resolve';
    resolve.title = 'End the thread: remove the directive and its replies';
    resolve.addEventListener('click', function () { resolveThread(ta); });
    row.appendChild(done);

    // The thread as the tab holds it now: its turns above your field, your sent turn and the
    // agent working on it, the field's words, and Resolve beside Done. Scrolled to the end,
    // where the newest turn is. While the agent works, the box's icon is its three squares.
    function showThread() {
      var turns = (threads[boxId] || []).slice();
      if (boxSent.trim()) turns.push({ prefix: 'you', text: boxSent }, { working: true });
      var view = turns.length ? threadView(turns) : null;
      headIcon.classList.toggle('hrv-icon-working', !!boxSent.trim());
      if (thread) thread.remove();
      thread = view;
      if (view) box.insertBefore(view, fieldLabel);
      fieldLabel.firstChild.textContent = view ? 'You' : 'Directive';
      ta.setAttribute('aria-label', view ? 'Your turn' : 'Directive');
      ta.placeholder = view ? 'Add to the thread' : 'Directive for this element';
      clearButton.title = (view ? "Empty the turn you haven't sent" : 'Clear the directive') + ' (' + CLEAR_KEY + ')';
      if (view && !resolve.parentNode) row.insertBefore(resolve, done);
      if (!view && resolve.parentNode) resolve.remove();
      if (view) view.scrollTop = view.scrollHeight;
      schedulePosition();
    }
    box.hrvShowThread = showThread;
    showThread();

    box.appendChild(ta);
    box.appendChild(row);
    box.appendChild(grip());
    // Keep keystrokes in the box away from the page's own shortcuts.
    ['keydown', 'keyup', 'keypress'].forEach(function (type) {
      box.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    layer.appendChild(box);
    applyBoxSize();
    if (thread) thread.scrollTop = thread.scrollHeight;
    syncMarker(id);   // open, the marker is the pencil: you're writing
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
  // Directive (You, in a thread), Resolve in a thread, Done, and wrap at the ends. Esc is the way out. A hidden action takes no stop.
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
  for (var t in threads) syncMarker(t);
  updateDocket();
  listen();
})();
