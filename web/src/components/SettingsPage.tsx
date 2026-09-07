import { useKindle } from "../kindle/KindleProvider";
import { KINDLE_HELP_URL } from "../kindle/limits";
import DeviceList from "./DeviceList";
import OpdsSection from "./OpdsSection";

interface Props {
  apiUrl: string;
  getIdToken(): Promise<string>;
  fetchFn?: typeof fetch;
}

export default function SettingsPage({ apiUrl, getIdToken, fetchFn = fetch }: Props) {
  const kindle = useKindle();

  return (
    <main className="page settings-page">
      <div className="page-head"><h2>Settings</h2></div>
      <section className="panel settings-section">
        <h3>Send to Kindle</h3>
        <p className="meta">Books you send arrive in your Kindle library as personal documents. One-time setup:</p>
        <ol className="meta">
          <li>Find your Kindle email under Amazon → Content &amp; Devices → Preferences → <a href={KINDLE_HELP_URL} target="_blank" rel="noreferrer">Personal Document Settings</a>.</li>
          <li>On the same page, add <code>{kindle.sender}</code> to your approved personal-document senders.</li>
        </ol>
        {kindle.loadFailed ? (
          // Never render the device list from a load that failed: it would look like a
          // first-time setup, and the add form's whole-list PUT would wipe the stored devices.
          <div className="notif-error" role="alert">
            <p>Couldn't load your devices. Nothing has been changed.</p>
            <button type="button" className="btn secondary" onClick={() => void kindle.reload().catch(() => {})}>Try again</button>
          </div>
        ) : kindle.devices === undefined
          ? <p className="empty">Loading…</p>
          : <DeviceList devices={kindle.devices} defaultDeviceId={kindle.defaultDeviceId} sender={kindle.sender} onSave={kindle.save} />}
      </section>
      <OpdsSection apiUrl={apiUrl} getIdToken={getIdToken} fetchFn={fetchFn} />
    </main>
  );
}
