import fs from 'node:fs';
import { InputError, UsageError } from '../lib/errors.mjs';

const defaultBaseUrl = 'https://chatgpt.com';

export function createChatgptClient(options = {}) {
  const token = resolveAccessToken(options);
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.CHATGPT_BASE_URL || defaultBaseUrl);
  const accountId = options.accountId || process.env.CHATGPT_ACCOUNT_ID || null;
  const delayMs = parseNonNegativeInteger(options.delayMs, 0, '--delay-ms');

  return {
    baseUrl,
    delayMs,
    async fetchConversation(sessionId) {
      return apiJson({ baseUrl, token, accountId, pathName: `/conversation/${encodeURIComponent(sessionId)}` });
    },
    async fetchConversationListPage({ offset = 0, limit = 100 } = {}) {
      return apiJson({ baseUrl, token, accountId, pathName: '/conversations', params: { offset, limit } });
    },
    async fetchFileDownload(fileId) {
      return apiJson({
        baseUrl,
        token,
        accountId,
        pathName: `/files/download/${encodeURIComponent(fileId)}`,
        params: { post_id: '', inline: 'false' }
      });
    },
    async fetchUrl(url) {
      const response = await fetch(url);
      if (!response.ok) {
        throw new InputError(`资源下载失败：HTTP ${response.status} ${response.statusText}`);
      }
      return response;
    }
  };
}

export function parseFetchLimit(value, fallback = 1000) {
  return parsePositiveInteger(value, fallback, '--limit');
}

export async function fetchAllConversationItems(client, options = {}) {
  const maxItems = parseFetchLimit(options.limit, 1000);
  const pageLimit = Math.min(100, maxItems);
  const out = [];
  let offset = 0;

  while (out.length < maxItems) {
    const result = await client.fetchConversationListPage({ offset, limit: pageLimit });
    const items = Array.isArray(result.items) ? result.items : [];
    out.push(...items);
    if (items.length === 0) break;
    if (typeof result.total === 'number' && out.length >= result.total) break;
    offset += items.length;
  }

  return out.slice(0, maxItems);
}

export function sessionIdFromInput(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const urlMatch = text.match(/\/c\/([A-Za-z0-9-]+)/) || text.match(/[?&]conversation_id=([A-Za-z0-9-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9-]{12,}$/.test(text)) return text;
  return null;
}

export async function maybeDelay(ms) {
  if (!ms) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveAccessToken(options) {
  const raw = options.token || readTokenFile(options.tokenFile) || process.env.CHATGPT_ACCESS_TOKEN || '';
  const token = String(raw).trim().replace(/^Bearer\s+/i, '');
  if (!token) {
    throw new UsageError(
      [
        'fetch-current 和 fetch-all 需要 ChatGPT Web 访问令牌。',
        '请设置 CHATGPT_ACCESS_TOKEN 环境变量，或使用 --token-file <path> / --token <token>。',
        '这个令牌来自 ChatGPT 网页请求的 Authorization 头，属于敏感信息，请不要提交到仓库。'
      ].join('\n')
    );
  }
  return token;
}

function readTokenFile(filePath) {
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new InputError(`无法读取 token 文件：${filePath}\n${error.message}`);
  }
}

function normalizeBaseUrl(value) {
  const text = String(value || defaultBaseUrl).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(text)) throw new UsageError(`--base-url 必须是 http 或 https 地址：${value}`);
  return text;
}

function apiUrl(baseUrl, pathName, params = {}) {
  const prefix = baseUrl.endsWith('/backend-api') ? baseUrl : `${baseUrl}/backend-api`;
  const url = new URL(`${prefix}${pathName}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url;
}

async function apiJson({ baseUrl, token, accountId, pathName, params = {}, init = {} }) {
  const response = await fetch(apiUrl(baseUrl, pathName, params), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Authorization': `Bearer ${token}`,
      ...(accountId ? { 'Chatgpt-Account-Id': accountId } : {}),
      ...(init.headers || {})
    }
  });

  if (!response.ok) {
    throw new InputError(`ChatGPT Web 请求失败：HTTP ${response.status} ${response.statusText}`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new InputError(`ChatGPT Web 返回了无法解析的 JSON：${error.message}`);
  }
}

function parsePositiveInteger(value, fallback, label) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`${label} 必须是正整数。`);
  return parsed;
}

function parseNonNegativeInteger(value, fallback, label) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new UsageError(`${label} 必须是非负整数。`);
  return parsed;
}
