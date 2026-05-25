'use strict';

const STORAGE_KEY = 'disney-cruise-groups-v1';
const UI_KEY = 'disney-cruise-ui-v1';
const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_COLORS = [
  '#ff6b6b', '#4aa8ff', '#57c8a2', '#c79a4b', '#b673e0',
  '#f4a261', '#e76f51', '#2ec4b6', '#e07a5f', '#81b29a',
];

const state = {
  ship: null,
  decks: [],
  deckById: new Map(),
  // room id (string) -> { deck: number, categories: string[], flags: string[] }
  roomIndex: new Map(),
  // group state
  groups: [],             // [{id, name, color}]
  roomGroups: new Map(),  // roomId -> Set<groupId>
  roomNotes: new Map(),   // roomId -> string (free-text note)
  assigningGroupId: null,
  expandedGroups: new Set(), // group ids currently expanded to show rooms
  // Filter: highlights all rooms matching theme/categoryCode across decks.
  // { kind: 'theme'|'category'|'flag', label, ids: Set<string>, perDeck: Map<deck, count> }
  filter: null,
  currentDeck: null,
  zoom: 1,
};

// ---------- Persistence ----------

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.groups)) state.groups = data.groups;
    if (data.rooms && typeof data.rooms === 'object') {
      state.roomGroups = new Map();
      for (const [roomId, v] of Object.entries(data.rooms)) {
        // Backward compat: old format was string (single group),
        // new format is array of group ids.
        if (typeof v === 'string') state.roomGroups.set(roomId, new Set([v]));
        else if (Array.isArray(v) && v.length > 0) state.roomGroups.set(roomId, new Set(v));
      }
    }
    if (data.notes && typeof data.notes === 'object') {
      state.roomNotes = new Map(Object.entries(data.notes).filter(([, v]) => typeof v === 'string' && v.length > 0));
    }
  } catch (e) {
    console.warn('failed to load saved state', e);
  }
}

function persist() {
  const rooms = {};
  for (const [roomId, set] of state.roomGroups) {
    if (set.size > 0) rooms[roomId] = [...set];
  }
  const notes = {};
  for (const [roomId, text] of state.roomNotes) {
    if (text) notes[roomId] = text;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    groups: state.groups, rooms, notes,
  }));
}

function setRoomNote(roomId, text) {
  const trimmed = (text || '').trim();
  if (trimmed) state.roomNotes.set(roomId, trimmed);
  else state.roomNotes.delete(roomId);
  persist();
}

// ---------- Data load ----------

async function loadRooms() {
  const res = await fetch('rooms.json');
  if (!res.ok) throw new Error(`rooms.json HTTP ${res.status}`);
  const data = await res.json();
  state.ship = data.ship;
  state.decks = data.decks;
  for (const d of state.decks) {
    state.deckById.set(d.deck, d);
    for (const r of d.rooms) {
      state.roomIndex.set(r.id, {
        deck: d.deck,
        categories: r.categories || [],
        flags: r.flags || [],
        shape: r.shape,
        theme: r.theme || null,
        categoryCode: r.categoryCode || null,
      });
    }
  }
}

// ---------- Group operations ----------

function makeGroupId() {
  return 'g' + Math.random().toString(36).slice(2, 9);
}

function addGroup(name = null, color = null) {
  const id = makeGroupId();
  const usedColors = new Set(state.groups.map(g => g.color));
  const c = color || DEFAULT_COLORS.find(c => !usedColors.has(c)) || DEFAULT_COLORS[state.groups.length % DEFAULT_COLORS.length];
  state.groups.push({ id, name: name || `分組 ${state.groups.length + 1}`, color: c });
  persist();
  return id;
}

function renameGroup(id, name) {
  const g = state.groups.find(g => g.id === id);
  if (!g) return;
  g.name = name;
  persist();
  renderBulkGroupSelect();
  renderPopupGroupSelect();
  updateAssignHint();
}

function setGroupColor(id, color) {
  const g = state.groups.find(g => g.id === id);
  if (g) {
    g.color = color;
    persist();
    repaintCurrentDeck();
    renderGroups();
    renderPopupGroupSelect();
    renderBulkGroupSelect();
  }
}

function deleteGroup(id) {
  state.groups = state.groups.filter(g => g.id !== id);
  for (const [roomId, set] of state.roomGroups) {
    if (set.delete(id) && set.size === 0) state.roomGroups.delete(roomId);
  }
  if (state.assigningGroupId === id) state.assigningGroupId = null;
  state.expandedGroups.delete(id);
  persist();
}

function groupById(id) { return state.groups.find(g => g.id === id) || null; }

function roomGroupsOf(roomId) {
  return state.roomGroups.get(roomId) || new Set();
}

function roomHasGroup(roomId, groupId) {
  return state.roomGroups.get(roomId)?.has(groupId) ?? false;
}

function addRoomToGroup(roomId, groupId) {
  if (!state.roomIndex.has(roomId)) return false;
  let set = state.roomGroups.get(roomId);
  if (!set) { set = new Set(); state.roomGroups.set(roomId, set); }
  set.add(groupId);
  persist();
  return true;
}

function removeRoomFromGroup(roomId, groupId) {
  const set = state.roomGroups.get(roomId);
  if (!set) return false;
  set.delete(groupId);
  if (set.size === 0) state.roomGroups.delete(roomId);
  persist();
  return true;
}

function clearRoomGroups(roomId) {
  state.roomGroups.delete(roomId);
  persist();
}

function roomsInGroup(groupId) {
  const out = [];
  for (const [r, set] of state.roomGroups) if (set.has(groupId)) out.push(r);
  return out;
}

// ---------- Deck rendering ----------

function renderDeckList() {
  const sel = document.getElementById('deck-select');
  sel.innerHTML = '';
  for (const d of state.decks) {
    const opt = document.createElement('option');
    opt.value = String(d.deck);
    opt.textContent = `Deck ${d.deck} (${d.rooms.length}間)`;
    sel.appendChild(opt);
  }
  sel.value = String(state.currentDeck);
}

function renderDeckInfo() {
  const d = state.deckById.get(state.currentDeck);
  if (!d) return;
  const cats = {};
  for (const r of d.rooms) for (const c of r.categories) cats[c] = (cats[c] || 0) + 1;
  const summary = Object.entries(cats).map(([k, v]) => `${k} ${v}`).join('  ·  ');
  document.getElementById('deck-info').textContent =
    `${state.ship === 'adventure' ? 'Disney Adventure' : state.ship} · Deck ${d.deck} · ${d.rooms.length} 房間` +
    (summary ? `  ·  ${summary}` : '');
}

function showDeck(deckNum) {
  const d = state.deckById.get(deckNum);
  if (!d) return;
  state.currentDeck = deckNum;
  const stage = document.getElementById('map-stage');
  stage.innerHTML = d.svg;
  renderDeckInfo();
  attachRoomHandlers();
  repaintCurrentDeck();
  applyZoom();
  // Reapply filter highlighting & refresh the chip's per-deck count
  if (state.filter) setFilter(state.filter);
}

function attachRoomHandlers() {
  const stage = document.getElementById('map-stage');
  // Disney's SVG has BOTH the shape (in <g id="room">) and the text label
  // (in <g id="numbers">) sharing the same id base. We bind click on both
  // and dedupe by roomId.
  const els = stage.querySelectorAll('[id^="room-"], [id^="number-"]');
  for (const el of els) {
    const id = el.id;
    const roomId = id.replace(/^(room|number)-/, '');
    if (!state.roomIndex.has(roomId)) continue;
    el.style.cursor = 'pointer';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onRoomClick(roomId, el);
    });
  }
  // Click outside any room closes popup
  stage.addEventListener('click', () => closePopup());
}

function repaintCurrentDeck() {
  const stage = document.getElementById('map-stage');
  if (!stage) return;
  const svg = stage.querySelector('svg');
  if (!svg) return;

  // Drop any pattern <defs> from previous repaint
  svg.querySelector('defs[data-app-defs]')?.remove();

  const neededPatterns = new Map(); // key -> [colors]
  const shapes = stage.querySelectorAll('[id^="room-"]');
  for (const el of shapes) {
    const roomId = el.id.slice('room-'.length);
    const set = state.roomGroups.get(roomId);
    if (!set || set.size === 0) {
      el.classList.remove('grouped');
      el.style.removeProperty('--group-color');
      el.style.removeProperty('fill');
      continue;
    }
    el.classList.add('grouped');
    if (set.size === 1) {
      const [gid] = set;
      const color = groupById(gid)?.color || '#ff6b6b';
      el.style.setProperty('--group-color', color);
      el.style.removeProperty('fill');
    } else {
      const sortedIds = [...set].sort();
      const key = sortedIds.join('_');
      const colors = sortedIds.map(g => groupById(g)?.color || '#ff6b6b');
      neededPatterns.set(key, colors);
      // !important so we beat the .grouped fill rule from CSS
      el.style.setProperty('fill', `url(#pat-${key})`, 'important');
      el.style.setProperty('fill-opacity', '0.95', 'important');
      el.style.removeProperty('--group-color');
    }
  }

  if (neededPatterns.size > 0) {
    const defs = document.createElementNS(SVG_NS, 'defs');
    defs.setAttribute('data-app-defs', '');
    for (const [key, colors] of neededPatterns) {
      defs.appendChild(makeStripePattern(`pat-${key}`, colors));
    }
    svg.insertBefore(defs, svg.firstChild);
  }
}

function makeStripePattern(id, colors) {
  const stripeW = 6;
  const totalW = stripeW * colors.length;
  const pat = document.createElementNS(SVG_NS, 'pattern');
  pat.id = id;
  pat.setAttribute('patternUnits', 'userSpaceOnUse');
  pat.setAttribute('width', String(totalW));
  pat.setAttribute('height', String(totalW));
  pat.setAttribute('patternTransform', 'rotate(45)');
  for (let i = 0; i < colors.length; i++) {
    const r = document.createElementNS(SVG_NS, 'rect');
    r.setAttribute('x', String(i * stripeW));
    r.setAttribute('y', '0');
    r.setAttribute('width', String(stripeW));
    r.setAttribute('height', String(totalW));
    r.setAttribute('fill', colors[i]);
    pat.appendChild(r);
  }
  return pat;
}

// ---------- Groups UI ----------

function renderGroups() {
  const list = document.getElementById('groups-list');
  list.innerHTML = '';
  if (state.groups.length === 0) {
    return; // The big "新增分組" button above is the empty-state CTA.
  }
  for (const g of state.groups) {
    const li = document.createElement('li');
    li.className = 'group-item-wrap';

    const row = document.createElement('div');
    row.className = 'group-item';
    if (state.assigningGroupId === g.id) row.classList.add('assigning');
    row.style.setProperty('--group-color', g.color);

    const paint = document.createElement('button');
    paint.type = 'button';
    paint.className = 'group-paint';
    if (state.assigningGroupId === g.id) paint.classList.add('assigning');
    paint.title = '切換指派模式';
    paint.setAttribute('aria-label', `切換 ${g.name} 指派模式`);
    paint.addEventListener('click', () => toggleAssigning(g.id));

    const name = document.createElement('input');
    name.className = 'group-name';
    name.value = g.name;
    name.addEventListener('change', () => renameGroup(g.id, name.value.trim() || g.name));

    const rooms = roomsInGroup(g.id);
    const expanded = state.expandedGroups.has(g.id);

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'group-expand';
    expand.textContent = (expanded ? '▾ ' : '▸ ') + rooms.length;
    expand.title = expanded ? '收起房間清單' : '展開房間清單';
    expand.disabled = rooms.length === 0;
    expand.addEventListener('click', () => {
      if (state.expandedGroups.has(g.id)) state.expandedGroups.delete(g.id);
      else state.expandedGroups.add(g.id);
      renderGroups();
    });

    const colorBtn = document.createElement('input');
    colorBtn.type = 'color';
    colorBtn.value = g.color;
    colorBtn.title = '改顏色';
    colorBtn.className = 'group-color-input';
    colorBtn.addEventListener('change', () => setGroupColor(g.id, colorBtn.value));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.textContent = '✕';
    delBtn.title = '刪除分組';
    delBtn.addEventListener('click', () => {
      const n = roomsInGroup(g.id).length;
      if (n === 0 || confirm(`刪除「${g.name}」？該組目前有 ${n} 間房，會從此組移除（不影響其他組）。`)) {
        deleteGroup(g.id);
        renderGroups();
        renderBulkGroupSelect();
        renderPopupGroupSelect();
        repaintCurrentDeck();
      }
    });

    const actions = document.createElement('div');
    actions.className = 'group-actions';
    actions.append(colorBtn, delBtn);

    row.append(paint, name, expand, actions);
    li.appendChild(row);

    if (expanded && rooms.length > 0) {
      li.appendChild(renderRoomChips(g.id, rooms));
    }

    list.appendChild(li);
  }
}

function renderRoomChips(groupId, roomIds) {
  // Sort numerically (room ids are numeric strings)
  const sorted = [...roomIds].sort((a, b) => Number(a) - Number(b));
  // Group by deck for readability
  const byDeck = new Map();
  for (const id of sorted) {
    const info = state.roomIndex.get(id);
    const deck = info?.deck ?? '?';
    if (!byDeck.has(deck)) byDeck.set(deck, []);
    byDeck.get(deck).push(id);
  }
  const container = document.createElement('div');
  container.className = 'group-rooms';
  for (const [deck, ids] of [...byDeck.entries()].sort((a, b) => a[0] - b[0])) {
    const deckRow = document.createElement('div');
    deckRow.className = 'group-rooms-deck';
    const label = document.createElement('span');
    label.className = 'group-rooms-deck-label';
    label.textContent = `Deck ${deck}`;
    deckRow.appendChild(label);
    const chipBox = document.createElement('div');
    chipBox.className = 'group-rooms-chips';
    for (const id of ids) {
      const chip = document.createElement('span');
      chip.className = 'room-chip';
      const note = state.roomNotes.get(id);
      if (note) chip.classList.add('has-note');
      chip.tabIndex = 0;
      const info = state.roomIndex.get(id);
      const meta = [info?.categoryCode, info?.theme].filter(Boolean).join(' · ');
      const tipParts = [];
      if (meta) tipParts.push(meta);
      if (note) tipParts.push(`備註：${note}`);
      chip.title = tipParts.length ? tipParts.join('\n') : '點 = 跳到此房；× = 從此組移除';

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'room-chip-label';
      label.textContent = note ? `${id} ✎` : id;
      label.addEventListener('click', () => jumpToRoom(id));

      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'room-chip-remove';
      x.textContent = '✕';
      x.setAttribute('aria-label', `從此組移除 ${id}`);
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        removeRoomFromGroup(id, groupId);
        repaintCurrentDeck();
        renderGroups();
        if (popupRoomId === id) renderPopupGroupCheckboxes(id);
      });

      chip.append(label, x);
      chipBox.appendChild(chip);
    }
    deckRow.appendChild(chipBox);
    container.appendChild(deckRow);
  }
  return container;
}

function jumpToRoom(roomId) {
  const info = state.roomIndex.get(roomId);
  if (!info) return;
  if (info.deck !== state.currentDeck) {
    document.getElementById('deck-select').value = String(info.deck);
    showDeck(info.deck);
  }
  const el = document.getElementById(`room-${roomId}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    openPopup(roomId, el);
  }
}

function toggleAssigning(groupId) {
  state.assigningGroupId = state.assigningGroupId === groupId ? null : groupId;
  renderGroups();
  updateAssignHint();
  // On mobile, close the drawer so the user can immediately tap rooms
  // on the map without dismissing it manually.
  if (state.assigningGroupId && isMobileViewport()) closeSidebar();
}

function updateAssignHint() {
  const hint = document.getElementById('assign-hint');
  if (state.assigningGroupId) {
    const g = groupById(state.assigningGroupId);
    hint.innerHTML = `指派模式：點房間 = 加入「<b>${escapeHtml(g.name)}</b>」（再點 = 移出）。再次點圓點關閉。`;
    hint.style.color = '#e6ecf5';
  } else {
    hint.textContent = '提示：點分組左邊的圓點切換「指派模式」，亮起時點甲板圖上的房間 = 加入該組（再點 = 移出）。';
    hint.style.color = '';
  }
}

function renderBulkGroupSelect() {
  const sel = document.getElementById('bulk-group');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const g of state.groups) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    sel.appendChild(opt);
  }
  if (prev && state.groups.some(g => g.id === prev)) sel.value = prev;
}

function renderPopupGroupSelect() {
  // Multi-group: popup shows checkboxes per-room. Re-render if any open.
  if (popupRoomId) renderPopupGroupCheckboxes(popupRoomId);
}

// ---------- Room click & popup ----------

let popupRoomId = null;

function onRoomClick(roomId, el) {
  if (state.assigningGroupId) {
    if (roomHasGroup(roomId, state.assigningGroupId)) {
      removeRoomFromGroup(roomId, state.assigningGroupId);
    } else {
      addRoomToGroup(roomId, state.assigningGroupId);
    }
    repaintCurrentDeck();
    renderGroups();
    return;
  }
  openPopup(roomId, el);
}

function openPopup(roomId, anchorEl) {
  popupRoomId = roomId;
  const info = state.roomIndex.get(roomId);
  if (!info) return;
  const popup = document.getElementById('popup');
  document.getElementById('popup-title').textContent = `房號 ${roomId}`;
  const body = document.getElementById('popup-body');
  body.innerHTML = '';
  const catLabel = info.categoryCode
    ? `${info.categories.map(translateCategory).join(', ') || '—'}  ·  ${info.categoryCode}`
    : (info.categories.length ? info.categories.map(translateCategory).join(', ') : '—');
  const rows = [
    ['樓層', `Deck ${info.deck}`],
    ['類別', catLabel],
    ['主題', info.theme || '—'],
    ['標籤', info.flags.length ? info.flags.map(translateFlag).join(', ') : '—'],
  ];
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    body.append(dt, dd);
  }
  // Group checkboxes
  renderPopupGroupCheckboxes(roomId);
  // Note textarea
  const noteEl = document.getElementById('popup-note-text');
  noteEl.value = state.roomNotes.get(roomId) || '';

  // Position popup near the clicked element
  popup.hidden = false;
  positionPopup(anchorEl);

  // Mark active
  document.querySelectorAll('.map-stage [id^="room-"].active').forEach(el => el.classList.remove('active'));
  const shape = document.getElementById(`room-${roomId}`);
  if (shape) shape.classList.add('active');
}

function renderPopupGroupCheckboxes(roomId) {
  const container = document.getElementById('popup-groups');
  container.innerHTML = '';
  if (state.groups.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.style.margin = '0';
    p.textContent = '尚未建立分組';
    container.appendChild(p);
    return;
  }
  const current = roomGroupsOf(roomId);
  for (const g of state.groups) {
    const label = document.createElement('label');
    label.className = 'popup-group-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = current.has(g.id);
    cb.addEventListener('change', () => {
      if (cb.checked) addRoomToGroup(roomId, g.id);
      else removeRoomFromGroup(roomId, g.id);
      repaintCurrentDeck();
      renderGroups();
    });
    const dot = document.createElement('span');
    dot.className = 'popup-group-dot';
    dot.style.background = g.color;
    const name = document.createElement('span');
    name.textContent = g.name;
    label.append(cb, dot, name);
    container.appendChild(label);
  }
}

function isMobileViewport() {
  return window.innerWidth <= 900;
}

function positionPopup(anchorEl) {
  const popup = document.getElementById('popup');
  // On mobile the popup is a bottom-sheet anchored via CSS — clear any
  // previous inline left/top so it can't fight the stylesheet.
  if (isMobileViewport()) {
    popup.style.left = '';
    popup.style.top = '';
    return;
  }
  const rect = anchorEl.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  let left = rect.right + 8;
  let top = rect.top;
  if (left + popupRect.width > window.innerWidth - 8) {
    left = Math.max(8, rect.left - popupRect.width - 8);
  }
  if (top + popupRect.height > window.innerHeight - 8) {
    top = Math.max(8, window.innerHeight - popupRect.height - 8);
  }
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

function closePopup() {
  popupRoomId = null;
  document.getElementById('popup').hidden = true;
  document.querySelectorAll('.map-stage [id^="room-"].active').forEach(el => el.classList.remove('active'));
}

function translateCategory(c) {
  return ({ inside: 'Inside 內艙', outside: 'Oceanview 海景', oceanview: 'Oceanview 海景', verandah: 'Verandah 陽台', suite: 'Suite 套房', concierge: 'Concierge' })[c] || c;
}
function translateFlag(f) {
  return ({ 'connecting-rooms': '連通房', 'accessible-rooms': '無障礙', 'navigators-verandah': 'Navigator Verandah' })[f] || f;
}

// ---------- Bulk input ----------

function parseRoomNumbers(text) {
  return text.split(/[\s,，、;\n]+/).map(s => s.trim()).filter(Boolean);
}

function doBulkAssign(remove = false) {
  const text = document.getElementById('bulk-input').value;
  const feedback = document.getElementById('bulk-feedback');
  const groupId = document.getElementById('bulk-group').value;
  feedback.classList.remove('error', 'success');

  if (!groupId) {
    feedback.textContent = '請先選擇目標分組';
    feedback.classList.add('error');
    return;
  }
  const ids = parseRoomNumbers(text);
  if (ids.length === 0) {
    feedback.textContent = '請輸入至少一個房號';
    feedback.classList.add('error');
    return;
  }
  const ok = [];
  const unknown = [];
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!state.roomIndex.has(id)) {
      unknown.push(id);
      continue;
    }
    if (remove) removeRoomFromGroup(id, groupId);
    else addRoomToGroup(id, groupId);
    ok.push(id);
  }
  repaintCurrentDeck();
  renderGroups();
  if (popupRoomId) renderPopupGroupCheckboxes(popupRoomId);

  const gName = groupById(groupId)?.name || '';
  const verb = remove ? `從「${gName}」移除` : `加入「${gName}」`;
  let msg = `已${verb}：${ok.length} 間`;
  if (unknown.length) msg += `\n找不到：${unknown.join(', ')}`;
  feedback.textContent = msg;
  feedback.classList.add(unknown.length ? 'error' : 'success');
}

// ---------- Search ----------

function findRoomsByCategoryCode(code) {
  const ids = new Set();
  for (const [id, info] of state.roomIndex) {
    if (info.categoryCode === code) ids.add(id);
  }
  return ids;
}

function findRoomsByTheme(theme) {
  const ids = new Set();
  for (const [id, info] of state.roomIndex) {
    if (info.theme === theme) ids.add(id);
  }
  return ids;
}

function uniqueThemes() {
  const counts = new Map();
  for (const info of state.roomIndex.values()) {
    if (!info.theme) continue;
    counts.set(info.theme, (counts.get(info.theme) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function uniqueCategoryCodes() {
  const counts = new Map();
  for (const info of state.roomIndex.values()) {
    if (!info.categoryCode) continue;
    counts.set(info.categoryCode, (counts.get(info.categoryCode) || 0) + 1);
  }
  // Sort: leading digit asc (treats codes like "10A" after "9A"), then letter
  return [...counts.entries()].sort((a, b) => {
    const numA = parseInt(a[0], 10);
    const numB = parseInt(b[0], 10);
    return numA - numB || a[0].localeCompare(b[0]);
  });
}

function populateFilterDropdowns() {
  const themeSel = document.getElementById('theme-filter');
  themeSel.innerHTML = '<option value="">（全部主題）</option>';
  for (const [theme, n] of uniqueThemes()) {
    const opt = document.createElement('option');
    opt.value = theme;
    opt.textContent = `${theme} (${n})`;
    themeSel.appendChild(opt);
  }
  const catSel = document.getElementById('category-filter');
  catSel.innerHTML = '<option value="">（全部類別）</option>';
  for (const [code, n] of uniqueCategoryCodes()) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${code} (${n})`;
    catSel.appendChild(opt);
  }
}

function setFilter(filter) {
  state.filter = filter;
  const chip = document.getElementById('filter-chip');
  const text = document.getElementById('filter-chip-text');
  if (!filter) {
    chip.hidden = true;
    text.textContent = '';
  } else {
    chip.hidden = false;
    const perDeck = filter.perDeck.get(state.currentDeck) || 0;
    text.textContent = `${filter.label}：全船 ${filter.ids.size}  ·  此層 ${perDeck}`;
  }
  applyFilterHighlight();
}

function applyFilterHighlight() {
  const stage = document.getElementById('map-stage');
  if (!stage) return;
  stage.querySelectorAll('.search-hit').forEach(el => el.classList.remove('search-hit'));
  if (!state.filter) return;
  for (const id of state.filter.ids) {
    const el = stage.querySelector(`#room-${CSS.escape(id)}`);
    if (el) el.classList.add('search-hit');
  }
}

function computePerDeck(ids) {
  const map = new Map();
  for (const id of ids) {
    const info = state.roomIndex.get(id);
    if (!info) continue;
    map.set(info.deck, (map.get(info.deck) || 0) + 1);
  }
  return map;
}

function doSearch(rawInput) {
  const q = rawInput.trim();
  if (!q) return;
  if (!state.roomIndex.has(q)) {
    showToast(`找不到房號 ${q}`, true);
    return;
  }
  const info = state.roomIndex.get(q);
  if (info.deck !== state.currentDeck) {
    document.getElementById('deck-select').value = String(info.deck);
    showDeck(info.deck);
  }
  const el = document.getElementById(`room-${q}`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    flashSearchJump(el);
  }
}

function flashSearchJump(el) {
  const stage = document.getElementById('map-stage');
  if (stage) {
    stage.querySelectorAll('.search-jump').forEach(e => e.classList.remove('search-jump'));
  }
  // Force reflow so re-adding the class restarts the pulse animation.
  void el.offsetWidth;
  el.classList.add('search-jump');
}

function refreshFilter() {
  const theme = document.getElementById('theme-filter').value;
  const code = document.getElementById('category-filter').value;
  if (!theme && !code) { setFilter(null); return; }

  let ids;
  const parts = [];
  if (theme) parts.push(`主題：${theme}`);
  if (code) parts.push(`類別 ${code}`);

  if (theme && code) {
    const t = findRoomsByTheme(theme);
    const c = findRoomsByCategoryCode(code);
    ids = new Set([...t].filter(x => c.has(x)));
  } else if (theme) {
    ids = findRoomsByTheme(theme);
  } else {
    ids = findRoomsByCategoryCode(code);
  }

  setFilter({
    kind: 'combo',
    label: parts.join(' ∩ '),
    ids,
    perDeck: computePerDeck(ids),
  });
  jumpToFirstMatch(ids);
}

function jumpToFirstMatch(ids) {
  // If current deck has matches, stay; otherwise switch to the deck with the most matches.
  const perDeck = computePerDeck(ids);
  if (!perDeck.get(state.currentDeck)) {
    const best = [...perDeck.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      document.getElementById('deck-select').value = String(best[0]);
      showDeck(best[0]);
    }
  }
  // Scroll first match into view
  const stage = document.getElementById('map-stage');
  for (const id of ids) {
    const info = state.roomIndex.get(id);
    if (info && info.deck === state.currentDeck) {
      const el = stage.querySelector(`#room-${CSS.escape(id)}`);
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); break; }
    }
  }
}

// ---------- Export / Import ----------

// ---------- Zoom ----------

function applyZoom() {
  const svg = document.querySelector('.map-stage svg');
  if (!svg) return;
  svg.style.transform = `scale(${state.zoom})`;
  const input = document.getElementById('zoom-value');
  // Don't clobber the user's keystrokes while they're typing.
  if (input && document.activeElement !== input) {
    input.value = Math.round(state.zoom * 100);
  }
  persistUi();
}

function persistUi() {
  const mapArea = document.querySelector('.map-area');
  const toolbarCollapsed = !!(mapArea && mapArea.classList.contains('toolbar-collapsed'));
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ zoom: state.zoom, toolbarCollapsed }));
  } catch (e) { /* full / unavailable — non-fatal */ }
}

function loadPersistedUi() {
  try {
    const raw = localStorage.getItem(UI_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch (e) { return {}; }
}

function loadPersistedZoom() {
  const z = Number(loadPersistedUi().zoom);
  return (Number.isFinite(z) && z >= 0.1 && z <= 3) ? z : null;
}

function setZoomPercent(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return;
  state.zoom = Math.max(0.1, Math.min(3, n / 100));
  applyZoom();
}

function fitZoom() {
  const scroll = document.getElementById('map-scroll');
  if (!scroll) return;
  // The ship SVG is tall and narrow (588 wide × ~3700 tall). Fit by width
  // so the calculation doesn't depend on layout being fully settled.
  // On desktop we let the ship occupy ~31% of the map area width; on
  // narrow viewports (phones) we let it occupy more so it isn't lost
  // in empty space.
  const SVG_W = 588;
  const w = scroll.clientWidth || window.innerWidth;
  const targetOccupancy = w > 768 ? 0.31 : 0.8;
  const raw = (w * targetOccupancy) / SVG_W;
  state.zoom = Math.max(0.3, Math.min(1.2, raw));
  applyZoom();
}

// ---------- Sidebar drawer (mobile) ----------

function openSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const toggle = document.getElementById('sidebar-toggle');
  if (!sidebar || !backdrop) return;
  sidebar.classList.add('open');
  backdrop.hidden = false;
  // Force reflow so the opacity transition runs.
  void backdrop.offsetWidth;
  backdrop.classList.add('open');
  if (toggle) toggle.setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const toggle = document.getElementById('sidebar-toggle');
  if (!sidebar || !backdrop) return;
  sidebar.classList.remove('open');
  backdrop.classList.remove('open');
  backdrop.hidden = true;
  if (toggle) toggle.setAttribute('aria-expanded', 'false');
}

// ---------- Toast ----------

let toastTimer = null;
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

// ---------- Utils ----------

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Offline / service worker ----------

async function setupOffline() {
  const btn = document.getElementById('offline-btn');
  if (!('serviceWorker' in navigator)) {
    btn.disabled = true;
    btn.textContent = '此瀏覽器不支援離線';
    btn.title = '請改用 Chrome / Safari / Edge';
    return;
  }
  // Service workers require HTTPS (or localhost). On file:// they no-op.
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
    btn.disabled = true;
    btn.textContent = '離線需 HTTPS';
    return;
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.register('./sw.js');
  } catch (e) {
    btn.disabled = true;
    btn.textContent = '離線設定失敗';
    btn.title = String(e);
    return;
  }

  // When a new SW takes over (e.g. after we deploy fresh assets), reload
  // the page once so the user actually sees the new version.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  const clearBtn = document.getElementById('offline-clear');

  // If the cache already exists, mark as ready.
  if ('caches' in window) {
    const cached = await caches.match('./rooms.json');
    if (cached) markOfflineReady(btn, clearBtn);
  }

  clearBtn.addEventListener('click', async () => {
    if (!confirm('清除已下載的離線版？分組與備註不會受影響。下次需要離線使用時要重新下載。')) return;
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    } catch (e) {
      showToast('清除失敗：' + e.message, true);
      return;
    }
    btn.disabled = false;
    btn.textContent = '📥 下載離線版';
    btn.classList.remove('offline-ready');
    btn.title = '把整個網頁下載到瀏覽器，沒網路也能用';
    clearBtn.hidden = true;
    showToast('離線版已清除');
  });

  btn.addEventListener('click', async () => {
    const sw = navigator.serviceWorker.controller || (await navigator.serviceWorker.ready).active;
    if (!sw) {
      showToast('Service worker 還沒啟動，1 秒後再試', true);
      return;
    }
    btn.disabled = true;
    btn.textContent = '下載中… 0%';
    const onMsg = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'cache-progress') {
        btn.textContent = `下載中… ${Math.round(d.done / d.total * 100)}%`;
      } else if (d.type === 'cache-done') {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        markOfflineReady(btn, clearBtn);
        showToast('離線版已就緒，可關閉網路使用');
      } else if (d.type === 'cache-error') {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        btn.disabled = false;
        btn.textContent = '📥 下載離線版';
        showToast(`下載失敗：${d.url}`, true);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    sw.postMessage({ type: 'cache-all' });
  });
}

function markOfflineReady(btn, clearBtn) {
  btn.disabled = false;
  btn.textContent = '✓ 離線版已就緒';
  btn.classList.add('offline-ready');
  btn.title = '已將整個網頁下載到瀏覽器。沒網路也能打開這個網址。再點一次會重新下載最新版。';
  if (clearBtn) clearBtn.hidden = false;
}

// ---------- Boot ----------

async function init() {
  try {
    await loadRooms();
  } catch (e) {
    document.body.innerHTML = `<div style="padding:32px;color:#ef5d5d">無法載入 rooms.json：${e.message}<br><br>請用本地 web server 開啟（例如 <code>python3 -m http.server</code>），不要用 file:// 直接打開。</div>`;
    return;
  }
  loadPersisted();

  // pick initial deck — prefer a mid stateroom deck if available
  const preferred = [10, 9, 12, 13, 15];
  state.currentDeck = preferred.find(n => state.deckById.has(n)) || state.decks[0].deck;

  renderDeckList();
  populateFilterDropdowns();
  renderGroups();
  renderBulkGroupSelect();
  renderPopupGroupSelect();
  showDeck(state.currentDeck);
  // Restore last zoom; if none saved, fit-to-screen.
  const savedZoom = loadPersistedZoom();
  if (savedZoom != null) {
    state.zoom = savedZoom;
    requestAnimationFrame(applyZoom);
  } else {
    requestAnimationFrame(fitZoom);
  }

  // Event wiring
  document.getElementById('deck-select').addEventListener('change', (e) => showDeck(parseInt(e.target.value, 10)));
  document.getElementById('add-group').addEventListener('click', () => {
    addGroup();
    renderGroups();
    renderBulkGroupSelect();
    renderPopupGroupSelect();
  });
  document.getElementById('bulk-assign').addEventListener('click', () => doBulkAssign(false));
  document.getElementById('theme-filter').addEventListener('change', refreshFilter);
  document.getElementById('category-filter').addEventListener('change', refreshFilter);
  document.getElementById('reset-btn').addEventListener('click', () => {
    if (!confirm('清除所有分組、房間指派與備註？此動作無法復原（除非有匯出的 JSON）。')) return;
    state.groups = [];
    state.roomGroups.clear();
    state.roomNotes.clear();
    state.assigningGroupId = null;
    persist();
    renderGroups();
    renderBulkGroupSelect();
    if (popupRoomId) renderPopupGroupCheckboxes(popupRoomId);
    repaintCurrentDeck();
  });
  const searchEl = document.getElementById('search');
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doSearch(searchEl.value);
  });
  document.getElementById('filter-chip-clear').addEventListener('click', () => {
    document.getElementById('theme-filter').value = '';
    document.getElementById('category-filter').value = '';
    setFilter(null);
  });
  document.getElementById('popup-close').addEventListener('click', closePopup);
  document.getElementById('popup-clear').addEventListener('click', () => {
    if (!popupRoomId) return;
    clearRoomGroups(popupRoomId);
    repaintCurrentDeck();
    renderGroups();
    renderPopupGroupCheckboxes(popupRoomId);
  });
  // Debounced note save (every 250ms after last keystroke, or on blur)
  const noteEl = document.getElementById('popup-note-text');
  let noteTimer = null;
  const saveNote = () => {
    if (!popupRoomId) return;
    setRoomNote(popupRoomId, noteEl.value);
    renderGroups();
    repaintCurrentDeck();
  };
  noteEl.addEventListener('input', () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, 250);
  });
  noteEl.addEventListener('blur', () => { clearTimeout(noteTimer); saveNote(); });
  document.getElementById('zoom-in').addEventListener('click', () => { state.zoom = Math.min(3, state.zoom * 1.2); applyZoom(); });
  document.getElementById('zoom-out').addEventListener('click', () => { state.zoom = Math.max(0.1, state.zoom / 1.2); applyZoom(); });
  document.getElementById('zoom-reset').addEventListener('click', fitZoom);
  const zoomInput = document.getElementById('zoom-value');
  zoomInput.addEventListener('input', () => setZoomPercent(zoomInput.value));
  zoomInput.addEventListener('change', () => {
    // Re-sync if user typed something out of range
    zoomInput.value = Math.round(state.zoom * 100);
  });
  zoomInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') zoomInput.blur();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closePopup();
      closeSidebar();
    }
  });

  // Mobile toolbar collapse
  const toolbarToggle = document.getElementById('toolbar-toggle');
  const mapArea = document.querySelector('.map-area');
  if (toolbarToggle && mapArea) {
    const applyToolbarCollapsed = (collapsed) => {
      mapArea.classList.toggle('toolbar-collapsed', collapsed);
      toolbarToggle.textContent = collapsed ? '▼' : '▲';
      toolbarToggle.setAttribute('aria-expanded', String(!collapsed));
      toolbarToggle.setAttribute('aria-label', collapsed ? '展開工具列' : '收合工具列');
    };
    // Restore from storage
    if (loadPersistedUi().toolbarCollapsed) applyToolbarCollapsed(true);
    toolbarToggle.addEventListener('click', () => {
      const next = !mapArea.classList.contains('toolbar-collapsed');
      applyToolbarCollapsed(next);
      persistUi();
    });
  }

  // Mobile sidebar drawer
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebarBackdrop = document.getElementById('sidebar-backdrop');
  if (sidebarToggle) {
    sidebarToggle.addEventListener('click', () => {
      const sidebar = document.querySelector('.sidebar');
      if (sidebar.classList.contains('open')) closeSidebar();
      else openSidebar();
    });
  }
  if (sidebarBackdrop) {
    sidebarBackdrop.addEventListener('click', closeSidebar);
  }
  // If the viewport grows past the mobile breakpoint, ensure the drawer
  // doesn't stay stuck in the open state from a previous resize.
  window.addEventListener('resize', () => {
    if (!isMobileViewport()) closeSidebar();
  });

  setupOffline();
}

init();
