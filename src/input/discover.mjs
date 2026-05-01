import fs from 'node:fs';
import path from 'node:path';
import { InputError } from '../lib/errors.mjs';
import { isZipPath, listZipEntries } from './zip-utils.mjs';

const optionalKnownFiles = new Set([
  'shared_conversations.json',
  'group_chats.json',
  'message_feedback.json',
  'library_files.json',
  'user.json',
  'user_settings.json',
  'export_manifest.json',
  'chat.html',
  'report.html',
  'emails sent.csv',
  'charge history.csv',
  'payment subscriptions.csv',
  'payments invoices.csv',
  'payments customer profile.csv'
]);

export function discoverExportInput(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) return discoverDirectory(resolved);
  if (stat.isFile() && isZipPath(resolved)) return discoverZip(resolved);
  if (stat.isFile()) {
    throw new InputError(`输入文件不是 zip，也不是可识别的导出目录：${resolved}`);
  }
  throw new InputError(`输入路径类型不可识别：${resolved}`);
}

function discoverDirectory(rootDir) {
  const files = walkFiles(rootDir);
  const directories = walkDirectories(rootDir);
  const conversationJsons = files.filter((file) => path.basename(file).toLowerCase() === 'conversations.json')
    .map((file) => candidateFromPath(rootDir, file));
  const conversationDirs = conversationJsons.map((candidate) => ({
    path: path.dirname(candidate.path),
    relativePath: path.dirname(candidate.relativePath)
  }));
  const conversationZips = files.filter((file) => looksLikeConversationZip(file)).map((file) => zipCandidate(rootDir, file));
  const filesZips = files.filter((file) => looksLikeFilesZip(file)).map((file) => zipCandidate(rootDir, file));
  const optionalFiles = files.filter((file) => optionalKnownFiles.has(path.basename(file).toLowerCase()))
    .map((file) => candidateFromPath(rootDir, file));
  const possibleConversationDirs = directories.filter((dir) => /conversations__/i.test(path.basename(dir)))
    .map((dir) => ({
      path: dir,
      relativePath: relative(rootDir, dir),
      hasConversationsJson: fs.existsSync(path.join(dir, 'conversations.json'))
    }));

  return finalizeDiscovery({
    inputPath: rootDir,
    inputKind: 'directory',
    rootDir,
    conversationJsons,
    conversationDirs,
    possibleConversationDirs,
    conversationZips,
    filesZips,
    optionalFiles,
    zipEntries: [],
    warnings: []
  });
}

function discoverZip(zipPath) {
  const entries = listZipEntries(zipPath);
  const conversationJsonEntries = entries.filter((entry) => path.posix.basename(entry.fullName).toLowerCase() === 'conversations.json');
  const conversationZipEntries = entries.filter((entry) => looksLikeConversationZip(entry.fullName));
  const filesZipEntries = entries.filter((entry) => looksLikeFilesZip(entry.fullName));
  const optionalEntries = entries.filter((entry) => optionalKnownFiles.has(path.posix.basename(entry.fullName).toLowerCase()));
  const directConversationZip = looksLikeConversationZip(zipPath) && conversationJsonEntries.length > 0;
  const directFilesZip = looksLikeFilesZip(zipPath);
  const hasConversationShape = conversationJsonEntries.length > 0 || conversationZipEntries.length > 0 || directConversationZip;
  const hasFilesShape = directFilesZip || filesZipEntries.length > 0;
  const inputKind = hasConversationShape ? 'zip_with_conversation_data' : hasFilesShape ? 'zip_attachment_package' : 'zip';

  return finalizeDiscovery({
    inputPath: zipPath,
    inputKind,
    rootDir: null,
    conversationJsons: conversationJsonEntries.map((entry) => ({
      path: `${zipPath}::${entry.fullName}`,
      relativePath: entry.fullName,
      sourceKind: 'zip_entry',
      size: entry.length
    })),
    conversationDirs: [],
    possibleConversationDirs: [],
    conversationZips: [
      ...(directConversationZip ? [zipCandidate(path.dirname(zipPath), zipPath)] : []),
      ...conversationZipEntries.map((entry) => zipEntryCandidate(zipPath, entry, 'conversations'))
    ],
    filesZips: [
      ...(directFilesZip ? [zipCandidate(path.dirname(zipPath), zipPath)] : []),
      ...filesZipEntries.map((entry) => zipEntryCandidate(zipPath, entry, 'files'))
    ],
    optionalFiles: optionalEntries.map((entry) => ({
      path: `${zipPath}::${entry.fullName}`,
      relativePath: entry.fullName,
      sourceKind: 'zip_entry',
      size: entry.length
    })),
    zipEntries: entries,
    warnings: inputKind === 'zip_attachment_package'
      ? ['该 zip 看起来只包含 Files 附件包；没有 conversations.json 或 Conversations__...zip 时不能独立生成完整归档。']
      : []
  });
}

function finalizeDiscovery(discovery) {
  const primaryConversationJson = choosePrimaryConversationJson(discovery.conversationJsons);
  const hasConversationData = Boolean(primaryConversationJson || discovery.conversationZips.length > 0);
  return {
    ...discovery,
    primaryConversationJson,
    hasConversationData,
    counts: {
      conversationJsons: discovery.conversationJsons.length,
      conversationDirs: discovery.conversationDirs.length,
      possibleConversationDirs: discovery.possibleConversationDirs.length,
      conversationZips: discovery.conversationZips.length,
      filesZips: discovery.filesZips.length,
      optionalFiles: discovery.optionalFiles.length,
      zipEntries: discovery.zipEntries.length
    }
  };
}

function choosePrimaryConversationJson(candidates) {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => candidateScore(b) - candidateScore(a))[0];
}

function candidateScore(candidate) {
  const rel = candidate.relativePath.toLowerCase();
  let score = 0;
  if (path.posix.basename(rel) === 'conversations.json') score += 10;
  if (/conversations__/.test(rel)) score += 5;
  if (/user online activity/.test(rel)) score += 2;
  if (!rel.includes('/')) score += 1;
  return score;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function walkDirectories(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(full);
      out.push(...walkDirectories(full));
    }
  }
  return out;
}

function candidateFromPath(rootDir, file) {
  return {
    path: file,
    relativePath: relative(rootDir, file),
    sourceKind: 'file',
    size: fs.statSync(file).size
  };
}

function zipCandidate(rootDir, file) {
  return {
    path: file,
    relativePath: relative(rootDir, file),
    sourceKind: 'zip_file',
    size: fs.statSync(file).size,
    role: looksLikeFilesZip(file) ? 'files' : looksLikeConversationZip(file) ? 'conversations' : 'unknown'
  };
}

function zipEntryCandidate(zipPath, entry, role) {
  return {
    path: `${zipPath}::${entry.fullName}`,
    relativePath: entry.fullName,
    sourceKind: 'zip_entry',
    size: entry.length,
    role
  };
}

function looksLikeConversationZip(file) {
  const name = path.basename(file).toLowerCase();
  return name.endsWith('.zip') && name.includes('conversations__') && name.includes('chatgpt');
}

function looksLikeFilesZip(file) {
  const name = path.basename(file).toLowerCase();
  return name.endsWith('.zip') && name.includes('files__') && name.includes('files-');
}

function relative(rootDir, value) {
  return path.relative(rootDir, value).split(path.sep).join('/');
}

export function formatDiscoverySummary(discovery) {
  const lines = [
    '导出包探测结果：',
    `  输入类型：${discovery.inputKind}`,
    `  conversations.json：${discovery.counts.conversationJsons}`,
    `  已解压对话目录：${discovery.counts.conversationDirs}`,
    `  对话 zip：${discovery.counts.conversationZips}`,
    `  附件 zip：${discovery.counts.filesZips}`,
    `  附加文件：${discovery.counts.optionalFiles}`
  ];
  if (discovery.primaryConversationJson) {
    lines.push(`  主 conversations.json：${discovery.primaryConversationJson.relativePath}`);
  }
  for (const warning of discovery.warnings || []) {
    lines.push(`  警告：${warning}`);
  }
  return lines.join('\n');
}
