import { useRef, useState } from 'react';
import { ApiError, apiRequest, getErrorMessage } from '../../lib/api';
import { countBulkUserLines, maskDiscordUserId, parseBulkUsers } from '../../lib/bulkUsers';
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
      const sourceLine = rows[Number(rowNumber) - 1]?.sourceLine;
      return `${sourceLine || rowNumber}人目：${reason}`;
    });
  }

  const validationErrors = Array.isArray(payload?.data?.errors) ? payload.data.errors : [];
  return validationErrors.map((item) => {
    const sourceLine = rows[Number(item?.row) - 1]?.sourceLine || item?.row;
    const fields = Array.isArray(item?.fields)
      ? item.fields.map((field) => FIELD_LABELS[field] || field).join('、')
      : '';
    return `${sourceLine || '?'}人目：${fields || '入力内容'}を確認してください。`;
  });
}

export default function BulkUserImport({ groups = [], onComplete }) {
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
  const resultRef = useRef(null);

  const availableGroups = [...new Set(
    groups.map((group) => String(group ?? '').trim()).filter(Boolean),
  )];
  const selectedGroupId = availableGroups.includes(draft.groupId) ? draft.groupId : '';
  const namesCount = countBulkUserLines(draft.names);
  const discordIdsCount = countBulkUserLines(draft.discordUserIds);
  const hasAnyListInput = draft.names.trim() !== '' || draft.discordUserIds.trim() !== '';
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
    setDraft((current) => ({ ...current, names: '', discordUserIds: '' }));
    invalidateReview();
    window.requestAnimationFrame(() => namesInputRef.current?.focus());
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
    if (busy || !preview || preview.errors.length > 0 || preview.rows.length === 0) return;
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
      focusResult();
      return;
    }

    const createdCount = Number(payload?.data?.created_count) || submittedRows.length;
    setDraft({ names: '', discordUserIds: '', groupId: '', role: 'member' });
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
    focusResult();
  };

  return (
    <section className="admin-panel admin-bulk-panel" aria-labelledby="admin-bulk-person-heading">
      <div className="admin-panel-heading">
        <div>
          <p className="admin-eyebrow">まとめて登録</p>
          <h2 id="admin-bulk-person-heading">同じグループの参加者をまとめて追加</h2>
        </div>
        <p className="admin-panel-description">参加者名とDiscordユーザーIDだけを同じ順番で入力し、全員に共通の設定を選びます。</p>
      </div>

      <div className="admin-bulk-guide">
        <strong>同じ番号どうしで1人として登録します</strong>
        <span>参加者名の1人目と、DiscordユーザーIDの1人目が同じ人です。カンマや見出し行は必要ありません。</span>
      </div>

      <div className="admin-form" aria-busy={busy}>
        {(!preview || preview.errors.length > 0) && (
          <>
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
              <div className="admin-bulk-preview-settings">
                <span>全員の設定</span>
                <strong>{preview.rows[0].group_id}・{roleLabel(preview.rows[0].role)}</strong>
              </div>
              <ol className="admin-bulk-preview-list" tabIndex="0" aria-label="追加する参加者の組み合わせ">
                {preview.rows.map((row) => (
                  <li key={`${row.sourceLine}-${row.name}`}>
                    <span>{row.sourceLine}人目</span>
                    <strong>{row.name}</strong>
                    <small>Discord ID {maskDiscordUserId(row.discord_user_id)}</small>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="admin-form-actions">
          {hasAnyListInput && (!preview || preview.errors.length > 0) && (
            <button type="button" className="admin-button admin-button-secondary" onClick={clearLists} disabled={busy}>
              名前とIDを消す
            </button>
          )}
          {preview && preview.errors.length === 0 && preview.rows.length > 0 ? (
            <>
              <button
                type="button"
                className="admin-button admin-button-secondary"
                onClick={() => {
                  invalidateReview();
                  window.requestAnimationFrame(() => namesInputRef.current?.focus());
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
            <button type="button" className="admin-button admin-button-primary" onClick={preparePreview} disabled={busy || !hasAnyListInput}>
              名前とIDの組み合わせを確認
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
