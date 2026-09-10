// UI боковой панели: чат, комнаты, стриминг, карточки подтверждения.

import { renderMarkdown, escapeHtml } from "./lib/markdown.js";
import { describeAction } from "./lib/tools.js";
import { CONFIG, isValidEffort } from "./config.js";

const $ = (id) => document.getElementById(id);

const els = {
  messages: $("messages"),
  empty: $("empty-state"),
  input: $("input"),
  send: $("btn-send"),
  stop: $("btn-stop"),
  status: $("status"),
  roomTitle: $("room-title"),
  roomsPanel: $("rooms-panel"),
  roomsList: $("rooms-list"),
  roomsSearch: $("rooms-search"),
  roomsDomain: $("rooms-domain"),
  roomsDomainCurrent: $("rooms-domain-current"),
  btnRooms: $("btn-rooms"),
  btnNew: $("btn-new"),
  btnSettings: $("btn-settings"),
  btnSitePrompt: $("btn-site-prompt"),
  sitePanel: $("site-panel"),
  sitePanelDomain: $("site-panel-domain"),
  sitePromptInput: $("site-prompt"),
  sitePromptSave: $("site-prompt-save"),
  sitePromptClear: $("site-prompt-clear"),
  sitePermsReset: $("site-perms-reset"),
  sitePanelStatus: $("site-panel-status"),
  sitePanelClose: $("site-panel-close"),
  modelSelect: $("model-select"),
  effortSelect: $("effort-select"),
  btnRefreshModels: $("btn-refresh-models"),
  versionBadge: $("version-badge"),
  tabTitle: $("tab-title"),
};

let state = {
  rooms: [],
  currentRoomId: null,
  running: false,
  runId: null,
  streamEl: null,
  streamText: "",
  reasoningEl: null,
  settings: null,
  tab: null, // текущая вкладка: { id, url, title, host, restricted }
  watchdog: null,
  windowId: null, // окно, в котором живёт ЭТА панель
  roomsFilter: "", // выбранный домен в истории чатов ("" = все сайты)
};

// ---------- хранилище ----------

async function loadState() {
  const data = await chrome.storage.local.get([
    "rooms",
    "currentRoomByWindow",
    "settings",
  ]);
  state.rooms = data.rooms || [];
  // у каждого окна своя активная комната
  const byWin = data.currentRoomByWindow || {};
  state.currentRoomId = byWin[state.windowId] || null;
  state.settings = data.settings || {};
  if (!state.rooms.length) createRoom(false);
  if (!state.currentRoomId || !getRoom())
    state.currentRoomId = state.rooms[0].id;
}

// Панелей может быть несколько (по одной на окно) — пишем со слиянием,
// иначе соседнее окно затрёт наши комнаты целиком.
async function persist() {
  const data = await chrome.storage.local.get(["rooms", "currentRoomByWindow"]);
  const stored = data.rooms || [];

  const merged = [];
  const seen = new Set();
  for (const r of state.rooms) {
    merged.push(r);
    seen.add(r.id);
  }
  for (const r of stored) {
    if (!seen.has(r.id)) merged.push(r);
  }

  const byWin = { ...(data.currentRoomByWindow || {}) };
  if (state.windowId != null) byWin[state.windowId] = state.currentRoomId;

  state.rooms = merged;
  await chrome.storage.local.set({ rooms: merged, currentRoomByWindow: byWin });
}

function getRoom() {
  return state.rooms.find((r) => r.id === state.currentRoomId);
}

function createRoom(render = true, tab = state.tab) {
  const room = {
    id: "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title: "Новый чат",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    items: [], // сырые items для Responses API
    view: [], // элементы для отрисовки
    // привязка к вкладке и к домену, с которого начался диалог
    tabId: tab ? tab.id : null,
    tabHost: tab ? tab.host || "" : "",
    tabDomain: tab ? tab.domain || normDomain(tab.host) : "",
    tabTitle: tab ? tab.title || "" : "",
    windowId: tab ? tab.windowId : state.windowId,
  };
  state.rooms.unshift(room);
  state.currentRoomId = room.id;
  if (render) {
    renderRoom();
    persist();
  }
  return room;
}

// ---------- привязка комнат к вкладкам ----------

// Тот же алгоритм, что в background.normDomain: ключ для промптов и разрешений
const MULTI_TLD =
  /\.(co|com|net|org|gov|edu|ac|or|ne|go)\.[a-z]{2}$|\.(com|net|org)\.(ua|ru|br|au|tr|mx|ar|pl|cn|in|za|sg|my|id|ph|vn|nz|hk|tw|kr|il|gr|pe|co|ve|ec|uy)$/i;

function normDomain(host) {
  let h = String(host || "")
    .toLowerCase()
    .trim();
  if (!h) return "";
  h = h
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0];
  if (!h) return "";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || !h.includes(".")) return h;
  const parts = h.split(".");
  return parts.slice(MULTI_TLD.test(h) ? -3 : -2).join(".");
}

function tabDomain(tab) {
  if (!tab) return "";
  return tab.domain || normDomain(tab.host);
}

function roomForTab(tab) {
  if (!tab) return null;
  // точное совпадение по id вкладки — самое надёжное
  let room = state.rooms.find((r) => r.tabId === tab.id);
  if (room) return room;

  // Вкладку могли перезапустить (id меняется) — ищем по домену,
  // с которым чат был связан изначально. Берём самый свежий чат домена
  // в ЭТОМ окне, иначе панели разных окон воруют чаты друг у друга.
  const dom = tabDomain(tab);
  if (dom) {
    const candidates = state.rooms
      .filter(
        (r) =>
          (r.tabDomain || normDomain(r.tabHost)) === dom &&
          (r.windowId == null || r.windowId === tab.windowId) &&
          !state.rooms.some((o) => o !== r && o.tabId === r.tabId),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    room = candidates[0];
    if (room) {
      room.tabId = tab.id;
      room.windowId = tab.windowId;
      return room;
    }
  }
  return null;
}

function applyTab(tab, { switchRoom = true } = {}) {
  state.tab = tab;
  renderTabTitle();
  loadSitePrompt();
  if (!switchRoom || !tab) return;

  const room = roomForTab(tab);
  if (room) {
    if (room.id !== state.currentRoomId) {
      state.currentRoomId = room.id;
      renderRoom();
    }
    // обновляем метаданные вкладки в комнате, но домен старта не трогаем
    room.tabId = tab.id;
    room.tabHost = tab.host || room.tabHost;
    if (!room.tabDomain) room.tabDomain = tabDomain(tab);
    room.tabTitle = tab.title || room.tabTitle;
    room.windowId = tab.windowId;
  } else {
    // для новой вкладки — новый чат, но пустую комнату переиспользуем
    const cur = getRoom();
    if (cur && !cur.items.length) {
      cur.tabId = tab.id;
      cur.tabHost = tab.host || "";
      cur.tabDomain = tabDomain(tab);
      cur.tabTitle = tab.title || "";
      cur.windowId = tab.windowId;
      renderRoom();
    } else {
      createRoom(true, tab);
    }
  }
  persist();
  renderRoomsList();
}

function renderTabTitle() {
  const t = state.tab;
  if (!t) {
    els.tabTitle.textContent = "";
    return;
  }
  els.tabTitle.classList.toggle("restricted", !!t.restricted);
  els.tabTitle.textContent = t.restricted
    ? "⚠ служебная страница — недоступна"
    : t.host || t.title || "";
  els.tabTitle.title = t.url || "";
}

async function refreshTab({ switchRoom = true } = {}) {
  try {
    const resp = await chrome.runtime.sendMessage({
      target: "background",
      action: "get_tab_info",
      windowId: state.windowId,
    });
    if (resp && resp.ok) applyTab(resp.tab, { switchRoom });
  } catch (_) {}
}

// ---------- рендер комнаты ----------

function renderRoom() {
  const room = getRoom();
  els.roomTitle.textContent = room ? room.title : "Новый чат";
  els.messages.innerHTML = "";
  if (!room || !room.view.length) {
    els.messages.appendChild(els.empty);
    els.empty.classList.remove("hidden");
    return;
  }
  els.empty.classList.add("hidden");
  for (const v of room.view) renderViewItem(v);
  scrollBottom();
}

function renderViewItem(v) {
  if (v.role === "user") {
    addUserMessage(v.text, false);
  } else if (v.role === "assistant") {
    const el = createAssistantBubble();
    el.innerHTML = renderMarkdown(v.text);
    bindCopyButtons(el);
  } else if (v.role === "tool") {
    // кнопку повтора показываем у любой плашки ошибки/остановки,
    // в том числе у сохранённых до появления флага retry
    const canRetry = !!v.retry || v.variant === "err" || v.variant === "denied";
    addChip(v.text, v.variant || "", canRetry);
  } else if (v.role === "approval") {
    const card = document.createElement("div");
    card.className =
      "approval resolved" + (v.risk === "ASK_ALWAYS" ? " danger" : "");
    card.innerHTML =
      `<div class="approval-head">${v.allowed ? "✅" : "⛔"} ${escapeHtml(v.title)}` +
      `<span class="approval-domain">${escapeHtml(v.domain || "")}</span></div>` +
      `<div class="approval-body">${v.bodyHtml}</div>` +
      `<div class="approval-actions"><span style="color:var(--text-dim);font-size:12px">` +
      `${v.allowed ? "разрешено" : "отклонено"}</span></div>`;
    els.messages.appendChild(card);
  }
}

function pushView(item) {
  const room = getRoom();
  if (!room) return;
  room.view.push(item);
  room.updatedAt = Date.now();
}

// ---------- элементы чата ----------

function hideEmpty() {
  els.empty.classList.add("hidden");
}

function addUserMessage(text, save = true) {
  hideEmpty();
  const wrap = document.createElement("div");
  wrap.className = "msg user";

  const b = document.createElement("div");
  b.className = "bubble";
  b.textContent = text;
  wrap.appendChild(b);

  // кнопка «отправить ещё раз» прямо у сообщения
  const retry = document.createElement("button");
  retry.className = "msg-retry";
  retry.type = "button";
  retry.title = "Отправить этот запрос ещё раз";
  retry.textContent = "⟳";
  retry.addEventListener("click", () => retryLast());
  wrap.appendChild(retry);

  els.messages.appendChild(wrap);
  if (save) pushView({ role: "user", text });
  scrollBottom();
}

function createAssistantBubble() {
  hideEmpty();
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const b = document.createElement("div");
  b.className = "bubble";
  wrap.appendChild(b);
  els.messages.appendChild(wrap);
  return b;
}

function addChip(text, variant = "", withRetry = false) {
  hideEmpty();
  const chip = document.createElement("div");
  chip.className = "tool-chip " + variant;
  chip.innerHTML =
    `<span class="dot"></span><span>${escapeHtml(text)}</span>` +
    (withRetry
      ? `<button class="chip-retry" type="button" title="Повторить запрос">⟳ повторить</button>`
      : "");
  els.messages.appendChild(chip);
  if (withRetry) {
    chip.querySelector(".chip-retry").addEventListener("click", () => {
      retryLast(chip);
    });
  }
  scrollBottom();
  return chip;
}

// Повтор последнего запроса: откатываем историю до последнего сообщения
// пользователя и отправляем заново.
function retryLast(chipEl) {
  if (state.running) return;
  const room = getRoom();
  if (!room) return;

  // ищем последний user-item
  let lastUserIdx = -1;
  for (let i = room.items.length - 1; i >= 0; i--) {
    if (room.items[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    addChip("нечего повторять — нет сообщений", "err");
    return;
  }

  // отрезаем всё, что модель успела наговорить после последнего вопроса
  room.items = room.items.slice(0, lastUserIdx + 1);

  // чистим отрисовку от плашки ошибки и хвоста после последнего user-сообщения
  let lastUserViewIdx = -1;
  for (let i = room.view.length - 1; i >= 0; i--) {
    if (room.view[i].role === "user") {
      lastUserViewIdx = i;
      break;
    }
  }
  if (lastUserViewIdx !== -1) {
    room.view = room.view.slice(0, lastUserViewIdx + 1);
  }

  if (chipEl) chipEl.remove();
  renderRoom();

  state.runId = "run_" + Date.now().toString(36);
  setRunning(true);
  setStatus("повторяю запрос…");
  persist();

  startWatchdog();

  chrome.runtime
    .sendMessage({
      target: "background",
      action: "run_agent",
      payload: {
        runId: state.runId,
        roomId: room.id,
        input: room.items,
        tabId: room.tabId ?? (state.tab ? state.tab.id : null),
        windowId: state.windowId,
      },
    })
    .catch((e) =>
      failRun(
        "не удалось связаться с фоновым процессом: " +
          String(e && e.message ? e.message : e),
      ),
    );
}

function scrollBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function bindCopyButtons(root) {
  root.querySelectorAll(".code-copy").forEach((btn) => {
    btn.addEventListener("click", () => {
      const code = btn.closest(".code-wrap").querySelector("code").textContent;
      navigator.clipboard.writeText(code);
      btn.textContent = "скопировано";
      setTimeout(() => (btn.textContent = "копировать"), 1500);
    });
  });
}

function setStatus(text) {
  if (!text) {
    els.status.classList.add("hidden");
    els.status.innerHTML = "";
    return;
  }
  els.status.classList.remove("hidden");
  els.status.innerHTML = `<span class="spinner"></span><span>${escapeHtml(text)}</span>`;
}

function setRunning(on) {
  state.running = on;
  els.send.classList.toggle("hidden", on);
  els.stop.classList.toggle("hidden", !on);
  if (!on) setStatus("");
}

// ---------- отправка ----------

async function send(textOverride) {
  if (state.running) return;
  const text = (
    textOverride !== undefined ? textOverride : els.input.value
  ).trim();
  if (!text) return;

  const room = getRoom();
  els.input.value = "";
  autoResize();

  addUserMessage(text);
  room.items.push({ role: "user", content: [{ type: "input_text", text }] });

  if (room.title === "Новый чат") {
    room.title = text.slice(0, 40) + (text.length > 40 ? "…" : "");
    els.roomTitle.textContent = room.title;
  }

  state.runId = "run_" + Date.now().toString(36);
  setRunning(true);
  setStatus("думаю…");
  await persist();

  startWatchdog();

  try {
    await chrome.runtime.sendMessage({
      target: "background",
      action: "run_agent",
      payload: {
        runId: state.runId,
        roomId: room.id,
        input: room.items,
        tabId: room.tabId ?? (state.tab ? state.tab.id : null),
        windowId: state.windowId,
      },
    });
  } catch (e) {
    // service worker мог быть выгружен или упасть при загрузке
    failRun(
      "не удалось связаться с фоновым процессом: " +
        String(e && e.message ? e.message : e),
    );
  }
}

// Если background молчит слишком долго — не висим бесконечно
function startWatchdog() {
  stopWatchdog();
  state.watchdog = setTimeout(() => {
    if (!state.running) return;
    failRun(
      "фоновый процесс не ответил за 60 секунд. Проверь консоль service worker на chrome://extensions",
    );
  }, 60000);
}

function stopWatchdog() {
  if (state.watchdog) {
    clearTimeout(state.watchdog);
    state.watchdog = null;
  }
}

function failRun(message) {
  stopWatchdog();
  finishStreamChunk();
  setRunning(false);
  addChip("ошибка: " + message, "err", true);
  pushView({
    role: "tool",
    text: "ошибка: " + message,
    variant: "err",
    retry: true,
  });
  persist();
}

// ---------- события из background ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "sidepanel") return;
  if (msg.type === "tab_changed") {
    // событие уходит всем панелям — реагируем только на своё окно
    if (
      state.windowId != null &&
      msg.tab &&
      msg.tab.windowId !== state.windowId
    ) {
      return;
    }
    // во время работы агента комнату не переключаем, чтобы не рвать поток
    applyTab(msg.tab, { switchRoom: !state.running });
    return;
  }
  if (msg.runId && state.runId && msg.runId !== state.runId) return;
  // background жив — перезапускаем таймер ожидания
  if (state.running) startWatchdog();
  handleEvent(msg);
});

function handleEvent(evt) {
  const room = getRoom();

  switch (evt.type) {
    case "text_start":
      state.streamEl = createAssistantBubble();
      state.streamText = "";
      setStatus("печатаю…");
      break;

    case "text_delta":
      if (!state.streamEl) {
        state.streamEl = createAssistantBubble();
        state.streamText = "";
      }
      state.streamText += evt.delta;
      state.streamEl.innerHTML = renderMarkdown(state.streamText);
      scrollBottom();
      break;

    case "reasoning_delta":
      if (!state.reasoningEl) {
        state.reasoningEl = document.createElement("div");
        state.reasoningEl.className = "reasoning";
        els.messages.appendChild(state.reasoningEl);
      }
      state.reasoningEl.textContent += evt.delta;
      scrollBottom();
      break;

    case "retrying":
      setStatus(`сервер вернул ${evt.status}, повтор ${evt.attempt}/2…`);
      break;

    case "tool_pending":
      setStatus(toolLabel(evt.name) + "…");
      break;

    case "web_search":
      addChip("поиск в интернете");
      setStatus("ищу в интернете…");
      break;

    case "tool_start":
      break;

    case "tool_auto":
      addChip(`${toolLabel(evt.name)} — ${evt.reason}`);
      pushView({
        role: "tool",
        text: `${toolLabel(evt.name)} — ${evt.reason}`,
      });
      break;

    case "tool_result": {
      const t = `${toolLabel(evt.name)}${evt.summary ? ": " + evt.summary : ""}`;
      addChip(t);
      pushView({ role: "tool", text: t });
      finishStreamChunk();
      break;
    }

    case "tool_error": {
      const t = `${toolLabel(evt.name)} — ошибка: ${evt.message}`;
      addChip(t, "err");
      pushView({ role: "tool", text: t, variant: "err" });
      break;
    }

    case "tool_denied": {
      const t = `${toolLabel(evt.name)} — отклонено`;
      addChip(t, "denied");
      pushView({ role: "tool", text: t, variant: "denied" });
      break;
    }

    case "approval_request":
      renderApproval(evt);
      setStatus("жду подтверждения…");
      break;

    case "approval_timeout":
      addChip("время на подтверждение истекло", "denied");
      break;

    case "permission_saved":
      // разрешения теперь глобальные и хранятся в background
      addChip("разрешение сохранено для " + (evt.key || "").split(":")[1]);
      break;

    case "done":
      stopWatchdog();
      finishStreamChunk();
      if (room && evt.items) {
        room.items.push(...evt.items);
      }
      setRunning(false);
      persist();
      renderRoomsList();
      break;

    case "aborted":
      stopWatchdog();
      finishStreamChunk();
      setRunning(false);
      addChip("остановлено", "denied", true);
      pushView({
        role: "tool",
        text: "остановлено",
        variant: "denied",
        retry: true,
      });
      persist();
      break;

    case "error":
      stopWatchdog();
      finishStreamChunk();
      setRunning(false);
      addChip("ошибка: " + evt.message, "err", true);
      pushView({
        role: "tool",
        text: "ошибка: " + evt.message,
        variant: "err",
        retry: true,
      });
      persist();
      break;
  }
}

function finishStreamChunk() {
  if (state.streamEl && state.streamText) {
    bindCopyButtons(state.streamEl);
    pushView({ role: "assistant", text: state.streamText });
  }
  state.streamEl = null;
  state.streamText = "";
  if (state.reasoningEl) {
    state.reasoningEl.remove();
    state.reasoningEl = null;
  }
}

function toolLabel(name) {
  return (
    {
      get_page_context: "прочитал страницу",
      read_selection: "прочитал выделение",
      scroll_to: "скролл к элементу",
      fill_form: "заполнил форму",
      click_element: "кликнул",
      open_url: "открыл ссылку",
      run_script: "выполнил скрипт",
      take_screenshot: "сделал снимок экрана",
    }[name] || name
  );
}

// ---------- карточка подтверждения ----------

function renderApproval(evt) {
  hideEmpty();
  const card = document.createElement("div");
  card.className = "approval" + (evt.risk === "ASK_ALWAYS" ? " danger" : "");

  const bodyHtml = approvalBody(evt.name, evt.args);
  const title = describeAction(evt.name, evt.args);

  card.innerHTML =
    `<div class="approval-head">⚠️ ${escapeHtml(title)}` +
    `<span class="approval-domain">${escapeHtml(evt.domain || "")}</span></div>` +
    `<div class="approval-body">${bodyHtml}</div>` +
    `<div class="approval-actions">` +
    `<button class="btn primary" data-act="allow">Разрешить</button>` +
    `<button class="btn ghost" data-act="deny">Отклонить</button>` +
    (evt.canRemember
      ? `<label class="remember"><input type="checkbox" data-remember> не спрашивать для ${escapeHtml(evt.domain || "этого сайта")}</label>`
      : "") +
    `</div>`;

  els.messages.appendChild(card);
  scrollBottom();

  const finish = (allowed) => {
    const remember = allowed && card.querySelector("[data-remember]")?.checked;
    chrome.runtime.sendMessage({
      target: "background",
      action: "approval_response",
      approvalId: evt.approvalId,
      allowed,
      remember: !!remember,
    });
    card.classList.add("resolved");
    card.querySelector(".approval-actions").innerHTML =
      `<span style="color:var(--text-dim);font-size:12px">${allowed ? "разрешено" : "отклонено"}</span>`;
    card.querySelector(".approval-head").innerHTML =
      `${allowed ? "✅" : "⛔"} ${escapeHtml(title)}<span class="approval-domain">${escapeHtml(evt.domain || "")}</span>`;
    pushView({
      role: "approval",
      title,
      domain: evt.domain,
      bodyHtml,
      allowed,
      risk: evt.risk,
    });
    persist();
  };

  card
    .querySelector('[data-act="allow"]')
    .addEventListener("click", () => finish(true));
  card
    .querySelector('[data-act="deny"]')
    .addEventListener("click", () => finish(false));
}

function approvalBody(name, args) {
  if (name === "fill_form") {
    const rows = (args.fields || [])
      .map(
        (f) =>
          `<tr><td>${escapeHtml(f.agent_id)}</td><td>${escapeHtml(String(f.value))}</td></tr>`,
      )
      .join("");
    return `<table>${rows}</table>`;
  }
  if (name === "click_element") {
    return `<table><tr><td>элемент</td><td>${escapeHtml(String(args.agent_id))}</td></tr></table>`;
  }
  if (name === "take_screenshot") {
    return (
      `<div style="margin-bottom:6px">${escapeHtml(args.reason || "нужен визуальный контекст")}</div>` +
      `<div style="color:var(--text-dim);font-size:11.5px">Снимок видимой части экрана будет отправлен в API.</div>`
    );
  }
  if (name === "open_url") {
    return (
      `<table><tr><td>адрес</td><td style="word-break:break-all">${escapeHtml(String(args.url))}</td></tr>` +
      `<tr><td>вкладка</td><td>${args.new_tab ? "новая" : "текущая"}</td></tr></table>`
    );
  }
  if (name === "run_script") {
    return (
      (args.purpose
        ? `<div style="margin-bottom:8px">${escapeHtml(args.purpose)}</div>`
        : "") + `<pre>${escapeHtml(args.code || "")}</pre>`
    );
  }
  return `<pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre>`;
}

// ---------- список комнат ----------

// домен, по которому чат сгруппирован в истории
function roomDomain(r) {
  return r.tabDomain || normDomain(r.tabHost) || "";
}

// Заполняем выпадающий фильтр: домен + число чатов. Текущий сайт — сразу под «все».
function fillDomainSelect(rooms) {
  const counts = new Map();
  for (const r of rooms) {
    const d = roomDomain(r) || "(без сайта)";
    counts.set(d, (counts.get(d) || 0) + 1);
  }

  const cur = tabDomain(state.tab);
  const domains = [...counts.keys()].sort((a, b) => {
    if (a === cur) return -1;
    if (b === cur) return 1;
    // больше чатов — выше, при равенстве по алфавиту
    const d = counts.get(b) - counts.get(a);
    return d || a.localeCompare(b);
  });

  const prev = state.roomsFilter || "";
  els.roomsDomain.innerHTML = "";

  const all = document.createElement("option");
  all.value = "";
  all.textContent = `Все сайты (${rooms.length})`;
  els.roomsDomain.appendChild(all);

  for (const d of domains) {
    const o = document.createElement("option");
    o.value = d;
    o.textContent = `${d} (${counts.get(d)})`;
    els.roomsDomain.appendChild(o);
  }

  // выбранный домен мог исчезнуть после удаления последнего чата
  if (prev && !counts.has(prev)) state.roomsFilter = "";
  els.roomsDomain.value = state.roomsFilter || "";
  els.roomsDomainCurrent.classList.toggle(
    "active",
    !!cur && state.roomsFilter === cur,
  );
}

function renderRoomsList() {
  const q = els.roomsSearch.value.trim().toLowerCase();
  const cur = tabDomain(state.tab);

  fillDomainSelect(state.rooms);

  const list = state.rooms.filter((r) => {
    if (q && !r.title.toLowerCase().includes(q)) return false;
    if (!state.roomsFilter) return true;
    return (roomDomain(r) || "(без сайта)") === state.roomsFilter;
  });

  // группируем по домену
  const groups = new Map();
  for (const r of list) {
    const d = roomDomain(r) || "(без сайта)";
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(r);
  }
  for (const arr of groups.values())
    arr.sort((a, b) => b.updatedAt - a.updatedAt);

  // порядок групп: текущий сайт → по свежести последнего чата
  const order = [...groups.keys()].sort((a, b) => {
    if (a === cur) return -1;
    if (b === cur) return 1;
    return groups.get(b)[0].updatedAt - groups.get(a)[0].updatedAt;
  });

  els.roomsList.innerHTML = "";

  if (!order.length) {
    const empty = document.createElement("div");
    empty.className = "rooms-empty";
    empty.textContent = "Ничего не найдено";
    els.roomsList.appendChild(empty);
    return;
  }

  for (const dom of order) {
    const head = document.createElement("div");
    head.className = "rooms-group" + (dom === cur ? " current" : "");
    head.innerHTML =
      `<span>${escapeHtml(dom)}</span>` +
      `<span class="count">${groups.get(dom).length}</span>`;
    els.roomsList.appendChild(head);

    for (const r of groups.get(dom)) els.roomsList.appendChild(roomItem(r));
  }
}

function roomItem(r) {
  const item = document.createElement("div");
  item.className =
    "room-item" + (r.id === state.currentRoomId ? " active" : "");
  item.innerHTML =
    `<span class="room-item-title">${escapeHtml(r.title)}` +
    (r.tabHost
      ? `<span class="room-item-host">${escapeHtml(r.tabHost)}</span>`
      : "") +
    `</span>` +
    `<button class="room-item-del" title="Удалить">✕</button>`;
  item.querySelector(".room-item-title").addEventListener("click", () => {
    state.currentRoomId = r.id;
    persist();
    renderRoom();
    toggleRooms(false);
  });
  item.querySelector(".room-item-del").addEventListener("click", (e) => {
    e.stopPropagation();
    state.rooms = state.rooms.filter((x) => x.id !== r.id);
    if (!state.rooms.length) createRoom(false);
    if (state.currentRoomId === r.id) state.currentRoomId = state.rooms[0].id;
    persist();
    renderRoomsList();
    renderRoom();
  });
  return item;
}

// ---------- системный промпт для сайта ----------

function siteStatus(text) {
  els.sitePanelStatus.textContent = text || "";
  if (text) setTimeout(() => (els.sitePanelStatus.textContent = ""), 2000);
}

async function loadSitePrompt() {
  const dom = tabDomain(state.tab);
  els.sitePanelDomain.textContent = dom || "—";
  if (!dom) {
    els.sitePromptInput.value = "";
    els.btnSitePrompt.classList.remove("active");
    return;
  }
  try {
    const resp = await chrome.runtime.sendMessage({
      target: "background",
      action: "get_site_prompt",
      domain: dom,
    });
    const text = (resp && resp.prompt) || "";
    els.sitePromptInput.value = text;
    // подсвечиваем кнопку, если для домена уже что-то задано
    els.btnSitePrompt.classList.toggle("active", !!text.trim());
  } catch (_) {}
}

function toggleSitePanel(force) {
  const show =
    force !== undefined ? force : els.sitePanel.classList.contains("hidden");
  els.sitePanel.classList.toggle("hidden", !show);
  if (show) {
    toggleRooms(false);
    loadSitePrompt();
    els.sitePromptInput.focus();
  }
}

async function saveSitePrompt(text) {
  const dom = tabDomain(state.tab);
  if (!dom) {
    siteStatus("нет домена");
    return;
  }
  await chrome.runtime.sendMessage({
    target: "background",
    action: "save_site_prompt",
    domain: dom,
    prompt: text,
  });
  els.btnSitePrompt.classList.toggle("active", !!String(text).trim());
  siteStatus("сохранено");
}

els.btnSitePrompt.addEventListener("click", () => toggleSitePanel());
els.sitePanelClose.addEventListener("click", () => toggleSitePanel(false));
els.sitePromptSave.addEventListener("click", () =>
  saveSitePrompt(els.sitePromptInput.value),
);
els.sitePromptClear.addEventListener("click", () => {
  els.sitePromptInput.value = "";
  saveSitePrompt("");
});
els.sitePermsReset.addEventListener("click", async () => {
  const dom = tabDomain(state.tab);
  if (!dom) return;
  await chrome.runtime.sendMessage({
    target: "background",
    action: "reset_permissions",
    domain: dom,
  });
  siteStatus("разрешения сброшены");
});

function toggleRooms(force) {
  const show =
    force !== undefined ? force : els.roomsPanel.classList.contains("hidden");
  els.roomsPanel.classList.toggle("hidden", !show);
  if (show) {
    els.sitePanel.classList.add("hidden");
    renderRoomsList();
    els.roomsSearch.focus();
  }
}

// ---------- ввод ----------

function autoResize() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
}

els.input.addEventListener("input", autoResize);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

els.send.addEventListener("click", () => send());
els.stop.addEventListener("click", () => {
  chrome.runtime.sendMessage({
    target: "background",
    action: "abort",
    runId: state.runId,
  });
});
// Новая задача: чистый контекст, старый чат остаётся в истории этого домена
els.btnNew.addEventListener("click", () => {
  createRoom(true, state.tab);
  toggleRooms(false);
  toggleSitePanel(false);
  renderRoomsList();
});
els.btnRooms.addEventListener("click", () => toggleRooms());
els.btnSettings.addEventListener("click", () =>
  chrome.runtime.openOptionsPage(),
);
els.roomsSearch.addEventListener("input", renderRoomsList);
els.roomsDomain.addEventListener("change", () => {
  state.roomsFilter = els.roomsDomain.value;
  renderRoomsList();
});
// быстрый переход к чатам текущего сайта, повторный клик снимает фильтр
els.roomsDomainCurrent.addEventListener("click", () => {
  const cur = tabDomain(state.tab);
  if (!cur) return;
  state.roomsFilter = state.roomsFilter === cur ? "" : cur;
  renderRoomsList();
});

document.querySelectorAll(".hint").forEach((b) => {
  b.addEventListener("click", () => {
    const p = b.dataset.prompt;
    if (p.endsWith(": ") || p.endsWith(" ")) {
      els.input.value = p;
      els.input.focus();
      autoResize();
    } else {
      send(p);
    }
  });
});

// ---------- модель и уровень рассуждений ----------

function currentSettings() {
  const s = state.settings || {};
  return {
    baseUrl: s.baseUrl || CONFIG.baseUrl,
    apiKey: s.apiKey || CONFIG.apiKey,
    model: s.model || CONFIG.model,
    effort: isValidEffort(s.effort) ? s.effort : CONFIG.effort,
    webSearch: s.webSearch !== false,
  };
}

function fillModelSelect(ids, selected) {
  const list = ids.includes(selected) ? ids : [selected, ...ids];
  els.modelSelect.innerHTML = "";
  for (const id of list) {
    if (!id) continue;
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id;
    if (id === selected) o.selected = true;
    els.modelSelect.appendChild(o);
  }
}

async function loadModels(force = false) {
  const cfg = currentSettings();
  const cached = await chrome.storage.local.get(["modelsCache"]);
  const cache = cached.modelsCache;

  // кэш живёт сутки
  if (
    !force &&
    cache &&
    Date.now() - cache.ts < 86400000 &&
    cache.ids?.length
  ) {
    fillModelSelect(cache.ids, cfg.model);
    return;
  }

  els.btnRefreshModels.classList.add("spin");
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/v1/models", {
      headers: { Authorization: "Bearer " + cfg.apiKey },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const ids = (json.data || []).map((m) => m.id).sort();
    if (ids.length) {
      fillModelSelect(ids, cfg.model);
      await chrome.storage.local.set({ modelsCache: { ts: Date.now(), ids } });
    }
  } catch (e) {
    if (force) addChip("не удалось загрузить модели: " + e.message, "err");
    fillModelSelect([cfg.model], cfg.model);
  } finally {
    els.btnRefreshModels.classList.remove("spin");
  }
}

async function saveSetting(patch) {
  const { settings } = await chrome.storage.local.get(["settings"]);
  const next = { ...CONFIG, ...(settings || {}), ...patch };
  state.settings = next;
  await chrome.storage.local.set({ settings: next });
}

els.modelSelect.addEventListener("change", () => {
  saveSetting({ model: els.modelSelect.value });
});
els.effortSelect.addEventListener("change", () => {
  saveSetting({ effort: els.effortSelect.value });
});
els.btnRefreshModels.addEventListener("click", () => loadModels(true));

// ---------- старт ----------

(async () => {
  // окно, в котором открыта эта панель — по нему фильтруем события вкладок
  try {
    const win = await chrome.windows.getCurrent();
    state.windowId = win.id;
  } catch (_) {}

  await loadState();
  renderRoom();
  const cfg = currentSettings();
  els.effortSelect.value = cfg.effort;
  fillModelSelect([cfg.model], cfg.model);
  loadModels(false);
  try {
    els.versionBadge.textContent = "v" + chrome.runtime.getManifest().version;
  } catch (_) {}
  // определяем текущую вкладку и открываем её комнату
  await refreshTab({ switchRoom: true });
})();

// панель могла проспать события — освежаем вкладку при возврате фокуса
window.addEventListener("focus", () => refreshTab({ switchRoom: false }));
