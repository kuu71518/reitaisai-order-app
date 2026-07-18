export const MAX_BULK_USERS = 100;

const ASSIGNABLE_ROLES = new Set(['member', 'manager']);

function generalError(field, message) {
  return { field, line: 0, message };
}

function errorAt(line, field, message) {
  return { field, line, message: `${line}人目：${message}` };
}

function normalizeLines(value) {
  const lines = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim());

  // 末尾の改行だけを無視する。先頭・途中の空行は、名前とIDの対応を
  // ずらさないため、その位置に残して入力エラーとして扱う。
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

export function countBulkUserLines(value) {
  return normalizeLines(value).length;
}

export function maskDiscordUserId(value) {
  const id = String(value ?? '');
  return id.length >= 4 ? `末尾${id.slice(-4)}` : '末尾----';
}

export function parseBulkUsers({ names = '', discordUserIds = '', groupId = '', role = 'member' } = {}) {
  const nameLines = normalizeLines(names);
  const discordIdLines = normalizeLines(discordUserIds);
  const normalizedGroupId = String(groupId ?? '').trim();
  const normalizedRole = String(role ?? '').trim().toLowerCase();

  if (nameLines.length === 0 && discordIdLines.length === 0) {
    return {
      rows: [],
      errors: [generalError('lists', '参加者名とDiscordユーザーIDを入力してください。')],
    };
  }
  if (nameLines.length === 0) {
    return {
      rows: [],
      errors: [generalError('names', '参加者名を1人ずつ改行して入力してください。')],
    };
  }
  if (discordIdLines.length === 0) {
    return {
      rows: [],
      errors: [generalError('discordUserIds', 'DiscordユーザーIDを1人ずつ改行して入力してください。')],
    };
  }

  const largestCount = Math.max(nameLines.length, discordIdLines.length);
  if (largestCount > MAX_BULK_USERS) {
    return {
      rows: [],
      errors: [generalError('lists', `一度に追加できるのは${MAX_BULK_USERS}人までです。`)],
    };
  }
  if (nameLines.length !== discordIdLines.length) {
    return {
      rows: [],
      errors: [generalError(
        'count',
        `参加者名は${nameLines.length}人、DiscordユーザーIDは${discordIdLines.length}人です。同じ人数にしてください。`,
      )],
    };
  }

  const errors = [];
  const rows = [];
  const firstLineByDiscordId = new Map();
  const sharedValuesAreValid = normalizedGroupId.length >= 1
    && normalizedGroupId.length <= 80
    && ASSIGNABLE_ROLES.has(normalizedRole);

  if (!normalizedGroupId || normalizedGroupId.length > 80) {
    errors.push(generalError('groupId', '全員のグループを選んでください。'));
  }
  if (!ASSIGNABLE_ROLES.has(normalizedRole)) {
    errors.push(generalError('role', '全員の権限は「一般参加者」または「担当者」から選んでください。'));
  }

  nameLines.forEach((name, index) => {
    const line = index + 1;
    const discordUserId = discordIdLines[index];
    let rowIsValid = true;

    if (!name || name.length > 80) {
      errors.push(errorAt(line, 'names', '参加者名は1〜80文字で入力してください。'));
      rowIsValid = false;
    } else if (name.includes('\t')) {
      errors.push(errorAt(line, 'names', '参加者名だけを入力し、1人ごとに改行してください。'));
      rowIsValid = false;
    }

    if (!/^\d{16,22}$/.test(discordUserId)) {
      errors.push(errorAt(line, 'discordUserIds', 'DiscordユーザーIDは数字16〜22桁を1人につき1行で入力してください。'));
      rowIsValid = false;
    } else if (firstLineByDiscordId.has(discordUserId)) {
      errors.push(errorAt(line, 'discordUserIds', `DiscordユーザーIDが${firstLineByDiscordId.get(discordUserId)}人目と重複しています。`));
      rowIsValid = false;
    } else {
      firstLineByDiscordId.set(discordUserId, line);
    }

    if (rowIsValid && sharedValuesAreValid) {
      rows.push({
        sourceLine: line,
        name,
        group_id: normalizedGroupId,
        role: normalizedRole,
        discord_user_id: discordUserId,
      });
    }
  });

  return { rows, errors };
}
