import type { ReactNode } from "react";
import Link from "./Link";

interface Props { email?: string; onSignOut: () => void; bell?: ReactNode }

export default function Header({ email, onSignOut, bell }: Props) {
  return (
    <header className="header">
      <h1><Link href="/">Lit Library</Link></h1>
      <div className="header-right">
        <Link href="/settings" className="settings-link" aria-label="Settings" title="Settings">⚙</Link>
        {bell}
        {email && <span className="who">{email}</span>}
        <button className="btn secondary" onClick={onSignOut}>Sign out</button>
      </div>
    </header>
  );
}
