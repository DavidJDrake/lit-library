import { useCallback } from "react";
import { useAuth } from "./auth/AuthProvider";
import { endSession } from "./catalog/session";
import Header from "./components/Header";
import Library from "./components/Library";
import SignInPage from "./components/SignInPage";
import StaticPage from "./components/StaticPage";

interface Props { fetchFn?: typeof fetch }

export default function App({ fetchFn = fetch }: Props) {
  const auth = useAuth();
  const signOut = useCallback(async () => {
    await endSession(auth.apiUrl, fetchFn);
    auth.signOut();
  }, [auth, fetchFn]);

  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/privacy") return <StaticPage kind="privacy" />;
  if (path === "/terms") return <StaticPage kind="terms" />;

  if (auth.status === "loading") return <p className="empty">Signing you in…</p>;
  if (auth.status === "signedOut") return <SignInPage onSignIn={() => void auth.signIn()} error={auth.error} />;
  return (
    <>
      <Header email={auth.email} onSignOut={() => void signOut()} />
      <Library apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn} isAdmin={auth.isAdmin} />
    </>
  );
}
