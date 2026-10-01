import { MAX_BULK_USERS, parseBulkUsers } from './bulkUsers.js';

export const EXCEL_USERS_SHEET = 'メンバー追加';
export const EXCEL_USERS_HEADERS = ['参加者名', 'DiscordユーザーID', 'グループ', '権限'];
export const MAX_EXCEL_FILE_BYTES = 1024 * 1024;

const ROLES = new Map([['一般参加者', 'member'], ['担当者', 'manager']]);

export function excelUserError(line, field, message) {
  return { line, field, message: line ? `Excel ${line}行目：${message}` : message };
}

function isBlank(value) {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

export function validateExcelUserFile(file) {
  if (!file || !/\.xlsx$/i.test(file.name || '')) {
    return 'Excelブック（.xlsx）を選んでください。.xls・CSV・マクロ付きブックには対応していません。';
  }
  if (!Number.isSafeInteger(file.size) || file.size === 0 || file.size > MAX_EXCEL_FILE_BYTES) {
    return 'ファイルは空でない1MB以下のExcelブックにしてください。';
  }
  return null;
}

// Each physical worksheet row remains one person. Never filter individual columns.
export function parseExcelUsers(data, groups = []) {
  const errors = [];
  const rows = [];
  const allowedGroups = new Set(groups.map((group) => String(group ?? '').trim()).filter(Boolean));
  const firstLineById = new Map();

  if (!Array.isArray(data) || !Array.isArray(data[0])
    || EXCEL_USERS_HEADERS.some((header, index) => data[0][index] !== header)
    || data[0].slice(4).some((value) => !isBlank(value))) {
    return { rows: [], errors: [excelUserError(1, 'file', 'A〜D列の見出しを「参加者名」「DiscordユーザーID」「グループ」「権限」の順にしてください。テンプレートを利用できます。')] };
  }

  data.slice(1).forEach((cells, index) => {
    const line = index + 2;
    if (!Array.isArray(cells) || cells.every(isBlank)) return;
    if (line > MAX_BULK_USERS + 1) {
      errors.push(excelUserError(line, 'file', `入力できるのは2〜${MAX_BULK_USERS + 1}行目、最大${MAX_BULK_USERS}人です。`));
      return;
    }
    if (cells.slice(4).some((value) => !isBlank(value))) {
      errors.push(excelUserError(line, 'file', 'E列以降に入力があります。参加者の情報はA〜D列へ入力してください。'));
    }

    const [name, discordId, group, roleLabel] = cells;
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const normalizedId = typeof discordId === 'string' ? discordId.trim() : '';
    const normalizedGroup = typeof group === 'string' ? group.trim() : '';
    const role = ROLES.get(typeof roleLabel === 'string' ? roleLabel.trim() : '');
    const rowErrorCount = errors.length;

    if (typeof name !== 'string' || /[\r\n\t]/.test(normalizedName)) {
      errors.push(excelUserError(line, 'names', '参加者名は改行やタブを含まない文字列で入力してください。'));
    }
    if (typeof discordId !== 'string') {
      errors.push(excelUserError(line, 'discordUserIds', 'DiscordユーザーIDを文字列で入力してください。数値で保存されたIDは桁が丸められるため取り込めません。セルを「文字列」にして、DiscordからIDをコピーし直してください。'));
    }
    if (!allowedGroups.has(normalizedGroup)) {
      errors.push(excelUserError(line, 'groupId', 'グループは画面に表示された登録可能なグループから入力してください。'));
    }
    if (!role) {
      errors.push(excelUserError(line, 'role', '権限は「一般参加者」または「担当者」を入力してください。'));
    }

    // Reuse the existing name / ID / group / role validator, retaining Excel row numbers.
    const parsed = parseBulkUsers({
      names: normalizedName,
      discordUserIds: normalizedId,
      groupId: normalizedGroup,
      role: role || '',
    });
    for (const error of parsed.errors) {
      if (errors.slice(rowErrorCount).some((existing) => existing.field === error.field)) continue;
      errors.push(excelUserError(line, error.field, error.message.replace(/^1人目：/, '')));
    }
    if (/^\d{16,22}$/.test(normalizedId)) {
      if (firstLineById.has(normalizedId)) {
        errors.push(excelUserError(line, 'discordUserIds', `DiscordユーザーIDが${firstLineById.get(normalizedId)}行目と重複しています。`));
      } else {
        firstLineById.set(normalizedId, line);
      }
    }
    if (errors.length === rowErrorCount && parsed.rows.length === 1) {
      rows.push({ ...parsed.rows[0], sourceLine: line, sourceKind: 'excel' });
    }
  });

  if (rows.length === 0 && errors.length === 0) {
    errors.push(excelUserError(0, 'file', '2行目から参加者を1人以上入力してください。完全な空行は読み飛ばします。'));
  }
  // Any error blocks the complete import; never offer a partial registration.
  return { rows: errors.length ? [] : rows, errors };
}
