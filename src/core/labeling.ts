// Разметка URL: что размечать, кандидаты контактов, проверка брендов по цитатам, рубрика, лимит стоимости.
// LLM здесь только классифицирует; всё, что можно проверить кодом, проверяет код.
import type {
  ContactCandidate,
  LabelCall,
  LabelInput,
  LabelRaw,
  Labeler,
  Logger,
  PageInfo,
  PageReader,
  PageType,
  ReadRow,
  Row,
} from './ports';
import { dateTimeInTz } from './time';

export const RELEVANT_TYPES: ReadonlySet<PageType> = new Set(['affiliate_review_or_ranking', 'media_with_casino_content']);
export const MAX_TEXT_CHARS = 6000;
export const MAX_LINKS = 60;
export const MAX_EVIDENCE = 100;
export const SNIPPET_ONLY_MAX_CONFIDENCE = 0.4;

/* ---------- что размечать ---------- */

export function needsLabel(
  row: ReadRow,
  opts: { now: Date; relabelDays: number; promptVersion: string; model: string },
): boolean {
  if (!row.page_type || !row.labeled_at) return true;
  if (row.prompt_version !== opts.promptVersion || row.model !== opts.model) return true;
  const labeled = Date.parse(row.labeled_at.replace(' ', 'T'));
  if (!Number.isFinite(labeled)) return true;
  return opts.now.getTime() - labeled > opts.relabelDays * 24 * 3600_000;
}

/* ---------- контакты ---------- */

const CONTACT_PAGE_RE = /(advertis|write-for-us|write_for_us|guest-post|partner|affiliat|media-kit|work-with-us|contact|about|press|impressum)/i;
const CONTACT_PRIORITY = [/advertis|media-kit|write.for.us|guest-post|work-with-us/i, /partner|affiliat/i, /contact/i, /about|press|impressum/i];
const SOCIAL_HOSTS = /(^|\.)(twitter\.com|x\.com|linkedin\.com|facebook\.com|instagram\.com|t\.me|telegram\.me)$/i;

const contactRank = (s: string) => {
  const i = CONTACT_PRIORITY.findIndex((re) => re.test(s));
  return i === -1 ? 99 : i;
};

/** Внутренние ссылки, похожие на страницы контактов/рекламы, лучшие первыми. */
export function contactPageLinks(info: PageInfo): string[] {
  const seen = new Set<string>();
  return info.links
    .filter((l) => l.internal && (CONTACT_PAGE_RE.test(new URL(l.href).pathname) || CONTACT_PAGE_RE.test(l.text)))
    .map((l) => ({ href: l.href.split('#')[0]!, rank: Math.min(contactRank(new URL(l.href).pathname), contactRank(l.text)) }))
    .filter((l) => (seen.has(l.href) ? false : (seen.add(l.href), true)))
    .sort((a, b) => a.rank - b.rank)
    .map((l) => l.href);
}

/**
 * Кандидаты собирает код: mailto/email на странице; если их нет — до 2 страниц contact/advertise/… того же домена.
 * LLM потом только выбирает лучший по индексу.
 */
export async function collectContacts(info: PageInfo, reader: PageReader, maxExtraPages = 2): Promise<ContactCandidate[]> {
  const out: ContactCandidate[] = [];
  const add = (c: ContactCandidate) => {
    if (!out.some((x) => x.type === c.type && x.value.toLowerCase() === c.value.toLowerCase())) out.push(c);
  };
  for (const e of info.emails) add({ type: 'email', value: e, sourceUrl: info.finalUrl });

  const pages = contactPageLinks(info);
  if (!info.emails.length) {
    for (const href of pages.slice(0, maxExtraPages)) {
      const r = await reader.read(href);
      if (!r.ok) continue;
      for (const e of r.info.emails) add({ type: 'email', value: e, sourceUrl: r.info.finalUrl });
      if (r.info.hasContactForm) add({ type: 'form', value: r.info.finalUrl, sourceUrl: r.info.finalUrl });
    }
  }
  if (info.hasContactForm && contactRank(new URL(info.finalUrl).pathname) < 99) add({ type: 'form', value: info.finalUrl, sourceUrl: info.finalUrl });
  for (const href of pages.slice(0, 4)) add({ type: 'page', value: href, sourceUrl: info.finalUrl });
  const socials = info.links.filter((l) => !l.internal && SOCIAL_HOSTS.test(l.domain)).slice(0, 4);
  for (const s of socials) add({ type: 'social', value: s.href, sourceUrl: info.finalUrl });
  return out.slice(0, 15);
}

/* ---------- вход для модели ---------- */

const AFFILIATE_PATH = /\/(go|visit|out|recommends|play|redirect|link)\/|[?&](ref|aff|affid|btag)=/i;

export function outboundLinks(info: PageInfo): LabelInput['outboundLinks'] {
  const seen = new Set<string>();
  const ext = info.links
    .filter((l) => !l.internal || AFFILIATE_PATH.test(l.href))
    .filter((l) => {
      const k = `${l.domain}|${l.text.toLowerCase()}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
  // Партнёрские ссылки вида /go/, /visit/, ?ref= — самые информативные для брендов, ставим их первыми.
  ext.sort((a, b) => Number(AFFILIATE_PATH.test(b.href)) - Number(AFFILIATE_PATH.test(a.href)));
  return ext.slice(0, MAX_LINKS).map((l) => ({ text: l.text, domain: l.domain, href: l.href }));
}

/* ---------- проверка брендов ---------- */

export const normText = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

const alnum = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
/** Сравнение без пробелов: склейки и переносы на странице не мешают, но каждое слово цитаты должно совпасть. */
const compact = (s: string) => normText(s).replace(/[\s"→]+/g, '');
/** Ядро названия: «BetOnRed Casino» → betonred (слово casino в цитате не обязательно). */
const brandCore = (name: string) => alnum(name.replace(/\b(online\s+)?casino\b/gi, '')) || alnum(name);

export interface BrandCheck {
  kept: { name: string; evidence: string }[];
  dropped: { name: string; why: string }[];
}

/**
 * Ноль выдуманных брендов обеспечивает код:
 * цитата должна дословно (после нормализации пробелов и кавычек) найтись в тексте страницы, анкорах или доменах ссылок,
 * а имя бренда — внутри самой цитаты. Для оператора его собственный бренд убирается.
 */
export function verifyBrands(
  brands: LabelRaw['brands'],
  haystackParts: string[],
  opts: { pageType: PageType; siteDomain: string },
): BrandCheck {
  const hay = compact(haystackParts.join(' '));
  const siteKey = alnum(opts.siteDomain.split('.').slice(0, -1).join('') || opts.siteDomain);
  const res: BrandCheck = { kept: [], dropped: [] };
  const seen = new Set<string>();
  for (const b of brands) {
    const name = b.name.trim();
    const evidence = b.evidence.trim().replace(/^["'«“]+|["'»”]+$/g, '');
    const key = alnum(name);
    if (!key) continue;
    if (seen.has(key)) continue;
    if (!evidence || !hay.includes(compact(evidence))) {
      res.dropped.push({ name, why: 'цитата не найдена на странице' });
      continue;
    }
    if (!alnum(evidence).includes(brandCore(name))) {
      res.dropped.push({ name, why: 'в цитате нет названия бренда' });
      continue;
    }
    const core = brandCore(name);
    if (opts.pageType === 'casino_operator' && siteKey && (siteKey.includes(core) || core.includes(siteKey))) {
      res.dropped.push({ name, why: 'собственный бренд оператора' });
      continue;
    }
    seen.add(key);
    res.kept.push({ name, evidence: evidence.length > MAX_EVIDENCE ? evidence.slice(0, MAX_EVIDENCE - 1) + '…' : evidence });
  }
  return res;
}

/* ---------- рубрика и итоговая строка Sites ---------- */

export function applyRubric(raw: LabelRaw, snippetOnly: boolean): { isRelevant: boolean; confidence: number; reason: string } {
  const isRelevant = RELEVANT_TYPES.has(raw.page_type);
  let confidence = Math.max(0, Math.min(1, raw.confidence));
  let reason = raw.reason.trim().replace(/\s+/g, ' ');
  if (raw.page_type === 'media_with_casino_content' && !/\bmedia\b/i.test(reason)) reason = `Media: ${reason}`;
  if (raw.page_type === 'other' && !reason) reason = 'Other: no reason given';
  if (snippetOnly) {
    confidence = Math.min(confidence, SNIPPET_ONLY_MAX_CONFIDENCE);
    if (!/^snippet-only/i.test(reason)) reason = `snippet-only: ${reason}`;
  }
  return { isRelevant, confidence: Math.round(confidence * 100) / 100, reason };
}

/* ---------- оркестрация ---------- */

export interface SiteToLabel {
  /** Нормализованный URL — ключ строки Sites. */
  key: string;
  /** URL для скачивания (как в выдаче). */
  fetchUrl: string;
  domain: string;
  serpTitle: string;
  serpSnippet: string;
}

export interface LabelingStats {
  labeled: number;
  fetchFailed: number;
  llmFailed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  stoppedByBudget: boolean;
  droppedBrands: number;
}

export interface LabelingDeps {
  reader: PageReader;
  labeler: Labeler;
  log: Logger;
  now: () => Date;
  timezone: string;
  /** Сколько уже потрачено в этом прогоне (SERP бесплатный, но поле общее). */
  budgetUsd: number;
  concurrency?: number;
}

/** Размечает сайты, возвращает строки для upsert в Sites и счётчики для Runs. */
export async function labelSites(sites: SiteToLabel[], deps: LabelingDeps): Promise<{ rows: Row[]; stats: LabelingStats }> {
  const { reader, labeler, log } = deps;
  const stats: LabelingStats = { labeled: 0, fetchFailed: 0, llmFailed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, stoppedByBudget: false, droppedBrands: 0 };
  const rows: Row[] = [];
  const queue = [...sites];

  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      if (stats.costUsd >= deps.budgetUsd) {
        stats.stoppedByBudget = true;
        return;
      }
      const row = await labelOne(s, deps, stats).catch((e: unknown) => {
        log.error(`[${s.key}] разметка упала: ${(e as Error).message}`);
        return null;
      });
      if (row) rows.push(row);
    }
  };
  await Promise.all(Array.from({ length: deps.concurrency ?? 4 }, worker));
  if (stats.stoppedByBudget)
    log.warn(`Лимит расходов $${deps.budgetUsd} достигнут ($${stats.costUsd.toFixed(4)}): разметка остановлена, остаток доразметит следующий прогон`);
  return { rows, stats };
}

async function labelOne(s: SiteToLabel, deps: LabelingDeps, stats: LabelingStats): Promise<Row | null> {
  const { reader, labeler, log } = deps;
  const page = await reader.read(s.fetchUrl);
  let input: LabelInput;
  let haystack: string[] = [s.serpTitle, s.serpSnippet, s.domain];
  let candidates: ContactCandidate[] = [];
  let fetchStatus: string;

  if (page.ok) {
    const info = page.info;
    candidates = await collectContacts(info, reader);
    const links = outboundLinks(info);
    fetchStatus = 'ok';
    // Ссылки — в том же виде, что видит модель («"Play now" → luxury.casino»): анкор и домен тоже доказательство.
    haystack = [info.title, info.fullText, ...info.links.map((l) => `"${l.text}" → ${l.domain} | ${l.href}`), ...haystack];
    input = {
      url: s.fetchUrl,
      domain: s.domain,
      serpTitle: s.serpTitle,
      serpSnippet: s.serpSnippet,
      fetchStatus,
      pageTitle: info.title,
      mainText: info.mainText.slice(0, MAX_TEXT_CHARS),
      outboundLinks: links,
      candidates,
    };
  } else {
    stats.fetchFailed++;
    fetchStatus = `failed: ${page.reason}`;
    log.warn(`[${s.domain}] не скачано (${page.reason}) — разметка по сниппету`);
    input = { url: s.fetchUrl, domain: s.domain, serpTitle: s.serpTitle, serpSnippet: s.serpSnippet, fetchStatus, pageTitle: '', mainText: '', outboundLinks: [], candidates: [] };
  }

  const call: LabelCall = await labeler.label(input);
  stats.inputTokens += call.inputTokens;
  stats.outputTokens += call.outputTokens;
  stats.costUsd += call.costUsd;

  if (!call.result) {
    stats.llmFailed++;
    log.error(`[${s.domain}] llm_failed: ${call.error ?? 'невалидный ответ'}`);
    // Пустой page_type → следующий прогон попробует снова.
    return { url: s.key, fetch_status: fetchStatus, page_type: '', reason: `llm_failed: ${(call.error ?? '').slice(0, 150)}`, labeled_at: '' };
  }

  const raw = call.result;
  const rubric = applyRubric(raw, !page.ok);
  const brandCheck = verifyBrands(raw.brands, haystack, { pageType: raw.page_type, siteDomain: s.domain });
  stats.droppedBrands += brandCheck.dropped.length;
  for (const d of brandCheck.dropped) log.warn(`[${s.domain}] бренд «${d.name}» выброшен: ${d.why}`);

  const contact = raw.contact_index >= 0 ? candidates[raw.contact_index] : undefined;
  stats.labeled++;
  return {
    url: s.key,
    fetch_status: fetchStatus,
    page_type: raw.page_type,
    is_relevant: rubric.isRelevant,
    confidence: rubric.confidence,
    reason: rubric.reason,
    brands: brandCheck.kept.map((b) => b.name).join('; '),
    brand_evidence: brandCheck.kept.map((b) => `${b.name}: «${b.evidence}»`).join(' | '),
    contact_type: contact?.type ?? 'none',
    contact_value: contact?.value ?? '',
    contact_source: contact?.sourceUrl ?? '',
    labeled_at: dateTimeInTz(deps.now(), deps.timezone),
    model: labeler.model,
    prompt_version: labeler.promptVersion,
  };
}
