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
  // Bumping this resets every row's draft label back to the saved value, which is
  // how a rejected rename gets reverted without discarding the input's DOM node.
  const [revision, setRevision] = useState(0);

  async function save(next: DeviceInput[], nextDefault?: string) {
    setError(undefined); setBusy(true);
    try {
      await onSave(next, nextDefault);
    } catch (e) {
      setError((e as Error).message);
      setRevision((r) => r + 1);
      throw e;
    } finally {
      setBusy(false);
    }
  }

  const keptDefault = defaultDeviceId ?? undefined;

  async function rename(id: string, label: string) {
    await save(devices.map((d) => (d.id === id ? { ...toInput(d), label } : toInput(d))), keptDefault);
  }
  async function makeDefault(id: string) {
    await save(devices.map(toInput), id);
  }
  async function remove(id: string) {
    const next = devices.filter((d) => d.id !== id);
    await save(next.map(toInput), next.some((d) => d.id === defaultDeviceId) ? keptDefault : undefined);
  }
  async function add(label: string, address: string) {
    await save([...devices.map(toInput), { label, address }], keptDefault);
  }

  return (
    <div className="device-list">
      <h4>Your devices</h4>
      {devices.length > 0 && (
        <ul>
          {devices.map((d) => (
            <DeviceRow key={d.id} device={d} isDefault={d.id === defaultDeviceId} busy={busy} resetToken={revision}
              onRename={(label) => rename(d.id, label)} onMakeDefault={() => makeDefault(d.id)} onRemove={() => remove(d.id)} />
          ))}
        </ul>
      )}
      {error && <div className="notif-error" role="alert">{error}</div>}
      {devices.length >= MAX_DEVICES
        ? <p className="meta">You can save up to {MAX_DEVICES} devices</p>
        : (
          <>
            <h4>Add a device</h4>
            <KindleDeviceForm sender={sender} submitLabel="Add device" showHelp={false} onSubmit={add} />
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
  onRename(label: string): Promise<void>;
  onMakeDefault(): Promise<void>;
  onRemove(): Promise<void>;
}

function DeviceRow({ device, isDefault, busy, resetToken, onRename, onMakeDefault, onRemove }: RowProps) {
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
    </li>
  );
}
