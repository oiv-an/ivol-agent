// options.html грузится как обычный скрипт, поэтому config.js импортировать нельзя.
// Ключ здесь НЕ хранится: он берётся из chrome.storage.local или из config.js
// через background (см. loadSettings). Эти значения — только запасные заглушки.
const DEFAULTS = {
  baseUrl: "",
  apiKey: "",
  model: "",
  effort: "max",
  webSearch: true,
  systemPrompt: "",
};

const $ = (id) => document.getElementById(id);
const el = {
  baseUrl: $("baseUrl"),
  apiKey: $("apiKey"),
  model: $("model"),
  effort: $("effort"),
  webSearch: $("webSearch"),
  systemPrompt: $("systemPrompt"),
  save: $("save"),
  test: $("test"),
  reload: $("reload"),
  status: $("status"),
};

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = "status " + cls;
}

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

function fillModelSelect(ids, selected) {
  el.model.innerHTML = "";
  const all = ids.includes(selected) ? ids : [selected, ...ids];
  for (const id of all) {
    if (!id) continue;
    const o = document.createElement("option");
    o.value = id;
    o.textContent = id;
    if (id === selected) o.selected = true;
    el.model.appendChild(o);
  }
}

// Настройки собирает background: он единственный видит config.js.
async function fetchSettings() {
  try {
    const s = await chrome.runtime.sendMessage({
      target: "background",
      action: "get_settings",
    });
    if (s && typeof s === "object") return { ...DEFAULTS, ...s };
  } catch (e) {
    console.debug("[IVOL] get_settings failed:", e && e.message);
  }
  const { settings } = await chrome.storage.local.get(["settings"]);
  return { ...DEFAULTS, ...(settings || {}) };
}

async function load() {
  const s = await fetchSettings();
  el.baseUrl.value = s.baseUrl;
  el.apiKey.value = s.apiKey;
  el.effort.value = s.effort;
  el.webSearch.checked = s.webSearch !== false;
  el.systemPrompt.value = s.systemPrompt || "";
  fillModelSelect([s.model], s.model);
  if (s.apiKey) loadModels(true);
}

async function loadModels(silent = false) {
  const baseUrl = trimSlash(el.baseUrl.value || DEFAULTS.baseUrl);
  const apiKey = el.apiKey.value.trim();
  if (!apiKey) {
    if (!silent) setStatus("Сначала введи ключ", "err");
    return;
  }
  if (!silent) setStatus("Загружаю модели…");
  try {
    const res = await fetch(baseUrl + "/v1/models", {
      headers: { Authorization: "Bearer " + apiKey },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const json = await res.json();
    const ids = (json.data || []).map((m) => m.id).sort();
    fillModelSelect(ids, el.model.value || DEFAULTS.model);
    if (!silent) setStatus(`Загружено моделей: ${ids.length}`, "ok");
  } catch (e) {
    if (!silent) setStatus("Не удалось загрузить: " + e.message, "err");
  }
}

async function save() {
  const settings = {
    baseUrl: trimSlash(el.baseUrl.value || DEFAULTS.baseUrl),
    apiKey: el.apiKey.value.trim(),
    model: el.model.value || DEFAULTS.model,
    effort: el.effort.value,
    webSearch: el.webSearch.checked,
    systemPrompt: el.systemPrompt.value.trim(),
  };
  await chrome.storage.local.set({ settings });
  setStatus("Сохранено", "ok");
  setTimeout(() => setStatus(""), 2000);
}

async function test() {
  setStatus("Проверяю…");
  const baseUrl = trimSlash(el.baseUrl.value || DEFAULTS.baseUrl);
  try {
    const res = await fetch(baseUrl + "/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + el.apiKey.value.trim(),
      },
      body: JSON.stringify({
        model: el.model.value,
        input: "Ответь одним словом: ок",
        reasoning: { effort: el.effort.value },
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error?.message || "HTTP " + res.status);
    const text = (json.output || [])
      .flatMap((i) => i.content || [])
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join(" ");
    setStatus(`OK · модель ${json.model} · ответ: ${text.slice(0, 40)}`, "ok");
  } catch (e) {
    setStatus("Ошибка: " + e.message, "err");
  }
}

el.save.addEventListener("click", save);
el.test.addEventListener("click", test);
el.reload.addEventListener("click", () => loadModels(false));
el.apiKey.addEventListener("change", () => loadModels(true));

load();
