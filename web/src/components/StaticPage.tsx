interface Props { kind: "privacy" | "terms" }

export default function StaticPage({ kind }: Props) {
  return (
    <main className="static">
      <p><a href="/">← Back to the library</a></p>
      {kind === "privacy" ? (
        <>
          <h1>Privacy</h1>
          <p>Lit Library is a private personal ebook library. Access is limited to authorized accounts.</p>
          <p>When you sign in with Google we receive your name and email address, which are used only to verify
            that your account is authorized and to keep a record of downloads. Nothing is passed to third parties
            and no advertising or analytics services are used.</p>
          <p>To have your account and download history removed, contact the site owner.</p>
        </>
      ) : (
        <>
          <h1>Terms</h1>
          <p>Access is restricted to authorized accounts. Content is for personal use only; do not
            redistribute it or share your sign-in.</p>
          <p>The site is run as a hobby with no uptime guarantees.</p>
        </>
      )}
    </main>
  );
}
