import { EVENT, VENUE, VENUE_MAP_URL } from '../lib/venue';

export default function VenueGuide({ compact = false }) {
  return (
    <details className={`venue-guide${compact ? ' venue-guide-compact' : ''}`}>
      <summary>
        <span className="venue-summary-copy">
          <span className="venue-label"><time dateTime={EVENT.date}>{EVENT.dateLabel}</time> 開催</span>
          {!compact && <strong>{VENUE.name}</strong>}
        </span>
        <span className="venue-toggle">会場・アクセス</span>
      </summary>
      <div className="venue-content">
        {compact && <strong>{VENUE.name}</strong>}
        <address>
          <span>{VENUE.address}</span>
          <strong>{VENUE.building}</strong>
        </address>
        <p>{VENUE.access}</p>
        <div className="venue-links">
          <a href={VENUE_MAP_URL} target="_blank" rel="noopener noreferrer">地図を開く<span className="sr-only">（新しいタブ）</span> ↗</a>
          <a href={VENUE.officialUrl} target="_blank" rel="noopener noreferrer">店舗の公式案内<span className="sr-only">（新しいタブ）</span> ↗</a>
        </div>
        <p className="venue-event-note"><strong>{EVENT.orderStyle}</strong><br />開始時刻・集合時刻・集合場所は未定です。決まり次第、主催者からご案内します。</p>
        <p className="venue-order-note">このアプリの注文はグループ担当者に届きます。担当者がまとめて店員へ伝えます。</p>
      </div>
    </details>
  );
}
