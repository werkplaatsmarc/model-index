import { zipSync, unzipSync, strToU8, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { getAllModels, getFile, addModel, updateModel } from './db.js';

const FORMAT = 'model-library-backup';
const VERSION = 1;

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const markBackedUp = () => { try { localStorage.setItem('ml.lastBackup', String(Date.now())); } catch {} };

/**
 * Build the backup .zip without saving it. With files=true it holds all originals
 * (stored uncompressed: STL/3MF barely compress and it keeps memory use lower).
 * Returns { blob, filename }.
 */
export async function createBackup({ files }) {
  const models = await getAllModels();
  const catalog = {
    format: FORMAT, version: VERSION, exported: Date.now(), includesFiles: files,
    models: models.map(({ path, ...rest }) => rest), // disk paths only mean something on this computer
  };
  const zipEntries = { 'catalog.json': strToU8(JSON.stringify(catalog)) };

  if (files) {
    for (const m of models) {
      const blob = await getFile(m.id);
      if (blob) zipEntries[`files/${m.id}.${m.ext}`] = new Uint8Array(await blob.arrayBuffer());
    }
  }
  const zipped = zipSync(zipEntries, { level: 0 });
  return {
    blob: new Blob([zipped], { type: 'application/zip' }),
    filename: `model-index-${files ? 'full' : 'catalog'}-${stamp()}.zip`,
  };
}

export function downloadBackup({ blob, filename }) {
  download(blob, filename);
  markBackedUp();
}

const asFile = ({ blob, filename }) => new File([blob], filename, { type: 'application/zip' });

/** True when this browser can hand the backup file to the system share sheet. */
export function canShareBackup(backup) {
  try {
    return typeof navigator.share === 'function' && navigator.canShare?.({ files: [asFile(backup)] }) === true;
  } catch { return false; }
}

/**
 * Open the share sheet (WhatsApp, mail, Drive, Files...). Must run straight from a tap.
 * Returns true when shared, false when the user closed the sheet; throws on a real failure.
 */
export async function shareBackup(backup) {
  try {
    await navigator.share({ files: [asFile(backup)], title: backup.filename });
  } catch (err) {
    if (err?.name === 'AbortError') return false;
    throw err;
  }
  markBackedUp();
  return true;
}

/** Import a backup .zip. Existing ids are kept untouched. Returns { added, skipped }. */
export async function importBackup(file) {
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  const raw = entries['catalog.json'];
  if (!raw) throw new Error('catalog.json missing');
  const catalog = JSON.parse(strFromU8(raw));
  if (catalog.format !== FORMAT || !Array.isArray(catalog.models)) throw new Error('Not a backup');

  const current = await getAllModels();
  const byId = new Map(current.map((m) => [m.id, m]));
  const byKey = new Map(current.map((m) => [`${m.name}|${m.size}|${m.lastModified}`, m]));
  let added = 0;
  let merged = 0;
  let skipped = 0;
  for (const meta of catalog.models) {
    const key = `${meta.name}|${meta.size}|${meta.lastModified}`;
    const data = entries[`files/${meta.id}.${meta.ext}`];
    const match = byId.get(meta.id) ?? byKey.get(key);
    if (match) {
      // Same model already here: a catalog-only backup restores names/tags/notes onto it.
      if (!data) {
        await updateModel({ ...match, title: meta.title, folder: meta.folder || '', tags: meta.tags, note: meta.note, fav: meta.fav });
        merged++;
      } else {
        skipped++;
      }
    } else if (data) {
      // thumbnails are regenerated after import
      await addModel({ ...meta, path: undefined, hasThumb: false, thumbFailed: false }, new Blob([data]));
      added++;
    } else {
      skipped++; // metadata without a file and nothing to attach it to
    }
  }
  return { added, merged, skipped };
}

export const lastBackup = () => {
  try { return Number(localStorage.getItem('ml.lastBackup')) || 0; } catch { return 0; }
};
