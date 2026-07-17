export const BULK_USER_HEADERS = ['参加者名', 'グループ', '権限', 'DiscordユーザーID'];
export const MAX_BULK_USERS = 100;

const ROLE_ALIASES = new Map([
  ['一般参加者', 'member'],
  ['member', 'member'],
  ['担当者', 'manager'],
  ['manager', 'manager'],
]);

function errorAt(line, message) {
  return { line, message: `${line}行目：${message}` };
}

function normalizeLines(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
}

export function maskDiscordUserId(value) {
  const id = String(value ?? '');
  return id.length >= 4 ? `末尾${id.slice(-4)}` : '末尾----';
}

export function parseBulkUsers(value) {
  const lines = normalizeLines(value);
  const firstContentIndex = lines.findIndex((line) => line.trim() !== '');

  if (firstContentIndex < 0) {
    return { rows: [], errors: [{ line: 0, message: '参加者一覧を貼り付けてください。' }] };
  }

  const headerLine = firstContentIndex + 1;
  const headers = lines[firstContentIndex].split('\t').map((cell) => cell.trim());
  const headerIsValid = headers.length === BULK_USER_HEADERS.length
    && BULK_USER_HEADERS.every((header, index) => headers[index] === header);

  if (!headerIsValid) {
    return {
      rows: [],
      errors: [errorAt(headerLine, `先頭行を「${BULK_USER_HEADERS.join(' / ')}」の4列にしてください。`)],
    };
  }

  const dataLines = lines
    .map((line, index) => ({ line, sourceLine: index + 1 }))
    .slice(firstContentIndex + 1)
    .filter(({ line }) => line.trim() !== '');

  if (dataLines.length === 0) {
    return { rows: [], errors: [{ line: 0, message: 'ヘッダーの下に、1人以上の参加者を入力してください。' }] };
  }
  if (dataLines.length > MAX_BULK_USERS) {
    return { rows: [], errors: [{ line: 0, message: `一度に追加できるのは${MAX_BULK_USERS}人までです。` }] };
  }

  const rows = [];
  const errors = [];
  const firstLineByDiscordId = new Map();

  dataLines.forEach(({ line, sourceLine }) => {
    const cells = line.split('\t').map((cell) => cell.trim());
    if (cells.length !== BULK_USER_HEADERS.length) {
      errors.push(errorAt(sourceLine, '列数が異なります。4列をまとめてコピーしてください。'));
      return;
    }

    const [name, groupId, roleLabel, discordUserId] = cells;
    const role = ROLE_ALIASES.get(roleLabel.toLowerCase());
    let rowIsValid = true;

    if (!name || name.length > 80) {
      errors.push(errorAt(sourceLine, '参加者名は1〜80文字で入力してください。'));
      rowIsValid = false;
    }
    if (!groupId || groupId.length > 80) {
      errors.push(errorAt(sourceLine, 'グループは1〜80文字で入力してください。'));
      rowIsValid = false;
    }
    if (!role) {
      errors.push(errorAt(sourceLine, '権限は「一般参加者」または「担当者」で入力してください。'));
      rowIsValid = false;
    }
    if (!/^\d{16,22}$/.test(discordUserId)) {
      errors.push(errorAt(sourceLine, 'DiscordユーザーIDは数字16〜22桁で入力してください。'));
      rowIsValid = false;
    } else if (firstLineByDiscordId.has(discordUserId)) {
      errors.push(errorAt(sourceLine, `DiscordユーザーIDが${firstLineByDiscordId.get(discordUserId)}行目と重複しています。`));
      rowIsValid = false;
    } else {
      firstLineByDiscordId.set(discordUserId, sourceLine);
    }

    if (rowIsValid) {
      rows.push({
        sourceLine,
        name,
        group_id: groupId,
        role,
        discord_user_id: discordUserId,
      });
    }
  });

  return { rows, errors };
}
