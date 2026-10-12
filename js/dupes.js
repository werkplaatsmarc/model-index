import { getFile, updateModel } from './db.js';

async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Find models whose files are byte-for-byte identical.
 * Only files that share a size are hashed (cheap pre-filter), and hashes are stored on the
 * model so a second scan is instant.
 * Returns { models, groups }: the models with hashes filled in, and groups of 2+ duplicates.
 */
export async function findDuplicates(models, onProgress) {
  const bySize = new Map();
  for (const m of models) bySize.set(m.size, [...(bySize.get(m.size) ?? []), m]);
  const candidates = [...bySize.values()].filter((g) => g.length > 1).flat();

  const hashed = new Map(models.map((m) => [m.id, m]));
  let done = 0;
  for (const m of candidates) {
    if (!m.hash) {
      const blob = await getFile(m.id);
      if (blob) {
        const next = { ...m, hash: await sha256(blob) };
        await updateModel(next);
        hashed.set(m.id, next);
      }
    }
    onProgress?.(++done, candidates.length);
    await new Promise((r) => setTimeout(r, 0));
  }

  const byHash = new Map();
  for (const id of candidates.map((m) => m.id)) {
    const m = hashed.get(id);
    if (m.hash) byHash.set(m.hash, [...(byHash.get(m.hash) ?? []), m]);
  }
  return {
    models: models.map((m) => hashed.get(m.id)),
    groups: [...byHash.values()].filter((g) => g.length > 1),
  };
}

/** Which copy to keep: the one you invested most in (name, tags, note, favourite), then the oldest. */
export function pickKeeper(group) {
  const effort = (m) => (m.title ? 2 : 0) + m.tags.length + (m.note ? 1 : 0) + (m.fav ? 2 : 0);
  return [...group].sort((a, b) => effort(b) - effort(a) || a.added - b.added)[0];
}

/** Metadata of the removed copies is merged into the one that stays, so nothing you typed is lost. */
export function mergeInto(keeper, others) {
  const merged = { ...keeper };
  for (const o of others) {
    if (!merged.title && o.title) merged.title = o.title;
    if (!merged.note && o.note) merged.note = o.note;
    if (!merged.folder && o.folder) merged.folder = o.folder;
    merged.fav = merged.fav || o.fav;
    merged.tags = [...new Set([...merged.tags, ...o.tags])];
  }
  return merged;
}
