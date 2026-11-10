import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { PageInfo, PageLink } from '../../core/ports';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi;
const JUNK_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(\d+x\.|sentry|example\.|domain\.|email\.|wixpress|sentry-next)/i;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);

/**
 * Текст узла с пробелом между соседними элементами.
 * textContent склеивает блоки («Go to 888 Casino888casino review»), из-за чего не находятся дословные цитаты.
 */
export function textOf(node: { childNodes: ArrayLike<unknown> }): string {
  const out: string[] = [];
  const walk = (n: { nodeType?: number; nodeValue?: string | null; nodeName?: string; childNodes?: ArrayLike<unknown> }) => {
    if (n.nodeType === 3) {
      if (n.nodeValue) out.push(n.nodeValue);
      return;
    }
    if (n.nodeType === 1 && SKIP_TAGS.has(String(n.nodeName).toUpperCase())) return;
    for (const c of Array.from(n.childNodes ?? [])) walk(c as typeof n);
  };
  walk(node as never);
  return squash(out.join(' '));
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Cloudflare прячет email в data-cfemail: первый байт — ключ XOR. */
export function decodeCfEmail(hex: string): string {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

export function cleanEmails(list: string[]): string[] {
  return [...new Set(list.map((e) => e.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0]!))].filter(
    (e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,24}$/.test(e) && !JUNK_EMAIL.test(e),
  );
}

/** HTML → заголовок, основной и полный текст, ссылки, email, признак контактной формы. */
export function extractPage(html: string, finalUrl: string): PageInfo {
  const { document } = parseHTML(html);
  const baseHost = hostOf(finalUrl);

  const title = squash(
    document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.querySelector('title')?.textContent || '',
  );

  const emails: string[] = [];
  const links: PageLink[] = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const raw = (a.getAttribute('href') ?? '').trim();
    if (/^mailto:/i.test(raw)) {
      emails.push(raw);
      continue;
    }
    if (!raw || /^(javascript:|#|tel:)/i.test(raw)) continue;
    let href: string;
    try {
      href = new URL(raw, finalUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(href)) continue;
    const domain = hostOf(href);
    const internal = domain === baseHost || domain.endsWith('.' + baseHost) || baseHost.endsWith('.' + domain);
    links.push({ href, text: squash(a.textContent ?? '').slice(0, 80), domain, internal });
  }
  for (const el of document.querySelectorAll('[data-cfemail]')) emails.push(decodeCfEmail(el.getAttribute('data-cfemail') ?? ''));

  const hasContactForm = [...document.querySelectorAll('form')].some(
    (f) => f.querySelector('textarea') !== null || f.querySelector('input[type="email"]') !== null,
  );

  // Полный видимый текст: без скриптов и стилей, с пробелами между элементами.
  for (const el of document.querySelectorAll('script, style, noscript, template, svg')) el.remove();
  const fullText = textOf((document.body ?? document.documentElement) as never);
  emails.push(...(fullText.match(EMAIL_RE) ?? []));

  let mainText = '';
  try {
    const article = new Readability(document as unknown as Document, { charThreshold: 300 }).parse();
    if (article?.content) mainText = textOf(parseHTML(`<html><body>${article.content}</body></html>`).document.body as never);
  } catch {
    /* Readability не справился — возьмём полный текст */
  }
  if (mainText.length < 400) mainText = fullText;

  return { finalUrl, title, mainText, fullText, links, emails: cleanEmails(emails), hasContactForm };
}
