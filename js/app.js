import { detectLang, setLang, getLang, t } from './i18n.js';
import {
  getAllModels, getFile, getThumb, updateModel, deleteModel, storageInfo, requestPersist,
} from './db.js';
import { importFiles, filesFromDrop, expandZips } from './import.js';
import { ThumbQueue, THUMB_VERSION } from './thumbs.js';
import { Viewer } from './viewer.js';
import { createBackup, downloadBackup, canShareBackup, shareBackup, importBackup, lastBackup } from './backup.js';
import { findDuplicates, pickKeeper, mergeInto } from './dupes.js';
import {
  diskSupported, loadRoot, pickRoot, unlinkRoot, ensureWrite, syncEnabled, setSyncEnabled, rootName, hasRoot,
  moveFile, deleteFile, safeName, scan,
} from './disk.js';
import { isModelFile } from './loaders.js';

const $ = (id) => document.getElementById(id);
const DAY = 86_400_000;

const state = {
  models: [],
  filter: 'all',
  tag: '',
  search: '',
  sort: 'added',
  thumbUrls: new Map(),
  viewerIds: [],
  viewerIndex: 0,
  folder: '', // '' = all, NO_FOLDER = models without a folder, otherwise a folder name
  selected: new Set(),
};

const NO_FOLDER = '__none__';

let viewer = null; // created lazily: WebGL is only needed once a model is opened
let observer = null;

/* ---------- helpers ---------- */

const stemOf = (name) => name.replace(/\.[^.]+$/, '');
const displayTitle = (m) => m.title || stemOf(m.name);
const formatBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};
const formatDims = (d) => (d ? `${d.w.toFixed(1)} × ${d.d.toFixed(1)} × ${d.h.toFixed(1)} mm` : '-');
const parseTags = (s) => [...new Set(s.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))];
const byId = (id) => state.models.find((m) => m.id === id);

let toastTimer;
function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

async function thumbUrl(id) {
  if (state.thumbUrls.has(id)) return state.thumbUrls.get(id);
  const blob = await getThumb(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  state.thumbUrls.set(id, url);
  return url;
}

function dropThumbUrl(id) {
  const url = state.thumbUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  state.thumbUrls.delete(id);
}

/* ---------- thumbnails queue ---------- */

const queue = new ThumbQueue({
  onProgress(done, total) {
    $('progress').hidden = total === 0;
    $('progress-fill').style.width = total ? `${(done / total) * 100}%` : '0';
    $('progress-text').textContent = t('thumbs.progress', { done, total });
  },
  onDone(updated) {
    const i = state.models.findIndex((m) => m.id === updated.id);
    if (i >= 0) state.models[i] = updated;
    dropThumbUrl(updated.id);
    const old = document.querySelector(`.card[data-id="${updated.id}"]`);
    if (old) old.replaceWith(buildCard(updated));
  },
});

function queueMissingThumbs() {
  // also redo previews made by an older version of the app (old thumbnails stay visible meanwhile)
  queue.add(state.models.filter((m) => (!m.hasThumb && !m.thumbFailed) || m.thumbV !== THUMB_VERSION));
}

async function rebuildThumbs() {
  state.models = state.models.map((m) => ({ ...m, thumbV: 0 }));
  await Promise.all(state.models.map((m) => updateModel(m)));
  $('settings-dialog').close();
  queueMissingThumbs();
}

/* ---------- grid ---------- */

function visibleModels() {
  const q = state.search.trim().toLowerCase();
  let list = state.models.filter((m) => {
    if (state.filter === 'fav' && !m.fav) return false;
    if (state.filter === 'unnamed' && m.title) return false;
    if (state.tag && !m.tags.includes(state.tag)) return false;
    if (state.folder === NO_FOLDER ? m.folder : state.folder && m.folder !== state.folder) return false;
    if (q) {
      const hay = `${m.title} ${m.name} ${m.folder || ''} ${m.tags.join(' ')} ${m.note}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const sorters = {
    added: (a, b) => b.added - a.added,
    name: (a, b) => displayTitle(a).localeCompare(displayTitle(b), undefined, { numeric: true, sensitivity: 'base' }),
    size: (a, b) => b.size - a.size,
  };
  list = list.sort(sorters[state.sort]);
  return list;
}

function buildCard(m) {
  const card = document.createElement('div');
  card.className = `card${state.selected.has(m.id) ? ' selected' : ''}`;
  card.dataset.id = m.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');

  const wrap = document.createElement('div');
  wrap.className = 'thumb-wrap';
  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (m.hasThumb) {
    thumbUrl(m.id).then((url) => {
      if (!url) return;
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = url;
      thumb.replaceChildren(img);
    });
  } else {
    thumb.textContent = m.thumbFailed ? t('card.thumbfail') : t('card.nothumb');
    if (!m.thumbFailed) observer?.observe(card);
  }

  const ext = document.createElement('span');
  ext.className = 'badge-ext';
  ext.textContent = m.ext.toUpperCase();

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'sel';
  check.checked = state.selected.has(m.id);
  check.setAttribute('aria-label', displayTitle(m));
  check.addEventListener('click', (e) => { e.stopPropagation(); toggleSelect(m.id, check.checked); });

  wrap.append(thumb, ext, check);
  if (m.fav) {
    const star = document.createElement('span');
    star.className = 'badge-fav';
    star.textContent = '★';
    wrap.append(star);
  }

  const info = document.createElement('div');
  info.className = 'card-info';
  const title = document.createElement('div');
  title.className = `card-title${m.title ? '' : ' unnamed'}`;
  title.textContent = displayTitle(m);
  const sub = document.createElement('div');
  sub.className = 'card-sub';
  sub.textContent = [m.folder ? `📁 ${m.folder}` : '', m.dims ? `${Math.round(m.dims.h)} mm` : '', formatBytes(m.size), ...m.tags.slice(0, 2)].filter(Boolean).join(' · ');
  info.append(title, sub);

  card.append(wrap, info);
  const activate = () => {
    if (state.selected.size) toggleSelect(m.id, !state.selected.has(m.id));
    else openViewer(m.id, visibleModels().map((x) => x.id));
  };
  card.addEventListener('click', activate);
  card.addEventListener('keydown', (e) => {
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); }
  });
  return card;
}

/* ---------- selection ---------- */

function toggleSelect(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  const card = document.querySelector(`.card[data-id="${id}"]`);
  if (card) {
    card.classList.toggle('selected', on);
    card.querySelector('.sel').checked = on;
  }
  updateSelBar();
}

function clearSelection() {
  state.selected.clear();
  document.querySelectorAll('.card.selected').forEach((c) => {
    c.classList.remove('selected');
    c.querySelector('.sel').checked = false;
  });
  updateSelBar();
}

function updateSelBar() {
  const n = state.selected.size;
  $('selbar').hidden = n === 0;
  document.body.classList.toggle('has-sel', n > 0);
  $('sel-count').textContent = t('bulk.selected', { n });
  const visible = visibleModels();
  const all = visible.length > 0 && visible.every((m) => state.selected.has(m.id));
  $('sel-all').textContent = t(all ? 'bulk.none' : 'bulk.all');
}

function toggleSelectAll() {
  const visible = visibleModels();
  const all = visible.length > 0 && visible.every((m) => state.selected.has(m.id));
  visible.forEach((m) => (all ? state.selected.delete(m.id) : state.selected.add(m.id)));
  render();
}

let bulkMode = null;

function openBulk(mode) {
  bulkMode = mode;
  const n = state.selected.size;
  $('bulk-title').textContent = t(mode === 'folder' ? 'bulk.move.title' : 'bulk.tags.title', { n });
  $('bulk-input').placeholder = t(mode === 'folder' ? 'bulk.move.placeholder' : 'bulk.tags.placeholder');
  $('bulk-input').value = '';
  $('bulk-nofolder').hidden = mode !== 'folder';
  const options = mode === 'folder' ? folderNames() : allTags();
  $('bulk-list').replaceChildren(...options.map((v) => Object.assign(document.createElement('option'), { value: v })));
  $('bulk-dialog').showModal();
  $('bulk-input').focus();
}

async function applyBulk(clearFolder = false) {
  const raw = $('bulk-input').value.trim();
  if (!clearFolder && !raw) return;
  const ids = [...state.selected];
  const existing = folderNames();
  const onDisk = bulkMode === 'folder' && syncEnabled() && (await ensureWrite());
  let count = 0;
  let moved = 0;
  for (const id of ids) {
    const m = byId(id);
    if (!m) continue;
    let next;
    if (bulkMode === 'folder') {
      // reuse an existing folder's spelling so "Kaas" and "kaas" do not become two folders
      const folder = clearFolder ? '' : (existing.find((f) => f.toLowerCase() === raw.toLowerCase()) ?? raw);
      next = { ...m, folder };
    } else {
      next = { ...m, tags: [...new Set([...m.tags, ...parseTags(raw)])] };
    }
    if (onDisk && m.path) {
      const synced = await syncToDisk(m, next);
      if (synced.path !== next.path) moved++;
      next = synced;
    }
    await updateModel(next);
    state.models[state.models.findIndex((x) => x.id === id)] = next;
    count++;
  }
  $('bulk-dialog').close();
  toast(t(bulkMode === 'folder' ? 'bulk.moved' : 'bulk.tagged', { n: count }) + (moved ? ` · ${t('disk.moved', { n: moved })}` : ''), 5000);
  clearSelection();
  render();
}

async function deleteSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  const choice = await askDelete(ids, t('del.subject.n', { n: ids.length }));
  if (!choice) return;
  await removeModels(ids, { disk: choice === 'disk' });
  state.selected.clear();
  render();
  toast(t('bulk.deleted', { n: ids.length }));
}

function folderNames() {
  return [...new Set(state.models.map((m) => m.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function allTags() {
  return [...new Set(state.models.flatMap((m) => m.tags))].sort((a, b) => a.localeCompare(b));
}

function renderFolderFilter() {
  const counts = new Map();
  state.models.forEach((m) => { if (m.folder) counts.set(m.folder, (counts.get(m.folder) || 0) + 1); });
  const sel = $('folder-filter');
  sel.replaceChildren(new Option(t('filter.allfolders'), ''));
  if (counts.size) sel.add(new Option(`${t('filter.nofolder')} (${state.models.filter((m) => !m.folder).length})`, NO_FOLDER));
  [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([f, n]) => sel.add(new Option(`📁 ${f} (${n})`, f)));
  if (state.folder && state.folder !== NO_FOLDER && !counts.has(state.folder)) state.folder = '';
  if (state.folder === NO_FOLDER && !counts.size) state.folder = '';
  sel.value = state.folder;
  sel.hidden = counts.size === 0;
  $('folder-list').replaceChildren(...[...counts.keys()].map((f) => Object.assign(document.createElement('option'), { value: f })));
}

function renderTagFilter() {
  const counts = new Map();
  state.models.forEach((m) => m.tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
  const sel = $('tag-filter');
  sel.replaceChildren(new Option(t('filter.alltags'), ''));
  [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([tag, n]) => sel.add(new Option(`${tag} (${n})`, tag)));
  if (state.tag && !counts.has(state.tag)) state.tag = '';
  sel.value = state.tag;
  sel.hidden = counts.size === 0;

  const list = $('tag-list');
  list.replaceChildren(...[...counts.keys()].map((tag) => Object.assign(document.createElement('option'), { value: tag })));
}

function render() {
  const list = visibleModels();
  const grid = $('grid');
  const empty = state.models.length === 0;
  $('empty').hidden = !empty;
  $('no-results').hidden = empty || list.length > 0;
  document.querySelector('.toolbar').hidden = empty;
  const present = new Set(state.models.map((m) => m.id));
  state.selected.forEach((id) => { if (!present.has(id)) state.selected.delete(id); });
  grid.replaceChildren(...list.map(buildCard));
  renderTagFilter();
  renderFolderFilter();
  updateSelBar();
}

/* ---------- importing ---------- */

async function handleFiles(picked) {
  if (!picked.length) return;
  $('add-dialog').close();
  const { files, backups } = await expandZips(picked);
  for (const backup of backups) await doImportBackup(backup);
  if (!files.length) return backups.length ? undefined : toast(t('import.nofiles'));
  const res = await importFiles(files, state.models, (done, total) => {
    $('progress').hidden = false;
    $('progress-fill').style.width = `${(done / total) * 100}%`;
    $('progress-text').textContent = t('import.progress', { done, total });
  });
  $('progress').hidden = true;
  if (!res.added.length && !res.updated.length && !res.dupes) return toast(t('import.nofiles'));
  state.models.push(...res.added);
  for (const u of res.updated) {
    state.models[state.models.findIndex((m) => m.id === u.id)] = u;
    dropThumbUrl(u.id);
  }
  render();
  toast(t('import.done', { added: res.added.length, dupes: res.dupes, skipped: res.skipped }));
  queueMissingThumbs();
  if (res.added.length) requestPersist();
  if (res.updated.length) toast(t('import.colors', { n: res.updated.length }));
  if (res.missingMtl) toast(t('import.nomtl', { n: res.missingMtl }), 9000);
}

/* ---------- viewer ---------- */

const fields = {
  title: () => $('d-title'), folder: () => $('d-folder'), tags: () => $('d-tags'), note: () => $('d-note'),
};

const currentMeta = () => byId(state.viewerIds[state.viewerIndex]);

function isDirty(m) {
  return fields.title().value.trim() !== m.title
    || fields.folder().value.trim() !== (m.folder || '')
    || parseTags(fields.tags().value).join(',') !== m.tags.join(',')
    || fields.note().value !== m.note;
}

async function saveCurrent({ quiet = false } = {}) {
  const m = currentMeta();
  if (!m) return;
  const next = {
    ...m,
    title: fields.title().value.trim(),
    folder: fields.folder().value.trim(),
    tags: parseTags(fields.tags().value),
    note: fields.note().value,
  };
  const synced = await syncToDisk(m, next);
  await updateModel(synced);
  state.models[state.models.findIndex((x) => x.id === m.id)] = synced;
  render();
  renderSuggestions();
  showDiskPath(synced);
  if (!quiet) toast(t('detail.saved'), 1500);
}

function showDiskPath(m) {
  $('d-disk').hidden = !m.path;
  if (m.path) $('d-disk').textContent = t('disk.path', { path: m.path.join('/') });
  if (m.path) $('d-file').textContent = m.name;
}

function renderSuggestions() {
  const m = currentMeta();
  const used = new Set(parseTags(fields.tags().value));
  const counts = new Map();
  state.models.forEach((x) => x.tags.forEach((tag) => counts.set(tag, (counts.get(tag) || 0) + 1)));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag).filter((tag) => !used.has(tag)).slice(0, 10);
  $('d-tag-suggest').replaceChildren(...top.map((tag) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `+ ${tag}`;
    b.addEventListener('click', () => {
      const cur = parseTags(fields.tags().value);
      fields.tags().value = [...cur, tag].join(', ');
      renderSuggestions();
    });
    return b;
  }));
  return m;
}

async function loadCurrent() {
  const m = currentMeta();
  if (!m) return closeViewer();
  fields.title().value = m.title;
  fields.folder().value = m.folder || '';
  fields.title().placeholder = stemOf(m.name);
  fields.tags().value = m.tags.join(', ');
  fields.note().value = m.note;
  $('d-file').textContent = m.name;
  showDiskPath(m);
  $('d-dims').textContent = formatDims(m.dims);
  $('d-size').textContent = formatBytes(m.size);
  $('d-added').textContent = new Date(m.added).toLocaleDateString(getLang());
  $('d-fav').textContent = m.fav ? t('detail.faved') : t('detail.fav');
  $('d-fav').classList.toggle('on', m.fav);
  $('v-count').textContent = `${state.viewerIndex + 1} / ${state.viewerIds.length}`;
  $('v-prev').hidden = $('v-next').hidden = state.viewerIds.length < 2;
  renderSuggestions();

  const status = $('v-status');
  status.textContent = t('viewer.loading');
  status.hidden = false;
  try {
    const dims = await viewer.show(m);
    if (dims === null) return; // a newer model was requested meanwhile
    status.hidden = true;
    if (!m.dims) {
      const next = { ...currentMeta(), dims };
      await updateModel(next);
      state.models[state.models.findIndex((x) => x.id === m.id)] = next;
      $('d-dims').textContent = formatDims(dims);
    }
  } catch (err) {
    console.warn(err);
    status.textContent = t('viewer.error');
  }
}

async function openViewer(id, ids) {
  state.viewerIds = ids;
  state.viewerIndex = Math.max(0, ids.indexOf(id));
  if (!viewer) viewer = new Viewer($('viewer-canvas'));
  $('viewer').hidden = false;
  document.body.style.overflow = 'hidden';
  viewer.start();
  history.pushState({ viewer: true }, '');
  $('v-wire').classList.toggle('on', viewer.wireframe);
  await loadCurrent();
}

async function closeViewer({ fromPop = false } = {}) {
  if ($('viewer').hidden) return;
  const m = currentMeta();
  if (m && isDirty(m)) await saveCurrent({ quiet: true });
  $('viewer').hidden = true;
  document.body.style.overflow = '';
  viewer.stop();
  if (!fromPop && history.state?.viewer) history.back();
}

async function step(delta) {
  const n = state.viewerIds.length;
  if (n < 2) return;
  const m = currentMeta();
  if (m && isDirty(m)) await saveCurrent({ quiet: true });
  state.viewerIndex = (state.viewerIndex + delta + n) % n;
  await loadCurrent();
}

async function toggleFav() {
  const m = currentMeta();
  const next = { ...m, fav: !m.fav };
  await updateModel(next);
  state.models[state.models.findIndex((x) => x.id === m.id)] = next;
  $('d-fav').textContent = next.fav ? t('detail.faved') : t('detail.fav');
  $('d-fav').classList.toggle('on', next.fav);
  render();
}

async function deleteCurrent() {
  const m = currentMeta();
  if (!m) return;
  const choice = await askDelete([m.id], t('del.subject.one', { name: displayTitle(m) }));
  if (!choice) return;
  await removeModels([m.id], { disk: choice === 'disk' });
  state.viewerIds.splice(state.viewerIndex, 1);
  render();
  if (!state.viewerIds.length) return closeViewer();
  state.viewerIndex = Math.min(state.viewerIndex, state.viewerIds.length - 1);
  await loadCurrent();
}

async function downloadCurrent() {
  const m = currentMeta();
  const blob = await getFile(m.id);
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: m.name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ---------- dialogs ---------- */

/**
 * Styled replacement for window.confirm(): shows a message and a list of buttons.
 * Resolves with the clicked button's value, or null when closed with Escape.
 */
function choose({ title, message, buttons }) {
  return new Promise((resolve) => {
    const dialog = $('choice-dialog');
    $('choice-title').textContent = title;
    $('choice-message').textContent = message;
    let result = null;
    const els = buttons.map((b) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `btn block ${b.kind || ''}`;
      el.textContent = b.label;
      el.addEventListener('click', () => { result = b.value; dialog.close(); });
      return el;
    });
    $('choice-buttons').replaceChildren(...els);
    dialog.addEventListener('close', () => resolve(result), { once: true });
    dialog.showModal();
    // focus the safe button so a stray Enter never deletes anything
    els[buttons.findIndex((b) => b.value === null)]?.focus();
  });
}

const linkedCount = (ids) => (syncEnabled() ? ids.map(byId).filter((m) => m?.path).length : 0);

/**
 * Ask before removing models. Returns null (cancelled), 'library' (only from the library)
 * or 'disk' (also delete the linked files from the disk).
 */
function askDelete(ids, subject) {
  const linked = linkedCount(ids);
  const message = [t('del.message', { what: subject }), linked ? t('del.diskwarning', { n: linked }) : t('del.keepfiles')].join('\n\n');
  const buttons = linked
    ? [
      { label: t('del.libraryOnly'), value: 'library', kind: 'primary' },
      { label: t('del.alsoDisk', { n: linked }), value: 'disk', kind: 'destructive' },
    ]
    : [{ label: t('del.remove'), value: 'library', kind: 'destructive' }];
  buttons.push({ label: t('common.cancel'), value: null, kind: 'ghost' });
  return choose({ title: t('del.title'), message, buttons });
}

/* ---------- disk link (optional, Chrome/Edge on desktop) ---------- */

const diskMessage = (err, m) => (err?.name === 'NotFoundError'
  ? t('disk.missing', { name: m?.name ?? '' })
  : t('disk.error', { msg: err?.message || err?.name || String(err) }));

/**
 * Apply a rename (new title) and/or a move (new folder) to the file on disk.
 * Returns the updated model; on any problem the model is returned unchanged and a message shown.
 */
async function syncToDisk(m, next) {
  if (!syncEnabled() || !m.path) return next;
  const folderChanged = (m.folder || '') !== (next.folder || '');
  const titleChanged = next.title && m.title !== next.title && safeName(next.title);
  if (!folderChanged && !titleChanged) return next;
  if (m.ext === 'obj' && m.mtl) { toast(t('disk.skipobj'), 6000); return next; }
  try {
    const destFolder = folderChanged ? (next.folder ? [safeName(next.folder)] : []) : m.path.slice(0, -1);
    const newName = titleChanged ? `${safeName(next.title)}.${m.ext}` : undefined;
    const path = await moveFile(m.path, destFolder, newName);
    if (titleChanged) toast(t('disk.renamed', { name: path.at(-1) }), 5000);
    return { ...next, path, name: path.at(-1) };
  } catch (err) {
    console.warn('Disk action failed', err);
    toast(diskMessage(err, m), 6000);
    return next;
  }
}

/** Delete the linked files of these models from the disk (the user already agreed in askDelete). */
async function deleteFromDisk(ids) {
  if (!syncEnabled()) return;
  const linked = ids.map(byId).filter((m) => m?.path);
  if (!linked.length) return;
  if (!(await ensureWrite())) return toast(t('disk.nopermission'));
  let n = 0;
  for (const m of linked) {
    try { await deleteFile(m.path); n++; } catch (err) { toast(diskMessage(err, m), 6000); }
  }
  if (n) toast(t('disk.deleted', { n }));
}

function renderDisk() {
  const supported = diskSupported();
  $('disk-unsupported').hidden = supported;
  $('disk-section').hidden = !supported;
  if (!supported) return;
  const linked = state.models.filter((m) => m.path).length;
  $('disk-status').textContent = hasRoot()
    ? t('disk.status', { name: rootName(), linked, total: state.models.length })
    : t('disk.none');
  $('disk-link').textContent = t(hasRoot() ? 'disk.relink' : 'disk.link');
  $('disk-rescan').hidden = $('disk-unlink').hidden = $('disk-sync-row').hidden = !hasRoot();
  $('disk-sync').checked = syncEnabled();
}

async function linkFolder({ pick }) {
  if (pick) {
    try {
      await pickRoot();
      // a different folder: old paths no longer point anywhere
      state.models = state.models.map((m) => (m.path ? { ...m, path: undefined } : m));
      await Promise.all(state.models.map((m) => updateModel(m)));
    } catch (err) {
      if (err.name === 'AbortError') return toast(t('disk.cancelled'));
      throw err;
    }
  }
  if (!(await ensureWrite())) return toast(t('disk.nopermission'));

  $('progress').hidden = false;
  const found = await scan((n) => { $('progress-text').textContent = t('disk.scanning', { n }); });
  const keyOf = (name, size, modified) => `${name}|${size}|${modified}`;
  const known = new Map(state.models.map((m) => [keyOf(m.name, m.size, m.lastModified), m]));

  let linked = 0;
  const fresh = [];
  for (const { file, path } of found) {
    const match = isModelFile(file.name) ? known.get(keyOf(file.name, file.size, file.lastModified)) : null;
    if (match) {
      const next = { ...match, path, folder: match.folder || (path.length > 1 ? path[0] : '') };
      await updateModel(next);
      state.models[state.models.findIndex((m) => m.id === match.id)] = next;
      linked++;
    } else {
      fresh.push(Object.assign(file, { _path: path }));
    }
  }
  const res = await importFiles(fresh, state.models, (done, total) => {
    $('progress-fill').style.width = `${(done / total) * 100}%`;
    $('progress-text').textContent = t('import.progress', { done, total });
  });
  $('progress').hidden = true;
  state.models.push(...res.added);
  render();
  queueMissingThumbs();
  toast(t('disk.linked', { linked, added: res.added.length }), 6000);
  renderDisk();
}

async function toggleDiskSync(on) {
  if (on && !(await ensureWrite())) {
    $('disk-sync').checked = false;
    return toast(t('disk.nopermission'));
  }
  setSyncEnabled(on);
  if (on) toast(t('disk.on'), 5000);
}

async function unlinkFolder() {
  await unlinkRoot();
  state.models = state.models.map((m) => (m.path ? { ...m, path: undefined } : m));
  await Promise.all(state.models.map((m) => updateModel(m)));
  render();
  renderDisk();
}

/* ---------- duplicates ---------- */

let dupeGroups = [];

async function removeModels(ids, { disk = false } = {}) {
  if (disk) await deleteFromDisk(ids);
  for (const id of ids) {
    await deleteModel(id);
    dropThumbUrl(id);
  }
  state.models = state.models.filter((m) => !ids.includes(m.id));
}

async function openDupes() {
  const dialog = $('dupes-dialog');
  $('dupes-list').replaceChildren();
  $('dupes-clean').hidden = true;
  $('dupes-status').textContent = t('dupes.scanning', { done: 0, total: 0 });
  dialog.showModal();
  const res = await findDuplicates(state.models, (done, total) => {
    $('dupes-status').textContent = t('dupes.scanning', { done, total });
  });
  state.models = res.models;
  dupeGroups = res.groups;
  renderDupes();
}

function renderDupes() {
  // drop models removed meanwhile, then groups that are no longer duplicates
  dupeGroups = dupeGroups
    .map((g) => g.filter((m) => state.models.some((x) => x.id === m.id)))
    .filter((g) => g.length > 1);
  const extra = dupeGroups.reduce((n, g) => n + g.length - 1, 0);
  $('dupes-status').textContent = dupeGroups.length
    ? t('dupes.found', { groups: dupeGroups.length, extra })
    : t('dupes.none');
  $('dupes-clean').hidden = !dupeGroups.length;

  $('dupes-list').replaceChildren(...dupeGroups.map((group) => {
    const keeper = pickKeeper(group);
    const box = document.createElement('div');
    box.className = 'dupe-group';
    for (const m of group) {
      const row = document.createElement('div');
      row.className = 'dupe-row';
      const thumb = document.createElement('div');
      thumb.className = 'dupe-ph';
      if (m.hasThumb) {
        thumbUrl(m.id).then((url) => {
          if (!url) return;
          const img = document.createElement('img');
          img.src = url;
          img.alt = '';
          thumb.replaceWith(img);
        });
      }
      const info = document.createElement('div');
      info.className = 'dupe-info';
      info.innerHTML = '<div class="t"></div><div class="s"></div>';
      info.firstChild.textContent = displayTitle(m);
      info.lastChild.textContent = [m.name, formatBytes(m.size), ...m.tags.slice(0, 3)].join(' · ');
      row.append(thumb, info);
      if (m.id === keeper.id) {
        const keep = document.createElement('span');
        keep.className = 'dupe-keep';
        keep.textContent = t('dupes.keep');
        row.append(keep);
      } else {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'btn small danger';
        del.textContent = t('dupes.remove');
        del.addEventListener('click', async () => {
          // only ask when a linked file could also be deleted from the disk
          const choice = linkedCount([m.id]) ? await askDelete([m.id], t('del.subject.dupes', { n: 1 })) : 'library';
          if (!choice) return;
          await mergeAndRemove(keeper, [m], { disk: choice === 'disk' });
          renderDupes();
        });
        row.append(del);
      }
      box.append(row);
    }
    return box;
  }));
}

async function mergeAndRemove(keeper, others, opts) {
  const merged = mergeInto(keeper, others);
  await updateModel(merged);
  state.models[state.models.findIndex((m) => m.id === merged.id)] = merged;
  await removeModels(others.map((o) => o.id), opts);
  dupeGroups = dupeGroups.map((g) => g.map((m) => (m.id === merged.id ? merged : m)));
  render();
}

async function cleanAllDupes() {
  const extra = dupeGroups.reduce((n, g) => n + g.length - 1, 0);
  if (!extra) return;
  const removing = dupeGroups.flatMap((g) => { const k = pickKeeper(g); return g.filter((m) => m.id !== k.id).map((m) => m.id); });
  const choice = await askDelete(removing, t('del.subject.dupes', { n: extra }));
  if (!choice) return;
  if (choice === 'disk') await deleteFromDisk(removing);
  for (const group of dupeGroups) {
    const keeper = pickKeeper(group);
    await mergeAndRemove(keeper, group.filter((m) => m.id !== keeper.id), { disk: false });
  }
  toast(t('dupes.done', { n: extra }));
  renderDupes();
}

/* ---------- settings ---------- */

async function openSettings() {
  $('set-lang').value = getLang();
  $('set-theme').value = localStorage.getItem('ml.theme') || 'auto';
  const lb = lastBackup();
  $('set-last-backup').textContent = lb
    ? t('settings.lastbackup', { date: new Date(lb).toLocaleDateString(getLang()) })
    : t('settings.nobackup');
  const info = await storageInfo();
  $('set-storage').textContent = t('settings.storage.info', {
    used: formatBytes(info.used),
    quota: formatBytes(info.quota),
    persist: info.persisted ? t('settings.storage.persist') : t('settings.storage.nopersist'),
  });
  renderDisk();
  $('settings-dialog').showModal();
}

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
}

async function doExport(files) {
  toast(t('backup.working'), 60_000);
  try {
    const backup = await createBackup({ files });
    let notice = t('backup.done');
    if (canShareBackup(backup)) {
      // Building a big zip can outlast the tap that started it, and sharing needs a fresh tap: ask first.
      $('toast').hidden = true;
      const choice = await choose({
        title: t('backup.ready'),
        message: t('backup.ready.message', { name: backup.filename, size: formatBytes(backup.blob.size) }),
        buttons: [
          { label: t('backup.share'), value: 'share', kind: 'primary' },
          { label: t('backup.save'), value: 'save' },
          { label: t('common.cancel'), value: null, kind: 'ghost' },
        ],
      });
      if (!choice) return toast(t('backup.cancelled'));
      if (choice === 'share') {
        try {
          if (!(await shareBackup(backup))) return toast(t('backup.cancelled'));
          toast(t('backup.shared'));
          return openSettings();
        } catch (err) {
          console.error(err);
          notice = t('backup.sharefail');
        }
      }
    }
    downloadBackup(backup);
    toast(notice, 5000);
    openSettings();
  } catch (err) {
    console.error(err);
    toast(String(err.message || err));
  }
}

async function doImportBackup(file) {
  try {
    const res = await importBackup(file);
    state.models = await getAllModels();
    render();
    queueMissingThumbs();
    toast(t('backup.importdone', res));
  } catch (err) {
    console.error(err);
    // not a backup: a zip with models in it is added like any other models
    if (/\.zip$/i.test(file.name)) return handleFiles([file]);
    toast(t('backup.importfail'));
  }
}

/* ---------- wiring ---------- */

function wire() {
  $('btn-add').addEventListener('click', () => $('add-dialog').showModal());
  $('btn-add-empty').addEventListener('click', () => $('add-dialog').showModal());
  $('add-close').addEventListener('click', () => $('add-dialog').close());
  $('add-files').addEventListener('click', () => $('file-input').click());
  $('add-folder').addEventListener('click', () => $('folder-input').click());
  for (const id of ['file-input', 'folder-input']) {
    $(id).addEventListener('change', (e) => { handleFiles([...e.target.files]); e.target.value = ''; });
  }

  $('search').addEventListener('input', (e) => { state.search = e.target.value; render(); });
  $('sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
  $('tag-filter').addEventListener('change', (e) => { state.tag = e.target.value; render(); });
  $('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.filter = chip.dataset.filter;
    document.querySelectorAll('#chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
    render();
  });
  $('btn-dupes').addEventListener('click', openDupes);
  $('folder-filter').addEventListener('change', (e) => { state.folder = e.target.value; render(); });
  $('sel-all').addEventListener('click', toggleSelectAll);
  $('sel-move').addEventListener('click', () => openBulk('folder'));
  $('sel-tags').addEventListener('click', () => openBulk('tags'));
  $('sel-delete').addEventListener('click', deleteSelected);
  $('sel-cancel').addEventListener('click', clearSelection);
  $('bulk-ok').addEventListener('click', () => applyBulk(false));
  $('bulk-nofolder').addEventListener('click', () => applyBulk(true));
  $('bulk-cancel').addEventListener('click', () => $('bulk-dialog').close());
  $('bulk-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyBulk(false); } });
  $('dupes-clean').addEventListener('click', cleanAllDupes);
  $('dupes-close').addEventListener('click', () => $('dupes-dialog').close());
  $('btn-help').addEventListener('click', () => $('help-dialog').showModal());
  $('help-close').addEventListener('click', () => $('help-dialog').close());

  $('v-close').addEventListener('click', () => closeViewer());
  $('v-prev').addEventListener('click', () => step(-1));
  $('v-next').addEventListener('click', () => step(1));
  $('v-reset').addEventListener('click', () => viewer.resetView());
  $('v-wire').addEventListener('click', (e) => {
    viewer.setWireframe(!viewer.wireframe);
    e.currentTarget.classList.toggle('on', viewer.wireframe);
  });
  $('d-save').addEventListener('click', () => saveCurrent());
  $('d-fav').addEventListener('click', toggleFav);
  $('d-delete').addEventListener('click', deleteCurrent);
  $('d-download').addEventListener('click', downloadCurrent);
  fields.tags().addEventListener('input', renderSuggestions);
  fields.title().addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    await saveCurrent();
  });

  window.addEventListener('popstate', () => closeViewer({ fromPop: true }));
  window.addEventListener('keydown', (e) => {
    if ($('viewer').hidden) {
      if (e.key === 'Escape' && state.selected.size && !document.querySelector('dialog[open]')) clearSelection();
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
    if (e.key === 'Escape') closeViewer();
    else if (!typing && e.key === 'ArrowLeft') step(-1);
    else if (!typing && e.key === 'ArrowRight') step(1);
  });

  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  $('set-lang').addEventListener('change', async (e) => { await setLang(e.target.value); render(); openSettings(); });
  $('set-theme').addEventListener('change', (e) => {
    localStorage.setItem('ml.theme', e.target.value);
    applyTheme(e.target.value);
  });
  $('set-rebuild').addEventListener('click', rebuildThumbs);
  $('disk-link').addEventListener('click', () => linkFolder({ pick: true }).catch((e) => toast(diskMessage(e))));
  $('disk-rescan').addEventListener('click', () => linkFolder({ pick: false }).catch((e) => toast(diskMessage(e))));
  $('disk-unlink').addEventListener('click', unlinkFolder);
  $('disk-sync').addEventListener('change', (e) => toggleDiskSync(e.target.checked));
  $('set-export-full').addEventListener('click', () => doExport(true));
  $('set-export-meta').addEventListener('click', () => doExport(false));
  $('set-import').addEventListener('click', () => $('import-input').click());
  $('import-input').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) doImportBackup(f);
  });

  // drag and drop (files and folders)
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; $('dropzone').hidden = false; } });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $('dropzone').hidden = true; } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').hidden = true;
    handleFiles(await filesFromDrop(e.dataTransfer));
  });
}

async function init() {
  try { applyTheme(localStorage.getItem('ml.theme') || 'auto'); } catch {}
  await setLang(detectLang());

  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      queue.prioritise(en.target.dataset.id);
      observer.unobserve(en.target);
    }
  }, { rootMargin: '200px' });

  // phones often hide files whose type they do not know when an accept list is set
  if (matchMedia('(pointer: coarse)').matches) $('file-input').removeAttribute('accept');
  wire();
  await loadRoot();
  state.models = await getAllModels();
  render();
  queueMissingThumbs();
  // first visit: show the short explanation once
  try {
    if (!state.models.length && !localStorage.getItem('ml.helpSeen')) {
      localStorage.setItem('ml.helpSeen', '1');
      $('help-dialog').showModal();
    }
  } catch {}

  const oldest = state.models.reduce((min, m) => Math.min(min, m.added), Date.now());
  const reference = lastBackup() || oldest;
  if (state.models.length >= 5 && Date.now() - reference > 30 * DAY) toast(t('backup.reminder'), 6000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker failed', err));
  }
}

init();
