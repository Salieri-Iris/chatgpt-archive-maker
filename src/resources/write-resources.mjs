import fs from 'node:fs';
import path from 'node:path';
import { createSourceCopier } from './source-index.mjs';

export function writeResourceArtifacts(resourceMap, outputRoot) {
  const imageCopyResult = copyImageResources(resourceMap.imageResources, outputRoot);
  const attachmentCopyResult = copyMatchedAttachments(resourceMap.nonImageAttachments, outputRoot);
  writeFilesReadme(outputRoot, resourceMap);
  writePublicResourceMap(resourceMap, outputRoot);
  return { imageCopyResult, attachmentCopyResult };
}

export function copyImageResources(imageResources, outputRoot) {
  let copied = 0;
  let alreadyPresent = 0;
  const missing = [];
  const copier = createSourceCopier();
  try {
    for (const resource of imageResources) {
      if (!resource.source || !resource.outputRelativePath) {
        missing.push(resource.resourceId);
        continue;
      }
      const destination = path.join(outputRoot, resource.outputRelativePath);
      if (fileAlreadyMatches(destination, resource.source.size)) {
        alreadyPresent += 1;
        continue;
      }
      copier.copy(resource.source, destination);
      copied += 1;
    }
  } finally {
    copier.dispose();
  }
  return { copied, alreadyPresent, missing };
}

export function copyMatchedAttachments(nonImageAttachments, outputRoot) {
  let copied = 0;
  let alreadyPresent = 0;
  const placeholders = [];
  const copier = createSourceCopier();
  try {
    for (const attachment of nonImageAttachments) {
      if (!attachment.source || !attachment.outputRelativePath) {
        placeholders.push(attachment.placeholderId);
        continue;
      }
      const destination = path.join(outputRoot, attachment.outputRelativePath);
      if (fileAlreadyMatches(destination, attachment.source.size)) {
        alreadyPresent += 1;
        continue;
      }
      copier.copy(attachment.source, destination);
      copied += 1;
    }
  } finally {
    copier.dispose();
  }
  return { copied, alreadyPresent, placeholders };
}

function writeFilesReadme(outputRoot, resourceMap) {
  const filesDir = path.join(outputRoot, 'assets', 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  const lines = [
    '# 附件目录',
    '',
    '这里保存能够从导出包中定位到实体文件的非图片附件。',
    '',
    `本次非图片附件记录：${resourceMap.summary.nonImageAttachmentCount}`,
    `未匹配、仅生成占位的附件：${resourceMap.summary.unmatchedNonImageAttachmentCount}`,
    ''
  ];
  fs.writeFileSync(path.join(filesDir, 'README.md'), lines.join('\n'), 'utf8');
}

function writePublicResourceMap(resourceMap, outputRoot) {
  const dataDir = path.join(outputRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'resource-map.json'),
    `${JSON.stringify(publicResourceMap(resourceMap), null, 2)}\n`,
    'utf8'
  );
}

function publicResourceMap(resourceMap) {
  return {
    generatedAt: resourceMap.generatedAt,
    summary: resourceMap.summary,
    images: resourceMap.imageResources.map((resource) => ({
      resourceId: resource.resourceId,
      sourceKind: resource.source?.sourceKind || null,
      sourceRelativePath: resource.source?.relativePath || null,
      sourceSize: resource.source?.size || null,
      outputRelativePath: resource.outputRelativePath,
      occurrenceCount: resource.occurrenceCount,
      placementIds: resource.placementIds,
      missing: resource.missing
    })),
    unmatchedNonImageAttachments: resourceMap.unmatchedNonImageAttachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
      conversationId: attachment.conversationId,
      conversationTitle: attachment.conversationTitle,
      nodeId: attachment.nodeId,
      messageId: attachment.messageId,
      role: attachment.role,
      isCurrentPath: attachment.isCurrentPath,
      placeholderId: attachment.placeholderId,
      matchAttemptSummary: attachment.matchAttemptSummary
    }))
  };
}

function fileAlreadyMatches(filePath, expectedSize) {
  if (!fs.existsSync(filePath)) return false;
  if (expectedSize == null) return true;
  return fs.statSync(filePath).size === expectedSize;
}
