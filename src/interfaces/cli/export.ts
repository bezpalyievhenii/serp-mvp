import ExcelJS from 'exceljs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, loadEnv, missingForRun } from '../../config';
import { SHEET_NAMES } from '../../core/schema';
import { buildSheetsStore, consoleLogger as log } from '../wiring';

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * npm run export — дамп всех листов таблицы в results/: <Лист>.csv и один results.xlsx.
 * Одно чтение всех листов (batchGet), в таблицу ничего не пишет.
 */
export async function exportResults(): Promise<number> {
  const { env } = loadEnv();
  const problems = missingForRun(env).filter((p) => !/SEARCHAPI_KEY|HASDATA_KEY/.test(p));
  if (problems.length) {
    problems.forEach((p) => log.error(p));
    return 1;
  }
  const store = buildSheetsStore(env, log);
  const data = await store.readMany(SHEET_NAMES);
  const dir = join(ROOT, 'results');
  await mkdir(dir, { recursive: true });

  const wb = new ExcelJS.Workbook();
  wb.creator = 'serp-mvp';
  for (const name of SHEET_NAMES) {
    const header = store.headerOf(name);
    const rows = data[name].map((r) => header.map((h) => r[h] ?? ''));
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
    await writeFile(join(dir, `${name}.csv`), '﻿' + csv); // BOM — чтобы Excel открыл UTF-8 с кириллицей
    // «History» — зарезервированное имя листа в Excel.
    const ws = wb.addWorksheet(name === 'History' ? 'History_' : name);
    ws.addRow(header).font = { bold: true };
    for (const r of rows) ws.addRow(r.map((v) => (v !== '' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)));
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    header.forEach((h, i) => (ws.getColumn(i + 1).width = Math.min(60, Math.max(10, h.length + 2, ...rows.slice(0, 200).map((r) => (r[i] ?? '').length * 0.9)))));
    log.info(`${name}: ${rows.length} строк`);
  }
  await wb.xlsx.writeFile(join(dir, 'results.xlsx'));
  log.info(`Сохранено в ${dir}: ${SHEET_NAMES.map((n) => `${n}.csv`).join(', ')}, results.xlsx`);
  return 0;
}
