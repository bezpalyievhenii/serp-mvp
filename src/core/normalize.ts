const TRACKING_PARAMS = new Set(['gclid', 'fbclid', 'gbraid', 'wbraid', 'msclkid', 'dclid', 'yclid']);

/**
 * Нормализация URL для дедупликации:
 * хост в нижнем регистре без www., схема https, без utm_… / gclid / fbclid, без фрагмента,
 * без хвостового слэша и порта по умолчанию.
 */
export function normalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Не http(s) URL: ${raw}`);
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams.entries()].filter(
    ([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(k.toLowerCase()),
  );
  const query = params.length ? '?' + new URLSearchParams(params).toString() : '';
  let path = u.pathname.replace(/\/+$/, '');
  if (path === '/') path = '';
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : '';
  return `https://${host}${port}${path}${query}`;
}

export function domainOf(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
}

/** Google иногда отдаёт ссылки-редиректы (google.ca/url?q=…, google.com/goto?url=…). Достаём целевой URL. */
export function unwrapGoogleRedirect(raw: string): string {
  try {
    const u = new URL(raw);
    if (/(^|\.)google\.[a-z.]+$/.test(u.hostname) && /^\/(url|goto)$/.test(u.pathname)) {
      const target = u.searchParams.get('url') ?? u.searchParams.get('q');
      if (target && /^https?:\/\//.test(target)) return target;
    }
  } catch {
    /* не URL — вернём как есть, отфильтрует валидация */
  }
  return raw;
}
