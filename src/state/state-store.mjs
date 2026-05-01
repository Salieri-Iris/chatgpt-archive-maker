import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { InputError } from '../lib/errors.mjs';

export const STATE_SCHEMA_VERSION = 1;

export function initializeArchiveState(archiveRoot, options = {}) {
  const paths = statePaths(archiveRoot);
  const { root, manifest: manifestPath } = paths;
  const rootExists = fs.existsSync(root);
  const manifestExists = fs.existsSync(manifestPath);

  if (rootExists && !fs.statSync(root).isDirectory()) {
    throw new InputError(`归档状态路径已经存在，但不是目录：${root}`);
  }

  if (rootExists && !manifestExists && fs.readdirSync(root).length > 0) {
    throw new InputError(`归档状态目录已经存在且不是空目录：${root}\n请选择一个空目录，或使用已经初始化过的状态库目录。`);
  }

  if (manifestExists && options.force) {
    throw new InputError('归档状态库已经存在。为了保护历史记录，init --force 不会覆盖状态库。');
  }

  if (manifestExists) {
    const manifest = loadArchiveState(root);
    ensureStateDirectories(paths);
    return { manifest, created: false };
  }

  fs.mkdirSync(root, { recursive: true });
  ensureStateDirectories(paths);

  const now = new Date().toISOString();
  const manifest = {
    schema_version: STATE_SCHEMA_VERSION,
    created_at: now,
    updated_at: now,
    generator: {
      name: 'chatgpt-archive-maker',
      state_format: 'archive-state-v1'
    },
    counts: {
      conversations: 0,
      total_conversations: 0,
      resources: 0,
      operations: 0
    },
    conversations: {},
    resources: {},
    imports: [],
    operations: [],
    last_operation_id: null
  };
  writeManifest(root, manifest);
  return { manifest, created: true };
}

export function loadArchiveState(archiveRoot) {
  const root = path.resolve(archiveRoot);
  const manifestPath = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new InputError(`没有找到归档状态库：${manifestPath}\n请先运行 init --archive <归档状态目录>。`);
  }

  const manifest = readJson(manifestPath);
  if (manifest.schema_version !== STATE_SCHEMA_VERSION) {
    throw new InputError(`不支持的归档状态版本：${manifest.schema_version}`);
  }
  validateManifestShape(manifest, manifestPath);
  return manifest;
}

export function appendOperation(archiveRoot, manifest, operation) {
  const root = path.resolve(archiveRoot);
  const now = new Date().toISOString();
  const record = {
    schema_version: STATE_SCHEMA_VERSION,
    operation_id: createOperationId(operation.type || 'operation'),
    type: operation.type || 'operation',
    created_at: now,
    summary: operation.summary || '',
    payload: operation.payload || {}
  };
  const operationPath = path.join(root, 'operations', `${record.operation_id}.json`);
  writeJsonAtomic(operationPath, record);

  manifest.updated_at = now;
  manifest.last_operation_id = record.operation_id;
  manifest.operations.push({
    operation_id: record.operation_id,
    type: record.type,
    created_at: record.created_at,
    summary: record.summary
  });
  manifest.counts.operations = manifest.operations.length;
  writeManifest(root, manifest);
  return record;
}

export function loadOperationRecord(archiveRoot, operationId) {
  const operationPath = path.join(path.resolve(archiveRoot), 'operations', `${operationId}.json`);
  if (!fs.existsSync(operationPath)) {
    throw new InputError(`找不到操作记录：${operationId}`);
  }
  const operation = readJson(operationPath);
  if (!operation || operation.schema_version !== STATE_SCHEMA_VERSION || operation.operation_id !== operationId) {
    throw new InputError(`操作记录格式错误：${operationPath}`);
  }
  return operation;
}

export function loadActiveConversationsFromState(archiveRoot, manifest = loadArchiveState(archiveRoot)) {
  const root = path.resolve(archiveRoot);
  return Object.values(manifest.conversations)
    .filter((entry) => !entry.deleted_at)
    .map((entry) => readJson(path.join(root, entry.current_version_path)));
}

export function upsertConversationVersion(archiveRoot, manifest, conversation, importRecord) {
  const root = path.resolve(archiveRoot);
  const conversationId = conversationIdOf(conversation);
  const contentHash = hashJsonValue(conversation);
  const versionId = `v-${contentHash.slice(0, 16)}`;
  const relativePath = path.posix.join('conversations', safeStateSegment(conversationId), `${versionId}.json`);
  const fullPath = path.join(root, ...relativePath.split('/'));
  const now = importRecord.imported_at;
  const existing = manifest.conversations[conversationId] || null;
  const alreadyHasVersion = Boolean(existing?.versions?.some((version) => version.version_id === versionId));

  if (!alreadyHasVersion) {
    writeJsonAtomic(fullPath, conversation);
  }

  const versionRecord = {
    version_id: versionId,
    content_hash: contentHash,
    path: relativePath,
    imported_at: now,
    import_id: importRecord.import_id,
    source_kind: importRecord.source_kind
  };

  const versions = existing?.versions ? [...existing.versions] : [];
  if (!versions.some((version) => version.version_id === versionId)) versions.push(versionRecord);

  manifest.conversations[conversationId] = {
    conversation_id: conversationId,
    title: conversation.title || '未命名会话',
    create_time: conversation.create_time ?? null,
    update_time: conversation.update_time ?? null,
    current_node: conversation.current_node || null,
    current_version_id: versionId,
    current_version_path: relativePath,
    current_hash: contentHash,
    first_imported_at: existing?.first_imported_at || now,
    last_imported_at: now,
    deleted_at: existing?.deleted_at || null,
    deleted_by_operation_id: existing?.deleted_by_operation_id || null,
    versions
  };

  if (!existing) return 'added';
  if (existing.current_hash === contentHash) return 'unchanged';
  return 'updated';
}

export function refreshManifestCounts(manifest) {
  const conversations = Object.values(manifest.conversations || {});
  manifest.counts.total_conversations = conversations.length;
  manifest.counts.conversations = conversations.filter((entry) => !entry.deleted_at).length;
  manifest.counts.resources = Object.keys(manifest.resources || {}).length;
  manifest.counts.operations = (manifest.operations || []).length;
}

export function writeManifest(archiveRoot, manifest) {
  validateManifestShape(manifest, path.join(path.resolve(archiveRoot), 'manifest.json'));
  writeJsonAtomic(path.join(path.resolve(archiveRoot), 'manifest.json'), manifest);
}

export function statePaths(archiveRoot) {
  const root = path.resolve(archiveRoot);
  return {
    root,
    manifest: path.join(root, 'manifest.json'),
    conversations: path.join(root, 'conversations'),
    resources: path.join(root, 'resources'),
    operations: path.join(root, 'operations'),
    snapshots: path.join(root, 'snapshots'),
    tmp: path.join(root, 'tmp')
  };
}

function validateManifestShape(manifest, manifestPath) {
  if (!manifest || typeof manifest !== 'object') {
    throw new InputError(`归档状态清单格式错误：${manifestPath}`);
  }
  if (manifest.schema_version !== STATE_SCHEMA_VERSION) {
    throw new InputError(`归档状态清单版本错误：${manifestPath}`);
  }
  if (!manifest.counts || typeof manifest.counts !== 'object') {
    throw new InputError(`归档状态清单缺少 counts：${manifestPath}`);
  }
  if (!manifest.conversations || typeof manifest.conversations !== 'object') {
    throw new InputError(`归档状态清单缺少 conversations：${manifestPath}`);
  }
  if (!manifest.resources || typeof manifest.resources !== 'object') {
    throw new InputError(`归档状态清单缺少 resources：${manifestPath}`);
  }
  if (!Array.isArray(manifest.operations)) {
    throw new InputError(`归档状态清单缺少 operations：${manifestPath}`);
  }
  if (!Array.isArray(manifest.imports)) {
    throw new InputError(`归档状态清单 imports 格式错误：${manifestPath}`);
  }
}

function createOperationId(type) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const safeType = String(type).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'operation';
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${stamp}-${safeType}-${suffix}`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new InputError(`无法读取归档状态 JSON：${filePath}\n${error.message}`);
  }
}

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  let fileHandle = null;
  try {
    fileHandle = fs.openSync(tempPath, 'wx');
    fs.writeFileSync(fileHandle, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(fileHandle);
    fs.closeSync(fileHandle);
    fileHandle = null;
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fileHandle !== null) {
      try {
        fs.closeSync(fileHandle);
      } catch {
        // Ignore cleanup failure and report the original write error.
      }
    }
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // Ignore cleanup failure and report the original write error.
      }
    }
    throw error;
  }
}

export function hashJsonValue(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function safeStateSegment(value) {
  const safe = String(value || 'unknown')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return safe || 'unknown';
}

function conversationIdOf(conversation) {
  return conversation.id || conversation.conversation_id || 'unknown-conversation';
}

function ensureStateDirectories(paths) {
  for (const key of ['conversations', 'resources', 'operations', 'snapshots', 'tmp']) {
    ensureDirectory(paths[key]);
  }
}

function ensureDirectory(dirPath) {
  if (fs.existsSync(dirPath)) {
    if (!fs.statSync(dirPath).isDirectory()) {
      throw new InputError(`归档状态路径已经存在，但不是目录：${dirPath}`);
    }
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true });
}
