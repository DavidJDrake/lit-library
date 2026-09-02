interface Props { kind: "privacy" | "terms" }

export default function StaticPage({ kind }: Props) {
  return (
    <main className="static">
      <p><a href="/">← Back to the library</a></p>
      {kind === "privacy" ? (
        <>
          <h1>Privacy</h1>
          <p>Lit Library is a private, invite-only ebook collection shared among friends.</p>
          <p>When you sign in with Google we receive your name and email address, which are used only to check
            the invite list and to record which books you download. Nothing is shared with third parties and
            no advertising or analytics services are used.</p>
          <p>To have your account and download history removed, ask Jay.</p>
        </>
      ) : (
        <>
          <h1>Terms</h1>
          <p>Access is by personal invitation only. Books are provided for your own reading; please don't
            redistribute them or share your sign-in.</p>
          <p>The site is run as a hobby with no uptime guarantees.</p>
        </>
      )}
    </main>
  );
}
