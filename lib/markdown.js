// Минималистичный markdown-рендер без внешних зависимостей.
// Возвращает безопасный HTML: любой пользовательский/модельный текст экранируется.

export function renderMarkdown(src) {
  const text = String(src || "");
  const blocks = [];

  // 1. вырезаем блоки кода
  let work = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const i = blocks.length;
    blocks.push({ lang: lang || "", code: code.replace(/\n$/, "") });
    return `\u0000BLOCK${i}\u0000`;
  });

  work = escapeHtml(work);

  // 2. блочные элементы
  const lines = work.split("\n");
  const out = [];
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push("<p>" + inline(paragraph.join("<br>")) + "</p>");
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    const blockMatch = line.match(/^\u0000BLOCK(\d+)\u0000$/);
    if (blockMatch) {
      flushParagraph();
      closeList();
      const b = blocks[Number(blockMatch[1])];
      out.push(codeBlock(b));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushParagraph();
      closeList();
      const lvl = h[1].length + 1;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      closeList();
      out.push("<hr>");
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushParagraph();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push("<li>" + inline(ul[1]) + "</li>");
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushParagraph();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push("<li>" + inline(ol[1]) + "</li>");
      continue;
    }

    const bq = line.match(/^&gt;\s?(.*)$/);
    if (bq) {
      flushParagraph();
      closeList();
      out.push("<blockquote>" + inline(bq[1]) + "</blockquote>");
      continue;
    }

    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();

  // 3. подставляем оставшиеся инлайновые блоки кода (если оказались внутри абзаца)
  let html = out.join("\n");
  html = html.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, i) =>
    codeBlock(blocks[Number(i)]),
  );
  return html;
}

function codeBlock(b) {
  if (!b) return "";
  const lang = b.lang
    ? `<span class="code-lang">${escapeHtml(b.lang)}</span>`
    : "";
  return (
    `<div class="code-wrap">` +
    `<div class="code-head">${lang}<button class="code-copy" type="button">копировать</button></div>` +
    `<pre><code>${escapeHtml(b.code)}</code></pre>` +
    `</div>`
  );
}

function inline(s) {
  let r = s;
  // inline code
  r = r.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`);
  // bold
  r = r.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  r = r.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // italic
  r = r.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // links [text](url)
  r = r.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, t, u) =>
      `<a href="${u}" target="_blank" rel="noreferrer noopener">${t}</a>`,
  );
  // голые ссылки
  r = r.replace(
    /(^|[\s(])(https?:\/\/[^\s<)]+)/g,
    (_m, pre, u) =>
      `${pre}<a href="${u}" target="_blank" rel="noreferrer noopener">${u}</a>`,
  );
  return r;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
