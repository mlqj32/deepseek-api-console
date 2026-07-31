const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const envFile = path.join(root, ".env");
const publicDir = path.join(root, "public");
const dataDir = path.join(root, "data");
const sessionsFile = path.join(dataDir, "sessions.json");

function loadEnv() {
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    process.env[key] = value;
  }
}

function currentApiKey() {
  loadEnv();
  return process.env.DEEPSEEK_API_KEY || "";
}

function hasConfiguredApiKey(apiKey = currentApiKey()) {
  return Boolean(apiKey && !apiKey.includes("your_deepseek_api_key_here"));
}

function saveEnvValue(key, value) {
  const linePattern = new RegExp(`^\\s*${key}\\s*=`);
  const lines = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").split(/\r?\n/) : [];
  let replaced = false;
  const nextLines = lines.map(line => {
    if (linePattern.test(line)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") nextLines.push("");
    nextLines.push(`${key}=${value}`);
  }
  fs.writeFileSync(envFile, nextLines.join("\n").replace(/\n*$/, "\n"), "utf8");
  process.env[key] = value;
}

function ensureData() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(sessionsFile)) fs.writeFileSync(sessionsFile, "[]", "utf8");
}

function readSessions() {
  ensureData();
  try {
    const value = JSON.parse(fs.readFileSync(sessionsFile, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function writeSessions(sessions) {
  ensureData();
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), "utf8");
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseJsonBody(req) {
  return readBody(req).then(body => {
    if (!body.trim()) return {};
    return JSON.parse(body);
  });
}

function deepseekHeaders(extra = {}) {
  loadEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY || "";
  if (!apiKey || apiKey.includes("your_deepseek_api_key_here")) {
    throw new Error("DeepSeek 接口密钥未配置。请在 .env 中替换 DEEPSEEK_API_KEY。");
  }
  return {
    "authorization": `Bearer ${apiKey}`,
    "content-type": "application/json",
    ...extra
  };
}

function formatDeepSeekError(status, payload) {
  const rawMessage = typeof payload === "string"
    ? payload
    : payload?.error?.message || payload?.message || JSON.stringify(payload);
  if (status === 401 || status === 403) return "接口密钥无效、已过期，或当前账号没有调用权限。请检查 .env 里的密钥是否正确。";
  if (status === 402) return "余额不足或账号额度不可用。请先充值，或到 DeepSeek 平台检查账号额度。";
  if (status === 429) return "请求过于频繁，已经触发限速。请稍等一会儿再试。";
  if (status >= 500) return "DeepSeek 服务端暂时异常。请稍后重试。";
  return rawMessage || `请求失败，状态码 ${status}`;
}

async function validateApiKey(apiKey) {
  const target = `${baseUrl("core")}/user/balance`;
  const response = await fetch(target, {
    method: "GET",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json"
    }
  });
  const responseText = await response.text();
  let parsed = responseText;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // Keep raw text for non-JSON responses.
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, error: "密钥不正确，请检查后重新输入。", detail: parsed };
  }
  if (response.status === 402) {
    return { ok: true, status: response.status, balance: parsed };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, error: formatDeepSeekError(response.status, parsed), detail: parsed };
  }
  return { ok: true, status: response.status, balance: parsed };
}

function baseUrl(kind = "core") {
  if (kind === "beta") return process.env.DEEPSEEK_BETA_BASE_URL || "https://api.deepseek.com/beta";
  if (kind === "anthropic") return process.env.DEEPSEEK_ANTHROPIC_BASE_URL || "https://api.deepseek.com/anthropic";
  return process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
}

function cleanPath(apiPath) {
  if (!apiPath || typeof apiPath !== "string") return "/";
  if (/^https?:\/\//i.test(apiPath)) throw new Error("只允许填写路径，例如 /chat/completions，不能填写完整 URL。");
  return apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
}

function createSession(title = "新对话") {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
    params: {
      temperature: 0.6,
      max_tokens: 4096,
      top_p: 1,
      stop: [],
      user: "",
      thinking: "disabled",
      reasoning_effort: "high",
      search: "disabled",
      output_mode: "normal",
      file_mode: "attachment"
    },
    system: "你是 DeepSeek，本地接口控制台中的可靠中文助手。",
    messages: []
  };
}

function cleanSessionTitle(text) {
  return String(text || "")
    .replace(/\r?\n/g, " ")
    .replace(/\[附件：.*?\]/g, "")
    .replace(/[#*_`>[\](){}|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function makeSessionTitle({ displayMessage, userContent, attachments }) {
  const visible = cleanSessionTitle(displayMessage);
  if (visible && visible !== "请阅读附件内容。") return visible.slice(0, 24);

  const firstFile = Array.isArray(attachments) ? attachments[0] : null;
  if (firstFile?.name) return `阅读附件：${cleanSessionTitle(firstFile.name)}`.slice(0, 24);

  const fallback = cleanSessionTitle(userContent).replace(/附件：.*$/, "").trim();
  return (fallback || "新对话").slice(0, 24);
}

function sessionSummary(session) {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model,
    messageCount: session.messages.length
  };
}

function saveSessionPatch(session) {
  const sessions = readSessions();
  const index = sessions.findIndex(item => item.id === session.id);
  session.updatedAt = new Date().toISOString();
  if (index >= 0) sessions[index] = session;
  else sessions.unshift(session);
  writeSessions(sessions);
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === "/") filePath = "/index.html";
  const resolved = path.normalize(path.join(publicDir, filePath));
  if (!resolved.startsWith(publicDir)) return text(res, 403, "Forbidden");
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return text(res, 404, "Not found");
  const ext = path.extname(resolved).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf"
  };
  text(res, 200, fs.readFileSync(resolved), types[ext] || "application/octet-stream");
}

async function proxyJson({ kind, method, apiPath, body, extraHeaders }) {
  const target = `${baseUrl(kind)}${cleanPath(apiPath)}`;
  const init = {
    method,
    headers: deepseekHeaders(extraHeaders)
  };
  if (!["GET", "HEAD"].includes(method)) init.body = JSON.stringify(body || {});
  const response = await fetch(target, init);
  const responseText = await response.text();
  let parsed = responseText;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // Keep raw text for non-JSON responses.
  }
  if (!response.ok) {
    return { status: response.status, body: { error: formatDeepSeekError(response.status, parsed), detail: parsed } };
  }
  return { status: response.status, body: parsed };
}

function writeSse(res, event, payload) {
  if (res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload || {})}\n\n`);
}

function outputModeInstruction(mode) {
  if (mode === "json") {
    return "本轮必须只输出一个非空的合法 JSON 对象，不要输出 Markdown 代码块，不要添加 JSON 之外的解释。若用户没有指定字段，请使用固定字段：title、summary、files、key_points、risks、conclusion；不确定的字段用空字符串或空数组，禁止只输出空白。";
  }
  if (mode === "table") {
    return "本轮优先用清晰的 Markdown 表格整理关键信息；表格之后只保留必要补充。";
  }
  if (mode === "steps") {
    return "本轮必须按步骤解析，先给结论，再给编号步骤，最后列出关键依据或易错点。";
  }
  return "";
}

function systemWithOutputMode(system, mode, searchEnabled = false) {
  const parts = [String(system || "").trim()].filter(Boolean);
  const modeInstruction = outputModeInstruction(mode);
  if (modeInstruction) parts.push(modeInstruction);
  if (searchEnabled) {
    parts.push("本轮已开启联网搜索。需要当前信息、事实核查、官网文档或价格时主动使用搜索；回答中尽量引用可靠来源，并在信息不确定时说明。");
  }
  return parts.join("\n\n");
}

function blankAssistantMessage(mode) {
  if (mode === "json") {
    return "{\"error\":\"模型返回了空白内容\",\"hint\":\"JSON 输出需要明确字段结构；请指定需要的 JSON 字段后重试，或切回普通回答。\"}";
  }
  return "调用完成，但模型返回了空白内容。";
}

function shouldSendMessageToModel(message) {
  if (message.role !== "assistant") return true;
  const content = String(message.content || "").trim();
  return !(
    message.error === true ||
    /^调用失败[:：]/.test(content) ||
    /^请求异常[:：]/.test(content) ||
    /^请求失败[:：]/.test(content)
  );
}

function toAnthropicContent(message) {
  if (Array.isArray(message.anthropicContent) && message.anthropicContent.length) {
    return message.anthropicContent;
  }
  return [{ type: "text", text: String(message.content || "") }];
}

function buildAnthropicMessages(session) {
  const messages = [];
  for (const message of session.messages || []) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!shouldSendMessageToModel(message)) continue;
    const content = toAnthropicContent(message).filter(block => block && block.type);
    if (!content.length) continue;
    messages.push({ role: message.role, content });
  }
  return messages;
}

function extractTextFromBlock(block) {
  if (!block) return "";
  if (block.type === "text") return block.text || "";
  return "";
}

function normalizeCitation(citation) {
  if (!citation || typeof citation !== "object") return null;
  const url = citation.url || citation.uri || "";
  const title = citation.title || citation.cited_text || citation.document_title || url || "来源";
  if (!url && !title) return null;
  return {
    title,
    url,
    citedText: citation.cited_text || citation.text || "",
    startIndex: citation.start_index,
    endIndex: citation.end_index
  };
}

function searchResultsFromBlock(block) {
  const items = Array.isArray(block?.content) ? block.content : [];
  return items
    .map(item => {
      if (!item || typeof item !== "object") return null;
      return {
        title: item.title || item.url || "搜索结果",
        url: item.url || "",
        encrypted_content: item.encrypted_content
      };
    })
    .filter(Boolean);
}

function pricingForModel(model) {
  if (model === "deepseek-v4-flash") {
    return { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28, currency: "USD" };
  }
  return { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87, currency: "USD" };
}

function usageField(usage, keys) {
  for (const key of keys) {
    const value = Number(String(key).split(".").reduce((value, part) => value?.[part], usage));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function estimateUsageCost(usage, model) {
  if (!usage) return null;
  const pricing = pricingForModel(model);
  const input = usageField(usage, ["input_tokens", "prompt_tokens"]);
  const hit = usageField(usage, ["prompt_cache_hit_tokens", "cache_read_input_tokens"]);
  const miss = usageField(usage, ["prompt_cache_miss_tokens", "cache_creation_input_tokens"]) || Math.max(0, input - hit);
  const output = usageField(usage, ["output_tokens", "completion_tokens"]);
  const usd = (hit * pricing.cacheHit + miss * pricing.cacheMiss + output * pricing.output) / 1000000;
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return { usd, cny: usd * 7.2, estimated: true };
}

async function handleChatStream(req, res) {
  const payload = await parseJsonBody(req);
  const sessions = readSessions();
  let session = sessions.find(item => item.id === payload.sessionId);
  if (!session) session = createSession(payload.title || "新对话");

  const userContent = String(payload.message || "").trim();
  if (!userContent) return json(res, 400, { error: "消息不能为空。" });

  const params = {
    ...session.params,
    ...(payload.params || {})
  };
  session.model = payload.model || session.model || process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
  session.system = payload.system ?? session.system ?? "";
  session.params = params;
  session.messages.push({
    role: "user",
    content: userContent,
    displayContent: payload.displayMessage || userContent,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    createdAt: new Date().toISOString()
  });
  const isFirstUserMessage = session.messages.filter(message => message.role === "user").length === 1;
  if (isFirstUserMessage || !session.title || session.title === "新对话") {
    session.title = makeSessionTitle({
      displayMessage: payload.displayMessage,
      userContent,
      attachments: payload.attachments
    });
  }
  saveSessionPatch(session);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });

  const messages = [];
  const systemContent = systemWithOutputMode(session.system, params.output_mode, false);
  if (systemContent) messages.push({ role: "system", content: systemContent });
  for (const message of session.messages) {
    if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
      if (!shouldSendMessageToModel(message)) continue;
      messages.push({ role: message.role, content: message.content });
    }
  }

  const shouldUseThinking = params.thinking === "enabled";
  const body = {
    model: session.model,
    messages,
    stream: true,
    temperature: Number(params.temperature),
    max_tokens: Number(params.max_tokens),
    top_p: Number(params.top_p ?? 1),
    thinking: { type: shouldUseThinking ? "enabled" : "disabled" },
    stream_options: { include_usage: true }
  };

  if (shouldUseThinking && params.reasoning_effort) body.reasoning_effort = params.reasoning_effort;
  if (Array.isArray(params.stop) && params.stop.length) body.stop = params.stop;
  if (params.user) body.user = String(params.user);
  if (params.output_mode === "json") body.response_format = { type: "json_object" };

  let assistantContent = "";
  let reasoningContent = "";
  let errorContent = "";
  let usage = null;
  let clientClosed = false;
  const upstreamController = new AbortController();

  res.on("close", () => {
    if (res.writableEnded) return;
    clientClosed = true;
    upstreamController.abort();
  });

  try {
    const upstream = await fetch(`${baseUrl("core")}/chat/completions`, {
      method: "POST",
      headers: deepseekHeaders(),
      body: JSON.stringify(body),
      signal: upstreamController.signal
    });

    if (!upstream.ok || !upstream.body) {
      const errorText = await upstream.text();
      let parsedError = errorText;
      try {
        parsedError = JSON.parse(errorText);
      } catch {
        // Keep raw error text.
      }
      errorContent = formatDeepSeekError(upstream.status, parsedError);
      res.write(`event: error\ndata: ${JSON.stringify({ status: upstream.status, error: errorContent, detail: parsedError })}\n\n`);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of upstream.body) {
      if (clientClosed) break;
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.split(/\r?\n/).find(item => item.startsWith("data:"));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          if (!clientClosed) res.write("event: done\ndata: {}\n\n");
          continue;
        }
        let event;
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }
        if (event.usage) usage = event.usage;
        const delta = event.choices?.[0]?.delta || {};
        if (shouldUseThinking && delta.reasoning_content) {
          reasoningContent += delta.reasoning_content;
          if (!clientClosed) res.write(`event: reasoning\ndata: ${JSON.stringify({ text: delta.reasoning_content })}\n\n`);
        }
        if (delta.content) {
          assistantContent += delta.content;
          if (!clientClosed) res.write(`event: content\ndata: ${JSON.stringify({ text: delta.content })}\n\n`);
        }
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      errorContent = error.message;
      if (!clientClosed) res.write(`event: error\ndata: ${JSON.stringify({ error: errorContent })}\n\n`);
    }
  } finally {
    if (assistantContent || reasoningContent || errorContent) {
      const latest = readSessions().find(item => item.id === session.id) || session;
      const cost = estimateUsageCost(usage, session.model);
      const finalContent = assistantContent.trim()
        ? assistantContent
        : (errorContent ? `调用失败：${errorContent}` : blankAssistantMessage(params.output_mode));
      latest.messages.push({
        role: "assistant",
        content: finalContent,
        reasoning: shouldUseThinking ? reasoningContent : "",
        thinkingUsed: shouldUseThinking,
        interrupted: clientClosed,
        usage,
        cost,
        model: session.model,
        error: Boolean(errorContent),
        createdAt: new Date().toISOString()
      });
      saveSessionPatch(latest);
      if (!clientClosed) writeSse(res, "saved", { sessionId: latest.id, usage, cost });
    }
    if (!res.destroyed) res.end();
  }
}

async function handleSearchChatStream(req, res) {
  const payload = await parseJsonBody(req);
  const sessions = readSessions();
  let session = sessions.find(item => item.id === payload.sessionId);
  if (!session) session = createSession(payload.title || "新对话");

  const userContent = String(payload.message || "").trim();
  if (!userContent) return json(res, 400, { error: "消息不能为空。" });

  const params = {
    ...session.params,
    ...(payload.params || {}),
    search: "enabled"
  };
  session.model = payload.model || session.model || process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
  session.system = payload.system ?? session.system ?? "";
  session.params = params;
  session.messages.push({
    role: "user",
    content: userContent,
    displayContent: payload.displayMessage || userContent,
    attachments: Array.isArray(payload.attachments) ? payload.attachments : [],
    anthropicContent: [{ type: "text", text: userContent }],
    searchUsed: true,
    createdAt: new Date().toISOString()
  });
  const isFirstUserMessage = session.messages.filter(message => message.role === "user").length === 1;
  if (isFirstUserMessage || !session.title || session.title === "新对话") {
    session.title = makeSessionTitle({
      displayMessage: payload.displayMessage,
      userContent,
      attachments: payload.attachments
    });
  }
  saveSessionPatch(session);

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });

  const shouldUseThinking = params.thinking === "enabled";
  const body = {
    model: session.model,
    max_tokens: Number(params.max_tokens) || 4096,
    stream: true,
    system: systemWithOutputMode(session.system, params.output_mode, true),
    messages: buildAnthropicMessages(session),
    tools: [
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: Number(params.search_max_uses) || 5
      }
    ],
    temperature: Number(params.temperature),
    top_p: Number(params.top_p ?? 1)
  };

  if (shouldUseThinking) {
    body.thinking = { type: "enabled" };
    if (params.reasoning_effort) body.reasoning_effort = params.reasoning_effort;
  }
  if (Array.isArray(params.stop) && params.stop.length) body.stop_sequences = params.stop;
  if (params.user) body.metadata = { user_id: String(params.user) };

  let assistantContent = "";
  let reasoningContent = "";
  let errorContent = "";
  let usage = null;
  const blocks = [];
  const citations = [];
  const searchEvents = [];
  let searchToolStarted = false;
  let answeringBeforeSearchTool = false;
  let clientClosed = false;
  const upstreamController = new AbortController();

  res.on("close", () => {
    if (res.writableEnded) return;
    clientClosed = true;
    upstreamController.abort();
  });

  const emitSearch = payload => {
    searchEvents.push({ ...payload, at: new Date().toISOString() });
    if (!clientClosed) writeSse(res, "search", payload);
  };

  const emitAnsweringBeforeSearchTool = () => {
    if (searchToolStarted || answeringBeforeSearchTool) return;
    answeringBeforeSearchTool = true;
    emitSearch({ status: "answering", text: "正在生成回答" });
  };

  try {
    emitSearch({ status: "starting", text: "联网搜索已开启" });
    const upstream = await fetch(`${baseUrl("anthropic")}/messages`, {
      method: "POST",
      headers: deepseekHeaders({
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05"
      }),
      body: JSON.stringify(body),
      signal: upstreamController.signal
    });

    if (!upstream.ok || !upstream.body) {
      const errorText = await upstream.text();
      let parsedError = errorText;
      try {
        parsedError = JSON.parse(errorText);
      } catch {
        // Keep raw error text.
      }
      errorContent = formatDeepSeekError(upstream.status, parsedError);
      writeSse(res, "error", { status: upstream.status, error: errorContent, detail: parsedError });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of upstream.body) {
      if (clientClosed) break;
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() || "";
      for (const part of parts) {
        const eventName = part.match(/^event: (.+)$/m)?.[1] || "message";
        const dataLine = part.split(/\r?\n/).find(item => item.startsWith("data:"));
        if (!dataLine) continue;
        let event;
        try {
          event = JSON.parse(dataLine.slice(5).trim());
        } catch {
          continue;
        }

        if (event.usage) usage = { ...(usage || {}), ...event.usage };
        if (event.message?.usage) usage = { ...(usage || {}), ...event.message.usage };
        if (event.delta?.usage) usage = { ...(usage || {}), ...event.delta.usage };

        if (eventName === "content_block_start" || event.type === "content_block_start") {
          const index = Number(event.index ?? blocks.length);
          const block = { ...(event.content_block || {}) };
          blocks[index] = block;
          if (block.type === "server_tool_use") {
            searchToolStarted = true;
            emitSearch({
              status: "tool_use",
              text: "正在发起网页搜索",
              name: block.name || "web_search",
              input: block.input || {}
            });
          }
          if (block.type === "web_search_tool_result") {
            searchToolStarted = true;
            emitSearch({ status: "reading", text: "正在读取搜索结果" });
          }
          if (block.type === "web_search_tool_result_error") {
            searchToolStarted = true;
            emitSearch({ status: "error", text: "联网搜索返回异常", detail: block });
          }
          if (block.type === "text" && block.text) {
            emitAnsweringBeforeSearchTool();
            assistantContent += block.text;
            if (!clientClosed) writeSse(res, "content", { text: block.text });
          }
        }

        if (eventName === "content_block_delta" || event.type === "content_block_delta") {
          const index = Number(event.index ?? 0);
          const block = blocks[index] || {};
          blocks[index] = block;
          const delta = event.delta || {};
          if (delta.type === "text_delta" && delta.text) {
            emitAnsweringBeforeSearchTool();
            block.type = block.type || "text";
            block.text = `${block.text || ""}${delta.text}`;
            assistantContent += delta.text;
            if (!clientClosed) writeSse(res, "content", { text: delta.text });
          }
          if (shouldUseThinking && (delta.type === "thinking_delta" || delta.type === "reasoning_delta") && delta.thinking) {
            reasoningContent += delta.thinking;
            if (!clientClosed) writeSse(res, "reasoning", { text: delta.thinking });
          }
          if (delta.type === "input_json_delta" && delta.partial_json) {
            block.partial_json = `${block.partial_json || ""}${delta.partial_json}`;
          }
          if (delta.type === "citations_delta" || delta.citation) {
            const citation = normalizeCitation(delta.citation || delta);
            if (citation) {
              citations.push(citation);
              block.citations = [...(block.citations || []), citation];
              if (!clientClosed) writeSse(res, "citation", citation);
            }
          }
        }

        if (eventName === "content_block_stop" || event.type === "content_block_stop") {
          const index = Number(event.index ?? 0);
          const block = blocks[index];
          if (block?.type === "server_tool_use" && block.partial_json && !block.input) {
            try {
              block.input = JSON.parse(block.partial_json);
            } catch {
              block.input = { raw: block.partial_json };
            }
            emitSearch({
              status: "query",
              text: "搜索请求已生成",
              name: block.name || "web_search",
              input: block.input
            });
          }
          if (block?.type === "web_search_tool_result") {
            searchToolStarted = true;
            const results = searchResultsFromBlock(block);
            emitSearch({
              status: "results",
              text: results.length ? `已读取 ${results.length} 个来源` : "未返回可展示来源",
              results
            });
          }
          if (block?.type === "web_search_tool_result_error") {
            searchToolStarted = true;
            emitSearch({ status: "error", text: "搜索结果不可用", detail: block });
          }
        }

        if (eventName === "message_delta" || event.type === "message_delta") {
          if (event.usage) usage = { ...(usage || {}), ...event.usage };
          if (event.delta?.usage) usage = { ...(usage || {}), ...event.delta.usage };
        }

        if (eventName === "error" || event.type === "error") {
          errorContent = formatDeepSeekError(event.error?.status || 500, event.error || event);
          writeSse(res, "error", { error: errorContent, detail: event });
        }
      }
    }
    if (!clientClosed) writeSse(res, "done", {});
  } catch (error) {
    if (error.name !== "AbortError") {
      errorContent = error.message;
      if (!clientClosed) writeSse(res, "error", { error: errorContent });
    }
  } finally {
    if (assistantContent && answeringBeforeSearchTool && !searchToolStarted) {
      emitSearch({ status: "done", text: "已生成回答" });
    }
    if (assistantContent || reasoningContent || errorContent || searchEvents.length) {
      const latest = readSessions().find(item => item.id === session.id) || session;
      const anthropicContent = blocks.filter(Boolean);
      const resultCitations = searchEvents
        .flatMap(event => Array.isArray(event.results) ? event.results : [])
        .map(item => normalizeCitation(item))
        .filter(Boolean);
      const finalCitations = citations.length ? citations : resultCitations;
      const cost = estimateUsageCost(usage, session.model);
      const finalContent = assistantContent.trim()
        ? assistantContent
        : (errorContent ? `调用失败：${errorContent}` : blankAssistantMessage(params.output_mode));
      latest.messages.push({
        role: "assistant",
        content: finalContent,
        reasoning: shouldUseThinking ? reasoningContent : "",
        thinkingUsed: shouldUseThinking,
        interrupted: clientClosed,
        usage,
        cost,
        model: session.model,
        error: Boolean(errorContent),
        searchUsed: true,
        searchEvents,
        citations: finalCitations,
        anthropicContent,
        createdAt: new Date().toISOString()
      });
      saveSessionPatch(latest);
      if (!clientClosed) writeSse(res, "saved", { sessionId: latest.id, usage, cost, citations: finalCitations, searchEvents });
    }
    if (!res.destroyed) res.end();
  }
}

async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");
  const method = req.method || "GET";
  loadEnv();

  try {
    if (url.pathname === "/api/config") {
      return json(res, 200, {
        keyConfigured: hasConfiguredApiKey(),
        defaultModel: process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
        baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
        models: [
          { id: "deepseek-v4-pro", label: "深度求索 V4 Pro", group: "official", status: "current", note: "官方 API 当前可用，质量优先" },
          { id: "deepseek-v4-flash", label: "深度求索 V4 Flash", group: "official", status: "current", note: "官方 API 当前可用，速度和成本优先" }
        ],
        unavailableModels: [
          { id: "deepseek-chat", reason: "旧版别名，官方已停止使用" },
          { id: "deepseek-reasoner", reason: "旧版别名，官方已停止使用" },
          { id: "DeepSeek-V3 / V3.1 / V3.2 / R1 / Coder / Math / MoE", reason: "属于开源或历史系列，官方 API 当前没有把这些作为可直接调用的模型 ID；需要自部署或第三方兼容网关" }
        ],
        endpoints: [
          { name: "对话生成", method: "POST", kind: "core", path: "/chat/completions" },
          { name: "联网搜索", method: "POST", kind: "anthropic", path: "/messages" },
          { name: "结构化输出", method: "POST", kind: "core", path: "/chat/completions" },
          { name: "工具调用", method: "POST", kind: "core", path: "/chat/completions" },
          { name: "前缀续写测试版", method: "POST", kind: "beta", path: "/chat/completions" },
          { name: "严格工具调用测试版", method: "POST", kind: "beta", path: "/chat/completions" },
          { name: "列出模型", method: "GET", kind: "core", path: "/models" },
          { name: "查询余额", method: "GET", kind: "core", path: "/user/balance" },
          { name: "代码补全测试版", method: "POST", kind: "beta", path: "/completions" },
          { name: "兼容消息接口", method: "POST", kind: "anthropic", path: "/messages" }
        ],
        uiCapabilities: {
          webSearch: true,
          outputModes: ["normal", "table", "json", "steps"],
          fileModes: ["attachment", "plain"]
        }
      });
    }

    if (url.pathname === "/api/key" && method === "GET") {
      const apiKey = currentApiKey();
      return json(res, 200, {
        keyConfigured: hasConfiguredApiKey(apiKey),
        apiKey: hasConfiguredApiKey(apiKey) ? apiKey : ""
      });
    }

    if (url.pathname === "/api/key" && method === "POST") {
      const body = await parseJsonBody(req);
      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey) {
        saveEnvValue("DEEPSEEK_API_KEY", "");
        return json(res, 200, {
          ok: true,
          keyConfigured: false
        });
      }
      if (/[\r\n]/.test(apiKey) || apiKey.includes("your_deepseek_api_key_here")) {
        return json(res, 400, { error: "密钥不正确，请检查后重新输入。" });
      }
      const validation = await validateApiKey(apiKey);
      if (!validation.ok) {
        return json(res, validation.status || 400, {
          error: validation.error || "密钥校验失败，请稍后重试。",
          detail: validation.detail
        });
      }
      saveEnvValue("DEEPSEEK_API_KEY", apiKey);
      return json(res, 200, {
        ok: true,
        keyConfigured: true,
        balance: validation.balance
      });
    }

    if (url.pathname === "/api/sessions" && method === "GET") {
      return json(res, 200, readSessions().map(sessionSummary));
    }

    if (url.pathname === "/api/sessions" && method === "POST") {
      const body = await parseJsonBody(req);
      const session = createSession(body.title || "新对话");
      saveSessionPatch(session);
      return json(res, 201, session);
    }

    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && method === "GET") {
      const session = readSessions().find(item => item.id === sessionMatch[1]);
      return session ? json(res, 200, session) : json(res, 404, { error: "会话不存在。" });
    }

    if (sessionMatch && method === "PATCH") {
      const body = await parseJsonBody(req);
      const sessions = readSessions();
      const index = sessions.findIndex(item => item.id === sessionMatch[1]);
      if (index < 0) return json(res, 404, { error: "会话不存在。" });
      sessions[index] = { ...sessions[index], ...body, updatedAt: new Date().toISOString() };
      writeSessions(sessions);
      return json(res, 200, sessions[index]);
    }

    if (sessionMatch && method === "DELETE") {
      writeSessions(readSessions().filter(item => item.id !== sessionMatch[1]));
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/api/chat/stream" && method === "POST") {
      return handleChatStream(req, res);
    }

    if (url.pathname === "/api/chat/search-stream" && method === "POST") {
      return handleSearchChatStream(req, res);
    }

    if (url.pathname === "/api/models" && method === "GET") {
      const result = await proxyJson({ kind: "core", method: "GET", apiPath: "/models" });
      return json(res, result.status, result.body);
    }

    if (url.pathname === "/api/balance" && method === "GET") {
      const result = await proxyJson({ kind: "core", method: "GET", apiPath: "/user/balance" });
      return json(res, result.status, result.body);
    }

    if (url.pathname === "/api/proxy" && method === "POST") {
      const body = await parseJsonBody(req);
      const result = await proxyJson({
        kind: body.kind || "core",
        method: String(body.method || "GET").toUpperCase(),
        apiPath: body.path || "/models",
        body: body.body || {},
        extraHeaders: body.kind === "anthropic" ? { "anthropic-version": body.anthropicVersion || "2023-06-01" } : {}
      });
      return json(res, result.status, result.body);
    }

    return json(res, 404, { error: "接口不存在。" });
  } catch (error) {
    return json(res, 500, { error: error.message });
  }
}

loadEnv();
ensureData();

const server = http.createServer((req, res) => {
  if ((req.url || "").startsWith("/api/")) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

const port = Number(process.env.PORT || 3217);
server.listen(port, () => {
  console.log(`DeepSeek Local Console running at http://localhost:${port}`);
  console.log("API Key location: D:\\小工具\\deepseek-api-demo\\.env");
});
