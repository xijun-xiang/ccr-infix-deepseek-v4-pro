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
- Removes Anthropic-only thinking request fields before sending requests to the OpenAI-compatible endpoint.
- Caps `max_tokens` to DeepSeek's 8192 response-token limit.

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
        "use": ["infix"]
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

- This is a compatibility layer for Claude Code agent workflows, not an Anthropic WebSearch replacement.
- Claude Code built-in `WebSearch`/`WebFetch` may still be limited with third-party model backends.
- For reliable web access, use Bash/PowerShell calls to public APIs or configure a search MCP.
