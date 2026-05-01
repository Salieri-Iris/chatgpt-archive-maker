import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, usageText } from './parse-args.mjs';
import { isStateCommand, runStateCommand } from './state-commands.mjs';
import { discoverExportInput, formatDiscoverySummary } from '../input/discover.mjs';
import { loadConversationsFromDiscovery } from '../model/load-conversations.mjs';
import { normalizeConversations, formatModelSummary } from '../model/normalize.mjs';
import { enrichModelWithResources, formatResourceSummary, mapResources } from '../resources/map-resources.mjs';
import { auditArchiveOutput, writeAuditReports } from '../audit/audit-output.mjs';
import { compareArchiveWithReference, writeReferenceCompareReports } from '../audit/compare-reference.mjs';
import { writeArchiveOutput } from '../output/write-output.mjs';
import { createRunContext } from '../lib/context.mjs';
import { InputError, UsageError } from '../lib/errors.mjs';
import { createLogger } from '../lib/logger.mjs';

export async function runCli(argv) {
  const options = parseArgs(argv);

  if (options.help) {
    console.log(usageText());
    return { exitCode: 0 };
  }

  if (options.version) {
    console.log(await packageVersion());
    return { exitCode: 0 };
  }

  if (isStateCommand(options.command)) {
    return runStateCommand(options);
  }

  if (!options.input) {
    throw new UsageError('缺少输入路径。请使用 --input <OpenAI导出zip或目录>，或传入一个位置参数。', 2);
  }

  const logger = createLogger({ quiet: options.quiet, verbose: options.verbose });
  const context = createRunContext(options);

  logger.info(`输入：${context.inputPath}`);
  logger.info(`输出：${context.outputPath}`);
  logger.info(`时区：${context.timezone}`);

  const discovery = discoverExportInput(context.inputPath);
  if (!discovery.hasConversationData) {
    throw new InputError(
      [
        '没有找到 conversations.json 或包含它的对话包，无法生成完整归档。',
        `输入类型：${discovery.inputKind}`,
        discovery.filesZips.length > 0 ? '检测到 Files__...zip，但它只能作为附件补充输入。' : null
      ].filter(Boolean).join('\n')
    );
  }

  logger.info(formatDiscoverySummary(discovery));
  const conversations = loadConversationsFromDiscovery(discovery);
  const model = normalizeConversations(conversations, { timezone: context.timezone, sourceExportRoot: context.inputPath });
  logger.info(formatModelSummary(model));
  const resourceMap = mapResources(model, discovery);
  const modelWithResources = enrichModelWithResources(model, resourceMap);
  logger.info(formatResourceSummary(resourceMap));

  if (options.dryRun) {
    logger.info('dry-run：已完成参数解析、路径规范化、导出包探测、数据模型和资源映射，未写出归档。');
    return { exitCode: 0, context, discovery, model: modelWithResources, resourceMap };
  }

  const output = writeArchiveOutput({ context, discovery, model: modelWithResources, resourceMap });
  const audit = auditArchiveOutput(context.outputPath);
  writeAuditReports(audit, context.outputPath, context.reportDir);
  if (!audit.pass) {
    throw new InputError(`归档已写出，但自动审计未通过。请查看：${path.join(context.reportDir, 'quality-audit.json')}`);
  }

  let referenceCompare = null;
  if (context.compareReferencePath) {
    referenceCompare = compareArchiveWithReference(context.outputPath, context.compareReferencePath);
    writeReferenceCompareReports(referenceCompare, context.outputPath, context.reportDir);
    if (!referenceCompare.pass) {
      throw new InputError(`参考归档对比未通过。请查看：${path.join(context.reportDir, 'reference-compare.json')}`);
    }
  }

  logger.info(`归档已生成：${output.indexPath}`);
  logger.info(`自动审计：通过，报告在 ${path.join(context.reportDir, 'quality-audit.json')}`);
  if (referenceCompare) logger.info(`参考归档对比：通过，报告在 ${path.join(context.reportDir, 'reference-compare.json')}`);
  logger.info(`Markdown 文件：${output.counts.markdownFiles}`);
  logger.info(`搜索条目：${output.counts.searchItems}`);
  if (context.open) openIndex(output.indexPath);
  return { exitCode: 0, context, discovery, model: modelWithResources, resourceMap, output, audit, referenceCompare };
}

async function packageVersion() {
  const currentFile = fileURLToPath(import.meta.url);
  const packagePath = path.resolve(path.dirname(currentFile), '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  return pkg.version;
}

function openIndex(indexPath) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', indexPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [indexPath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [indexPath], { detached: true, stdio: 'ignore' }).unref();
}
