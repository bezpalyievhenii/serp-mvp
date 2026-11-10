import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { PAGE_TYPES, type LabelCall, type LabelInput, type LabelRaw, type Labeler } from '../../core/ports';
import { costUsd } from './pricing';

/** Схема ответа модели. Ограничения диапазонов дополнительно проверяет код (structured outputs их не гарантируют). */
export const LabelSchema = z.object({
  page_type: z.enum(PAGE_TYPES),
  confidence: z.number(),
  reason: z.string(),
  brands: z.array(z.object({ name: z.string(), evidence: z.string() })),
  contact_index: z.number().int(),
});

const StrictLabel = LabelSchema.extend({
  confidence: z.number().min(0).max(1),
  reason: z.string().min(3).max(400),
  brands: z.array(z.object({ name: z.string().min(1).max(60), evidence: z.string().min(1).max(300) })).max(30),
  contact_index: z.number().int().min(-1),
});

export interface ClassifyPrompt {
  version: string;
  system: string;
}

/** prompts/classify.md: шапка `--- version: … ---`, дальше системный промпт. */
export function loadPrompt(path: string): ClassifyPrompt {
  const text = readFileSync(path, 'utf8');
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(text);
  const version = m ? /version:\s*(\S+)/.exec(m[1]!)?.[1] : undefined;
  if (!m || !version) throw new Error(`${path}: нет шапки с version`);
  return { version, system: m[2]!.trim() };
}

/** Данные страницы — в отдельном блоке <page>; это недоверенный ввод. */
export function renderUserMessage(i: LabelInput): string {
  const esc = (s: string) => s.replace(/<\/?(page|contact_candidates)>/gi, '');
  const links = i.outboundLinks.map((l) => `- "${esc(l.text)}" → ${l.domain}`).join('\n') || '(none)';
  const cands = i.candidates.map((c, n) => `${n}. ${c.type}: ${c.value} (found on ${c.sourceUrl})`).join('\n') || '(empty)';
  return [
    `<page url="${i.url}" domain="${i.domain}">`,
    `Fetch status: ${i.fetchStatus}`,
    `SERP title: ${esc(i.serpTitle)}`,
    `SERP snippet: ${esc(i.serpSnippet)}`,
    i.pageTitle ? `Page title: ${esc(i.pageTitle)}` : '',
    i.mainText ? `Main text (truncated):\n${esc(i.mainText)}` : 'Main text: (not available — fetch failed)',
    `Outbound links (anchor → domain):\n${links}`,
    `</page>`,
    `<contact_candidates>\n${cands}\n</contact_candidates>`,
    'Classify this page.',
  ]
    .filter(Boolean)
    .join('\n');
}

export class AnthropicLabeler implements Labeler {
  readonly promptVersion: string;
  private readonly system: string;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    promptPath: string,
    client?: Anthropic,
  ) {
    const p = loadPrompt(promptPath);
    this.promptVersion = p.version;
    this.system = p.system;
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  /** Невалидный ответ — 1 повтор, потом llm_failed. Стоимость считается по реальному usage обеих попыток. */
  async label(input: LabelInput): Promise<LabelCall> {
    const call: LabelCall = { result: null, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    const content = renderUserMessage(input);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.client.messages.parse({
          model: this.model,
          max_tokens: 2000,
          system: [{ type: 'text', text: this.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content }],
          output_config: { effort: 'low', format: zodOutputFormat(LabelSchema) },
        });
        call.inputTokens += res.usage.input_tokens + (res.usage.cache_read_input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
        call.outputTokens += res.usage.output_tokens;
        call.costUsd += costUsd(this.model, res.usage);
        if (res.stop_reason === 'refusal') {
          call.error = 'refusal';
          continue;
        }
        const parsed = StrictLabel.safeParse(res.parsed_output);
        if (parsed.success) {
          call.result = parsed.data as LabelRaw;
          call.error = undefined;
          return call;
        }
        call.error = `invalid output: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`.slice(0, 200);
      } catch (e) {
        call.error = e instanceof Anthropic.APIError ? `API ${e.status}: ${e.message}` : (e as Error).message;
        if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return call;
      }
    }
    return call;
  }
}
