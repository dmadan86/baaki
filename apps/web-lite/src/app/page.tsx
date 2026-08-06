/**
 * There is no web app. This page exists because somebody will type the domain
 * in, and a blank 404 tells them nothing about what they were sent.
 */
export default function Home() {
  return (
    <main>
      <div className="card">
        <h1>Baaki</h1>
        <p>
          Split expenses without the argument at the end. This page is only for opening an invite
          link — if somebody shared a group with you, open their link rather than this address.
        </p>
        <p className="faint">Everything else lives in the app.</p>
      </div>
    </main>
  );
}
