import { UnifiedChatRequest } from "@/types/llm";
import { Transformer } from "../types/transformer";
import { TransformerOptions } from "@/types/transformer";

type ToolCall = {
  id?: string;
  index?: number;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export class InfixTransformer implements Transformer {
  static TransformerName = "infix";
  name = InfixTransformer.TransformerName;
  private reasoningByToolId = new Map<string, string>();
  private readonly maxCachedToolCalls = 1000;
  private readonly webToolsMode: "off" | "mcp" | "bash";
  private readonly replayPlaceholderReasoning: boolean;
  private readonly stripBillingHeader: boolean;

  constructor(options?: TransformerOptions) {
    const mode = options?.webToolsMode ?? options?.webTools ?? "off";
    this.webToolsMode =
      mode === "mcp" || mode === "bash" ? mode : "off";
    this.replayPlaceholderReasoning =
      options?.replayPlaceholderReasoning !== false;
    this.stripBillingHeader = options?.stripBillingHeader !== false;
  }

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    if (request.max_tokens && request.max_tokens > 8192) {
      request.max_tokens = 8192;
    }

    if (this.stripBillingHeader) {
      this.stripVolatileSystemPrefixes(request);
    }

    if (this.webToolsMode !== "off") {
      this.removeBrokenClaudeWebTools(request);
      this.injectLocalWebToolInstruction(request);
    }

    for (const message of request.messages || []) {
      if (message.role !== "assistant") continue;

      const hasToolCalls =
        Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
      const reasoning =
        message.thinking?.content ||
        this.getReasoningContent(message) ||
        message.tool_calls
          ?.map((toolCall) =>
            toolCall.id ? this.reasoningByToolId.get(toolCall.id) : undefined
          )
          .find((value): value is string => Boolean(value)) ||
        (hasToolCalls && this.replayPlaceholderReasoning ? "tool call" : undefined);

      if (reasoning) {
        (message as any).reasoning_content = reasoning;
        (message as any).provider_specific_fields = {
          ...((message as any).provider_specific_fields || {}),
          reasoning_content: reasoning,
        };
        delete (message as any).thinking;
        delete (message as any).reasoning;
      }
    }

    delete (request as any).reasoning;
    delete (request as any).thinking;
    delete (request as any).enable_thinking;

    return request;
  }

  private stripVolatileSystemPrefixes(request: UnifiedChatRequest) {
    const messages = request.messages || [];
    for (const message of messages) {
      if (message.role !== "system") continue;

      if (typeof message.content === "string") {
        message.content = this.stripLeadingAnthropicBillingHeader(message.content);
        continue;
      }

      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type === "text" && typeof part.text === "string") {
            part.text = this.stripLeadingAnthropicBillingHeader(part.text);
          }
        }
      }
    }
  }

  private stripLeadingAnthropicBillingHeader(text: string) {
    const prefix = "x-anthropic-billing-header:";
    if (!text.startsWith(prefix)) return text;

    const lineEnd = text.search(/\r?\n/);
    if (lineEnd < 0) return "";

    return text.slice(lineEnd).replace(/^\r?\n\r?\n?/, "");
  }

  private removeBrokenClaudeWebTools(request: UnifiedChatRequest) {
    if (!Array.isArray(request.tools)) return;

    request.tools = request.tools.filter((tool) => {
      const name = tool.function?.name || "";
      return !this.isClaudeWebToolName(name);
    });

    if (
      typeof request.tool_choice === "object" &&
      this.isClaudeWebToolName(request.tool_choice.function?.name || "")
    ) {
      request.tool_choice = "auto";
    }
  }

  private isClaudeWebToolName(name: string) {
    return ["websearch", "web_search", "webfetch", "web_fetch"].includes(
      name.toLowerCase()
    );
  }

  private injectLocalWebToolInstruction(request: UnifiedChatRequest) {
    const instruction =
      this.webToolsMode === "mcp"
        ? [
            "Network access note for this route:",
            "The built-in Claude Code WebSearch/WebFetch tools are unavailable with this DeepSeek route.",
            "For web search or page fetching, use the local MCP tools from server ccr-local-web.",
            "Their Claude Code tool names are usually mcp__ccr-local-web__web_search and mcp__ccr-local-web__web_fetch.",
            "For current facts that need source checking, prefer mcp__ccr-local-web__web_research because it searches and fetches top pages together.",
            "For NBA scores or schedules, prefer mcp__ccr-local-web__nba_scoreboard because it returns structured ESPN scoreboard data.",
            "If those MCP tools are not available, use Bash with PowerShell/curl as a fallback instead of calling WebSearch or WebFetch.",
          ].join("\n")
        : [
            "Network access note for this route:",
            "The built-in Claude Code WebSearch/WebFetch tools are unavailable with this DeepSeek route.",
            "For web search or page fetching, use Bash with PowerShell Invoke-RestMethod/curl instead of calling WebSearch or WebFetch.",
          ].join("\n");

    const existingSystem = request.messages?.find(
      (message) => message.role === "system"
    );

    if (existingSystem && typeof existingSystem.content === "string") {
      if (!existingSystem.content.includes("Network access note for this route:")) {
        existingSystem.content = `${existingSystem.content}\n\n${instruction}`;
      }
      return;
    }

    request.messages = [
      { role: "system", content: instruction },
      ...(request.messages || []),
    ];
  }

  async transformResponseOut(response: Response): Promise<Response> {
    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("application/json")) {
      const jsonResponse = await response.json();
      this.captureJsonReasoning(jsonResponse);
      this.exposeJsonThinking(jsonResponse);
      const headers = this.mutableHeaders(response.headers);
      return new Response(JSON.stringify(jsonResponse), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    if (contentType.includes("stream") && response.body) {
      const stream = this.captureStreamReasoning(response.body);
      const headers = this.mutableHeaders(response.headers);
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    return response;
  }

  private captureJsonReasoning(jsonResponse: any) {
    for (const choice of jsonResponse?.choices || []) {
      const message = choice?.message;
      const reasoning = this.getReasoningContent(message);

      if (!reasoning || !Array.isArray(message?.tool_calls)) continue;

      for (const toolCall of message.tool_calls as ToolCall[]) {
        if (toolCall.id) {
          this.cacheReasoning(toolCall.id, reasoning);
        }
      }
    }
  }

  private exposeJsonThinking(jsonResponse: any) {
    for (const choice of jsonResponse?.choices || []) {
      const message = choice?.message;
      const reasoning = this.getReasoningContent(message);

      if (message && reasoning && !message.thinking) {
        message.thinking = {
          content: reasoning,
          signature: `infix-${Date.now()}`,
        };
      }
    }
  }

  private captureStreamReasoning(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = "";
    let reasoning = "";
    let thinkingSignatureSent = false;
    const pendingToolCalls = new Map<number, ToolCall>();

    const processLine = (line: string) => {
      if (!line.startsWith("data:")) {
        return line + "\n";
      }

      const payload = line.slice(5).trimStart();
      if (payload === "[DONE]") {
        return line + "\n";
      }

      try {
        const data = JSON.parse(payload);
        const choice = data.choices?.[0];
        const delta = choice?.delta;
        const message = choice?.message;
        let changed = false;
        let prefix = "";

        const reasoningDelta = this.getReasoningContent(delta) || this.getReasoningContent(message);
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          const target = delta || message;
          if (target) {
            this.removeReasoningContent(target);
            changed = true;
          }
          prefix = `data: ${JSON.stringify(
            this.createThinkingContentChunk(data, reasoningDelta)
          )}\n`;
        }

        const toolCalls = delta?.tool_calls || message?.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const toolCall of toolCalls as ToolCall[]) {
            const index = toolCall.index ?? 0;
            const existing = pendingToolCalls.get(index) || {};
            const merged: ToolCall = {
              ...existing,
              ...toolCall,
              function: {
                ...(existing.function || {}),
                ...(toolCall.function || {}),
                arguments:
                  (existing.function?.arguments || "") +
                  (toolCall.function?.arguments || ""),
              },
            };
            pendingToolCalls.set(index, merged);
          }
        }

        const hasAssistantOutput = Boolean(
          delta?.content ||
            delta?.tool_calls?.length ||
            message?.content ||
            message?.tool_calls?.length ||
            choice?.finish_reason
        );

        if (
          reasoning &&
          hasAssistantOutput &&
          !thinkingSignatureSent
        ) {
          const targetDelta = choice.delta || (choice.delta = {});
          targetDelta.thinking = {
            ...(targetDelta.thinking || {}),
            signature: `infix-${Date.now()}`,
          };
          thinkingSignatureSent = true;
          changed = true;
        }

        if (choice?.finish_reason === "tool_calls" && reasoning) {
          for (const toolCall of pendingToolCalls.values()) {
            if (toolCall.id) {
              this.cacheReasoning(toolCall.id, reasoning);
            }
          }
        }

        if (changed) {
          if (hasAssistantOutput || choice?.finish_reason || !reasoningDelta) {
            return `${prefix}data: ${JSON.stringify(data)}\n`;
          }
          return prefix;
        }
      } catch {
        // Keep malformed or partial provider lines unchanged.
      }

      return line + "\n";
    };

    return new ReadableStream({
      start: async (controller) => {
        const reader = body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              controller.enqueue(encoder.encode(processLine(line)));
            }
          }

          if (buffer) {
            controller.enqueue(encoder.encode(processLine(buffer)));
          }
        } finally {
          reader.releaseLock();
          controller.close();
        }
      },
    });
  }

  private getReasoningContent(message: any): string | undefined {
    return (
      message?.reasoning_content ||
      message?.reasoning ||
      message?.provider_specific_fields?.reasoning_content
    );
  }

  private removeReasoningContent(message: any) {
    delete message.reasoning_content;
    delete message.reasoning;
    if (message.provider_specific_fields) {
      delete message.provider_specific_fields.reasoning_content;
    }
  }

  private createThinkingContentChunk(data: any, reasoning: string) {
    const choice = data.choices?.[0] || {};
    return {
      ...data,
      choices: [
        {
          ...choice,
          delta: {
            thinking: {
              content: reasoning,
            },
          },
          finish_reason: null,
        },
      ],
    };
  }

  private cacheReasoning(toolCallId: string, reasoning: string) {
    this.reasoningByToolId.set(toolCallId, reasoning);
    if (this.reasoningByToolId.size > this.maxCachedToolCalls) {
      const oldestKey = this.reasoningByToolId.keys().next().value;
      if (oldestKey) {
        this.reasoningByToolId.delete(oldestKey);
      }
    }
  }

  private mutableHeaders(headers: Headers) {
    const mutableHeaders = new Headers(headers);
    mutableHeaders.delete("content-length");
    return mutableHeaders;
  }
}
