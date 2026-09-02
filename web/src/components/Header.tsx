interface Props { email?: string; onSignOut: () => void }

export default function Header({ email, onSignOut }: Props) {
  return (
    <header className="header">
      <h1>Lit Library</h1>
      <div>
        {email && <span className="who">{email}</span>}
        <button className="btn secondary" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}
