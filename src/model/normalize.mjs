import path from 'node:path';

export function normalizeConversations(conversations, options = {}) {
  const timezone = options.timezone || 'UTC';
  const conversationOrder = conversations
    .map((conversation, sourceIndex) => ({ conversation, sourceIndex }))
    .sort((a, b) =>
      compareNullableTime(a.conversation.create_time, b.conversation.create_time) ||
      a.sourceIndex - b.sourceIndex ||
      conversationIdOf(a.conversation).localeCompare(conversationIdOf(b.conversation))
    );

  const archiveConversations = [];
  const messages = [];
  const hiddenMessages = [];
  const emptyMessages = [];
  const branchMessages = [];
  const imagePlacements = [];
  const attachmentRecords = [];

  for (let orderIndex = 0; orderIndex < conversationOrder.length; orderIndex += 1) {
    const { conversation, sourceIndex } = conversationOrder[orderIndex];
    const conversationOrdinal = orderIndex + 1;
    const conversationId = conversationIdOf(conversation);
    const currentIds = currentPathIds(conversation);
    const meta = {
      conversation_id: conversationId,
      conversation_title: conversation.title || '未命名会话',
      conversation_ordinal: conversationOrdinal,
      source_index: sourceIndex,
      slug: buildConversationSlug(conversationOrdinal, conversation),
      create_time: conversation.create_time ?? null,
      create_time_display: timestampToZone(conversation.create_time, timezone),
      update_time: conversation.update_time ?? null,
      update_time_display: timestampToZone(conversation.update_time, timezone),
      current_node: conversation.current_node || null,
      current_path_node_ids: currentIds,
      message_ids: [],
      branch_message_ids: []
    };
    archiveConversations.push(meta);

    const mapping = conversation.mapping || {};
    const currentSet = new Set(currentIds);
    const currentPathIndexByNode = new Map(currentIds.map((nodeId, index) => [nodeId, index + 1]));

    for (let pathIndex = 0; pathIndex < currentIds.length; pathIndex += 1) {
      const nodeId = currentIds[pathIndex];
      const node = mapping[nodeId];
      const message = node?.message;
      if (!message) continue;
      const nodeImagePlacements = isOrdinaryHiddenSystem(message)
        ? []
        : collectImagePlacements(message, {
          conversation,
          conversationOrdinal,
          nodeId,
          isCurrentPath: true,
          imagePlacements
        });
      const nodeAttachments = collectAttachmentRecords(message, {
        conversation,
        nodeId,
        isCurrentPath: true,
        timezone,
        attachmentRecords
      });
      const parts = extractParts(message, nodeImagePlacements, nodeAttachments.filter((item) => !item.isImage));
      const displayClass = classifyMessage(message, parts);
      const timeInfo = effectiveTimeFor(message, conversation);
      const archiveMessageId = `m${pad(conversationOrdinal, 3)}-${pad(pathIndex + 1, 5)}-${shortId(nodeId, 8)}`;
      const normalized = normalizeMessage({
        archiveMessageId,
        node,
        nodeId,
        message,
        conversation,
        meta,
        timezone,
        timeInfo,
        displayClass,
        parts,
        pathKind: 'current',
        pathIndex: pathIndex + 1
      });
      if (displayClass === 'hidden_metadata') hiddenMessages.push(normalized);
      else if (displayClass === 'empty') emptyMessages.push(normalized);
      else {
        messages.push(normalized);
        meta.message_ids.push(archiveMessageId);
      }
    }

    const branchNodes = Object.entries(mapping)
      .filter(([nodeId, node]) => node.message && !currentSet.has(nodeId))
      .map(([nodeId, node]) => ({
        nodeId,
        node,
        branchInfo: branchInfoFor(nodeId, mapping, currentPathIndexByNode)
      }))
      .sort((a, b) =>
        a.branchInfo.branch_group - b.branchInfo.branch_group ||
        compareNullableTime(a.node.message?.create_time, b.node.message?.create_time) ||
        a.nodeId.localeCompare(b.nodeId)
      );
    const branchIndexByGroup = new Map();
    for (const branchRecord of branchNodes) {
      const { nodeId, node, branchInfo } = branchRecord;
      const branchIndex = (branchIndexByGroup.get(branchInfo.branch_group) || 0) + 1;
      branchIndexByGroup.set(branchInfo.branch_group, branchIndex);
      const message = node.message;
      const nodeImagePlacements = [];
      const nodeAttachments = collectAttachmentRecords(message, {
        conversation,
        nodeId,
        isCurrentPath: false,
        timezone,
        attachmentRecords
      });
      const parts = extractParts(message, nodeImagePlacements, nodeAttachments.filter((item) => !item.isImage));
      const timeInfo = effectiveTimeFor(message, conversation);
      const archiveMessageId = `b${pad(conversationOrdinal, 3)}-${pad(branchInfo.branch_group, 4)}-${pad(branchIndex, 3)}-${shortId(nodeId, 8)}`;
      const normalized = normalizeMessage({
        archiveMessageId,
        node,
        nodeId,
        message,
        conversation,
        meta,
        timezone,
        timeInfo,
        displayClass: classifyMessage(message, parts),
        parts,
        pathKind: 'branch',
        pathIndex: null,
        branchInfo,
        branchIndex
      });
      branchMessages.push(normalized);
      meta.branch_message_ids.push(archiveMessageId);
    }
  }

  const timelineEvents = messages
    .filter((message) => message.display_class === 'main' || message.display_class === 'collapsible')
    .sort((a, b) =>
      a.effective_time - b.effective_time ||
      a.time_fallback_rank - b.time_fallback_rank ||
      a.conversation_ordinal - b.conversation_ordinal ||
      a.path_index - b.path_index ||
      a.source_node_id.localeCompare(b.source_node_id)
    )
    .map((message, index) => ({
      timeline_event_id: `t${pad(index + 1, 6)}-${message.archive_message_id}`,
      archive_message_id: message.archive_message_id,
      conversation_id: message.conversation_id,
      conversation_title: message.conversation_title,
      conversation_ordinal: message.conversation_ordinal,
      effective_time: message.effective_time,
      effective_time_display: message.effective_time_display,
      time_source: message.time_source,
      time_fallback_rank: message.time_fallback_rank,
      role: message.role,
      role_label: message.role_label,
      display_class: message.display_class
    }));

  const hiddenMetadataSummary = hiddenMessages.map((message) => ({
    archive_message_id: message.archive_message_id,
    conversation_id: message.conversation_id,
    conversation_title: message.conversation_title,
    role: message.role,
    author_name: message.author_name,
    content_type: message.content_type,
    create_time: message.create_time,
    create_time_display: message.create_time_display,
    source_node_id: message.source_node_id,
    text: message.search_text
  }));

  const nonImageAttachments = attachmentRecords.filter((item) => !item.isImage);
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    timezone,
    sourceExportRoot: options.sourceExportRoot || null,
    conversations: archiveConversations,
    messages,
    timelineEvents,
    branchMessages,
    hiddenMessages,
    hiddenMetadataSummary,
    emptyMessages,
    imagePlacements,
    attachmentRecords,
    nonImageAttachments,
    counts: {
      conversations: archiveConversations.length,
      messages: messages.length,
      timelineEvents: timelineEvents.length,
      branchMessages: branchMessages.length,
      hiddenMetadata: hiddenMessages.length,
      hiddenMetadataSummary: hiddenMetadataSummary.length,
      emptyMessages: emptyMessages.length,
      imagePlacements: imagePlacements.length,
      attachmentRecords: attachmentRecords.length,
      nonImageAttachments: nonImageAttachments.length
    }
  };
}

function normalizeMessage({ archiveMessageId, node, nodeId, message, meta, timezone, timeInfo, displayClass, parts, pathKind, pathIndex, branchInfo = {}, branchIndex = null }) {
  return {
    archive_message_id: archiveMessageId,
    source_node_id: nodeId,
    source_message_id: message.id || null,
    parent_node_id: node.parent || null,
    children_node_ids: node.children || [],
    conversation_id: meta.conversation_id,
    conversation_title: meta.conversation_title,
    conversation_ordinal: meta.conversation_ordinal,
    path_kind: pathKind,
    ...(pathIndex == null ? {} : { path_index: pathIndex }),
    ...branchInfo,
    ...(branchIndex == null ? {} : { branch_index: branchIndex }),
    role: message.author?.role || 'unknown',
    role_label: roleLabel(message),
    author_name: message.author?.name || null,
    recipient: message.recipient || null,
    content_type: message.content?.content_type || null,
    status: message.status || null,
    create_time: message.create_time ?? null,
    create_time_display: timestampToZone(message.create_time, timezone),
    effective_time: timeInfo.effectiveTime,
    effective_time_display: timestampToZone(timeInfo.effectiveTime, timezone),
    time_fallback_rank: timeInfo.timeFallbackRank,
    time_source: timeInfo.timeSource,
    display_class: displayClass,
    parts,
    search_text: parts.map(partText).join('\n').trim()
  };
}

function currentPathIds(conversation) {
  const mapping = conversation.mapping || {};
  const ids = [];
  const seen = new Set();
  let current = conversation.current_node;
  while (current && mapping[current] && !seen.has(current)) {
    seen.add(current);
    ids.push(current);
    current = mapping[current].parent;
  }
  return ids.reverse();
}

function collectImagePlacements(message, context) {
  const refs = renderableImageRefs(message);
  return refs.map((ref) => {
    const placement = {
      placementId: `img-${pad(context.imagePlacements.length + 1, 6)}`,
      resourceId: ref.id,
      nodeId: context.nodeId,
      conversationId: conversationIdOf(context.conversation),
      conversationTitle: context.conversation.title || '未命名会话',
      conversationOrdinal: context.conversationOrdinal,
      messageId: message.id || null,
      role: message.author?.role || 'unknown',
      isCurrentPath: context.isCurrentPath,
      kind: ref.kind,
      partIndex: ref.partIndex,
      matchedText: ref.matchedText || null,
      startIndex: ref.startIndex ?? null,
      endIndex: ref.endIndex ?? null,
      size: ref.size ?? null,
      width: ref.width ?? null,
      height: ref.height ?? null
    };
    context.imagePlacements.push(placement);
    return placement;
  });
}

function collectAttachmentRecords(message, context) {
  const records = [];
  for (const attachment of message.metadata?.attachments || []) {
    const record = {
      id: attachment.id || null,
      name: attachment.name || null,
      mime: attachment.mime_type || '',
      size: attachment.size ?? null,
      isImage: (attachment.mime_type || '').startsWith('image/'),
      conversationId: conversationIdOf(context.conversation),
      conversationTitle: context.conversation.title || '未命名会话',
      nodeId: context.nodeId,
      messageId: message.id || null,
      role: message.author?.role || 'unknown',
      isCurrentPath: context.isCurrentPath,
      createTime: message.create_time ?? null,
      createTimeDisplay: timestampToZone(message.create_time, context.timezone),
      placeholderId: `missing-attachment-${attachment.id || shortId(`${context.nodeId}-${attachment.name}`, 16)}`
    };
    context.attachmentRecords.push(record);
    records.push(record);
  }
  return records;
}

function extractParts(message, imagePlacements, attachmentPlaceholders) {
  const content = message?.content || {};
  const contentType = content.content_type || '';
  const parts = [];
  const placementsByPartIndex = groupBy(imagePlacements.filter((item) => item.kind === 'content.parts.image_asset_pointer'), (item) => String(item.partIndex ?? ''));
  const screenshotPlacements = imagePlacements.filter((item) => item.kind === 'content.screenshot.asset_pointer');
  const inlinePlacements = imagePlacements.filter((item) => item.kind === 'metadata.content_references.asset_pointer_links' || item.kind === 'metadata.citations.asset_pointer_links');

  if (contentType === 'text' || contentType === 'multimodal_text') {
    for (let index = 0; index < (content.parts || []).length; index += 1) {
      const part = content.parts[index];
      if (typeof part === 'string') {
        const text = normalizeWhitespace(part);
        if (text.trim()) parts.push({ type: 'text', text });
      } else if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
        for (const placement of placementsByPartIndex.get(String(index)) || []) parts.push(imageRefPart(placement));
      } else if (part && typeof part === 'object' && part.content_type === 'audio_transcription') {
        if (part.text) parts.push({ type: 'text', text: `[音频转写]\n${normalizeWhitespace(part.text)}` });
      } else if (part && typeof part === 'object') {
        parts.push({ type: 'raw_json', label: '未识别消息片段', text: plainObjectSummary(part) });
      }
    }
  } else if (contentType === 'code') {
    if (content.text) parts.push({ type: 'code', language: content.language || '', responseFormatName: content.response_format_name || null, text: normalizeWhitespace(content.text) });
  } else if (contentType === 'execution_output' || contentType === 'system_error') {
    if (content.text) parts.push({ type: 'tool_output', label: contentType, text: normalizeWhitespace(content.text) });
  } else if (contentType === 'tether_quote') {
    const prefix = [content.title, content.domain, content.url].filter(Boolean).join('\n');
    const text = [prefix, content.text].filter(Boolean).join('\n\n');
    if (text.trim()) parts.push({ type: 'tool_output', label: '文件搜索摘录', text: normalizeWhitespace(text) });
  } else if (contentType === 'tether_browsing_display') {
    const text = [content.summary, content.result].filter(Boolean).join('\n\n');
    if (text.trim()) parts.push({ type: 'tool_output', label: '浏览或文件搜索结果', text: normalizeWhitespace(text) });
    if (content.assets) parts.push({ type: 'raw_json', label: '工具资源', text: plainObjectSummary(content.assets) });
  } else if (contentType === 'thoughts') {
    const text = extractThoughts(content);
    if (text) parts.push({ type: 'reasoning', label: '推理记录', text: normalizeWhitespace(text) });
  } else if (contentType === 'reasoning_recap') {
    if (content.content) parts.push({ type: 'reasoning', label: '推理摘要', text: normalizeWhitespace(content.content) });
  } else if (contentType === 'computer_output') {
    for (const placement of screenshotPlacements) parts.push(imageRefPart(placement));
    if (content.state) parts.push({ type: 'tool_output', label: '浏览器状态', text: plainObjectSummary(content.state, 1500) });
  } else if (contentType === 'user_editable_context') {
    const text = [content.user_profile, content.user_instructions].filter(Boolean).join('\n\n');
    if (text.trim()) parts.push({ type: 'raw_json', label: '用户上下文', text: normalizeWhitespace(text) });
  } else if (Object.keys(content).length > 0) {
    parts.push({ type: 'raw_json', label: '未识别内容', text: plainObjectSummary(content) });
  }

  for (const placement of screenshotPlacements) {
    if (!parts.some((part) => part.type === 'image_ref' && part.placementId === placement.placementId)) parts.push(imageRefPart(placement));
  }
  for (const placement of inlinePlacements) parts.push(imageRefPart(placement));
  for (const attachment of attachmentPlaceholders) {
    parts.push({
      type: 'attachment_placeholder',
      id: attachment.id,
      placeholderId: attachment.placeholderId,
      name: attachment.name || attachment.id || '未命名附件',
      mime: attachment.mime || '未知类型',
      size: attachment.size ?? null,
      reason: '原始导出未提供可定位文件'
    });
  }
  return parts;
}

function renderableImageRefs(message) {
  const refs = [];
  for (let partIndex = 0; partIndex < (message?.content?.parts || []).length; partIndex += 1) {
    const part = message.content.parts[partIndex];
    if (part && typeof part === 'object' && part.content_type === 'image_asset_pointer') {
      for (const id of idsFromPointer(part.asset_pointer)) {
        refs.push({ id, kind: 'content.parts.image_asset_pointer', partIndex, size: part.size_bytes ?? null, width: part.width ?? null, height: part.height ?? null });
      }
    }
  }
  for (const id of idsFromPointer(message?.content?.screenshot?.asset_pointer)) {
    refs.push({ id, kind: 'content.screenshot.asset_pointer', partIndex: null, size: null, width: null, height: null });
  }
  const contentReferenceRefs = [];
  for (const reference of message?.metadata?.content_references || []) {
    for (const id of nestedAssetIds(reference.asset_pointer_links || [])) {
      contentReferenceRefs.push({ id, kind: 'metadata.content_references.asset_pointer_links', partIndex: null, matchedText: reference.matched_text || null, startIndex: reference.start_idx ?? null, endIndex: reference.end_idx ?? null, size: null, width: null, height: null });
    }
  }
  refs.push(...contentReferenceRefs);
  const contentReferenceKeys = new Set(contentReferenceRefs.map((ref) => inlineImageReferenceKey(ref)));
  for (const citation of message?.metadata?.citations || []) {
    for (const id of nestedAssetIds(citation.metadata?.asset_pointer_links || [])) {
      const ref = { id, kind: 'metadata.citations.asset_pointer_links', partIndex: null, matchedText: null, startIndex: citation.start_ix ?? null, endIndex: citation.end_ix ?? null, size: null, width: null, height: null };
      if (!contentReferenceKeys.has(inlineImageReferenceKey(ref))) refs.push(ref);
    }
  }
  return refs.filter((ref) => ref.id);
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

function inlineImageReferenceKey(ref) {
  return `${ref.id || ''}|${ref.startIndex ?? ''}|${ref.endIndex ?? ''}`;
}

function imageRefPart(placement) {
  return {
    type: 'image_ref',
    resourceId: placement.resourceId,
    placementId: placement.placementId,
    kind: placement.kind,
    alt: placement.matchedText || placement.resourceId,
    width: placement.width || null,
    height: placement.height || null
  };
}

function classifyMessage(message, parts) {
  if (isOrdinaryHiddenSystem(message) || isVisuallyHidden(message) || message?.content?.content_type === 'user_editable_context') return 'hidden_metadata';
  if (parts.length === 0) return 'empty';
  const role = message?.author?.role;
  const contentType = message?.content?.content_type;
  if ((role === 'user' || role === 'assistant') && (contentType === 'text' || contentType === 'multimodal_text')) return 'main';
  if (role === 'user' && parts.some((part) => part.type === 'attachment_placeholder' || part.type === 'image_ref')) return 'main';
  return 'collapsible';
}

function isOrdinaryHiddenSystem(message) {
  return message?.author?.role === 'system' && !message?.metadata?.is_user_system_message;
}

function isVisuallyHidden(message) {
  return Boolean(message?.metadata?.is_visually_hidden_from_conversation);
}

function roleLabel(message) {
  const role = message?.author?.role || 'unknown';
  if (role === 'user') return '用户';
  if (role === 'assistant') return 'ChatGPT';
  if (role === 'tool') return message?.author?.name ? `工具：${message.author.name}` : '工具';
  if (role === 'system') return '系统';
  return role;
}

function partText(part) {
  if (!part) return '';
  if (part.type === 'text' || part.type === 'code' || part.type === 'tool_output' || part.type === 'reasoning' || part.type === 'raw_json') return part.text || '';
  if (part.type === 'image_ref') return [part.alt, part.resourceId, part.placementId].filter(Boolean).join(' ');
  if (part.type === 'attachment_placeholder') return [part.name, part.mime, part.id].filter(Boolean).join(' ');
  return '';
}

function extractThoughts(content) {
  const pieces = [];
  for (const thought of content?.thoughts || []) {
    if (thought.summary) pieces.push(`摘要：${thought.summary}`);
    if (thought.content) pieces.push(thought.content);
    if (Array.isArray(thought.chunks) && thought.chunks.length > 0) pieces.push(thought.chunks.map((chunk) => typeof chunk === 'string' ? chunk : JSON.stringify(chunk)).join('\n'));
  }
  return pieces.join('\n\n').trim();
}

function effectiveTimeFor(message, conversation) {
  if (typeof message.create_time === 'number' && Number.isFinite(message.create_time)) return { effectiveTime: message.create_time, timeFallbackRank: 0, timeSource: 'message.create_time' };
  if (typeof conversation.create_time === 'number' && Number.isFinite(conversation.create_time)) return { effectiveTime: conversation.create_time, timeFallbackRank: 3, timeSource: 'conversation.create_time' };
  return { effectiveTime: 0, timeFallbackRank: 4, timeSource: 'missing' };
}

function branchInfoFor(nodeId, mapping, currentPathIndexByNode) {
  const seen = new Set([nodeId]);
  let parentId = mapping[nodeId]?.parent || null;
  while (parentId && mapping[parentId] && !seen.has(parentId)) {
    if (currentPathIndexByNode.has(parentId)) {
      const parentPathIndex = currentPathIndexByNode.get(parentId);
      return { branch_group: parentPathIndex, branch_group_parent_node_id: parentId, branch_group_parent_path_index: parentPathIndex };
    }
    seen.add(parentId);
    parentId = mapping[parentId]?.parent || null;
  }
  return { branch_group: 0, branch_group_parent_node_id: null, branch_group_parent_path_index: null };
}

function buildConversationSlug(ordinal, conversation) {
  const title = safeName(conversation.title || '未命名会话');
  return `c${pad(ordinal, 3)}-${formatDateForSlug(conversation.create_time)}-${title}-${shortId(conversationIdOf(conversation), 8)}`;
}

function conversationIdOf(conversation) {
  return conversation.id || conversation.conversation_id || 'unknown-conversation';
}

function timestampToZone(value, timezone) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value * 1000));
}

function compareNullableTime(a, b) {
  const aa = typeof a === 'number' && Number.isFinite(a) ? a : Number.POSITIVE_INFINITY;
  const bb = typeof b === 'number' && Number.isFinite(b) ? b : Number.POSITIVE_INFINITY;
  return aa - bb;
}

function formatDateForSlug(unixSeconds) {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) return 'unknown-date';
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function safeName(value) {
  return String(value || 'untitled').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'untitled';
}

function shortId(value, length = 8) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, length) || 'unknown';
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function plainObjectSummary(value, maxLength = 4000) {
  const text = JSON.stringify(value, null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n... [truncated]` : text;
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function pad(value, length) {
  return String(value).padStart(length, '0');
}

export function formatModelSummary(model) {
  return [
    '规范化模型：',
    `  会话：${model.counts.conversations}`,
    `  当前路径可读消息：${model.counts.messages}`,
    `  时间线事件：${model.counts.timelineEvents}`,
    `  分支消息：${model.counts.branchMessages}`,
    `  隐藏上下文：${model.counts.hiddenMetadata}`,
    `  空消息：${model.counts.emptyMessages}`,
    `  图片放置点：${model.counts.imagePlacements}`,
    `  非图片附件记录：${model.counts.nonImageAttachments}`
  ].join('\n');
}
