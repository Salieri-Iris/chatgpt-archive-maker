import fs from 'node:fs';
import path from 'node:path';
import { listFiles, loadArchiveBundle } from './load-archive.mjs';

export function auditArchiveOutput(archiveRoot) {
  const bundle = loadArchiveBundle(archiveRoot);
  const { archiveData, searchIndex, manifest, resourceMap } = bundle;
  const checks = [];

  checks.push(checkRequiredFiles(bundle.archiveRoot));
  checks.push(checkManifestCounts(archiveData, searchIndex, resourceMap, manifest));
  checks.push(checkUniqueIds(archiveData, searchIndex));
  checks.push(checkTimeline(archiveData));
  checks.push(checkConversationOrder(archiveData));
  checks.push(checkImages(bundle.archiveRoot, archiveData, resourceMap));
  checks.push(checkSearchCoverage(archiveData, searchIndex, resourceMap));
  checks.push(checkMarkdown(bundle.archiveRoot, archiveData, resourceMap));
  checks.push(checkHtmlOffline(bundle.archiveRoot));

  const failures = checks.filter((check) => !check.pass);
  return {
    generatedAt: new Date().toISOString(),
    archiveRoot: bundle.archiveRoot,
    pass: failures.length === 0,
    failureCount: failures.length,
    checks,
    failures,
    summary: summarize(bundle, checks)
  };
}

export function writeAuditReports(audit, outputRoot, reportDir = path.join(outputRoot, '_build', 'reports')) {
  fs.mkdirSync(reportDir, { recursive: true });
  writeJson(path.join(reportDir, 'quality-audit.json'), audit);
  fs.writeFileSync(path.join(reportDir, 'quality-audit.md'), renderAuditMarkdown(audit), 'utf8');

  const dataDir = path.join(outputRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  writeJson(path.join(dataDir, 'audit.json'), audit);
}

function checkRequiredFiles(root) {
  const required = [
    'index.html',
    'sessions.html',
    'timeline.html',
    'assets/app.css',
    'assets/app.js',
    'data/archive-data.js',
    'data/search-index.js',
    'data/manifest.json',
    'data/resource-map.json',
    'markdown/README.md',
    'README.md',
    'START_HERE.txt'
  ];
  const missing = required.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)));
  return result('交付目录结构', missing.length === 0, { requiredCount: required.length, missing });
}

function checkManifestCounts(archiveData, searchIndex, resourceMap, manifest) {
  const actual = actualCounts(archiveData, searchIndex, resourceMap);
  const counts = manifest?.counts || archiveData.manifest || {};
  const expected = {
    conversations: counts.conversationCount,
    messages: counts.messageCount,
    timelineEvents: counts.timelineEventCount,
    branchMessages: counts.branchMessageCount,
    hiddenMetadata: counts.hiddenMetadataCount,
    emptyMessages: counts.emptyMessageCount,
    searchItems: archiveData.messages.length + archiveData.branchMessages.length + (resourceMap?.unmatchedNonImageAttachments || []).length,
    resourceImages: counts.imageResourceCount,
    imagePlacements: counts.imagePlacementCount,
    unmatchedNonImageAttachments: counts.unmatchedNonImageAttachmentCount
  };
  return result('核心计数与 manifest 一致', shallowEqual(actual, expected), { actual, expected });
}

function checkUniqueIds(archiveData, searchIndex) {
  const groups = [
    ['会话 ID', archiveData.conversations.map((item) => item.conversation_id)],
    ['当前路径消息 ID', archiveData.messages.map((item) => item.archive_message_id)],
    ['分支消息 ID', archiveData.branchMessages.map((item) => item.archive_message_id)],
    ['时间线事件 ID', archiveData.timelineEvents.map((item) => item.timeline_event_id)],
    ['搜索索引 ID', searchIndex.map((item) => item.search_id)]
  ];
  const failures = groups
    .map(([name, ids]) => ({ name, total: ids.length, unique: new Set(ids).size }))
    .filter((item) => item.total !== item.unique);
  return result('稳定 ID 唯一性', failures.length === 0, { failures });
}

function checkTimeline(archiveData) {
  const messagesById = new Map(archiveData.messages.map((message) => [message.archive_message_id, message]));
  const missingTargets = archiveData.timelineEvents.filter((event) => !messagesById.has(event.archive_message_id));
  const sorted = isSorted(archiveData.timelineEvents, (a, b) =>
    a.effective_time - b.effective_time ||
    a.time_fallback_rank - b.time_fallback_rank ||
    a.timeline_event_id.localeCompare(b.timeline_event_id)
  );
  return result('现实时间线目标与排序', missingTargets.length === 0 && sorted.ok, {
    missingTargetCount: missingTargets.length,
    firstSortFailure: sorted.ok ? null : sorted
  });
}

function checkConversationOrder(archiveData) {
  const messagesByConversation = groupBy(archiveData.messages, (message) => message.conversation_id);
  const failures = [];
  for (const conversation of archiveData.conversations) {
    const messages = messagesByConversation.get(conversation.conversation_id) || [];
    const sorted = isSorted(messages, (a, b) =>
      (a.path_index || 0) - (b.path_index || 0) ||
      a.archive_message_id.localeCompare(b.archive_message_id)
    );
    if (!sorted.ok) failures.push({ conversationId: conversation.conversation_id, reason: 'path_order', firstSortFailure: sorted.index });
    const ids = messages.map((message) => message.archive_message_id);
    const expectedIds = conversation.message_ids || [];
    if (ids.length !== expectedIds.length || ids.some((id, index) => id !== expectedIds[index])) {
      failures.push({ conversationId: conversation.conversation_id, reason: 'message_ids_mismatch', actual: ids.length, expected: expectedIds.length });
    }
  }
  return result('会话当前路径顺序和引用', failures.length === 0, { failures: failures.slice(0, 10), failureCount: failures.length });
}

function checkImages(root, archiveData, resourceMap) {
  const imageParts = archiveData.messages.flatMap((message) => (message.parts || []).filter((part) => part.type === 'image'));
  const missingImageParts = imageParts.filter((part) => !part.outputRelativePath || !fs.existsSync(path.join(root, part.outputRelativePath)));
  const imageFiles = listFiles(path.join(root, 'assets', 'images'), () => true).length;
  const resourceImages = resourceMap?.images || [];
  const imageIds = new Set(imageParts.map((part) => part.resourceId));
  const resourceIds = new Set(resourceImages.map((item) => item.resourceId));
  const missingResources = [...imageIds].filter((id) => !resourceIds.has(id));
  const pass = missingImageParts.length === 0 && imageFiles === resourceImages.length && missingResources.length === 0;
  return result('图片恢复与共享资源', pass, {
    imageParts: imageParts.length,
    imageFiles,
    resourceImages: resourceImages.length,
    missingImagePartCount: missingImageParts.length,
    missingResourceCount: missingResources.length,
    imageByKind: countObject(imageParts, (part) => part.kind || 'unknown')
  });
}

function checkSearchCoverage(archiveData, searchIndex, resourceMap) {
  const expected = {
    message: new Set(archiveData.messages.map((message) => message.archive_message_id)),
    branch_message: new Set(archiveData.branchMessages.map((message) => message.archive_message_id)),
    unmatched_attachment: new Set((resourceMap?.unmatchedNonImageAttachments || []).map((attachment) => attachment.placeholderId))
  };
  const actual = {
    message: countBy(searchIndex.filter((item) => item.target_type === 'message'), (item) => item.target_id),
    branch_message: countBy(searchIndex.filter((item) => item.target_type === 'branch_message'), (item) => item.target_id),
    unmatched_attachment: countBy(searchIndex.filter((item) => item.target_type === 'unmatched_attachment'), (item) => item.target_id)
  };
  const coverage = Object.fromEntries(Object.keys(expected).map((key) => [key, setCoverage(actual[key], expected[key])]));
  const pass = Object.values(coverage).every((item) => item.missing.length === 0 && item.duplicates.length === 0 && item.unexpected.length === 0);
  return result('搜索索引目标完整', pass, {
    searchByType: countObject(searchIndex, (item) => item.target_type),
    coverage: compactCoverage(coverage)
  });
}

function checkMarkdown(root, archiveData, resourceMap) {
  const markdownRoot = path.join(root, 'markdown');
  const markdownFiles = listFiles(markdownRoot, (file) => file.toLowerCase().endsWith('.md'));
  const sessionFiles = listFiles(path.join(markdownRoot, 'sessions'), (file) => file.toLowerCase().endsWith('.md') && path.basename(file) !== 'README.md');
  const timelineFiles = listFiles(path.join(markdownRoot, 'timeline'), (file) => file.toLowerCase().endsWith('.md') && path.basename(file) !== 'README.md');
  const branchFiles = listFiles(path.join(markdownRoot, 'branches'), (file) => file.toLowerCase().endsWith('.md') && path.basename(file) !== 'README.md');
  const imageLinks = findMarkdownImageLinks(markdownFiles);
  const badLinks = findBadMarkdownLinks(markdownFiles, root);
  const expectedImageLinks = archiveData.messages.flatMap((message) => (message.parts || []).filter((part) => part.type === 'image')).length * 3
    + archiveData.branchMessages.flatMap((message) => (message.parts || []).filter((part) => part.type === 'image')).length;
  const unmatchedRows = countTableRows(path.join(markdownRoot, 'appendices', 'unmatched_attachments.md'));
  const pass = sessionFiles.length === archiveData.conversations.length &&
    timelineFiles.length >= 1 &&
    branchFiles.length === archiveData.conversations.filter((conversation) => (conversation.branch_message_ids || []).length > 0).length &&
    imageLinks.length === expectedImageLinks &&
    badLinks.length === 0 &&
    unmatchedRows === (resourceMap?.unmatchedNonImageAttachments || []).length;
  return result('Markdown 输出完整性', pass, {
    files: markdownFiles.length,
    sessionFiles: sessionFiles.length,
    timelineFiles: timelineFiles.length,
    branchFiles: branchFiles.length,
    imageLinks: imageLinks.length,
    expectedImageLinks,
    badLinks: badLinks.slice(0, 10),
    unmatchedRows
  });
}

function checkHtmlOffline(root) {
  const htmlFiles = ['index.html', 'sessions.html', 'timeline.html'];
  const requiredOrder = ['data/archive-data.js', 'data/search-index.js', 'assets/app.js'];
  const htmlOrder = Object.fromEntries(htmlFiles.map((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const positions = requiredOrder.map((src) => text.indexOf(`src="${src}"`));
    return [file, positions.every((pos) => pos >= 0) && isAscending(positions)];
  }));
  const appJs = fs.readFileSync(path.join(root, 'assets', 'app.js'), 'utf8');
  const noNetwork = !/\bfetch\s*\(|XMLHttpRequest|https?:\/\/|localhost|127\.0\.0\.1/.test(appJs);
  return result('HTML 离线应用', Object.values(htmlOrder).every(Boolean) && noNetwork, { htmlOrder, noNetwork });
}

function actualCounts(archiveData, searchIndex, resourceMap) {
  return {
    conversations: archiveData.conversations.length,
    messages: archiveData.messages.length,
    timelineEvents: archiveData.timelineEvents.length,
    branchMessages: archiveData.branchMessages.length,
    hiddenMetadata: (archiveData.hiddenMetadataSummary || []).length,
    emptyMessages: archiveData.manifest?.emptyMessageCount,
    searchItems: searchIndex.length,
    resourceImages: (resourceMap?.images || []).length,
    imagePlacements: archiveData.messages.flatMap((message) => (message.parts || []).filter((part) => part.type === 'image')).length,
    unmatchedNonImageAttachments: (resourceMap?.unmatchedNonImageAttachments || []).length
  };
}

function summarize(bundle, checks) {
  return {
    counts: actualCounts(bundle.archiveData, bundle.searchIndex, bundle.resourceMap),
    checkCount: checks.length,
    failureCount: checks.filter((check) => !check.pass).length
  };
}

function renderAuditMarkdown(audit) {
  const lines = [
    '# 质量审计报告',
    '',
    `生成时间：${audit.generatedAt}`,
    '',
    `总体结果：${audit.pass ? '通过' : '未通过'}`,
    '',
    '| 检查项 | 结果 |',
    '|---|---|'
  ];
  for (const check of audit.checks) lines.push(`| ${check.name} | ${check.pass ? '通过' : '未通过'} |`);
  lines.push('');
  lines.push('## 核心计数');
  lines.push('');
  for (const [key, value] of Object.entries(audit.summary.counts || {})) lines.push(`- ${key}: ${value}`);
  if (audit.failures.length > 0) {
    lines.push('');
    lines.push('## 失败项');
    lines.push('');
    for (const failure of audit.failures) lines.push(`- ${failure.name}`);
  }
  return `${lines.join('\n')}\n`;
}

function findBadMarkdownLinks(markdownFiles, root) {
  const bad = [];
  for (const link of findMarkdownImageLinks(markdownFiles)) {
    if (isForbiddenImageTarget(link.target)) {
      bad.push({ file: link.file, target: link.target, reason: 'non_portable' });
      continue;
    }
    const target = path.resolve(path.dirname(link.file), link.target);
    if (!isInsidePath(path.resolve(root), target) || !fs.existsSync(target)) bad.push({ file: link.file, target: link.target, reason: 'missing_or_outside' });
  }
  for (const link of findHtmlImageLinks(markdownFiles)) {
    if (isForbiddenImageTarget(link.target)) {
      bad.push({ file: link.file, target: link.target, reason: 'non_portable' });
      continue;
    }
    const target = path.resolve(path.dirname(link.file), link.target);
    if (!isInsidePath(path.resolve(root), target) || !fs.existsSync(target)) bad.push({ file: link.file, target: link.target, reason: 'missing_or_outside' });
  }
  return bad;
}

function findMarkdownImageLinks(markdownFiles) {
  const links = [];
  const linkPattern = /!\[[^\]\n]*]\(([^)\n]+)\)/g;
  for (const file of markdownFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(linkPattern)) {
      links.push({ file, target: parseLinkTarget(match[1]) });
    }
  }
  return links;
}

function findHtmlImageLinks(markdownFiles) {
  const links = [];
  const imgPattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  for (const file of markdownFiles) {
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(imgPattern)) {
      links.push({ file, target: parseLinkTarget(match[1] || match[2] || match[3]) });
    }
  }
  return links;
}

function parseLinkTarget(rawTarget) {
  const raw = String(rawTarget || '').trim();
  if (raw.startsWith('<') && raw.endsWith('>')) return raw.slice(1, -1).trim();
  if (raw.startsWith('<') && raw.includes('>')) return raw.slice(1, raw.indexOf('>')).trim();
  return raw.split(/\s+/)[0] || raw;
}

function isForbiddenImageTarget(target) {
  const raw = String(target || '').trim();
  return /^(?:https?:|file:|sandbox:)/i.test(raw) ||
    raw.startsWith('//') ||
    /^[A-Za-z]:/.test(raw) ||
    path.win32.isAbsolute(raw) ||
    path.posix.isAbsolute(raw);
}

function isInsidePath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (process.platform === 'win32') {
    const rootLower = resolvedRoot.toLowerCase();
    const targetLower = resolvedTarget.toLowerCase();
    return targetLower.startsWith(`${rootLower}${path.sep}`);
  }
  return resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function countTableRows(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => /^\| \d+ \|/.test(line)).length;
}

function result(name, pass, details = {}) {
  return { name, pass: Boolean(pass), ...details };
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

function isSorted(items, comparator) {
  for (let index = 1; index < items.length; index += 1) {
    if (comparator(items[index - 1], items[index]) > 0) return { ok: false, index };
  }
  return { ok: true };
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return map;
}

function countObject(items, keyFn) {
  const counts = countBy(items, keyFn);
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

function setCoverage(actualCounts, expectedIds) {
  const missing = [];
  const duplicates = [];
  const unexpected = [];
  for (const expectedId of expectedIds) if (!actualCounts.has(expectedId)) missing.push(expectedId);
  for (const [id, count] of actualCounts.entries()) {
    if (!expectedIds.has(id)) unexpected.push(id);
    if (count > 1) duplicates.push({ id, count });
  }
  return { missing, duplicates, unexpected };
}

function compactCoverage(coverage) {
  return Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key, {
    missing: value.missing.length,
    duplicates: value.duplicates.length,
    unexpected: value.unexpected.length
  }]));
}

function shallowEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function isAscending(values) {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] < 0 || values[index] < 0 || values[index - 1] >= values[index]) return false;
  }
  return true;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
