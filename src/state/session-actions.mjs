import fs from 'node:fs';
import path from 'node:path';
import {
  appendOperation,
  loadArchiveState,
  loadOperationRecord,
  refreshManifestCounts,
  statePaths,
  writeJsonAtomic,
  writeManifest
} from './state-store.mjs';
import { InputError, UsageError } from '../lib/errors.mjs';

export function listSessionsInState({ archiveRoot }) {
  const manifest = loadArchiveState(archiveRoot);
  const sessions = Object.values(manifest.conversations || {})
    .map((entry) => ({
      conversation_id: entry.conversation_id,
      title: entry.title || '未命名会话',
      status: entry.deleted_at ? 'deleted' : 'active',
      create_time: entry.create_time ?? null,
      update_time: entry.update_time ?? null,
      current_version_id: entry.current_version_id || null,
      version_count: Array.isArray(entry.versions) ? entry.versions.length : 0,
      last_imported_at: entry.last_imported_at || null,
      deleted_at: entry.deleted_at || null
    }))
    .sort(compareSessions);

  return { archiveRoot, manifest, sessions };
}

export function removeSessionFromState({ archiveRoot, sessionId }) {
  if (!sessionId) throw new UsageError('命令 remove-session 需要 --session-id <id>。');
  const manifest = loadArchiveState(archiveRoot);
  const entry = manifest.conversations?.[sessionId];
  if (!entry) throw new InputError(`状态库中没有找到指定会话：${sessionId}`);
  if (entry.deleted_at) {
    throw new InputError(`指定会话已经是删除状态：${sessionId}`);
  }

  const previousConversationEntry = cloneJson(entry);
  const deletedAt = new Date().toISOString();
  manifest.conversations[sessionId] = {
    ...entry,
    deleted_at: deletedAt,
    deleted_by_operation_id: null
  };
  refreshManifestCounts(manifest);
  const nextConversationEntry = cloneJson(manifest.conversations[sessionId]);

  const operation = appendOperation(archiveRoot, manifest, {
    type: 'remove-session',
    summary: `删除会话：${entry.title || sessionId}。`,
    payload: {
      session_id: sessionId,
      previous_conversation_entry: previousConversationEntry,
      next_conversation_entry: nextConversationEntry
    }
  });

  manifest.conversations[sessionId].deleted_by_operation_id = operation.operation_id;
  operation.payload.next_conversation_entry = cloneJson(manifest.conversations[sessionId]);
  writeOperationRecord(archiveRoot, operation);
  refreshManifestCounts(manifest);
  writeManifest(archiveRoot, manifest);

  return {
    archiveRoot,
    manifest,
    conversationId: sessionId,
    previousConversationEntry,
    operation
  };
}

export function undoLastStateOperation({ archiveRoot }) {
  const manifest = loadArchiveState(archiveRoot);
  if (!manifest.last_operation_id) {
    throw new InputError('状态库中还没有可撤销的操作。');
  }

  const targetOperation = loadOperationRecord(archiveRoot, manifest.last_operation_id);
  if (!isSupportedUndoTarget(targetOperation)) {
    throw new InputError(`最近一次操作不能自动撤销：${targetOperation.type}`);
  }

  const sessionId = targetOperation.payload?.session_id;
  if (!sessionId) throw new InputError('最近一次操作缺少会话编号，无法撤销。');

  const previousConversationEntry = targetOperation.payload.previous_conversation_entry ?? null;
  if (previousConversationEntry) {
    manifest.conversations[sessionId] = cloneJson(previousConversationEntry);
  } else {
    delete manifest.conversations[sessionId];
  }
  restoreResourceEntries(manifest, targetOperation.payload.previous_resource_entries);
  removeCreatedResourceFiles(archiveRoot, targetOperation.payload.created_resource_files);
  restoreImportList(manifest, targetOperation.payload.previous_imports_length);

  refreshManifestCounts(manifest);
  const operation = appendOperation(archiveRoot, manifest, {
    type: 'undo',
    summary: `撤销操作：${targetOperation.operation_id}。`,
    payload: {
      undone_operation_id: targetOperation.operation_id,
      undone_operation_type: targetOperation.type,
      session_id: sessionId
    }
  });

  return {
    archiveRoot,
    manifest,
    operation,
    undoneOperation: targetOperation,
    conversationId: sessionId
  };
}

function isSupportedUndoTarget(operation) {
  const payload = operation.payload || {};
  if (operation.type === 'remove-session') return isJsonObject(payload.previous_conversation_entry);
  if (operation.type !== 'import-session') return false;
  return Object.hasOwn(payload, 'previous_conversation_entry') &&
    (payload.previous_conversation_entry === null || isJsonObject(payload.previous_conversation_entry)) &&
    isJsonObject(payload.previous_resource_entries) &&
    Number.isInteger(payload.previous_imports_length) &&
    payload.previous_imports_length >= 0;
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function compareSessions(a, b) {
  if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
  return compareNullableTime(a.create_time, b.create_time)
    || String(a.title).localeCompare(String(b.title), 'zh-Hans-CN')
    || a.conversation_id.localeCompare(b.conversation_id);
}

function compareNullableTime(a, b) {
  const aa = typeof a === 'number' && Number.isFinite(a) ? a : Number.POSITIVE_INFINITY;
  const bb = typeof b === 'number' && Number.isFinite(b) ? b : Number.POSITIVE_INFINITY;
  return aa - bb;
}

function cloneJson(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}

function restoreResourceEntries(manifest, previousResourceEntries) {
  if (!previousResourceEntries || typeof previousResourceEntries !== 'object') return;
  for (const [resourceId, previousEntry] of Object.entries(previousResourceEntries)) {
    if (previousEntry) manifest.resources[resourceId] = cloneJson(previousEntry);
    else delete manifest.resources[resourceId];
  }
}

function restoreImportList(manifest, previousImportsLength) {
  if (!Number.isInteger(previousImportsLength) || previousImportsLength < 0) return;
  if (!Array.isArray(manifest.imports)) return;
  if (previousImportsLength <= manifest.imports.length) {
    manifest.imports = manifest.imports.slice(0, previousImportsLength);
  }
}

function removeCreatedResourceFiles(archiveRoot, createdResourceFiles) {
  if (!Array.isArray(createdResourceFiles) || createdResourceFiles.length === 0) return;
  const resourcesRoot = path.resolve(statePaths(archiveRoot).resources);
  for (const relativePath of createdResourceFiles) {
    const target = path.resolve(resourcesRoot, ...String(relativePath || '').split('/'));
    if (!isInsideDirectory(resourcesRoot, target)) continue;
    try {
      if (fs.existsSync(target) && fs.statSync(target).isFile()) fs.unlinkSync(target);
      removeEmptyParentDirectories(path.dirname(target), resourcesRoot);
    } catch {
      // 撤销时尽力清理新下载的资源文件；清单恢复仍然是主结果。
    }
  }
}

function removeEmptyParentDirectories(startDir, stopDir) {
  let current = path.resolve(startDir);
  const root = path.resolve(stopDir);
  while (isInsideDirectory(root, current)) {
    try {
      if (!fs.existsSync(current) || fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function isInsideDirectory(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (process.platform === 'win32') {
    return resolvedTarget.toLowerCase().startsWith(`${resolvedRoot.toLowerCase()}${path.sep}`);
  }
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function writeOperationRecord(archiveRoot, operation) {
  const operationPath = path.join(statePaths(archiveRoot).operations, `${operation.operation_id}.json`);
  writeJsonAtomic(operationPath, operation);
}
