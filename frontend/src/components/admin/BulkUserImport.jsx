import { useState } from 'react';
import { ApiError, apiRequest, getErrorMessage } from '../../lib/api';
import { BULK_USER_HEADERS, maskDiscordUserId, parseBulkUsers } from '../../lib/bulkUsers';
import { Field, StatusNotice } from '../States';

const FIELD_LABELS = {
  name: '参加者名',
  group_id: 'グループ',
  role: '権限',
  discord_user_id: 'DiscordユーザーID',
};

function roleLabel(role) {
  return role === 'manager' ? '担当者' : '一般参加者';
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
      return `${sourceLine || rowNumber}行目：${reason}`;
    });
  }

  const validationErrors = Array.isArray(payload?.data?.errors) ? payload.data.errors : [];
  return validationErrors.map((item) => {
    const sourceLine = rows[Number(item?.row) - 1]?.sourceLine || item?.row;
    const fields = Array.isArray(item?.fields)
      ? item.fields.map((field) => FIELD_LABELS[field] || field).join('、')
      : '';
    return `${sourceLine || '?'}行目：${fields || '入力内容'}を確認してください。`;
  });
}

export default function BulkUserImport({ onComplete }) {
  const [source, setSource] = useState('');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [serverErrors, setServerErrors] = useState([]);

  const updateSource = (value) => {
    setSource(value);
    setPreview(null);
    setNotice(null);
    setServerErrors([]);
  };

  const preparePreview = () => {
    const result = parseBulkUsers(source);
    setPreview(result);
    setServerErrors([]);
    setNotice(result.errors.length > 0
      ? { tone: 'danger', title: '入力内容を確認してください', message: '下の行番号を直し、もう一度「入力内容を確認」を押してください。' }
      : { tone: 'success', title: `${result.rows.length}人分を確認できました`, message: '名前、グループ、権限を確認してから追加してください。' });
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
      setServerErrors(rowErrors);
      setNotice({
        tone: 'danger',
        title: '参加者を追加できませんでした',
        message: rowErrors.length > 0
          ? '該当する行を直して、もう一度お試しください。'
          : getErrorMessage(error, '通信状態を確認して、もう一度お試しください。'),
      });
      setBusy(false);
      return;
    }

    const createdCount = Number(payload?.data?.created_count) || submittedRows.length;
    setSource('');
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
  };

  return (
    <section className="admin-panel admin-bulk-panel" aria-labelledby="admin-bulk-person-heading">
      <div className="admin-panel-heading">
        <div>
          <p className="admin-eyebrow">まとめて登録</p>
          <h2 id="admin-bulk-person-heading">参加者をまとめて追加</h2>
        </div>
        <p className="admin-panel-description">Excelやスプレッドシートの4列をコピーし、そのまま貼り付けます。</p>
      </div>

      <details className="admin-import-help">
        <summary>貼り付ける表の作り方</summary>
        <p>先頭行に以下の4つの見出しを入れ、1行に1人ずつ入力します。権限は「一般参加者」または「担当者」です。</p>
        <div className="admin-import-header-example" aria-label="必要な4列">
          {BULK_USER_HEADERS.map((header) => <span key={header}>{header}</span>)}
        </div>
      </details>

      <div className="admin-form" aria-busy={busy}>
        {(!preview || preview.errors.length > 0) && (
          <Field label="参加者一覧" hint="先頭行の見出しを含めて貼り付けます" required>
            <textarea
              className="admin-input admin-bulk-textarea"
              value={source}
              onChange={(event) => updateSource(event.target.value)}
              placeholder={BULK_USER_HEADERS.join('\t')}
              autoComplete="off"
              spellCheck="false"
              disabled={busy}
            />
          </Field>
        )}

        {notice && <StatusNotice tone={notice.tone} title={notice.title} live>{notice.message}</StatusNotice>}

        {preview?.errors.length > 0 && (
          <ul className="admin-operation-errors" aria-label="修正が必要な箇所">
            {preview.errors.map((error, index) => <li key={`${error.line}-${index}`}>{error.message}</li>)}
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
                <h3 id="admin-bulk-preview-heading">参加者名簿</h3>
              </div>
              <strong>{preview.rows.length}人</strong>
            </div>
            <ol className="admin-bulk-preview-list">
              {preview.rows.map((row) => (
                <li key={`${row.sourceLine}-${row.name}`}>
                  <span>{row.sourceLine}行目</span>
                  <strong>{row.name}</strong>
                  <small>{row.group_id}・{roleLabel(row.role)}・{maskDiscordUserId(row.discord_user_id)}</small>
                </li>
              ))}
            </ol>
          </div>
        )}

        <div className="admin-form-actions">
          {source && (!preview || preview.errors.length > 0) && (
            <button type="button" className="admin-button admin-button-secondary" onClick={() => updateSource('')} disabled={busy}>
              入力を消す
            </button>
          )}
          {preview && preview.errors.length === 0 && preview.rows.length > 0 ? (
            <>
              <button
                type="button"
                className="admin-button admin-button-secondary"
                onClick={() => {
                  setPreview(null);
                  setNotice(null);
                  setServerErrors([]);
                }}
                disabled={busy}
              >
                入力内容を修正
              </button>
              <button type="button" className="admin-button admin-button-primary" onClick={addUsers} disabled={busy}>
                {busy ? '追加しています' : `${preview.rows.length}人をまとめて追加`}
              </button>
            </>
          ) : (
            <button type="button" className="admin-button admin-button-primary" onClick={preparePreview} disabled={busy || !source.trim()}>
              入力内容を確認
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
