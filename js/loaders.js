import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { unzipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';

export const EXTENSIONS = ['stl', '3mf', 'obj'];
export const MAX_PREVIEW_BYTES = 150 * 1024 * 1024; // above this we skip automatic parsing

export const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
export const isModelFile = (name) => EXTENSIONS.includes(extOf(name));

const defaultMaterial = () => new THREE.MeshStandardMaterial({
  color: 0x6aa0ff, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
});

/**
 * Parse a stored file into a Y-up THREE.Group sitting on y=0 and centred on x/z.
 * Slicer files are Z-up, so everything is rotated -90deg around X.
 * Returns { object, dims } where dims = { w, d, h } in model units (mm).
 */
export async function parseModel(blob, ext, { mtl = '' } = {}) {
  let content;
  if (ext === 'stl') {
    const geo = new STLLoader().parse(await blob.arrayBuffer());
    // Many exporters write zeroed normals, so always recompute (gives flat shading per triangle).
    geo.computeVertexNormals();
    content = new THREE.Mesh(geo, defaultMaterial());
  } else if (ext === 'obj') {
    const loader = new OBJLoader();
    if (mtl) {
      // Only the colours are used: texture maps would need extra files, so drop those lines.
      const materials = new MTLLoader().parse(mtl.replace(/^\s*(map_|bump|disp|decal|refl)\S*.*$/gim, ''), '');
      materials.preload();
      loader.setMaterials(materials);
    }
    content = loader.parse(await blob.text());
    content.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
      const hasColors = !!o.geometry.getAttribute('color');
      if (mtl) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.side = THREE.DoubleSide; });
      } else if (hasColors) {
        o.material = new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
        });
      } else {
        o.material = defaultMaterial();
      }
    });
  } else if (ext === '3mf') {
    const buffer = await blob.arrayBuffer();
    content = new ThreeMFLoader().parse(buffer);
    content.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach((m) => {
        m.side = THREE.DoubleSide;
        // plain white means "no colour assigned" in most files: use the library colour instead
        if (!m.vertexColors && !m.map && m.color?.getHex() === 0xffffff) m.color.set(0x6aa0ff);
      });
    });
    try { applySlicerColours(content, buffer); } catch (err) { console.warn('Slicer colours skipped', err); }
  } else {
    throw new Error(`Unsupported format: ${ext}`);
  }

  const zUp = new THREE.Group();
  zUp.add(content);
  zUp.rotation.x = -Math.PI / 2;
  zUp.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(zUp);
  if (box.isEmpty()) throw new Error('Empty model');
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  const object = new THREE.Group();
  object.add(zUp);
  zUp.position.set(-center.x, -box.min.y, -center.z);
  object.updateMatrixWorld(true);

  return { object, dims: { w: size.x, d: size.z, h: size.y } };
}

/**
 * Bambu Studio / OrcaSlicer 3MF files keep colours outside the 3D data: each object (or part)
 * has an extruder number in Metadata/model_settings.config and the filament colours are listed
 * in Metadata/project_settings.config. Apply those colours to the meshes the loader built.
 * Scene layout from the loader: build item -> component -> meshes, in file order.
 */
function applySlicerColours(root, buffer) {
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (f) => /^Metadata\/(project_settings|model_settings|Slic3r_PE|Slic3r_PE_model)\.config$/.test(f.name)
      || f.name === '3D/3dmodel.model'
      || (f.name.startsWith('3D/Objects/') && f.name.endsWith('.model')),
  });
  if (files['Metadata/project_settings.config'] && files['Metadata/model_settings.config']) applyBambuColours(root, files);
  else if (files['Metadata/Slic3r_PE_model.config'] && files['Metadata/Slic3r_PE.config']) applyPrusaColours(root, files);
}

const HEX_COLOUR = /^#[0-9a-f]{6}/i;
const parseXml = (raw) => new DOMParser().parseFromString(strFromU8(raw), 'application/xml');

/** One shared standard material per colour. */
function materialCache() {
  const cache = new Map();
  return (hex) => {
    if (!HEX_COLOUR.test(hex || '')) return null;
    if (!cache.has(hex)) {
      cache.set(hex, new THREE.MeshStandardMaterial({
        color: hex.slice(0, 7), roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
      }));
    }
    return cache.get(hex);
  };
}

const paintNode = (node, material) => {
  if (material) node.traverse((o) => { if (o.isMesh) o.material = material; });
};

/**
 * Give every triangle of every mesh under `node` its own colour. `hexOf(tri)` returns a colour
 * or null (keep the mesh colour). Skipped when the triangle count does not match the file.
 */
function paintTriangles(node, triangleCount, hexOf) {
  node.traverse((mesh) => {
    const geo = mesh.geometry;
    if (!mesh.isMesh || !geo?.index || geo.index.count / 3 !== triangleCount) return;
    const flat = geo.toNonIndexed();
    const base = new THREE.Color(mesh.material.color ?? 0xffffff);
    const fill = new Float32Array(flat.getAttribute('position').count * 3);
    for (let tri = 0; tri < triangleCount; tri++) {
      const hex = hexOf(tri);
      const c = HEX_COLOUR.test(hex || '') ? new THREE.Color(hex.slice(0, 7)) : base;
      for (let v = 0; v < 3; v++) c.toArray(fill, (tri * 3 + v) * 3);
    }
    flat.setAttribute('color', new THREE.BufferAttribute(fill, 3));
    mesh.geometry = flat;
    mesh.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
    });
  });
}

/** Bambu Studio / OrcaSlicer: extruder per object/part, painted triangles in paint_color. */
function applyBambuColours(root, files) {
  const colours = JSON.parse(strFromU8(files['Metadata/project_settings.config'])).filament_colour;
  const modelRaw = files['3D/3dmodel.model'];
  if (!Array.isArray(colours) || !colours.length || !modelRaw) return;

  const config = parseXml(files['Metadata/model_settings.config']);
  const model = parseXml(modelRaw);

  const extruderOf = (el) => {
    const meta = [...el.children].find((c) => c.tagName === 'metadata' && c.getAttribute('key') === 'extruder');
    return meta ? parseInt(meta.getAttribute('value'), 10) : 0;
  };
  const objectCfg = new Map();
  for (const obj of config.querySelectorAll('config > object')) {
    const parts = new Map();
    for (const part of obj.querySelectorAll(':scope > part')) parts.set(part.getAttribute('id'), extruderOf(part));
    objectCfg.set(obj.getAttribute('id'), { extruder: extruderOf(obj) || 1, parts });
  }

  const components = new Map();
  for (const obj of model.querySelectorAll('resources > object')) {
    components.set(obj.getAttribute('id'), [...obj.querySelectorAll('component')].map((c) => ({
      id: c.getAttribute('objectid'),
      path: c.getAttribute('p:path'),
    })));
  }
  const items = [...model.querySelectorAll('build > item')].map((i) => i.getAttribute('objectid'));
  const materialFor = materialCache();

  // Parts painted in the slicer carry a paint_color per triangle (the extruder to use).
  const objectFiles = new Map(Object.entries(files).filter(([n]) => n.startsWith('3D/Objects/')).map(([n, d]) => [n, strFromU8(d)]));
  const paintCache = new Map();
  const paintCodes = (path, objectId) => {
    const key = `${path}#${objectId}`;
    if (!paintCache.has(key)) {
      const text = objectFiles.get((path || '').replace(/^\//, ''));
      paintCache.set(key, text?.includes('paint_color') ? triangleCodes(text, objectId, 'paint_color') : null);
    }
    return paintCache.get(key);
  };

  items.forEach((objectId, i) => {
    const item = root.children[i];
    const cfg = objectCfg.get(objectId);
    if (!item || !cfg) return;
    const parts = components.get(objectId) ?? [];
    if (!parts.length || parts.length !== item.children.length) return paintNode(item, materialFor(colours[cfg.extruder - 1]));
    parts.forEach((part, j) => {
      const node = item.children[j];
      paintNode(node, materialFor(colours[(cfg.parts.get(part.id) || cfg.extruder) - 1]));
      const codes = paintCodes(part.path, part.id);
      if (codes) paintTriangles(node, codes.length, (t) => (codes[t] ? colours[decodePaint(codes[t]) - 1] : null));
    });
  });
}

/**
 * PrusaSlicer: extruder per object and per volume (a volume is a range of triangles) in
 * Slic3r_PE_model.config, colours in Slic3r_PE.config, painted triangles in
 * slic3rpe:mmu_segmentation. Every object is a single mesh with its triangles in file order.
 */
function applyPrusaColours(root, files) {
  const modelRaw = files['3D/3dmodel.model'];
  if (!modelRaw) return;
  const ini = strFromU8(files['Metadata/Slic3r_PE.config']);
  const line = ini.match(/^;\s*extruder_colour\s*=\s*(.*)$/m)?.[1] ?? ini.match(/^;\s*filament_colour\s*=\s*(.*)$/m)?.[1] ?? '';
  const colours = line.match(/#[0-9a-fA-F]{6}/g) ?? [];
  if (!colours.length) return;

  const config = parseXml(files['Metadata/Slic3r_PE_model.config']);
  const modelText = strFromU8(modelRaw);
  const model = parseXml(modelRaw);
  const items = [...model.querySelectorAll('build > item')].map((i) => i.getAttribute('objectid'));
  const materialFor = materialCache();

  const extruderOf = (el) => {
    const meta = [...el.children].find((c) => c.tagName === 'metadata' && c.getAttribute('key') === 'extruder');
    return meta ? parseInt(meta.getAttribute('value'), 10) : 0;
  };

  items.forEach((objectId, i) => {
    const item = root.children[i];
    const obj = [...config.querySelectorAll('config > object')].find((o) => o.getAttribute('id') === objectId);
    if (!item) return;
    const objectExtruder = obj ? extruderOf(obj) || 1 : 1;
    paintNode(item, materialFor(colours[objectExtruder - 1]));

    const volumes = obj ? [...obj.querySelectorAll(':scope > volume')].map((v) => ({
      first: parseInt(v.getAttribute('firstid'), 10),
      last: parseInt(v.getAttribute('lastid'), 10),
      extruder: extruderOf(v) || objectExtruder,
    })) : [];
    const codes = modelText.includes('mmu_segmentation') ? triangleCodes(modelText, objectId, 'slic3rpe:mmu_segmentation') : null;
    const differs = volumes.some((v) => v.extruder !== objectExtruder);
    if (!codes && !differs) return;

    const count = codes?.length ?? Math.max(0, ...volumes.map((v) => v.last + 1));
    const volumeExtruder = (t) => volumes.find((v) => t >= v.first && t <= v.last)?.extruder ?? objectExtruder;
    paintTriangles(item, count, (t) => {
      const painted = codes?.[t] ? decodePaint(codes[t]) : 0;
      return colours[(painted || volumeExtruder(t)) - 1];
    });
  });
}

/** Per-triangle values of one attribute (e.g. paint_color) for an object, '' where missing. */
function triangleCodes(text, objectId, attribute) {
  const block = text.match(new RegExp(`<object[^>]*\\bid="${objectId}"[\\s\\S]*?</object>`))?.[0] ?? '';
  const attr = new RegExp(`${attribute}="([0-9A-Fa-f]+)"`);
  return [...block.matchAll(/<triangle\b[^>]*>/g)].map((m) => m[0].match(attr)?.[1] ?? '');
}

/**
 * Decode a Bambu/Prusa paint_color value (hex string, bits read from the last nibble) into the
 * extruder number of the triangle. Triangles that were split inside the slicer are approximated
 * by the state of their first sub-triangle.
 */
function decodePaint(hex) {
  const bit = (k) => {
    const nibble = hex.length - 1 - (k >> 2);
    return nibble < 0 ? 0 : (parseInt(hex[nibble], 16) >> (k & 3)) & 1;
  };
  let pos = 0;
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++) v |= bit(pos++) << i; return v; };
  const node = () => {
    if (read(2) === 0) {
      const s = read(2);
      return s === 3 ? 3 + read(4) : s;
    }
    read(2); // which side was split
    return node();
  };
  return node();
}

/**
 * Many slicer-made 3MF files embed a coloured preview image. Returns a Blob or null.
 * Prusa/Cura use Metadata/thumbnail.png; Bambu/Orca use Metadata/plate_N.png (plus variants
 * we skip: *_small, *_no_light and pick_* which is a flat false-colour map).
 */
export async function extract3mfThumbnail(blob) {
  try {
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()), {
      filter: (f) => /^Metadata\/[^/]+\.(png|jpe?g)$/i.test(f.name) && !/pick|no_light|small|top_|bottom_/i.test(f.name),
    });
    const names = Object.keys(files);
    if (!names.length) return null;
    const rank = (n) => (/thumbnail/i.test(n) ? 2 : /plate_\d+\.(png|jpe?g)$/i.test(n) ? 1 : 0);
    names.sort((a, b) => rank(b) - rank(a) || files[b].length - files[a].length);
    const best = names[0];
    const type = /\.jpe?g$/i.test(best) ? 'image/jpeg' : 'image/png';
    return new Blob([files[best]], { type });
  } catch {
    return null;
  }
}

export function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6270, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-4, 2, -3);
  scene.add(fill);
}

/** Position the camera so the whole object fits. Returns the target point. */
export function fitCamera(camera, object, dir = new THREE.Vector3(1, 0.8, 1)) {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fov = THREE.MathUtils.degToRad(camera.fov);
  const dist = (sphere.radius / Math.sin(Math.min(fov, 2 * Math.atan(Math.tan(fov / 2) * camera.aspect)) / 2)) * 1.05;
  camera.position.copy(sphere.center).addScaledVector(dir.clone().normalize(), dist);
  camera.near = Math.max(dist / 1000, 0.01);
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  camera.lookAt(sphere.center);
  return sphere.center;
}

export function disposeObject(object) {
  object.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}
