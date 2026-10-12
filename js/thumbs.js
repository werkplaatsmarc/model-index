import * as THREE from 'three';
import { parseModel, extract3mfThumbnail, addLights, fitCamera, disposeObject, MAX_PREVIEW_BYTES } from './loaders.js';
import { getFile, putThumb, updateModel } from './db.js';

const SIZE = 360;
/** Bump when previews should be regenerated for everyone (new colours, new renderer...). */
export const THUMB_VERSION = 3;
let renderer, scene, camera;

function init() {
  if (renderer) return;
  const canvas = document.createElement('canvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.setClearColor(0x000000, 0);
  scene = new THREE.Scene();
  addLights(scene);
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
}

function renderToBlob(object) {
  init();
  scene.add(object);
  fitCamera(camera, object);
  renderer.render(scene, camera);
  scene.remove(object);
  return new Promise((resolve) => renderer.domElement.toBlob(resolve, 'image/webp', 0.85));
}

/**
 * Create (or fetch from the 3MF) a preview, store it, and record the dimensions.
 * Returns the updated meta. Never throws: on failure meta.thumbFailed is set.
 */
export async function generateThumb(meta) {
  const blob = await getFile(meta.id);
  const next = { ...meta, thumbV: THUMB_VERSION };
  try {
    if (!blob) throw new Error('File missing');
    if (blob.size > MAX_PREVIEW_BYTES) throw new Error('Too large for automatic preview');

    let thumb = null;
    if (meta.ext === '3mf') thumb = await extract3mfThumbnail(blob);

    // Always parse for the dimensions; render only if the file had no embedded preview.
    const { object, dims } = await parseModel(blob, meta.ext, { mtl: meta.mtl });
    next.dims = dims;
    if (!thumb) thumb = await renderToBlob(object);
    disposeObject(object);

    await putThumb(meta.id, thumb);
    next.hasThumb = true;
    next.thumbFailed = false;
  } catch (err) {
    console.warn('Thumbnail failed for', meta.name, err);
    next.thumbFailed = true;
  }
  await updateModel(next);
  return next;
}

/** Sequential queue so we never parse many large files at once. */
export class ThumbQueue {
  constructor({ onProgress, onDone }) {
    this.pending = [];
    this.total = 0;
    this.done = 0;
    this.running = false;
    this.onProgress = onProgress;
    this.onDone = onDone;
  }

  add(metas) {
    const known = new Set(this.pending.map((m) => m.id));
    for (const m of metas) if (!known.has(m.id)) this.pending.push(m);
    this.total = this.done + this.pending.length;
    this.onProgress?.(this.done, this.total);
    if (!this.running) this.#run();
  }

  /** Move a model to the front (e.g. it scrolled into view). */
  prioritise(id) {
    const i = this.pending.findIndex((m) => m.id === id);
    if (i > 0) this.pending.unshift(...this.pending.splice(i, 1));
  }

  async #run() {
    this.running = true;
    while (this.pending.length) {
      const meta = this.pending.shift();
      const updated = await generateThumb(meta);
      this.done++;
      this.onDone?.(updated);
      this.onProgress?.(this.done, this.total);
      // let the UI breathe between heavy parses
      await new Promise((r) => setTimeout(r, 0));
    }
    this.running = false;
    this.done = 0;
    this.total = 0;
    this.onProgress?.(0, 0);
  }
}
