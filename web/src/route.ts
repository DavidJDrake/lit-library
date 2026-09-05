import { useCallback, useEffect, useState } from "react";

// A deliberately tiny router: the app has three pages. Everything reads the
// URL through here so in-app navigation never reloads (and never re-runs sign-in).
export function currentPath(): string {
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): { path: string; search: string; navigate: (path: string) => void } {
  const [state, setState] = useState(() => ({ path: currentPath(), search: window.location.search }));
  useEffect(() => {
    const onChange = () => setState({ path: currentPath(), search: window.location.search });
    window.addEventListener("popstate", onChange);
    return () => window.removeEventListener("popstate", onChange);
  }, []);
  const go = useCallback((path: string) => navigate(path), []);
  return { path: state.path, search: state.search, navigate: go };
}
