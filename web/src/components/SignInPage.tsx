interface Props { onSignIn: () => void; error?: string }

export default function SignInPage({ onSignIn, error }: Props) {
  return (
    <main className="signin">
      <h1>Lit Library</h1>
      <p>A private ebook library for friends. Sign in with the Google account Jay invited.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <button className="btn" onClick={onSignIn}>Sign in with Google</button>
      <p className="count" style={{ marginTop: "1.5rem" }}>
        <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>
      </p>
    </main>
  );
}
