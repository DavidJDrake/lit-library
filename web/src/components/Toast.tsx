import { useEffect } from "react";

interface Props { message?: string; variant?: "error" | "ok"; onDismiss: () => void }

export default function Toast({ message, variant = "error", onDismiss }: Props) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);
  if (!message) return null;
  return (
    <div className={variant === "ok" ? "toast ok" : "toast"} role="status" onClick={onDismiss}>
      {message}
    </div>
  );
}
