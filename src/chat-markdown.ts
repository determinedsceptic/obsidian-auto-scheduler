import { type App, Notice, sanitizeHTMLToDom } from 'obsidian';
import { Marked, type Tokens } from 'marked';

type LinkKind = 'external' | 'internal';

interface LinkIntent {
  href: string;
  kind: LinkKind;
}

interface WikiLinkToken extends Tokens.Generic {
  type: 'wikilink';
  href: string;
  label: string;
  image: boolean;
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function classifyLink(rawHref: string): LinkIntent | null {
  const href = rawHref.trim();
  if (!href || CONTROL_CHARACTER.test(href) || href.startsWith('//') || href.startsWith('\\')) return null;

  if (/^https?:/i.test(href) || /^mailto:/i.test(href)) {
    try {
      const protocol = new URL(href).protocol.toLowerCase();
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:') {
        return { href, kind: 'external' };
      }
    } catch {
      return null;
    }
    return null;
  }

  if (URI_SCHEME.test(href) || href.startsWith('/')) return null;
  return { href, kind: 'internal' };
}

function inertLink(labelHtml: string, image: boolean): string {
  const prefix = image ? 'Image: ' : '';
  return `<span class="auto-scheduler-inert-link">${prefix}${labelHtml}</span>`;
}

/** Render chat Markdown without invoking Obsidian or third-party code-block processors. */
export function renderChatMarkdown(
  app: App,
  markdown: string,
  container: HTMLElement,
  sourcePath: string,
): void {
  const linkIntents: LinkIntent[] = [];

  const renderLink = (href: string, labelHtml: string, image = false): string => {
    const intent = classifyLink(href);
    if (!intent) return inertLink(labelHtml, image);
    const linkId = linkIntents.push(intent) - 1;
    const classes = image
      ? 'auto-scheduler-rendered-link auto-scheduler-image-link'
      : 'auto-scheduler-rendered-link';
    const prefix = image ? 'Image: ' : '';
    return `<a class="${classes}" href="#auto-scheduler-chat-link-${linkId}">${prefix}${labelHtml}</a>`;
  };

  const parser = new Marked({
    async: false,
    breaks: false,
    gfm: true,
    pedantic: false,
    renderer: {
      html({ text }: Tokens.HTML | Tokens.Tag): string {
        return escapeHtml(text);
      },
      link(token: Tokens.Link): string {
        return renderLink(token.href, this.parser.parseInline(token.tokens));
      },
      image(token: Tokens.Image): string {
        const label = escapeHtml(token.text.trim() || token.href);
        return renderLink(token.href, label, true);
      },
    },
    extensions: [{
      name: 'wikilink',
      level: 'inline',
      start(src: string): number | undefined {
        const normal = src.indexOf('[[');
        const embed = src.indexOf('![[');
        if (normal < 0) return embed < 0 ? undefined : embed;
        if (embed < 0) return normal;
        return Math.min(normal, embed);
      },
      tokenizer(src: string): WikiLinkToken | undefined {
        const match = /^!?\[\[([^\]\n]+)\]\]/.exec(src);
        if (!match) return undefined;
        const separator = match[1].indexOf('|');
        const href = (separator < 0 ? match[1] : match[1].slice(0, separator)).trim();
        const alias = separator < 0 ? '' : match[1].slice(separator + 1).trim();
        return {
          type: 'wikilink',
          raw: match[0],
          href,
          label: alias || href || match[0],
          image: match[0].startsWith('!'),
        };
      },
      renderer(token: Tokens.Generic): string {
        const wiki = token as WikiLinkToken;
        return renderLink(wiki.href, escapeHtml(wiki.label), wiki.image);
      },
    }],
  });

  let fragment: DocumentFragment;
  try {
    const html = parser.parse(markdown, { async: false });
    fragment = sanitizeHTMLToDom(html);
  } catch {
    fragment = document.createDocumentFragment();
    const fallback = document.createElement('p');
    fallback.className = 'auto-scheduler-message-plain';
    fallback.textContent = markdown;
    fragment.append(fallback);
  }

  const anchors = fragment.querySelectorAll<HTMLAnchorElement>('a');
  anchors.forEach(anchor => {
    const match = /^#auto-scheduler-chat-link-(\d+)$/.exec(anchor.getAttribute('href') ?? '');
    if (!match) return;
    const intent = linkIntents[Number(match[1])];
    if (!intent) {
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ''));
      return;
    }

    if (intent.kind === 'external') {
      anchor.setAttribute('href', intent.href);
      if (intent.href.toLowerCase().startsWith('http')) anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      return;
    }

    anchor.setAttribute('href', '#');
    anchor.addClass('internal-link');
    anchor.addEventListener('click', event => {
      event.preventDefault();
      const newLeaf = event.metaKey || event.ctrlKey || event.shiftKey;
      void app.workspace.openLinkText(intent.href, sourcePath, newLeaf)
        .catch(() => new Notice('Could not open note'));
    });
  });

  container.replaceChildren(fragment);
}
