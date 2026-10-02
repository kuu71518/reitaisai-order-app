import { useRef, useState } from 'react';
import { ApiError, apiRequest, getErrorMessage } from '../../lib/api';
import { countBulkUserLines, maskDiscordUserId, parseBulkUsers } from '../../lib/bulkUsers';
import { excelUserError, validateExcelUserFile } from '../../lib/excelUsers';
import { Field, StatusNotice } from '../States';

const FIELD_LABELS = {
  name: '参加者名',
  group_id: 'グループ',
  role: '権限',
  discord_user_id: 'DiscordユーザーID',
};

const ROLE_OPTIONS = [
  { value: 'member', label: '一般参加者' },
  { value: 'manager', label: '担当者' },
  { value: 'chief', label: '主任' },
];

function roleLabel(role) {
  return ROLE_OPTIONS.find((option) => option.value === role)?.label || '権限不明';
}

function getServerRowErrors(error, rows) {
  if (!(error instanceof ApiError)) return [];
  const payload = error.payload;
  const duplicateRows = Array.isArray(payload?.data?.rows) ? payload.data.rows : [];

  if (payload?.code === 'BULK_DUPLICATE_IN_REQUEST' || payload?.code === 'BULK_DUPLICATE_EXISTING') {
    const reason = payload.code === 'BULK_DUPLICATE_EXISTING'
      ? 'すでに登録済みのDiscordアカウントです。'
      : '一括入力内でDiscordアカウントが重複しています。';
    return duplicateRows.map((rowNumber) => {
      const row = rows[Number(rowNumber) - 1];
      return `${row?.sourceKind === 'excel' ? `Excel ${row.sourceLine}行目` : `${row?.sourceLine || rowNumber}人目`}：${reason}`;
    });
  }

  const validationErrors = Array.isArray(payload?.data?.errors) ? payload.data.errors : [];
  return validationErrors.map((item) => {
    const row = rows[Number(item?.row) - 1];
    const sourceLine = row?.sourceLine || item?.row;
    const fields = Array.isArray(item?.fields)
      ? item.fields.map((field) => FIELD_LABELS[field] || field).join('、')
      : '';
    return `${row?.sourceKind === 'excel' ? `Excel ${sourceLine}行目` : `${sourceLine || '?'}人目`}：${fields || '入力内容'}を確認してください。`;
  });
}

export default function BulkUserImport({ groups = [], onComplete }) {
  const [inputMode, setInputMode] = useState('excel');
  const [excelFile, setExcelFile] = useState(null);
  const [reading, setReading] = useState(false);
  const [draft, setDraft] = useState({
    names: '',
    discordUserIds: '',
    groupId: '',
    role: 'member',
  });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [serverErrors, setServerErrors] = useState([]);
  const namesInputRef = useRef(null);
  const fileInputRef = useRef(null);
  const operationRef = useRef(false);
  const resultRef = useRef(null);

  const availableGroups = [...new Set(
    groups.map((group) => String(group ?? '').trim()).filter(Boolean),
  )];
  const selectedGroupId = availableGroups.includes(draft.groupId) ? draft.groupId : '';
  const namesCount = countBulkUserLines(draft.names);
  const discordIdsCount = countBulkUserLines(draft.discordUserIds);
  const hasAnyListInput = draft.names.trim() !== '' || draft.discordUserIds.trim() !== '';
  const hasAnyInput = inputMode === 'excel' ? Boolean(excelFile) : hasAnyListInput;
  const countsMatch = namesCount > 0 && namesCount === discordIdsCount;
  const errorFields = new Set(preview?.errors.flatMap((error) => {
    if (error.field === 'lists' || error.field === 'count') return ['names', 'discordUserIds'];
    return [error.field];
  }) || []);

  const focusResult = () => {
    window.requestAnimationFrame(() => resultRef.current?.focus());
  };

  const invalidateReview = () => {
    setPreview(null);
    setNotice(null);
    setServerErrors([]);
  };

  const updateDraft = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    invalidateReview();
  };

  const clearLists = () => {
    if (inputMode === 'excel') {
      setExcelFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } else {
      setDraft((current) => ({ ...current, names: '', discordUserIds: '' }));
    }
    invalidateReview();
    window.requestAnimationFrame(() => (inputMode === 'excel' ? fileInputRef : namesInputRef).current?.focus());
  };

  const prepareExcelPreview = async (file = excelFile) => {
    if (operationRef.current || !file) return;
    operationRef.current = true;
    setReading(true);
    setBusy(true);
    invalidateReview();
    let result;
    try {
      const fileError = validateExcelUserFile(file);
      if (fileError) {
        result = { rows: [], errors: [excelUserError(0, 'file', fileError)] };
      } else {
        const { readExcelUsers } = await import('../../lib/excelUsersFile');
        result = await readExcelUsers(file, availableGroups);
      }
    } catch {
      result = { rows: [], errors: [excelUserError(0, 'file', '読込機能を準備できませんでした。通信状態を確認して、もう一度お試しください。')] };
    }
    setPreview(result);
    setNotice(result.errors.length
      ? { tone: 'danger', title: 'Excelの入力内容を確認してください', message: '1人も登録していません。下の内容を修正して保存し、ファイルを選び直してください。' }
      : { tone: 'success', title: `${result.rows.length}人分を読み込みました`, message: '各行の名前・ID末尾・グループ・権限を確認してから、一括追加を押してください。まだ登録していません。' });
    setReading(false);
    setBusy(false);
    operationRef.current = false;
    focusResult();
  };

  const preparePreview = () => {
    const result = parseBulkUsers({ ...draft, groupId: selectedGroupId });
    setPreview(result);
    setServerErrors([]);
    setNotice(result.errors.length > 0
      ? { tone: 'danger', title: '入力内容を確認してください', message: '下に表示された内容を直し、もう一度組み合わせを確認してください。' }
      : {
        tone: 'success',
        title: `${result.rows.length}人分の組み合わせを確認できました`,
        message: `全員を「${selectedGroupId}・${roleLabel(draft.role)}」で追加します。`,
      });
    focusResult();
  };

  const addUsers = async () => {
    if (operationRef.current || busy || !preview || preview.errors.length > 0 || preview.rows.length === 0) return;
    operationRef.current = true;
    setBusy(true);
    setNotice(null);
    setServerErrors([]);

    const submittedRows = preview.rows;
    let payload;
    try {
      payload = await apiRequest('/api/admin/users/bulk', {
        method: 'POST',
        body: {
          users: submittedRows.map((user) => ({
            name: user.name,
            group_id: user.group_id,
            role: user.role,
            discord_user_id: user.discord_user_id,
          })),
        },
      });
    } catch (error) {
      const rowErrors = getServerRowErrors(error, submittedRows);
      setPreview(null);
      setServerErrors(rowErrors);
      setNotice({
        tone: 'danger',
        title: '参加者を追加できませんでした',
        message: rowErrors.length > 0
          ? '該当する人を直して、もう一度お試しください。'
          : getErrorMessage(error, '通信状態を確認して、もう一度お試しください。'),
      });
      setBusy(false);
      operationRef.current = false;
      focusResult();
      return;
    }

    const createdCount = Number(payload?.data?.created_count) || submittedRows.length;
    setDraft({ names: '', discordUserIds: '', groupId: '', role: 'member' });
    setExcelFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setPreview(null);
    setNotice({ tone: 'success', title: `${createdCount}人を追加しました`, message: '参加者一覧も最新の状態に更新します。' });

    let refreshed = true;
    try {
      if (onComplete) refreshed = await onComplete({ createdCount, payload }) !== false;
    } catch {
      refreshed = false;
    }
    if (!refreshed) {
      setNotice({
        tone: 'warning',
        title: `${createdCount}人の追加は完了しました`,
        message: '参加者一覧だけ最新の状態に更新できませんでした。通信状態を確認して、「最新情報に更新」を押してください。',
      });
    }
    setBusy(false);
    operationRef.current = false;
    focusResult();
  };

  return (
    <section className="admin-panel admin-bulk-panel" aria-labelledby="admin-bulk-person-heading">
      <div className="admin-panel-heading">
        <div>
          <p className="admin-eyebrow">まとめて登録</p>
          <h2 id="admin-bulk-person-heading">参加者をまとめて追加</h2>
        </div>
        <p className="admin-panel-description">Excelのリスト、または名前とIDの入力から、最大100人を確認して一括登録できます。</p>
      </div>

      <div className="admin-bulk-mode" role="group" aria-label="一括追加の入力方法">
        <button type="button" className={`admin-button ${inputMode === 'excel' ? 'admin-button-primary' : 'admin-button-secondary'}`} aria-pressed={inputMode === 'excel'} disabled={busy} onClick={() => { setInputMode('excel'); invalidateReview(); }}>Excelファイルから</button>
        <button type="button" className={`admin-button ${inputMode === 'lists' ? 'admin-button-primary' : 'admin-button-secondary'}`} aria-pressed={inputMode === 'lists'} disabled={busy} onClick={() => { setInputMode('lists'); setExcelFile(null); invalidateReview(); }}>名前とIDを直接入力</button>
      </div>

      {inputMode === 'lists' && <div className="admin-bulk-guide">
        <strong>同じ番号どうしで1人として登録します</strong>
        <span>参加者名の1人目と、DiscordユーザーIDの1人目が同じ人です。カンマや見出し行は必要ありません。</span>
      </div>}

      <div className="admin-form" aria-busy={busy}>
        {(!preview || preview.errors.length > 0) && (
          <>
            {inputMode === 'excel' ? <div className="admin-excel-source">
              <div className="admin-bulk-guide">
                <strong>1行につき1人。グループや権限を別々に指定できます</strong>
                <span>テンプレートの「メンバー追加」シートの2〜101行目へ入力してください。DiscordユーザーIDは文字列のまま貼り付けます。</span>
                <a className="admin-excel-template" href="/templates/member-import.xlsx" download="メンバー追加リスト.xlsx">Excelテンプレートをダウンロード</a>
              </div>
              <p className="admin-bulk-settings-hint">登録可能なグループ：{availableGroups.length ? availableGroups.join('、') : 'グループがありません'}<br />権限：一般参加者・担当者・主任（全グループの会計を閲覧）</p>
              <Field label="入力済みのExcelファイル" required>
                <input ref={fileInputRef} type="file" className="admin-input admin-excel-file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy || availableGroups.length === 0} aria-describedby="admin-excel-hint" onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  event.target.value = '';
                  setExcelFile(file);
                  invalidateReview();
                  if (file) void prepareExcelPreview(file);
                }} />
                {excelFile && <span className="field-hint">選択中：{excelFile.name}</span>}
                <span id="admin-excel-hint" className="field-hint">.xlsx形式・1MB以下。ファイルの内容はこの画面内で読み取り、一括追加を押すまで送信しません。</span>
              </Field>
              {reading && <p role="status">Excelファイルを読み込んでいます…</p>}
            </div> : <>
            <div className="admin-bulk-source-grid">
              <Field label="1. 参加者名を入力" required>
                <textarea
                  ref={namesInputRef}
                  className="admin-input admin-bulk-textarea"
                  value={draft.names}
                  onChange={(event) => updateDraft('names', event.target.value)}
                  placeholder={'Aさん\nBさん\nCさん'}
                  autoComplete="off"
                  aria-describedby="admin-bulk-names-hint admin-bulk-count-summary"
                  aria-invalid={errorFields.has('names') || undefined}
                  required
                  disabled={busy}
                />
                <span id="admin-bulk-names-hint" className="field-hint">1人入力したら改行します。見出しは入れません。</span>
              </Field>

              <Field label="2. 同じ順番でDiscordユーザーIDを入力" required>
                <textarea
                  className="admin-input admin-bulk-textarea admin-bulk-id-list"
                  value={draft.discordUserIds}
                  onChange={(event) => updateDraft('discordUserIds', event.target.value)}
                  placeholder={'123456789012340001\n223456789012340002\n323456789012340003'}
                  autoComplete="off"
                  spellCheck="false"
                  aria-describedby="admin-bulk-ids-hint admin-bulk-count-summary"
                  aria-invalid={errorFields.has('discordUserIds') || serverErrors.length > 0 || undefined}
                  required
                  disabled={busy}
                />
                <span id="admin-bulk-ids-hint" className="field-hint">Discordの「ユーザーIDをコピー」で取得した数字を、1人につき1行入力します。ユーザー名ではありません。</span>
              </Field>
            </div>

            <div
              id="admin-bulk-count-summary"
              className={`admin-bulk-count-summary${namesCount > 0 && discordIdsCount > 0 && !countsMatch ? ' is-mismatch' : ''}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span>参加者名 <strong>{namesCount}人</strong></span>
              <span>Discord ID <strong>{discordIdsCount}人</strong></span>
              <b>
                {countsMatch && '人数が一致しています'}
                {!countsMatch && namesCount > 0 && discordIdsCount > 0 && '両方を同じ人数にしてください'}
                {!countsMatch && namesCount > 0 && discordIdsCount === 0 && '次にDiscord IDを入力してください'}
                {!countsMatch && namesCount === 0 && discordIdsCount > 0 && '参加者名を入力してください'}
                {!hasAnyListInput && '入力すると人数を確認できます'}
              </b>
            </div>

            <div className="admin-form-grid admin-bulk-settings">
              <Field label="3. 全員のグループ" required>
                <select
                  className="admin-select"
                  value={selectedGroupId}
                  onChange={(event) => updateDraft('groupId', event.target.value)}
                  aria-describedby="admin-bulk-settings-hint"
                  aria-invalid={errorFields.has('groupId') || undefined}
                  required
                  disabled={busy || availableGroups.length === 0}
                >
                  <option value="" disabled>{availableGroups.length > 0 ? 'グループを選んでください' : '選べるグループがありません'}</option>
                  {availableGroups.map((group) => <option key={group} value={group}>{group}</option>)}
                </select>
              </Field>

              <Field label="4. 全員の権限" required>
                <select
                  className="admin-select"
                  value={draft.role}
                  onChange={(event) => updateDraft('role', event.target.value)}
                  aria-describedby="admin-bulk-settings-hint"
                  aria-invalid={errorFields.has('role') || undefined}
                  required
                  disabled={busy}
                >
                  {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </Field>
            </div>
            <p id="admin-bulk-settings-hint" className="admin-bulk-settings-hint">グループや権限が違う人は、分けて追加してください。権限は「一般参加者」が標準です。</p>
            </>}
          </>
        )}

        <div ref={resultRef} className="admin-bulk-result" tabIndex="-1">
          {notice && <StatusNotice tone={notice.tone} title={notice.title} live>{notice.message}</StatusNotice>}

          {preview?.errors.length > 0 && (
            <ul className="admin-operation-errors" aria-label="修正が必要な箇所">
              {preview.errors.map((error, index) => <li key={`${error.field}-${error.line}-${index}`}>{error.message}</li>)}
            </ul>
          )}
          {serverErrors.length > 0 && (
            <ul className="admin-operation-errors" aria-label="追加できなかった箇所">
              {serverErrors.map((message) => <li key={message}>{message}</li>)}
            </ul>
          )}

          {preview && preview.errors.length === 0 && preview.rows.length > 0 && (
            <div className="admin-bulk-preview" aria-labelledby="admin-bulk-preview-heading">
              <div className="admin-bulk-preview-heading">
                <div>
                  <span>追加前の確認</span>
                  <h3 id="admin-bulk-preview-heading">名前とIDを確認</h3>
                </div>
                <strong>{preview.rows.length}人</strong>
              </div>
              {inputMode === 'lists' && <div className="admin-bulk-preview-settings">
                <span>全員の設定</span>
                <strong>{preview.rows[0].group_id}・{roleLabel(preview.rows[0].role)}</strong>
              </div>}
              <ol className="admin-bulk-preview-list" tabIndex="0" aria-label="追加する参加者の組み合わせ">
                {preview.rows.map((row) => (
                  <li key={`${row.sourceLine}-${row.name}`}>
                    <span>{row.sourceKind === 'excel' ? `Excel ${row.sourceLine}行目` : `${row.sourceLine}人目`}</span>
                    <strong>{row.name}</strong>
                    <small>Discord ID {maskDiscordUserId(row.discord_user_id)}</small>
                    {inputMode === 'excel' && <small>{row.group_id}・{roleLabel(row.role)}</small>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="admin-form-actions">
          {hasAnyInput && (!preview || preview.errors.length > 0) && (
            <button type="button" className="admin-button admin-button-secondary" onClick={clearLists} disabled={busy}>
              {inputMode === 'excel' ? '選択を解除' : '名前とIDを消す'}
            </button>
          )}
          {preview && preview.errors.length === 0 && preview.rows.length > 0 ? (
            <>
              <button
                type="button"
                className="admin-button admin-button-secondary"
                onClick={() => {
                  invalidateReview();
                  window.requestAnimationFrame(() => (inputMode === 'excel' ? fileInputRef : namesInputRef).current?.focus());
                }}
                disabled={busy}
              >
                入力に戻る
              </button>
              <button type="button" className="admin-button admin-button-primary" onClick={addUsers} disabled={busy}>
                {busy ? '追加しています' : `この${preview.rows.length}人をまとめて追加`}
              </button>
            </>
          ) : (
            <button type="button" className="admin-button admin-button-primary" onClick={inputMode === 'excel' ? () => prepareExcelPreview() : preparePreview} disabled={busy || !hasAnyInput}>
              {reading ? '読み込んでいます' : inputMode === 'excel' ? 'Excelの内容を確認' : '名前とIDの組み合わせを確認'}
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
