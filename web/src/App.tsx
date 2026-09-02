import { useAuth } from "./auth/AuthProvider";
import Header from "./components/Header";
import Library from "./components/Library";
import SignInPage from "./components/SignInPage";
import StaticPage from "./components/StaticPage";
import { CONFIG } from "./config";

export default function App() {
  const auth = useAuth();
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/privacy") return <StaticPage kind="privacy" />;
  if (path === "/terms") return <StaticPage kind="terms" />;

  if (auth.status === "loading") return <p className="empty">Signing you in…</p>;
  if (auth.status === "signedOut") return <SignInPage onSignIn={() => void auth.signIn()} error={auth.error} />;
  return (
    <>
      <Header email={auth.email} onSignOut={auth.signOut} />
      <Library apiUrl={CONFIG.apiUrl} getIdToken={auth.getIdToken} />
    </>
  );
}
