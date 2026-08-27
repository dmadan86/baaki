import { voiceAttempts } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * What the mic heard and the parser could not turn into an expense.
 *
 * The device reports only misses (item_count 0), silently and with the person's
 * analytics consent, so this is the raw material for improving voice quick-add:
 * the actual sentences that failed, newest first. Mirrors the feedback page —
 * same data layer, same console-only read.
 */
export default async function VoiceAttemptsPage() {
  const rows = await voiceAttempts(200);
  const withModel = rows.filter((row) => row.used_model).length;

  return (
    <main>
      <header className="top">
        <h1>Voice attempts</h1>{' '}
      </header>

      <div className="tiles">
        <div className="tile">
          <span className="label">Unparsed</span>
          <div className="value">{rows.length}</div>
        </div>
        <div className="tile">
          <span className="label">Model tier</span>
          <div className="value">{withModel}</div>
        </div>
        <div className="tile">
          <span className="label">On-device</span>
          <div className="value">{rows.length - withModel}</div>
        </div>
      </div>

      <h2>Newest first</h2>
      <section>
        {rows.length === 0 ? (
          <p className="note">
            Nothing yet. Attempts arrive only when a dictation fails to parse and the person has
            turned analytics on; if you expected some, the{' '}
            <code>20260828000000_voice_attempts</code> migration may not be deployed to this
            project.
          </p>
        ) : (
          <ul className="feedback">
            {rows.map((row) => (
              <li key={row.id}>
                <div className="meta">
                  <span className={`tag tag-${row.used_model ? 'idea' : 'general'}`}>
                    {row.used_model ? 'model' : 'on-device'}
                  </span>
                  <span>{new Date(row.created_at).toLocaleString('en-IN')}</span>
                  {row.locale ? <span>{row.locale}</span> : null}
                  {row.platform ? <span>{row.platform}</span> : null}
                  {row.app_version ? <span>v{row.app_version}</span> : null}
                  {row.profile_id ? <span>{row.profile_id}</span> : null}
                </div>
                <p>{row.transcript}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="note" style={{ padding: '14px 0 0' }}>
        These are raw speech transcripts, so they can name people, amounts and places. They are read
        here and nowhere else — no client can select them. The profile id is kept, unlike feedback,
        so a confusing miss can be traced to the person who spoke it and the parser tuned against
        real usage.
      </p>
    </main>
  );
}
