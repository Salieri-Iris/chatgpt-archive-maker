import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadArchiveBundle } from './load-archive.mjs';

export function compareArchiveWithReference(outputRoot, referenceRoot) {
  const output = loadArchiveBundle(outputRoot);
  const reference = loadArchiveBundle(referenceRoot);
  const comparisons = [
    compareCounts(output, reference),
    compareConversationShape(output, reference),
    compareIdSets(output, reference),
    compareImageResources(output, reference),
    compareSearchShape(output, reference),
    compareMarkdownInventory(output.archiveRoot, reference.archiveRoot),
    compareMarkdownFileNames(output.archiveRoot, reference.archiveRoot),
    compareEntrypoints(output.archiveRoot, reference.archiveRoot)
  ];
  const failures = comparisons.filter((item) => !item.pass);
  return {
    generatedAt: new Date().toISOString(),
    outputRoot: output.archiveRoot,
    referenceRoot: reference.archiveRoot,
    pass: failures.length === 0,
    failureCount: failures.length,
    comparisons,
    failures
  };
}

export function writeReferenceCompareReports(compare, outputRoot, reportDir = path.join(outputRoot, '_build', 'reports')) {
  fs.mkdirSync(reportDir, { recursive: true });
  writeJson(path.join(reportDir, 'reference-compare.json'), compare);
  fs.writeFileSync(path.join(reportDir, 'reference-compare.md'), renderReferenceCompareMarkdown(compare), 'utf8');
}

function compareCounts(output, reference) {
  const actual = countSummary(output);
  const expected = countSummary(reference);
  return result('核心计数对齐', shallowEqual(actual, expected), { actual, expected });
}

function compareConversationShape(output, reference) {
  const actual = output.archiveData.conversations.map((conversation) => ({
    id: conversation.conversation_id,
    title: conversation.conversation_title,
    messages: conversation.message_ids.length,
    branches: conversation.branch_message_ids.length
  }));
  const expected = reference.archiveData.conversations.map((conversation) => ({
    id: conversation.conversation_id,
    title: conversation.conversation_title,
    messages: conversation.message_ids.length,
    branches: conversation.branch_message_ids.length
  }));
  const mismatch = firstMismatch(actual, expected);
  return result('会话清单与消息分布对齐', mismatch == null, {
    actual: digestRecords(actual),
    expected: digestRecords(expected),
    mismatch
  });
}

function compareImageResources(output, reference) {
  const actual = imageSummary(output);
  const expected = imageSummary(reference);
  return result('图片资源与图片位置对齐', shallowEqual(actual, expected), { actual, expected });
}

function compareIdSets(output, reference) {
  const actual = idSummary(output);
  const expected = idSummary(reference);
  return result('核心数据 ID 集合对齐', shallowEqual(actual, expected), {
    actual,
    expected,
    mismatchSamples: mismatchSamples(actual, expected)
  });
}

function compareSearchShape(output, reference) {
  const actual = countByObject(output.searchIndex, (item) => item.target_type);
  const expected = countByObject(reference.searchIndex, (item) => item.target_type);
  return result('搜索索引类型分布对齐', shallowEqual(actual, expected), { actual, expected });
}

function compareMarkdownInventory(outputRoot, referenceRoot) {
  const actual = markdownInventory(outputRoot);
  const expected = markdownInventory(referenceRoot);
  return result('Markdown 文件分布对齐', shallowEqual(actual, expected), { actual, expected });
}

function compareMarkdownFileNames(outputRoot, referenceRoot) {
  const actual = markdownRelativeFiles(outputRoot);
  const expected = markdownRelativeFiles(referenceRoot);
  const mismatch = firstMismatch(actual, expected);
  return result('Markdown 文件名集合对齐', mismatch == null, {
    actual: digestList(actual),
    expected: digestList(expected),
    mismatch
  });
}

function compareEntrypoints(outputRoot, referenceRoot) {
  const files = ['index.html', 'sessions.html', 'timeline.html', 'assets/app.css', 'assets/app.js'];
  const actual = Object.fromEntries(files.map((file) => [file, fs.existsSync(path.join(outputRoot, file))]));
  const expected = Object.fromEntries(files.map((file) => [file, fs.existsSync(path.join(referenceRoot, file))]));
  return result('HTML 入口与静态资源存在性对齐', shallowEqual(actual, expected), { actual, expected });
}

function countSummary(bundle) {
  const data = bundle.archiveData;
  const resourceMap = bundle.resourceMap || {};
  return {
    conversations: data.conversations.length,
    messages: data.messages.length,
    timelineEvents: data.timelineEvents.length,
    branchMessages: data.branchMessages.length,
    hiddenMetadata: (data.hiddenMetadataSummary || []).length,
    emptyMessages: manifestCount(bundle, 'emptyMessageCount'),
    imageParts: data.messages.flatMap((message) => (message.parts || []).filter((part) => part.type === 'image')).length,
    imageResources: (resourceMap.images || data.resources?.images || []).length,
    unmatchedAttachments: (resourceMap.unmatchedNonImageAttachments || data.resources?.unmatchedAttachments || []).length,
    searchItems: bundle.searchIndex.length,
    markdownFiles: markdownRelativeFiles(bundle.archiveRoot).length
  };
}

function imageSummary(bundle) {
  const data = bundle.archiveData;
  const imageParts = data.messages.flatMap((message) => (message.parts || []).filter((part) => part.type === 'image'));
  const imageResources = bundle.resourceMap?.images || data.resources?.images || [];
  const imageFileNames = imageResources.map((item) => path.posix.basename(item.outputRelativePath || '')).sort();
  return {
    imageParts: imageParts.length,
    imageResources: imageResources.length,
    imageFileNameDigest: digestList(imageFileNames),
    imagePlacementDigest: digestImagePlacements(bundle),
    byKind: JSON.stringify(countByObject(imageParts, (part) => part.kind || 'unknown'))
  };
}

function manifestCount(bundle, key) {
  return bundle.archiveData.manifest?.[key] ?? bundle.manifest?.counts?.[key] ?? null;
}

function idSummary(bundle) {
  return {
    conversations: digestList(bundle.archiveData.conversations.map((item) => item.conversation_id).sort()),
    messages: digestList(bundle.archiveData.messages.map((item) => item.archive_message_id).sort()),
    timelineEvents: digestList(bundle.archiveData.timelineEvents.map((item) => item.timeline_event_id).sort()),
    branchMessages: digestList(bundle.archiveData.branchMessages.map((item) => item.archive_message_id).sort())
  };
}

function markdownInventory(root) {
  const markdownRoot = path.join(root, 'markdown');
  const files = listMarkdownFiles(markdownRoot);
  return {
    files: files.length,
    sessions: files.filter((file) => file.includes(`${path.sep}sessions${path.sep}`) && path.basename(file) !== 'README.md').length,
    timeline: files.filter((file) => file.includes(`${path.sep}timeline${path.sep}`) && path.basename(file) !== 'README.md').length,
    branches: files.filter((file) => file.includes(`${path.sep}branches${path.sep}`) && path.basename(file) !== 'README.md').length,
    appendices: files.filter((file) => file.includes(`${path.sep}appendices${path.sep}`)).length
  };
}

function markdownRelativeFiles(root) {
  const markdownRoot = path.join(root, 'markdown');
  return listMarkdownFiles(markdownRoot).map((file) => path.relative(markdownRoot, file).split(path.sep).join('/')).sort();
}

function digestImagePlacements(bundle) {
  const placements = bundle.resourceMap?.imagePlacements || [];
  return digestRecords(placements.map((placement) => ({
    conversationId: placement.conversationId,
    nodeId: placement.nodeId,
    messageId: placement.messageId,
    kind: placement.kind,
    partIndex: placement.partIndex ?? null,
    resourceId: placement.resourceId,
    outputRelativePath: placement.outputRelativePath || null
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

function listMarkdownFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listMarkdownFiles(fullPath));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(fullPath);
  }
  return out.sort();
}

function countByObject(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}

function firstMismatch(actual, expected) {
  if (actual.length !== expected.length) return { reason: 'length', actual: actual.length, expected: expected.length };
  for (let index = 0; index < actual.length; index += 1) {
    if (JSON.stringify(actual[index]) !== JSON.stringify(expected[index])) return { index, actual: actual[index], expected: expected[index] };
  }
  return null;
}

function mismatchSamples(actual, expected) {
  return Object.fromEntries(Object.keys(actual).map((key) => {
    if (actual[key] === expected[key]) return [key, null];
    return [key, { actual: actual[key], expected: expected[key] }];
  }).filter(([, value]) => value !== null));
}

function digestList(items) {
  return `${items.length}:${crypto.createHash('sha256').update(items.join('\n')).digest('hex')}`;
}

function digestRecords(items) {
  return digestList(items.map((item) => JSON.stringify(item)));
}

function renderReferenceCompareMarkdown(compare) {
  const lines = [
    '# 参考归档对比报告',
    '',
    `生成时间：${compare.generatedAt}`,
    '',
    `总体结果：${compare.pass ? '通过' : '未通过'}`,
    '',
    '| 对比项 | 结果 |',
    '|---|---|'
  ];
  for (const item of compare.comparisons) lines.push(`| ${item.name} | ${item.pass ? '通过' : '未通过'} |`);
  if (compare.failures.length > 0) {
    lines.push('');
    lines.push('## 失败项');
    lines.push('');
    for (const failure of compare.failures) lines.push(`- ${failure.name}`);
  }
  return `${lines.join('\n')}\n`;
}

function result(name, pass, details = {}) {
  return { name, pass: Boolean(pass), ...details };
}

function shallowEqual(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
