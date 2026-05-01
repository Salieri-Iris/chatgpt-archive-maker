export function htmlPages() {
  return {
    'index.html': indexHtml(),
    'sessions.html': sessionsHtml(),
    'timeline.html': timelineHtml()
  };
}

function head(title) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <link rel="stylesheet" href="assets/app.css">
  <script defer src="data/archive-data.js"></script>
  <script defer src="data/search-index.js"></script>
  <script defer src="assets/app.js"></script>
</head>`;
}

function topbar(active) {
  return `<header class="topbar">
    <a class="brand" href="index.html">ChatGPT 归档</a>
    <nav class="nav" aria-label="主要页面">
      <a class="nav-link${active === 'home' ? ' active' : ''}" href="index.html">总览</a>
      <a class="nav-link${active === 'sessions' ? ' active' : ''}" href="sessions.html">会话</a>
      <a class="nav-link${active === 'timeline' ? ' active' : ''}" href="timeline.html">时间线</a>
      <a class="nav-link" href="markdown/README.md">Markdown</a>
    </nav>
  </header>`;
}

function indexHtml() {
  return `${head('ChatGPT 归档')}
<body data-page="home">
  ${topbar('home')}
  <main class="page page-home">
    <section class="workspace-header">
      <div>
        <p class="eyebrow">离线归档</p>
        <h1>ChatGPT 对话归档</h1>
        <p class="muted">按会话浏览、按现实时间浏览，并保留图片、分支记录和可编辑 Markdown。</p>
      </div>
      <div class="header-actions">
        <a class="button primary" href="sessions.html">打开会话版</a>
        <a class="button" href="timeline.html">打开时间线版</a>
      </div>
    </section>

    <section id="home-summary" class="metric-grid" aria-label="归档统计"></section>

    <section class="panel search-panel" aria-labelledby="home-search-title">
      <div class="panel-heading">
        <div>
          <h2 id="home-search-title">全局搜索</h2>
          <p class="muted">搜索当前路径消息、分支消息和未匹配附件记录。</p>
        </div>
      </div>
      <label class="search-box">
        <span>搜索</span>
        <input id="global-search" type="search" autocomplete="off" placeholder="输入关键词">
      </label>
      <div id="search-results" class="search-results" aria-live="polite"></div>
    </section>

    <section class="two-column">
      <div class="panel">
        <div class="panel-heading">
          <h2>最近会话</h2>
          <a href="sessions.html">查看全部</a>
        </div>
        <div id="recent-sessions" class="compact-list"></div>
      </div>
      <div class="panel">
        <div class="panel-heading">
          <h2>可编辑文本</h2>
          <a href="markdown/README.md">打开索引</a>
        </div>
        <div class="link-stack">
          <a href="markdown/sessions/README.md">会话版 Markdown</a>
          <a href="markdown/timeline/000_all_timeline.md">完整时间线 Markdown</a>
          <a href="markdown/branches/README.md">分支附录</a>
          <a href="markdown/appendices/raw_export_boundary.md">原始边界说明</a>
        </div>
      </div>
    </section>
  </main>
</body>
</html>
`;
}

function sessionsHtml() {
  return `${head('会话版 · ChatGPT 归档')}
<body data-page="sessions">
  ${topbar('sessions')}
  <main class="page split-page">
    <aside class="sidebar" aria-label="会话列表">
      <div class="sidebar-header">
        <h1>会话版</h1>
        <p class="muted">按每个 session 的当前路径顺序阅读。</p>
      </div>
      <label class="search-box compact">
        <span>筛选</span>
        <input id="session-filter" type="search" autocomplete="off" placeholder="会话标题">
      </label>
      <div id="session-list" class="session-list"></div>
    </aside>
    <section class="reader" aria-label="会话正文">
      <div id="session-toolbar" class="reader-toolbar"></div>
      <div id="session-messages" class="message-list"></div>
      <div id="session-more" class="load-more"></div>
    </section>
  </main>
</body>
</html>
`;
}

function timelineHtml() {
  return `${head('时间线版 · ChatGPT 归档')}
<body data-page="timeline">
  ${topbar('timeline')}
  <main class="page timeline-page">
    <section class="workspace-header compact-header">
      <div>
        <p class="eyebrow">现实时间排序</p>
        <h1>时间线版</h1>
        <p class="muted">把所有当前路径消息按有效现实时间合并排列。</p>
      </div>
      <a class="button" href="markdown/timeline/000_all_timeline.md">打开完整 Markdown</a>
    </section>

    <section class="panel timeline-controls" aria-label="时间线筛选">
      <label>
        <span>月份</span>
        <select id="timeline-month"></select>
      </label>
      <label>
        <span>角色</span>
        <select id="timeline-role">
          <option value="all">全部角色</option>
          <option value="user">用户</option>
          <option value="assistant">ChatGPT</option>
          <option value="tool">工具</option>
        </select>
      </label>
      <label class="grow">
        <span>筛选正文</span>
        <input id="timeline-query" type="search" autocomplete="off" placeholder="输入关键词">
      </label>
    </section>

    <section id="timeline-summary" class="timeline-summary"></section>
    <section id="timeline-messages" class="message-list timeline-list" aria-label="时间线正文"></section>
    <div id="timeline-more" class="load-more"></div>
  </main>
</body>
</html>
`;
}
