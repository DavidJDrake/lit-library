import { useCallback } from "react";
import { useAuth } from "./auth/AuthProvider";
import { resolveSuggestion } from "./catalog/library";
import { LibraryDataProvider, useLibraryData } from "./catalog/LibraryDataProvider";
import { endSession } from "./catalog/session";
import Header from "./components/Header";
import Library from "./components/Library";
import NotificationBell from "./components/NotificationBell";
import NotificationsPage from "./components/NotificationsPage";
import SignInPage from "./components/SignInPage";
import StaticPage from "./components/StaticPage";
import { NotificationsProvider, useNotifications } from "./notifications/NotificationsProvider";
import { useRoute } from "./route";

interface Props { fetchFn?: typeof fetch }

function Shell({ fetchFn }: { fetchFn: typeof fetch }) {
  const auth = useAuth();
  const { path, search } = useRoute();
  const { titleOf, refreshOverlay } = useLibraryData();
  const notifications = useNotifications();

  const signOut = useCallback(async () => {
    await endSession(auth.apiUrl, fetchFn);
    auth.signOut();
  }, [auth, fetchFn]);

  // Accept/reject from the bell: same API as the sidebar chips, then refresh both views.
  const resolveFromBell = useCallback(async (suggestionId: string, action: "accept" | "reject") => {
    await resolveSuggestion(auth.apiUrl, await auth.getIdToken(), suggestionId, action, fetchFn);
    await Promise.all([refreshOverlay().catch(() => undefined), notifications.refresh()]);
  }, [auth, fetchFn, refreshOverlay, notifications]);

  const bell = <NotificationBell isAdmin={auth.isAdmin} titleOf={titleOf} onResolve={resolveFromBell} />;
  return (
    <>
      <Header email={auth.email} onSignOut={() => void signOut()} bell={bell} />
      {path === "/notifications"
        ? <NotificationsPage isAdmin={auth.isAdmin} titleOf={titleOf} onResolve={resolveFromBell} />
        : <Library key={search} apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn} isAdmin={auth.isAdmin} onChanged={() => void notifications.refresh()} />}
    </>
  );
}

export default function App({ fetchFn = fetch }: Props) {
  const auth = useAuth();
  const { path } = useRoute();
  if (path === "/privacy") return <StaticPage kind="privacy" />;
  if (path === "/terms") return <StaticPage kind="terms" />;
  if (auth.status === "loading") return <p className="empty">Signing you in…</p>;
  if (auth.status === "signedOut") return <SignInPage onSignIn={() => void auth.signIn()} error={auth.error} />;
  return (
    <LibraryDataProvider apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn}>
      <NotificationsProvider apiUrl={auth.apiUrl} getIdToken={auth.getIdToken} fetchFn={fetchFn}>
        <Shell fetchFn={fetchFn} />
      </NotificationsProvider>
    </LibraryDataProvider>
  );
}
