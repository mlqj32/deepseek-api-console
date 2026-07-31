const state = {
  sessions: [],
  current: null,
  config: null,
  endpoints: [],
  models: [],
  balance: null,
  files: [],
  isStreaming: false,
  abortController: null,
  abortRequested: false,
  autoScrollMessages: true,
  isSyncingControls: false,
  settingsSaveTimers: new Map(),
  markdownCache: new Map(),
  messageRenderToken: 0,
  historyRender: null
};

const $ = selector => document.querySelector(selector);
const assistantAvatar = `<img src="/assets/deepseek-whale.svg?v=20260729-polish" alt="DeepSeek">`;
const keyVisibleStorageKey = "deepseek.keyVisible";
const defaultSessionSettings = {
  system: "你是 DeepSeek，本地接口控制台中的可靠中文助手。",
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
  }
};

function hasUnsupportedFiles() {
  return state.files.some(file => !file.supported);
}

function hasSendablePayload() {
  const text = ($("#prompt")?.value || "").trim();
  return !hasUnsupportedFiles() && Boolean(text || state.files.some(file => file.supported));
}

function updateSendState() {
  const button = $("#send");
  if (!button) return;
  if (state.isStreaming) {
    button.disabled = state.abortRequested;
    button.textContent = state.abortRequested ? "停止中" : "停止";
    button.title = state.abortRequested ? "正在停止本轮响应" : "停止本轮响应";
    button.classList.add("stop");
    return;
  }
  button.textContent = "发送";
  button.classList.remove("stop");
  const canSend = hasSendablePayload();
  button.disabled = !canSend;
  button.title = hasUnsupportedFiles()
    ? "请先移除不支持的文件"
    : (canSend ? "发送消息" : "请输入消息，或添加可发送的文本类文件");
}

function autoResizePrompt() {
  const input = $("#prompt");
  if (!input) return;
  input.style.height = "auto";
  const maxHeight = 170;
  const nextHeight = Math.min(input.scrollHeight, maxHeight);
  input.style.height = `${Math.max(nextHeight, 72)}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

function stopGeneration() {
  if (!state.isStreaming || !state.abortController) return;
  state.abortRequested = true;
  updateSendState();
  state.abortController.abort();
}

function pretty(value) {
  return JSON.stringify(value, null, 2);
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readBalanced(text, start, open = "{", close = "}") {
  if (text[start] !== open) return null;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    if (text[index] === close) depth -= 1;
    if (depth === 0) {
      return { value: text.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function normalizeMathSymbols(text) {
  const symbols = {
    "\\leq": "≤",
    "\\le": "≤",
    "\\geq": "≥",
    "\\ge": "≥",
    "\\neq": "≠",
    "\\ne": "≠",
    "\\approx": "≈",
    "\\sim": "∼",
    "\\times": "×",
    "\\cdot": "·",
    "\\div": "÷",
    "\\pm": "±",
    "\\mp": "∓",
    "\\infty": "∞",
    "\\angle": "∠",
    "\\triangle": "△",
    "\\parallel": "∥",
    "\\perp": "⊥",
    "\\to": "→",
    "\\rightarrow": "→",
    "\\leftarrow": "←",
    "\\Rightarrow": "⇒",
    "\\Leftrightarrow": "⇔",
    "\\because": "∵",
    "\\therefore": "∴",
    "\\pi": "π",
    "\\theta": "θ",
    "\\alpha": "α",
    "\\beta": "β",
    "\\gamma": "γ",
    "\\Delta": "Δ",
    "\\lambda": "λ",
    "\\mu": "μ",
    "\\omega": "ω",
    "\\sin": "sin",
    "\\cos": "cos",
    "\\tan": "tan",
    "\\log": "log",
    "\\ln": "ln"
  };
  let output = String(text || "")
    .replace(/\\left|\\right/g, "")
    .replace(/\\,/g, " ")
    .replace(/\\quad|\\qquad/g, " ")
    .replace(/\\%/g, "%");
  for (const [key, value] of Object.entries(symbols)) {
    output = output.replaceAll(key, value);
  }
  return output;
}

function replaceMathCommand(text, pattern, replacer) {
  let output = "";
  let cursor = 0;
  pattern.lastIndex = 0;
  while (true) {
    const match = pattern.exec(text);
    if (!match) break;
    const brace = text.indexOf("{", pattern.lastIndex);
    if (brace < 0) break;
    const first = readBalanced(text, brace);
    if (!first) break;
    output += text.slice(cursor, match.index);
    output += replacer(first, brace);
    cursor = first.end;
    pattern.lastIndex = first.end;
  }
  return output + text.slice(cursor);
}

function replaceMathFraction(text, stash) {
  let output = "";
  let cursor = 0;
  const pattern = /\\(?:dfrac|tfrac|frac)\s*/g;
  while (true) {
    const match = pattern.exec(text);
    if (!match) break;
    const numeratorStart = pattern.lastIndex;
    const numerator = readBalanced(text, numeratorStart);
    if (!numerator) continue;
    let denominatorStart = numerator.end;
    while (/\s/.test(text[denominatorStart] || "")) denominatorStart += 1;
    const denominator = readBalanced(text, denominatorStart);
    if (!denominator) continue;
    output += text.slice(cursor, match.index);
    output += stash(`<span class="math-frac"><span class="math-num">${renderMathContent(numerator.value)}</span><span class="math-den">${renderMathContent(denominator.value)}</span></span>`);
    cursor = denominator.end;
    pattern.lastIndex = denominator.end;
  }
  return output + text.slice(cursor);
}

function replaceMathSqrt(text, stash) {
  let output = "";
  let cursor = 0;
  const pattern = /\\sqrt\s*/g;
  while (true) {
    const match = pattern.exec(text);
    if (!match) break;
    let index = pattern.lastIndex;
    let rootIndex = "";
    if (text[index] === "[") {
      const optional = readBalanced(text, index, "[", "]");
      if (optional) {
        rootIndex = optional.value;
        index = optional.end;
      }
    }
    const body = readBalanced(text, index);
    if (!body) continue;
    output += text.slice(cursor, match.index);
    const indexHtml = rootIndex ? `<span class="math-root-index">${renderMathContent(rootIndex)}</span>` : "";
    output += stash(`<span class="math-root">${indexHtml}<span class="math-radicand">${renderMathContent(body.value)}</span></span>`);
    cursor = body.end;
    pattern.lastIndex = body.end;
  }
  return output + text.slice(cursor);
}

function renderMathContent(text) {
  const stashItems = [];
  const stash = html => {
    const key = `\uE000${stashItems.length}\uE001`;
    stashItems.push(html);
    return key;
  };
  let output = normalizeMathSourceForTex(stripMathDelimiters(text));
  output = replaceMathFraction(output, stash);
  output = replaceMathSqrt(output, stash);
  output = normalizeMathSymbols(output);
  output = escapeHtml(output)
    .replace(/\^\{([^{}]+)\}/g, "<sup>$1</sup>")
    .replace(/_\{([^{}]+)\}/g, "<sub>$1</sub>")
    .replace(/\^([A-Za-z0-9+\-=]+)/g, "<sup>$1</sup>")
    .replace(/_([A-Za-z0-9+\-=]+)/g, "<sub>$1</sub>");
  output = output.replace(/\uE000(\d+)\uE001/g, (_, index) => stashItems[Number(index)] || "");
  return output;
}

function renderKatexMath(text, displayMode) {
  if (!window.katex) return null;
  try {
    return window.katex.renderToString(normalizeMathSourceForTex(stripMathDelimiters(text)), {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "html"
    });
  } catch {
    return null;
  }
}

function hasMathJaxRenderer() {
  return Boolean(window.MathJax && typeof window.MathJax.typesetPromise === "function");
}

function stripMathDelimiters(text) {
  let value = String(text || "").trim();
  value = value.replace(/^\\+\(?\s*/, match => {
    const slashCount = (match.match(/\\/g) || []).length;
    return slashCount > 1 && match.endsWith("(") ? "\\(" : match;
  });
  let changed = true;
  while (changed && value) {
    changed = false;
    const pairs = [
      ["\\[", "\\]"],
      ["\\(", "\\)"],
      ["$$", "$$"],
      ["$", "$"],
      ["[", "]"]
    ];
    for (const [open, close] of pairs) {
      if (value.startsWith(open) && value.endsWith(close) && value.length > open.length + close.length) {
        const next = value.slice(open.length, -close.length).trim();
        if (next) {
          value = next;
          changed = true;
        }
      }
    }
  }
  value = value
    .replace(/^(?:\\\()+\s*/, "")
    .replace(/\s*(?:\\\))+$/, "");
  return value;
}

function normalizeMathDelimiterNoise(text) {
  return String(text || "")
    .replace(/\\{2,}\(/g, "\\(")
    .replace(/\\{2,}\)/g, "\\)")
    .replace(/\\{2,}\[/g, "\\[")
    .replace(/\\{2,}\]/g, "\\]");
}

function expandUnicodeMathTokens(text) {
  const superscripts = {
    "⁰": "0",
    "¹": "1",
    "²": "2",
    "³": "3",
    "⁴": "4",
    "⁵": "5",
    "⁶": "6",
    "⁷": "7",
    "⁸": "8",
    "⁹": "9",
    "⁺": "+",
    "⁻": "-",
    "⁽": "(",
    "⁾": ")"
  };
  let output = String(text || "");
  output = output.replace(/([A-Za-z0-9\)])([⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+)/g, (_, base, sup) => {
    const converted = sup.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]/g, ch => superscripts[ch] || ch);
    return `${base}^${converted}`;
  });
  output = output.replace(/∛\s*(\([^)]+\)|\{[^}]+\}|[A-Za-z0-9_.]+)/g, (_, body) => {
    const value = body.startsWith("(") || body.startsWith("{") ? body.slice(1, -1) : body;
    return `\\sqrt[3]{${value}}`;
  });
  output = output.replace(/√\s*(\([^)]+\)|\{[^}]+\}|[A-Za-z0-9_.]+)/g, (_, body) => {
    const value = body.startsWith("(") || body.startsWith("{") ? body.slice(1, -1) : body;
    return `\\sqrt{${value}}`;
  });
  return output;
}

function normalizeMathSourceForTex(text) {
  return expandUnicodeMathTokens(String(text || ""))
    .replace(/(?<!\\)\bsqrt\s*\(([^()]+)\)/g, "\\sqrt{$1}")
    .replace(/(?<!\\)\bsqrt\s*\{([^{}]+)\}/g, "\\sqrt{$1}")
    .replace(/(?<!\\)\bsqrt\s*([A-Za-z0-9.]+)/g, "\\sqrt{$1}")
    .replace(/(?<!\\)\b(ln|sin|cos|tan|log)(?=\s*[A-Za-z(])/g, "\\$1 ")
    .replace(/([A-Za-z0-9)])\^(?:\\ln\s*|ln)([A-Za-z])/g, "$1^{\\ln $2}");
}

function renderMathJaxSource(text, displayMode) {
  const raw = normalizeMathSourceForTex(stripMathDelimiters(text));
  if (typeof window.MathJax?.tex2chtml === "function") {
    try {
      const node = window.MathJax.tex2chtml(raw, { display: displayMode });
      cleanupMathJaxUi(node);
      const html = node.outerHTML;
      return displayMode
        ? `<div class="math-block mathjax-wrap">${html}</div>`
        : `<span class="math-inline mathjax-wrap">${html}</span>`;
    } catch (error) {
      console.warn("MathJax direct render failed:", error);
    }
  }
  const source = escapeHtml(raw);
  if (displayMode) {
    return `<div class="math-block mathjax-wrap">\\[${source}\\]</div>`;
  }
  return `<span class="math-inline mathjax-wrap">\\(${source}\\)</span>`;
}

const mathTypesetInterval = 180;

function isMessagesNearBottom(threshold = 96) {
  const wrap = $("#messages");
  if (!wrap) return true;
  return wrap.scrollHeight - wrap.clientHeight - wrap.scrollTop <= threshold;
}

function scrollMessagesToBottom(force = false) {
  const wrap = $("#messages");
  if (!wrap) return;
  if (!force && !state.autoScrollMessages && !isMessagesNearBottom()) return;
  wrap.scrollTop = wrap.scrollHeight;
  state.autoScrollMessages = true;
  requestAnimationFrame(() => {
    if (!force && !state.autoScrollMessages && !isMessagesNearBottom()) return;
    wrap.scrollTop = wrap.scrollHeight;
    state.autoScrollMessages = true;
  });
}

function scheduleLowPriorityRender(callback) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: 300 });
    return;
  }
  window.setTimeout(callback, 40);
}

function prependOlderMessagesIfNeeded() {
  const wrap = $("#messages");
  const history = state.historyRender;
  if (!wrap || !history || history.busy || history.firstRenderedIndex <= 0) return;
  if (wrap.scrollTop > 180) return;
  history.busy = true;
  scheduleLowPriorityRender(() => {
    if (history !== state.historyRender || history.token !== state.messageRenderToken) return;
    const end = history.firstRenderedIndex;
    const start = Math.max(0, end - 8);
    const previousHeight = wrap.scrollHeight;
    const previousTop = wrap.scrollTop;
    const fragment = document.createDocumentFragment();
    const nodes = [];
    for (let index = start; index < end; index += 1) {
      const node = messageNode(history.messages[index], index);
      nodes.push(node);
      fragment.appendChild(node);
    }
    wrap.insertBefore(fragment, wrap.firstChild);
    nodes.forEach(node => {
      scheduleMathTypeset(node, false, false);
      scheduleMermaidRender(node);
    });
    history.firstRenderedIndex = start;
    history.busy = false;
    wrap.scrollTop = previousTop + (wrap.scrollHeight - previousHeight);
    if (history.firstRenderedIndex <= 0) state.historyRender = null;
    else if (wrap.scrollTop <= 180) prependOlderMessagesIfNeeded();
  });
}

function cleanupMathJaxUi(root) {
  if (!root) return;
  for (const item of root.querySelectorAll("mjx-container")) {
    item.removeAttribute("tabindex");
    item.className = String(item.className || "")
      .replace(/\bCtxtMenu_[^\s]+/g, "")
      .replace(/\bmjx-explorer-active\b/g, "")
      .trim();
  }
  root.querySelectorAll("mjx-help, mjx-speech-container, .MJX_LiveRegion, .MJX_HoverRegion, .MJX_ToolTip").forEach(item => {
    item.remove();
  });
  root.querySelectorAll(".mjx-selected").forEach(item => {
    item.classList.remove("mjx-selected");
  });
}

function bindMathJaxUiGuards() {
  const guard = event => {
    const container = event.target?.closest?.("mjx-container");
    if (!container || !container.closest(".markdown-body")) return;
    event.stopImmediatePropagation();
    window.setTimeout(() => {
      cleanupMathJaxUi(container.closest(".markdown-body"));
    }, 0);
  };
  document.addEventListener("click", guard, true);
  document.addEventListener("focusin", guard, true);
}

bindMathJaxUiGuards();

function scheduleMathTypeset(root, immediate = false, keepBottom = false) {
  if (!root || !hasMathJaxRenderer()) return;
  const typesetState = root.__mathJaxState || {
    timer: null,
    busy: false,
    pending: false,
    lastRun: 0,
    keepBottom: false
  };
  root.__mathJaxState = typesetState;
  typesetState.pending = true;
  typesetState.keepBottom = typesetState.keepBottom || keepBottom;

  if (typesetState.busy || typesetState.timer) return;

  const now = typeof performance !== "undefined" ? performance.now() : Date.now();
  const wait = immediate ? 0 : Math.max(0, mathTypesetInterval - (now - typesetState.lastRun));
  typesetState.timer = window.setTimeout(() => {
    typesetState.timer = null;
    typesetState.busy = true;
    typesetState.pending = false;
    typesetState.lastRun = typeof performance !== "undefined" ? performance.now() : Date.now();

    const run = async () => {
      try {
        if (typeof window.MathJax.typesetClear === "function") {
          window.MathJax.typesetClear([root]);
        }
        await window.MathJax.typesetPromise([root]);
        cleanupMathJaxUi(root);
        if (typesetState.keepBottom) scrollMessagesToBottom();
      } catch (error) {
        console.warn("MathJax typeset failed:", error);
      }
    };

    const startup = window.MathJax.startup?.promise || Promise.resolve();
    startup
      .then(run)
      .finally(() => {
        typesetState.busy = false;
        const shouldKeepBottom = typesetState.keepBottom;
        typesetState.keepBottom = false;
        if (typesetState.pending) scheduleMathTypeset(root, immediate, shouldKeepBottom);
      })
      .catch(error => {
        console.warn("MathJax typeset failed:", error);
      });
  }, wait);
}

function renderInlineMath(text) {
  if (hasMathJaxRenderer()) return renderMathJaxSource(text, false);
  const katexHtml = renderKatexMath(text, false);
  if (katexHtml) return `<span class="math-inline katex-wrap">${katexHtml}</span>`;
  return `<span class="math-inline">${renderMathContent(text)}</span>`;
}

function renderBlockMath(text) {
  if (hasMathJaxRenderer()) return renderMathJaxSource(text, true);
  const katexHtml = renderKatexMath(text, true);
  if (katexHtml) return `<div class="math-block katex-wrap">${katexHtml}</div>`;
  return `<div class="math-block">${renderMathContent(text)}</div>`;
}

function repairLooseMathDelimiters(text) {
  let output = String(text || "");
  output = output.replace(
    /(^|[^\w\\])\{([^{}\n]+)\}\s*\{(\\(?:sin|cos|tan|ln|log)[^{}\n]*)\}/g,
    (_, prefix, numerator, denominator) => `${prefix}\\frac{${numerator}}{${denominator}}`
  );
  output = output.replace(
    /(^|\n)\s*\[\s*([^\n]*\\(?:frac|sqrt|quad|sin|cos|tan|ln|log|pi|theta|alpha|beta|gamma|Delta)[^\n]*?)\s*\\\]/g,
    (_, prefix, body) => `${prefix}\\[${body.trim()}\\]`
  );
  output = output.replace(
    /(^|\n)\s*\\\[\s*([^\n]*\\(?:frac|sqrt|quad|sin|cos|tan|ln|log|pi|theta|alpha|beta|gamma|Delta)[^\n]*?)\s*\]/g,
    (_, prefix, body) => `${prefix}\\[${body.trim()}\\]`
  );
  return output.replace(
    /(^|[^\\])((?:(?:\\(?:frac|dfrac|tfrac|sqrt|sin|cos|tan|ln|log|pi|theta|alpha|beta|gamma|Delta|leq|geq|neq|cdot|times|to|infty))|[A-Za-z0-9{}_^+\-=*/().,\s])+?)\s*\\\)/g,
    (match, prefix, body, offset) => {
      if (offset > 0 && output[offset - 1] === "\\") return match;
      const lineStart = output.lastIndexOf("\n", offset) + 1;
      const beforeInLine = output.slice(lineStart, offset);
      if (/\\\(|\\\[|\$(?!\$)/.test(beforeInLine)) return match;
      const trimmed = body.trim();
      const looksMath = /\\(?:frac|dfrac|tfrac|sqrt|sin|cos|tan|ln|log|pi|theta|alpha|beta|gamma|Delta|leq|geq|neq|cdot|times|to|infty)|[{}_^=+\-*/]/.test(trimmed);
      return looksMath ? `${prefix}\\(${trimmed}\\)` : match;
    }
  );
}

function renderInlineMarkdown(text) {
  const stashItems = [];
  const stash = html => {
    const key = `\uE010${stashItems.length}\uE011`;
    stashItems.push(html);
    return key;
  };
  let output = repairLooseMathDelimiters(normalizeMathDelimiterNoise(text))
    .replace(/`([^`]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`))
    .replace(/<br\s*\/?>/gi, () => stash("<br>"))
    .replace(/\\\((.+?)\\\)/g, (_, math) => stash(renderInlineMath(math)))
    .replace(/\\\[(.+?)\\\]/g, (_, math) => stash(renderBlockMath(math)))
    .replace(/\[([^\]\n]*(?:\\(?:frac|dfrac|tfrac|sqrt|sum|int|lim|sin|cos|tan|ln|log|pi|theta|alpha|beta|gamma|Delta|pm|leq|geq|neq)|[_^=+\-]|[≤≥≠±√])[^\]\n]*)\]/g, (_, math) => stash(renderInlineMath(math)))
    .replace(/\$(?!\$)([^$\n]+?)\$/g, (_, math) => stash(renderInlineMath(math)));
  output = escapeHtml(output)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return output.replace(/\uE010(\d+)\uE011/g, (_, index) => stashItems[Number(index)] || "");
}

function isLooseBracketMathLine(line) {
  const value = String(line || "").trim();
  if (!value.startsWith("[") || !value.endsWith("]") || value.startsWith("\\[")) return false;
  const inner = value.slice(1, -1).trim();
  if (!inner || /^\S+\]\(/.test(inner)) return false;
  return /\\(?:frac|dfrac|tfrac|sqrt|sum|int|lim|sin|cos|tan|ln|log|pi|theta|alpha|beta|gamma|Delta|pm|leq|geq|neq)|[_^=+\-]|[≤≥≠±√]/.test(inner);
}

function renderMarkdownTable(lines) {
  const rows = lines.map(line => line.trim().replace(/^\||\|$/g, "").split("|").map(cell => cell.trim()));
  const head = rows[0] || [];
  const body = rows.slice(2);
  const layoutClass = getMarkdownTableLayoutClass(head);
  const thead = `<thead><tr>${head.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map(row => `<tr>${row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="md-table-wrap ${layoutClass}"><table>${thead}${tbody}</table></div>`;
}

function getMarkdownTableLayoutClass(head) {
  const cells = head.map(cell => String(cell || "").replace(/\s+/g, ""));
  const hasHeader = value => cells.some(cell => cell.includes(value));
  if (cells.length === 2) return "md-table-two";
  if (cells.length === 3 && hasHeader("阶段") && hasHeader("内容") && hasHeader("年级")) return "md-table-info";
  if (cells.length === 3) return "md-table-compare";
  if (cells.length >= 4) return "md-table-wide";
  return "";
}

function renderBoxDrawingTable(source) {
  const rows = String(source || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.includes("│") && !/^[┌├└┬┼┴─┐┤┘\s]+$/.test(line))
    .map(line => line.replace(/^│|│$/g, "").split("│").map(cell => cell.trim()))
    .filter(row => row.length >= 2 && row.some(Boolean));
  if (rows.length < 2) return "";
  const width = rows[0].length;
  if (!rows.every(row => row.length === width)) return "";
  const head = rows[0];
  const body = rows.slice(1);
  const layoutClass = getMarkdownTableLayoutClass(head);
  const thead = `<thead><tr>${head.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`;
  const tbody = `<tbody>${body.map(row => `<tr>${row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="md-table-wrap ${layoutClass}"><table>${thead}${tbody}</table></div>`;
}

function renderAlignedTextTable(source) {
  const text = String(source || "");
  if (!/[\u4e00-\u9fa5]/.test(text)) return "";
  if (/^\s*(?:function|class|const|let|var|import|export|def|public|private|#include|select|from|where)\b/im.test(text)) return "";
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 3) return "";
  const rows = lines.map(line => line.split(/\t+|\s{2,}/).map(cell => cell.trim()).filter(Boolean));
  const usable = rows.filter(row => row.length >= 2);
  if (usable.length < Math.max(3, Math.ceil(lines.length * 0.6))) return "";
  const width = Math.max(...usable.map(row => row.length));
  if (width < 2 || width > 4) return "";
  const normalized = usable.map(row => {
    const next = row.slice(0, width);
    while (next.length < width) next.push("");
    return next;
  });
  const tbody = `<tbody>${normalized.map(row => `<tr>${row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  return `<div class="md-table-wrap aligned-text-table"><table>${tbody}</table></div>`;
}

function codeLanguageLabel(lang) {
  const key = String(lang || "").toLowerCase().replace(/[\s_-]+/g, "");
  const labels = {
    js: "JavaScript",
    javascript: "JavaScript",
    ts: "TypeScript",
    typescript: "TypeScript",
    jsx: "JSX",
    tsx: "TSX",
    py: "Python",
    python: "Python",
    java: "Java",
    c: "C",
    cpp: "C++",
    cs: "C#",
    csharp: "C#",
    html: "HTML",
    css: "CSS",
    json: "JSON",
    docker: "Dockerfile",
    dockerfile: "Dockerfile",
    bash: "Shell",
    sh: "Shell",
    shell: "Shell",
    linux: "Shell",
    cmd: "CMD",
    bat: "Batch",
    batch: "Batch",
    sql: "SQL",
    mermaid: "Mermaid",
    brainfuck: "Brainfuck",
    brainfucklang: "Brainfuck"
  };
  return labels[key] || (lang ? String(lang).trim() : "代码");
}

function isMermaidSource(source, lang = "") {
  const first = String(source || "").trimStart().split(/\r?\n/)[0]?.trim() || "";
  return String(lang || "").toLowerCase() === "mermaid"
    || /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram-v2|erDiagram|gantt|journey|pie|mindmap|timeline|gitGraph)\b/.test(first);
}

function isTextChartSource(source) {
  const text = String(source || "");
  if (!text.trim()) return false;
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 3) return false;
  const hasBarRun = /[█▓▒░■□▪▫▰▱▉▊▋▌▍▎▏▔▁▂▃▄▅▆▇]{3,}/.test(text);
  const hasChartCue = /[：:]\s*$|^\s*[\u4e00-\u9fa5A-Za-z0-9_. -]{1,24}\s+[█▓▒░■□▪▫▰▱▉▊▋▌▍▎▏▔▁▂▃▄▅▆▇]/m.test(text);
  const looksLikeCode = /^\s*(?:function|class|const|let|var|import|export|def|public|private|#include|select|from|where)\b/im.test(text);
  return hasBarRun && hasChartCue && !looksLikeCode;
}

function highlightCode(source, lang = "") {
  const stashItems = [];
  const stash = html => {
    const key = `\uE020${String.fromCharCode(0xE100 + stashItems.length)}\uE021`;
    stashItems.push(html);
    return key;
  };
  const rawLanguage = String(lang || "").toLowerCase();
  const aliases = {
    bat: "cmd",
    batch: "cmd",
    shell: "bash",
    sh: "bash",
    zsh: "bash",
    linux: "bash",
    docker: "dockerfile",
    dockerfile: "dockerfile",
    py: "python",
    cc: "cpp",
    cxx: "cpp",
    "c++": "cpp",
    hpp: "cpp",
    h: "c"
  };
  const language = aliases[rawLanguage] || rawLanguage;
  const restore = value => value.replace(/\uE020([\uE100-\uEFFF])\uE021/g, (_, key) => stashItems[key.charCodeAt(0) - 0xE100] || "");
  const markWords = (html, words, className, flags = "g") => {
    if (!words) return html;
    return html.replace(new RegExp(`\\b(${words})\\b`, flags), value => stash(`<span class="${className}">${value}</span>`));
  };
  const quotedStringPattern = /(&quot;(?:\\.|(?!&quot;)[^\n])*?&quot;|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/g;
  let output = escapeHtml(source || "");

  if (language === "json") {
    output = output.replace(/(&quot;(?:\\.|(?!&quot;)[^\n])*?&quot;)(\s*:)/g, (_, key, colon) => stash(`<span class="tok-property">${key}</span>${colon}`));
    output = output.replace(/(&quot;(?:\\.|(?!&quot;)[^\n])*?&quot;)/g, value => stash(`<span class="tok-string">${value}</span>`));
    output = output.replace(/\b(true|false|null)\b/g, value => stash(`<span class="tok-constant">${value}</span>`));
    output = output.replace(/-?\b(\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/gi, value => stash(`<span class="tok-number">${value}</span>`));
    return restore(output);
  }

  if (["java", "c", "cpp", "js", "javascript", "ts", "typescript", "jsx", "tsx", "css"].includes(language)) {
    output = output.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, value => stash(`<span class="tok-comment">${value}</span>`));
  } else if (["python", "bash", "dockerfile", "powershell"].includes(language)) {
    output = output.replace(/(^|\s)(#[^\n]*)/gm, (_, prefix, comment) => `${prefix}${stash(`<span class="tok-comment">${comment}</span>`)}`);
  } else if (language === "cmd") {
    output = output.replace(/^(\s*)(::[^\n]*|rem\b[^\n]*)/gim, (_, prefix, comment) => `${prefix}${stash(`<span class="tok-comment">${comment}</span>`)}`);
  }

  output = output.replace(quotedStringPattern, value => stash(`<span class="tok-string">${value}</span>`));

  const keywordSets = {
    bash: {
      keyword: "if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|time|in",
      command: "apt|apt-get|cat|cd|chmod|chown|cp|curl|docker|echo|export|find|grep|head|kill|ln|ls|mkdir|mv|npm|pnpm|ps|pwd|rm|rsync|sed|sudo|tail|tar|touch|unzip|vim|wget|yarn"
    },
    dockerfile: {
      keyword: "FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS"
    },
    cmd: {
      keyword: "if|else|for|in|do|not|exist|errorlevel|defined",
      command: "assoc|attrib|call|cd|chcp|cls|cmd|copy|del|dir|echo|endlocal|erase|exit|find|findstr|goto|md|mkdir|move|path|pause|popd|pushd|rd|rem|ren|rename|rmdir|set|setlocal|start|type|where|xcopy"
    },
    python: {
      keyword: "and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield",
      type: "bool|bytes|dict|float|frozenset|int|list|object|set|str|tuple",
      command: "print|len|range|enumerate|zip|open|sum|min|max|sorted"
    },
    java: {
      keyword: "abstract|assert|break|case|catch|class|const|continue|default|do|else|enum|extends|final|finally|for|if|implements|import|instanceof|interface|native|new|package|private|protected|public|return|static|strictfp|super|switch|synchronized|this|throw|throws|transient|try|volatile|while",
      type: "boolean|byte|char|double|float|int|long|short|void|String|Integer|Long|Double|Float|Boolean|List|Map|Set|ArrayList|HashMap"
    },
    c: {
      keyword: "auto|break|case|const|continue|default|do|else|enum|extern|for|goto|if|inline|register|restrict|return|sizeof|static|struct|switch|typedef|union|volatile|while",
      type: "bool|char|double|float|int|long|short|signed|unsigned|void|size_t|FILE"
    },
    cpp: {
      keyword: "alignas|alignof|and|asm|auto|break|case|catch|class|concept|const|constexpr|continue|decltype|default|delete|do|else|enum|explicit|export|extern|final|for|friend|goto|if|inline|namespace|new|noexcept|operator|override|private|protected|public|return|sizeof|static|struct|switch|template|this|throw|try|typedef|typename|union|using|virtual|volatile|while",
      type: "bool|char|double|float|int|long|short|signed|unsigned|void|size_t|string|vector|map|set|unordered_map|unordered_set|unique_ptr|shared_ptr"
    },
    css: {
      keyword: "align-items|background|border|color|display|flex|font|gap|grid|height|justify-content|margin|padding|position|width",
      constant: "absolute|auto|block|border-box|center|fixed|flex|grid|hidden|inline|none|relative|solid|sticky|transparent"
    },
    sql: {
      keyword: "select|from|where|join|left|right|inner|outer|insert|update|delete|create|table|group|order|by|limit|as|and|or|not|on|having|values|into|distinct",
      type: "int|integer|varchar|char|text|date|datetime|timestamp|boolean|decimal|numeric"
    }
  };

  const sets = keywordSets[language] || {
    keyword: "async|await|break|case|catch|class|const|continue|def|default|do|else|enum|except|export|extends|finally|for|from|function|if|import|in|interface|let|new|return|static|switch|this|throw|try|var|void|while|with|yield"
  };
  output = markWords(output, sets.type, "tok-type");
  output = markWords(output, sets.keyword, "tok-keyword", language === "dockerfile" ? "gi" : "g");
  output = markWords(output, sets.command, "tok-command", language === "cmd" ? "gi" : "g");
  output = markWords(output, sets.constant || "true|false|null|undefined|None|True|False|nullptr|NULL", "tok-constant");
  output = output.replace(/\b(\d+(?:\.\d+)?)\b/g, value => stash(`<span class="tok-number">${value}</span>`));
  return restore(output);
}

function renderCodeBlock(code) {
  const source = code.lines.join("\n");
  const lang = code.lang || "";
  if (!lang && /[┌┐└┘├┤│]/.test(source)) {
    const table = renderBoxDrawingTable(source);
    if (table) return table;
  }
  if (!lang) {
    const table = renderAlignedTextTable(source);
    if (table) return table;
    if (isTextChartSource(source)) {
      return `<div class="text-chart-card"><pre>${escapeHtml(source)}</pre></div>`;
    }
  }
  if (isMermaidSource(source, lang)) {
    return `<div class="mermaid-card"><div class="code-label"><span>Mermaid 图表</span><div class="mermaid-actions"><button class="icon-action download-mermaid" type="button" data-format="png" title="下载为 PNG"><span class="download-icon" aria-hidden="true"></span><span>PNG</span></button><button class="icon-action download-mermaid" type="button" data-format="jpg" title="下载为 JPG（白底）"><span class="download-icon" aria-hidden="true"></span><span>JPG</span></button></div></div><div class="mermaid">${escapeHtml(source)}</div></div>`;
  }
  return `<div class="code-card"><div class="code-label">${escapeHtml(codeLanguageLabel(lang))}</div><pre><code class="language-${escapeHtml(lang || "text")}">${highlightCode(source, lang)}</code></pre></div>`;
}

function scheduleMermaidRender(root) {
  if (!root || !window.mermaid) return;
  window.mermaid.initialize?.({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      primaryColor: "#eef6ff",
      primaryBorderColor: "#9eb8ff",
      primaryTextColor: "#172033",
      lineColor: "#64748b",
      fontFamily: "Microsoft YaHei, Arial, sans-serif"
    },
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
    state: { htmlLabels: false },
    sequence: { useMaxWidth: true }
  });
  window.setTimeout(() => {
    const nodes = [...root.querySelectorAll(".mermaid:not([data-processed='true'])")];
    if (!nodes.length) return;
    window.mermaid.run({ nodes }).catch(error => {
      console.warn("Mermaid render failed:", error);
      nodes.forEach(node => {
        node.classList.add("mermaid-error");
        node.textContent = "图表暂时无法渲染，已保留原始 Mermaid 内容。";
      });
    });
  }, 80);
}

function renderMarkdown(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    const attrs = list.type === "ol" && Number.isFinite(list.start) && list.start > 1
      ? ` start="${list.start}"`
      : "";
    html.push(`<${list.type}${attrs}>${list.items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${renderMarkdown(quote.join("\n"))}</blockquote>`);
    quote = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trimEnd();

    if (code) {
      if (/^```/.test(line.trim())) {
        html.push(renderCodeBlock(code));
        code = null;
      } else {
        code.lines.push(raw);
      }
      continue;
    }

    if (/^```/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushQuote();
      const lang = line.trim().slice(3).trim().split(/\s+/)[0] || "";
      code = { lines: [], lang: lang.toLowerCase() };
      continue;
    }

    const blockMathStart = line.trim();
    const looseBlockMath = isLooseBracketMathLine(blockMathStart)
      || (!blockMathStart.startsWith("\\[")
        && blockMathStart.startsWith("[")
        && blockMathStart.endsWith("\\]")
        && /\\(?:frac|sqrt|quad|sin|cos|tan|ln|log|pi|theta|alpha|beta|gamma|Delta)|[_^=+\-]/.test(blockMathStart));
    if (blockMathStart.startsWith("$$") || blockMathStart.startsWith("\\[") || looseBlockMath) {
      flushParagraph();
      flushList();
      flushQuote();
      const close = blockMathStart.startsWith("$$")
        ? "$$"
        : (looseBlockMath && blockMathStart.endsWith("]") && !blockMathStart.endsWith("\\]") ? "]" : "\\]");
      const openLength = looseBlockMath ? 1 : close.length;
      let math = blockMathStart.slice(openLength).trim();
      if (math.endsWith(close)) {
        math = math.slice(0, -close.length).trim();
      } else {
        index += 1;
        while (index < lines.length && !lines[index].trim().endsWith(close)) {
          math += `\n${lines[index]}`;
          index += 1;
        }
        if (index < lines.length) {
          math += `\n${lines[index].trim().slice(0, -close.length).trim()}`;
        }
      }
      html.push(renderBlockMath(math));
      continue;
    }

    const tableRun = [];
    if (line.includes("|") && lines[index + 1] && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1])) {
      flushParagraph();
      flushList();
      flushQuote();
      tableRun.push(line, lines[index + 1]);
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableRun.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html.push(renderMarkdownTable(tableRun));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushQuote();
      continue;
    }

    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push("<hr>");
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushQuote();
      html.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }

    const quoted = line.match(/^>\s?(.+)$/);
    if (quoted) {
      flushParagraph();
      flushList();
      quote.push(quoted[1]);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.type !== "ul") flushList();
      if (!list) list = { type: "ul", items: [] };
      list.items.push(unordered[1]);
      continue;
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.type !== "ol") flushList();
      if (!list) list = { type: "ol", start: Number(ordered[1]), items: [] };
      list.items.push(ordered[2]);
      continue;
    }

    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }

  if (code) html.push(renderCodeBlock(code));
  flushParagraph();
  flushList();
  flushQuote();
  return html.join("");
}

function normalizeReasoningMath(text) {
  const source = String(text || "");
  const functionWords = new Set(["ln", "sin", "cos", "tan", "log"]);
  const commandWords = [
    "frac", "dfrac", "tfrac", "sqrt", "left", "right", "cdot", "times",
    "leq", "geq", "neq", "pm", "pi", "theta", "alpha", "beta", "gamma", "delta"
  ];
  const isCjk = ch => /[\u4e00-\u9fff]/.test(ch);
  const isMathOp = ch => /[=<>+\-*/^_\u221a\u221b\u00b7\u00d7\u00f7\u2264\u2265\u2248\u2260\u2032'?]/.test(ch);
  const isBoundary = ch => !ch || /[\s,???;:?!???)]/.test(ch);
  const startsSpan = (line, index) => {
    const ch = line[index];
    if (!ch) return false;
    if ((ch === "*" || ch === "_") && (line[index - 1] === ch || line[index + 1] === ch)) return false;
    if (/[0-9]/.test(ch)) return true;
    if ("([{^_=<>+-*/\\\u221a\u221b\u00b7\u00d7\u00f7".includes(ch)) return true;
    if (/[A-Za-z]/.test(ch)) {
      const prev = line[index - 1] || "";
      if (/[A-Za-z0-9_\u2032'?]/.test(prev)) return false;
      const word = (line.slice(index).match(/^[A-Za-z]+/) || [""])[0].toLowerCase();
      if (!word) return false;
      if (word === "sqrt") {
        const next = line[index + word.length] || "";
        return /[A-Za-z0-9({]/.test(next);
      }
      if (word.length === 1 || functionWords.has(word) || /^[A-Z]{1,3}$/.test(word)) {
        const next = line[index + word.length] || "";
        return isBoundary(next) || isMathOp(next) || next === "\\";
      }
    }
    return false;
  };
  const wrapLine = line => {
    if (/\\\(|\\\[|\$\$?/.test(line)) return line;
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) return line;
    let out = "";
    let i = 0;
    while (i < line.length) {
      if (startsSpan(line, i)) {
        let j = i;
        let paren = 0;
        let bracket = 0;
        let brace = 0;
        let sawMath = false;
        while (j < line.length) {
          const ch = line[j];
          if (isCjk(ch)) break;
          if (/[，,。；;：:!?！？]/.test(ch) && paren === 0 && bracket === 0 && brace === 0 && sawMath) {
            break;
          }
          if (ch === "\\") {
            const tail = line.slice(j + 1);
            const cmd = tail.match(/^[A-Za-z]+/)?.[0] || "";
            if (!cmd) break;
            sawMath = true;
            j += 1 + cmd.length;
            continue;
          }
          if (/[A-Za-z]/.test(ch)) {
            const word = (line.slice(j).match(/^[A-Za-z]+/) || [""])[0].toLowerCase();
            if (commandWords.includes(word) || functionWords.has(word)) {
              sawMath = true;
              j += word.length;
              continue;
            }
          }
          if (ch === "(") paren += 1;
          else if (ch === ")") {
            if (paren === 0 && bracket === 0 && brace === 0 && sawMath) break;
            paren = Math.max(0, paren - 1);
          } else if (ch === "[") bracket += 1;
          else if (ch === "]") {
            if (paren === 0 && bracket === 0 && brace === 0 && sawMath) break;
            bracket = Math.max(0, bracket - 1);
          } else if (ch === "{") brace += 1;
          else if (ch === "}") {
            if (paren === 0 && bracket === 0 && brace === 0 && sawMath) break;
            brace = Math.max(0, brace - 1);
          } else if (isMathOp(ch) || /[\u2070\u00b9\u00b2\u00b3\u2074-\u2079]/.test(ch)) {
            sawMath = true;
          } else if (!/[A-Za-z0-9_\s.,]/.test(ch)) {
            break;
          }
          j += 1;
        }
        const span = line.slice(i, j).trim();
        if (span && sawMath) {
          out += `\\(${span}\\)`;
          i = j;
          continue;
        }
      }
      out += line[i];
      i += 1;
    }
    return out;
  };
  return source.split("\n").map(wrapLine).join("\n");
}

function normalizeReasoningFractions(text) {
  const normalizeMath = math => {
    let output = String(math || "").replace(
      /([0-9]+(?:\.[0-9]+)?)\s*sqrt\s*(\([^)]+\)|\{[^}]+\}|[A-Za-z0-9.]+)/g,
      (_, coefficient, body) => {
        const value = body.startsWith("(") || body.startsWith("{") ? body.slice(1, -1) : body;
        return `${coefficient}\\sqrt{${value}}`;
      }
    );
    output = normalizeMathSourceForTex(output);
    const variable = String.raw`[A-Za-z][A-Za-z0-9]*(?:['′])?(?:\^[A-Za-z0-9{}]+)?`;
    const functionAtom = String.raw`(?:sin|cos|tan|ln|log)\s+${variable}`;
    const commandAtom = String.raw`\\[A-Za-z]+(?:\[[^\]]+\])?(?:\{[^{}]+\})?(?:\s+${variable})?`;
    const numberAtom = String.raw`[0-9]+(?:\.[0-9]+)?`;
    const coefficientAtom = String.raw`${numberAtom}\s*(?:${commandAtom}|${functionAtom})`;
    const atom = String.raw`(?:${coefficientAtom}|${commandAtom}|${functionAtom}|${variable}|${numberAtom})`;
    output = output.replace(
      new RegExp(String.raw`\(([^()]+?)\)\s*/\s*(${atom})`, "g"),
      (_, numerator, denominator) => `\\frac{${numerator.trim()}}{${denominator.trim()}}`
    );
    output = output.replace(
      new RegExp(String.raw`(${atom})\s*/\s*\(([^()]+?)\)`, "g"),
      (_, numerator, denominator) => `\\frac{${numerator.trim()}}{${denominator.trim()}}`
    );
    output = output.replace(
      new RegExp(String.raw`(${atom})\s*/\s*(${atom})`, "g"),
      (_, numerator, denominator) => `\\frac{${numerator.trim()}}{${denominator.trim()}}`
    );
    return output;
  };
  return String(text || "")
    .replace(/\\\((.+?)\\\)/g, (_, math) => `\\(${normalizeMath(math)}\\)`)
    .replace(/\$(?!\$)([^$\n]+?)\$/g, (_, math) => `$${normalizeMath(math)}$`);
}

function renderReasoningMarkdown(text) {
  const normalized = String(text || "").replace(/\|\s*\|/g, "|\n|");
  return renderMarkdown(normalizeReasoningFractions(normalizeReasoningMath(normalized)));
}

function hashText(text) {
  const value = String(text || "");
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cachedMarkdown(keyParts, text, renderer = renderMarkdown) {
  const value = String(text || "");
  const mathMode = hasMathJaxRenderer() ? "mathjax" : (window.katex ? "katex" : "fallback");
  const key = `${mathMode}:${keyParts.join(":")}:${value.length}:${hashText(value)}`;
  if (state.markdownCache.has(key)) return state.markdownCache.get(key);
  const html = renderer(value);
  state.markdownCache.set(key, html);
  if (state.markdownCache.size > 240) {
    state.markdownCache.delete(state.markdownCache.keys().next().value);
  }
  return html;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function setKeyState(ok) {
  const el = $("#keyState");
  el.className = `key-state ${ok ? "ok" : "bad"}`;
  el.textContent = ok ? "密钥已读取" : "密钥未配置";
  if (!ok) {
    setBalanceDisplay(null, false);
  }
}

function nowText() {
  const date = new Date();
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

function currencyLabel(currency) {
  if (currency === "CNY") return "￥";
  if (currency === "USD") return "$";
  return currency ? `${currency} ` : "";
}

function getPrimaryBalance(balance) {
  const infos = Array.isArray(balance?.balance_infos) ? balance.balance_infos : [];
  return infos[0] || null;
}

function setBalanceDisplay(balance, available) {
  const card = $("#balanceCard");
  const amount = $("#balanceAmount");
  const updated = $("#balanceUpdated");
  if (!card || !amount || !updated) return;
  card.classList.toggle("ok", Boolean(balance && available));
  card.classList.toggle("bad", Boolean(balance && !available));
  if (!balance) {
    amount.textContent = state.config?.keyConfigured ? "未知" : "未配置";
    updated.textContent = state.config?.keyConfigured ? "余额读取失败" : "请先填写密钥";
    return;
  }
  const primary = getPrimaryBalance(balance);
  if (!primary) {
    amount.textContent = "未知";
    updated.textContent = `已刷新 ${nowText()}`;
    return;
  }
  const value = Number(primary.total_balance || 0);
  const nextText = `${currencyLabel(primary.currency)}${value.toFixed(2)}`;
  if (amount.textContent && amount.textContent !== "读取中" && amount.textContent !== nextText) {
    card.classList.remove("changed");
    requestAnimationFrame(() => card.classList.add("changed"));
  }
  amount.textContent = nextText;
  updated.textContent = `${available ? "额度可用" : "额度不可用"} · ${nowText()} 自动刷新`;
}

function updateBalanceState(balance) {
  state.balance = balance;
  const el = $("#keyState");
  if (!state.config?.keyConfigured) {
    setKeyState(false);
    return;
  }
  if (!balance) {
    el.className = "key-state ok";
    el.textContent = "密钥已读取";
    setBalanceDisplay(null, true);
    return;
  }
  const infos = Array.isArray(balance.balance_infos) ? balance.balance_infos : [];
  const currencyName = item => item.currency === "CNY" ? "人民币" : (item.currency || "");
  const summary = infos.map(item => `${currencyName(item)} ${item.total_balance || "0"}`).join("，") || "余额未知";
  setBalanceDisplay(balance, balance.is_available !== false);
  if (balance.is_available === false) {
    el.className = "key-state bad";
    el.textContent = `密钥已读取，但余额不足或账户不可用`;
  } else {
    el.className = "key-state ok";
    el.textContent = `密钥已读取，余额可用：${summary}`;
  }
}

async function refreshBalance({ showResult = false } = {}) {
  if (!state.config?.keyConfigured) {
    setKeyState(false);
    return null;
  }
  const balance = await api("/api/balance");
  updateBalanceState(balance);
  if (showResult) {
    const infos = Array.isArray(balance.balance_infos) ? balance.balance_infos : [];
    const currencyName = item => item.currency === "CNY" ? "人民币" : (item.currency || "");
    const summary = infos.map(item => `${currencyName(item)} ${item.total_balance || "0"}`).join("，") || "余额未知";
    $("#apiResult").textContent = balance.is_available === false
      ? `账户额度不可用或余额不足。\n当前余额：${summary}\n\n原始返回：\n${pretty(balance)}`
      : `账户额度可用。\n当前余额：${summary}\n\n原始返回：\n${pretty(balance)}`;
  }
  return balance;
}

function getKeyVisiblePreference() {
  return localStorage.getItem(keyVisibleStorageKey) === "true";
}

function setKeyVisiblePreference(visible) {
  localStorage.setItem(keyVisibleStorageKey, visible ? "true" : "false");
}

function applyKeyVisibility(visible) {
  const input = $("#keyInput");
  const toggle = $("#keyVisibilityToggle");
  if (!input || !toggle) return;
  input.type = visible ? "text" : "password";
  toggle.textContent = visible ? "隐藏" : "显示";
  toggle.classList.toggle("active", visible);
  toggle.classList.toggle("reveal-warning", !visible);
}

function setKeyModalStatus(message = "", kind = "") {
  const status = $("#keyModalStatus");
  if (!status) return;
  status.textContent = message;
  status.className = `key-modal-status ${kind}`.trim();
}

function closeKeyModal() {
  const overlay = $("#keyOverlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  window.onkeydown = null;
}

async function openKeyModal() {
  const overlay = $("#keyOverlay");
  const input = $("#keyInput");
  const saveButton = $("#keySave");
  if (!overlay || !input || !saveButton) return;
  applyKeyVisibility(getKeyVisiblePreference());
  input.value = "";
  saveButton.disabled = false;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  setKeyModalStatus("正在读取当前密钥...", "info");
  try {
    const result = await api("/api/key");
    input.value = result.apiKey || "";
    setKeyModalStatus(result.keyConfigured ? "当前密钥已读取，可直接修改后保存；留空保存可清除密钥。" : "当前未配置密钥，请输入后保存。", result.keyConfigured ? "ok" : "info");
    input.focus();
    input.select();
  } catch (error) {
    setKeyModalStatus(`读取密钥失败：${error.message}`, "bad");
    input.focus();
  }
  window.onkeydown = event => {
    if (event.key === "Escape") closeKeyModal();
  };
}

async function saveKeyFromModal() {
  const input = $("#keyInput");
  const saveButton = $("#keySave");
  const cancelButton = $("#keyCancel");
  const apiKey = (input?.value || "").trim();
  saveButton.disabled = true;
  cancelButton.disabled = true;
  setKeyModalStatus(apiKey ? "正在校验密钥..." : "正在清除密钥...", "info");
  try {
    const result = await api("/api/key", {
      method: "POST",
      body: JSON.stringify({ apiKey })
    });
    state.config = {
      ...(state.config || {}),
      keyConfigured: Boolean(result.keyConfigured)
    };
    if (result.keyConfigured) {
      setKeyState(true);
      if (result.balance) updateBalanceState(result.balance);
      else refreshBalance().catch(() => updateBalanceState(null));
      setKeyModalStatus("密钥校验通过，已保存。", "ok");
    } else {
      setKeyState(false);
      updateBalanceState(null);
      setKeyModalStatus("密钥已清除，当前为未配置状态。", "ok");
    }
    closeKeyModal();
  } catch (error) {
    setKeyModalStatus(error.message || "密钥不正确，请检查后重新输入。", "bad");
    input?.focus();
  } finally {
    saveButton.disabled = false;
    cancelButton.disabled = false;
  }
}

function groupName(group) {
  if (group === "official") return "官方当前可用模型";
  return "其他模型";
}

function statusLabel(status) {
  if (status === "current") return "可用";
  return "不可用";
}

function modelShortLabel(model) {
  const label = model.label || model.id || "";
  if (/v4[-\s]?pro/i.test(label) || /v4[-\s]?pro/i.test(model.id || "")) return "DeepSeek V4 Pro";
  if (/v4[-\s]?flash/i.test(label) || /v4[-\s]?flash/i.test(model.id || "")) return "DeepSeek V4 Flash";
  return label.replace(/^深度求索\s*/, "DeepSeek ") || model.id;
}

function renderModels() {
  const select = $("#model");
  select.innerHTML = "";
  const groups = ["official", "legacy", "open"];
  for (const group of groups) {
    const list = state.models.filter(model => model.group === group);
    if (!list.length) continue;
    for (const model of list) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = modelShortLabel(model);
      option.title = `${model.id} · ${statusLabel(model.status)}${model.note ? ` · ${model.note}` : ""}`;
      option.dataset.note = model.note || "";
      option.dataset.status = model.status || "";
      select.appendChild(option);
    }
  }
  select.value = state.config?.defaultModel || "deepseek-v4-pro";
  updateModelHint();
}

function selectedModelInfo() {
  const id = $("#model").value || "deepseek-v4-pro";
  return state.models.find(model => model.id === id) || {
    id,
    label: id,
    status: "unknown",
    note: "未知模型。"
  };
}

function currentModelId() {
  return selectedModelInfo().id;
}

function updateModelHint() {
  const info = selectedModelInfo();
  const modelSelect = $("#model");
  if (modelSelect) modelSelect.title = `${info.label || info.id}：${info.note || ""}`;
  const badge = $("#modelBadge");
  if (badge) {
    badge.textContent = info.status === "current" ? info.label.replace("深度求索 ", "") : statusLabel(info.status);
    badge.title = `${info.id} ${info.note || ""}`;
  }
}

function renderSessions() {
  const wrap = $("#sessions");
  wrap.innerHTML = "";
  const keyword = ($("#sessionSearch")?.value || "").trim().toLowerCase();
  const sessions = state.sessions.filter(session => {
    if (!keyword) return true;
    return `${session.title || ""} ${session.model || ""}`.toLowerCase().includes(keyword);
  });
  for (const session of sessions) {
    const item = document.createElement("div");
    item.className = `session ${state.current?.id === session.id ? "active" : ""}`;
    item.innerHTML = `
      <div class="session-top">
        <strong>${escapeHtml(session.title || "新对话")}</strong>
        <button class="delete-session" title="删除会话">×</button>
      </div>
      <span>${session.messageCount} 条消息 · ${escapeHtml(session.model || "")}</span>
    `;
    item.onclick = event => {
      if (event.target.closest(".delete-session")) return;
      loadSession(session.id);
    };
    item.querySelector(".delete-session").onclick = async event => {
      event.stopPropagation();
      const ok = await showConfirm({
        title: "删除这个会话？",
        text: `“${session.title || "新对话"}”会从本地会话列表中移除，此操作不可撤销。`,
        okText: "确认删除"
      });
      if (!ok) return;
      await api(`/api/sessions/${session.id}`, { method: "DELETE" });
      if (state.current?.id === session.id) state.current = null;
      await refreshSessions();
      if (!state.current && state.sessions[0]) await loadSession(state.sessions[0].id);
      if (!state.current) await newSession();
    };
    wrap.appendChild(item);
  }
}

function usageNumber(usage, keys) {
  if (!usage) return 0;
  for (const key of keys) {
    const value = Number(key.split(".").reduce((value, part) => value?.[part], usage));
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function modelPricing(model) {
  if (model === "deepseek-v4-flash") {
    return { cacheHit: 0.0028, cacheMiss: 0.14, output: 0.28 };
  }
  return { cacheHit: 0.003625, cacheMiss: 0.435, output: 0.87 };
}

function estimateMessageCost(message, input, output, hit) {
  if (message.cost?.cny) return Number(message.cost.cny);
  const usage = message.usage;
  if (!usage) return 0;
  const pricing = modelPricing(message.model || state.current?.model || currentModelId());
  const miss = usageNumber(usage, ["prompt_cache_miss_tokens", "cache_creation_input_tokens"]) || Math.max(0, input - hit);
  const usd = (hit * pricing.cacheHit + miss * pricing.cacheMiss + output * pricing.output) / 1000000;
  return Number.isFinite(usd) && usd > 0 ? usd * 7.2 : 0;
}

function usageMeta(message) {
  const usage = message.usage;
  if (!usage) return "";
  const input = usageNumber(usage, ["prompt_tokens", "input_tokens"]);
  const output = usageNumber(usage, ["completion_tokens", "output_tokens"]);
  const reasoning = usageNumber(usage, [
    "reasoning_tokens",
    "reasoning_output_tokens",
    "completion_tokens_details.reasoning_tokens",
    "output_tokens_details.reasoning_tokens"
  ]);
  const hit = usageNumber(usage, ["prompt_cache_hit_tokens", "cache_read_input_tokens"]);
  const parts = [];
  const total = usageNumber(usage, ["total_tokens"]) || input + output;
  if (total) parts.push(`耗用 ${total.toLocaleString()} tokens`);
  parts.push(`推理 ${reasoning.toLocaleString()}`);
  parts.push(`缓存命中 ${hit.toLocaleString()}`);
  const cost = estimateMessageCost(message, input, output, hit);
  if (cost) parts.push(`约 ￥${cost.toFixed(4)}`);
  return parts.join(" · ");
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderCitations(citations) {
  if (!Array.isArray(citations) || !citations.length) return "";
  const unique = uniqueCitations(citations);
  if (!unique.length) return "";
  return `
    <details class="citations">
      <summary>引用来源 ${unique.length} 条</summary>
      <div class="citation-list">
        ${unique.map((item, index) => `
          <a class="citation-card" href="${escapeHtml(item.url || "#")}" target="_blank" rel="noreferrer">
            <span>${index + 1}</span>
            <strong>${escapeHtml(item.title || item.url || "来源")}</strong>
            <em>${escapeHtml(hostFromUrl(item.url) || item.url || "来源")}</em>
          </a>
        `).join("")}
      </div>
    </details>
  `;
}

function uniqueCitations(citations) {
  const unique = [];
  const seen = new Set();
  for (const citation of citations || []) {
    const key = citation?.url || citation?.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(citation);
  }
  return unique;
}

function citationsFromSearchEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .flatMap(event => Array.isArray(event?.results) ? event.results : [])
    .filter(item => item && (item.url || item.title))
    .map(item => ({
      title: item.title || item.url || "来源",
      url: item.url || ""
    }));
}

function citationsForMessage(message) {
  return uniqueCitations([
    ...(Array.isArray(message?.citations) ? message.citations : []),
    ...citationsFromSearchEvents(message?.searchEvents)
  ]);
}

function displaySearchEventText(event, message) {
  if (!event) return "联网搜索";
  const count = citationsForMessage(message).length;
  const events = Array.isArray(message?.searchEvents) ? message.searchEvents : [];
  const hasResolvedSearch = events.some(item => item.status === "results" || item.status === "error" || item.status === "done")
    || Boolean(message?.usage || message?.interrupted || message?.error || String(message?.content || "").trim());
  if (!count && hasResolvedSearch) return "未返回可展示来源";
  if (event.status === "results" || event.status === "done") {
    return count ? `已读取 ${count} 个来源` : "未返回可展示来源";
  }
  if (event.status === "starting" && /准备联网搜索/.test(event.text || "")) {
    return "联网搜索已开启";
  }
  return event.text || "联网搜索";
}

function searchQueriesForMessage(message) {
  const queries = [];
  const pushQuery = value => {
    const query = String(value || "").trim();
    if (query && !queries.includes(query)) queries.push(query);
  };
  for (const event of message?.searchEvents || []) {
    pushQuery(event?.input?.query);
  }
  for (const block of message?.anthropicContent || []) {
    pushQuery(block?.input?.query);
    if (block?.partial_json) {
      try {
        pushQuery(JSON.parse(block.partial_json)?.query);
      } catch {
        // Ignore partial tool input that is not complete JSON.
      }
    }
  }
  return queries;
}

function renderSearchSources(message) {
  const citations = citationsForMessage(message);
  if (citations.length) return renderCitations(citations);
  const events = Array.isArray(message?.searchEvents) ? message.searchEvents : [];
  const hasSearchContext = Boolean(message?.searchUsed || events.length);
  if (!hasSearchContext) return "";
  const hasSearchResultEvent = events.some(event => event.status === "results" || event.status === "error" || event.status === "done");
  const canShowEmpty = Boolean(message?.interrupted || message?.usage || message?.error || hasSearchResultEvent);
  if (!canShowEmpty) return "";
  const queries = searchQueriesForMessage(message);
  return `
    <div class="citations citations-empty">
      <div class="citations-empty-title">未返回可展示来源</div>
      <p>本轮已开启联网搜索，但搜索接口没有返回可列出的网页来源。</p>
      ${queries.length ? `
        <div class="search-query-list">
          ${queries.map(query => `<span>${escapeHtml(query)}</span>`).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderSearchEvents(events, message = null) {
  if (!Array.isArray(events) || !events.length) return "";
  const latest = events[events.length - 1];
  const citationCount = citationsForMessage(message).length;
  const hasResolvedSearch = events.some(event => event.status === "results" || event.status === "done" || event.status === "error")
    || Boolean(message?.usage || message?.interrupted || message?.error || String(message?.content || "").trim());
  const done = events.some(event => event.status === "results" || event.status === "done" || event.status === "error")
    || citationCount > 0;
  const empty = hasResolvedSearch && citationCount === 0 && latest?.status !== "error";
  const text = displaySearchEventText(latest, message);
  return `
    <div class="search-status ${done ? "done" : ""} ${empty ? "empty" : ""} ${latest?.status === "error" ? "error" : ""}">
      <span class="search-pulse"></span>
      <strong>${escapeHtml(text)}</strong>
    </div>
  `;
}

function renderMessageMeta(message) {
  const meta = usageMeta(message);
  const parts = [];
  if (message.error) parts.push("<span>接口错误</span>");
  if (message.searchUsed) parts.push("<span>联网搜索已开启</span>");
  if (message.interrupted) {
    parts.push("<span>已停止</span>");
  }
  if (meta) {
    parts.push(`<span>${escapeHtml(meta)}</span>`);
  } else if (message.searchUsed || message.interrupted || message.error) {
    parts.push("<span>未收到精确 token 用量</span>");
  }
  return parts.length ? `<div class="message-meta">${parts.join("")}</div>` : "";
}

function renderMessageActions(message) {
  if (message.role !== "assistant" || !String(message.content || "").trim()) return "";
  return `
    <div class="message-actions-row">
      <button class="icon-action copy-message" type="button" title="复制本条回复全文">
        <span class="copy-icon" aria-hidden="true"></span>
        <span>复制全文</span>
      </button>
    </div>
  `;
}

function displayContentForMessage(message) {
  let value = message.displayContent ?? message.content ?? "";
  if (message.role === "assistant" && message.interrupted) {
    value = cleanInterruptedContent(value);
  }
  if (message.role === "assistant" && String(value).length && !String(value).trim()) {
    return "调用完成，但模型返回了空白内容。JSON 输出通常需要明确字段结构；请指定需要的 JSON 字段后重试，或切回普通回答。";
  }
  return value;
}

function cleanInterruptedContent(text) {
  let value = String(text || "");
  const dollarBlocks = value.match(/\$\$/g) || [];
  if (dollarBlocks.length % 2 === 1) {
    value = value.slice(0, value.lastIndexOf("$$")).trimEnd();
  }
  const trimFromUnclosed = (open, close) => {
    const openIndex = value.lastIndexOf(open);
    if (openIndex < 0) return;
    const closeIndex = value.lastIndexOf(close);
    if (closeIndex < openIndex) value = value.slice(0, openIndex).trimEnd();
  };
  trimFromUnclosed("\\[", "\\]");
  trimFromUnclosed("\\(", "\\)");
  return value.trim() ? value : "已停止生成。";
}

function messageNode(message, index = -1, { animate = false } = {}) {
  const row = document.createElement("div");
  row.className = `message ${message.role}${animate ? "" : " no-enter-animation"}`;
  row.dataset.messageIndex = String(index);
  const avatar = message.role === "user"
    ? "我"
    : assistantAvatar;
  const canShowReasoning = message.thinkingUsed === true || (!message.searchUsed && message.thinkingUsed !== false);
  const cacheBase = [state.current?.id || "session", index, message.role, message.createdAt || ""];
  const reasoning = message.reasoning && canShowReasoning ? `<div class="reasoning markdown-body">${cachedMarkdown([...cacheBase, "reasoning"], message.reasoning, renderReasoningMarkdown)}</div>` : "";
  const displayText = displayContentForMessage(message);
  const files = Array.isArray(message.attachments) && message.attachments.length
    ? `<div class="message-files">${message.attachments.map(file => `
        <div class="message-file" title="${escapeHtml(`${file.name || "附件"} · ${file.meta || ""}`)}">
          <span class="file-icon">文</span>
          <span class="file-copy">
            <strong>${escapeHtml(file.name || "附件")}</strong>
            <em>${escapeHtml(file.meta || "")}</em>
          </span>
        </div>
      `).join("")}</div>`
    : "";
  const search = message.role === "assistant" ? renderSearchEvents(message.searchEvents, message) : "";
  const citations = message.role === "assistant" ? renderSearchSources(message) : "";
  const meta = message.role === "assistant" ? renderMessageMeta(message) : "";
  const actions = renderMessageActions(message);
  row.innerHTML = `
    <div class="avatar">${avatar}</div>
    <div class="bubble">${search}${reasoning}<div class="content markdown-body">${cachedMarkdown([...cacheBase, "content"], displayText)}</div>${files}${citations}${meta}${actions}</div>
  `;
  return row;
}

function renderMessages({ stickToBottom = true } = {}) {
  const wrap = $("#messages");
  const previousScrollTop = wrap.scrollTop;
  const renderToken = ++state.messageRenderToken;
  state.historyRender = null;
  wrap.innerHTML = "";
  if (!state.current || state.current.messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "message assistant";
    empty.innerHTML = `<div class="avatar">${assistantAvatar}</div><div class="bubble"><div class="content markdown-body">${renderMarkdown("点击左下角“密钥”配置 DeepSeek API Key，校验通过后就可以像网页端一样直接聊。左侧会自动保存上下文，输入框下方只显示官方接口当前确认可用的模型。")}</div></div>`;
    wrap.appendChild(empty);
    scheduleMathTypeset(wrap, false, stickToBottom);
    scheduleMermaidRender(wrap);
  } else if (state.current.messages.length <= 24) {
    const fragment = document.createDocumentFragment();
    state.current.messages.forEach((message, index) => fragment.appendChild(messageNode(message, index)));
    wrap.appendChild(fragment);
    scheduleMathTypeset(wrap, false, stickToBottom);
    scheduleMermaidRender(wrap);
  } else {
    const messages = [...state.current.messages];
    const tailSize = 18;
    let firstRenderedIndex = Math.max(0, messages.length - tailSize);
    const fragment = document.createDocumentFragment();
    for (let index = firstRenderedIndex; index < messages.length; index += 1) {
      fragment.appendChild(messageNode(messages[index], index));
    }
    wrap.appendChild(fragment);
    scheduleMathTypeset(wrap, false, stickToBottom);
    scheduleMermaidRender(wrap);
    if (stickToBottom) {
      scrollMessagesToBottom(true);
    } else {
      wrap.scrollTop = previousScrollTop;
      state.autoScrollMessages = false;
    }

    if (firstRenderedIndex > 0) {
      state.historyRender = {
        token: renderToken,
        messages,
        firstRenderedIndex,
        busy: false
      };
    }
    return;
  }
  if (stickToBottom) {
    scrollMessagesToBottom(true);
  } else {
    wrap.scrollTop = previousScrollTop;
    state.autoScrollMessages = false;
  }
}

function syncControlsFromSession() {
  const session = state.current;
  if (!session) return;
  state.isSyncingControls = true;
  try {
    $("#sessionTitle").textContent = session.title || "新对话";
    const known = state.models.some(model => model.id === session.model);
    if (known) {
      $("#model").value = session.model;
    } else {
      $("#model").value = state.config?.defaultModel || "deepseek-v4-pro";
    }
    $("#systemPrompt").value = (session.system || "").replace("本地 API 控制台", "本地接口控制台");
    $("#temperature").value = session.params?.temperature ?? 0.6;
    $("#tempValue").textContent = $("#temperature").value;
    $("#maxTokens").value = session.params?.max_tokens ?? 4096;
    $("#topP").value = session.params?.top_p ?? 1;
    $("#topPValue").textContent = $("#topP").value;
    $("#stopWords").value = Array.isArray(session.params?.stop) ? session.params.stop.join("，") : "";
    $("#userId").value = session.params?.user || "";
    $("#thinking").value = session.params?.thinking ?? "disabled";
    $("#effort").value = session.params?.reasoning_effort ?? "high";
    $("#searchMode").value = session.params?.search ?? "disabled";
    $("#outputMode").value = session.params?.output_mode ?? "normal";
    $("#fileMode").value = session.params?.file_mode ?? "attachment";
    updateModelHint();
    updateThinkingVisual();
    updateSearchVisual();
    updateOutputModeVisual();
    updateFileModeVisual();
  } finally {
    state.isSyncingControls = false;
  }
}

async function refreshSessions() {
  state.sessions = await api("/api/sessions");
  renderSessions();
}

async function loadSession(id, { stickToBottom = true } = {}) {
  state.current = await api(`/api/sessions/${id}`);
  syncControlsFromSession();
  renderSessions();
  renderMessages({ stickToBottom });
}

async function newSession() {
  state.current = await api("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ title: "新对话" })
  });
  await refreshSessions();
  syncControlsFromSession();
  renderMessages();
}

function currentParams() {
  const stop = $("#stopWords").value
    .split(/[，,]/)
    .map(item => item.trim())
    .filter(Boolean);
  const maxTokens = Number($("#maxTokens").value);
  const thinking = $("#thinking").value;
  const effort = $("#effort").value;
  return {
    temperature: Number($("#temperature").value),
    max_tokens: Number.isFinite(maxTokens) && maxTokens >= 1 ? Math.floor(maxTokens) : (state.current?.params?.max_tokens || 4096),
    top_p: Number($("#topP").value),
    stop,
    user: $("#userId").value.trim(),
    thinking,
    reasoning_effort: effort === "off" ? (state.current?.params?.reasoning_effort || "high") : effort,
    search: $("#searchMode")?.value || "disabled",
    output_mode: $("#outputMode")?.value || "normal",
    file_mode: $("#fileMode")?.value || "attachment"
  };
}

function updateThinkingVisual() {
  const thinking = $("#thinking");
  const effort = $("#effort");
  const offOption = effort?.querySelector?.('option[value="off"]');
  const toggle = $("#thinkingToggle");
  const composer = document.querySelector(".composer");
  if (!thinking || !effort || !composer) return;
  const enabled = thinking.value === "enabled";
  if (offOption) {
    offOption.hidden = enabled;
    offOption.disabled = enabled;
  }
  if (enabled && effort.value === "off") {
    effort.value = state.current?.params?.reasoning_effort || "high";
  }
  if (!enabled) {
    if (offOption) {
      offOption.hidden = false;
      offOption.disabled = false;
    }
    effort.value = "off";
  }
  thinking.classList.toggle("thinking-enabled", enabled);
  thinking.classList.toggle("thinking-disabled", !enabled);
  thinking.title = enabled ? "深度思考已开启，会产生推理内容并可能增加消耗" : "快速模式，默认不生成推理过程";
  if (toggle) {
    toggle.classList.toggle("thinking-enabled", enabled);
    toggle.classList.toggle("thinking-disabled", !enabled);
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.title = thinking.title;
    toggle.querySelector(".thinking-main").textContent = enabled ? "深度思考" : "快速模式";
    toggle.querySelector(".thinking-sub").textContent = enabled ? "增耗" : "默认";
  }
  const badge = $("#modelBadge");
  if (badge) {
    badge.classList.toggle("deep-thinking", enabled);
    badge.title = enabled
      ? `${badge.textContent} · 深度思考已开启，可能增加消耗`
      : `${badge.textContent} · 快速模式`;
  }
  composer.classList.toggle("thinking-is-enabled", enabled);
  effort.disabled = !enabled;
  effort.title = enabled ? "深度思考已开启，可调整推理强度" : "快速模式不支持推理；开启深度思考后可调整推理强度";
}

function updateSearchVisual() {
  const mode = $("#searchMode");
  const toggle = $("#searchToggle");
  const composer = document.querySelector(".composer");
  if (!mode || !toggle) return;
  const enabled = mode.value === "enabled";
  toggle.classList.toggle("search-enabled", enabled);
  toggle.classList.toggle("search-disabled", !enabled);
  toggle.setAttribute("aria-pressed", String(enabled));
  toggle.querySelector(".search-main").textContent = "联网搜索";
  toggle.querySelector(".search-sub").textContent = enabled ? "开启" : "关闭";
  toggle.title = enabled
    ? "本轮会在需要时联网搜索，会增加消耗"
    : "联网搜索已关闭，本轮只使用当前会话上下文";
  composer?.classList.toggle("search-is-enabled", enabled);
}

function outputModeLabel(mode) {
  return {
    normal: "普通回答",
    table: "表格整理",
    json: "JSON 输出",
    steps: "步骤解析"
  }[mode] || "普通回答";
}

function updateOutputModeVisual() {
  const select = $("#outputMode");
  const button = $("#outputModeButton");
  if (!select || !button) return;
  const mode = select.value || "normal";
  button.textContent = outputModeLabel(mode);
  button.classList.toggle("is-structured", mode !== "normal");
  button.title = mode === "normal" ? "普通自然语言回答" : `本轮使用${outputModeLabel(mode)}`;
  document.querySelectorAll("#outputModeMenu button").forEach(item => {
    item.classList.toggle("active", item.dataset.mode === mode);
  });
}

function updateFileModeVisual() {
  const select = $("#fileMode");
  const button = $("#fileModeToggle");
  const hint = $("#fileModeHint");
  if (!select || !button) return;
  const plain = select.value === "plain";
  button.textContent = plain ? "直接并入消息" : "按文件阅读";
  button.classList.toggle("file-plain", plain);
  button.title = plain
    ? "文件内容会直接拼到本轮消息后面"
    : "文件会保留文件名，让 AI 按附件理解";
  if (hint) {
    hint.textContent = plain
      ? "文件内容会直接拼进本轮消息，适合当普通文本续写。"
      : "文件会保留文件名，让 AI 按附件理解。";
  }
}

function currentSessionSettingsPayload() {
  return {
    model: currentModelId(),
    system: $("#systemPrompt").value,
    params: {
      ...(state.current?.params || {}),
      ...currentParams()
    }
  };
}

function updateSessionSettingsLocal(sessionId, payload, updatedSession = null) {
  const next = updatedSession || payload;
  if (state.current?.id === sessionId) {
    state.current = { ...state.current, ...next };
  }
  const index = state.sessions.findIndex(session => session.id === sessionId);
  if (index >= 0) {
    state.sessions[index] = { ...state.sessions[index], ...next };
    renderSessions();
  }
}

async function resetCurrentSessionSettings() {
  if (!state.current) return;
  const ok = await showConfirm({
    title: "恢复默认参数？",
    text: "将把当前会话的模型、系统提示词、温度、最大输出长度、核采样、停止词、用户标识、思考模式、联网搜索、输出方式和文件阅读方式恢复为默认值；聊天记录不会被删除。",
    okText: "恢复默认",
    okClass: "primary confirm-primary"
  });
  if (!ok) return;
  const payload = {
    model: state.config?.defaultModel || "deepseek-v4-pro",
    system: defaultSessionSettings.system,
    params: { ...defaultSessionSettings.params }
  };
  const existing = state.settingsSaveTimers.get(state.current.id);
  if (existing) {
    clearTimeout(existing);
    state.settingsSaveTimers.delete(state.current.id);
  }
  state.current = { ...state.current, ...payload };
  syncControlsFromSession();
  updateSessionSettingsLocal(state.current.id, payload);
  try {
    const updated = await api(`/api/sessions/${state.current.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    updateSessionSettingsLocal(state.current.id, {}, updated);
  } catch (error) {
    console.warn("恢复默认参数保存失败", error);
  }
}

function persistCurrentSessionSettings(delay = 350) {
  if (!state.current || state.isSyncingControls) return;
  const sessionId = state.current.id;
  const payload = currentSessionSettingsPayload();
  updateSessionSettingsLocal(sessionId, payload);

  const existing = state.settingsSaveTimers.get(sessionId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    state.settingsSaveTimers.delete(sessionId);
    try {
      const updated = await api(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      updateSessionSettingsLocal(sessionId, {}, updated);
    } catch (error) {
      console.warn("保存会话设置失败", error);
    }
  }, delay);
  state.settingsSaveTimers.set(sessionId, timer);
}

function showConfirm({ title, text, okText = "确认", okClass = "danger" }) {
  const overlay = $("#confirmOverlay");
  const okButton = $("#confirmOk");
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  okButton.textContent = okText;
  okButton.className = okClass;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  return new Promise(resolve => {
    const cleanup = value => {
      overlay.classList.add("hidden");
      overlay.setAttribute("aria-hidden", "true");
      okButton.onclick = null;
      $("#confirmCancel").onclick = null;
      overlay.onclick = null;
      window.onkeydown = null;
      resolve(value);
    };
    okButton.onclick = () => cleanup(true);
    $("#confirmCancel").onclick = () => cleanup(false);
    overlay.onclick = event => {
      if (event.target === overlay) cleanup(false);
    };
    window.onkeydown = event => {
      if (event.key === "Escape") cleanup(false);
    };
  });
}

function renderAttachments() {
  const wrap = $("#attachments");
  const notice = $("#attachmentNotice");
  updateFileModeVisual();
  wrap.innerHTML = "";
  for (const file of state.files) {
    const chip = document.createElement("span");
    chip.className = `attachment ${file.supported ? "" : "bad"}`;
    const label = file.supported ? file.name : `${file.name}：${file.reason}`;
    chip.innerHTML = `<span title="${escapeHtml(label)}">${escapeHtml(label)}</span> <button title="移除">×</button>`;
    chip.querySelector("button").onclick = () => {
      state.files = state.files.filter(item => item.id !== file.id);
      renderAttachments();
    };
    wrap.appendChild(chip);
  }
  const unsupported = state.files.filter(file => !file.supported);
  if (unsupported.length) {
    const imageCount = unsupported.filter(file => file.kind === "image").length;
    const docCount = unsupported.length - imageCount;
    const parts = [];
    if (imageCount) parts.push(`${imageCount} 个图片`);
    if (docCount) parts.push(`${docCount} 个非文本文件`);
    notice.classList.remove("hidden");
    notice.textContent = `${parts.join("、")}没有发送：DeepSeek 官方接口当前不接收图片、文档或容器上传，只接收文本消息。请先用截图识别、OCR 或其他视觉模型把图片内容转成文字，再粘贴到输入框。`;
  } else {
    notice.classList.add("hidden");
    notice.textContent = "";
  }
  updateSendState();
}

function isTextLike(file) {
  const name = file.name.toLowerCase();
  return file.type.startsWith("text/")
    || /\.(txt|md|csv|json|js|ts|tsx|jsx|py|java|cpp|c|cs|html|css|xml|yaml|yml|log)$/i.test(name);
}

function unsupportedReason(file) {
  if (file.type.startsWith("image/")) {
    return { kind: "image", reason: "图片输入暂不支持" };
  }
  if (/\.(pdf|doc|docx|ppt|pptx|xls|xlsx)$/i.test(file.name)) {
    return { kind: "document", reason: "文档上传暂不支持" };
  }
  if (/\.(zip|rar|7z|tar|gz)$/i.test(file.name)) {
    return { kind: "archive", reason: "压缩包暂不支持" };
  }
  return { kind: "binary", reason: "非文本文件暂不支持" };
}

async function handleFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    const item = {
      id: crypto.randomUUID(),
      name: file.name,
      supported: isTextLike(file),
      kind: "text",
      reason: "",
      content: ""
    };
    if (!item.supported) {
      const info = unsupportedReason(file);
      item.kind = info.kind;
      item.reason = info.reason;
    }
    if (item.supported) {
      item.content = await file.text();
      if (item.content.length > 40000) {
        item.content = `${item.content.slice(0, 40000)}\n\n[文件内容过长，已截断前 40000 字符]`;
      }
    }
    state.files.push(item);
  }
  renderAttachments();
}

function promptWithFiles(text, mode = "attachment") {
  const supported = state.files.filter(file => file.supported);
  if (!supported.length) return text;
  const parts = supported.map(file => {
    if (mode === "plain") return `\n\n${file.content}`;
    return `\n\n[附件：${file.name}]\n${file.content}`;
  });
  return `${text}${parts.join("")}`;
}

function humanSize(length) {
  if (length < 1024) return `${length} 字符`;
  return `${(length / 1024).toFixed(1)} 千字符`;
}

function fileSummaries(mode = "attachment") {
  return state.files
    .filter(file => file.supported)
    .map(file => ({
      name: file.name,
      meta: `${humanSize(file.content.length)} · ${mode === "plain" ? "已直接并入消息" : "已按文件阅读"}`
    }));
}

async function sendMessage() {
  if (state.isStreaming) {
    stopGeneration();
    return;
  }
  const input = $("#prompt");
  const text = input.value.trim();
  if (hasUnsupportedFiles()) {
    renderAttachments();
    const notice = $("#attachmentNotice");
    if (notice) {
      notice.classList.remove("hidden");
      notice.textContent = "请先移除不支持的文件：DeepSeek 官方接口当前只接收文本消息，不接收图片、文档或容器上传。";
    }
    updateSendState();
    return;
  }
  if (!text && !state.files.some(file => file.supported)) {
    renderAttachments();
    const notice = $("#attachmentNotice");
    if (notice) {
      notice.classList.remove("hidden");
      notice.textContent = state.files.length
        ? "当前选择的文件都不能发送：DeepSeek 官方接口当前只接收文本消息，不接收图片、文档或容器上传。"
        : "请输入消息或添加文本类文件。";
    }
    updateSendState();
    return;
  }
  refreshBalance().catch(() => {});
  if (!state.current) await newSession();
  input.value = "";
  autoResizePrompt();
  const params = currentParams();
  const finalText = promptWithFiles(text || "请阅读附件内容。", params.file_mode);
  const displayText = text || "请阅读附件内容。";
  const attached = fileSummaries(params.file_mode);
  state.files = state.files.filter(file => !file.supported);
  renderAttachments();

  const userMessage = {
    role: "user",
    content: finalText,
    displayContent: displayText,
    attachments: attached
  };
  state.current.messages.push(userMessage);
  appendMessageToView(userMessage, state.current.messages.length - 1);

  const assistant = {
    role: "assistant",
    content: "",
    reasoning: "",
    thinkingUsed: params.thinking === "enabled",
    searchUsed: params.search === "enabled",
    interrupted: false,
    searchEvents: [],
    citations: []
  };
  state.current.messages.push(assistant);
  const node = appendMessageToView(assistant, state.current.messages.length - 1);
  const contentEl = node.querySelector(".content");
  const bubble = node.querySelector(".bubble");

  state.isStreaming = true;
  state.abortRequested = false;
  state.abortController = new AbortController();
  updateSendState();
  let contentRenderFrame = null;
  let contentRenderTimer = null;
  let lastContentRenderAt = 0;
  const contentRenderInterval = 90;

  function renderAssistantContent({ immediate = false, keepBottom = true } = {}) {
    const run = () => {
      contentRenderFrame = null;
      contentRenderTimer = null;
      lastContentRenderAt = typeof performance !== "undefined" ? performance.now() : Date.now();
      contentEl.innerHTML = renderMarkdown(assistant.content);
      if (keepBottom) scrollMessagesToBottom();
      scheduleMathTypeset(contentEl, false, keepBottom);
      scheduleMermaidRender(contentEl);
    };
    if (immediate) {
      if (contentRenderFrame) {
        cancelAnimationFrame(contentRenderFrame);
        contentRenderFrame = null;
      }
      if (contentRenderTimer) {
        clearTimeout(contentRenderTimer);
        contentRenderTimer = null;
      }
      run();
      return;
    }
    if (contentRenderFrame || contentRenderTimer) return;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const wait = Math.max(0, contentRenderInterval - (now - lastContentRenderAt));
    if (wait > 0) {
      contentRenderTimer = window.setTimeout(() => {
        contentRenderTimer = null;
        contentRenderFrame = requestAnimationFrame(run);
      }, wait);
    } else {
      contentRenderFrame = requestAnimationFrame(run);
    }
  }

  function appendReasoning(text) {
    assistant.reasoning += text;
    let reasoningEl = bubble.querySelector(".reasoning");
    if (!reasoningEl) {
      reasoningEl = document.createElement("div");
      reasoningEl.className = "reasoning markdown-body";
      bubble.insertBefore(reasoningEl, contentEl);
    }
    reasoningEl.innerHTML = renderReasoningMarkdown(assistant.reasoning);
    scheduleMathTypeset(reasoningEl, false, true);
    scheduleMermaidRender(reasoningEl);
  }

  function renderSearchPanel() {
    let searchEl = bubble.querySelector(".search-status");
    if (!assistant.searchEvents.length) {
      searchEl?.remove();
      return;
    }
    const latest = assistant.searchEvents[assistant.searchEvents.length - 1];
    if (!searchEl) {
      searchEl = document.createElement("div");
      searchEl.className = "search-status";
      bubble.insertBefore(searchEl, bubble.firstChild);
    }
    const citationCount = citationsForMessage(assistant).length;
    const hasResolvedSearch = assistant.searchEvents.some(event => event.status === "results" || event.status === "done" || event.status === "error")
      || Boolean(assistant.usage || assistant.interrupted || assistant.error || String(assistant.content || "").trim());
    searchEl.classList.toggle("done", hasResolvedSearch || citationCount > 0);
    searchEl.classList.toggle("empty", hasResolvedSearch && citationCount === 0 && latest.status !== "error");
    searchEl.classList.toggle("error", latest.status === "error");
    searchEl.innerHTML = `<span class="search-pulse"></span><strong>${escapeHtml(displaySearchEventText(latest, assistant))}</strong>`;
  }

  function renderCitationPanel() {
    bubble.querySelector(".citations")?.remove();
    const wrap = document.createElement("div");
    wrap.innerHTML = renderSearchSources(assistant);
    const details = wrap.firstElementChild;
    if (details) bubble.appendChild(details);
  }

  function renderMetaPanel() {
    bubble.querySelector(".message-meta")?.remove();
    const html = renderMessageMeta(assistant);
    if (!html) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const actions = bubble.querySelector(".message-actions-row");
    if (wrap.firstElementChild) bubble.insertBefore(wrap.firstElementChild, actions || null);
  }

  function renderActionsPanel() {
    bubble.querySelector(".message-actions-row")?.remove();
    const html = renderMessageActions(assistant);
    if (!html) return;
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    if (wrap.firstElementChild) bubble.appendChild(wrap.firstElementChild);
  }

  let shouldReload = true;
  try {
    const response = await fetch(params.search === "enabled" ? "/api/chat/search-stream" : "/api/chat/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: state.abortController.signal,
      body: JSON.stringify({
        sessionId: state.current.id,
        message: finalText,
        displayMessage: displayText,
        attachments: attached,
        model: currentModelId(),
        system: $("#systemPrompt").value,
        params
      })
    });
    if (!response.ok || !response.body) {
      contentEl.textContent = "请求失败。";
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\n\n/);
      buffer = parts.pop() || "";
      for (const part of parts) {
        const event = part.match(/^event: (.+)$/m)?.[1] || "message";
        const dataLine = part.match(/^data: (.+)$/m)?.[1] || "{}";
        let data = {};
        try {
          data = JSON.parse(dataLine);
        } catch {
          continue;
        }
        if (event === "reasoning" && params.thinking === "enabled") appendReasoning(data.text || "");
        if (event === "content") {
          assistant.content += data.text || "";
          renderAssistantContent();
        }
        if (event === "search") {
          assistant.searchUsed = true;
          assistant.searchEvents.push(data);
          assistant.citations = citationsForMessage(assistant);
          renderSearchPanel();
        }
        if (event === "citation") {
          assistant.citations.push(data);
          assistant.citations = citationsForMessage(assistant);
          renderSearchPanel();
        }
        if (event === "saved") {
          assistant.usage = data.usage;
          assistant.cost = data.cost;
          if (assistant.content && !assistant.content.trim()) {
            assistant.content = params.output_mode === "json"
              ? "{\"error\":\"模型返回了空白内容\",\"hint\":\"JSON 输出需要明确字段结构；请指定需要的 JSON 字段后重试，或切回普通回答。\"}"
              : "调用完成，但模型返回了空白内容。";
            renderAssistantContent({ immediate: true });
          }
          if (Array.isArray(data.citations) && data.citations.length) assistant.citations = data.citations;
          if (Array.isArray(data.searchEvents) && data.searchEvents.length) {
            assistant.searchEvents = data.searchEvents;
          }
          assistant.citations = citationsForMessage(assistant);
          renderSearchPanel();
          renderCitationPanel();
          renderMetaPanel();
          refreshBalance().catch(() => {});
        }
        if (event === "error") {
          assistant.error = true;
          const errorText = `调用失败：${data.error || data.status || "未知错误"}`;
          assistant.content = assistant.content
            ? `${assistant.content}\n\n${errorText}`
            : errorText;
          renderAssistantContent({ immediate: true });
          renderMetaPanel();
          refreshBalance().catch(() => {});
        }
        scrollMessagesToBottom();
      }
    }
  } catch (error) {
    if (error.name === "AbortError") {
      shouldReload = false;
      assistant.interrupted = true;
      if (!assistant.content.trim()) assistant.content = "已停止生成。";
      assistant.content = cleanInterruptedContent(assistant.content);
      renderAssistantContent({ immediate: true, keepBottom: false });
      renderCitationPanel();
      renderMetaPanel();
      refreshBalance().catch(() => {});
    } else {
      assistant.error = true;
      const errorText = `请求异常：${error.message}`;
      assistant.content = assistant.content
        ? `${assistant.content}\n\n${errorText}`
        : errorText;
      renderAssistantContent({ immediate: true });
      renderMetaPanel();
      refreshBalance().catch(() => {});
    }
  } finally {
    const keepBottomAfterStream = state.autoScrollMessages && isMessagesNearBottom();
    renderActionsPanel();
    scheduleMathTypeset(contentEl, true, keepBottomAfterStream);
    scheduleMermaidRender(contentEl);
    const reasoningEl = bubble.querySelector(".reasoning");
    if (reasoningEl) scheduleMathTypeset(reasoningEl, true, keepBottomAfterStream);
    if (keepBottomAfterStream) scrollMessagesToBottom();
    state.isStreaming = false;
    state.abortRequested = false;
    state.abortController = null;
    updateSendState();
  }

  if (shouldReload) {
    await refreshSessions();
    const fresh = state.sessions.find(session => session.id === state.current?.id);
    if (fresh) {
      state.current.title = fresh.title;
      $("#sessionTitle").textContent = fresh.title || "新对话";
      renderSessions();
    }
  }
}

function appendMessageToView(message, index = -1, { stickToBottom = true } = {}) {
  const wrap = $("#messages");
  if (!wrap) return null;
  const node = messageNode(message, index, { animate: true });
  wrap.appendChild(node);
  scheduleMathTypeset(node, false, stickToBottom);
  scheduleMermaidRender(node);
  if (stickToBottom) scrollMessagesToBottom(true);
  return node;
}

function fillEndpoint(endpoint) {
  $("#apiKind").value = endpoint.kind;
  $("#apiMethod").value = endpoint.method;
  $("#apiPath").value = endpoint.path;
  const examples = {
    "对话生成": {
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: "你是一个可靠的中文助手。" },
        { role: "user", content: "你好，介绍一下你自己。" }
      ],
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      max_tokens: 1024,
      temperature: 0.6
    },
    "联网搜索": {
      model: "deepseek-v4-pro",
      max_tokens: 1024,
      stream: true,
      messages: [
        { role: "user", content: "核查一下 DeepSeek API 是否支持联网搜索，并给出来源。" }
      ],
      tools: [
        {
          type: "web_search_20250305",
          name: "web_search",
          max_uses: 5
        }
      ]
    },
    "结构化输出": {
      model: "deepseek-v4-pro",
      messages: [
        { role: "system", content: "你必须只输出结构化数据，格式为 {\"summary\":\"...\",\"level\":1}。" },
        { role: "user", content: "把“DeepSeek 接口很适合做本地工具”总结成结构化结果。" }
      ],
      response_format: { type: "json_object" },
      max_tokens: 1024,
      temperature: 0.2
    },
    "工具调用": {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "杭州今天适合出门吗？请先调用天气工具。" }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather of a location.",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string", description: "城市名，例如 Hangzhou" }
              },
              required: ["location"]
            }
          }
        }
      ]
    },
    "前缀续写测试版": {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "请写一个快速排序函数。" },
        { role: "assistant", content: "```python\n", prefix: true }
      ],
      stop: ["```"],
      max_tokens: 1024,
      temperature: 0.2
    },
    "严格工具调用测试版": {
      model: "deepseek-v4-pro",
      messages: [
        { role: "user", content: "查询广州天气。" }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            strict: true,
            description: "Get weather of a location.",
            parameters: {
              type: "object",
              properties: {
                location: { type: "string" }
              },
              required: ["location"],
              additionalProperties: false
            }
          }
        }
      ]
    },
    "代码补全测试版": {
      model: "deepseek-v4-pro",
      prompt: "function add(a, b) {",
      suffix: "}",
      max_tokens: 128,
      temperature: 0.2
    },
    "兼容消息接口": {
      model: "deepseek-v4-pro",
      max_tokens: 1024,
      messages: [
        { role: "user", content: "用两句话介绍 DeepSeek Anthropic API。" }
      ]
    }
  };
  $("#apiBody").value = ["GET", "HEAD"].includes(endpoint.method) ? "{}" : pretty(examples[endpoint.name] || {});
}

async function runApi() {
  let body = {};
  try {
    body = JSON.parse($("#apiBody").value || "{}");
  } catch (error) {
    $("#apiResult").textContent = `请求体解析失败：${error.message}`;
    return;
  }
  $("#apiResult").textContent = "请求中...";
  try {
    const result = await api("/api/proxy", {
      method: "POST",
      body: JSON.stringify({
        kind: $("#apiKind").value,
        method: $("#apiMethod").value,
        path: $("#apiPath").value,
        body
      })
    });
    $("#apiResult").textContent = pretty(result);
  } catch (error) {
    $("#apiResult").textContent = error.message;
  }
}

async function copyText(text, button) {
  const value = String(text || "");
  if (!value.trim()) return;
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
  } else {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
  if (button) {
    if (!button.dataset.originalHtml) {
      button.dataset.originalHtml = button.innerHTML;
      button.dataset.originalTitle = button.title || "";
    }
    if (button.__copyResetTimer) {
      window.clearTimeout(button.__copyResetTimer);
    }
    button.classList.add("done");
    button.title = "已复制到剪贴板";
    button.innerHTML = `<span class="copy-icon" aria-hidden="true"></span><span>已复制</span>`;
    button.__copyResetTimer = window.setTimeout(() => {
      button.classList.remove("done");
      button.innerHTML = button.dataset.originalHtml || `<span class="copy-icon" aria-hidden="true"></span><span>复制全文</span>`;
      button.title = button.dataset.originalTitle || "复制本条回复全文";
      delete button.dataset.originalHtml;
      delete button.dataset.originalTitle;
      button.__copyResetTimer = null;
    }, 1200);
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function svgNumber(value, fallback = 0) {
  const next = Number.parseFloat(String(value || "").replace("px", ""));
  return Number.isFinite(next) ? next : fallback;
}

function convertForeignObjectLabels(svg) {
  svg.querySelectorAll("foreignObject").forEach(item => {
    const label = item.textContent.replace(/\s+/g, " ").trim();
    if (!label) {
      item.remove();
      return;
    }
    const x = svgNumber(item.getAttribute("x"));
    const y = svgNumber(item.getAttribute("y"));
    const width = svgNumber(item.getAttribute("width"));
    const height = svgNumber(item.getAttribute("height"));
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("x", String(x + width / 2));
    text.setAttribute("y", String(y + height / 2));
    text.setAttribute("fill", "#172033");
    text.setAttribute("font-size", "14");
    text.setAttribute("font-family", "Microsoft YaHei, Arial, sans-serif");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "middle");
    text.textContent = label;
    item.replaceWith(text);
  });
}

function prepareMermaidSvgForExport(svg, width, height, pixelWidth, pixelHeight) {
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(pixelWidth));
  clone.setAttribute("height", String(pixelHeight));
  clone.setAttribute("style", "color:#172033");

  convertForeignObjectLabels(clone);
  clone.querySelectorAll("text, tspan").forEach(item => {
    item.setAttribute("fill", item.getAttribute("fill") || "#172033");
    item.setAttribute("font-family", item.getAttribute("font-family") || "Microsoft YaHei, Arial, sans-serif");
  });
  return new XMLSerializer().serializeToString(clone);
}

async function downloadMermaidImage(button) {
  const card = button.closest(".mermaid-card");
  const svg = card?.querySelector(".mermaid svg");
  if (!svg) {
    button.title = "图表还在渲染中";
    return;
  }
  const Canvg = window.canvg?.Canvg;
  if (!Canvg) {
    button.title = "PNG renderer is not loaded";
    return;
  }
  const old = button.innerHTML;
  const format = button.dataset.format === "jpg" ? "jpg" : "png";
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const label = format.toUpperCase();
  button.disabled = true;
  button.innerHTML = `<span class="download-icon" aria-hidden="true"></span><span>生成中</span>`;
  const box = svg.getBoundingClientRect();
  const viewBox = svg.viewBox?.baseVal;
  const width = Math.max(1, Math.ceil(viewBox?.width || box.width || 960));
  const height = Math.max(1, Math.ceil(viewBox?.height || box.height || 540));
  const canvas = document.createElement("canvas");
  const scale = Math.max(3, Math.min(4, window.devicePixelRatio || 1));
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const svgText = prepareMermaidSvgForExport(svg, width, height, canvas.width, canvas.height);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  try {
    const renderer = await Canvg.fromString(ctx, svgText, {
      ignoreAnimation: true,
      ignoreMouse: true,
      enableRedraw: false,
      ignoreDimensions: true,
      scaleWidth: canvas.width,
      scaleHeight: canvas.height
    });
    await renderer.render();
    let exportCanvas = canvas;
    if (format === "jpg") {
      exportCanvas = document.createElement("canvas");
      exportCanvas.width = canvas.width;
      exportCanvas.height = canvas.height;
      const exportCtx = exportCanvas.getContext("2d");
      exportCtx.fillStyle = "#ffffff";
      exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
      exportCtx.drawImage(canvas, 0, 0);
    }
    const blob = await new Promise(resolve => exportCanvas.toBlob(resolve, mime, format === "jpg" ? 0.96 : undefined));
    if (!blob) throw new Error(`${label} Blob generation failed`);
    downloadBlob(blob, `mermaid-${Date.now()}.${format}`);
    button.classList.add("done");
    button.innerHTML = `<span class="download-icon" aria-hidden="true"></span><span>已下载</span>`;
    window.setTimeout(() => {
      button.classList.remove("done");
      button.innerHTML = old;
      button.disabled = false;
    }, 1200);
  } catch (error) {
    button.innerHTML = `<span class="download-icon" aria-hidden="true"></span><span>失败</span>`;
    button.title = error.message || `${label} download failed`;
    window.setTimeout(() => {
      button.innerHTML = old;
      button.disabled = false;
    }, 1600);
    throw error;
  }
}

function bindEvents() {
  $("#newSession").onclick = newSession;
  $("#refreshSessions").onclick = refreshSessions;
  $("#resetSettings").onclick = resetCurrentSessionSettings;
  $("#sessionSearch").oninput = renderSessions;
  $("#send").onclick = sendMessage;
  $("#attachBtn").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = event => {
    handleFiles(event.target.files).catch(error => alert(`读取文件失败：${error.message}`));
    event.target.value = "";
  };
  $("#prompt").addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    if (event.isComposing || event.shiftKey) return;
    event.preventDefault();
    if (!state.isStreaming && !hasSendablePayload()) return;
    sendMessage();
  });
  $("#prompt").addEventListener("input", () => {
    autoResizePrompt();
    updateSendState();
  });
  $("#messages").addEventListener("scroll", () => {
    state.autoScrollMessages = isMessagesNearBottom();
    prependOlderMessagesIfNeeded();
  }, { passive: true });
  $("#messages").addEventListener("click", event => {
    const copyButton = event.target.closest(".copy-message");
    if (copyButton) {
      const row = copyButton.closest(".message");
      const index = Number(row?.dataset.messageIndex);
      const message = Number.isInteger(index) ? state.current?.messages?.[index] : null;
      copyText(message?.content || row?.querySelector(".content")?.innerText || "", copyButton).catch(error => {
        console.warn("复制失败", error);
      });
      return;
    }
    const downloadButton = event.target.closest(".download-mermaid");
    if (downloadButton) {
      downloadMermaidImage(downloadButton).catch(error => {
        console.warn("下载 Mermaid 图失败", error);
      });
    }
  });
  $("#temperature").oninput = event => {
    $("#tempValue").textContent = event.target.value;
    persistCurrentSessionSettings();
  };
  $("#topP").oninput = event => {
    $("#topPValue").textContent = event.target.value;
    persistCurrentSessionSettings();
  };
  $("#maxTokens").oninput = () => persistCurrentSessionSettings();
  $("#systemPrompt").oninput = () => persistCurrentSessionSettings();
  $("#stopWords").oninput = () => persistCurrentSessionSettings();
  $("#userId").oninput = () => persistCurrentSessionSettings();
  $("#thinking").onchange = () => {
    updateThinkingVisual();
    persistCurrentSessionSettings(0);
  };
  $("#thinkingToggle").onclick = () => {
    const thinking = $("#thinking");
    thinking.value = thinking.value === "enabled" ? "disabled" : "enabled";
    updateThinkingVisual();
    persistCurrentSessionSettings(0);
  };
  $("#searchToggle").onclick = () => {
    const mode = $("#searchMode");
    mode.value = mode.value === "enabled" ? "disabled" : "enabled";
    updateSearchVisual();
    persistCurrentSessionSettings(0);
  };
  $("#effort").onchange = () => persistCurrentSessionSettings(0);
  $("#outputModeButton").onclick = event => {
    event.stopPropagation();
    $("#outputModeMenu").classList.toggle("hidden");
  };
  document.addEventListener("click", event => {
    if (!event.target.closest(".tool-menu")) $("#outputModeMenu")?.classList.add("hidden");
  });
  document.querySelectorAll("#outputModeMenu button").forEach(button => {
    button.onclick = () => {
      $("#outputMode").value = button.dataset.mode || "normal";
      $("#outputModeMenu").classList.add("hidden");
      updateOutputModeVisual();
      persistCurrentSessionSettings(0);
    };
  });
  $("#fileModeToggle").onclick = () => {
    const mode = $("#fileMode");
    mode.value = mode.value === "attachment" ? "plain" : "attachment";
    updateFileModeVisual();
    renderAttachments();
    persistCurrentSessionSettings(0);
  };
  $("#model").onchange = () => {
    updateModelHint();
    updateThinkingVisual();
    updateSearchVisual();
    persistCurrentSessionSettings(0);
  };
  $("#keyBtn").onclick = openKeyModal;
  $("#keyVisibilityToggle").onclick = () => {
    const visible = !getKeyVisiblePreference();
    setKeyVisiblePreference(visible);
    applyKeyVisibility(visible);
  };
  $("#keySave").onclick = saveKeyFromModal;
  $("#keyCancel").onclick = closeKeyModal;
  $("#keyInput").addEventListener("keydown", event => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    saveKeyFromModal();
  });
  $("#keyOverlay").onclick = event => {
    if (event.target === $("#keyOverlay")) closeKeyModal();
  };
  $("#topUpBtn").onclick = () => {
    window.open("https://platform.deepseek.com/top_up", "_blank", "noopener,noreferrer");
  };
  for (const tab of document.querySelectorAll(".tab")) {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach(item => item.classList.remove("active"));
      tab.classList.add("active");
      $("#chatPanel").classList.toggle("hidden", tab.dataset.tab !== "chat");
      $("#apiPanel").classList.toggle("hidden", tab.dataset.tab !== "api");
    };
  }
  $("#endpointPreset").onchange = event => {
    const endpoint = state.endpoints.find(item => item.name === event.target.value);
    if (endpoint) fillEndpoint(endpoint);
  };
  $("#runApi").onclick = runApi;
}

async function boot() {
  bindEvents();
  state.config = await api("/api/config");
  state.endpoints = state.config.endpoints || [];
  state.models = state.config.models || [
    { id: "deepseek-v4-pro", label: "深度求索 V4 Pro", group: "official", status: "current" },
    { id: "deepseek-v4-flash", label: "深度求索 V4 Flash", group: "official", status: "current" }
  ];
  setKeyState(state.config.keyConfigured);
  renderModels();
  if (state.config.keyConfigured) {
    try {
      await refreshBalance();
    } catch {
      updateBalanceState(null);
    }
  }
  window.setInterval(() => {
    refreshBalance().catch(() => setBalanceDisplay(null, false));
  }, 15000);

  const preset = $("#endpointPreset");
  preset.innerHTML = "";
  for (const endpoint of state.endpoints) {
    const option = document.createElement("option");
    option.textContent = endpoint.name;
    preset.appendChild(option);
  }
  if (state.endpoints[0]) fillEndpoint(state.endpoints[0]);
  await refreshSessions();
  if (state.sessions[0]) await loadSession(state.sessions[0].id);
  else await newSession();
  updateSendState();
}

boot().catch(error => {
  document.body.innerHTML = `<pre style="padding:24px;color:#c93f3f">${escapeHtml(error.stack || error.message)}</pre>`;
});
