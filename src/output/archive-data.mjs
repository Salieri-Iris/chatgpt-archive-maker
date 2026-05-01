export function buildArchiveData(model, resourceMap, context) {
  const conversations = model.conversations.map(outputConversation);
  const messages = model.messages.map(outputMessage);
  const branchMessages = model.branchMessages.map(outputMessage);
  const timelineEvents = model.timelineEvents.map(outputTimelineEvent);
  const hiddenMetadataSummary = model.hiddenMetadataSummary.map(outputHiddenMetadata);
  const imageResources = resourceMap.imageResources.map(publicImageResource);
  const unmatchedAttachments = resourceMap.unmatchedNonImageAttachments.map(publicAttachment);

  const archiveData = {
    version: 1,
    generatedAt: model.generatedAt,
    timezone: model.timezone,
    manifest: {
      title: 'ChatGPT Archive',
      sourceExportRoot: context.inputPath,
      conversationCount: conversations.length,
      messageCount: messages.length,
      timelineEventCount: timelineEvents.length,
      branchMessageCount: branchMessages.length,
      hiddenMetadataCount: hiddenMetadataSummary.length,
      emptyMessageCount: model.emptyMessages.length,
      imagePlacementCount: resourceMap.summary.imagePlacementCount,
      imageResourceCount: resourceMap.summary.uniqueImageResourceCount,
      unmatchedNonImageAttachmentCount: resourceMap.summary.unmatchedNonImageAttachmentCount
    },
    conversations,
    messages,
    timelineEvents,
    resources: {
      images: imageResources,
      unmatchedAttachments
    },
    branchMessages,
    hiddenMetadataSummary
  };

  const searchIndex = buildSearchIndex(archiveData, unmatchedAttachments);
  const manifest = buildManifest(archiveData, context);
  const resourceMapPublic = buildPublicResourceMap(resourceMap);

  return { archiveData, searchIndex, manifest, resourceMap: resourceMapPublic };
}

export function writeJsDataValue(variableName, value) {
  return `window.${variableName} = ${JSON.stringify(value)};\n`;
}

function outputConversation(conversation) {
  return {
    ...conversation,
    create_time_shanghai: conversation.create_time_display,
    update_time_shanghai: conversation.update_time_display
  };
}

function outputMessage(message) {
  return {
    ...message,
    create_time_shanghai: message.create_time_display,
    effectiveTime: message.effective_time,
    timeFallbackRank: message.time_fallback_rank,
    timeSource: message.time_source,
    effective_time_shanghai: message.effective_time_display
  };
}

function outputTimelineEvent(event) {
  return {
    ...event,
    effective_time_shanghai: event.effective_time_display
  };
}

function outputHiddenMetadata(item) {
  return {
    ...item,
    create_time_shanghai: item.create_time_display
  };
}

function publicImageResource(resource) {
  return {
    resourceId: resource.resourceId,
    sourceKind: resource.source?.sourceKind || null,
    sourceRelativePath: resource.source?.relativePath || null,
    sourceSize: resource.source?.size || null,
    outputRelativePath: resource.outputRelativePath,
    occurrenceCount: resource.occurrenceCount,
    placementIds: resource.placementIds,
    missing: resource.missing
  };
}

function publicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    mime: attachment.mime,
    size: attachment.size,
    isImage: attachment.isImage,
    conversationId: attachment.conversationId,
    conversationTitle: attachment.conversationTitle,
    nodeId: attachment.nodeId,
    messageId: attachment.messageId,
    role: attachment.role,
    isCurrentPath: attachment.isCurrentPath,
    createTime: attachment.createTime,
    createTimeShanghai: attachment.createTimeDisplay,
    placeholderId: attachment.placeholderId,
    matched: attachment.matched,
    outputRelativePath: attachment.outputRelativePath,
    matchAttemptSummary: attachment.matchAttemptSummary
  };
}

function buildSearchIndex(data, unmatchedAttachments) {
  return [
    ...data.messages.map((message) => ({
      search_id: `s-${message.archive_message_id}`,
      target_type: 'message',
      target_id: message.archive_message_id,
      conversation_id: message.conversation_id,
      conversation_title: message.conversation_title,
      time: message.effective_time_shanghai,
      role: message.role_label,
      display_class: message.display_class,
      default_visible: true,
      text: messageSearchText(message),
      resource_names: message.parts.filter((part) => part.type === 'image').map((part) => part.outputRelativePath).filter(Boolean)
    })),
    ...data.branchMessages.map((message) => ({
      search_id: `s-${message.archive_message_id}`,
      target_type: 'branch_message',
      target_id: message.archive_message_id,
      conversation_id: message.conversation_id,
      conversation_title: message.conversation_title,
      time: message.effective_time_shanghai,
      role: message.role_label,
      display_class: message.display_class,
      default_visible: false,
      text: messageSearchText(message),
      resource_names: message.parts.filter((part) => part.type === 'image').map((part) => part.outputRelativePath).filter(Boolean)
    })),
    ...unmatchedAttachments.map((attachment) => ({
      search_id: `s-${attachment.placeholderId}`,
      target_type: 'unmatched_attachment',
      target_id: attachment.placeholderId,
      conversation_id: attachment.conversationId,
      conversation_title: attachment.conversationTitle,
      time: attachment.createTimeShanghai,
      role: attachment.role || '',
      display_class: 'attachment_placeholder',
      default_visible: true,
      text: [attachment.name, attachment.mime, attachment.id, attachment.conversationTitle].filter(Boolean).join(' '),
      resource_names: [attachment.name].filter(Boolean)
    }))
  ];
}

function messageSearchText(message) {
  return (message.parts || []).map((part) => {
    if (part.type === 'text' || part.type === 'code' || part.type === 'tool_output' || part.type === 'reasoning' || part.type === 'raw_json') return part.text || '';
    if (part.type === 'image') return [part.alt, part.outputRelativePath, part.resourceId].filter(Boolean).join(' ');
    if (part.type === 'attachment_placeholder') return [part.name, part.mime, part.id, part.outputRelativePath].filter(Boolean).join(' ');
    return '';
  }).join('\n').trim();
}

function buildManifest(data, context) {
  return {
    generatedAt: data.generatedAt,
    sourceExportRoot: context.inputPath,
    entrypoints: {
      index: 'index.html',
      sessions: 'sessions.html',
      timeline: 'timeline.html'
    },
    counts: data.manifest
  };
}

function buildPublicResourceMap(resourceMap) {
  return {
    generatedAt: resourceMap.generatedAt,
    summary: resourceMap.summary,
    images: resourceMap.imageResources.map(publicImageResource),
    imagePlacements: resourceMap.imagePlacements.map((placement) => ({
      placementId: placement.placementId,
      resourceId: placement.resourceId,
      kind: placement.kind,
      conversationId: placement.conversationId,
      conversationTitle: placement.conversationTitle,
      conversationOrdinal: placement.conversationOrdinal,
      nodeId: placement.nodeId,
      messageId: placement.messageId,
      role: placement.role,
      partIndex: placement.partIndex,
      matchedText: placement.matchedText,
      outputRelativePath: placement.outputRelativePath,
      sourceKind: placement.source?.sourceKind || null,
      sourceRelativePath: placement.source?.relativePath || null
    })),
    unmatchedNonImageAttachments: resourceMap.unmatchedNonImageAttachments.map(publicAttachment)
  };
}
