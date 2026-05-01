import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InputError } from '../lib/errors.mjs';
import { extractZipEntryToFile, listZipEntries, readZipTextEntry } from '../input/zip-utils.mjs';

export function loadConversationsFromDiscovery(discovery) {
  const text = readDiscoveryConversationText(discovery);
  const conversations = JSON.parse(text);
  if (!Array.isArray(conversations)) {
    throw new InputError('conversations.json 顶层不是数组，无法继续。');
  }
  return conversations;
}

function readDiscoveryConversationText(discovery) {
  if (discovery.primaryConversationJson) return readCandidateText(discovery.primaryConversationJson);

  const conversationZip = choosePrimaryConversationZip(discovery.conversationZips || []);
  if (conversationZip) return readConversationZipText(conversationZip);

  throw new InputError('没有可读取的 conversations.json。输入必须包含 conversations.json、对话 zip，或包含对话 zip 的完整导出 zip。');
}

function readCandidateText(candidate) {
  if (candidate.sourceKind === 'file') return fs.readFileSync(candidate.path, 'utf8');
  if (candidate.sourceKind === 'zip_entry') {
    const [zipPath, entryName] = splitZipReference(candidate.path);
    return readZipTextEntry(zipPath, entryName);
  }
  throw new InputError(`不支持的 conversations.json 来源：${candidate.sourceKind}`);
}

function readConversationZipText(candidate) {
  if (candidate.sourceKind === 'zip_file') {
    return readConversationsJsonFromZip(candidate.path, candidate.relativePath);
  }
  if (candidate.sourceKind === 'zip_entry') {
    const [outerZipPath, innerEntryName] = splitZipReference(candidate.path);
    return readConversationsJsonFromNestedZip(outerZipPath, innerEntryName, candidate.relativePath);
  }
  throw new InputError(`不支持的对话 zip 来源：${candidate.sourceKind}`);
}

function readConversationsJsonFromZip(zipPath, label) {
  const entries = listZipEntries(zipPath);
  const entry = choosePrimaryConversationJsonEntry(entries, label);
  return readZipTextEntry(zipPath, entry.fullName);
}

function readConversationsJsonFromNestedZip(outerZipPath, innerEntryName, label) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-maker-'));
  const tempZipPath = path.join(tempDir, 'conversation.zip');
  try {
    extractZipEntryToFile(outerZipPath, innerEntryName, tempZipPath);
    return readConversationsJsonFromZip(tempZipPath, label || innerEntryName);
  } finally {
    removeTemporaryFile(tempZipPath, tempDir);
  }
}

function removeTemporaryFile(tempZipPath, tempDir) {
  try {
    if (fs.existsSync(tempZipPath)) fs.unlinkSync(tempZipPath);
  } catch {
    // 临时文件清理失败不应掩盖真正的读取结果或读取错误。
  }
  try {
    fs.rmdirSync(tempDir);
  } catch {
    // 临时目录只包含上面的单个文件；若系统仍占用它，交给系统临时目录清理。
  }
}

function choosePrimaryConversationZip(candidates) {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) =>
    conversationZipScore(b) - conversationZipScore(a) ||
    String(a.relativePath || '').localeCompare(String(b.relativePath || '')) ||
    String(a.path || '').localeCompare(String(b.path || ''))
  )[0];
}

function choosePrimaryConversationJsonEntry(entries, label) {
  const candidates = entries.filter((entry) => path.posix.basename(entry.fullName).toLowerCase() === 'conversations.json');
  if (candidates.length === 0) {
    throw new InputError(`对话 zip 中没有 conversations.json：${label}`);
  }
  return candidates.sort((a, b) =>
    conversationJsonEntryScore(b) - conversationJsonEntryScore(a) ||
    a.fullName.localeCompare(b.fullName)
  )[0];
}

function conversationZipScore(candidate) {
  const rel = String(candidate.relativePath || candidate.path || '').toLowerCase().replaceAll('\\', '/');
  let score = 0;
  if (/conversations__/.test(rel)) score += 10;
  if (/chatgpt/.test(rel)) score += 5;
  if (/user online activity/.test(rel)) score += 2;
  return score;
}

function conversationJsonEntryScore(entry) {
  const rel = String(entry.fullName || '').toLowerCase();
  let score = 0;
  if (path.posix.basename(rel) === 'conversations.json') score += 10;
  if (/conversations__/.test(rel)) score += 5;
  if (!rel.includes('/')) score += 1;
  return score;
}

function splitZipReference(value) {
  const marker = '::';
  const index = value.indexOf(marker);
  if (index < 0) throw new InputError(`zip 条目引用格式错误：${value}`);
  return [value.slice(0, index), value.slice(index + marker.length)];
}
