import fs from 'node:fs';
import path from 'node:path';

export function writeMarkdownFiles({ archiveData, resourceMap, outputRoot }) {
  const markdownRoot = path.join(outputRoot, 'markdown');
  cleanGeneratedDirectory(markdownRoot, outputRoot);
  ensureDir(path.join(markdownRoot, 'sessions'));
  ensureDir(path.join(markdownRoot, 'timeline'));
  ensureDir(path.join(markdownRoot, 'branches'));
  ensureDir(path.join(markdownRoot, 'appendices'));

  const conversations = [...archiveData.conversations].sort((a, b) => a.conversation_ordinal - b.conversation_ordinal);
  const messagesById = new Map(archiveData.messages.map((message) => [message.archive_message_id, message]));
  const messagesByConversation = groupBy(archiveData.messages, (message) => message.conversation_id);
  const branchesByConversation = groupBy(archiveData.branchMessages, (message) => message.conversation_id);

  for (const conversation of conversations) {
    const messages = [...(messagesByConversation.get(conversation.conversation_id) || [])].sort(comparePathMessageOrder);
    writeText(
      path.join(markdownRoot, 'sessions', `${conversation.slug}.md`),
      renderSessionFile(conversation, messages)
    );
  }

  const timelineEvents = [...archiveData.timelineEvents].sort(compareTimelineEvents);
  writeText(
    path.join(markdownRoot, 'timeline', '000_all_timeline.md'),
    renderTimelineFile('完整现实时间线', timelineEvents, messagesById)
  );

  const monthFiles = [];
  const monthGroups = groupBy(timelineEvents, (event) => monthKeyFromTime(event.effective_time, archiveData.timezone));
  for (const [month, events] of [...monthGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const file = `${month}.md`;
    monthFiles.push(file);
    writeText(
      path.join(markdownRoot, 'timeline', file),
      renderTimelineFile(`现实时间线：${month}`, events, messagesById)
    );
  }

  const conversationsWithBranches = conversations.filter((conversation) => (conversation.branch_message_ids || []).length > 0);
  for (const conversation of conversationsWithBranches) {
    const branchMessages = [...(branchesByConversation.get(conversation.conversation_id) || [])];
    writeText(
      path.join(markdownRoot, 'branches', `${conversation.slug}.md`),
      renderBranchFile(conversation, branchMessages)
    );
  }

  writeText(path.join(markdownRoot, 'appendices', 'hidden_context.md'), renderHiddenContext(archiveData.hiddenMetadataSummary || []));
  writeText(path.join(markdownRoot, 'appendices', 'unmatched_attachments.md'), renderUnmatchedAttachments(resourceMap.unmatchedNonImageAttachments || []));
  writeText(path.join(markdownRoot, 'appendices', 'raw_export_boundary.md'), renderRawBoundary(archiveData, resourceMap));
  writeText(path.join(markdownRoot, 'sessions', 'README.md'), renderSessionsReadme(conversations));
  writeText(path.join(markdownRoot, 'timeline', 'README.md'), renderTimelineReadme(monthFiles));
  writeText(path.join(markdownRoot, 'branches', 'README.md'), renderBranchesReadme(conversationsWithBranches));
  writeText(path.join(markdownRoot, 'README.md'), renderMarkdownReadme(conversations, monthFiles));

  return {
    files: listMarkdownFiles(markdownRoot),
    sessionFiles: conversations.length,
    timelineMonthFiles: monthFiles.length,
    branchFiles: conversationsWithBranches.length
  };
}

function renderSessionFile(conversation, messages) {
  const branchCount = (conversation.branch_message_ids || []).length;
  const branchNote = branchCount > 0
    ? `本文件按该会话当前路径的上下文顺序排列。分支消息没有混入正文，可在 [分支附录](../branches/${conversation.slug}.md) 查看。`
    : '本文件按该会话当前路径的上下文顺序排列。此会话没有默认路径之外的分支消息。';
  const lines = [
    frontMatter(cleanTitle(conversation.conversation_title), [
      conversationMetadataTable(conversation, messages),
      '',
      branchNote
    ])
  ];
  for (const message of messages) {
    lines.push(renderMessage(message, 'markdown/sessions'));
    lines.push('\n---\n');
  }
  if (messages.length === 0) lines.push('此会话没有可展示消息。');
  return lines.join('\n');
}

function renderTimelineFile(title, events, messagesById) {
  const lines = [
    frontMatter(title, [
      '本文件按现实时间排序。每条消息仍保留其所属会话标题和稳定消息编号。'
    ])
  ];
  for (const event of events) {
    const message = messagesById.get(event.archive_message_id);
    if (!message) continue;
    lines.push(renderMessage(message, 'markdown/timeline', { includeConversation: true }));
    lines.push('\n---\n');
  }
  return lines.join('\n');
}

function renderBranchFile(conversation, branchMessages) {
  const lines = [
    frontMatter(`分支记录：${cleanTitle(conversation.conversation_title)}`, [
      '本文件只保存不在当前默认路径上的分支消息。它们不参与默认会话正文和默认时间线，但保留为可搜索、可编辑的附录。',
      '',
      `[返回会话正文](../sessions/${conversation.slug}.md)`
    ])
  ];
  if (branchMessages.length === 0) {
    lines.push('此会话没有分支消息。');
    return lines.join('\n');
  }

  const branchGroups = groupBy([...branchMessages].sort(compareBranchMessageOrder), (message) => message.branch_group ?? 'unknown');
  for (const [group, groupMessages] of [...branchGroups.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const first = groupMessages[0];
    lines.push(`## 分支组 ${group}`);
    lines.push('');
    lines.push(`父节点：${first.branch_group_parent_node_id || '未知'}`);
    lines.push('');
    for (const message of groupMessages.sort(compareBranchMessageOrder)) {
      lines.push(renderMessage(message, 'markdown/branches'));
      lines.push('\n---\n');
    }
  }
  return lines.join('\n');
}

function renderHiddenContext(hiddenItems) {
  const lines = [
    frontMatter('隐藏上下文附录', [
      '这里保存默认阅读正文中隐藏的系统上下文、用户可编辑上下文和其他元数据摘要。它们不进入默认时间线，但保留为可搜索、可编辑文本。'
    ])
  ];
  for (const item of hiddenItems) {
    lines.push(`<a id="${item.archive_message_id}"></a>`);
    lines.push(`## ${item.role || '未知角色'} · ${item.create_time_shanghai || item.create_time_display || '未知时间'}`);
    lines.push('');
    lines.push(`会话：${cleanTitle(item.conversation_title)}`);
    lines.push('');
    lines.push(neutralizeNonPortableMarkdownSyntax(item.text) || '> 无文本摘要。');
    lines.push('\n---\n');
  }
  return lines.join('\n');
}

function renderUnmatchedAttachments(unmatched) {
  const lines = [
    frontMatter('未匹配附件附录', [
      '这里列出原始导出中出现、但没有在导出文件夹或 Files 压缩包中定位到实体文件的非图片附件。正文中对应位置会保留占位说明。'
    ]),
    '| 序号 | 附件 | 类型 | 大小 | 会话 | 当前路径 | 占位编号 |',
    '|---:|---|---|---:|---|---|---|'
  ];
  unmatched.forEach((attachment, index) => {
    lines.push(`| ${index + 1} | ${escapeTable(attachment.name || attachment.id || '未知附件')} | ${escapeTable(attachment.mime || '未知')} | ${escapeTable(formatSize(attachment.size))} | ${escapeTable(attachment.conversationTitle || '')} | ${attachment.isCurrentPath ? '是' : '否'} | ${escapeTable(attachment.placeholderId)} |`);
  });
  return lines.join('\n');
}

function renderRawBoundary(data, resourceMap) {
  const counts = data.manifest || {};
  return [
    frontMatter('原始导出边界说明', [
      '这份归档由 ChatGPT Web 端用户数据导出转换而来。原始导出目录没有被修改。'
    ]),
    '## 默认正文',
    '',
    `- 会话：${counts.conversationCount}`,
    `- 当前路径消息：${counts.messageCount}`,
    `- 时间线事件：${counts.timelineEventCount}`,
    `- 图片放置点：${counts.imagePlacementCount}`,
    `- 唯一图片资源：${counts.imageResourceCount}`,
    '',
    '## 作为附录保留的内容',
    '',
    `- 分支消息：${counts.branchMessageCount}`,
    `- 隐藏上下文和元数据摘要：${counts.hiddenMetadataCount}`,
    `- 未匹配非图片附件：${counts.unmatchedNonImageAttachmentCount}`,
    '',
    '## 生成规则',
    '',
    '- 会话版按每个会话的当前路径顺序排列。',
    '- 时间线版按消息的有效现实时间排列；时间缺失时使用归档模型中的回退规则。',
    '- 图片使用共享目录 `assets/images`，Markdown 中只写相对路径。',
    '- 分支消息不混入默认正文，但保留在 `markdown/branches`。',
    '- 未匹配附件不伪造文件路径，只保留占位和匹配尝试摘要。',
    '',
    '## 资源摘要',
    '',
    `- 缺失图片资源：${resourceMap.summary?.missingImageResourceCount ?? 0}`,
    `- 当前路径内未匹配非图片附件：${resourceMap.summary?.unmatchedCurrentPathNonImageAttachmentCount ?? 0}`
  ].join('\n');
}

function renderSessionsReadme(conversations) {
  const lines = [
    '# 会话版 Markdown',
    '',
    '| 序号 | 会话 | 创建时间 | 文件 |',
    '|---:|---|---|---|'
  ];
  for (const conversation of conversations) {
    lines.push(`| ${conversation.conversation_ordinal} | ${escapeTable(conversation.conversation_title)} | ${escapeTable(conversation.create_time_shanghai || '未知')} | [打开](${conversation.slug}.md) |`);
  }
  return lines.join('\n');
}

function renderTimelineReadme(monthFiles) {
  const lines = [
    '# 时间线 Markdown',
    '',
    '- [完整现实时间线](000_all_timeline.md)',
    '',
    '## 分月文件',
    ''
  ];
  for (const file of monthFiles) lines.push(`- [${file.replace(/\.md$/, '')}](${file})`);
  return lines.join('\n');
}

function renderBranchesReadme(conversations) {
  const lines = [
    '# 分支附录',
    '',
    '| 序号 | 会话 | 分支消息 | 文件 |',
    '|---:|---|---:|---|'
  ];
  for (const conversation of conversations) {
    lines.push(`| ${conversation.conversation_ordinal} | ${escapeTable(conversation.conversation_title)} | ${(conversation.branch_message_ids || []).length} | [打开](${conversation.slug}.md) |`);
  }
  return lines.join('\n');
}

function renderMarkdownReadme(conversations, monthFiles) {
  return [
    '# ChatGPT 归档 Markdown',
    '',
    '这些文件是可编辑、可全文搜索的纯文本版本。图片使用相对路径指向归档根目录下的 `assets/images`。',
    '',
    '## 入口',
    '',
    '- [会话版索引](sessions/README.md)',
    '- [完整现实时间线](timeline/000_all_timeline.md)',
    '- [时间线分月索引](timeline/README.md)',
    '- [分支附录](branches/README.md)',
    '- [隐藏上下文附录](appendices/hidden_context.md)',
    '- [未匹配附件附录](appendices/unmatched_attachments.md)',
    '- [原始导出边界说明](appendices/raw_export_boundary.md)',
    '',
    '## 数量',
    '',
    `- 会话文件：${conversations.length}`,
    `- 分月时间线文件：${monthFiles.length}`
  ].join('\n');
}

function renderMessage(message, markdownDirRelative, options = {}) {
  const title = messageTitle(message, Boolean(options.includeConversation));
  const metadata = [
    `<!-- source_node_id: ${message.source_node_id || ''} -->`,
    `<!-- content_type: ${message.content_type || ''}; display_class: ${message.display_class || ''}; time_source: ${message.timeSource || message.time_source || ''} -->`
  ].join('\n');
  const body = renderParts(message.parts, markdownDirRelative);
  if (message.display_class === 'collapsible') {
    return [
      messageAnchor(message.archive_message_id),
      '<details>',
      `<summary>${title}</summary>`,
      '',
      metadata,
      '',
      body,
      '',
      '</details>'
    ].join('\n');
  }
  return [
    messageAnchor(message.archive_message_id),
    `### ${title}`,
    '',
    metadata,
    '',
    body
  ].join('\n');
}

function renderParts(parts, markdownDirRelative) {
  const rendered = (parts || [])
    .map((part) => renderPart(part, markdownDirRelative))
    .filter((text) => text && text.trim().length > 0);
  return rendered.length ? rendered.join('\n\n') : '> 此消息没有可展示正文。';
}

function renderPart(part, markdownDirRelative) {
  if (part.type === 'text') return neutralizeNonPortableMarkdownSyntax(part.text);
  if (part.type === 'image') {
    if (!part.outputRelativePath) return `> 图片缺失：${part.resourceId || part.placementId || '未知图片'}`;
    const imagePath = relAssetPath(markdownDirRelative, part.outputRelativePath);
    const caption = [
      part.kind === 'content.screenshot.asset_pointer' ? '截图' : '图片',
      part.placementId,
      part.resourceId
    ].filter(Boolean).join(' · ');
    return `![${escapeAlt(part.alt || part.resourceId)}](${imagePath})\n\n<small>${caption}</small>`;
  }
  if (part.type === 'code') {
    const text = normalizeText(part.text);
    const fence = fenceFor(text);
    return `${fence}${part.language || ''}\n${text}\n${fence}`;
  }
  if (part.type === 'tool_output') {
    const text = normalizeText(part.text);
    const fence = fenceFor(text);
    return `工具输出：${part.label || 'output'}\n\n${fence}text\n${text}\n${fence}`;
  }
  if (part.type === 'reasoning') return `推理记录：${part.label || ''}\n\n${neutralizeNonPortableMarkdownSyntax(part.text)}`.trim();
  if (part.type === 'attachment_placeholder') {
    return [
      `> 附件未能定位：${part.name || part.id || '未知附件'}`,
      `> 类型：${part.mime || '未知类型'}`,
      `> 大小：${formatSize(part.size)}`,
      `> 原因：${part.reason || '原始导出未提供可定位文件'}`
    ].join('\n');
  }
  const text = normalizeText(part.text || JSON.stringify(part, null, 2));
  const fence = fenceFor(text);
  return `${fence}json\n${text}\n${fence}`;
}

function conversationMetadataTable(conversation, messages) {
  const mainCount = messages.filter((message) => message.display_class === 'main').length;
  const collapsibleCount = messages.filter((message) => message.display_class === 'collapsible').length;
  return [
    '| 项目 | 内容 |',
    '|---|---|',
    `| 会话标题 | ${escapeTable(conversation.conversation_title)} |`,
    `| 会话编号 | ${escapeTable(conversation.conversation_ordinal)} |`,
    `| 原始会话 ID | ${escapeTable(conversation.conversation_id)} |`,
    `| 创建时间 | ${escapeTable(conversation.create_time_shanghai || '未知')} |`,
    `| 更新时间 | ${escapeTable(conversation.update_time_shanghai || '未知')} |`,
    `| 当前路径消息 | ${messages.length} |`,
    `| 主要消息 | ${mainCount} |`,
    `| 可折叠技术记录 | ${collapsibleCount} |`,
    `| 分支消息 | ${(conversation.branch_message_ids || []).length} |`
  ].join('\n');
}

function messageTitle(message, includeConversation = false) {
  const bits = [
    message.role_label || message.role || '未知角色',
    message.effective_time_shanghai || message.create_time_shanghai || '未知时间'
  ];
  if (includeConversation) bits.push(cleanTitle(message.conversation_title));
  bits.push(message.archive_message_id);
  return bits.join(' · ');
}

function monthKeyFromTime(seconds, timezone) {
  if (!Number.isFinite(seconds)) return 'unknown-time';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'UTC',
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date(seconds * 1000));
  const year = parts.find((part) => part.type === 'year')?.value || '0000';
  const month = parts.find((part) => part.type === 'month')?.value || '00';
  return `${year}-${month}`;
}

function relAssetPath(fromMarkdownDirRelative, outputRelativePath) {
  return path.posix.relative(fromMarkdownDirRelative, String(outputRelativePath).replaceAll('\\', '/'));
}

function compareTimelineEvents(a, b) {
  return a.effective_time - b.effective_time ||
    a.time_fallback_rank - b.time_fallback_rank ||
    a.timeline_event_id.localeCompare(b.timeline_event_id);
}

function comparePathMessageOrder(a, b) {
  return (a.path_index ?? 0) - (b.path_index ?? 0) ||
    String(a.archive_message_id).localeCompare(String(b.archive_message_id));
}

function compareBranchMessageOrder(a, b) {
  return (a.branch_group ?? 0) - (b.branch_group ?? 0) ||
    (a.branch_index ?? 0) - (b.branch_index ?? 0) ||
    String(a.archive_message_id).localeCompare(String(b.archive_message_id));
}

function messageAnchor(id) {
  return `<a id="${id}"></a>`;
}

function frontMatter(title, extra = []) {
  return [`# ${title}`, '', ...extra, ''].join('\n');
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function cleanTitle(value) {
  return String(value || '未命名会话').replace(/\s+/g, ' ').trim();
}

function normalizeText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

function neutralizeNonPortableMarkdownSyntax(text) {
  return normalizeText(text)
    .replace(/(^|[^\\])!\[([^\]\n]*)]\(([^)\n]+)\)/g, (match, prefix, alt, rawTarget) => `${prefix}图片引用：${alt || '未命名图片'}（原始引用：${parseLinkTarget(rawTarget)}）`)
    .replace(/(^|[^!\\])\[([^\]\n]+)]\(([^)\n]+)\)/g, (match, prefix, label, rawTarget) => {
      const target = parseLinkTarget(rawTarget);
      return isNonPortableRawLinkTarget(target) ? `${prefix}${label}（原始引用：${target}）` : match;
    });
}

function parseLinkTarget(rawTarget) {
  return String(rawTarget || '').trim().replace(/^<|>$/g, '');
}

function isNonPortableRawLinkTarget(target) {
  const text = String(target || '');
  return text.startsWith('sandbox:') || text.startsWith('file:') || path.win32.isAbsolute(text) || text.startsWith('/') || text.startsWith('\\');
}

function escapeTable(value) {
  return String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

function escapeAlt(value) {
  return String(value || 'image').replaceAll('[', '(').replaceAll(']', ')').replace(/\r?\n/g, ' ').trim();
}

function fenceFor(text) {
  const matches = String(text || '').match(/`+/g) || [];
  const longest = matches.reduce((max, item) => Math.max(max, item.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function listMarkdownFiles(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(fullPath);
  }
  return out.sort();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

function cleanGeneratedDirectory(target, outputRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(outputRoot);
  if (!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`拒绝清理输出目录之外的位置：${resolvedTarget}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
  ensureDir(resolvedTarget);
}
