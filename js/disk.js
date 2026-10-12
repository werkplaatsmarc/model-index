// Optional two-way link with a folder on the computer (File System Access API).
// Only available in Chromium desktop browsers (Chrome, Edge). Everything here is opt-in:
// nothing touches the disk unless a folder is linked AND "also change files on disk" is on.
import { getHandle, putHandle, deleteHandle } from './db.js';
import { isModelFile, extOf } from './loaders.js';

const SYNC_KEY = 'ml.diskSync';
let root = null;

export const diskSupported = () => typeof window.showDirectoryPicker === 'function';
export const rootName = () => root?.name ?? '';
export const hasRoot = () => !!root;

export function syncEnabled() {
  try { return !!root && localStorage.getItem(SYNC_KEY) === '1'; } catch { return false; }
}

export function setSyncEnabled(on) {
  try { localStorage.setItem(SYNC_KEY, on ? '1' : '0'); } catch {}
}

export async function loadRoot() {
  if (!diskSupported()) return null;
  try { root = await getHandle('root'); } catch { root = null; }
  return root;
}

export async function pickRoot() {
  const handle = await window.showDirectoryPicker({ id: 'model-library', mode: 'readwrite' });
  await putHandle('root', handle);
  root = handle;
  return handle;
}

export async function unlinkRoot() {
  root = null;
  setSyncEnabled(false);
  await deleteHandle('root');
}

/** Must run inside a click: the browser may ask the user again after a restart. */
export async function ensureWrite() {
  if (!root) return false;
  const opts = { mode: 'readwrite' };
  if ((await root.queryPermission(opts)) === 'granted') return true;
  return (await root.requestPermission(opts)) === 'granted';
}

/** Characters Windows/macOS do not allow in file or folder names. */
export const safeName = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim();

async function dirFor(segments, create = false) {
  let dir = root;
  for (const seg of segments) dir = await dir.getDirectoryHandle(seg, { create });
  return dir;
}

async function exists(dir, name) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (err) {
    if (err.name === 'NotFoundError') return false;
    if (err.name === 'TypeMismatchError') return true; // a folder with that name
    throw err;
  }
}

/** "name.stl" -> "name (2).stl" when the name is taken. */
async function freeName(dir, name) {
  if (!(await exists(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  throw new Error('No free file name');
}

/**
 * Move and/or rename a file inside the linked folder.
 * path: ['sub', 'file.stl']; destFolder: [] for the root or ['Keuken'].
 * Returns the new path. Never overwrites: a taken name gets " (2)".
 */
export async function moveFile(path, destFolder, newName) {
  const srcDir = await dirFor(path.slice(0, -1));
  const srcName = path.at(-1);
  const source = await srcDir.getFileHandle(srcName);
  const destDir = await dirFor(destFolder, true);
  const sameDir = destFolder.join('/') === path.slice(0, -1).join('/');
  const wanted = newName ?? srcName;
  if (sameDir && wanted === srcName) return path;

  const name = await freeName(destDir, wanted);
  try {
    await source.move(destDir, name);
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') throw err;
    // browsers without FileSystemHandle.move(): copy, verify the size, then remove the original
    const file = await source.getFile();
    const target = await destDir.getFileHandle(name, { create: true });
    const writable = await target.createWritable();
    await writable.write(file);
    await writable.close();
    if ((await target.getFile()).size !== file.size) throw new Error('Copy failed, original left in place');
    await srcDir.removeEntry(srcName);
  }
  return [...destFolder, name];
}

export async function deleteFile(path) {
  const dir = await dirFor(path.slice(0, -1));
  await dir.removeEntry(path.at(-1));
}

/** Recursively list model files (and .mtl files) in the linked folder. */
export async function scan(onProgress) {
  const out = [];
  async function walk(dir, prefix) {
    for await (const [name, handle] of dir.entries()) {
      if (name.startsWith('.')) continue;
      if (handle.kind === 'directory') {
        await walk(handle, [...prefix, name]);
      } else if (isModelFile(name) || extOf(name) === 'mtl') {
        const file = await handle.getFile();
        out.push({ file, path: [...prefix, name] });
        onProgress?.(out.length);
      }
    }
  }
  await walk(root, []);
  return out;
}

/** Read access to one linked file (used to check that a file still exists). */
export async function fileExists(path) {
  try {
    const dir = await dirFor(path.slice(0, -1));
    await dir.getFileHandle(path.at(-1));
    return true;
  } catch {
    return false;
  }
}
