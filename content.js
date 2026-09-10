// Content script: карта интерактивных элементов, чтение страницы, заполнение форм, клики, скролл.
// Инжектится по требованию из background через chrome.scripting.executeScript.

(() => {
  if (window.__ivolAgentContentLoaded) return;
  window.__ivolAgentContentLoaded = true;

  const ATTR = "data-ivol-agent-id";
  let counter = 0;

  const INTERACTIVE_SELECTOR = [
    "input:not([type=hidden])",
    "textarea",
    "select",
    "button",
    "a[href]",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=tab]",
    '[contenteditable=""]',
    '[contenteditable="true"]',
  ].join(",");

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.target !== "content") return;
    Promise.resolve()
      .then(() => handle(msg))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) =>
        sendResponse({
          ok: false,
          error: String(e && e.message ? e.message : e),
        }),
      );
    return true; // async
  });

  async function handle(msg) {
    switch (msg.action) {
      case "ping":
        return { pong: true };
      case "get_page_context":
        return getPageContext(msg.args || {});
      case "read_selection":
        return { selection: String(window.getSelection() || "") };
      case "scroll_to":
        return scrollTo(msg.args);
      case "fill_form":
        return fillForm(msg.args);
      case "click_element":
        return clickElement(msg.args);
      case "describe_elements":
        return describeElements(msg.args);
      default:
        throw new Error("Неизвестное действие: " + msg.action);
    }
  }

  // ---------- карта элементов ----------

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.opacity === "0"
    )
      return false;
    return true;
  }

  function labelFor(el) {
    // <label for="id">
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.innerText.trim()) return clean(l.innerText);
    }
    // обёртка <label>
    const wrap = el.closest("label");
    if (wrap && wrap.innerText.trim()) return clean(wrap.innerText);
    // aria
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const l = document.getElementById(labelledBy);
      if (l && l.innerText.trim()) return clean(l.innerText);
    }
    // соседний текст сверху
    const prev = el.previousElementSibling;
    if (prev && prev.innerText && prev.innerText.trim().length < 80)
      return clean(prev.innerText);
    return "";
  }

  function clean(s) {
    return String(s).replace(/\s+/g, " ").trim().slice(0, 120);
  }

  function tagInfo(el) {
    const tag = el.tagName.toLowerCase();
    let type = tag;
    if (tag === "input")
      type = "input[" + (el.getAttribute("type") || "text") + "]";
    else if (el.getAttribute("role"))
      type = tag + "[role=" + el.getAttribute("role") + "]";
    else if (el.isContentEditable) type = "contenteditable";
    return type;
  }

  function markAll() {
    const nodes = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
    const items = [];
    for (const el of nodes) {
      if (!isVisible(el)) continue;
      let id = el.getAttribute(ATTR);
      if (!id) {
        id = "a" + ++counter;
        el.setAttribute(ATTR, id);
      }
      items.push({ id, el });
      if (items.length >= 400) break; // защита от монстро-страниц
    }
    return items;
  }

  function serializeElement(id, el) {
    const type = tagInfo(el);
    const item = { agent_id: id, type };

    const label = labelFor(el);
    if (label) item.label = label;

    const ph = el.getAttribute("placeholder");
    if (ph) item.placeholder = clean(ph);

    const name = el.getAttribute("name");
    if (name) item.name = name;

    if (el.required) item.required = true;

    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") item.checked = !!el.checked;
      else if (t !== "password") item.value = clean(el.value || "");
      else item.value = el.value ? "***" : "";
    } else if (tag === "select") {
      item.value = clean(el.value || "");
      item.options = Array.from(el.options)
        .slice(0, 30)
        .map((o) => clean(o.text));
    } else if (el.isContentEditable) {
      item.value = clean(el.innerText || "");
    } else {
      const text = clean(
        el.innerText || el.value || el.getAttribute("title") || "",
      );
      if (text) item.text = text;
      if (tag === "a") {
        const href = el.getAttribute("href") || "";
        if (href && !href.startsWith("javascript:"))
          item.href = href.slice(0, 200);
      }
    }
    return item;
  }

  function getPageContext(args) {
    const includeText = args.include_text !== false;
    const maxLen = Math.min(Number(args.max_text_length) || 12000, 40000);

    const marked = markAll();
    const elements = marked.map(({ id, el }) => serializeElement(id, el));

    const result = {
      url: location.href,
      title: document.title,
      elements,
    };

    if (includeText) result.text = extractText(maxLen);

    const sel = String(window.getSelection() || "").trim();
    if (sel) result.selection = sel.slice(0, 4000);

    return result;
  }

  function extractText(maxLen) {
    const root =
      document.querySelector("main, article, [role=main]") || document.body;
    const clone = root.cloneNode(true);
    clone
      .querySelectorAll("script, style, noscript, svg, iframe, template")
      .forEach((n) => n.remove());
    let text = clone.innerText || "";
    text = text
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    if (text.length > maxLen)
      text = text.slice(0, maxLen) + "\n…[текст обрезан]";
    return text;
  }

  function byAgentId(agentId) {
    const el = document.querySelector(
      `[${ATTR}="${CSS.escape(String(agentId))}"]`,
    );
    if (!el)
      throw new Error(
        `Элемент ${agentId} не найден. Вызови get_page_context заново — страница могла измениться.`,
      );
    return el;
  }

  function describeElements(args) {
    const ids = args?.agent_ids || [];
    return ids.map((id) => {
      try {
        const el = byAgentId(id);
        return serializeElement(id, el);
      } catch (e) {
        return { agent_id: id, error: "не найден" };
      }
    });
  }

  // ---------- действия ----------

  function scrollTo(args) {
    const el = byAgentId(args.agent_id);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    highlight(el);
    return { ok: true };
  }

  function highlight(el) {
    const prev = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = "3px solid #10a37f";
    el.style.outlineOffset = "2px";
    setTimeout(() => {
      el.style.outline = prev;
      el.style.outlineOffset = prevOffset;
    }, 1600);
  }

  // Установка значения так, чтобы React/Vue увидели изменение
  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInput(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillForm(args) {
    const fields = args?.fields || [];
    const filled = [];
    const failed = [];

    for (const f of fields) {
      try {
        const el = byAgentId(f.agent_id);
        el.scrollIntoView({ block: "center" });
        el.focus({ preventScroll: true });

        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();

        if (tag === "input" && (type === "checkbox" || type === "radio")) {
          const want = /^(true|1|yes|да|on|checked)$/i.test(String(f.value));
          if (el.checked !== want) el.click();
          filled.push({ agent_id: f.agent_id, checked: el.checked });
        } else if (tag === "select") {
          const target = String(f.value);
          let matched = null;
          for (const o of el.options) {
            if (o.value === target || o.text.trim() === target.trim()) {
              matched = o;
              break;
            }
          }
          if (!matched) {
            for (const o of el.options) {
              if (o.text.toLowerCase().includes(target.toLowerCase())) {
                matched = o;
                break;
              }
            }
          }
          if (!matched) throw new Error(`опция "${target}" не найдена`);
          el.value = matched.value;
          fireInput(el);
          filled.push({ agent_id: f.agent_id, value: matched.text.trim() });
        } else if (el.isContentEditable) {
          el.innerText = String(f.value);
          fireInput(el);
          filled.push({ agent_id: f.agent_id, value: String(f.value) });
        } else {
          setNativeValue(el, String(f.value));
          fireInput(el);
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          filled.push({ agent_id: f.agent_id, value: String(f.value) });
        }
        highlight(el);
      } catch (e) {
        failed.push({ agent_id: f.agent_id, error: String(e.message || e) });
      }
    }

    return { filled, failed };
  }

  function clickElement(args) {
    const el = byAgentId(args.agent_id);
    const urlBefore = location.href;
    const label = clean(
      el.innerText || el.value || el.getAttribute("aria-label") || "",
    );
    el.scrollIntoView({ block: "center" });
    highlight(el);
    el.click();
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({
          ok: true,
          clicked: label,
          url_changed: location.href !== urlBefore,
          url: location.href,
        });
      }, 350);
    });
  }
})();
