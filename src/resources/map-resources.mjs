import { safeExtension, safePathSegment, sortSources } from './resource-utils.mjs';
import { buildResourceSourceIndex } from './source-index.mjs';

export function mapResources(model, discovery) {
  const sourceIndex = buildResourceSourceIndex(discovery);
  const imagePlacements = model.imagePlacements.map((placement) => mapImagePlacement(placement, sourceIndex));
  const imageResources = deduplicateImageResources(imagePlacements);
  const nonImageAttachments = mapNonImageAttachments(model.nonImageAttachments, sourceIndex);
  const unmatchedNonImageAttachments = nonImageAttachments.filter((record) => !record.matched);
  const summary = summarizeResources({ imagePlacements, imageResources, nonImageAttachments, unmatchedNonImageAttachments });
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    summary,
    sourceInventory: {
      totalResourceSources: sourceIndex.sources.length,
      sourcesByKind: countBy(sourceIndex.sources, (source) => source.sourceKind)
    },
    imagePlacements,
    imageResources,
    nonImageAttachments,
    unmatchedNonImageAttachments
  };
}

export function enrichModelWithResources(model, resourceMap) {
  const imagePlacementById = new Map(resourceMap.imagePlacements.map((placement) => [placement.placementId, placement]));
  const attachmentByPlaceholderId = new Map(resourceMap.nonImageAttachments.map((attachment) => [attachment.placeholderId, attachment]));

  const enrichMessage = (message) => {
    const parts = message.parts.map((part) => enrichPart(part, imagePlacementById, attachmentByPlaceholderId));
    return {
      ...message,
      parts,
      search_text: parts.map(resourcePartText).join('\n').trim()
    };
  };

  return {
    ...model,
    messages: model.messages.map(enrichMessage),
    branchMessages: model.branchMessages.map(enrichMessage),
    hiddenMessages: model.hiddenMessages.map(enrichMessage),
    emptyMessages: model.emptyMessages.map(enrichMessage),
    imagePlacements: resourceMap.imagePlacements,
    resourceSummary: resourceMap.summary,
    counts: {
      ...model.counts,
      imageResources: resourceMap.summary.uniqueImageResourceCount,
      missingImageResources: resourceMap.summary.missingImageResourceCount,
      unmatchedNonImageAttachments: resourceMap.summary.unmatchedNonImageAttachmentCount
    }
  };
}

export function formatResourceSummary(resourceMap) {
  return [
    '资源映射：',
    `  图片放置点：${resourceMap.summary.imagePlacementCount}`,
    `  去重图片资源：${resourceMap.summary.uniqueImageResourceCount}`,
    `  缺失图片资源：${resourceMap.summary.missingImageResourceCount}`,
    `  非图片附件记录：${resourceMap.summary.nonImageAttachmentCount}`,
    `  未匹配非图片附件：${resourceMap.summary.unmatchedNonImageAttachmentCount}`,
    `  当前路径内未匹配非图片附件：${resourceMap.summary.unmatchedCurrentPathNonImageAttachmentCount}`
  ].join('\n');
}

function mapImagePlacement(placement, sourceIndex) {
  const chosen = chooseSourceById(placement.resourceId, sourceIndex);
  return {
    ...placement,
    source: chosen.source,
    outputRelativePath: chosen.source ? outputImagePath(placement.resourceId, chosen.source) : null,
    allMatches: chosen.allMatches
  };
}

function chooseSourceById(resourceId, sourceIndex) {
  const all = sourceIndex.byId.get(resourceId) || [];
  const sorted = sortSources(all);
  const source = sorted[0] || null;
  return {
    source,
    allMatches: {
      conversationById: sorted.filter((item) => item.sourceKind === 'conversation_directory' || item.sourceKind === 'conversation_zip'),
      filesById: sorted.filter((item) => item.sourceKind === 'files_zip')
    }
  };
}

function deduplicateImageResources(imagePlacements) {
  const byId = new Map();
  for (const placement of imagePlacements) {
    if (!byId.has(placement.resourceId)) {
      byId.set(placement.resourceId, {
        resourceId: placement.resourceId,
        source: placement.source,
        outputRelativePath: placement.outputRelativePath,
        occurrenceCount: 0,
        placementIds: [],
        missing: !placement.source
      });
    }
    const resource = byId.get(placement.resourceId);
    resource.occurrenceCount += 1;
    resource.placementIds.push(placement.placementId);
  }
  return [...byId.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId));
}

function mapNonImageAttachments(attachments, sourceIndex) {
  const usedOutputPaths = new Set();
  return attachments.map((attachment) => {
    const match = matchAttachment(attachment, sourceIndex);
    const outputRelativePath = match.source ? outputAttachmentPath(attachment, match.source, usedOutputPaths) : null;
    return {
      ...attachment,
      matched: Boolean(match.source),
      source: match.source,
      outputRelativePath,
      fileLink: outputRelativePath,
      matchAttemptSummary: match.matchAttemptSummary
    };
  });
}

function matchAttachment(record, sourceIndex) {
  const byId = record.id ? sourceIndex.byId.get(record.id) || [] : [];
  const byName = record.name ? sourceIndex.byName.get(record.name.toLowerCase()) || [] : [];
  const bySize = record.size != null ? sourceIndex.bySize.get(String(record.size)) || [] : [];
  const sortedById = sortSources(byId);
  const sortedByName = sortSources(byName);
  const sortedBySize = sortSources(bySize);
  return {
    source: sortedById[0] || sortedByName[0] || sortedBySize[0] || null,
    matchAttemptSummary: {
      conversationById: byId.filter(isConversationSource).length,
      filesById: byId.filter(isFilesSource).length,
      conversationByName: byName.filter(isConversationSource).length,
      filesByName: byName.filter(isFilesSource).length,
      conversationBySize: bySize.filter(isConversationSource).length,
      filesBySize: bySize.filter(isFilesSource).length
    }
  };
}

function summarizeResources({ imagePlacements, imageResources, nonImageAttachments, unmatchedNonImageAttachments }) {
  return {
    imagePlacementCount: imagePlacements.length,
    uniqueImageResourceCount: imageResources.length,
    missingImageResourceCount: imageResources.filter((item) => item.missing).length,
    imagePlacementsByKind: countBy(imagePlacements, (placement) => placement.kind),
    imageSourcesByKind: countBy(imageResources, (resource) => resource.source?.sourceKind || 'missing'),
    nonImageAttachmentCount: nonImageAttachments.length,
    unmatchedNonImageAttachmentCount: unmatchedNonImageAttachments.length,
    unmatchedCurrentPathNonImageAttachmentCount: unmatchedNonImageAttachments.filter((record) => record.isCurrentPath).length
  };
}

function outputImagePath(id, source) {
  return `assets/images/${safePathSegment(id)}${safeExtension(source?.extension)}`;
}

function outputAttachmentPath(record, source, usedOutputPaths) {
  const extension = safeExtension(source?.extension || fileExtensionFromName(record.name));
  const base = safePathSegment(record.id || stripExtension(record.name) || stripExtension(source?.name) || 'attachment');
  let candidate = `assets/files/${base}${extension}`;
  let counter = 2;
  while (usedOutputPaths.has(candidate)) {
    candidate = `assets/files/${base}-${counter}${extension}`;
    counter += 1;
  }
  usedOutputPaths.add(candidate);
  return candidate;
}

function enrichPart(part, imagePlacementById, attachmentByPlaceholderId) {
  if (part.type === 'image_ref') {
    const placement = imagePlacementById.get(part.placementId);
    return {
      type: 'image',
      resourceId: part.resourceId,
      placementId: part.placementId,
      outputRelativePath: placement?.outputRelativePath || null,
      sourceKind: placement?.source?.sourceKind || null,
      alt: part.alt || part.resourceId,
      width: part.width || null,
      height: part.height || null,
      kind: part.kind,
      missing: !placement?.outputRelativePath
    };
  }
  if (part.type === 'attachment_placeholder') {
    const attachment = attachmentByPlaceholderId.get(part.placeholderId);
    return {
      ...part,
      matched: Boolean(attachment?.matched),
      outputRelativePath: attachment?.outputRelativePath || null,
      sourceKind: attachment?.source?.sourceKind || null,
      matchAttemptSummary: attachment?.matchAttemptSummary || null
    };
  }
  return part;
}

function resourcePartText(part) {
  if (!part) return '';
  if (part.type === 'text' || part.type === 'code' || part.type === 'tool_output' || part.type === 'reasoning' || part.type === 'raw_json') return part.text || '';
  if (part.type === 'image') return [part.alt, part.outputRelativePath, part.resourceId].filter(Boolean).join(' ');
  if (part.type === 'attachment_placeholder') return [part.name, part.mime, part.id, part.outputRelativePath].filter(Boolean).join(' ');
  return '';
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

function isConversationSource(source) {
  return source.sourceKind === 'conversation_directory' || source.sourceKind === 'conversation_zip';
}

function isFilesSource(source) {
  return source.sourceKind === 'files_zip';
}

function fileExtensionFromName(name) {
  const match = String(name || '').match(/(\.[A-Za-z0-9]{1,16})$/);
  return match ? match[1].toLowerCase() : '';
}

function stripExtension(name) {
  return String(name || '').replace(/\.[^/.\\]+$/, '');
}
