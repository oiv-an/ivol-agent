// Service worker: agent-loop поверх Responses API, диспетчер tool'ов, permission gate.

import { parseSSE } from "./lib/sse.js";
import { buildTools, TOOL_RISK, RISK } from "./lib/tools.js";
import { CONFIG, isValidEffort } from "./config.js";

const DEFAULTS = { ...CONFIG };

const APPROVAL_TIMEOUT_MS = 120000;
const MAX_LOOP_STEPS = 12;

// agent_id -> resolve функции ожидающих подтверждений
const pendingApprovals = new Map();
// runId -> AbortController
const running = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "background") return;

  if (msg.action === "approval_response") {
    const entry = pendingApprovals.get(msg.approvalId);
    if (entry) {
      pendingApprovals.delete(msg.approvalId);
      clearTimeout(entry.timer);
      entry.resolve({ allowed: !!msg.allowed, remember: !!msg.remember });
    }
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "abort") {
    const ctrl = running.get(msg.runId);
    if (ctrl) ctrl.abort();
    sendResponse({ ok: true });
    return;
  }

  // options.html грузится как обычный скрипт и не может импортировать config.js —
  // отдаём ему актуальные настройки отсюда
  if (msg.action === "get_settings") {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.action === "run_agent") {
    // отвечаем сразу, работа идёт в фоне
    sendResponse({ ok: true });
    runAgent(msg.payload).catch((e) => {
      emit({
        type: "error",
        runId: msg.payload.runId,
        message: String(e && e.message ? e.message : e),
      });
    });
    return;
  }

  // панель спрашивает, какая вкладка активна в ЕЁ окне
  if (msg.action === "get_tab_info") {
    getActiveTab(msg.windowId)
      .then((tab) => sendResponse({ ok: true, tab: tabInfo(tab) }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true; // async
  }
});

// ---------- отслеживание активной вкладки ----------

function tabInfo(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    title: tab.title,
    host: safeHost(tab.url),
    restricted: isRestricted(tab.url),
  };
}

// Событие уходит всем панелям; каждая сама отфильтрует по своему windowId
function notifyTabChanged(tab) {
  if (!tab) return;
  chrome.runtime
    .sendMessage({
      target: "sidepanel",
      type: "tab_changed",
      tab: tabInfo(tab),
    })
    .catch(() => {});
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    notifyTabChanged(await chrome.tabs.get(tabId));
  } catch (_) {}
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab.active) return;
  if (info.status === "complete" || info.title || info.url) {
    notifyTabChanged(tab);
  }
});

chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId: winId });
    notifyTabChanged(tab);
  } catch (_) {}
});

// ---------- отправка событий в side panel ----------

function emit(event) {
  chrome.runtime.sendMessage({ target: "sidepanel", ...event }).catch((e) => {
    // панель закрыта или ещё не слушает — не критично, но логируем
    console.debug("[IVOL] emit failed:", event.type, String(e && e.message));
  });
}

// ---------- настройки ----------

async function getSettings() {
  const stored = await chrome.storage.local.get(["settings"]);
  const s = { ...DEFAULTS, ...(stored.settings || {}) };
  // пустые значения из storage не должны затирать зашитый конфиг
  if (!s.apiKey) s.apiKey = DEFAULTS.apiKey;
  if (!s.baseUrl) s.baseUrl = DEFAULTS.baseUrl;
  if (!s.model) s.model = DEFAULTS.model;
  // старое/битое значение из storage не должно молча деградировать в medium
  if (!isValidEffort(s.effort)) s.effort = DEFAULTS.effort;
  return s;
}

// ---------- системный промпт ----------

function systemPrompt(pageInfo) {
  return [
    "Ты — IVOL Agent, ассистент, встроенный в браузер Chrome в виде боковой панели.",
    "Ты можешь читать текущую страницу, заполнять формы, кликать, скроллить, открывать сайты, искать в интернете и выполнять JavaScript.",
    "",
    "ПРАВИЛА РАБОТЫ СО СТРАНИЦЕЙ:",
    "1. Прежде чем что-то делать на странице — вызови get_page_context, чтобы увидеть актуальные элементы.",
    "2. Для действий используй ТОЛЬКО agent_id из последнего get_page_context. CSS-селекторы не работают.",
    "3. После клика или навигации DOM меняется — вызывай get_page_context заново.",
    "4. Действия fill_form, click_element, open_url и run_script требуют подтверждения пользователя. Это нормально, просто вызывай их.",
    "5. Если пользователь отклонил действие — не повторяй его молча, объясни альтернативу и спроси.",
    "6. run_script используй только когда обычных tool'ов недостаточно. Код должен быть коротким, читаемым и возвращать результат через return.",
    "7. Для поиска в интернете используй встроенный web_search.",
    "8. Служебные страницы (chrome://, страница расширений, Chrome Web Store) расширениям недоступны. " +
      "Если вкладка такая — не пытайся её читать, а предложи открыть нужный сайт через open_url.",
    "9. Текст и карта элементов из get_page_context — основной способ понять страницу. " +
      "take_screenshot нужен только когда текста объективно не хватает: график, диаграмма, canvas, " +
      "картинка без alt, вопрос про вёрстку или внешний вид. Не делай снимок «на всякий случай».",
    "",
    "СТИЛЬ:",
    "- Отвечай на русском, по делу, без воды и без лишних расшаркиваний.",
    "- Используй markdown: списки, таблицы, блоки кода.",
    "- Если собираешься заполнить форму — сначала кратко скажи, что именно заполнишь, потом вызывай tool.",
    "",
    pageInfo
      ? `ТЕКУЩАЯ ВКЛАДКА: ${pageInfo.title || "(без заголовка)"} — ${pageInfo.url}` +
        (isRestricted(pageInfo.url)
          ? "\nВНИМАНИЕ: эта вкладка служебная и недоступна расширению. Читать и менять её нельзя."
          : "")
      : "",
  ].join("\n");
}

// ---------- главный цикл ----------

async function runAgent({
  runId,
  roomId,
  input,
  allowedActions,
  tabId,
  windowId,
}) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    emit({
      type: "error",
      runId,
      message: "Не задан API-ключ. Открой настройки расширения.",
    });
    return;
  }

  const tab = await resolveTab(tabId, windowId);
  const conversation = [...input];
  const baseLen = conversation.length;
  const controller = new AbortController();
  running.set(runId, controller);

  const roomPerms = allowedActions || {};

  try {
    for (let step = 0; step < MAX_LOOP_STEPS; step++) {
      const result = await streamOnce({
        settings,
        runId,
        instructions: systemPrompt(tab),
        input: conversation,
        signal: controller.signal,
      });

      // всё, что вернула модель, кладём обратно в диалог
      conversation.push(...result.outputItems);

      if (!result.functionCalls.length) {
        emit({ type: "done", runId, items: conversation.slice(baseLen) });
        return;
      }

      // выполняем вызовы по очереди
      for (const call of result.functionCalls) {
        let args = {};
        try {
          args = call.arguments ? JSON.parse(call.arguments) : {};
        } catch (_) {
          args = {};
        }

        const risk = TOOL_RISK[call.name] || RISK.ASK;
        const domain = tab && tab.url ? safeHost(tab.url) : "";
        const permKey = `${call.name}:${domain}`;

        let allowed = true;
        if (risk === RISK.ASK_ALWAYS) {
          allowed = await requestApproval({
            runId,
            call,
            args,
            risk,
            domain,
            canRemember: false,
          });
        } else if (risk === RISK.ASK) {
          if (roomPerms[permKey]) {
            allowed = true;
            emit({
              type: "tool_auto",
              runId,
              name: call.name,
              args,
              reason: "разрешено ранее для " + domain,
            });
          } else {
            const res = await requestApprovalFull({
              runId,
              call,
              args,
              risk,
              domain,
              canRemember: true,
            });
            allowed = res.allowed;
            if (allowed && res.remember) {
              roomPerms[permKey] = true;
              emit({ type: "permission_saved", runId, roomId, key: permKey });
            }
          }
        } else {
          emit({ type: "tool_start", runId, name: call.name, args });
        }

        let output;
        if (!allowed) {
          output = {
            error:
              "Пользователь отклонил это действие. Предложи другой вариант или спроси, что делать дальше.",
          };
          emit({ type: "tool_denied", runId, name: call.name });
        } else {
          try {
            output = await executeTool(call.name, args, tab);
            emit({
              type: "tool_result",
              runId,
              name: call.name,
              summary: summarize(call.name, output),
            });
          } catch (e) {
            output = { error: String(e && e.message ? e.message : e) };
            emit({
              type: "tool_error",
              runId,
              name: call.name,
              message: output.error,
            });
          }
        }

        // Картинку нельзя положить в function_call_output — он принимает только текст.
        // Достаём её и добавляем отдельным сообщением с input_image.
        let image = null;
        if (output && output.__image) {
          image = output.__image;
          output = { ...output };
          delete output.__image;
        }

        conversation.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(output).slice(0, 100000),
        });

        if (image) {
          conversation.push({
            role: "user",
            content: [
              { type: "input_text", text: "Снимок экрана текущей вкладки:" },
              { type: "input_image", image_url: image },
            ],
          });
        }
      }
    }

    emit({
      type: "error",
      runId,
      message: "Превышен лимит шагов агента. Останавливаюсь.",
    });
  } catch (e) {
    if (e.name === "AbortError") emit({ type: "aborted", runId });
    else
      emit({
        type: "error",
        runId,
        message: String(e && e.message ? e.message : e),
      });
  } finally {
    running.delete(runId);
  }
}

// ---------- один проход к модели со стримингом ----------

async function streamOnce({ settings, runId, instructions, input, signal }) {
  const body = {
    model: settings.model,
    instructions,
    input,
    stream: true,
    reasoning: { effort: settings.effort || "high" },
    tools: buildTools({ webSearch: settings.webSearch !== false }),
    parallel_tool_calls: false,
    store: false,
  };

  // Прокси периодически отдаёт 502/503 (PHP-FPM падает) — пробуем ещё раз
  let res;
  const RETRY_STATUSES = [429, 500, 502, 503, 504];
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(trimSlash(settings.baseUrl) + "/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.apiKey,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok || !RETRY_STATUSES.includes(res.status)) break;
    if (attempt < 2) {
      emit({
        type: "retrying",
        runId,
        attempt: attempt + 1,
        status: res.status,
      });
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const clean = txt
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    throw new Error(`API ${res.status}: ${clean.slice(0, 200)}`);
  }

  const outputItems = [];
  const functionCalls = [];
  let textStarted = false;

  // Прокси может отдавать поток либо в формате Responses API,
  // либо в формате Chat Completions (chat.completion.chunk). Поддерживаем оба.
  let chatText = "";
  const chatCalls = new Map(); // index -> { id, name, args }

  const startText = () => {
    if (!textStarted) {
      textStarted = true;
      emit({ type: "text_start", runId });
    }
  };

  for await (const evt of parseSSE(res)) {
    // --- ветка Chat Completions ---
    if (evt.object === "chat.completion.chunk" || (evt.choices && !evt.type)) {
      const choice = (evt.choices || [])[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (typeof delta.content === "string" && delta.content) {
        startText();
        chatText += delta.content;
        emit({ type: "text_delta", runId, delta: delta.content });
      }

      const rc = delta.reasoning_content || delta.reasoning;
      if (typeof rc === "string" && rc) {
        emit({ type: "reasoning_delta", runId, delta: rc });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : 0;
          let acc = chatCalls.get(idx);
          if (!acc) {
            acc = { id: "", name: "", args: "" };
            chatCalls.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function) {
            if (tc.function.name) {
              acc.name = tc.function.name;
              emit({ type: "tool_pending", runId, name: acc.name });
            }
            if (tc.function.arguments) acc.args += tc.function.arguments;
          }
        }
      }
      continue;
    }

    // --- ветка Responses API ---
    const t = evt.type;

    if (t === "response.output_text.delta" && evt.delta) {
      startText();
      emit({ type: "text_delta", runId, delta: evt.delta });
    } else if (t === "response.reasoning_summary_text.delta" && evt.delta) {
      emit({ type: "reasoning_delta", runId, delta: evt.delta });
    } else if (t === "response.output_item.added") {
      const item = evt.item || {};
      if (item.type === "function_call") {
        emit({ type: "tool_pending", runId, name: item.name });
      } else if (item.type === "web_search_call") {
        emit({ type: "web_search", runId });
      }
    } else if (t === "response.output_item.done") {
      const item = evt.item;
      if (item) {
        outputItems.push(item);
        if (item.type === "function_call") functionCalls.push(item);
      }
    } else if (t === "response.completed") {
      const out = evt.response && evt.response.output;
      if (out && !outputItems.length) {
        for (const item of out) {
          outputItems.push(item);
          if (item.type === "function_call") functionCalls.push(item);
        }
      }
    } else if (t === "error" || t === "response.failed") {
      const m =
        (evt.error && evt.error.message) ||
        (evt.response && evt.response.error && evt.response.error.message) ||
        "Ошибка потока";
      throw new Error(m);
    }
  }

  // Собираем items в формате Responses API из chat-потока
  if (!outputItems.length) {
    if (chatText) {
      outputItems.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: chatText }],
      });
    }
    for (const acc of chatCalls.values()) {
      if (!acc.name) continue;
      const item = {
        type: "function_call",
        call_id: acc.id || "call_" + Math.random().toString(36).slice(2),
        name: acc.name,
        arguments: acc.args || "{}",
      };
      outputItems.push(item);
      functionCalls.push(item);
    }
  }

  return { outputItems, functionCalls };
}

// ---------- permission gate ----------

function requestApprovalFull({ runId, call, args, risk, domain, canRemember }) {
  const approvalId =
    "ap_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(approvalId);
      emit({ type: "approval_timeout", runId, approvalId });
      resolve({ allowed: false, remember: false });
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(approvalId, { resolve, timer });

    emit({
      type: "approval_request",
      runId,
      approvalId,
      name: call.name,
      args,
      risk,
      domain,
      canRemember,
    });
  });
}

async function requestApproval(opts) {
  const r = await requestApprovalFull(opts);
  return r.allowed;
}

// ---------- выполнение tool'ов ----------

async function executeTool(name, args, tab) {
  // open_url — единственный tool, который работает даже на служебной странице
  if (name === "open_url") return openUrl(args, tab);

  // перечитываем вкладку: пользователь мог перейти на другой адрес
  const fresh = await resolveTab(tab && tab.id, tab && tab.windowId);
  assertPageUsable(fresh);

  switch (name) {
    case "take_screenshot":
      return takeScreenshot(fresh);
    case "run_script":
      return runScript(args, fresh);
    case "get_page_context":
    case "read_selection":
    case "scroll_to":
    case "fill_form":
    case "click_element":
      return sendToContent(fresh.id, name, args);
    default:
      throw new Error("Неизвестный tool: " + name);
  }
}

async function openUrl({ url, new_tab }, boundTab) {
  if (!/^https?:\/\//i.test(url))
    throw new Error("URL должен начинаться с http:// или https://");
  if (new_tab) {
    const t = await chrome.tabs.create({ url, active: true });
    await waitForLoad(t.id);
    return { tab_id: t.id, url, opened_in: "новая вкладка" };
  }
  const tab = await resolveTab(
    boundTab && boundTab.id,
    boundTab && boundTab.windowId,
  );
  const t = await chrome.tabs.update(tab.id, { url });
  await waitForLoad(t.id);
  return { tab_id: t.id, url, opened_in: "текущая вкладка" };
}

// Снимок видимой части вкладки + сжатие, чтобы не жечь токены
async function takeScreenshot(tab) {
  const raw = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });
  if (!raw) throw new Error("Не удалось сделать снимок вкладки");

  const compressed = await compressDataUrl(raw, 1024, 0.6);
  const bytes = Math.round((compressed.length * 3) / 4 / 1024);

  return {
    __image: compressed, // вытаскивается в runAgent и уходит отдельным сообщением
    url: tab.url,
    title: tab.title,
    note: "Снимок только видимой области экрана. Чтобы увидеть другую часть страницы — сначала проскролль.",
    size_kb: bytes,
  };
}

async function compressDataUrl(dataUrl, maxSide, quality) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);

    let { width, height } = bitmap;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    width = Math.round(width * scale);
    height = Math.round(height * scale);

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const out = await canvas.convertToBlob({ type: "image/jpeg", quality });
    const buf = await out.arrayBuffer();
    return "data:image/jpeg;base64," + arrayBufferToBase64(buf);
  } catch (_) {
    // если что-то пошло не так — отдаём исходный PNG
    return dataUrl;
  }
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function runScript({ code }, tab) {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [code],
    func: (src) => {
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(src);
        const out = fn();
        if (out === undefined) return { ok: true, result: null };
        try {
          return { ok: true, result: JSON.parse(JSON.stringify(out)) };
        } catch (_) {
          return { ok: true, result: String(out) };
        }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    },
  });
  const r = res && res.result;
  if (!r) return { ok: false, error: "Скрипт не вернул результат" };
  if (!r.ok) throw new Error(r.error);
  return r;
}

async function sendToContent(tabId, action, args) {
  await ensureContentScript(tabId);
  const resp = await chrome.tabs.sendMessage(tabId, {
    target: "content",
    action,
    args,
  });
  if (!resp) throw new Error("Нет ответа от страницы");
  if (!resp.ok) throw new Error(resp.error);
  return resp.data;
}

async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, {
      target: "content",
      action: "ping",
    });
    if (r && r.ok) return;
  } catch (_) {
    // не загружен
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

// ---------- утилиты ----------

const RESTRICTED_RE =
  /^(chrome|edge|about|chrome-extension|devtools|view-source|file):/i;

function isRestricted(url) {
  if (!url) return true;
  if (RESTRICTED_RE.test(url)) return true;
  // Chrome Web Store тоже закрыт для расширений
  if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) return true;
  if (/^https:\/\/chrome\.google\.com\/webstore/i.test(url)) return true;
  return false;
}

// Вкладка, к которой привязан чат. Если id передан из панели — берём её,
// иначе падаем на активную.
async function resolveTab(tabId, windowId) {
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) return tab;
    } catch (_) {
      // вкладку закрыли — идём за активной в том же окне
    }
  }
  return getActiveTab(windowId);
}

// windowId обязателен, когда открыто несколько окон: у каждого своя панель
async function getActiveTab(windowId) {
  if (windowId != null) {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) return tab;
  }
  let [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab) throw new Error("Нет активной вкладки");
  return tab;
}

// Понятное сообщение вместо сырого «Cannot access a chrome:// URL»
function assertPageUsable(tab) {
  if (!tab) throw new Error("Нет активной вкладки");
  if (isRestricted(tab.url)) {
    throw new Error(
      `Эта вкладка недоступна расширениям (${shortUrl(tab.url)}). ` +
        "Переключись на обычный сайт и повтори — или скажи, какой адрес открыть.",
    );
  }
}

function shortUrl(url) {
  if (!url) return "нет URL";
  const s = String(url);
  return s.length > 60 ? s.slice(0, 60) + "…" : s;
}

function waitForLoad(tabId, timeout = 15000) {
  return new Promise((resolve) => {
    const to = setTimeout(finish, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") finish();
    }
    function finish() {
      clearTimeout(to);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return "";
  }
}

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

function summarize(name, output) {
  if (!output || output.error)
    return output && output.error ? "ошибка: " + output.error : "";
  switch (name) {
    case "get_page_context":
      return `${output.elements ? output.elements.length : 0} элементов, ${output.text ? output.text.length : 0} символов текста`;
    case "fill_form": {
      const f = output.filled ? output.filled.length : 0;
      const bad = output.failed ? output.failed.length : 0;
      return `заполнено ${f}${bad ? ", ошибок " + bad : ""}`;
    }
    case "click_element":
      return output.clicked ? `«${output.clicked}»` : "ок";
    case "take_screenshot":
      return output.size_kb ? `снимок ${output.size_kb} КБ` : "снимок сделан";
    case "open_url":
      return output.url || "ок";
    case "run_script":
      return "выполнено";
    case "read_selection":
      return output.selection
        ? output.selection.slice(0, 60)
        : "ничего не выделено";
    default:
      return "ок";
  }
}
