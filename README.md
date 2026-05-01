# ChatGPT Archive Maker

把 OpenAI ChatGPT 网页端的数据导出包转换成离线、可搜索、可编辑的个人归档。

English documentation: [README.en.md](README.en.md)

## 它适合做什么

ChatGPT Archive Maker 面向想长期保存自己 ChatGPT 导出数据的人。它会从本地导出包中读取对话、图片和附件信息，生成一个可以直接离线打开的归档目录。归档包含按会话阅读的版本、按现实时间排序的时间线版本，以及可继续编辑的 Markdown 文件。

本仓库只保存生成器代码，不需要、也不应该保存任何用户导出包、对话内容、图片或生成后的归档结果。

## 主要能力

- 支持完整的 OpenAI 导出压缩包，也支持已经解压出来的导出目录。
- 自动寻找对话数据、对话分包和附件分包。
- 把图片复制到归档资源目录，并在消息中恢复到原本出现的位置。
- 输出两个网页阅读视图：按现实时间排序的时间线，以及按会话独立排列的阅读页。
- 同时输出可编辑的 Markdown，包括会话版、时间线版、分支附录和隐藏上下文附录。
- 生成本地搜索索引、图片资源映射、质量审计报告，以及可选的参考归档对比报告。
- 生成后的网页可以通过本地文件直接打开，不依赖外部网络资源。
- 提供可持续归档状态库：可以先导入完整导出包，再增量加入单个会话、列出会话、软删除会话、撤销最近一次支持的操作，并从状态库重新生成归档。
- 提供可选的 ChatGPT Web 获取器第一版：可以在用户主动提供访问令牌时获取指定会话或分页获取会话列表，再导入状态库。

## 环境要求

- Node.js 20 或更高版本。
- Windows 用户可以使用 `build-archive.cmd`。
- macOS、Linux 或其他环境可以直接使用 Node.js 命令行入口。

## 快速开始

如果项目目录旁边有 `OpenAI-export` 或 `OpenAI-export.zip`，Windows 用户可以直接运行：

```powershell
.\build-archive.cmd
```

默认输出目录是项目旁边的 `ChatGPT-archive-generated`。

## 指定输入和输出

使用已经解压的导出目录：

```powershell
node bin/chatgpt-archive-maker.mjs --input "D:\path\to\OpenAI-export" --output "D:\path\to\ChatGPT-archive-generated" --force
```

直接使用完整导出压缩包：

```powershell
node bin/chatgpt-archive-maker.mjs --input "D:\path\to\OpenAI-export.zip" --output "D:\path\to\ChatGPT-archive-generated" --force
```

如果希望用固定时区显示时间，可以传入 `--timezone`：

```powershell
node bin/chatgpt-archive-maker.mjs --input "D:\path\to\OpenAI-export.zip" --output "D:\path\to\ChatGPT-archive-generated" --timezone Asia/Shanghai --force
```

如果已有一份旧归档，可以生成后自动比较关键结构：

```powershell
node bin/chatgpt-archive-maker.mjs --input "D:\path\to\OpenAI-export.zip" --output "D:\path\to\ChatGPT-archive-generated" --force --compare-reference "D:\path\to\previous-archive"
```

## 持续归档模式

如果你希望把归档当作一个长期维护的本地库，而不是每次从头生成，可以使用状态库命令。状态库目录只应保存在本机，里面会包含对话 JSON 和资源文件，不应提交到 Git。

初始化状态库：

```powershell
node bin/chatgpt-archive-maker.mjs init --archive "D:\path\to\archive-state"
```

从完整 OpenAI 导出包导入：

```powershell
node bin/chatgpt-archive-maker.mjs import-export --archive "D:\path\to\archive-state" --input "D:\path\to\OpenAI-export.zip"
```

只导入一个指定会话。输入可以是完整导出包、已解压导出目录、`conversations.json`，也可以是单个会话 JSON：

```powershell
node bin/chatgpt-archive-maker.mjs import-session --archive "D:\path\to\archive-state" --input "D:\path\to\OpenAI-export" --session-id "conversation-id"
```

从状态库生成最终归档：

```powershell
node bin/chatgpt-archive-maker.mjs build --archive "D:\path\to\archive-state" --output "D:\path\to\ChatGPT-archive-generated" --timezone Asia/Shanghai --force
```

查看、删除和撤销：

```powershell
node bin/chatgpt-archive-maker.mjs list-sessions --archive "D:\path\to\archive-state"
node bin/chatgpt-archive-maker.mjs remove-session --archive "D:\path\to\archive-state" --session-id "conversation-id"
node bin/chatgpt-archive-maker.mjs undo --archive "D:\path\to\archive-state"
```

删除是软删除，原始版本仍保留在状态库中；重新 `build` 时会排除已删除会话。`undo` 目前支持撤销最近一次 `remove-session`，也支持撤销新格式记录下的 `import-session` 或 `fetch-current`。

## 可选实时获取

`fetch-current` 和 `fetch-all` 是实验性的可选能力，用于从当前 ChatGPT Web 会话接口拉取数据并导入状态库。它依赖 ChatGPT Web 的非公开接口，可能因为网页端改版而失效。最稳定、最推荐的数据来源仍然是 OpenAI 官方导出包。

这两个命令需要访问令牌。推荐把令牌放在环境变量或本地文件里，不要写进命令历史、脚本或 Git 仓库。PowerShell 中可以用交互输入设置临时环境变量，避免把令牌明文保存到历史记录：

```powershell
$secureToken = Read-Host "ChatGPT access token" -AsSecureString
$env:CHATGPT_ACCESS_TOKEN = [System.Net.NetworkCredential]::new("", $secureToken).Password
Remove-Variable secureToken
```

获取指定会话：

```powershell
node bin/chatgpt-archive-maker.mjs fetch-current --archive "D:\path\to\archive-state" --session-id "conversation-id"
```

也可以把 ChatGPT 会话链接传给 `--input`：

```powershell
node bin/chatgpt-archive-maker.mjs fetch-current --archive "D:\path\to\archive-state" --input "https://chatgpt.com/c/conversation-id"
```

分页获取会话列表并逐个导入：

```powershell
node bin/chatgpt-archive-maker.mjs fetch-all --archive "D:\path\to\archive-state" --limit 200 --delay-ms 200
```

可用选项包括 `--token-file`、`--base-url`、`--account-id`、`--skip-resources`。如果图片资源下载失败，工具会保留会话文本并在构建审计中报告缺失资源。

## 输出内容

- `index.html`：总览与全局搜索。
- `sessions.html`：按会话阅读当前主路径。
- `timeline.html`：按现实时间阅读全部当前路径消息。
- `assets/images/`：复制并去重后的图片。
- `assets/files/`：附件占位说明和可恢复的文件资源。
- `data/archive-data.js`：离线网页使用的数据。
- `data/search-index.js`：本地搜索索引。
- `data/resource-map.json`：图片与附件映射。
- `markdown/`：可编辑 Markdown，包括会话版、时间线版、分支附录和隐藏上下文附录。
- `_build/reports/`：质量审计报告和可选的参考对比报告。

## 隐私检查

公开仓库前，请确认 Git 只包含生成器代码。仓库中的 `.gitignore` 已经排除了常见的导出包、生成目录、图片、索引、报告和本地任务记录，但仍建议执行：

```powershell
git status --short
git ls-files -o --exclude-standard
git status --ignored --short
git diff --cached --stat
```

不要提交这些内容：

- OpenAI 导出压缩包或解压目录。
- 生成后的归档目录。
- 状态库目录，也就是你传给 `--archive` 的目录。
- `.env`、令牌文件、含有 `CHATGPT_ACCESS_TOKEN` 的脚本或终端记录。
- `assets/images/`、`data/`、`markdown/` 或 `_build/` 等生成结果。
- 包含个人对话、图片、搜索索引、审计报告或本地路径的文件。

## 验证

检查源码语法：

```powershell
npm run check
```

查看命令行帮助和版本：

```powershell
npm run smoke
```

生成归档后，工具会自动写出质量审计报告。报告中的 `pass` 应为 `true`，`failureCount` 应为 `0`。

## 已知限制

- 单独的 `Files__...zip` 只能作为附件来源，不能生成完整归档；完整归档至少需要对话数据。
- 如果原始导出没有提供非图片附件的实体文件，工具会保留占位说明，不会伪造文件路径。
- 默认正文只恢复当前主路径中的图片；分支消息保留在分支附录中。
- 自动审计会检查结构、索引、资源链接和离线可用性，但不会逐条截图所有消息。
- ChatGPT Web 获取器使用非公开网页端接口；它是方便增量归档的辅助能力，不应替代官方导出包。
