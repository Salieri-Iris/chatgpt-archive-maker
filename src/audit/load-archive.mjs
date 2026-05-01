import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

export function loadArchiveBundle(archiveRoot) {
  const resolvedRoot = path.resolve(archiveRoot);
  const context = { window: {} };
  vm.createContext(context);
  runJsFile(path.join(resolvedRoot, 'data', 'archive-data.js'), context);
  runJsFile(path.join(resolvedRoot, 'data', 'search-index.js'), context);
  const archiveData = context.window.CHATGPT_ARCHIVE_DATA;
  const searchIndex = context.window.CHATGPT_ARCHIVE_SEARCH || [];
  if (!archiveData) throw new Error(`归档数据未加载：${resolvedRoot}`);
  return {
    archiveRoot: resolvedRoot,
    archiveData,
    searchIndex,
    manifest: readJsonIfExists(path.join(resolvedRoot, 'data', 'manifest.json')),
    resourceMap: readJsonIfExists(path.join(resolvedRoot, 'data', 'resource-map.json'))
  };
}

export function listFiles(root, predicate = () => true) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(fullPath, predicate));
    else if (entry.isFile() && predicate(fullPath)) out.push(fullPath);
  }
  return out.sort();
}

function runJsFile(filePath, context) {
  vm.runInContext(fs.readFileSync(filePath, 'utf8'), context, { filename: filePath });
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}
