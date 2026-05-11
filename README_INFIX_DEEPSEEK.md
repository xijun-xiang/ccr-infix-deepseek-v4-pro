# Claude Code Router for Infix + DeepSeek V4 Pro

This branch adds an `infix` transformer for Claude Code Router. It lets Claude Code use an OpenAI-compatible Infix endpoint with `deepseek-v4-pro` while preserving DeepSeek reasoning across tool calls.

## What This Solves

Some DeepSeek reasoning models return reasoning as `reasoning_content`. During Claude Code agent loops, that reasoning must be replayed on later tool-result turns. Without this, Infix/DeepSeek may return errors such as:

```text
The `reasoning_content` in the thinking mode must be passed back to the API.
```

The `infix` transformer:

- Converts upstream `reasoning_content` into Claude Code-compatible `thinking` chunks.
- Caches reasoning by tool call id.
- Replays cached reasoning as `reasoning_content` on the following assistant/tool-call message.
- Adds a small `reasoning_content` placeholder for assistant tool-call history if Claude Code drops the previous thinking block.
- Strips Claude Code's volatile leading `x-anthropic-billing-header` from system prompts to improve prompt-cache stability.
- Removes Anthropic-only thinking request fields before sending requests to the OpenAI-compatible endpoint.
- Caps `max_tokens` to DeepSeek's 8192 response-token limit.
- Optionally disables Claude Code's broken built-in `WebSearch`/`WebFetch` for this route and steers the model to local MCP web tools.

## Configuration

Create or update:

```text
~/.claude-code-router/config.json
```

Example:

```json
{
  "PORT": 3456,
  "LOG": true,
  "API_TIMEOUT_MS": 600000,
  "Providers": [
    {
      "name": "infix",
      "api_base_url": "https://proxy.infix-ai.xyz/v1/chat/completions",
      "api_key": "$ANTHROPIC_AUTH_TOKEN",
      "models": ["deepseek-v4-pro"],
      "transformer": {
        "use": [
          [
            "infix",
            {
              "webToolsMode": "mcp",
              "replayPlaceholderReasoning": true,
              "stripBillingHeader": true
            }
          ]
        ]
      }
    }
  ],
  "Router": {
    "default": "infix,deepseek-v4-pro",
    "background": "infix,deepseek-v4-pro",
    "think": "infix,deepseek-v4-pro",
    "longContext": "infix,deepseek-v4-pro",
    "longContextThreshold": 60000
  }
}
```

Set your key outside the repository:

```powershell
setx ANTHROPIC_AUTH_TOKEN "your-infix-api-key"
```

Restart your terminal after `setx`.

## Local Web Tools

DeepSeek's public API supports function calling, but not Anthropic server-side
web-search result blocks. For Claude Code, the reliable workaround is to use a
local MCP server that performs web access from your machine.

This branch includes a lightweight MCP server:

```text
scripts/cc-web-mcp.js
```

Add it to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "ccr-local-web": {
      "type": "stdio",
      "command": "node",
      "args": [
        "D:\\path\\to\\claude-code-router\\scripts\\cc-web-mcp.js"
      ]
    }
  }
}
```

The server exposes:

- `web_search`: local web search. By default it tries Jina Search, then falls back to DuckDuckGo HTML results.
- `web_fetch`: local URL fetching and simple HTML-to-text cleanup. If a dynamic page returns almost no text, it tries Jina Reader.
- `web_research`: local search plus top-page fetching in one structured result. Prefer it for current facts, news, and source cross-checking.
- `nba_scoreboard`: structured NBA scores/schedules from ESPN's public site API, filtered by local date and timezone.

For a stronger search backend, set one of these environment options before
starting Claude Code:

```powershell
setx CCR_WEB_SEARCH_API_URL "https://your-search-api.example/search"
setx CCR_WEB_SEARCH_TOKEN "optional-token"
```

or:

```powershell
setx CCR_WEB_SEARCH_COMMAND "D:\path\to\your-search-script.cmd"
```

Optional Jina settings:

```powershell
setx JINA_API_KEY "optional-jina-key"
setx CCR_WEB_SEARCH_BACKEND "duckduckgo"
setx CCR_WEB_FETCH_NO_JINA "1"
```

When `webToolsMode` is set to `"mcp"`, the `infix` transformer removes the
broken Claude Code built-in `WebSearch`/`WebFetch` tools from DeepSeek requests
and adds a short instruction telling the model to use the local MCP web tools.
For NBA or similar structured sports data, use `nba_scoreboard`; for general
fresh information, use `web_research` first and only then fetch additional URLs
with `web_fetch`.

## Notes from cc-switch

This branch borrows two useful compatibility ideas from cc-switch's proxy layer:

- Keep `reasoning_content` only on providers/models that need it, and replay it
  across tool-call turns so DeepSeek/Kimi-style reasoning models do not reject
  follow-up tool results.
- Remove volatile Claude Code billing metadata from the prompt prefix so repeated
  requests have a better chance of hitting provider-side prompt caches.

cc-switch is still stronger as a GUI provider manager and hot-switching proxy.
This branch stays focused on the narrower Infix + DeepSeek V4 Pro + Claude Code
route.

## Start Claude Code

From the project directory you want Claude Code to work in:

```powershell
cd "D:\your-project"
node "D:\path\to\claude-code-router\dist\cli.js" code
```

Useful commands:

```powershell
node "D:\path\to\claude-code-router\dist\cli.js" status
node "D:\path\to\claude-code-router\dist\cli.js" stop
```

## Security Notes

Do not commit real API keys. Keep keys in environment variables or a local ignored `.env` file.

This repository intentionally uses:

```json
"api_key": "$ANTHROPIC_AUTH_TOKEN"
```

instead of a literal key.

Before publishing, scan for accidental secrets:

```powershell
Select-String -Path .\**\* -Pattern "sk-[A-Za-z0-9_-]{8,}" -ErrorAction SilentlyContinue
```

Expected safe matches should only be placeholders or package names, not real credentials.

## Caveats

- This is a compatibility layer for Claude Code agent workflows, not an Anthropic server-side WebSearch clone.
- The local MCP search fallback is intentionally simple. Configure `CCR_WEB_SEARCH_API_URL` or `CCR_WEB_SEARCH_COMMAND` for production-grade search.
- Search queries and fetched URLs are sent to whichever backend is active, such as Jina, DuckDuckGo, or your configured API/script.
