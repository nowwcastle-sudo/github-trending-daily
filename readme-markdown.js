/* Safe, deliberately small Markdown renderer for repository README panels. */
(function (root) {
  "use strict";

  const CONTROL = /[\u0000-\u001f\u007f]/;
  const BLOB_SHA = /^[a-f0-9]{40}$/i;

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function escapeNonCode(value) {
    const neutralized = String(value).replace(/<[^>\n]*>/g, tag => tag
      .replace(/\son[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/javascript\s*:/gi, ""));
    return escapeText(neutralized);
  }

  function repositorySource(source) {
    if (!source || !BLOB_SHA.test(source.blobSha) || !BLOB_SHA.test(source.commitSha)) return null;
    try {
      const url = new URL(source.repositoryUrl);
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || parts.length !== 2) return null;
      const repository = parts.map(encodeURIComponent).join("/");
      return {
        blobBase: `https://github.com/${repository}/blob/${source.commitSha}`,
        rawBase: `https://raw.githubusercontent.com/${repository}/${source.commitSha}`,
      };
    } catch {
      return null;
    }
  }

  function resolveUrl(value, source, preferRaw = false) {
    const raw = String(value || "").trim();
    if (!raw || CONTROL.test(raw) || raw.startsWith("//") || raw.includes("\\")) return null;
    if (/^https?:/i.test(raw)) {
      try {
        const url = new URL(raw);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
        return { href: url.href, external: true };
      } catch {
        return null;
      }
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/") || raw.startsWith("#")) return null;
    const bases = repositorySource(source);
    if (!bases) return null;
    const [pathAndQuery, fragment = ""] = raw.split("#", 2);
    const [path, query = ""] = pathAndQuery.split("?", 2);
    const segments = path.split("/");
    if (!path || segments.some(segment => !segment || segment === "." || segment === "..")) return null;
    const encodedPath = segments.map(encodeURIComponent).join("/");
    const encodedQuery = query ? `?${encodeURI(query)}` : "";
    const encodedFragment = fragment ? `#${encodeURI(fragment)}` : "";
    return { href: `${preferRaw ? bases.rawBase : bases.blobBase}/${encodedPath}${encodedQuery}${encodedFragment}`, external: false };
  }

  function emphasize(value) {
    return value
      .replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  }

  function inline(markdown, source) {
    const pattern = /`([^`\n]*)`|(!?)\[([^\]]*)\]\(([^\s)]+)(?:\s+[^)]*)?\)/g;
    let html = "";
    let cursor = 0;
    let match;
    while ((match = pattern.exec(markdown))) {
      html += emphasize(escapeNonCode(markdown.slice(cursor, match.index)));
      cursor = match.index + match[0].length;
      if (match[1] !== undefined) {
        html += `<code>${escapeText(match[1])}</code>`;
        continue;
      }
      const image = match[2] === "!";
      const target = resolveUrl(match[4], source, image);
      const label = emphasize(escapeNonCode(match[3]));
      if (!target) {
        html += label;
      } else if (image) {
        html += `<img src="${escapeText(target.href)}" alt="${escapeText(match[3])}">`;
      } else {
        const external = target.external ? ' target="_blank" rel="noopener noreferrer"' : "";
        html += `<a href="${escapeText(target.href)}"${external}>${label}</a>`;
      }
    }
    return html + emphasize(escapeNonCode(markdown.slice(cursor)));
  }

  function tableCells(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map(cell => cell.trim());
  }

  function isTableDivider(line) {
    return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  }

  function renderBlocks(markdown, source) {
    const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) { index += 1; continue; }
      const fence = line.match(/^\s*(```+|~~~+)/);
      if (fence) {
        const token = fence[1];
        const code = [];
        index += 1;
        while (index < lines.length && !new RegExp(`^\\s*${token[0]}{${token.length},}\\s*$`).test(lines[index])) code.push(lines[index++]);
        if (index < lines.length) index += 1;
        blocks.push(`<pre><code>${escapeText(code.join("\n"))}</code></pre>`);
        continue;
      }
      const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        blocks.push(`<h${level}>${inline(heading[2], source)}</h${level}>`);
        index += 1;
        continue;
      }
      if (line.startsWith(">")) {
        const quote = [];
        while (index < lines.length && lines[index].startsWith(">")) quote.push(lines[index++].replace(/^>\s?/, ""));
        blocks.push(`<blockquote>${renderBlocks(quote.join("\n"), source)}</blockquote>`);
        continue;
      }
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        const type = unordered ? "ul" : "ol";
        const expression = unordered ? /^\s*[-*+]\s+(.+)$/ : /^\s*\d+[.)]\s+(.+)$/;
        const items = [];
        while (index < lines.length) {
          const item = lines[index].match(expression);
          if (!item) break;
          items.push(`<li>${inline(item[1], source)}</li>`);
          index += 1;
        }
        blocks.push(`<${type}>${items.join("")}</${type}>`);
        continue;
      }
      if (index + 1 < lines.length && line.includes("|") && isTableDivider(lines[index + 1])) {
        const headers = tableCells(line).map(cell => `<th>${inline(cell, source)}</th>`).join("");
        index += 2;
        const rows = [];
        while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
          rows.push(`<tr>${tableCells(lines[index]).map(cell => `<td>${inline(cell, source)}</td>`).join("")}</tr>`);
          index += 1;
        }
        blocks.push(`<table><thead><tr>${headers}</tr></thead><tbody>${rows.join("")}</tbody></table>`);
        continue;
      }
      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim()
        && !/^\s*(```+|~~~+|#{1,6}\s|>|[-*+]\s+|\d+[.)]\s+)/.test(lines[index])
        && !(lines[index].includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1]))) {
        paragraph.push(lines[index++]);
      }
      blocks.push(`<p>${inline(paragraph.join(" "), source)}</p>`);
    }
    return blocks.join("");
  }

  root.ReadmeMarkdown = {
    render(markdown, source) {
      return renderBlocks(markdown, source);
    },
  };
}(globalThis));
