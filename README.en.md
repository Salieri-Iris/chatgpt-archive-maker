# ChatGPT Archive Maker

Convert an OpenAI ChatGPT web data export into an offline, searchable, editable personal archive.

Chinese documentation: [README.md](README.md)

## What It Is For

ChatGPT Archive Maker is for people who want to preserve their own ChatGPT export in a durable local format. It reads conversations, images, and attachment references from a local export package, then writes an offline archive that can be opened directly in a browser. The generated archive includes a session-based reading view, a real-time chronological timeline, and editable Markdown files.

This repository should contain only the generator code. It does not need, and should never include, any user export package, private conversation content, images, or generated archive output.

## Features

- Supports a complete OpenAI export zip or an already extracted export directory.
- Discovers conversation data, nested conversation packages, and attachment packages automatically.
- Copies image resources into the archive and places them back where they occurred in the conversation.
- Produces two browser views: a chronological timeline and a session-based reader.
- Produces editable Markdown files for sessions, timelines, branches, and hidden context appendices.
- Writes a local search index, resource map, quality audit report, and optional reference-archive comparison report.
- Generates an offline archive that does not depend on external network resources.
- Provides a persistent archive-state mode: import a full export once, add a single session later, list sessions, soft-delete sessions, undo the latest supported operation, and rebuild the final archive from state.
- Provides an optional first-pass ChatGPT Web fetcher: with a user-supplied access token, fetch one session or page through the conversation list and import the results into the state store.

## Requirements

- Node.js 20 or newer.
- Windows users can run `build-archive.cmd`.
- macOS, Linux, and other environments can use the Node.js command-line entry point directly.

## Quick Start

If `OpenAI-export` or `OpenAI-export.zip` is next to the project directory, Windows users can run:

```powershell
.\build-archive.cmd
```

The default output directory is `ChatGPT-archive-generated` next to the project directory.

## Custom Input And Output

Use an extracted export directory:

```powershell
node bin/chatgpt-archive-maker.mjs --input "D:\path\to\OpenAI-export" --output "D:\path\to\ChatGPT-archive-generated" --force
```

Use a complete export zip:

```powershell
node bin/chatgpt-archive-maker.mjs --input "D:\path\to\OpenAI-export.zip" --output "D:\path\to\ChatGPT-archive-generated" --force
```

To render times in a fixed time zone, pass `--timezone`:

```powershell
node bin/chatgpt-archive-maker.mjs --input "D:\path\to\OpenAI-export.zip" --output "D:\path\to\ChatGPT-archive-generated" --timezone Asia/Shanghai --force
```

If you already have a previous archive, you can compare the new output against it:

```powershell
node bin/chatgpt-archive-maker.mjs --input "D:\path\to\OpenAI-export.zip" --output "D:\path\to\ChatGPT-archive-generated" --force --compare-reference "D:\path\to\previous-archive"
```

## Persistent Archive Mode

Use the state-store commands if you want to maintain a long-lived local archive instead of regenerating everything from scratch. The state directory contains conversation JSON and copied resources, so keep it local and do not commit it to Git.

Initialize a state store:

```powershell
node bin/chatgpt-archive-maker.mjs init --archive "D:\path\to\archive-state"
```

Import a full OpenAI export:

```powershell
node bin/chatgpt-archive-maker.mjs import-export --archive "D:\path\to\archive-state" --input "D:\path\to\OpenAI-export.zip"
```

Import one specific session. The input can be a full export package, an extracted export directory, `conversations.json`, or a single conversation JSON file:

```powershell
node bin/chatgpt-archive-maker.mjs import-session --archive "D:\path\to\archive-state" --input "D:\path\to\OpenAI-export" --session-id "conversation-id"
```

Build the final archive from state:

```powershell
node bin/chatgpt-archive-maker.mjs build --archive "D:\path\to\archive-state" --output "D:\path\to\ChatGPT-archive-generated" --timezone Asia/Shanghai --force
```

List, remove, and undo:

```powershell
node bin/chatgpt-archive-maker.mjs list-sessions --archive "D:\path\to\archive-state"
node bin/chatgpt-archive-maker.mjs remove-session --archive "D:\path\to\archive-state" --session-id "conversation-id"
node bin/chatgpt-archive-maker.mjs undo --archive "D:\path\to\archive-state"
```

Removal is soft deletion: the stored version remains in the state directory, but the next `build` excludes it. `undo` currently supports the latest `remove-session` operation, and also supports new-format `import-session` or `fetch-current` operations.

## Optional Live Fetching

`fetch-current` and `fetch-all` are experimental optional commands that pull data from ChatGPT Web endpoints and import it into the state store. They rely on non-public ChatGPT Web behavior and may break if the web app changes. The most stable and recommended source of truth is still the official OpenAI export package.

These commands need an access token. Prefer an environment variable or a local token file. Do not commit tokens to Git, and avoid putting them in reusable scripts or shell history. In PowerShell, you can set a temporary environment variable from an interactive prompt instead of typing the token directly into the command line:

```powershell
$secureToken = Read-Host "ChatGPT access token" -AsSecureString
$env:CHATGPT_ACCESS_TOKEN = [System.Net.NetworkCredential]::new("", $secureToken).Password
Remove-Variable secureToken
```

Fetch one session:

```powershell
node bin/chatgpt-archive-maker.mjs fetch-current --archive "D:\path\to\archive-state" --session-id "conversation-id"
```

You can also pass a ChatGPT conversation URL to `--input`:

```powershell
node bin/chatgpt-archive-maker.mjs fetch-current --archive "D:\path\to\archive-state" --input "https://chatgpt.com/c/conversation-id"
```

Fetch a paged conversation list and import each session:

```powershell
node bin/chatgpt-archive-maker.mjs fetch-all --archive "D:\path\to\archive-state" --limit 200 --delay-ms 200
```

Useful options include `--token-file`, `--base-url`, `--account-id`, and `--skip-resources`. If an image resource cannot be downloaded, the conversation text is still kept and the build audit reports the missing resource.

## Output

- `index.html`: overview and global search.
- `sessions.html`: session-based reader for the current conversation path.
- `timeline.html`: real-time chronological timeline for current-path messages.
- `assets/images/`: copied and deduplicated image resources.
- `assets/files/`: attachment notes and recoverable file resources.
- `data/archive-data.js`: data used by the offline browser app.
- `data/search-index.js`: local search index.
- `data/resource-map.json`: image and attachment mapping.
- `markdown/`: editable Markdown files for sessions, timelines, branches, and hidden context appendices.
- `_build/reports/`: quality audit report and optional reference comparison report.

## Privacy Checklist

Before publishing or pushing the repository, make sure Git contains only the generator code. The included `.gitignore` excludes common export packages, generated archives, images, indexes, reports, and local task notes, but it is still worth checking:

```powershell
git status --short
git ls-files -o --exclude-standard
git status --ignored --short
git diff --cached --stat
```

Do not commit:

- OpenAI export zip files or extracted export directories.
- Generated archive directories.
- State-store directories, meaning the directory passed to `--archive`.
- `.env` files, token files, scripts containing `CHATGPT_ACCESS_TOKEN`, or terminal logs containing tokens.
- Generated `assets/images/`, `data/`, `markdown/`, or `_build/` directories.
- Any file containing private conversations, images, search indexes, audit reports, or local machine paths.

## Verification

Check source syntax:

```powershell
npm run check
```

Show command-line help and version:

```powershell
npm run smoke
```

After generating an archive, the tool writes a quality audit report. In a healthy output, `pass` should be `true` and `failureCount` should be `0`.

## Known Limits

- A standalone `Files__...zip` can only be used as an attachment source; a complete archive requires conversation data.
- If the original export does not include the physical file for a non-image attachment, the tool keeps a placeholder note instead of inventing a file path.
- The main reading views restore images only for the current conversation path; branch messages are kept in branch appendices.
- The automatic audit checks structure, indexes, resource links, and offline availability, but it does not screenshot every message.
- The ChatGPT Web fetcher uses non-public web endpoints. Treat it as a convenience for incremental archiving, not as a replacement for official exports.
