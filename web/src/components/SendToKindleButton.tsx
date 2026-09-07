import { useEffect, useRef, useState } from "react";
import type { KindleDevice } from "../kindle/api";

interface Props {
  devices: KindleDevice[];
  defaultDeviceId: string | null;
  pdf?: boolean;
  disabled: boolean;
  title?: string;
  sending: boolean;
  onSend(deviceId?: string): void;
}

// One device (or none) renders a plain button; two or more render a split button whose
// caret opens the device menu. A pick applies to that click only — no sticky selection.
export default function SendToKindleButton({ devices, defaultDeviceId, pdf = false, disabled, title, sending, onSend }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onClick); };
  }, [open]);

  const target = devices.find((d) => d.id === defaultDeviceId) ?? devices[0];
  const verb = pdf ? "Send PDF to" : "Send to";
  const mainLabel = sending ? "Sending…" : `${verb} ${target?.label || "Kindle"}`;

  return (
    <div className="kindle-send" ref={wrap}>
      <button className={pdf ? "more" : "btn secondary"} disabled={disabled || sending} title={title}
        onClick={() => onSend(target?.id)}>
        {mainLabel}
      </button>
      {devices.length > 1 && !sending && (
        <>
          <button type="button" className="caret" aria-label="Choose a device" aria-haspopup="menu" aria-expanded={open}
            disabled={disabled} onClick={() => setOpen((v) => !v)}>▾</button>
          {open && (
            <div className="kindle-menu" role="menu">
              {devices.map((d) => (
                <button key={d.id} type="button" role="menuitem" aria-checked={d.id === (target?.id ?? null)}
                  onClick={() => { setOpen(false); onSend(d.id); }}>
                  {d.label || d.address}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
