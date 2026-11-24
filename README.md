# search-chats

Search every coding agent chat on your machine from one terminal picker, then resume it where it left off.

```sh
search-chats                 # browse everything, newest first
search-chats retry backoff   # start with a query
search-chats --agent devin   # one agent only
```

Works with Codex, Claude Code, Cursor CLI, and Devin, including Devin cloud sessions when you are signed in with `devin auth login`. Enter resumes the chat in its original project folder.

## Install

Requires Node.js 22.13 or newer.

```sh
npm install -g search-chats
```

Claude Code deletes transcripts 30 days after their last use, and deleted chats can't be searched. To keep them, add `"cleanupPeriodDays": 3650` to `~/.claude/settings.json`.

## Transcript search

By default, search covers chat titles, opening prompts, and project names. To also search inside transcripts, by keyword and by meaning, index them into [turbopuffer](https://turbopuffer.com):

```sh
export TURBOPUFFER_API_KEY=...
export TURBOPUFFER_REGION=gcp-us-central1   # optional
search-chats --index
```

After the first run, the picker updates the index each time it opens. Use `--local` or Ctrl-L to search without it.

## Keys

| Key | Action |
| --- | --- |
| Enter | Resume |
| Tab | Filter by agent |
| Ctrl-T | Read the full transcript |
| Ctrl-Y | Copy the resume command |
| F1 | Show all keys |

## Development

```sh
git clone https://github.com/owenhalpert/search-chats
cd search-chats
npm ci && npm run build
npm link                  # puts this checkout on your PATH
npm test && npm run test:terminal
```
