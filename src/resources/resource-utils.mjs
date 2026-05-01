import path from 'node:path';

export function addToMapArray(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

export function toPortableRelativePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

export function resourceIdFromName(name) {
  return (
    String(name || '').match(/^(file-[A-Za-z0-9]+)/)?.[1] ||
    String(name || '').match(/^(file_[0-9a-f]+)/)?.[1] ||
    null
  );
}

export function safePathSegment(value) {
  const segment = String(value || 'untitled')
    .replace(/[<>:"/\\|?*\u0000-\u001f\s]+/g, '_')
    .replace(/^\.+$/, '_')
    .slice(0, 120);
  return segment || 'untitled';
}

export function safeExtension(value) {
  const ext = String(value || '').toLowerCase();
  return /^\.[a-z0-9][a-z0-9]{0,15}$/.test(ext) ? ext : '.bin';
}

export function extensionOf(name) {
  return path.posix.extname(toPortableRelativePath(name)).toLowerCase();
}

export function sourcePriority(source) {
  if (!source) return 99;
  if (source.sourceKind === 'conversation_directory') return 0;
  if (source.sourceKind === 'conversation_zip') return 1;
  if (source.sourceKind === 'files_zip') return 2;
  return 50;
}

export function sortSources(items) {
  return [...items].sort((a, b) =>
    sourcePriority(a) - sourcePriority(b) ||
    String(a.relativePath || '').localeCompare(String(b.relativePath || '')) ||
    String(a.name || '').localeCompare(String(b.name || '')) ||
    Number(a.size || 0) - Number(b.size || 0)
  );
}
