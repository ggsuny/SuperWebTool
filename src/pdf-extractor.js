/* global pdfjsLib */
(() => {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.js");

  window.addEventListener("message", async (event) => {
    const message = event.data || {};
    if (message.type !== "PIT_EXTRACT_PDF_TEXT") return;

    try {
      const text = await extractPdfText(message.buffer);
      event.source?.postMessage({
        type: "PIT_EXTRACT_PDF_TEXT_RESULT",
        requestId: message.requestId,
        ok: true,
        text
      }, event.origin || "*");
    } catch (error) {
      event.source?.postMessage({
        type: "PIT_EXTRACT_PDF_TEXT_RESULT",
        requestId: message.requestId,
        ok: false,
        error: error?.message || String(error)
      }, event.origin || "*");
    }
  });

  async function extractPdfText(buffer) {
    if (!buffer) throw new Error("PDF 数据为空。");
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    const pdf = await loadingTask.promise;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = textItemsToParagraphs(content.items || []);
      if (text) pages.push(`第 ${pageNumber} 页\n${text}`);
    }

    await pdf.destroy();
    return pages.join("\n\n").trim();
  }

  function textItemsToParagraphs(items) {
    const lines = [];
    let current = "";
    let lastY = null;

    for (const item of items) {
      const value = String(item.str || "").trim();
      if (!value) continue;
      const y = Math.round(Number(item.transform?.[5] || 0));
      if (lastY !== null && Math.abs(y - lastY) > 5 && current.trim()) {
        lines.push(current.trim());
        current = "";
      }
      current = current ? `${current} ${value}` : value;
      lastY = y;
    }

    if (current.trim()) lines.push(current.trim());
    return lines
      .join("\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
})();
