import { UsageError } from '../lib/errors.mjs';

const commands = new Set([
  'generate',
  'init',
  'status',
  'import-export',
  'import-session',
  'build',
  'list-sessions',
  'remove-session',
  'undo',
  'fetch-current',
  'fetch-all'
]);
const booleanOptions = new Set(['force', 'open', 'dry-run', 'help', 'version', 'quiet', 'verbose', 'skip-resources']);
const leadingCommandOptions = new Set(['help', 'version', 'quiet', 'verbose']);
const valueOptions = new Set([
  'input',
  'output',
  'timezone',
  'config',
  'report-dir',
  'compare-reference',
  'archive',
  'session-id',
  'token',
  'token-file',
  'base-url',
  'account-id',
  'limit',
  'delay-ms'
]);

export function parseArgs(argv) {
  const options = {
    command: 'generate',
    input: null,
    output: null,
    archive: null,
    sessionId: null,
    token: null,
    tokenFile: null,
    baseUrl: null,
    accountId: null,
    limit: null,
    delayMs: null,
    skipResources: false,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    config: null,
    reportDir: null,
    compareReference: null,
    force: false,
    open: false,
    dryRun: false,
    help: false,
    version: false,
    quiet: false,
    verbose: false,
    positional: []
  };
  Object.defineProperty(options, 'providedOptions', { value: new Set(), enumerable: false });

  const args = [...argv];
  const commandIndex = findLeadingCommandIndex(args);
  if (commandIndex >= 0) {
    options.command = args[commandIndex];
    args.splice(commandIndex, 1);
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      options.positional.push(...args.slice(index + 1));
      break;
    }

    if (!arg.startsWith('-')) {
      options.positional.push(arg);
      continue;
    }

    if (!arg.startsWith('--')) {
      throw new UsageError(`不支持短参数：${arg}`);
    }

    const raw = arg.slice(2);
    const equalIndex = raw.indexOf('=');
    const key = equalIndex >= 0 ? raw.slice(0, equalIndex) : raw;
    const inlineValue = equalIndex >= 0 ? raw.slice(equalIndex + 1) : null;

    if (booleanOptions.has(key)) {
      if (inlineValue !== null) throw new UsageError(`布尔参数不接受值：--${key}`);
      setBooleanOption(options, key, true);
      continue;
    }

    if (valueOptions.has(key)) {
      const value = inlineValue !== null ? inlineValue : args[++index];
      if (!value || value.startsWith('--')) {
        throw new UsageError(`参数 --${key} 需要一个值`);
      }
      setValueOption(options, key, value);
      continue;
    }

    throw new UsageError(`未知参数：--${key}`);
  }

  if (options.command === 'generate' && options.input && options.positional.length > 0) {
    throw new UsageError('不能同时使用 --input 和位置参数作为输入路径。请选择一种输入方式。');
  }

  if (options.command === 'generate' && options.positional.length > 1) {
    throw new UsageError(`只允许一个位置参数作为输入路径，收到 ${options.positional.length} 个`);
  }

  if (options.command === 'generate' && options.positional.length === 1) {
    options.input = options.positional[0];
  }

  if (options.quiet && options.verbose) {
    throw new UsageError('不能同时使用 --quiet 和 --verbose');
  }

  return options;
}

function setBooleanOption(options, key, value) {
  const normalized = key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
  options[normalized] = value;
  options.providedOptions.add(key);
}

function findLeadingCommandIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return -1;
    if (isLeadingBooleanOption(arg)) continue;
    if (!arg.startsWith('-') && commands.has(arg)) return index;
    return -1;
  }
  return -1;
}

function isLeadingBooleanOption(arg) {
  if (!arg.startsWith('--')) return false;
  const raw = arg.slice(2);
  if (raw.includes('=')) return false;
  return leadingCommandOptions.has(raw);
}

function setValueOption(options, key, value) {
  options.providedOptions.add(key);
  if (key === 'report-dir') {
    options.reportDir = value;
    return;
  }
  if (key === 'compare-reference') {
    options.compareReference = value;
    return;
  }
  if (key === 'session-id') {
    options.sessionId = value;
    return;
  }
  if (key === 'token-file') {
    options.tokenFile = value;
    return;
  }
  if (key === 'base-url') {
    options.baseUrl = value;
    return;
  }
  if (key === 'account-id') {
    options.accountId = value;
    return;
  }
  if (key === 'delay-ms') {
    options.delayMs = value;
    return;
  }
  options[key] = value;
}

export function usageText() {
  return [
    'ChatGPT Archive Maker',
    '',
    '用法：',
    '  chatgpt-archive-maker --input <OpenAI导出zip或目录> --output <输出目录> [选项]',
    '  chatgpt-archive-maker <OpenAI导出zip或目录> --output <输出目录>',
    '  chatgpt-archive-maker init --archive <归档状态目录>',
    '  chatgpt-archive-maker status --archive <归档状态目录>',
    '  chatgpt-archive-maker import-export --archive <归档状态目录> --input <OpenAI导出zip或目录>',
    '  chatgpt-archive-maker import-session --archive <归档状态目录> --input <会话JSON、导出zip或导出目录> --session-id <id>',
    '  chatgpt-archive-maker build --archive <归档状态目录> --output <输出目录>',
    '  chatgpt-archive-maker list-sessions --archive <归档状态目录>',
    '  chatgpt-archive-maker remove-session --archive <归档状态目录> --session-id <id>',
    '  chatgpt-archive-maker undo --archive <归档状态目录>',
    '  chatgpt-archive-maker fetch-current --archive <归档状态目录> (--session-id <id> | --input <ChatGPT会话链接>)',
    '  chatgpt-archive-maker fetch-all --archive <归档状态目录> [--limit <n>]',
    '',
    '选项：',
    '  --input <path>       OpenAI 导出 zip 或已解压目录；fetch-current 也可传 ChatGPT 会话链接。',
    '  --output <path>      输出归档目录。默认：输入旁边的 ChatGPT-archive。',
    '  --archive <path>     可持续归档系统的状态目录。',
    '  --session-id <id>    指定单个会话；用于后续增量导入、删除和撤销相关命令。',
    '  --token <token>      ChatGPT Web 访问令牌；建议优先使用 CHATGPT_ACCESS_TOKEN 环境变量。',
    '  --token-file <path>  从本地文件读取 ChatGPT Web 访问令牌。',
    '  --base-url <url>     ChatGPT Web 基础地址。默认：https://chatgpt.com。',
    '  --account-id <id>    可选团队或工作区账号编号；也可用 CHATGPT_ACCOUNT_ID。',
    '  --limit <n>          fetch-all 最多获取的会话数量。',
    '  --delay-ms <n>       fetch-all 每个会话请求之间的等待毫秒数。',
    '  --skip-resources     获取会话时不尝试下载图片资源。',
    '  --timezone <name>    输出时间所用时区。默认：当前系统时区。',
    '  --force              输出目录存在时允许覆盖生成内容。',
    '  --open               生成后尝试打开 index.html。',
    '  --dry-run            只解析参数和输入，不写出归档。',
    '  --config <path>      可选配置文件。',
    '  --report-dir <path>  可选报告输出目录。',
    '  --compare-reference <path>  可选参考归档目录；生成后输出对比报告。',
    '  --quiet              只输出错误。',
    '  --verbose            输出更多诊断信息。',
    '  --help               显示帮助。',
    '  --version            显示版本。',
    '',
    '说明：',
    '  没有子命令时保持旧的一次性生成行为。',
    '  Files__...zip 只能作为附件补充输入；完整归档仍需要 conversations.json 或包含它的对话包。',
    '  init、status、import-export、import-session、build、list-sessions、remove-session、undo、fetch-current、fetch-all 是当前可用的状态库命令。',
    '  后续导入、删除和撤销都会围绕 --archive 状态目录运行。'
  ].join('\n');
}
