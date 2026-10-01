import { Unzip, UnzipInflate } from 'fflate';
import { readSheet } from 'read-excel-file/universal';
import { EXCEL_USERS_SHEET, excelUserError, parseExcelUsers, validateExcelUserFile } from './excelUsers.js';

const MAX_ARCHIVE_ENTRIES = 128;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;
const XML_NAMESPACES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
];

class ExcelImportError extends Error {}

// Bounded streaming decompression stops on actual output size, not only ZIP metadata.
export function unpackExcelForValidation(bytes) {
  const entries = new Map();
  let expandedBytes = 0;
  let completed = 0;
  const unzip = new Unzip((entry) => {
    if (entries.size >= MAX_ARCHIVE_ENTRIES || entries.has(entry.name)) {
      throw new ExcelImportError('ファイルの内部構成が複雑すぎるか重複しています。新しいテンプレートへ値を貼り付けて保存してください。');
    }
    if (entry.originalSize > MAX_ENTRY_BYTES) {
      throw new ExcelImportError('展開後のファイルが大きすぎます。画像などを含めず、テンプレートへ値だけを貼り付けてください。');
    }
    const chunks = [];
    let entryBytes = 0;
    entries.set(entry.name, null);
    entry.ondata = (error, chunk, final) => {
      if (error) throw new ExcelImportError('Excelブックを読み取れませんでした。Excelで開いて.xlsx形式で保存し直してください。');
      entryBytes += chunk.length;
      expandedBytes += chunk.length;
      if (entryBytes > MAX_ENTRY_BYTES || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new ExcelImportError('展開後のファイルが大きすぎます。画像などを含めず、テンプレートへ値だけを貼り付けてください。');
      }
      chunks.push(chunk);
      if (final) {
        const content = new Uint8Array(entryBytes);
        let offset = 0;
        for (const part of chunks) { content.set(part, offset); offset += part.length; }
        entries.set(entry.name, content);
        completed += 1;
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  }
  if (entries.size === 0 || completed !== entries.size) throw new ExcelImportError('Excelブックが不完全です。保存し直してから読み込んでください。');
  return entries;
}

function parseXmlEntry(entries, path) {
  const content = entries.get(path);
  if (!content) throw new ExcelImportError('Excelブックに必要な情報がありません。テンプレートを利用してください。');
  // DOMParser performs no network requests. DTD and custom entities are unnecessary here.
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(content);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ExcelImportError('対応していないExcelブックの形式です。テンプレートを利用してください。');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length) throw new ExcelImportError('Excelブックの構成を読み取れませんでした。保存し直してください。');
  return document;
}

function inspectMemberSheet(entries) {
  const workbook = parseXmlEntry(entries, 'xl/workbook.xml');
  const sheet = [...workbook.getElementsByTagNameNS('*', 'sheet')]
    .find((item) => item.getAttribute('name') === EXCEL_USERS_SHEET);
  if (!sheet) throw new ExcelImportError(`「${EXCEL_USERS_SHEET}」シートがありません。テンプレートを利用してください。`);
  const relationId = XML_NAMESPACES.map((namespace) => sheet.getAttributeNS(namespace, 'id')).find(Boolean);
  const relationships = parseXmlEntry(entries, 'xl/_rels/workbook.xml.rels');
  const relationship = [...relationships.getElementsByTagNameNS('*', 'Relationship')]
    .find((item) => item.getAttribute('Id') === relationId);
  const target = relationship?.getAttribute('Target');
  if (!target || relationship.getAttribute('TargetMode') === 'External') throw new ExcelImportError('参加者シートを読み取れませんでした。テンプレートを利用してください。');
  const path = new URL(target, 'https://local.invalid/xl/workbook.xml').pathname.slice(1);
  if (!path.startsWith('xl/worksheets/')) throw new ExcelImportError('参加者シートを読み取れませんでした。テンプレートを利用してください。');
  const worksheet = parseXmlEntry(entries, path);
  const errors = [];
  const cells = [...worksheet.getElementsByTagNameNS('*', 'c')];
  const sheetRows = [...worksheet.getElementsByTagNameNS('*', 'row')];
  // Prevent huge sparse row / column allocations before the spreadsheet parser runs.
  if (cells.length > 5000 || sheetRows.length > 1000
    || sheetRows.some((row) => Number(row.getAttribute('r')) > 1000)) {
    throw new ExcelImportError('入力範囲が大きすぎます。テンプレートの2〜101行目へ値だけを貼り付けてください。');
  }
  for (const cell of cells) {
    const address = cell.getAttribute('r');
    const match = /^([A-Z]{1,2})([1-9]\d{0,2}|1000)$/.exec(address);
    if (!match || match[1].length > 1) throw new ExcelImportError('入力範囲が大きすぎるかセル位置が不正です。テンプレートへ値だけを貼り付けてください。');
    const line = Number(match[2]);
    // Some XLSX writers store plain text as t="str" with a <v> and no formula.
    // Reject the actual <f> element, including shared / cached formulas, not the text type.
    if (cell.getElementsByTagNameNS('*', 'f').length) {
      errors.push(excelUserError(line, 'file', '数式のあるセルは取り込めません。内容を確認して値だけを貼り付けてください。'));
    }
  }
  if (worksheet.getElementsByTagNameNS('*', 'mergeCell').length) {
    errors.push(excelUserError(0, 'file', '参加者シートに結合セルがあります。結合を解除するかテンプレートを利用してください。'));
  }
  return errors;
}

export async function readExcelUsers(file, groups) {
  const fileError = validateExcelUserFile(file);
  if (fileError) return { rows: [], errors: [excelUserError(0, 'file', fileError)] };
  try {
    const buffer = await file.arrayBuffer();
    const entries = unpackExcelForValidation(new Uint8Array(buffer));
    const errors = inspectMemberSheet(entries);
    if (errors.length) return { rows: [], errors };
    const data = await readSheet(buffer, EXCEL_USERS_SHEET, { trim: false });
    return parseExcelUsers(data, groups);
  } catch (error) {
    // Parser errors may contain cell values. Never display or log their raw messages.
    const message = error instanceof ExcelImportError ? error.message
      : 'Excelブックを読み取れませんでした。パスワード保護を解除し、Excelで.xlsx形式に保存し直してください。';
    return { rows: [], errors: [excelUserError(0, 'file', message)] };
  }
}
