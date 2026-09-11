// Шаблон конфигурации. Скопируй в config.js и подставь свои значения:
//   cp config.example.js config.js
//
// config.js в .gitignore — ключ остаётся только на твоей машине.
// Настройки из chrome.storage.local (страница ⚙) имеют приоритет над этими значениями.

export const CONFIG = {
  // Базовый URL OpenAI-совместимого API. Без слеша на конце.
  baseUrl: "https://api.openai.com",
  // API-ключ. НИКОГДА не коммить его в репозиторий.
  apiKey: "",
  model: "gpt-4o",
  // none | low | medium | high | xhigh | max
  // Какие значения реально поддерживаются — зависит от твоего провайдера.
  effort: "max",
  webSearch: true,
  // Отдельная модель для нативного веб-поиска (тот же baseUrl и ключ).
  // Пусто — поиск выполняет основная модель, как раньше.
  searchModel: "",
  // Глобальный системный промпт для всех сайтов (редактируется в настройках ⚙).
  systemPrompt: "",
};

// Уровни рассуждений, доступные в UI.
export const EFFORT_LEVELS = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Maximum" },
];

export function isValidEffort(v) {
  return EFFORT_LEVELS.some((e) => e.value === v);
}
