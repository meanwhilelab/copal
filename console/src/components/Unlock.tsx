import { useState } from "react";
import { setToken } from "../api/client.js";

export function Unlock({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return; // guard double-submit (Enter while checking)
    const token = value.trim();
    if (!token) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/ping", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) {
      setToken(token);
      onUnlock();
    } else if (res && res.status !== 401) {
      // Distinguish server trouble (429/5xx/offline) from a genuinely bad token.
      setError("The server didn't answer cleanly — check it's up, then try again.");
    } else if (!res) {
      setError("Couldn't reach the server.");
    } else {
      setError("That token doesn't open the material.");
    }
  };

  return (
    <div className="h-screen grid place-items-center" style={{ background: "var(--ground)" }}>
      <div className="w-[380px] max-w-[90vw] text-center risein">
        <div className="display text-[2.625rem] font-semibold mb-1" style={{ color: "var(--amber-hi)" }}>
          Copal
        </div>
        <div className="kicker mb-8">control surface · private</div>
        <input
          type="password"
          value={value}
          autoFocus
          placeholder="Paste your console token"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
          className="w-full h-11 px-4 rounded-[10px] border text-center mono text-[0.75rem] outline-none"
          style={{ background: "var(--surface)", borderColor: error ? "var(--pri-alta)" : "var(--line-2)", color: "var(--text)" }}
        />
        {error && (
          <div className="mt-3 text-xs" style={{ color: "var(--pri-alta)" }}>
            {error}
          </div>
        )}
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="mt-5 px-6 py-2.5 rounded-[9px] border-0 font-bold text-[0.8125rem] cursor-pointer disabled:opacity-50"
          style={{ background: "var(--amber)", color: "#1a1206" }}
        >
          {busy ? "checking…" : "Unlock"}
        </button>
        <p className="mt-8 text-[0.6875rem] leading-relaxed" style={{ color: "var(--text-3)" }}>
          The token stays in this browser only. Mint or revoke tokens on the server:
          <br />
          <span className="mono">npm run mint-token -- console</span>
        </p>
      </div>
    </div>
  );
}
