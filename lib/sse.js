// Парсер SSE-потока Responses API.
// Отдаёт события вида { type, ...payload } через async-итератор.

export async function* parseSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // события разделяются пустой строкой
      let sep;
      while ((sep = findSeparator(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        const evt = parseEvent(rawEvent);
        if (evt) yield evt;
      }
    }
    // хвост
    const evt = parseEvent(buffer);
    if (evt) yield evt;
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {}
  }
}

function findSeparator(buf) {
  const i1 = buf.indexOf("\n\n");
  const i2 = buf.indexOf("\r\n\r\n");
  if (i1 === -1 && i2 === -1) return -1;
  if (i2 === -1 || (i1 !== -1 && i1 < i2)) return { index: i1, length: 2 };
  return { index: i2, length: 4 };
}

function parseEvent(raw) {
  if (!raw || !raw.trim()) return null;
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return { type: "done" };
  try {
    return JSON.parse(data);
  } catch (_) {
    return null;
  }
}
