import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chatgpt-archive-maker-test-'));

try {
  await testExportAndStateCommands();
  await testLiveFetchCommands();
  console.log('integration tests passed');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function testExportAndStateCommands() {
  const exportDir = path.join(tempRoot, 'OpenAI-export');
  const outputDir = path.join(tempRoot, 'archive-output');
  const stateDir = path.join(tempRoot, 'archive-state');
  const removedOutputDir = path.join(tempRoot, 'archive-output-removed');
  const restoredOutputDir = path.join(tempRoot, 'archive-output-restored');
  fs.mkdirSync(exportDir, { recursive: true });
  fs.writeFileSync(
    path.join(exportDir, 'conversations.json'),
    JSON.stringify([
      textConversation('export-one', 'Export One', 1700000000),
      textConversation('export-two', 'Export Two', 1700001000)
    ], null, 2),
    'utf8'
  );

  await runCli(['--input', exportDir, '--output', outputDir, '--force', '--quiet']);
  assertAuditPass(outputDir);

  await runCli(['init', '--archive', stateDir, '--quiet']);
  await runCli(['import-export', '--archive', stateDir, '--input', exportDir, '--quiet']);
  await runCli(['build', '--archive', stateDir, '--output', outputDir, '--force', '--quiet']);
  assertCounts(stateDir, { conversations: 2, total_conversations: 2 });
  await runCli(['remove-session', '--archive', stateDir, '--session-id', 'export-one', '--quiet']);
  await runCli(['build', '--archive', stateDir, '--output', removedOutputDir, '--force', '--quiet']);
  assertCounts(stateDir, { conversations: 1, total_conversations: 2 });
  assertAuditPass(removedOutputDir);
  await runCli(['undo', '--archive', stateDir, '--quiet']);
  await runCli(['build', '--archive', stateDir, '--output', restoredOutputDir, '--force', '--quiet']);
  assertCounts(stateDir, { conversations: 2, total_conversations: 2 });
  assertAuditPass(restoredOutputDir);
}

async function testLiveFetchCommands() {
  const stateAll = path.join(tempRoot, 'fetch-all-state');
  const outAll = path.join(tempRoot, 'fetch-all-output');
  const stateImage = path.join(tempRoot, 'fetch-image-state');
  const outImage = path.join(tempRoot, 'fetch-image-output');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64');
  const conversations = {
    liveOne: textConversation('liveOne', 'Live One', 1700002000),
    liveTwo: textConversation('liveTwo', 'Live Two', 1700003000),
    liveImage: imageConversation('liveImage', 'Live Image', 1700004000)
  };
  const seen = [];
  let baseUrl = '';

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/download/file-img1.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(png);
      return;
    }

    seen.push({ authorization: request.headers.authorization, account: request.headers['chatgpt-account-id'] || null });
    if (request.headers.authorization !== 'Bearer mock-token' || request.headers['chatgpt-account-id'] !== 'acct-1') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ detail: 'bad auth' }));
      return;
    }

    if (url.pathname === '/backend-api/conversations') {
      const offset = Number(url.searchParams.get('offset') || 0);
      const items = ['liveOne', 'liveTwo'].map((id) => ({
        id,
        title: conversations[id].title,
        create_time: conversations[id].create_time,
        update_time: conversations[id].update_time
      }));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ items: items.slice(offset, offset + 1), total: items.length }));
      return;
    }

    const conversationMatch = url.pathname.match(/^\/backend-api\/conversation\/([^/]+)$/);
    if (conversationMatch && conversations[conversationMatch[1]]) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(conversations[conversationMatch[1]]));
      return;
    }

    if (url.pathname === '/backend-api/files/download/file-img1') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'success',
        download_url: `${baseUrl}/download/file-img1.png`,
        file_name: 'file-img1.png',
        mime_type: 'image/png'
      }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ detail: 'not found' }));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await runCli(['init', '--archive', stateAll, '--quiet']);
    await runCli(['fetch-all', '--archive', stateAll, '--base-url', baseUrl, '--token', 'mock-token', '--account-id', 'acct-1', '--limit', '2', '--skip-resources', '--quiet']);
    await runCli(['build', '--archive', stateAll, '--output', outAll, '--force', '--quiet']);
    assertCounts(stateAll, { conversations: 2, total_conversations: 2, resources: 0 });
    assertAuditPass(outAll);

    await runCli(['init', '--archive', stateImage, '--quiet']);
    await runCli(['fetch-current', '--archive', stateImage, '--session-id', 'liveImage', '--base-url', baseUrl, '--token', 'mock-token', '--account-id', 'acct-1', '--quiet']);
    await runCli(['build', '--archive', stateImage, '--output', outImage, '--force', '--quiet']);
    assertCounts(stateImage, { conversations: 1, total_conversations: 1, resources: 1 });
    assertImageAudit(outImage);
    await runCli(['undo', '--archive', stateImage, '--quiet']);
    assertCounts(stateImage, { conversations: 0, total_conversations: 0, resources: 0 });
    const imageDir = path.join(stateImage, 'resources', 'assets', 'images');
    if (fs.existsSync(imageDir) && fs.readdirSync(imageDir).length !== 0) {
      throw new Error('undo did not remove newly downloaded image resources');
    }

    if (!seen.every((item) => item.authorization === 'Bearer mock-token' && item.account === 'acct-1')) {
      throw new Error('live fetch requests did not include expected auth headers');
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function textConversation(id, title, time) {
  return {
    id,
    title,
    create_time: time,
    update_time: time + 60,
    current_node: `${id}-assistant`,
    mapping: {
      [`${id}-root`]: { id: `${id}-root`, children: [`${id}-user`] },
      [`${id}-user`]: {
        id: `${id}-user`,
        parent: `${id}-root`,
        children: [`${id}-assistant`],
        message: message(`${id}-user`, 'user', time, `hello ${id}`)
      },
      [`${id}-assistant`]: {
        id: `${id}-assistant`,
        parent: `${id}-user`,
        children: [],
        message: message(`${id}-assistant`, 'assistant', time + 30, `reply ${id}`)
      }
    }
  };
}

function imageConversation(id, title, time) {
  const conversation = textConversation(id, title, time);
  conversation.mapping[`${id}-user`].message.content = {
    content_type: 'multimodal_text',
    parts: [
      'look',
      {
        content_type: 'image_asset_pointer',
        asset_pointer: 'sediment://file-img1',
        width: 1,
        height: 1
      }
    ]
  };
  return conversation;
}

function message(id, role, time, text) {
  return {
    id,
    author: { role, metadata: {} },
    create_time: time,
    content: { content_type: 'text', parts: [text] },
    recipient: 'all',
    status: 'finished_successfully'
  };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['bin/chatgpt-archive-maker.mjs', ...args], { cwd: repoRoot });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`command timed out: ${args.join(' ')}`));
    }, 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`command failed: ${args.join(' ')}\n${stdout}\n${stderr}`));
    });
  });
}

function assertCounts(stateDir, expected) {
  const manifest = JSON.parse(fs.readFileSync(path.join(stateDir, 'manifest.json'), 'utf8'));
  for (const [key, value] of Object.entries(expected)) {
    if (manifest.counts[key] !== value) {
      throw new Error(`expected ${key}=${value}, got ${manifest.counts[key]}`);
    }
  }
}

function assertAuditPass(outputDir) {
  const audit = JSON.parse(fs.readFileSync(path.join(outputDir, '_build', 'reports', 'quality-audit.json'), 'utf8'));
  if (!audit.pass || audit.failureCount !== 0) {
    throw new Error(`audit failed for ${outputDir}`);
  }
}

function assertImageAudit(outputDir) {
  const audit = JSON.parse(fs.readFileSync(path.join(outputDir, '_build', 'reports', 'quality-audit.json'), 'utf8'));
  const imageCheck = audit.checks.find((item) => item.name === '图片恢复与共享资源');
  if (!audit.pass || !imageCheck?.pass || imageCheck.imageParts !== 1 || imageCheck.imageFiles !== 1 || imageCheck.resourceImages !== 1) {
    throw new Error('image resource audit failed');
  }
}
