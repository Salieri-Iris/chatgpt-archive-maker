import path from 'node:path';
import { UsageError } from '../lib/errors.mjs';
import { createLogger } from '../lib/logger.mjs';
import { appendOperation, initializeArchiveState, loadArchiveState } from '../state/state-store.mjs';
import { importExportIntoState } from '../state/import-export.mjs';
import { importSessionIntoState } from '../state/import-session.mjs';
import { buildArchiveFromState } from '../state/build-state.mjs';
import { listSessionsInState, removeSessionFromState, undoLastStateOperation } from '../state/session-actions.mjs';
import { fetchAllConversationsIntoState, fetchCurrentConversationIntoState } from '../state/fetch-chatgpt.mjs';

const sharedOptions = new Set(['help', 'version', 'quiet', 'verbose']);

export function isStateCommand(command) {
  return command !== 'generate';
}

export async function runStateCommand(options) {
  const logger = createLogger({ quiet: options.quiet, verbose: options.verbose });
  if (options.command === 'init') return runInit(options, logger);
  if (options.command === 'status') return runStatus(options, logger);
  if (options.command === 'import-export') return runImportExport(options, logger);
  if (options.command === 'import-session') return runImportSession(options, logger);
  if (options.command === 'build') return runBuild(options, logger);
  if (options.command === 'list-sessions') return runListSessions(options, logger);
  if (options.command === 'remove-session') return runRemoveSession(options, logger);
  if (options.command === 'undo') return runUndo(options, logger);
  if (options.command === 'fetch-current') return runFetchCurrent(options, logger);
  if (options.command === 'fetch-all') return runFetchAll(options, logger);

  throw new UsageError(`命令 ${options.command} 尚未实现。当前可用的归档系统命令：init、status、import-export、import-session、build、list-sessions、remove-session、undo、fetch-current、fetch-all。`);
}

function requireArchivePath(options) {
  if (!options.archive) {
    throw new UsageError(`命令 ${options.command} 需要 --archive <归档状态目录>。`);
  }
  return path.resolve(options.archive);
}

function runInit(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive', 'force']));
  const archiveRoot = requireArchivePath(options);
  const { manifest, created } = initializeArchiveState(archiveRoot, { force: options.force });
  const operation = appendOperation(archiveRoot, manifest, {
    type: 'init',
    summary: created ? '初始化归档状态库。' : '确认归档状态库已经存在。'
  });

  logger.info(created ? `归档状态库已初始化：${archiveRoot}` : `归档状态库已经存在：${archiveRoot}`);
  logger.info(`操作记录：${operation.operation_id}`);
  return { exitCode: 0, archiveRoot, manifest, operation };
}

function runStatus(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive']));
  const archiveRoot = requireArchivePath(options);
  const manifest = loadArchiveState(archiveRoot);
  logger.info(`归档状态库：${archiveRoot}`);
  logger.info(`版本：${manifest.schema_version}`);
  logger.info(`当前会话：${manifest.counts.conversations}`);
  logger.info(`历史会话：${manifest.counts.total_conversations || manifest.counts.conversations}`);
  logger.info(`资源：${manifest.counts.resources}`);
  logger.info(`操作记录：${manifest.counts.operations}`);
  logger.info(`最近操作：${manifest.last_operation_id || '无'}`);
  return { exitCode: 0, archiveRoot, manifest };
}

function runImportExport(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive', 'input']));
  const archiveRoot = requireArchivePath(options);
  if (!options.input) throw new UsageError('命令 import-export 需要 --input <OpenAI导出zip或目录>。');
  const result = importExportIntoState({ archiveRoot, inputPath: options.input, logger });
  logger.info(`导入完成：新增 ${result.counts.added}，更新 ${result.counts.updated}，未变化 ${result.counts.unchanged}`);
  logger.info(`资源复制：图片 ${result.resourceCopy.imageCopyResult.copied}，附件 ${result.resourceCopy.attachmentCopyResult.copied}`);
  logger.info(`操作记录：${result.operation.operation_id}`);
  return { exitCode: 0, ...result };
}

function runImportSession(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive', 'input', 'session-id']));
  const archiveRoot = requireArchivePath(options);
  if (!options.input) throw new UsageError('命令 import-session 需要 --input <会话JSON、导出zip或导出目录>。');
  const result = importSessionIntoState({ archiveRoot, inputPath: options.input, sessionId: options.sessionId, logger });
  logger.info(`会话导入完成：${result.conversationId}，结果：${result.result}`);
  logger.info(`资源复制：图片 ${result.resourceCopy.imageCopyResult.copied}，附件 ${result.resourceCopy.attachmentCopyResult.copied}`);
  logger.info(`操作记录：${result.operation.operation_id}`);
  return { exitCode: 0, ...result };
}

function runBuild(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive', 'output', 'timezone', 'force', 'open', 'dry-run', 'report-dir', 'compare-reference']));
  const archiveRoot = requireArchivePath(options);
  if (!options.output) throw new UsageError('命令 build 需要 --output <输出目录>。');
  const result = buildArchiveFromState({ archiveRoot, options, logger });
  if (options.dryRun) {
    logger.info('状态库构建 dry-run 已完成，未写出归档。');
    return { exitCode: 0, ...result };
  }
  logger.info(`归档已从状态库生成：${result.output.indexPath}`);
  logger.info(`自动审计：通过，报告在 ${path.join(result.context.reportDir, 'quality-audit.json')}`);
  if (result.referenceCompare) logger.info(`参考归档对比：通过，报告在 ${path.join(result.context.reportDir, 'reference-compare.json')}`);
  return { exitCode: 0, ...result };
}

function runListSessions(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive']));
  const archiveRoot = requireArchivePath(options);
  const result = listSessionsInState({ archiveRoot });
  logger.info(`会话总数：${result.sessions.length}；当前可构建：${result.manifest.counts.conversations}；已删除：${result.sessions.filter((session) => session.status === 'deleted').length}`);
  if (result.sessions.length === 0) {
    logger.info('状态库目前没有会话。');
    return { exitCode: 0, ...result };
  }
  for (const session of result.sessions) {
    const status = session.status === 'deleted' ? '已删除' : '当前';
    const deleted = session.deleted_at ? `；删除时间：${session.deleted_at}` : '';
    logger.info(`${status} | ${session.conversation_id} | ${session.title} | 版本：${session.version_count} | 创建：${formatUnixTime(session.create_time)} | 更新：${formatUnixTime(session.update_time)}${deleted}`);
  }
  return { exitCode: 0, ...result };
}

function runRemoveSession(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive', 'session-id']));
  const archiveRoot = requireArchivePath(options);
  const result = removeSessionFromState({ archiveRoot, sessionId: options.sessionId });
  logger.info(`会话已标记为删除：${result.conversationId}`);
  logger.info(`操作记录：${result.operation.operation_id}`);
  return { exitCode: 0, ...result };
}

function runUndo(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive']));
  const archiveRoot = requireArchivePath(options);
  const result = undoLastStateOperation({ archiveRoot });
  logger.info(`已撤销操作：${result.undoneOperation.operation_id}`);
  logger.info(`受影响会话：${result.conversationId}`);
  logger.info(`操作记录：${result.operation.operation_id}`);
  return { exitCode: 0, ...result };
}

async function runFetchCurrent(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive', 'input', 'session-id', 'token', 'token-file', 'base-url', 'account-id', 'delay-ms', 'skip-resources']));
  const archiveRoot = requireArchivePath(options);
  const result = await fetchCurrentConversationIntoState({ archiveRoot, options, logger });
  logger.info(`会话获取完成：${result.conversationId}，结果：${result.result}`);
  logger.info(`资源获取：新增 ${result.resourceDownload.copied}，已存在 ${result.resourceDownload.alreadyPresent}，失败 ${result.resourceDownload.failed.length}`);
  logger.info(`操作记录：${result.operation.operation_id}`);
  return { exitCode: 0, ...result };
}

async function runFetchAll(options, logger) {
  rejectUnexpectedArguments(options, new Set(['archive', 'token', 'token-file', 'base-url', 'account-id', 'limit', 'delay-ms', 'skip-resources']));
  const archiveRoot = requireArchivePath(options);
  const result = await fetchAllConversationsIntoState({ archiveRoot, options, logger });
  logger.info(`全部会话获取完成：新增 ${result.counts.added}，更新 ${result.counts.updated}，未变化 ${result.counts.unchanged}，失败 ${result.counts.failed}`);
  logger.info(`操作记录：${result.operation.operation_id}`);
  return { exitCode: 0, ...result };
}

function rejectUnexpectedArguments(options, allowed) {
  if (options.positional.length > 0) {
    throw new UsageError(`命令 ${options.command} 不接受位置参数：${options.positional.join(', ')}`);
  }

  const unexpected = [];
  for (const key of options.providedOptions || []) {
    if (!allowed.has(key) && !sharedOptions.has(key)) unexpected.push(`--${key}`);
  }

  if (unexpected.length > 0) {
    throw new UsageError(`命令 ${options.command} 不支持这些参数：${unexpected.join(', ')}`);
  }
}

function formatUnixTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '未知';
  return new Date(value * 1000).toISOString();
}
