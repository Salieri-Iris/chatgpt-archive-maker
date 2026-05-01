import path from 'node:path';
import { spawn } from 'node:child_process';
import { normalizeConversations, formatModelSummary } from '../model/normalize.mjs';
import { mapResources, enrichModelWithResources, formatResourceSummary } from '../resources/map-resources.mjs';
import { writeArchiveOutput } from '../output/write-output.mjs';
import { auditArchiveOutput, writeAuditReports } from '../audit/audit-output.mjs';
import { compareArchiveWithReference, writeReferenceCompareReports } from '../audit/compare-reference.mjs';
import { InputError } from '../lib/errors.mjs';
import { loadActiveConversationsFromState, loadArchiveState, statePaths } from './state-store.mjs';

export function buildArchiveFromState({ archiveRoot, options, logger }) {
  const paths = statePaths(archiveRoot);
  const manifest = loadArchiveState(archiveRoot);
  const conversations = loadActiveConversationsFromState(archiveRoot, manifest);
  if (conversations.length === 0) {
    throw new InputError('归档状态库里没有可构建的会话。请先运行 import-export 或 import-session。');
  }

  const context = createStateBuildContext({ archiveRoot, options });
  const model = normalizeConversations(conversations, { timezone: context.timezone, sourceExportRoot: paths.root });
  logger.info(formatModelSummary(model));
  const discovery = stateResourceDiscovery(paths);
  const resourceMap = mapResources(model, discovery);
  const modelWithResources = enrichModelWithResources(model, resourceMap);
  logger.info(formatResourceSummary(resourceMap));

  if (options.dryRun) {
    logger.info('dry-run：已从状态库完成数据模型和资源映射，未写出归档。');
    return { context, manifest, model: modelWithResources, resourceMap };
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

  if (context.open) openIndex(output.indexPath);
  return { context, manifest, model: modelWithResources, resourceMap, output, audit, referenceCompare };
}

function createStateBuildContext({ archiveRoot, options }) {
  const outputPath = path.resolve(options.output);
  const reportDir = options.reportDir ? path.resolve(options.reportDir) : path.join(outputPath, '_build', 'reports');
  return {
    inputPath: path.resolve(archiveRoot),
    outputPath,
    reportDir,
    timezone: options.timezone,
    force: options.force,
    open: options.open,
    dryRun: options.dryRun,
    configPath: options.config ? path.resolve(options.config) : null,
    compareReferencePath: options.compareReference ? path.resolve(options.compareReference) : null
  };
}

function stateResourceDiscovery(paths) {
  return {
    inputPath: paths.root,
    inputKind: 'archive_state',
    rootDir: paths.root,
    conversationJsons: [],
    conversationDirs: [{ path: paths.resources, relativePath: 'resources' }],
    possibleConversationDirs: [],
    conversationZips: [],
    filesZips: [],
    optionalFiles: [],
    zipEntries: [],
    warnings: [],
    primaryConversationJson: null,
    hasConversationData: true,
    counts: {
      conversationJsons: 0,
      conversationDirs: 1,
      possibleConversationDirs: 0,
      conversationZips: 0,
      filesZips: 0,
      optionalFiles: 0,
      zipEntries: 0
    }
  };
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
