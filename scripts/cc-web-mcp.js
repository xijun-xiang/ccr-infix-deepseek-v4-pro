#!/usr/bin/env node

const { spawn } = require("node:child_process");

const SERVER_NAME = "ccr-local-web-tools";
const SERVER_VERSION = "0.1.0";
const MAX_OUTPUT_CHARS = Number(process.env.CCR_WEB_MAX_OUTPUT_CHARS || 30000);
const MAX_RESEARCH_PAGE_CHARS = Number(process.env.CCR_WEB_MAX_RESEARCH_PAGE_CHARS || 4500);
const DEFAULT_SEARCH_RESULTS = Number(process.env.CCR_WEB_SEARCH_RESULTS || 8);
const DEFAULT_RESEARCH_PAGES = Number(process.env.CCR_WEB_RESEARCH_PAGES || 3);
const JINA_SEARCH_URL = "https://s.jina.ai/";
const JINA_READER_URL = "https://r.jina.ai/";

let inputBuffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  inputBuffer += chunk;
  drainInputBuffer();
});

process.stdin.on("end", () => {
  drainInputBuffer(true);
});

function drainInputBuffer(flush = false) {
  for (;;) {
    const newlineIndex = inputBuffer.indexOf("\n");
    if (newlineIndex < 0) break;
    const line = inputBuffer.slice(0, newlineIndex).trim();
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (line) handleRawMessage(line);
  }

  if (flush && inputBuffer.trim()) {
    handleRawMessage(inputBuffer.trim());
    inputBuffer = "";
  }
}

function handleRawMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  handleMessage(message).catch((error) => {
    if (message.id !== undefined) {
      sendError(message.id, -32603, error.message || String(error));
    }
  });
}

async function handleMessage(message) {
  const { id, method, params } = message;

  if (method?.startsWith("notifications/")) return;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, {
      tools: [
        {
          name: "web_search",
          description:
            "Search the web from the local machine. Returns titles, URLs, and snippets.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query.",
              },
              max_results: {
                type: "number",
                description: "Maximum number of results to return.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          name: "web_fetch",
          description:
            "Fetch a URL from the local machine and return readable text.",
          inputSchema: {
            type: "object",
            properties: {
              url: {
                type: "string",
                description: "URL to fetch.",
              },
            },
            required: ["url"],
            additionalProperties: false,
          },
        },
        {
          name: "web_research",
          description:
            "Search the web, fetch the top reliable pages, and return structured snippets with source URLs. Prefer this for current facts, news, and cross-checking.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Research query.",
              },
              max_results: {
                type: "number",
                description: "Maximum search results to return.",
              },
              fetch_pages: {
                type: "number",
                description: "Number of top result pages to fetch and include.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
        {
          name: "nba_scoreboard",
          description:
            "Get structured NBA scoreboard data for a calendar date. Useful for current scores and schedules.",
          inputSchema: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "Date in YYYY-MM-DD. Defaults to today in the requested timezone.",
              },
              timezone: {
                type: "string",
                description: "IANA timezone name, for example Asia/Shanghai or America/New_York.",
              },
            },
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};

    try {
      if (name === "web_search") {
        const query = requireString(args.query, "query");
        const maxResults = clampInteger(args.max_results, 1, 20, DEFAULT_SEARCH_RESULTS);
        const output = await webSearch(query, maxResults);
        sendToolResult(id, output);
        return;
      }

      if (name === "web_fetch") {
        const url = requireString(args.url, "url");
        const output = await webFetch(url);
        sendToolResult(id, output);
        return;
      }

      if (name === "web_research") {
        const query = requireString(args.query, "query");
        const maxResults = clampInteger(args.max_results, 1, 20, DEFAULT_SEARCH_RESULTS);
        const fetchPages = clampInteger(args.fetch_pages, 0, 8, DEFAULT_RESEARCH_PAGES);
        const output = await webResearch(query, maxResults, fetchPages);
        sendToolResult(id, output);
        return;
      }

      if (name === "nba_scoreboard") {
        const timezone =
          typeof args.timezone === "string" && args.timezone.trim()
            ? args.timezone.trim()
            : "Asia/Shanghai";
        const date =
          typeof args.date === "string" && args.date.trim()
            ? args.date.trim()
            : formatDateInTimeZone(new Date(), timezone);
        const output = await nbaScoreboard(date, timezone);
        sendToolResult(id, output);
        return;
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (error) {
      sendToolResult(id, error.message || String(error), true);
      return;
    }
  }

  sendError(id, -32601, `Method not found: ${method}`);
}

async function webSearch(query, maxResults) {
  const results = await searchWeb(query, maxResults);
  return formatResultArray(results);
}

async function webResearch(query, maxResults, fetchPages) {
  const results = await searchWeb(query, maxResults);
  const enriched = [];
  let fetched = 0;

  for (const result of results) {
    const item = { ...result };
    if (item.url && fetched < fetchPages) {
      try {
        const page = await webFetch(item.url);
        item.fetched = true;
        item.pageText = trimTo(page, MAX_RESEARCH_PAGE_CHARS);
        fetched += 1;
      } catch (error) {
        item.fetched = false;
        item.fetchError = trimTo(error.message || String(error), 1200);
      }
    }
    enriched.push(item);
  }

  return trimOutput(
    JSON.stringify(
      {
        query,
        fetchedPages: fetched,
        note:
          "Use the fetched pageText fields for verification; cite source URLs when answering.",
        results: enriched,
      },
      null,
      2
    )
  );
}

async function searchWeb(query, maxResults) {
  if (process.env.CCR_WEB_SEARCH_COMMAND) {
    const text = await runSearchCommand(process.env.CCR_WEB_SEARCH_COMMAND, query);
    return normalizeSearchResults(parseLooseSearchText(text), maxResults);
  }

  if (process.env.CCR_WEB_SEARCH_API_URL) {
    return runSearchApi(query, maxResults);
  }

  if (process.env.CCR_WEB_SEARCH_BACKEND !== "duckduckgo") {
    try {
      const results = await runJinaSearch(query, maxResults);
      if (results.length) return results;
    } catch (error) {
      if (process.env.CCR_WEB_SEARCH_BACKEND === "jina") {
        throw error;
      }
    }
  }

  return runDuckDuckGoSearch(query, maxResults);
}

function runSearchCommand(command, query) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [query], {
      shell: process.platform === "win32",
      windowsHide: true,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0 && !signal) {
        resolve(trimOutput(stdout));
      } else {
        reject(
          new Error(
            `Search command failed${code !== null ? ` with exit code ${code}` : ""}${
              signal ? ` by signal ${signal}` : ""
            }: ${stderr || stdout || "no output"}`
          )
        );
      }
    });
  });
}

async function runSearchApi(query, maxResults) {
  const headers = {
    "content-type": "application/json",
  };

  if (process.env.CCR_WEB_SEARCH_TOKEN) {
    headers.Token = process.env.CCR_WEB_SEARCH_TOKEN;
  }
  if (process.env.CCR_WEB_SEARCH_AUTH_BEARER) {
    headers.Authorization = `Bearer ${process.env.CCR_WEB_SEARCH_AUTH_BEARER}`;
  }

  const response = await fetch(process.env.CCR_WEB_SEARCH_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Search API failed with status ${response.status}: ${text}`);
  }

  try {
    const payload = JSON.parse(text);
    if (Array.isArray(payload.results)) {
      return normalizeSearchResults(payload.results, maxResults);
    }
    if (Array.isArray(payload.data)) {
      return normalizeSearchResults(payload.data, maxResults);
    }
    if (typeof payload.result === "string") {
      return normalizeSearchResults(parseLooseSearchText(payload.result), maxResults);
    }
    return normalizeSearchResults(parseLooseSearchText(JSON.stringify(payload, null, 2)), maxResults);
  } catch {
    return normalizeSearchResults(parseLooseSearchText(text), maxResults);
  }
}

async function runDuckDuckGoSearch(query, maxResults) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml",
    },
  });

  const html = await response.text();
  if (!response.ok) {
    throw new Error(`DuckDuckGo search failed with status ${response.status}`);
  }

  const results = [];
  const blockRegex = /<div class="result[\s\S]*?<\/div>\s*<\/div>/gi;
  const titleRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;
  let blockMatch;

  while ((blockMatch = blockRegex.exec(html)) && results.length < maxResults) {
    const block = blockMatch[0];
    const titleMatch = block.match(titleRegex);
    if (!titleMatch) continue;

    const snippetMatch = block.match(snippetRegex);
    const resultUrl = normalizeDuckDuckGoUrl(decodeHtml(titleMatch[1]));
    if (isLikelyAdUrl(resultUrl)) continue;

    results.push({
      title: cleanHtml(titleMatch[2]),
      url: resultUrl,
      snippet: snippetMatch ? cleanHtml(snippetMatch[1]) : "",
    });
  }

  if (!results.length) {
    throw new Error(
      "No search results found. Set CCR_WEB_SEARCH_API_URL or CCR_WEB_SEARCH_COMMAND for a stronger search backend."
    );
  }

  return results;
}

async function runJinaSearch(query, maxResults) {
  const response = await fetch(`${JINA_SEARCH_URL}${encodeURIComponent(query)}`, {
    headers: buildJinaHeaders(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Jina search failed with status ${response.status}: ${text}`);
  }
  const results = parseJinaSearch(text);
  if (results.length) return normalizeSearchResults(results, maxResults);
  return normalizeSearchResults(parseLooseSearchText(text), maxResults);
}

async function webFetch(rawUrl) {
  const url = normalizeUrl(rawUrl);
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      accept: "text/html,text/plain,application/json,*/*",
    },
  });

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (!response.ok) {
    if (
      process.env.CCR_WEB_FETCH_NO_JINA !== "1" &&
      (contentType.includes("text/html") || text.includes("<html"))
    ) {
      try {
        return await webFetchViaJina(url);
      } catch {
        // Fall through to the direct error when Reader is unavailable.
      }
    }
    throw new Error(`Fetch failed with status ${response.status}: ${trimOutput(text)}`);
  }

  const body = contentType.includes("text/html") ? htmlToText(text) : text;
  if (
    contentType.includes("text/html") &&
    body.trim().length < 300 &&
    process.env.CCR_WEB_FETCH_NO_JINA !== "1"
  ) {
    try {
      return await webFetchViaJina(url);
    } catch {
      // Keep the direct fetch result if Reader is unavailable.
    }
  }

  return trimOutput(
    [
      `URL: ${response.url || url}`,
      `Content-Type: ${contentType || "unknown"}`,
      "",
      body,
    ].join("\n")
  );
}

async function nbaScoreboard(targetDate, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
    throw new Error("date must use YYYY-MM-DD format.");
  }

  const candidateDates = [
    shiftDate(targetDate, -1),
    targetDate,
    shiftDate(targetDate, 1),
  ];
  const seenEvents = new Set();
  const events = [];

  for (const candidateDate of candidateDates) {
    const yyyymmdd = candidateDate.replace(/-/g, "");
    const response = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yyyymmdd}`,
      {
        headers: {
          "user-agent": `${SERVER_NAME}/${SERVER_VERSION}`,
          accept: "application/json",
        },
      }
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ESPN NBA scoreboard failed with status ${response.status}: ${text}`);
    }

    const payload = JSON.parse(text);
    for (const event of payload.events || []) {
      if (!event?.id || seenEvents.has(event.id)) continue;
      const eventDate = new Date(event.date);
      if (formatDateInTimeZone(eventDate, timezone) !== targetDate) continue;
      seenEvents.add(event.id);
      events.push(normalizeNbaEvent(event, timezone));
    }
  }

  events.sort((a, b) => a.localTime.localeCompare(b.localTime));

  const result = {
    source: "ESPN site API",
    date: targetDate,
    timezone,
    count: events.length,
    games: events,
  };

  if (!events.length) {
    return JSON.stringify(
      {
        ...result,
        note: "No NBA games found for this local calendar date.",
      },
      null,
      2
    );
  }

  return JSON.stringify(result, null, 2);
}

function normalizeNbaEvent(event, timezone) {
  const competition = event.competitions?.[0] || {};
  const competitors = competition.competitors || [];
  const home = competitors.find((team) => team.homeAway === "home") || competitors[0] || {};
  const away = competitors.find((team) => team.homeAway === "away") || competitors[1] || {};
  const status = competition.status || event.status || {};
  const localDate = new Date(event.date);

  return {
    id: event.id,
    name: event.name,
    shortName: event.shortName,
    localDate: formatDateInTimeZone(localDate, timezone),
    localTime: formatTimeInTimeZone(localDate, timezone),
    status: status.type?.description || status.type?.name || "",
    completed: Boolean(status.type?.completed),
    detail: status.type?.detail || status.type?.shortDetail || "",
    venue: competition.venue?.fullName || "",
    series: competition.series?.summary || "",
    note: competition.notes?.[0]?.headline || "",
    home: normalizeTeam(home),
    away: normalizeTeam(away),
    winner:
      home.winner === true
        ? home.team?.displayName || home.team?.name || ""
        : away.winner === true
        ? away.team?.displayName || away.team?.name || ""
        : "",
    score:
      home.score != null && away.score != null
        ? `${away.team?.abbreviation || away.team?.shortDisplayName || "AWAY"} ${away.score} - ${home.score} ${home.team?.abbreviation || home.team?.shortDisplayName || "HOME"}`
        : "",
    links: (event.links || [])
      .filter((link) => link?.href && ["summary", "boxscore", "recap"].some((rel) => link.rel?.includes(rel)))
      .map((link) => ({
        text: link.text || link.shortText || "",
        href: link.href,
      })),
  };
}

function normalizeTeam(competitor) {
  const team = competitor.team || {};
  return {
    name: team.displayName || team.name || "",
    abbreviation: team.abbreviation || "",
    homeAway: competitor.homeAway || "",
    score: competitor.score || "",
    winner: Boolean(competitor.winner),
    linescores: (competitor.linescores || []).map((line) => line.displayValue || String(line.value ?? "")),
    leaders: (competitor.leaders || []).map((leader) => ({
      name: leader.displayName || leader.name || "",
      athlete: leader.leaders?.[0]?.athlete?.displayName || "",
      value: leader.leaders?.[0]?.displayValue || "",
    })),
  };
}

function shiftDate(yyyyMmDd, offsetDays) {
  const date = new Date(`${yyyyMmDd}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function formatDateInTimeZone(date, timezone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTimeInTimeZone(date, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function webFetchViaJina(url) {
  const response = await fetch(`${JINA_READER_URL}${url}`, {
    headers: buildJinaHeaders(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Jina reader failed with status ${response.status}: ${text}`);
  }
  return trimOutput(text);
}

function buildJinaHeaders() {
  const headers = {
    "user-agent": `${SERVER_NAME}/${SERVER_VERSION}`,
  };
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }
  return headers;
}

function formatResultArray(results) {
  return trimOutput(
    results
      .map((item, index) => {
        const title = item.title || item.name || `Result ${index + 1}`;
        const url = item.url || item.link || item.href || "";
        const snippet = item.snippet || item.content || item.description || "";
        return [`${index + 1}. ${title}`, url, snippet].filter(Boolean).join("\n");
      })
      .join("\n\n")
  );
}

function normalizeSearchResults(results, maxResults) {
  const normalized = [];
  const seen = new Set();

  for (const item of results || []) {
    const title = String(item.title || item.name || item.heading || "").trim();
    const url = String(item.url || item.link || item.href || item.source || "").trim();
    const snippet = String(
      item.snippet || item.content || item.description || item.text || ""
    ).trim();
    const key = url || `${title}\n${snippet}`;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      title: title || `Result ${normalized.length + 1}`,
      url,
      snippet: trimTo(snippet, 1200),
    });
    if (normalized.length >= maxResults) break;
  }

  return normalized;
}

function parseJinaSearch(text) {
  const results = [];
  const pattern =
    /Title:\s*([\s\S]*?)\n(?:URL Source|URL):\s*(https?:\/\/\S+)\s*\n(?:Markdown Content|Content|Description):\s*([\s\S]*?)(?=\nTitle:|\s*$)/g;
  let match;
  while ((match = pattern.exec(text))) {
    results.push({
      title: cleanPlainText(match[1]),
      url: match[2].trim(),
      snippet: cleanPlainText(match[3]),
    });
  }
  return results;
}

function parseLooseSearchText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const results = [];
  for (let i = 0; i < lines.length; i++) {
    const urlMatch = lines[i].match(/https?:\/\/[^\s)>"']+/);
    if (!urlMatch) continue;
    const url = urlMatch[0];
    const title = cleanPlainText(lines[i - 1] || lines[i].replace(url, ""));
    const snippet = cleanPlainText([lines[i + 1], lines[i + 2]].filter(Boolean).join(" "));
    results.push({
      title: title || url,
      url,
      snippet,
    });
  }

  if (!results.length && text.trim()) {
    results.push({
      title: "Search output",
      url: "",
      snippet: cleanPlainText(text),
    });
  }

  return results;
}

function cleanPlainText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https URLs are supported.");
  }
  return url.toString();
}

function normalizeDuckDuckGoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, "https://duckduckgo.com");
    const nested = url.searchParams.get("uddg");
    return nested ? decodeURIComponent(nested) : url.toString();
  } catch {
    return rawUrl;
  }
}

function isLikelyAdUrl(rawUrl) {
  try {
    const url = new URL(rawUrl, "https://duckduckgo.com");
    return (
      url.hostname.includes("duckduckgo.com") &&
      (url.pathname.includes("/y.js") || url.searchParams.has("ad_domain"))
    );
  } catch {
    return false;
  }
}

function htmlToText(html) {
  return cleanHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
  );
}

function cleanHtml(value) {
  return decodeHtml(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function requireString(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing required string field: ${fieldName}`);
  }
  return value.trim();
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function appendLimited(existing, chunk) {
  if (existing.length >= MAX_OUTPUT_CHARS) return existing;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  return (existing + text).slice(0, MAX_OUTPUT_CHARS);
}

function trimOutput(text) {
  const trimmed = String(text || "").trim();
  if (trimmed.length <= MAX_OUTPUT_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n\n[truncated at ${MAX_OUTPUT_CHARS} chars]`;
}

function trimTo(text, maxChars) {
  const value = String(text || "").trim();
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated at ${maxChars} chars]`;
}

function sendToolResult(id, text, isError = false) {
  sendResult(id, {
    content: [
      {
        type: "text",
        text,
      },
    ],
    isError,
  });
}

function sendResult(id, result) {
  if (id === undefined) return;
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id, code, message) {
  if (id === undefined) return;
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
