import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { InputError } from '../lib/errors.mjs';

export function isZipPath(filePath) {
  return path.extname(filePath).toLowerCase() === '.zip';
}

export function listZipEntries(zipPath) {
  if (!fs.existsSync(zipPath)) throw new InputError(`zip 文件不存在：${zipPath}`);
  if (os.platform() === 'win32') return listZipEntriesWithPowerShell(zipPath);
  return listZipEntriesWithUnzip(zipPath);
}

export function extractZip(zipPath, targetDir) {
  if (!fs.existsSync(zipPath)) throw new InputError(`zip 文件不存在：${zipPath}`);
  fs.mkdirSync(targetDir, { recursive: true });
  if (os.platform() === 'win32') return extractZipWithPowerShell(zipPath, targetDir);
  run('unzip', ['-oq', zipPath, '-d', targetDir], `解压 zip 失败：${zipPath}`);
}

export function readZipTextEntry(zipPath, entryName) {
  if (!fs.existsSync(zipPath)) throw new InputError(`zip 文件不存在：${zipPath}`);
  if (os.platform() === 'win32') {
    const command = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$zip=${psString(zipPath)}`,
      `$entryName=${psString(entryName)}`,
      '$archive=[System.IO.Compression.ZipFile]::OpenRead($zip)',
      'try {',
      '  $entry=$archive.GetEntry($entryName)',
      '  if ($null -eq $entry) { throw "zip entry not found: $entryName" }',
      '  $reader=[System.IO.StreamReader]::new($entry.Open(), [System.Text.Encoding]::UTF8)',
      '  try { $reader.ReadToEnd() } finally { $reader.Dispose() }',
      '} finally { $archive.Dispose() }'
    ].join('; ');
    return runPowerShell(command, `读取 zip 条目失败：${zipPath}::${entryName}`);
  }
  return run('unzip', ['-p', zipPath, entryName], `读取 zip 条目失败：${zipPath}::${entryName}`);
}

export function extractZipEntryToFile(zipPath, entryName, targetFile) {
  if (!fs.existsSync(zipPath)) throw new InputError(`zip 文件不存在：${zipPath}`);
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  if (os.platform() === 'win32') {
    const command = [
      '$ErrorActionPreference="Stop"',
      '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      `$zip=${psString(zipPath)}`,
      `$entryName=${psString(entryName)}`,
      `$target=${psString(targetFile)}`,
      '$archive=[System.IO.Compression.ZipFile]::OpenRead($zip)',
      'try {',
      '  $entry=$archive.GetEntry($entryName)',
      '  if ($null -eq $entry) { throw "zip entry not found: $entryName" }',
      '  $input=$entry.Open()',
      '  $output=[System.IO.File]::Create($target)',
      '  try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }',
      '} finally { $archive.Dispose() }'
    ].join('; ');
    runPowerShell(command, `提取 zip 条目失败：${zipPath}::${entryName}`);
    return;
  }

  const fd = fs.openSync(targetFile, 'w');
  let result;
  try {
    result = spawnSync('unzip', ['-p', zipPath, entryName], {
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024
    });
  } finally {
    fs.closeSync(fd);
  }
  if (result.error) {
    const hint = result.error.code === 'ENOENT'
      ? '\n未找到 unzip 命令。请安装 unzip，或先手动解压 zip 后传入目录。'
      : '';
    throw new InputError(`提取 zip 条目失败：${zipPath}::${entryName}${hint}\n无法启动命令 unzip：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = cleanProcessOutput(result.stderr || `unzip exited with ${result.status}`);
    throw new InputError(`提取 zip 条目失败：${zipPath}::${entryName}\n命令 unzip 退出码 ${result.status}。\n${detail}`);
  }
}

function listZipEntriesWithPowerShell(zipPath) {
  const command = [
    '$ErrorActionPreference="Stop"',
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip=${psString(zipPath)}`,
    '$archive=[System.IO.Compression.ZipFile]::OpenRead($zip)',
    'try {',
    '  $archive.Entries | ForEach-Object {',
    '    [PSCustomObject]@{ FullName=$_.FullName; Length=$_.Length; CompressedLength=$_.CompressedLength }',
    '  } | ConvertTo-Json -Depth 3',
    '} finally { $archive.Dispose() }'
  ].join('; ');
  const stdout = runPowerShell(command, `读取 zip 目录失败：${zipPath}`);
  if (!stdout.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new InputError(`读取 zip 目录失败：${zipPath}\nPowerShell 返回了无法解析的目录信息：${error.message}`);
  }
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
    fullName: entry.FullName,
    length: Number(entry.Length) || 0,
    compressedLength: Number(entry.CompressedLength) || 0
  }));
}

function extractZipWithPowerShell(zipPath, targetDir) {
  const command = [
    '$ErrorActionPreference="Stop"',
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip=${psString(zipPath)}`,
    `$target=${psString(targetDir)}`,
    '$targetRoot=[System.IO.Path]::GetFullPath($target)',
    'if (-not $targetRoot.EndsWith([System.IO.Path]::DirectorySeparatorChar)) { $targetRoot += [System.IO.Path]::DirectorySeparatorChar }',
    '$archive=[System.IO.Compression.ZipFile]::OpenRead($zip)',
    'try {',
    '  foreach ($entry in $archive.Entries) {',
    '    if ([string]::IsNullOrWhiteSpace($entry.FullName)) { continue }',
    '    $destination=[System.IO.Path]::GetFullPath((Join-Path $target $entry.FullName))',
    '    if (-not $destination.StartsWith($targetRoot, [System.StringComparison]::OrdinalIgnoreCase)) { throw "zip 条目路径越界：$($entry.FullName)" }',
    '    if ([string]::IsNullOrEmpty($entry.Name)) { [System.IO.Directory]::CreateDirectory($destination) | Out-Null; continue }',
    '    $parent=[System.IO.Path]::GetDirectoryName($destination)',
    '    if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }',
    '    if ([System.IO.File]::Exists($destination)) { [System.IO.File]::Delete($destination) }',
    '    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination)',
    '  }',
    '} finally { $archive.Dispose() }'
  ].join('; ');
  runPowerShell(command, `解压 zip 失败：${zipPath}`);
}

function listZipEntriesWithUnzip(zipPath) {
  const stdout = run('unzip', ['-Z', '-1', zipPath], `读取 zip 目录失败：${zipPath}`);
  return stdout.split(/\r?\n/).filter(Boolean).map((fullName) => ({
    fullName,
    length: 0,
    compressedLength: 0
  }));
}

function runPowerShell(command, errorPrefix) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], errorPrefix);
}

function run(command, args, errorPrefix) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024
  });
  if (result.error) {
    const hint = command === 'unzip' && result.error.code === 'ENOENT'
      ? '\n未找到 unzip 命令。请安装 unzip，或先手动解压 zip 后传入目录。'
      : '';
    throw new InputError(`${errorPrefix}${hint}\n无法启动命令 ${command}：${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = cleanProcessOutput(result.stderr || result.stdout || `${command} exited with ${result.status}`);
    throw new InputError(`${errorPrefix}\n命令 ${command} 退出码 ${result.status}。\n${detail}`);
  }
  return result.stdout || '';
}

function cleanProcessOutput(value) {
  return String(value || '').trim() || '没有返回更多错误细节。';
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
