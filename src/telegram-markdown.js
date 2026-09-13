import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt({ html: false, linkify: false });
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (name, attribute = '') => ({ open: `<${name}${attribute}>`, close: `</${name}>` });
const safeLink = href => /^(https?:\/\/|mailto:|tg:\/\/)/i.test(href ?? '');

// Parse the complete Markdown before splitting. Each text run carries its tags,
// so every Telegram chunk can close/reopen formatting without cutting HTML.
export function renderTelegramMarkdown(markdown, limit = 3900) {
  if (!Number.isInteger(limit) || limit < 2) throw new Error('Invalid message limit');
  const source = String(markdown ?? '');
  const lines = source.split('\n');
  const runs = [];
  const marks = [];
  const lists = [];
  const add = (text, styles = marks) => {
    if (text) runs.push({ text, styles: [...styles].filter(Boolean) });
  };
  const newline = () => {
    if (runs.length && !runs.at(-1).text.endsWith('\n')) add('\n', []);
  };
  function inline(tokens) {
    for (const token of tokens ?? []) {
      switch (token.type) {
        case 'text': add(token.content); break;
        case 'softbreak': case 'hardbreak': add('\n'); break;
        case 'code_inline': add(token.content, [tag('code')]); break;
        case 'strong_open': marks.push(tag('b')); break;
        case 'em_open': marks.push(tag('i')); break;
        case 's_open': marks.push(tag('s')); break;
        case 'link_open': {
          const href = token.attrGet('href');
          marks.push(safeLink(href) ? tag('a', ` href="${escape(href)}"`) : null);
          break;
        }
        case 'strong_close': case 'em_close': case 's_close': case 'link_close': marks.pop(); break;
        case 'image': {
          const href = token.attrGet('src');
          add(token.content || href || 'Image', safeLink(href) ? [tag('a', ` href="${escape(href)}"`)] : marks);
          break;
        }
        default: if (token.content) add(token.content);
      }
    }
  }
  const tokens = parser.parse(source, {});
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'inline': inline(token.children); break;
      case 'heading_open': newline(); marks.push(tag('b')); break;
      case 'heading_close': marks.pop(); newline(); break;
      case 'paragraph_open': break;
      case 'paragraph_close': newline(); if (!lists.length) add('\n', []); break;
      case 'bullet_list_open': lists.push({ next: null }); break;
      case 'ordered_list_open': lists.push({ next: Number(token.attrGet('start') || 1) }); break;
      case 'bullet_list_close': case 'ordered_list_close': lists.pop(); newline(); break;
      case 'list_item_open': {
        newline();
        const list = lists.at(-1);
        add('  '.repeat(Math.max(0, lists.length - 1)) + (list?.next == null ? '• ' : `${list.next++}. `), []);
        break;
      }
      case 'list_item_close': newline(); break;
      case 'blockquote_open':
        newline(); marks.push(marks.some(mark => mark?.open === '<blockquote>') ? null : tag('blockquote')); break;
      case 'blockquote_close': newline(); marks.pop(); break;
      case 'fence': case 'code_block': {
        newline();
        const language = token.info.trim().split(/\s+/)[0];
        const styles = [tag('pre')];
        if (/^[A-Za-z0-9_+-]+$/.test(language)) styles.push(tag('code', ` class="language-${language}"`));
        add(token.content, styles); newline(); break;
      }
      case 'table_open': {
        newline();
        add(lines.slice(token.map[0], token.map[1]).join('\n'), [tag('pre')]);
        while (i < tokens.length && tokens[i].type !== 'table_close') i++;
        newline(); break;
      }
      case 'hr': newline(); add('────────', []); newline(); break;
      default: if (token.content) add(token.content);
    }
  }
  // Remove layout-only trailing newlines, preserving code block contents.
  while (runs.length && !runs.at(-1).styles.length && /^\n+$/.test(runs.at(-1).text)) runs.pop();
  const chunks = [];
  let text = '', html = '';
  const flush = () => { if (text) chunks.push({ text, html }); text = ''; html = ''; };
  for (const run of runs) {
    let remaining = run.text;
    while (remaining) {
      let size = Math.min(remaining.length, limit - text.length);
      // Telegram uses UTF-16 offsets; never split a surrogate pair.
      if (size < remaining.length && /[\uD800-\uDBFF]/.test(remaining[size - 1] ?? '')) size--;
      if (!size) { flush(); continue; }
      const part = remaining.slice(0, size);
      text += part;
      html += run.styles.map(style => style.open).join('') + escape(part) + [...run.styles].reverse().map(style => style.close).join('');
      remaining = remaining.slice(size);
      if (text.length >= limit) flush();
    }
  }
  flush();
  return chunks;
}
