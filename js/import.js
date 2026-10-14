import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { isModelFile, extOf } from './loaders.js';
import { addModel, updateModel } from './db.js';

/** Collect File objects from a drop event, including dropped folders. */
export async function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dataTransfer.files];

  const out = [];
  const walk = async (entry, path) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, folder: path });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, path ? `${path}/${entry.name}` : entry.name);
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out.map((o) => Object.assign(o.file, { _folder: o.folder }));
}

const ZIP_NAME = /\.zip(\.txt)?$/i;

/**
 * Zip files that were picked directly (Tinkercad, Thingiverse and Printables hand out zips) are
 * opened: the models and .mtl colour files inside are added, named after the zip.
 * A zip that is one of our own backups is not unpacked but returned in `backups`.
 */
export async function expandZips(files) {
  const out = [];
  const backups = [];
  for (const file of files) {
    // zips found inside a folder that was added are left alone: that folder is usually already unpacked
    // a backup shared from Chrome arrives as ".zip.txt" (Chrome refuses to share .zip files)
    if (!ZIP_NAME.test(file.name) || file.webkitRelativePath || file._folder) { out.push(file); continue; }
    let entries;
    try {
      entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter: (e) => !e.name.endsWith('/') && (isModelFile(e.name) || extOf(e.name) === 'mtl' || e.name === 'catalog.json'),
      });
    } catch {
      continue; // not a readable zip
    }
    if (entries['catalog.json']) { backups.push(file); continue; }
    const stem = file.name.replace(ZIP_NAME, '');
    for (const [path, data] of Object.entries(entries)) {
      const name = path.split('/').pop();
      if (path.includes('__MACOSX/') || name.startsWith('._')) continue;
      const dir = path.split('/').slice(0, -1).join('/');
      out.push(Object.assign(new File([data], name, { lastModified: file.lastModified }), {
        _folder: dir ? `${stem}/${dir}` : stem,
      }));
    }
  }
  return { files: out, backups };
}

/**
 * Add files to the library. Skips non-model files and duplicates (same name+size+modified).
 * Returns { added: meta[], dupes, skipped }.
 */
export async function importFiles(files, existing, onProgress) {
  const list = [...files].filter((f) => f && f.name);
  const models = list.filter((f) => isModelFile(f.name));
  // .mtl files carry the OBJ colours; they are not models themselves but get attached to their OBJ.
  // Tinkercad names every colour file "obj.mtl", so they are matched per folder, not just by name.
  const mtlList = list.filter((f) => extOf(f.name) === 'mtl');
  const known = new Map(existing.map((m) => [`${m.name}|${m.size}|${m.lastModified}`, m]));
  const result = { added: [], updated: [], dupes: 0, missingMtl: 0, skipped: list.length - models.length - mtlList.length };

  let done = 0;
  for (const file of models) {
    const key = `${file.name}|${file.size}|${file.lastModified}`;
    let mtl = '';
    if (file.name.toLowerCase().endsWith('.obj')) {
      const found = await findMtl(file, mtlList);
      mtl = found.text;
      if (found.wanted && !mtl) result.missingMtl++;
    }
    const match = known.get(key);
    if (match) {
      if (mtl && mtl !== match.mtl) {
        // Same OBJ added earlier without (or with other) colours: attach them and rebuild the preview.
        const updated = { ...match, mtl, hasThumb: false, thumbFailed: false };
        await updateModel(updated);
        result.updated.push(updated);
      } else {
        result.dupes++;
      }
    } else {
      // files that come from the linked disk folder: the first sub folder becomes the app folder
      const folder = file._path ? '' : folderOf(file);
      const meta = {
        id: crypto.randomUUID(),
        name: file.name,
        ext: extOf(file.name),
        size: file.size,
        lastModified: file.lastModified,
        title: '',
        folder: file._path?.length > 1 ? file._path[0] : '',
        tags: folder ? [folder] : [],
        note: '',
        fav: false,
        added: Date.now(),
        dims: null,
        hasThumb: false,
        thumbFailed: false,
        ...(mtl ? { mtl } : {}),
        ...(file._path ? { path: file._path } : {}),
      };
      await addModel(meta, file);
      known.set(key, meta);
      result.added.push(meta);
    }
    done++;
    onProgress?.(done, models.length);
  }
  return result;
}

/** Folder a file came from ('' when unknown), however it was added. */
function dirOf(file) {
  if (file._path) return file._path.slice(0, -1).join('/');
  if (file._folder !== undefined) return file._folder;
  return file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : '';
}

/**
 * Look up the .mtl an OBJ points to (mtllib line) among the files added together.
 * The one in the same folder wins. A same-named file elsewhere is only used when it is the
 * only candidate, so two folders that both hold an "obj.mtl" can never swap colours.
 * Returns { wanted, text }: wanted is the referenced file name, text its contents ('' if not found).
 */
async function findMtl(objFile, mtlList) {
  const head = await objFile.slice(0, 65536).text();
  const m = head.match(/^mtllib\s+(.+)$/m);
  if (!m) return { wanted: '', text: '' };
  const wanted = m[1].trim().split(/[\\/]/).pop().toLowerCase();
  const sameName = mtlList.filter((f) => f.name.toLowerCase() === wanted);
  const dir = dirOf(objFile).toLowerCase();
  const file = sameName.find((f) => dirOf(f).toLowerCase() === dir) ?? (sameName.length === 1 ? sameName[0] : null);
  return { wanted, text: file ? await file.text() : '' };
}

// Folder names that say nothing about the model, so they are not turned into tags.
const GENERIC_FOLDERS = new Set([
  'downloads', 'download', 'files', 'file', 'documents', 'documenten', 'desktop', 'bureaublad',
  'models', 'model', 'modellen', 'stl', 'stls', 'stl files', 'stl-files', 'obj', 'objs', '3mf', '3mfs',
  '3d', '3d models', '3d printing', '3d print', '3dprint', '3d-print', 'prints', 'print', 'printing',
  'new folder', 'nieuwe map', 'temp', 'tmp', 'untitled', 'misc', 'diversen', 'various', 'other', 'overig',
  'onedrive', 'dropbox', 'google drive', 'mijn drive', 'my drive', 'pictures', 'afbeeldingen', 'data', 'src',
]);

/** Last folder name of a file's path, lower-case, or '' when missing or generic. */
function folderOf(file) {
  const path = file._folder || (file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(0, -1).join('/') : '');
  const name = path.split('/').pop().trim().toLowerCase();
  return !name || GENERIC_FOLDERS.has(name) ? '' : name;
}
