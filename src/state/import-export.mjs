import fs from 'node:fs';
import path from 'node:path';
import { discoverExportInput, formatDiscoverySummary } from '../input/discover.mjs';
import { loadConversationsFromDiscovery } from '../model/load-conversations.mjs';
import { normalizeConversations, formatModelSummary } from '../model/normalize.mjs';
import { mapResources, formatResourceSummary } from '../resources/map-resources.mjs';
import { copyImageResources, copyMatchedAttachments } from '../resources/write-resources.mjs';
import { resolveExistingInputPath } from '../lib/path-utils.mjs';
import { InputError } from '../lib/errors.mjs';
import {
  appendOperation,
  hashJsonValue,
  loadArchiveState,
  refreshManifestCounts,
  statePaths,
  upsertConversationVersion
} from './state-store.mjs';
import { mergeResourceManifest } from './resource-state.mjs';

export function importExportIntoState({ archiveRoot, inputPath, logger }) {
  const resolvedInputPath = resolveExistingInputPath(inputPath);
  const manifest = loadArchiveState(archiveRoot);
  const paths = statePaths(archiveRoot);
  const discovery = discoverExportInput(resolvedInputPath);
  logger.info(formatDiscoverySummary(discovery));
  if (!discovery.hasConversationData) {
    throw new InputError(
      [
        '没有找到 conversations.json 或包含它的对话包，无法导入状态库。',
        `输入类型：${discovery.inputKind}`,
        discovery.filesZips.length > 0 ? '检测到 Files__...zip，但它只能作为附件补充输入。' : null
      ].filter(Boolean).join('\n')
    );
  }

  const conversations = loadConversationsFromDiscovery(discovery);
  const importRecord = createImportRecord(resolvedInputPath, discovery, conversations);
  const counts = { added: 0, updated: 0, unchanged: 0 };

  for (const conversation of conversations) {
    const result = upsertConversationVersion(archiveRoot, manifest, conversation, importRecord);
    counts[result] += 1;
  }

  const model = normalizeConversations(conversations, { timezone: 'UTC', sourceExportRoot: resolvedInputPath });
  logger.info(formatModelSummary(model));
  const resourceMap = mapResources(model, discovery);
  logger.info(formatResourceSummary(resourceMap));
  const resourceCopy = copyResourcesIntoState(paths.resources, resourceMap);
  mergeResourceManifest(manifest, resourceMap);

  manifest.imports.push({
    ...importRecord,
    counts,
    resource_summary: resourceMap.summary,
    resource_copy: resourceCopy
  });
  refreshManifestCounts(manifest);
  const operation = appendOperation(archiveRoot, manifest, {
    type: 'import-export',
    summary: `从 OpenAI 导出包导入 ${conversations.length} 个会话。`,
    payload: {
      import_id: importRecord.import_id,
      input_kind: discovery.inputKind,
      counts,
      resource_summary: resourceMap.summary
    }
  });

  return { archiveRoot, manifest, importRecord, counts, resourceMap, resourceCopy, operation };
}

function createImportRecord(inputPath, discovery, conversations) {
  const now = new Date().toISOString();
  return {
    import_id: `import-${now.replace(/[-:.TZ]/g, '').slice(0, 14)}-${hashJsonValue({ inputPath: path.resolve(inputPath), count: conversations.length, now }).slice(0, 8)}`,
    imported_at: now,
    source_kind: 'openai-export',
    input_path: path.resolve(inputPath),
    input_kind: discovery.inputKind,
    conversation_count: conversations.length
  };
}

function copyResourcesIntoState(resourcesRoot, resourceMap) {
  fs.mkdirSync(resourcesRoot, { recursive: true });
  const imageCopyResult = copyImageResources(resourceMap.imageResources, resourcesRoot);
  const attachmentCopyResult = copyMatchedAttachments(resourceMap.nonImageAttachments, resourcesRoot);
  fs.writeFileSync(
    path.join(resourcesRoot, 'resource-map.snapshot.json'),
    `${JSON.stringify({
      generatedAt: resourceMap.generatedAt,
      summary: resourceMap.summary,
      imageResources: resourceMap.imageResources.map((resource) => ({
        resourceId: resource.resourceId,
        outputRelativePath: resource.outputRelativePath,
        missing: resource.missing,
        sourceKind: resource.source?.sourceKind || null,
        sourceRelativePath: resource.source?.relativePath || null
      })),
      unmatchedNonImageAttachments: resourceMap.unmatchedNonImageAttachments
    }, null, 2)}\n`,
    'utf8'
  );
  return { imageCopyResult, attachmentCopyResult };
}
