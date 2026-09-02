import { useEffect } from "react";

interface Props { message?: string; onDismiss: () => void }

export default function Toast({ message, onDismiss }: Props) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [message, onDismiss]);
  if (!message) return null;
  return <div className="toast" role="status" onClick={onDismiss}>{message}</div>;
}
