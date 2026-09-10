// Определения tool'ов агента и уровни риска.
// SAFE       - выполняется без подтверждения
// ASK        - карточка подтверждения, можно разрешить на домен в пределах комнаты
// ASK_ALWAYS - карточка подтверждения всегда, без возможности отключить

export const RISK = {
  SAFE: "SAFE",
  ASK: "ASK",
  ASK_ALWAYS: "ASK_ALWAYS",
};

export const TOOL_RISK = {
  get_page_context: RISK.SAFE,
  read_selection: RISK.SAFE,
  scroll_to: RISK.SAFE,
  take_screenshot: RISK.ASK,
  fill_form: RISK.ASK,
  click_element: RISK.ASK,
  open_url: RISK.ASK,
  run_script: RISK.ASK_ALWAYS,
};

// Схемы функций в формате Responses API (плоские, без вложенного "function")
export const FUNCTION_TOOLS = [
  {
    type: "function",
    name: "get_page_context",
    description:
      "Прочитать текущую страницу: URL, заголовок, видимый текст и карту интерактивных элементов. " +
      "Каждый элемент получает agent_id — используй ТОЛЬКО его для действий, CSS-селекторы не поддерживаются. " +
      "Вызывай этот tool перед любой работой со страницей и повторно после изменений DOM.",
    parameters: {
      type: "object",
      properties: {
        include_text: {
          type: "boolean",
          description: "Включать видимый текст страницы. По умолчанию true.",
        },
        max_text_length: {
          type: "number",
          description:
            "Максимальная длина текста в символах. По умолчанию 12000.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "read_selection",
    description:
      "Получить текст, выделенный пользователем на странице. Полезно для перевода и объяснения.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "scroll_to",
    description:
      "Проскроллить страницу к элементу по agent_id и подсветить его.",
    parameters: {
      type: "object",
      properties: {
        agent_id: {
          type: "string",
          description: "agent_id элемента из get_page_context",
        },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "take_screenshot",
    description:
      "Сделать снимок видимой части страницы и увидеть его своими глазами. " +
      "Используй ТОЛЬКО когда текста из get_page_context недостаточно: график/диаграмма/canvas, " +
      "картинки без alt, вопрос про внешний вид и вёрстку, визуальный элемент без текстового описания. " +
      "Для обычного чтения текста и работы с формами скриншот НЕ нужен — get_page_context точнее и дешевле. " +
      "Снимается только то, что сейчас на экране: при необходимости сначала вызови scroll_to.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Коротко на русском, зачем нужен снимок — пользователь увидит это в запросе подтверждения",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "fill_form",
    description:
      "Заполнить поля формы. Значения устанавливаются так, чтобы их видели React/Vue. " +
      'Для checkbox/radio передавай value "true"/"false". Для select — текст или value опции.',
    parameters: {
      type: "object",
      properties: {
        fields: {
          type: "array",
          description: "Список полей для заполнения",
          items: {
            type: "object",
            properties: {
              agent_id: { type: "string" },
              value: { type: "string" },
            },
            required: ["agent_id", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["fields"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "click_element",
    description: "Кликнуть по элементу (кнопка, ссылка, чекбокс) по agent_id.",
    parameters: {
      type: "object",
      properties: { agent_id: { type: "string" } },
      required: ["agent_id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "open_url",
    description: "Открыть URL в текущей или новой вкладке.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Полный URL со схемой https://" },
        new_tab: {
          type: "boolean",
          description:
            "true — новая вкладка, false — текущая. По умолчанию false.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "run_script",
    description:
      "Выполнить произвольный JavaScript в контексте страницы (MAIN world). Используй, когда остальных tool'ов не хватает: " +
      "изменить вёрстку, извлечь данные, автоматизировать сложное действие. " +
      "Код должен быть телом функции и возвращать сериализуемый результат через return. " +
      "Пользователь увидит код целиком и должен его одобрить, поэтому пиши компактно и понятно.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: 'Тело функции на JS. Пример: "return document.title;"',
        },
        purpose: {
          type: "string",
          description: "Короткое объяснение на русском, что делает код и зачем",
        },
      },
      required: ["code", "purpose"],
      additionalProperties: false,
    },
  },
];

// Нативный веб-поиск Responses API — на нашей стороне не реализуется
export const WEB_SEARCH_TOOL = { type: "web_search" };

export function buildTools({ webSearch = true } = {}) {
  return webSearch ? [...FUNCTION_TOOLS, WEB_SEARCH_TOOL] : [...FUNCTION_TOOLS];
}

// Человекочитаемое описание действия для карточки подтверждения
export function describeAction(name, args) {
  switch (name) {
    case "fill_form": {
      const n = args?.fields?.length || 0;
      return `Заполнить ${n} ${plural(n, "поле", "поля", "полей")} формы`;
    }
    case "click_element":
      return "Кликнуть по элементу страницы";
    case "take_screenshot":
      return "Сделать снимок видимой части страницы";
    case "open_url":
      return args?.new_tab ? "Открыть новую вкладку" : "Перейти по адресу";
    case "run_script":
      return "Выполнить JavaScript на странице";
    default:
      return name;
  }
}

function plural(n, one, few, many) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
