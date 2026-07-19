(() => {
  'use strict';

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);

  const safeUrl = (value) => {
    try {
      const url = new URL(String(value).trim(), window.location.origin);
      return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? escapeHtml(url.href) : null;
    } catch {
      return null;
    }
  };

  function inlineMarkdown(source) {
    const tokens = [];
    const stash = (html) => {
      const key = `\u0000MD${tokens.length}\u0000`;
      tokens.push(html);
      return key;
    };

    let text = String(source ?? '');
    text = text.replace(/`([^`\n]+)`/g, (_, code) => stash(`<code class="md-inline-code">${escapeHtml(code)}</code>`));
    text = text.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
      const url = safeUrl(href);
      return url ? stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`) : escapeHtml(label);
    });
    text = escapeHtml(text)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
    return text.replace(/\u0000MD(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
  }

  function renderTable(lines, start) {
    if (start + 1 >= lines.length || !lines[start].includes('|')) return null;
    const divider = lines[start + 1].trim();
    if (!/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(divider)) return null;
    const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
    const headers = cells(lines[start]);
    const rows = [];
    let index = start + 2;
    while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
      rows.push(cells(lines[index]));
      index++;
    }
    return {
      next: index,
      html: `<div class="md-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, column) => `<td>${inlineMarkdown(row[column] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
    };
  }
  function renderBlocks(source) {
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
    const output = [];
    let paragraph = [];
    let listType = null;

    const closeParagraph = () => {
      if (paragraph.length) output.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
      paragraph = [];
    };
    const closeList = () => {
      if (listType) output.push(`</${listType}>`);
      listType = null;
    };
    const startList = (type) => {
      closeParagraph();
      if (listType !== type) {
        closeList();
        output.push(`<${type}>`);
        listType = type;
      }
    };

    for (let index = 0; index < lines.length;) {
      const raw = lines[index];
      const line = raw.trim();
      const table = renderTable(lines, index);
      if (table) {
        closeParagraph(); closeList(); output.push(table.html); index = table.next; continue;
      }
      if (!line) {
        closeParagraph(); closeList(); index++; continue;
      }
      const heading = line.match(/^(#{1,4})\s+(.+)$/);
      if (heading) {
        closeParagraph(); closeList();
        const level = heading[1].length;
        output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
        index++; continue;
      }
      if (/^([-*_])(?:\s*\1){2,}$/.test(line)) {
        closeParagraph(); closeList(); output.push('<hr>'); index++; continue;
      }
      const quote = line.match(/^>\s?(.*)$/);
      if (quote) {
        closeParagraph(); closeList(); output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`); index++; continue;
      }
      const unordered = line.match(/^[-*+]\s+(.+)$/);
      if (unordered) {
        startList('ul'); output.push(`<li>${inlineMarkdown(unordered[1])}</li>`); index++; continue;
      }
      const ordered = line.match(/^\d+[.)]\s+(.+)$/);
      if (ordered) {
        startList('ol'); output.push(`<li>${inlineMarkdown(ordered[1])}</li>`); index++; continue;
      }
      closeList(); paragraph.push(line); index++;
    }
    closeParagraph(); closeList();
    return output.join('');
  }

  function render(markdown) {
    const source = String(markdown ?? '').replace(/\r\n?/g, '\n');
    const output = [];
    const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
    let cursor = 0;
    let match;
    while ((match = fence.exec(source))) {
      output.push(renderBlocks(source.slice(cursor, match.index)));
      const language = String(match[1] || '').trim().replace(/[^\w.+#-]/g, '').slice(0, 24);
      const label = language || 'code';
      const code = match[2].replace(/\n$/, '');
      output.push(`<div class="md-code-block"><div class="md-code-head"><span>${escapeHtml(label)}</span><button type="button" data-md-copy>Copy</button></div><pre><code class="language-${escapeHtml(language || 'text')}">${escapeHtml(code)}</code></pre></div>`);
      cursor = fence.lastIndex;
    }
    output.push(renderBlocks(source.slice(cursor)));
    return `<div class="md-content">${output.join('')}</div>`;
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-md-copy]');
    if (!button) return;
    const code = button.closest('.md-code-block')?.querySelector('code')?.textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      const previous = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = previous; }, 1400);
    } catch {
      button.textContent = 'Copy failed';
    }
  });

  window.DsaMarkdown = Object.freeze({ render });
})();