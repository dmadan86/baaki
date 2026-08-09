import { feedback } from '@/lib/data';

export const dynamic = 'force-dynamic';

const KIND_LABEL: Record<string, string> = {
  general: 'General',
  bug: 'Broken',
  idea: 'Idea',
  deletion: 'Left',
};

export default async function FeedbackPage() {
  const rows = await feedback(200);
  const counts = rows.reduce<Record<string, number>>((tally, row) => {
    tally[row.kind] = (tally[row.kind] ?? 0) + 1;
    return tally;
  }, {});

  return (
    <main>
      <header className="top">
        <h1>Feedback</h1>{' '}
      </header>

      <div className="tiles">
        {(['general', 'bug', 'idea', 'deletion'] as const).map((kind) => (
          <div className="tile" key={kind}>
            <span className="label">{KIND_LABEL[kind]}</span>
            <div className="value">{counts[kind] ?? 0}</div>
          </div>
        ))}
      </div>

      <h2>Newest first</h2>
      <section>
        {rows.length === 0 ? (
          <p className="note">
            Nothing yet. If you expected some, the <code>20260808230000_feedback_and_erasure</code>{' '}
            migration may not be deployed to this project.
          </p>
        ) : (
          <ul className="feedback">
            {rows.map((row) => (
              <li key={row.id}>
                <div className="meta">
                  <span className={`tag tag-${row.kind}`}>{KIND_LABEL[row.kind] ?? row.kind}</span>
                  {row.rating ? <span>{'★'.repeat(row.rating)}</span> : null}
                  <span>{new Date(row.created_at).toLocaleString('en-IN')}</span>
                  {row.platform ? <span>{row.platform}</span> : null}
                  {row.app_version ? <span>v{row.app_version}</span> : null}
                  {row.country_code ? <span>{row.country_code}</span> : null}
                  {row.locale ? <span>{row.locale}</span> : null}
                  {row.from_deleted_account ? <span className="gone">account deleted</span> : null}
                </div>
                <p>{row.message}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="note" style={{ padding: '14px 0 0' }}>
        There is no author column here and no way to ask for one. Knowing who complained is not
        needed in order to act on a complaint. Where it says <em>account deleted</em>, the person
        has since erased themselves — their words are kept on purpose, because why somebody leaves
        is the most useful thing they ever write and cascading it away at that moment would destroy
        exactly that.
      </p>
    </main>
  );
}
