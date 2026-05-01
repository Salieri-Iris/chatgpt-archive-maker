import { UsageError } from '../lib/errors.mjs';

const booleanOptions = new Set(['force', 'open', 'dry-run', 'help', 'version', 'quiet', 'verbose']);
const valueOptions = new Set(['input', 'output', 'timezone', 'config', 'report-dir', 'compare-reference']);

export function parseArgs(argv) {
  const options = {
    input: null,
    output: null,
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

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      options.positional.push(...argv.slice(index + 1));
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
      const value = inlineValue !== null ? inlineValue : argv[++index];
      if (!value || value.startsWith('--')) {
        throw new UsageError(`参数 --${key} 需要一个值`);
      }
      setValueOption(options, key, value);
      continue;
    }

    throw new UsageError(`未知参数：--${key}`);
  }

  if (options.input && options.positional.length > 0) {
    throw new UsageError('不能同时使用 --input 和位置参数作为输入路径。请选择一种输入方式。');
  }

  if (options.positional.length > 1) {
    throw new UsageError(`只允许一个位置参数作为输入路径，收到 ${options.positional.length} 个`);
  }

  if (options.positional.length === 1) {
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
}

function setValueOption(options, key, value) {
  if (key === 'report-dir') {
    options.reportDir = value;
    return;
  }
  if (key === 'compare-reference') {
    options.compareReference = value;
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
    '',
    '选项：',
    '  --input <path>       OpenAI 导出 zip 或已解压目录。',
    '  --output <path>      输出归档目录。默认：输入旁边的 ChatGPT-archive。',
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
    '  Files__...zip 只能作为附件补充输入；完整归档仍需要 conversations.json 或包含它的对话包。'
  ].join('\n');
}
