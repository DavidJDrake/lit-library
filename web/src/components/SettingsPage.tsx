import { useState } from "react";
import { useKindle } from "../kindle/KindleProvider";
import { KINDLE_HELP_URL } from "../kindle/limits";
import KindleAddressForm from "./KindleAddressForm";

export default function SettingsPage() {
  const kindle = useKindle();
  const [saved, setSaved] = useState(false);

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
        {kindle.address === undefined ? <p className="empty">Loading…</p> : (
          <KindleAddressForm key={kindle.address ?? ""} sender={kindle.sender} initial={kindle.address ?? ""} submitLabel="Save"
            onSubmit={async (a) => { await kindle.save(a); setSaved(true); }} />
        )}
        {saved && <p className="meta" role="status">Saved</p>}
      </section>
    </main>
  );
}
