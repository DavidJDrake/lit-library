import { useEffect, useState } from "react";
import type { DeviceInput, KindleDevice } from "../kindle/api";
import { MAX_DEVICES } from "../kindle/limits";
import KindleDeviceForm from "./KindleDeviceForm";

interface Props {
  devices: KindleDevice[];
  defaultDeviceId: string | null;
  sender: string;
  onSave(devices: DeviceInput[], defaultDeviceId?: string): Promise<void>;
}

const toInput = (d: KindleDevice): DeviceInput => ({ id: d.id, label: d.label, address: d.address });

export default function DeviceList({ devices, defaultDeviceId, sender, onSave }: Props) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Set when an add is refused because a migrated device still has no name. The reason
  // belongs on that row, not under the name the reader just typed correctly.
  const [needsName, setNeedsName] = useState(false);
  // Bumping this resets every row's draft label back to the saved value, which is
  // how a rejected rename gets reverted without discarding the input's DOM node.
  const [revision, setRevision] = useState(0);

  // Every mutation — a rename, a default change, a remove, or an add — shares this
  // single busy flag and runs through here, so two of them can never be in flight at
  // once computing whole-list replacements from the same stale snapshot.
  async function mutate(next: DeviceInput[], nextDefault: string | undefined, opts?: { silent?: boolean }) {
    if (!opts?.silent) setError(undefined);
    setBusy(true);
    try {
      await onSave(next, nextDefault);
    } catch (e) {
      // The add form owns and displays its own rejection; only rename, make-default,
      // and remove report through this list's outer alert, so a failure is never
      // announced in two live regions at once.
      if (!opts?.silent) {
        setError((e as Error).message);
        setRevision((r) => r + 1);
      }
      throw e;
    } finally {
      setBusy(false);
    }
  }

  const keptDefault = defaultDeviceId ?? undefined;

  async function rename(id: string, label: string) {
    await mutate(devices.map((d) => (d.id === id ? { ...toInput(d), label } : toInput(d))), keptDefault);
  }
  async function makeDefault(id: string) {
    await mutate(devices.map(toInput), id);
  }
  async function remove(id: string) {
    const next = devices.filter((d) => d.id !== id);
    await mutate(next.map(toInput), next.some((d) => d.id === defaultDeviceId) ? keptDefault : undefined);
  }
  async function add(label: string, address: string) {
    // An add submits the whole list, and the server rejects any entry with an empty label,
    // so a reader whose row migrated from the old single address would otherwise be told
    // their new device's name is bad. Ask them to name the migrated one first instead.
    if (devices.some((d) => d.label.trim() === "")) {
      setNeedsName(true);
      // An empty message leaves the add form's own alert quiet: the unnamed row shows it.
      throw new Error("");
    }
    setNeedsName(false);
    await mutate([...devices.map(toInput), { label, address }], keptDefault, { silent: true });
  }

  return (
    <div className="device-list">
      <h4>Your devices</h4>
      {devices.length > 0 && (
        <ul>
          {devices.map((d) => (
            <DeviceRow key={d.id} device={d} isDefault={d.id === defaultDeviceId} busy={busy} resetToken={revision}
              needsName={needsName} onRename={(label) => rename(d.id, label)}
              onMakeDefault={() => makeDefault(d.id)} onRemove={() => remove(d.id)} />
          ))}
        </ul>
      )}
      {error && <div className="notif-error" role="alert">{error}</div>}
      {devices.length >= MAX_DEVICES
        ? <p className="meta">You can save up to {MAX_DEVICES} devices</p>
        : (
          <>
            <h4>Add a device</h4>
            <KindleDeviceForm sender={sender} submitLabel="Add device" showHelp={false} disabled={busy} onSubmit={add} />
          </>
        )}
    </div>
  );
}

interface RowProps {
  device: KindleDevice;
  isDefault: boolean;
  busy: boolean;
  resetToken: number;
  needsName: boolean;
  onRename(label: string): Promise<void>;
  onMakeDefault(): Promise<void>;
  onRemove(): Promise<void>;
}

function DeviceRow({ device, isDefault, busy, resetToken, needsName, onRename, onMakeDefault, onRemove }: RowProps) {
  const [label, setLabel] = useState(device.label);
  // A rejected rename bumps resetToken, which snaps this row's draft back to the
  // last saved label without unmounting the input (which would orphan its DOM node).
  useEffect(() => { setLabel(device.label); }, [resetToken, device.label]);
  const unnamed = device.label === "";

  function commit() {
    const next = label.trim();
    if (next === device.label) return;
    void onRename(next).catch(() => setLabel(device.label));
  }

  return (
    <li aria-label={device.label || device.address} className={unnamed ? "device unnamed" : "device"}>
      <input type="text" aria-label={`Name for ${device.address}`} value={label} disabled={busy}
        placeholder={unnamed ? "Name this device" : undefined}
        onChange={(e) => setLabel(e.target.value)} onBlur={commit} />
      <span className="meta">{device.address}</span>
      {isDefault ? <span className="chip">default</span>
        : <button type="button" className="more" disabled={busy} onClick={() => void onMakeDefault()}>Make default</button>}
      <button type="button" className="more" disabled={busy} onClick={() => void onRemove()}>Remove</button>
      {unnamed && <p className="meta">Name this device so you can tell it apart</p>}
      {unnamed && needsName && <p className="notif-error" role="alert">Name this device before adding another</p>}
    </li>
  );
}
