import fs from 'node:fs';
import path from 'node:path';
import { discoverExportInput, formatDiscoverySummary } from '../input/discover.mjs';
import { loadConversationsFromDiscovery } from '../model/load-conversations.mjs';
import { normalizeConversations, formatModelSummary } from '../model/normalize.mjs';
import { mapResources, formatResourceSummary } from '../resources/map-resources.mjs';
import { copyImageResources, copyMatchedAttachments } from '../resources/write-resources.mjs';
import { InputError, UsageError } from '../lib/errors.mjs';
import { resolveExistingInputPath } from '../lib/path-utils.mjs';
import {
  appendOperation,
  hashJsonValue,
  loadArchiveState,
  refreshManifestCounts,
  statePaths,
  upsertConversationVersion
} from './state-store.mjs';
import { mergeResourceManifest } from './resource-state.mjs';

export function importSessionIntoState({ archiveRoot, inputPath, sessionId, logger }) {
  const resolvedInputPath = resolveExistingInputPath(inputPath);
  const manifest = loadArchiveState(archiveRoot);
  const paths = statePaths(archiveRoot);
  const { conversation, discovery, sourceKind } = loadSessionInput({ inputPath: resolvedInputPath, sessionId, logger });
  const importRecord = createSessionImportRecord(resolvedInputPath, conversation, sourceKind);
  const conversationId = conversationIdOf(conversation);
  const previousConversationEntry = cloneJson(manifest.conversations[conversationId] || null);
  const { resourceMap, resourceCopy } = copySessionResources(paths.resources, conversation, discovery, resolvedInputPath, logger);
  const previousResourceEntries = resourceMap ? capturePreviousResourceEntries(manifest, resourceMap) : {};
  const previousImportsLength = manifest.imports.length;
  const result = upsertConversationVersion(archiveRoot, manifest, conversation, importRecord);
  const nextConversationEntry = cloneJson(manifest.conversations[conversationId] || null);

  if (resourceMap) mergeResourceManifest(manifest, resourceMap);
  manifest.imports.push({
    ...importRecord,
    session_id: conversationId,
    result,
    resource_summary: resourceMap?.summary || null,
    resource_copy: resourceCopy
  });
  refreshManifestCounts(manifest);
  const operation = appendOperation(archiveRoot, manifest, {
    type: 'import-session',
    summary: `导入单个会话：${conversation.title || conversationId}。`,
    payload: {
      import_id: importRecord.import_id,
      session_id: conversationId,
      result,
      source_kind: sourceKind,
      previous_conversation_entry: previousConversationEntry,
      next_conversation_entry: nextConversationEntry,
      previous_resource_entries: previousResourceEntries,
      previous_imports_length: previousImportsLength,
      resource_summary: resourceMap?.summary || null
    }
  });

  return {
    archiveRoot,
    manifest,
    importRecord,
    conversationId,
    result,
    resourceMap,
    resourceCopy,
    operation
  };
}

function loadSessionInput({ inputPath, sessionId, logger }) {
  const resolved = path.resolve(inputPath);
  const stat = fs.statSync(resolved);

  if (stat.isDirectory() || resolved.toLowerCase().endsWith('.zip')) {
    const discovery = discoverExportInput(resolved);
    logger.info(formatDiscoverySummary(discovery));
    if (!discovery.hasConversationData) {
      throw new InputError(
        [
          '没有找到 conversations.json 或包含它的对话包，无法从导出包导入单个会话。',
          `输入类型：${discovery.inputKind}`,
          discovery.filesZips.length > 0 ? '检测到 Files__...zip，但它只能作为附件补充输入。' : null
        ].filter(Boolean).join('\n')
      );
    }
    const conversations = loadConversationsFromDiscovery(discovery);
    if (!sessionId) {
      throw new UsageError('从完整导出包导入单个会话时必须提供 --session-id <id>。');
    }
    const conversation = conversations.find((item) => conversationIdOf(item) === sessionId);
    if (!conversation) {
      throw new InputError(`导出包中没有找到指定会话：${sessionId}`);
    }
    return { conversation, discovery, sourceKind: 'openai-export-session' };
  }

  const parsed = readJsonFile(resolved);
  const conversation = selectConversationFromJson(parsed, sessionId);
  return {
    conversation,
    discovery: discoverJsonFileResources(resolved, logger),
    sourceKind: 'conversation-json'
  };
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new InputError(`无法读取会话 JSON：${filePath}\n${error.message}`);
  }
}

function discoverJsonFileResources(jsonPath, logger) {
  if (path.basename(jsonPath).toLowerCase() !== 'conversations.json') return null;

  const discovery = discoverExportInput(path.dirname(jsonPath));
  logger.info(formatDiscoverySummary(discovery));
  return discovery;
}

function selectConversationFromJson(parsed, sessionId) {
  const conversations = Array.isArray(parsed) ? parsed : [parsed];
  const valid = conversations.filter((item) => item && typeof item === 'object' && item.mapping);
  if (valid.length === 0) {
    throw new InputError('输入 JSON 不是 ChatGPT 会话对象，也不是会话对象数组。');
  }
  if (sessionId) {
    const match = valid.find((item) => conversationIdOf(item) === sessionId);
    if (!match) throw new InputError(`输入 JSON 中没有找到指定会话：${sessionId}`);
    return match;
  }
  if (valid.length > 1) {
    throw new UsageError('输入 JSON 包含多个会话，请使用 --session-id <id> 指定其中一个。');
  }
  return valid[0];
}

function copySessionResources(resourcesRoot, conversation, discovery, inputPath, logger) {
  const emptyCopy = { imageCopyResult: { copied: 0, alreadyPresent: 0, missing: [] }, attachmentCopyResult: { copied: 0, alreadyPresent: 0, placeholders: [] } };
  if (!discovery) return { resourceMap: null, resourceCopy: emptyCopy };

  const model = normalizeConversations([conversation], { timezone: 'UTC', sourceExportRoot: path.resolve(inputPath) });
  logger.info(formatModelSummary(model));
  const resourceMap = mapResources(model, discovery);
  logger.info(formatResourceSummary(resourceMap));
  const resourceCopy = {
    imageCopyResult: copyImageResources(resourceMap.imageResources, resourcesRoot),
    attachmentCopyResult: copyMatchedAttachments(resourceMap.nonImageAttachments, resourcesRoot)
  };
  return { resourceMap, resourceCopy };
}

function createSessionImportRecord(inputPath, conversation, sourceKind) {
  const now = new Date().toISOString();
  const conversationId = conversationIdOf(conversation);
  return {
    import_id: `import-session-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${hashJsonValue({ inputPath: path.resolve(inputPath), conversationId, now }).slice(0, 8)}`,
    imported_at: now,
    source_kind: sourceKind,
    input_path: path.resolve(inputPath),
    conversation_count: 1
  };
}

function conversationIdOf(conversation) {
  return conversation.id || conversation.conversation_id || 'unknown-conversation';
}

function capturePreviousResourceEntries(manifest, resourceMap) {
  const entries = {};
  for (const id of resourceIdsFromMap(resourceMap)) {
    entries[id] = cloneJson(manifest.resources?.[id] || null);
  }
  return entries;
}

function resourceIdsFromMap(resourceMap) {
  const ids = [];
  for (const resource of resourceMap.imageResources || []) {
    if (!resource.outputRelativePath || resource.missing) continue;
    ids.push(resource.resourceId);
  }
  for (const attachment of resourceMap.nonImageAttachments || []) {
    if (!attachment.outputRelativePath || !attachment.matched) continue;
    ids.push(attachment.id || attachment.placeholderId);
  }
  return ids.filter(Boolean);
}

function cloneJson(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}
