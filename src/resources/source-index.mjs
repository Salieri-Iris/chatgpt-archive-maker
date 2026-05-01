import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractZipEntryToFile, listZipEntries } from '../input/zip-utils.mjs';
import { addToMapArray, extensionOf, resourceIdFromName, sortSources, toPortableRelativePath } from './resource-utils.mjs';

export function buildResourceSourceIndex(discovery) {
  const sources = [
    ...conversationDirectorySources(discovery.conversationDirs || []),
    ...zipCandidateSources(discovery.conversationZips || [], 'conversation_zip'),
    ...zipCandidateSources(discovery.filesZips || [], 'files_zip')
  ];

  const byId = new Map();
  const bySize = new Map();
  const byName = new Map();
  for (const source of sources) {
    addToMapArray(byId, resourceIdFromName(source.name), source);
    addToMapArray(bySize, String(source.size), source);
    addToMapArray(byName, String(source.name || '').toLowerCase(), source);
  }

  sortMapValues(byId);
  sortMapValues(bySize);
  sortMapValues(byName);
  return { sources: sortSources(sources), byId, bySize, byName };
}

function conversationDirectorySources(conversationDirs) {
  const out = [];
  for (const dir of conversationDirs) {
    out.push(...walkFiles(dir.path, dir.path).map((file) => ({
      sourceKind: 'conversation_directory',
      copyKind: 'file',
      fullPath: file.fullPath,
      relativePath: file.relativePath,
      name: file.name,
      size: file.size,
      extension: extensionOf(file.name)
    })));
  }
  return out;
}

function zipCandidateSources(candidates, sourceKind) {
  const out = [];
  for (const candidate of candidates) {
    if (candidate.sourceKind === 'zip_file') {
      out.push(...zipFileSources(candidate.path, sourceKind, candidate.relativePath));
    } else if (candidate.sourceKind === 'zip_entry') {
      out.push(...nestedZipEntrySources(candidate, sourceKind));
    }
  }
  return out;
}

function zipFileSources(zipPath, sourceKind, containerRelativePath) {
  return listZipEntries(zipPath)
    .filter((entry) => isFileEntry(entry.fullName))
    .map((entry) => sourceFromZipEntry({
      sourceKind,
      copyKind: 'zip_entry',
      zipPath,
      entryName: entry.fullName,
      containerRelativePath,
      entryLength: entry.length
    }));
}

function nestedZipEntrySources(candidate, sourceKind) {
  const [outerZipPath, innerEntryName] = splitZipReference(candidate.path);
  return withTemporaryNestedZip(outerZipPath, innerEntryName, (tempZipPath) => (
    listZipEntries(tempZipPath)
      .filter((entry) => isFileEntry(entry.fullName))
      .map((entry) => sourceFromZipEntry({
        sourceKind,
        copyKind: 'nested_zip_entry',
        outerZipPath,
        innerEntryName,
        entryName: entry.fullName,
        containerRelativePath: candidate.relativePath,
        entryLength: entry.length
      }))
  ));
}

function sourceFromZipEntry({ sourceKind, copyKind, zipPath = null, outerZipPath = null, innerEntryName = null, entryName, containerRelativePath, entryLength }) {
  const relativePath = toPortableRelativePath(entryName);
  const name = path.posix.basename(relativePath);
  return {
    sourceKind,
    copyKind,
    zipPath,
    outerZipPath,
    innerEntryName,
    entryName,
    containerRelativePath: toPortableRelativePath(containerRelativePath),
    relativePath,
    name,
    size: Number(entryLength) || 0,
    extension: extensionOf(name)
  };
}

function walkFiles(dir, rootDir = dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(fullPath, rootDir));
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      out.push({
        fullPath,
        relativePath: toPortableRelativePath(path.relative(rootDir, fullPath)),
        name: entry.name,
        size: stat.size
      });
    }
  }
  return out;
}

function isFileEntry(fullName) {
  const portable = toPortableRelativePath(fullName);
  return Boolean(portable && path.posix.basename(portable));
}

function sortMapValues(map) {
  for (const [key, values] of map.entries()) {
    map.set(key, sortSources(values));
  }
}

export function copySourceToFile(source, targetFile) {
  const copier = createSourceCopier();
  try {
    copier.copy(source, targetFile);
  } finally {
    copier.dispose();
  }
}

export function createSourceCopier() {
  const nestedZipCache = new Map();
  return {
    copy(source, targetFile) {
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });
      if (source.copyKind === 'file') {
        fs.copyFileSync(source.fullPath, targetFile);
        return;
      }
      if (source.copyKind === 'zip_entry') {
        extractZipEntryToFile(source.zipPath, source.entryName, targetFile);
        return;
      }
      if (source.copyKind === 'nested_zip_entry') {
        const tempZipPath = cachedNestedZipPath(source, nestedZipCache);
        extractZipEntryToFile(tempZipPath, source.entryName, targetFile);
        return;
      }
      throw new Error(`不支持的资源复制来源：${source.copyKind}`);
    },
    dispose() {
      for (const item of nestedZipCache.values()) removeTemporaryFile(item.tempZipPath, item.tempDir);
      nestedZipCache.clear();
    }
  };
}

function cachedNestedZipPath(source, nestedZipCache) {
  const key = `${source.outerZipPath}::${source.innerEntryName}`;
  if (nestedZipCache.has(key)) return nestedZipCache.get(key).tempZipPath;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-maker-resource-'));
  const tempZipPath = path.join(tempDir, 'nested.zip');
  extractZipEntryToFile(source.outerZipPath, source.innerEntryName, tempZipPath);
  nestedZipCache.set(key, { tempDir, tempZipPath });
  return tempZipPath;
}

function withTemporaryNestedZip(outerZipPath, innerEntryName, callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-maker-resource-'));
  const tempZipPath = path.join(tempDir, 'nested.zip');
  try {
    extractZipEntryToFile(outerZipPath, innerEntryName, tempZipPath);
    return callback(tempZipPath);
  } finally {
    removeTemporaryFile(tempZipPath, tempDir);
  }
}

function removeTemporaryFile(tempZipPath, tempDir) {
  try {
    if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
  } catch {
    // 临时文件清理失败不影响主流程。
  }
  try {
    fs.rmdirSync(tempDir);
  } catch {
    // 临时目录由系统后续清理。
  }
}

function splitZipReference(value) {
  const marker = '::';
  const index = String(value).indexOf(marker);
  if (index < 0) throw new Error(`zip 条目引用格式错误：${value}`);
  return [String(value).slice(0, index), String(value).slice(index + marker.length)];
}
