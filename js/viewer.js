import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { parseModel, addLights, fitCamera, disposeObject } from './loaders.js';
import { getFile } from './db.js';

/** Interactive 3D view inside an existing <canvas>. One instance is reused for all models. */
export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    addLights(this.scene);
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = true;
    this.object = null;
    this.grid = null;
    this.wireframe = false;
    this.token = 0;
    this.active = false;

    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.loop = this.loop.bind(this);
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.canvas.parentElement;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.resize();
    requestAnimationFrame(this.loop);
  }

  stop() {
    this.active = false;
    this.token++;
    this.#clear();
  }

  loop() {
    if (!this.active) return;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.loop);
  }

  #clear() {
    if (this.object) {
      this.scene.remove(this.object);
      disposeObject(this.object);
      this.object = null;
    }
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid.material.dispose();
      this.grid = null;
    }
  }

  /** Load a stored model. Resolves with dims, or rejects. Stale calls are ignored (null). */
  async show(meta) {
    const token = ++this.token;
    this.#clear();
    const blob = await getFile(meta.id);
    if (!blob) throw new Error('File missing');
    const { object, dims } = await parseModel(blob, meta.ext, { mtl: meta.mtl });
    if (token !== this.token) { disposeObject(object); return null; }

    this.object = object;
    this.scene.add(object);

    const radius = Math.max(dims.w, dims.d, dims.h);
    const grid = new THREE.GridHelper(Math.ceil((radius * 2.2) / 10) * 10, 20, 0x8890a0, 0x8890a0);
    grid.material.transparent = true;
    grid.material.opacity = 0.25;
    this.grid = grid;
    this.scene.add(grid);

    this.setWireframe(this.wireframe);
    this.resetView();
    return dims;
  }

  resetView() {
    if (!this.object) return;
    const target = fitCamera(this.camera, this.object);
    this.controls.target.copy(target);
    this.controls.update();
  }

  setWireframe(on) {
    this.wireframe = on;
    this.object?.traverse((o) => {
      if (!o.isMesh) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.wireframe = on; });
    });
  }
}
