// Интерфейс менеджера: без фреймворков. Все строки — из i18n/ru.json и i18n/en.json.

const state = {
  lang: readPref('lang', 'ru'),
  dict: {},
  meta: null,
  data: null,
  tab: 'sites',
  filters: { relevance: 'all', brand: '', keyword: '', q: '' },
  openSite: null,
  history: { mode: 'keyword', keyword: '', url: '' },
  pollTimer: null,
};

/* ---------- утилиты ---------- */

function readPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* приватный режим */ }
}

function t(key, vars = {}) {
  let s = state.dict[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Безопасное создание DOM: текст всегда через textContent, данные страниц не исполняются. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.message ?? body.error ?? res.statusText), { status: res.status, code: body.error });
  return body;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3500);
}

const splitList = (s, sep) => (s ?? '').split(sep).map((x) => x.trim()).filter(Boolean);

function urlParts(url) {
  try {
    const u = new URL(url);
    return { domain: u.hostname, path: (u.pathname + u.search).replace(/^\/$/, '') };
  } catch {
    return { domain: url, path: '' };
  }
}

function parseEvidence(s) {
  // Формат: «Бренд: «цитата» | Бренд2: «цитата»»
  return splitList(s, ' | ').map((part) => {
    const i = part.indexOf(':');
    return i > 0 ? { brand: part.slice(0, i).trim(), quote: part.slice(i + 1).trim().replace(/^«|»$/g, '') } : { brand: '', quote: part };
  });
}

/* ---------- язык ---------- */

async function setLang(lang) {
  state.lang = lang;
  writePref('lang', lang);
  state.dict = await fetch(`/i18n/${lang}.json`).then((r) => r.json());
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll('.lang button').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));
  document.title = t('app.title');
  render();
}

/* ---------- загрузка ---------- */

async function loadData() {
  state.data = await api('/api/data');
  updateRunIndicator(state.data.running);
}

function updateRunIndicator(running) {
  const el = document.getElementById('run-indicator');
  el.hidden = !running;
  el.textContent = running ? t('app.running') : '';
  if (running && !state.pollTimer) {
    state.pollTimer = setInterval(async () => {
      await loadData().catch(() => {});
      if (!state.data?.running) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
      if (['runs', 'sites', 'history'].includes(state.tab)) render();
    }, 2500);
  }
}

/* ---------- вкладки ---------- */

function render() {
  const view = document.getElementById('view');
  document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === state.tab));
  if (!state.data) {
    view.replaceChildren(h('div', { class: 'empty' }, t('app.loading')));
    return;
  }
  const views = { sites: renderSites, history: renderHistory, keywords: renderKeywords, runs: renderRuns, schedule: renderSchedule };
  view.replaceChildren(...[].concat((views[state.tab] ?? renderSites)()));
}

function keywordMap() {
  return new Map(state.data.keywords.map((k) => [k.id, k.keyword]));
}

/* ----- Сайты ----- */

function renderSites() {
  const { sites } = state.data;
  const kwMap = keywordMap();
  const f = state.filters;
  const brands = [...new Set(sites.flatMap((s) => splitList(s.brands, ';')))].sort((a, b) => a.localeCompare(b));
  const anyLabels = sites.some((s) => s.page_type);

  const filtered = sites
    .filter((s) => {
      if (f.relevance === 'yes' && s.is_relevant !== 'TRUE') return false;
      if (f.relevance === 'no' && s.is_relevant !== 'FALSE') return false;
      if (f.relevance === 'unlabeled' && s.page_type) return false;
      if (f.brand && !splitList(s.brands, ';').includes(f.brand)) return false;
      if (f.keyword && !splitList(s.keywords, ',').includes(f.keyword)) return false;
      if (f.q && !(s.url + ' ' + s.domain).toLowerCase().includes(f.q.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => Number(a.best_position || 99) - Number(b.best_position || 99) || a.url.localeCompare(b.url));

  const setF = (k) => (e) => {
    state.filters[k] = e.target.value;
    render();
  };

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('div', { class: 'field' }, h('label', {}, t('sites.filter.relevance')),
      h('select', { onchange: setF('relevance') },
        ['all', 'yes', 'no', 'unlabeled'].map((v) =>
          h('option', { value: v, selected: f.relevance === v }, t({ all: 'sites.filter.all', yes: 'sites.filter.relevant', no: 'sites.filter.notRelevant', unlabeled: 'sites.filter.unlabeled' }[v]))))),
    h('div', { class: 'field' }, h('label', {}, t('sites.filter.brand')),
      h('select', { onchange: setF('brand') }, h('option', { value: '' }, t('sites.filter.all')),
        brands.map((b) => h('option', { value: b, selected: f.brand === b }, b)))),
    h('div', { class: 'field' }, h('label', {}, t('sites.filter.keyword')),
      h('select', { onchange: setF('keyword') }, h('option', { value: '' }, t('sites.filter.all')),
        state.data.keywords.map((k) => h('option', { value: k.id, selected: f.keyword === k.id }, `${k.id} · ${k.keyword}`)))),
    h('div', { class: 'field grow' }, h('label', {}, t('sites.filter.search')),
      h('input', { type: 'search', value: f.q, placeholder: 'casino.org', oninput: (e) => { state.filters.q = e.target.value; renderSitesTableOnly(); } })),
  );

  const count = h('p', { class: 'count', id: 'sites-count' },
    t('sites.count', { shown: filtered.length, total: sites.length, relevant: sites.filter((s) => s.is_relevant === 'TRUE').length }),
    anyLabels ? '' : ` · ${t('sites.noLabels')}`);

  return [toolbar, count, h('div', { class: 'panel table-wrap', id: 'sites-table' }, sitesTable(filtered, kwMap))];
}

function renderSitesTableOnly() {
  // при наборе в поиске не перерисовываем поле ввода, чтобы не терять фокус
  const wrap = document.getElementById('sites-table');
  const keep = document.activeElement;
  render();
  void wrap;
  const input = document.querySelector('.toolbar input[type=search]');
  if (keep && keep.type === 'search' && input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function sitesTable(rows, kwMap) {
  if (!rows.length) return h('div', { class: 'empty' }, t('app.empty'));
  const head = h('tr', {},
    h('th', {}, t('sites.col.url')), h('th', { class: 'num' }, t('sites.col.best')), h('th', {}, t('sites.col.keywords')),
    h('th', {}, t('sites.col.type')), h('th', {}, t('sites.col.relevant')), h('th', {}, t('sites.col.confidence')),
    h('th', {}, t('sites.col.brands')), h('th', {}, t('sites.col.contact')), h('th', {}, t('sites.col.lastSeen')));
  const body = [];
  for (const s of rows) {
    const { domain, path } = urlParts(s.url);
    const open = state.openSite === s.url;
    body.push(
      h('tr', { class: 'clickable', onclick: () => { state.openSite = open ? null : s.url; render(); } },
        h('td', { class: 'url-cell' },
          h('div', { class: 'url-domain' }, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, domain)),
          path ? h('div', { class: 'url-path' }, path) : null),
        h('td', { class: 'num' }, s.best_position || '—'),
        h('td', {}, keywordChips(splitList(s.keywords, ','), kwMap)),
        h('td', {}, s.page_type ? t(`type.${s.page_type}`) : h('span', { class: 'muted' }, t('sites.unlabeled'))),
        h('td', {}, relevanceBadge(s)),
        h('td', {}, confidence(s.confidence)),
        h('td', {}, h('div', { class: 'chips' }, splitList(s.brands, ';').map((b) => h('span', { class: 'chip' }, b)))),
        h('td', {}, contactCell(s)),
        h('td', { class: 'mono' }, s.last_seen),
      ),
    );
    if (open) body.push(siteDetails(s, kwMap));
  }
  return h('table', {}, h('thead', {}, head), h('tbody', {}, body));
}

function keywordChips(ids, kwMap, max = 3) {
  const shown = ids.slice(0, max).map((id) => h('span', { class: 'chip', title: kwMap.get(id) ?? id }, id));
  const rest = ids.length - max;
  return h('div', { class: 'chips' }, shown, rest > 0 ? h('span', { class: 'chip muted', title: ids.slice(max).map((id) => kwMap.get(id) ?? id).join('\n') }, `+${rest}`) : null);
}

function relevanceBadge(s) {
  if (s.is_relevant === 'TRUE') return h('span', { class: 'badge badge-ok' }, t('sites.yes'));
  if (s.is_relevant === 'FALSE') return h('span', { class: 'badge badge-bad' }, t('sites.no'));
  return h('span', { class: 'muted' }, t('sites.unlabeled'));
}

function confidence(v) {
  if (v === '' || v === undefined) return h('span', { class: 'muted' }, '—');
  const n = Math.max(0, Math.min(1, Number(v)));
  return h('span', { class: 'conf' }, h('span', { class: 'conf-bar' }, h('span', { style: `width:${Math.round(n * 100)}%` })), n.toFixed(2));
}

function contactCell(s) {
  if (!s.contact_type) return h('span', { class: 'muted' }, '—');
  if (s.contact_type === 'none') return h('span', { class: 'muted' }, t('contact.none'));
  const label = t(`contact.${s.contact_type}`);
  const value = s.contact_value || '';
  const href = s.contact_type === 'email' ? `mailto:${value}` : /^https?:\/\//.test(value) ? value : null;
  return h('div', {}, h('span', { class: 'badge badge-neutral' }, label), ' ',
    href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', onclick: (e) => e.stopPropagation() }, value) : value);
}

function siteDetails(s, kwMap) {
  const ev = parseEvidence(s.brand_evidence);
  const dl = (label, ...content) => h('div', {}, h('dt', {}, label), h('dd', {}, ...content));
  return h('tr', { class: 'details' }, h('td', { colspan: 9 },
    h('dl', { class: 'details-grid' },
      dl(t('sites.details.reason'), s.reason || '—'),
      dl(t('sites.details.evidence'), ev.length ? ev.map((e) => h('blockquote', {}, h('strong', {}, e.brand ? `${e.brand}: ` : ''), `«${e.quote}»`)) : '—'),
      dl(t('sites.col.keywords'), splitList(s.keywords, ',').map((id) => h('div', {}, `${id} · ${kwMap.get(id) ?? ''}`))),
      dl(t('sites.details.fetch'), s.fetch_status || '—'),
      dl(t('sites.details.contactSource'), s.contact_source ? h('a', { href: s.contact_source, target: '_blank', rel: 'noopener noreferrer' }, s.contact_source) : '—'),
      dl(t('sites.details.firstSeen'), s.first_seen || '—'),
      dl(t('sites.details.labeled'), s.labeled_at ? `${s.labeled_at} · ${s.model} · ${s.prompt_version}` : '—'),
      s.affiliate_targets ? dl(t('sites.details.affiliate'), s.affiliate_targets) : null,
    )));
}

/* ----- История позиций ----- */

function renderHistory() {
  const { serp } = state.data;
  const kwMap = keywordMap();
  const dates = [...new Set(serp.map((r) => r.run_date))].sort();
  const hs = state.history;
  const keywordIds = [...new Set(serp.map((r) => r.keyword_id))].sort();
  const urls = [...new Set(serp.map((r) => r.normalized_url))].sort();
  if (hs.mode === 'keyword' && !hs.keyword) hs.keyword = keywordIds[0] ?? '';
  if (hs.mode === 'url' && !hs.url) hs.url = urls[0] ?? '';

  const seg = h('div', { class: 'segmented' },
    ['keyword', 'url'].map((m) => h('button', { type: 'button', class: hs.mode === m ? 'active' : '', onclick: () => { hs.mode = m; render(); } },
      t(m === 'keyword' ? 'history.byKeyword' : 'history.byUrl'))));

  const picker = hs.mode === 'keyword'
    ? h('div', { class: 'field grow' }, h('label', {}, t('history.pickKeyword')),
        h('select', { onchange: (e) => { hs.keyword = e.target.value; render(); } },
          keywordIds.map((id) => h('option', { value: id, selected: hs.keyword === id }, `${id} · ${kwMap.get(id) ?? ''}`))))
    : h('div', { class: 'field grow' }, h('label', {}, t('history.pickUrl')),
        h('select', { onchange: (e) => { hs.url = e.target.value; render(); } },
          urls.map((u) => h('option', { value: u, selected: hs.url === u }, u))));

  // строки: по ключу → URL; по URL → ключи
  const pick = hs.mode === 'keyword' ? serp.filter((r) => r.keyword_id === hs.keyword) : serp.filter((r) => r.normalized_url === hs.url);
  const rowKey = (r) => (hs.mode === 'keyword' ? r.normalized_url : r.keyword_id);
  const grid = new Map();
  for (const r of pick) {
    const k = rowKey(r);
    if (!grid.has(k)) grid.set(k, new Map());
    const cur = grid.get(k).get(r.run_date);
    const p = Number(r.position);
    if (cur === undefined || p < cur) grid.get(k).set(r.run_date, p);
  }
  const last = dates.at(-1);
  const rows = [...grid.entries()].sort((a, b) => (a[1].get(last) ?? 99) - (b[1].get(last) ?? 99) || String(a[0]).localeCompare(String(b[0])));

  const table = rows.length
    ? h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t(hs.mode === 'keyword' ? 'history.col.url' : 'history.col.keyword')), dates.map((d) => h('th', { class: 'num mono' }, d)))),
        h('tbody', {}, rows.map(([k, byDate]) => h('tr', {},
          h('td', { class: 'url-cell' }, hs.mode === 'keyword' ? h('a', { href: k, target: '_blank', rel: 'noopener noreferrer' }, k) : `${k} · ${kwMap.get(k) ?? ''}`),
          dates.map((d, i) => h('td', { class: 'num' }, posCell(byDate.get(d), i > 0 ? byDate.get(dates[i - 1]) : undefined)))))))
    : h('div', { class: 'empty' }, t('app.empty'));

  return [h('p', { class: 'hint' }, t('history.hint')), h('div', { class: 'toolbar' }, seg, picker), h('div', { class: 'panel table-wrap' }, table)];
}

function posCell(p, prev) {
  if (p === undefined) return h('span', { class: 'muted', title: t('history.notInTop') }, '—');
  let delta = null;
  if (prev !== undefined && prev !== p) delta = prev > p ? h('span', { class: 'delta-up' }, `▲${prev - p}`) : h('span', { class: 'delta-down' }, `▼${p - prev}`);
  return h('span', { class: 'pos' + (p <= 3 ? ' pos-top3' : '') }, delta, String(p));
}

/* ----- Ключи ----- */

function renderKeywords() {
  const kws = state.data.keywords;
  const form = h('form', { class: 'toolbar panel panel-pad', onsubmit: addKeyword },
    h('div', { class: 'field grow' }, h('label', { for: 'kw-new' }, t('keywords.keyword')), h('input', { id: 'kw-new', name: 'keyword', required: true, placeholder: 'best payout casino canada' })),
    h('div', { class: 'field' }, h('label', { for: 'kw-cluster' }, t('keywords.cluster')), h('input', { id: 'kw-cluster', name: 'cluster', placeholder: 'Платёжки' })),
    h('button', { class: 'btn', type: 'submit' }, t('keywords.add')));

  const rows = kws.map((k) => {
    const active = String(k.active).toUpperCase() !== 'FALSE';
    const kwInput = h('input', { value: k.keyword, 'aria-label': t('keywords.keyword') });
    const clInput = h('input', { value: k.cluster, 'aria-label': t('keywords.cluster') });
    const save = h('button', { class: 'btn btn-sm', type: 'button', hidden: true }, t('keywords.save'));
    const dirty = () => (save.hidden = kwInput.value === k.keyword && clInput.value === k.cluster);
    kwInput.addEventListener('input', dirty);
    clInput.addEventListener('input', dirty);
    save.addEventListener('click', () => patchKeyword(k.id, { keyword: kwInput.value, cluster: clInput.value }));
    return h('tr', { class: active ? '' : 'inactive' },
      h('td', { class: 'mono' }, k.id),
      h('td', { class: 'grow' }, kwInput),
      h('td', {}, clInput),
      h('td', {}, h('label', { class: 'switch' },
        h('input', { type: 'checkbox', checked: active, 'aria-label': t('keywords.col.active'), onchange: (e) => patchKeyword(k.id, { active: e.target.checked }) }),
        h('span'))),
      h('td', { class: 'mono' }, k.added_at),
      h('td', {}, save));
  });

  return [
    form,
    h('p', { class: 'hint', style: 'margin-top:12px' }, t('keywords.hint')),
    h('div', { class: 'panel table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, t('keywords.col.id')), h('th', {}, t('keywords.keyword')), h('th', {}, t('keywords.cluster')),
          h('th', {}, t('keywords.col.active')), h('th', {}, t('keywords.col.added')), h('th'))),
        h('tbody', {}, rows))),
  ];
}

async function addKeyword(e) {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/keywords', { method: 'POST', body: { keyword: fd.get('keyword'), cluster: fd.get('cluster') } });
    e.target.reset();
    toast(t('keywords.saved'));
    await loadData();
    render();
  } catch (err) {
    toast(t(`keywords.err.${err.code}`) !== `keywords.err.${err.code}` ? t(`keywords.err.${err.code}`) : err.message, true);
  }
}

async function patchKeyword(id, patch) {
  try {
    await api(`/api/keywords/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
    toast(t('keywords.saved'));
    await loadData();
    render();
  } catch (err) {
    toast(t(`keywords.err.${err.code}`) !== `keywords.err.${err.code}` ? t(`keywords.err.${err.code}`) : err.message, true);
  }
}

/* ----- Прогоны ----- */

function renderRuns() {
  const { runs, running } = state.data;
  const btn = h('button', { class: 'btn', type: 'button', disabled: Boolean(running), onclick: runNow }, t('runs.runNow'));
  const statusBadge = (s) => h('span', { class: `badge ${s === 'ok' ? 'badge-ok' : s === 'partial' ? 'badge-warn' : 'badge-bad'}` }, t(`status.${s}`));
  const table = runs.length
    ? h('table', {},
        h('thead', {}, h('tr', {},
          ['runs.col.run', 'runs.col.status', 'runs.col.started', 'runs.col.finished'].map((k) => h('th', {}, t(k))),
          ['runs.col.keywords', 'runs.col.serp', 'runs.col.urlsNew', 'runs.col.labeled', 'runs.col.fetchFailed', 'runs.col.tokens', 'runs.col.cost'].map((k) => h('th', { class: 'num' }, t(k))),
          h('th', {}, t('runs.col.error')))),
        h('tbody', {}, runs.map((r) => h('tr', {},
          h('td', { class: 'mono' }, r.run_id), h('td', {}, statusBadge(r.status)),
          h('td', { class: 'mono' }, r.started_at), h('td', { class: 'mono' }, r.finished_at),
          h('td', { class: 'num' }, `${r.keywords_ok} / ${r.keywords_failed}`),
          h('td', { class: 'num' }, r.serp_requests), h('td', { class: 'num' }, r.urls_new), h('td', { class: 'num' }, r.urls_labeled),
          h('td', { class: 'num' }, r.fetch_failed), h('td', { class: 'num' }, `${r.input_tokens} / ${r.output_tokens}`),
          h('td', { class: 'num' }, Number(r.cost_usd || 0).toFixed(4)),
          h('td', { class: 'muted', title: r.error }, r.error ? (r.error.length > 80 ? r.error.slice(0, 80) + '…' : r.error) : '')))))
    : h('div', { class: 'empty' }, t('app.empty'));
  return [h('div', { class: 'toolbar' }, btn, running ? h('span', { class: 'run-indicator' }, `${t('app.running')}: ${running}`) : h('span', { class: 'muted' }, t('app.idle'))),
    h('div', { class: 'panel table-wrap' }, table)];
}

async function runNow() {
  try {
    const r = await api('/api/runs', { method: 'POST' });
    toast(t('runs.started', { id: r.run_id }));
    await loadData();
    render();
  } catch (err) {
    toast(err.status === 409 ? t('runs.busy') : err.message, true);
  }
}

/* ----- Расписание ----- */

function renderSchedule() {
  const box = h('div', { class: 'panel panel-pad schedule' }, h('div', { class: 'empty' }, t('app.loading')));
  api('/api/schedule').then((s) => fillSchedule(box, s)).catch((e) => box.replaceChildren(h('p', { class: 'error-text' }, e.message)));
  return [h('h2', { style: 'font-size:16px;margin:0 0 12px' }, t('schedule.title')), box, h('p', { class: 'hint', style: 'margin-top:12px;max-width:640px' }, t('schedule.hint'))];
}

function fillSchedule(box, s) {
  const input = h('input', { class: 'mono', value: s.cron, placeholder: '0 7 * * *', 'aria-label': t('schedule.cron') });
  const preview = h('div');
  const fmt = new Intl.DateTimeFormat(state.lang === 'ru' ? 'ru-RU' : 'en-CA', { timeZone: s.timezone, dateStyle: 'medium', timeStyle: 'short' });
  let enabled = Boolean(s.enabled);
  const showPreview = (p, cron) => {
    if (!cron.trim()) return preview.replaceChildren(h('p', { class: 'muted' }, t('schedule.off')));
    if (!p.valid) return preview.replaceChildren(h('p', { class: 'error-text' }, `${t('schedule.invalid')}: ${p.error ?? ''}`));
    preview.replaceChildren(h('div', { class: 'muted', style: 'font-size:12px;margin-top:10px' }, t(enabled ? 'schedule.next' : 'schedule.ifEnabled')),
      h('ul', { class: 'next-runs' + (enabled ? '' : ' muted') }, p.next.map((d) => h('li', {}, fmt.format(new Date(d))))));
  };

  // Включатель автозапуска: по умолчанию выключен, чтобы прогоны сами не тратили квоту и деньги.
  const status = h('div', { class: 'schedule-status' });
  const showStatus = (nextRun) => {
    status.className = 'schedule-status ' + (enabled ? 'on' : 'off');
    status.replaceChildren(
      enabled
        ? `${t('schedule.on')}${nextRun ? ` · ${t('schedule.nextRun')}: ${fmt.format(new Date(nextRun))}` : ''}`
        : t('schedule.offManual'),
    );
  };
  const toggle = h('input', { type: 'checkbox', checked: enabled, 'aria-label': t('schedule.autorun') });
  toggle.addEventListener('change', async () => {
    const want = toggle.checked;
    try {
      const r = await api('/api/schedule', { method: 'PUT', body: { enabled: want } });
      enabled = r.enabled;
      showStatus(r.nextRun);
      showPreview(await api(`/api/schedule/preview?cron=${encodeURIComponent(input.value)}`), input.value);
      toast(t(enabled ? 'schedule.enabledToast' : 'schedule.disabledToast'));
    } catch (e) {
      toggle.checked = !want;
      toast(e.code === 'empty_cron' ? t('schedule.emptyCron') : e.code === 'invalid_cron' ? t('schedule.invalid') : e.message, true);
    }
  });
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => showPreview(await api(`/api/schedule/preview?cron=${encodeURIComponent(input.value)}`), input.value), 250);
  };
  input.addEventListener('input', refresh);
  const presets = [['schedule.preset.daily7', '0 7 * * *'], ['schedule.preset.twice', '0 7,19 * * *'], ['schedule.preset.weekdays', '0 8 * * 1-5']];
  const save = async () => {
    try {
      const r = await api('/api/schedule', { method: 'PUT', body: { cron: input.value } });
      showStatus(r.nextRun);
      toast(t('schedule.saved'));
    } catch (e) {
      toast(e.code === 'empty_cron' ? t('schedule.emptyCron') : e.code === 'invalid_cron' ? t('schedule.invalid') : e.message, true);
    }
  };
  box.replaceChildren(
    h('div', { class: 'schedule-toggle' },
      h('label', { class: 'switch' }, toggle, h('span')),
      h('div', {}, h('div', { style: 'font-weight:600' }, t('schedule.autorun')), status)),
    h('div', { class: 'toolbar', style: 'margin:0' },
      h('div', { class: 'field grow' }, h('label', {}, t('schedule.cron')), input),
      h('div', { class: 'field' }, h('label', {}, t('schedule.timezone')), h('input', { value: s.timezone, disabled: true })),
      h('button', { class: 'btn', type: 'button', onclick: save }, t('schedule.save'))),
    h('div', { class: 'muted', style: 'font-size:12px;margin-top:12px' }, t('schedule.presets')),
    h('div', { class: 'presets' }, presets.map(([k, cron]) => h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => { input.value = cron; refresh(); } }, t(k)))),
    preview,
  );
  showStatus(s.nextRun);
  showPreview(s.preview, s.cron);
}

/* ---------- старт ---------- */

function onHash() {
  state.tab = (location.hash || '#sites').slice(1);
  render();
}

async function init() {
  document.querySelectorAll('.lang button').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  window.addEventListener('hashchange', onHash);
  state.tab = (location.hash || '#sites').slice(1);
  await setLang(state.lang);
  try {
    state.meta = await api('/api/meta');
    const link = document.getElementById('sheet-link');
    if (state.meta.demo) link.hidden = true;
    else link.href = state.meta.sheetUrl;
    document.getElementById('demo-banner').hidden = !state.meta.demo;
    await loadData();
  } catch (e) {
    document.getElementById('view').replaceChildren(h('div', { class: 'empty error-text' }, `${t('app.error')}: ${e.message}`));
    return;
  }
  render();
}

init();
