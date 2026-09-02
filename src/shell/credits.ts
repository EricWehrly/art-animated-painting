/// <reference types="vite/client" />

// `docs/credits.md` is the single source of truth for this content — imported as raw text
// (Vite's `?raw` suffix, see vite/client.d.ts) rather than duplicated here, so the doc and the
// in-scene panel can't drift apart. See docs/credits.md's own note about this.
import creditsMarkdown from "../../docs/credits.md?raw";

export interface CreditsModalHandle {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/**
 * A small "credits" button (fixed corner, matching index.html's `#swatch-link` styling
 * pattern) that opens a modal overlay rendering `docs/credits.md`. Self-contained — no
 * Tweakpane dependency, mirroring shell/timeline.ts.
 */
export function createCreditsModal(container: HTMLElement): CreditsModalHandle {
  const button = document.createElement("button");
  button.id = "credits-link";
  button.type = "button";
  button.textContent = "credits";
  button.style.cssText =
    "position:fixed;top:40px;left:16px;z-index:10;font:12px system-ui,sans-serif;color:#eee;" +
    "text-decoration:none;background:rgba(0,0,0,0.35);padding:4px 8px;border-radius:4px;" +
    "border:none;cursor:pointer;";

  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;" +
    "background:rgba(0,0,0,0.6);font:13px/1.5 system-ui,sans-serif;color:#eee;";

  const panel = document.createElement("div");
  panel.style.cssText =
    "position:relative;max-width:560px;width:calc(100% - 48px);max-height:80vh;overflow-y:auto;" +
    "background:#1c1912;border:1px solid rgba(255,255,255,0.1);border-radius:8px;" +
    "padding:28px 28px 20px;box-shadow:0 10px 40px rgba(0,0,0,0.5);";

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.setAttribute("aria-label", "close credits");
  closeButton.textContent = "×"; // ×
  closeButton.style.cssText =
    "position:absolute;top:10px;right:12px;background:none;border:none;color:#eee;" +
    "font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;";

  const content = document.createElement("div");
  content.innerHTML = renderMarkdownToHtml(creditsMarkdown);
  applyContentStyles(content);

  panel.appendChild(closeButton);
  panel.appendChild(content);
  overlay.appendChild(panel);
  container.appendChild(button);
  container.appendChild(overlay);

  function open() {
    overlay.style.display = "flex";
  }
  function close() {
    overlay.style.display = "none";
  }

  button.addEventListener("click", open);
  closeButton.addEventListener("click", close);
  // Click-outside: only the overlay backdrop itself closes, not clicks that bubble up from
  // inside the panel (a click starting inside the panel and released there never reaches this
  // handler with `target === overlay`).
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.style.display !== "none") close();
  });

  return { element: overlay, open, close };
}

/** Minimal, dependency-free renderer for the small subset of Markdown docs/credits.md
 * actually uses: #/##/### headings, "- " bullet lists, "> " blockquotes, blank-line-separated
 * paragraphs, and inline **bold** / [text](url) / `code`. Not a general Markdown parser — just
 * enough to render this one doc without pulling in a library for a single credits panel. */
function renderMarkdownToHtml(markdown: string): string {
  const lines = markdown.split("\n");
  let html = "";
  let inList = false;
  let paragraphBuffer: string[] = [];

  const closeList = () => {
    if (inList) {
      html += "</ul>";
      inList = false;
    }
  };
  const flushParagraph = () => {
    if (paragraphBuffer.length) {
      html += `<p>${renderInline(paragraphBuffer.join(" "))}</p>`;
      paragraphBuffer = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("### ")) {
      flushParagraph();
      closeList();
      html += `<h3>${renderInline(line.slice(4))}</h3>`;
    } else if (line.startsWith("## ")) {
      flushParagraph();
      closeList();
      html += `<h2>${renderInline(line.slice(3))}</h2>`;
    } else if (line.startsWith("# ")) {
      flushParagraph();
      closeList();
      html += `<h1>${renderInline(line.slice(2))}</h1>`;
    } else if (line.startsWith("> ")) {
      flushParagraph();
      closeList();
      html += `<blockquote>${renderInline(line.slice(2))}</blockquote>`;
    } else if (line.startsWith("- ")) {
      flushParagraph();
      if (!inList) {
        html += "<ul>";
        inList = true;
      }
      html += `<li>${renderInline(line.slice(2))}</li>`;
    } else if (line === "") {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraphBuffer.push(line);
    }
  }
  flushParagraph();
  closeList();
  return html;
}

function renderInline(text: string): string {
  let t = escapeHtml(text);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  return t;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Inline styling for the rendered content — kept here rather than a stylesheet since this
 * module owns its own DOM entirely, same spirit as shell/timeline.ts's inline `cssText`s. */
function applyContentStyles(content: HTMLElement) {
  const style = document.createElement("style");
  style.textContent = `
    #credits-link:hover { background: rgba(0,0,0,0.55); }
    .credits-content h1 { font-size: 16px; margin: 0 0 12px; }
    .credits-content h2 { font-size: 14px; margin: 20px 0 8px; color: #fff; }
    .credits-content h2:first-child { margin-top: 0; }
    .credits-content h3 { font-size: 13px; margin: 14px 0 6px; color: #ddd; }
    .credits-content p { margin: 0 0 10px; color: #ccc; }
    .credits-content ul { margin: 0 0 10px; padding-left: 20px; color: #ccc; }
    .credits-content li { margin: 0 0 4px; }
    .credits-content blockquote {
      margin: 0 0 10px; padding: 6px 12px; border-left: 2px solid rgba(255,255,255,0.25);
      color: #bbb; font-style: italic;
    }
    .credits-content code { background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; }
    .credits-content a { color: #9fd0ff; }
  `;
  content.classList.add("credits-content");
  content.prepend(style);
}
