import fs from 'node:fs';
import path from 'node:path';
import { createChatgptClient, fetchAllConversationItems, maybeDelay, sessionIdFromInput } from '../live/chatgpt-client.mjs';
import { safeExtension, safePathSegment } from '../resources/resource-utils.mjs';
import { InputError, UsageError } from '../lib/errors.mjs';
import {
  appendOperation,
  hashJsonValue,
  loadArchiveState,
  refreshManifestCounts,
  statePaths,
  upsertConversationVersion
} from './state-store.mjs';

export async function fetchCurrentConversationIntoState({ archiveRoot, options, logger }) {
  const sessionId = options.sessionId || sessionIdFromInput(options.input);
  if (!sessionId) {
    throw new UsageError('命令 fetch-current 需要 --session-id <id>，或用 --input 提供 ChatGPT 会话链接。');
  }

  const client = createChatgptClient(options);
  const manifest = loadArchiveState(archiveRoot);
  logger.info(`正在获取指定会话：${sessionId}`);
  const conversation = normalizeFetchedConversation(await client.fetchConversation(sessionId), sessionId);
  const result = await importFetchedConversation({ archiveRoot, manifest, conversation, client, options, logger });

  const operation = appendOperation(archiveRoot, manifest, {
    type: 'import-session',
    summary: `从 ChatGPT Web 获取并导入单个会话：${conversation.title || result.conversationId}。`,
    payload: {
      import_id: result.importRecord.import_id,
      session_id: result.conversationId,
      result: result.result,
      source_kind: 'chatgpt-web-api',
      previous_conversation_entry: result.previousConversationEntry,
      next_conversation_entry: result.nextConversationEntry,
      previous_resource_entries: result.previousResourceEntries,
      created_resource_files: result.createdResourceFiles,
      previous_imports_length: result.previousImportsLength,
      resource_summary: result.resourceSummary
    }
  });

  return { archiveRoot, manifest, operation, ...result };
}

export async function fetchAllConversationsIntoState({ archiveRoot, options, logger }) {
  const client = createChatgptClient(options);
  const manifest = loadArchiveState(archiveRoot);
  const items = await fetchAllConversationItems(client, { limit: options.limit });
  if (items.length === 0) throw new InputError('没有从 ChatGPT Web 获取到任何会话。');

  logger.info(`会话列表获取完成：${items.length} 个。`);
  const importRecord = createFetchImportRecord('fetch-all', items.length);
  const counts = { added: 0, updated: 0, unchanged: 0, failed: 0 };
  const failures = [];
  const sessions = [];
  let resourceCopied = 0;
  let resourceAlreadyPresent = 0;
  let resourceFailed = 0;

  for (let index = 0; index < items.length; index += 1) {
    const id = items[index]?.id;
    if (!id) continue;
    try {
      logger.info(`正在获取会话 ${index + 1}/${items.length}：${id}`);
      const conversation = normalizeFetchedConversation(await client.fetchConversation(id), id);
      const result = await importFetchedConversation({ archiveRoot, manifest, conversation, client, options, logger, importRecord });
      counts[result.result] += 1;
      resourceCopied += result.resourceDownload.copied;
      resourceAlreadyPresent += result.resourceDownload.alreadyPresent;
      resourceFailed += result.resourceDownload.failed.length;
      sessions.push({ session_id: result.conversationId, result: result.result });
      await maybeDelay(client.delayMs);
    } catch (error) {
      counts.failed += 1;
      failures.push({ session_id: id, message: error.message });
    }
  }

  manifest.imports.push({
    ...importRecord,
    conversation_count: sessions.length,
    counts,
    failures,
    resource_copy: {
      copied: resourceCopied,
      already_present: resourceAlreadyPresent,
      failed: resourceFailed,
      skipped: Boolean(options.skipResources)
    }
  });
  refreshManifestCounts(manifest);

  const operation = appendOperation(archiveRoot, manifest, {
    type: 'fetch-all',
    summary: `从 ChatGPT Web 获取并导入 ${sessions.length} 个会话。`,
    payload: {
      import_id: importRecord.import_id,
      counts,
      sessions,
      failures
    }
  });

  return { archiveRoot, manifest, operation, importRecord, counts, sessions, failures };
}

async function importFetchedConversation({ archiveRoot, manifest, conversation, client, options, logger, importRecord = null }) {
  const conversationId = conversationIdOf(conversation);
  const record = importRecord || createFetchImportRecord('fetch-current', 1);
  const previousConversationEntry = cloneJson(manifest.conversations[conversationId] || null);
  const previousImportsLength = manifest.imports.length;
  const resourceDownload = options.skipResources
    ? emptyResourceDownload(true)
    : await downloadConversationResources({ archiveRoot, manifest, conversation, client, logger });
  const previousResourceEntries = resourceDownload.previousResourceEntries;
  const result = upsertConversationVersion(archiveRoot, manifest, conversation, record);
  const nextConversationEntry = cloneJson(manifest.conversations[conversationId] || null);

  if (!importRecord) {
    manifest.imports.push({
      ...record,
      session_id: conversationId,
      result,
      resource_copy: resourceDownload.publicSummary
    });
  }
  refreshManifestCounts(manifest);

  return {
    conversationId,
    importRecord: record,
    result,
    previousConversationEntry,
    nextConversationEntry,
    previousResourceEntries,
    createdResourceFiles: resourceDownload.createdResourceFiles,
    previousImportsLength,
    resourceDownload,
    resourceSummary: resourceDownload.publicSummary
  };
}

async function downloadConversationResources({ archiveRoot, manifest, conversation, client, logger }) {
  const ids = collectImageResourceIds(conversation);
  const previousResourceEntries = capturePreviousResourceEntries(manifest, ids);
  const paths = statePaths(archiveRoot);
  const copied = [];
  const alreadyPresent = [];
  const failed = [];
  const createdResourceFiles = [];

  for (const id of ids) {
    try {
      const result = await downloadOneResource({ id, resourcesRoot: paths.resources, client });
      if (result.alreadyPresent) alreadyPresent.push(id);
      else {
        copied.push(id);
        if (!result.existedBefore) createdResourceFiles.push(result.outputRelativePath);
      }
      manifest.resources[id] = {
        resource_id: id,
        type: 'image',
        output_relative_path: result.outputRelativePath,
        occurrence_count: 1,
        last_seen_at: new Date().toISOString()
      };
    } catch (error) {
      failed.push({ resource_id: id, message: error.message });
    }
  }

  if (failed.length > 0) logger.warn(`有 ${failed.length} 个图片资源没有成功下载，构建时可能显示为缺失。`);

  return {
    previousResourceEntries,
    createdResourceFiles,
    copied: copied.length,
    alreadyPresent: alreadyPresent.length,
    failed,
    publicSummary: {
      copied: copied.length,
      already_present: alreadyPresent.length,
      failed: failed.length,
      skipped: false
    }
  };
}

async function downloadOneResource({ id, resourcesRoot, client }) {
  const details = await client.fetchFileDownload(id);
  if (details.status === 'error') {
    throw new InputError(details.error_message || details.error_code || `无法获取资源下载地址：${id}`);
  }
  if (!details.download_url) throw new InputError(`资源下载地址为空：${id}`);
  const response = await client.fetchUrl(details.download_url);
  const contentType = response.headers.get('content-type') || details.mime_type || details.mimedata || '';
  const extension = safeExtension(extensionFromName(details.file_name) || extensionFromMime(contentType));
  const outputRelativePath = `assets/images/${safePathSegment(id)}${extension}`;
  const destination = path.join(resourcesRoot, ...outputRelativePath.split('/'));
  const bytes = Buffer.from(await response.arrayBuffer());
  const existedBefore = fs.existsSync(destination);
  if (fs.existsSync(destination) && fs.statSync(destination).size === bytes.length) {
    return { outputRelativePath, alreadyPresent: true, existedBefore };
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, bytes);
  return { outputRelativePath, alreadyPresent: false, existedBefore };
}

function normalizeFetchedConversation(value, fallbackId) {
  if (!value || typeof value !== 'object' || !value.mapping) {
    throw new InputError(`ChatGPT Web 返回的会话格式不完整：${fallbackId}`);
  }
  return {
    ...value,
    id: value.id || value.conversation_id || fallbackId
  };
}

function createFetchImportRecord(sourceKind, conversationCount) {
  const now = new Date().toISOString();
  return {
    import_id: `${sourceKind}-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${hashJsonValue({ sourceKind, conversationCount, now }).slice(0, 8)}`,
    imported_at: now,
    source_kind: 'chatgpt-web-api',
    input_path: 'chatgpt-web-api',
    conversation_count: conversationCount
  };
}

function collectImageResourceIds(conversation) {
  const ids = [];
  for (const node of Object.values(conversation.mapping || {})) {
    const message = node?.message;
    if (!message) continue;
    const content = message.content || {};
    if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
          ids.push(...idsFromPointer(part.asset_pointer));
        }
      }
    }
    ids.push(...idsFromPointer(content.screenshot?.asset_pointer));
    for (const reference of message.metadata?.content_references || []) ids.push(...nestedAssetIds(reference.asset_pointer_links || []));
    for (const citation of message.metadata?.citations || []) ids.push(...nestedAssetIds(citation.metadata?.asset_pointer_links || []));
    for (const item of message.metadata?.aggregate_result?.messages || []) {
      if (item.message_type === 'image') ids.push(...idsFromPointer(item.image_url));
    }
  }
  return [...new Set(ids)].sort();
}

function idsFromPointer(value) {
  const text = String(value || '');
  const ids = [];
  for (const match of text.matchAll(/file-service:\/\/(file-[A-Za-z0-9]+)/g)) ids.push(match[1]);
  for (const match of text.matchAll(/file-service:\/\/(file_[0-9a-f]+)/g)) ids.push(match[1]);
  for (const match of text.matchAll(/sediment:\/\/(file-[A-Za-z0-9]+)/g)) ids.push(match[1]);
  for (const match of text.matchAll(/sediment:\/\/(file_[0-9a-f]+)/g)) ids.push(match[1]);
  return ids;
}

function nestedAssetIds(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') {
    out.push(...idsFromPointer(value));
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) nestedAssetIds(item, out);
    return out;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) nestedAssetIds(item, out);
  }
  return out;
}

function capturePreviousResourceEntries(manifest, ids) {
  const entries = {};
  for (const id of ids) entries[id] = cloneJson(manifest.resources?.[id] || null);
  return entries;
}

function emptyResourceDownload(skipped) {
  return {
    previousResourceEntries: {},
    createdResourceFiles: [],
    copied: 0,
    alreadyPresent: 0,
    failed: [],
    publicSummary: { copied: 0, already_present: 0, failed: 0, skipped }
  };
}

function extensionFromName(name) {
  const match = String(name || '').match(/(\.[A-Za-z0-9]{1,16})$/);
  return match ? match[1].toLowerCase() : '';
}

function extensionFromMime(mime) {
  const text = String(mime || '').toLowerCase().split(';')[0].trim();
  if (text === 'image/jpeg') return '.jpg';
  if (text === 'image/png') return '.png';
  if (text === 'image/webp') return '.webp';
  if (text === 'image/gif') return '.gif';
  return '.bin';
}

function conversationIdOf(conversation) {
  return conversation.id || conversation.conversation_id || 'unknown-conversation';
}

function cloneJson(value) {
  return value == null ? null : JSON.parse(JSON.stringify(value));
}
