import fs from 'node:fs';
import path from 'node:path';
import { InputError } from './errors.mjs';

export function resolveExistingInputPath(value) {
  if (!value) throw new InputError('缺少输入路径。');
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new InputError(`输入路径不存在：${resolved}`);
  }
  return resolved;
}

export function normalizeOutputPath(value, inputPath) {
  if (value) return path.resolve(value);
  const parent = fs.statSync(inputPath).isDirectory() ? path.dirname(inputPath) : path.dirname(inputPath);
  return path.join(parent, 'ChatGPT-archive');
}

export function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

export function ensureInside(parent, child) {
  const parentResolved = path.resolve(parent);
  const childResolved = path.resolve(child);
  if (childResolved !== parentResolved && !childResolved.startsWith(parentResolved + path.sep)) {
    throw new InputError(`路径越界：${childResolved} 不在 ${parentResolved} 内`);
  }
  return childResolved;
}
