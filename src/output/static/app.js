(function () {
  'use strict';

  const data = window.CHATGPT_ARCHIVE_DATA;
  const searchIndex = window.CHATGPT_ARCHIVE_SEARCH || [];

  if (!data) {
    document.body.innerHTML = '<main class="page"><div class="panel empty">没有加载到归档数据。</div></main>';
    return;
  }

  const conversations = [...data.conversations].sort((a, b) => a.conversation_ordinal - b.conversation_ordinal);
  const messages = data.messages || [];
  const timelineEvents = data.timelineEvents || [];
  const branchMessages = data.branchMessages || [];
  const messagesById = new Map(messages.map((message) => [message.archive_message_id, message]));
  const conversationsById = new Map(conversations.map((conversation) => [conversation.conversation_id, conversation]));
  const messagesByConversation = groupBy(messages, (message) => message.conversation_id);
  const branchByConversation = groupBy(branchMessages, (message) => message.conversation_id);
  const page = document.body.dataset.page;
  const url = new URL(window.location.href);

  const state = {
    selectedConversationId: url.searchParams.get('conversation') || conversations[0]?.conversation_id,
    targetMessageId: url.searchParams.get('message') || '',
    sessionVisible: numberParam('show', 80),
    timelineVisible: numberParam('show', 160)
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (page === 'home') renderHome();
    if (page === 'sessions') renderSessionsPage();
    if (page === 'timeline') renderTimelinePage();
  });

  function numberParam(name, fallback) {
    const raw = Number(url.searchParams.get(name));
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
  }

  function groupBy(items, keyFn) {
    const map = new Map();
    for (const item of items) {
      const key = keyFn(item);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    return map;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function cleanTitle(value) {
    return String(value || '未命名会话').replace(/\s+/g, ' ').trim();
  }

  function truncate(value, max = 220) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}...` : text;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat('zh-CN').format(value || 0);
  }

  function markdownSessionHref(conversation) {
    return `markdown/sessions/${encodeURI(conversation.slug)}.md`;
  }

  function markdownBranchHref(conversation, messageId) {
    const anchor = messageId ? `#${encodeURIComponent(messageId)}` : '';
    return `markdown/branches/${encodeURI(conversation.slug)}.md${anchor}`;
  }

  function roleClass(message) {
    if (message.role === 'user') return 'user';
    if (message.role === 'assistant') return 'assistant';
    return 'tool';
  }

  function byPathIndex(a, b) {
    return (a.path_index || 0) - (b.path_index || 0);
  }

  function renderHome() {
    const manifest = data.manifest || {};
    const summary = document.querySelector('#home-summary');
    summary.innerHTML = [
      metric('会话', manifest.conversationCount, 'session 独立文件'),
      metric('当前路径消息', manifest.messageCount, '进入默认阅读正文'),
      metric('图片位置', manifest.imagePlacementCount, '全部已恢复到消息中'),
      metric('分支消息', manifest.branchMessageCount, '保留在附录')
    ].join('');

    renderRecentSessions();
    setupGlobalSearch(document.querySelector('#global-search'), document.querySelector('#search-results'));
  }

  function metric(label, value, note) {
    return `<div class="metric"><strong>${formatNumber(value)}</strong><span>${escapeHtml(label)}</span><p class="muted">${escapeHtml(note)}</p></div>`;
  }

  function renderRecentSessions() {
    const container = document.querySelector('#recent-sessions');
    const recent = [...conversations]
      .sort((a, b) => (b.update_time || 0) - (a.update_time || 0))
      .slice(0, 6);
    container.innerHTML = recent.map((conversation) => {
      const count = (messagesByConversation.get(conversation.conversation_id) || []).length;
      return `<a class="compact-item" href="sessions.html?conversation=${encodeURIComponent(conversation.conversation_id)}">
        <span class="item-title">${escapeHtml(cleanTitle(conversation.conversation_title))}</span>
        <span class="item-meta">${escapeHtml(conversation.update_time_shanghai || '未知时间')} · ${formatNumber(count)} 条消息</span>
      </a>`;
    }).join('');
  }

  function setupGlobalSearch(input, container) {
    if (!input || !container) return;
    input.addEventListener('input', debounce(() => {
      const query = input.value.trim();
      renderSearchResults(container, query);
    }, 120));
    renderSearchResults(container, '');
  }

  function renderSearchResults(container, query) {
    if (!query) {
      container.innerHTML = '<div class="empty">输入关键词后开始搜索。</div>';
      return;
    }

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const item of searchIndex) {
      const haystack = `${item.conversation_title || ''} ${item.role || ''} ${item.text || ''} ${(item.resource_names || []).join(' ')}`.toLowerCase();
      if (terms.every((term) => haystack.includes(term))) {
        results.push(item);
        if (results.length >= 80) break;
      }
    }

    if (!results.length) {
      container.innerHTML = '<div class="empty">没有找到匹配结果。</div>';
      return;
    }

    container.innerHTML = results.map((item) => renderSearchItem(item, terms)).join('');
  }

  function renderSearchItem(item, terms) {
    const href = targetHref(item);
    const typeLabel = item.target_type === 'message' ? '当前路径' : item.target_type === 'branch_message' ? '分支' : '附件记录';
    const title = `${item.role || '记录'} · ${item.time || '未知时间'} · ${typeLabel}`;
    return `<a class="result-item" href="${href}">
      <span class="item-title">${escapeHtml(cleanTitle(item.conversation_title))}</span>
      <span class="item-meta">${escapeHtml(title)}</span>
      <span class="item-snippet">${highlight(truncate(item.text, 260), terms)}</span>
    </a>`;
  }

  function targetHref(item) {
    const conversation = conversationsById.get(item.conversation_id);
    if (item.target_type === 'message') {
      return `sessions.html?conversation=${encodeURIComponent(item.conversation_id)}&message=${encodeURIComponent(item.target_id)}`;
    }
    if (item.target_type === 'branch_message' && conversation) {
      return markdownBranchHref(conversation, item.target_id);
    }
    return 'markdown/appendices/unmatched_attachments.md';
  }

  function highlight(text, terms) {
    let escaped = escapeHtml(text);
    for (const term of terms.filter((item) => item.length >= 2)) {
      const pattern = new RegExp(escapeRegExp(escapeHtml(term)), 'gi');
      escaped = escaped.replace(pattern, (match) => `<mark>${match}</mark>`);
    }
    return escaped;
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function renderSessionsPage() {
    const filter = document.querySelector('#session-filter');
    filter.addEventListener('input', debounce(renderSessionList, 100));
    renderSessionList();
    renderSelectedSession();
  }

  function renderSessionList() {
    const filter = document.querySelector('#session-filter').value.trim().toLowerCase();
    const container = document.querySelector('#session-list');
    const filtered = conversations.filter((conversation) => {
      const text = `${conversation.conversation_title || ''} ${conversation.create_time_shanghai || ''}`.toLowerCase();
      return !filter || text.includes(filter);
    });

    container.innerHTML = filtered.map((conversation) => {
      const count = (messagesByConversation.get(conversation.conversation_id) || []).length;
      const branchCount = (conversation.branch_message_ids || []).length;
      const active = conversation.conversation_id === state.selectedConversationId ? ' active' : '';
      return `<button class="session-row${active}" type="button" data-conversation="${escapeHtml(conversation.conversation_id)}">
        <span class="item-title">${escapeHtml(conversation.conversation_ordinal)}. ${escapeHtml(cleanTitle(conversation.conversation_title))}</span>
        <span class="item-meta">${escapeHtml(conversation.create_time_shanghai || '未知时间')} · ${formatNumber(count)} 条 · 分支 ${formatNumber(branchCount)}</span>
      </button>`;
    }).join('') || '<div class="empty">没有匹配的会话。</div>';

    container.querySelectorAll('[data-conversation]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedConversationId = button.dataset.conversation;
        state.targetMessageId = '';
        state.sessionVisible = 80;
        updateUrl({ conversation: state.selectedConversationId });
        renderSessionList();
        renderSelectedSession();
      });
    });
  }

  function renderSelectedSession() {
    const conversation = conversationsById.get(state.selectedConversationId) || conversations[0];
    if (!conversation) return;
    state.selectedConversationId = conversation.conversation_id;
    const allMessages = [...(messagesByConversation.get(conversation.conversation_id) || [])].sort(byPathIndex);
    const targetIndex = state.targetMessageId ? allMessages.findIndex((message) => message.archive_message_id === state.targetMessageId) : -1;
    if (targetIndex >= state.sessionVisible) {
      state.sessionVisible = Math.min(allMessages.length, targetIndex + 30);
    }
    const visible = allMessages.slice(0, state.sessionVisible);
    const branches = branchByConversation.get(conversation.conversation_id) || [];

    document.querySelector('#session-toolbar').innerHTML = renderSessionToolbar(conversation, allMessages.length, branches.length);
    document.querySelector('#session-messages').innerHTML = visible.length
      ? visible.map((message) => renderMessage(message, false)).join('')
      : '<div class="panel empty">此会话没有可展示消息。</div>';
    renderMoreButton('#session-more', allMessages.length, state.sessionVisible, () => {
      state.sessionVisible = Math.min(allMessages.length, state.sessionVisible + 120);
      updateUrl({ conversation: state.selectedConversationId, show: state.sessionVisible });
      renderSelectedSession();
    }, () => {
      state.sessionVisible = allMessages.length;
      updateUrl({ conversation: state.selectedConversationId, show: state.sessionVisible });
      renderSelectedSession();
    });
    scrollToTarget();
  }

  function renderSessionToolbar(conversation, count, branchCount) {
    const branchLink = branchCount > 0
      ? `<a class="button" href="${markdownBranchHref(conversation)}">分支附录</a>`
      : '<span class="pill">无分支</span>';
    return `<div class="toolbar-grid">
      <div>
        <h2>${escapeHtml(cleanTitle(conversation.conversation_title))}</h2>
        <p class="muted">创建：${escapeHtml(conversation.create_time_shanghai || '未知')} · 更新：${escapeHtml(conversation.update_time_shanghai || '未知')} · 当前路径 ${formatNumber(count)} 条 · 分支 ${formatNumber(branchCount)} 条</p>
      </div>
      <div class="toolbar-links">
        <a class="button" href="${markdownSessionHref(conversation)}">Markdown</a>
        ${branchLink}
      </div>
    </div>`;
  }

  function renderTimelinePage() {
    const monthSelect = document.querySelector('#timeline-month');
    const roleSelect = document.querySelector('#timeline-role');
    const queryInput = document.querySelector('#timeline-query');
    const months = [...new Set(timelineEvents.map((event) => monthFromEvent(event)))].sort();
    monthSelect.innerHTML = '<option value="all">全部月份</option>' + months.map((month) => `<option value="${month}">${month}</option>`).join('');
    monthSelect.value = url.searchParams.get('month') || 'all';
    roleSelect.value = url.searchParams.get('role') || 'all';
    queryInput.value = url.searchParams.get('q') || '';

    [monthSelect, roleSelect, queryInput].forEach((control) => {
      control.addEventListener('input', debounce(() => {
        state.timelineVisible = 160;
        updateUrl({
          month: monthSelect.value === 'all' ? '' : monthSelect.value,
          role: roleSelect.value === 'all' ? '' : roleSelect.value,
          q: queryInput.value.trim(),
          show: ''
        });
        renderTimelineMessages();
      }, 120));
    });

    renderTimelineMessages();
  }

  function monthFromEvent(event) {
    const time = event.effective_time_shanghai || 'unknown-time';
    const match = time.match(/^(\d{4})\/(\d{2})/);
    return match ? `${match[1]}-${match[2]}` : 'unknown-time';
  }

  function renderTimelineMessages() {
    const month = document.querySelector('#timeline-month').value;
    const role = document.querySelector('#timeline-role').value;
    const query = document.querySelector('#timeline-query').value.trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    let events = timelineEvents.filter((event) => {
      if (month !== 'all' && monthFromEvent(event) !== month) return false;
      if (role !== 'all' && event.role !== role) return false;
      const message = messagesById.get(event.archive_message_id);
      if (!message) return false;
      if (!terms.length) return true;
      const haystack = `${message.conversation_title || ''} ${message.role_label || ''} ${message.search_text || ''}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    });

    const targetIndex = state.targetMessageId ? events.findIndex((event) => event.archive_message_id === state.targetMessageId) : -1;
    if (targetIndex >= state.timelineVisible) {
      state.timelineVisible = Math.min(events.length, targetIndex + 50);
    }

    const visible = events.slice(0, state.timelineVisible);
    document.querySelector('#timeline-summary').innerHTML = `共匹配 <strong>${formatNumber(events.length)}</strong> 条消息。当前显示 ${formatNumber(visible.length)} 条。`;
    document.querySelector('#timeline-messages').innerHTML = visible.length
      ? visible.map((event) => renderMessage(messagesById.get(event.archive_message_id), true)).join('')
      : '<div class="panel empty">没有匹配的时间线消息。</div>';
    renderMoreButton('#timeline-more', events.length, state.timelineVisible, () => {
      state.timelineVisible = Math.min(events.length, state.timelineVisible + 200);
      updateUrl({ show: state.timelineVisible });
      renderTimelineMessages();
    }, () => {
      state.timelineVisible = events.length;
      updateUrl({ show: state.timelineVisible });
      renderTimelineMessages();
    });
    scrollToTarget();
  }

  function renderMoreButton(selector, total, visible, moreFn, allFn) {
    const container = document.querySelector(selector);
    if (visible >= total) {
      container.innerHTML = '';
      return;
    }
    container.innerHTML = `<div class="toolbar-links">
      <button type="button" class="primary" data-more>再显示一段</button>
      <button type="button" data-all>显示全部 ${formatNumber(total)} 条</button>
    </div>`;
    container.querySelector('[data-more]').addEventListener('click', moreFn);
    container.querySelector('[data-all]').addEventListener('click', allFn);
  }

  function renderMessage(message, includeConversation) {
    if (!message) return '';
    const classes = ['message', roleClass(message), message.display_class === 'collapsible' ? 'collapsible' : ''].filter(Boolean).join(' ');
    const title = includeConversation
      ? `${message.role_label || message.role} · ${message.effective_time_shanghai || '未知时间'} · ${cleanTitle(message.conversation_title)}`
      : `${message.role_label || message.role} · ${message.effective_time_shanghai || '未知时间'}`;
    const body = renderMessageBody(message);
    const meta = `${message.archive_message_id} · ${message.content_type || 'content'} · ${message.display_class || 'main'}`;

    if (message.display_class === 'collapsible') {
      return `<article id="${escapeHtml(message.archive_message_id)}" class="${classes}">
        <details>
          <summary class="message-header">
            <span class="message-role">${escapeHtml(title)}</span>
            <span class="message-time">${escapeHtml(meta)}</span>
          </summary>
          <div class="message-body">${body}</div>
        </details>
      </article>`;
    }

    return `<article id="${escapeHtml(message.archive_message_id)}" class="${classes}">
      <div class="message-header">
        <span class="message-role">${escapeHtml(title)}</span>
        <span class="message-time">${escapeHtml(meta)}</span>
      </div>
      <div class="message-body">${body}</div>
    </article>`;
  }

  function renderMessageBody(message) {
    const parts = message.parts || [];
    if (!parts.length) return '<div class="part-text">此消息没有可展示正文。</div>';
    return parts.map(renderPart).join('');
  }

  function renderPart(part) {
    if (part.type === 'text') {
      return `<div class="part part-text">${escapeHtml(part.text)}</div>`;
    }
    if (part.type === 'image') {
      const src = escapeHtml(part.outputRelativePath || '');
      const alt = escapeHtml(part.alt || part.resourceId || '图片');
      const caption = [part.kind === 'content.screenshot.asset_pointer' ? '截图' : '图片', part.placementId, part.resourceId].filter(Boolean).join(' · ');
      return `<figure class="part image-part">
        <img src="${src}" alt="${alt}" loading="lazy">
        <figcaption>${escapeHtml(caption)}</figcaption>
      </figure>`;
    }
    if (part.type === 'code') {
      return `<pre class="part part-code"><code>${escapeHtml(part.text || '')}</code></pre>`;
    }
    if (part.type === 'tool_output') {
      return `<details class="part" open>
        <summary>工具输出：${escapeHtml(part.label || 'output')}</summary>
        <pre class="part-output"><code>${escapeHtml(part.text || '')}</code></pre>
      </details>`;
    }
    if (part.type === 'reasoning') {
      return `<details class="part">
        <summary>推理记录</summary>
        <div class="part-text">${escapeHtml(part.text || '')}</div>
      </details>`;
    }
    if (part.type === 'attachment_placeholder') {
      return `<div class="part attachment-note">
        <strong>附件未能定位：${escapeHtml(part.name || part.id || '未知附件')}</strong>
        <div>类型：${escapeHtml(part.mime || '未知')} · 大小：${escapeHtml(formatFileSize(part.size))}</div>
        <div>${escapeHtml(part.reason || '原始导出未提供可定位文件')}</div>
      </div>`;
    }
    return `<pre class="part part-code"><code>${escapeHtml(JSON.stringify(part, null, 2))}</code></pre>`;
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes)) return '未知大小';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function updateUrl(values) {
    const next = new URL(window.location.href);
    Object.entries(values).forEach(([key, value]) => {
      if (value === '' || value === null || value === undefined) next.searchParams.delete(key);
      else next.searchParams.set(key, value);
    });
    window.history.replaceState({}, '', next);
  }

  function scrollToTarget() {
    if (!state.targetMessageId) return;
    window.requestAnimationFrame(() => {
      const target = document.getElementById(state.targetMessageId);
      if (target) {
        target.scrollIntoView({ block: 'center' });
        target.classList.add('target-flash');
        setTimeout(() => target.classList.remove('target-flash'), 1600);
      }
    });
  }

  function debounce(fn, delay) {
    let timer = 0;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), delay);
    };
  }
})();
