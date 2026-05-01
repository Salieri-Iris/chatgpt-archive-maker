import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildArchiveData, writeJsDataValue } from './archive-data.mjs';
import { htmlPages } from './html.mjs';
import { writeMarkdownFiles } from './markdown.mjs';
import { writeResourceArtifacts } from '../resources/write-resources.mjs';
import { InputError } from '../lib/errors.mjs';

export function writeArchiveOutput({ context, model, resourceMap }) {
  prepareOutputRoot(context.outputPath, context.force);

  const dataBundle = buildArchiveData(model, resourceMap, context);
  const resourceWriteResult = writeResourceArtifacts(resourceMap, context.outputPath);
  writeDataFiles(context.outputPath, dataBundle);
  writeHtmlFiles(context.outputPath);
  copyStaticAssets(context.outputPath);
  const markdownResult = writeMarkdownFiles({
    archiveData: dataBundle.archiveData,
    resourceMap: dataBundle.resourceMap,
    outputRoot: context.outputPath
  });
  writeEntryDocuments(context.outputPath, dataBundle.archiveData, markdownResult);

  return {
    outputPath: context.outputPath,
    indexPath: path.join(context.outputPath, 'index.html'),
    manifest: dataBundle.manifest,
    counts: {
      ...dataBundle.archiveData.manifest,
      searchItems: dataBundle.searchIndex.length,
      markdownFiles: markdownResult.files.length
    },
    resourceWriteResult,
    markdownResult
  };
}

function prepareOutputRoot(outputRoot, force) {
  const resolved = path.resolve(outputRoot);
  if (fs.existsSync(resolved) && fs.readdirSync(resolved).length > 0 && !force) {
    throw new InputError(`输出目录已存在且不是空目录：${resolved}\n请换一个输出目录，或使用 --force 覆盖生成器管理的输出文件。`);
  }
  fs.mkdirSync(resolved, { recursive: true });
  if (!force) return;

  for (const relativePath of [
    'assets',
    'data',
    'markdown',
    '_build',
    'index.html',
    'sessions.html',
    'timeline.html',
    'README.md',
    'START_HERE.txt'
  ]) {
    removeGeneratedPath(path.join(resolved, relativePath), resolved);
  }
}

function removeGeneratedPath(target, outputRoot) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(outputRoot);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`拒绝删除输出目录之外的位置：${resolvedTarget}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function writeDataFiles(outputRoot, dataBundle) {
  const dataDir = path.join(outputRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  writeJson(path.join(dataDir, 'manifest.json'), dataBundle.manifest);
  writeJson(path.join(dataDir, 'resource-map.json'), dataBundle.resourceMap);
  fs.writeFileSync(path.join(dataDir, 'archive-data.js'), writeJsDataValue('CHATGPT_ARCHIVE_DATA', dataBundle.archiveData), 'utf8');
  fs.writeFileSync(path.join(dataDir, 'search-index.js'), writeJsDataValue('CHATGPT_ARCHIVE_SEARCH', dataBundle.searchIndex), 'utf8');
}

function writeHtmlFiles(outputRoot) {
  for (const [fileName, html] of Object.entries(htmlPages())) {
    fs.writeFileSync(path.join(outputRoot, fileName), html, 'utf8');
  }
}

function copyStaticAssets(outputRoot) {
  const staticRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
  const assetsDir = path.join(outputRoot, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.copyFileSync(path.join(staticRoot, 'app.css'), path.join(assetsDir, 'app.css'));
  fs.copyFileSync(path.join(staticRoot, 'app.js'), path.join(assetsDir, 'app.js'));
}

function writeEntryDocuments(outputRoot, archiveData, markdownResult) {
  const counts = archiveData.manifest;
  const readme = [
    '# ChatGPT Archive',
    '',
    '这是由 OpenAI ChatGPT 数据导出包生成的离线归档。',
    '',
    '## 打开方式',
    '',
    '- `index.html`：总览和全局搜索。',
    '- `sessions.html`：按会话阅读。',
    '- `timeline.html`：按现实时间阅读。',
    '- `markdown/README.md`：可编辑 Markdown 入口。',
    '',
    '## 统计',
    '',
    `- 会话：${counts.conversationCount}`,
    `- 当前路径消息：${counts.messageCount}`,
    `- 时间线事件：${counts.timelineEventCount}`,
    `- 分支消息：${counts.branchMessageCount}`,
    `- 图片位置：${counts.imagePlacementCount}`,
    `- 图片文件：${counts.imageResourceCount}`,
    `- Markdown 文件：${markdownResult.files.length}`
  ].join('\n');
  fs.writeFileSync(path.join(outputRoot, 'README.md'), `${readme}\n`, 'utf8');

  const startHere = [
    'ChatGPT Archive',
    '',
    '建议从 index.html 开始。',
    '如果想编辑或全文搜索纯文本，请打开 markdown/README.md。',
    '',
    `会话：${counts.conversationCount}`,
    `当前路径消息：${counts.messageCount}`,
    `图片文件：${counts.imageResourceCount}`
  ].join('\n');
  fs.writeFileSync(path.join(outputRoot, 'START_HERE.txt'), `${startHere}\n`, 'utf8');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
