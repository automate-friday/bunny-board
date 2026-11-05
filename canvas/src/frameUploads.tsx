import { readAgentCapabilities } from "./agentCapabilities";
import { useSyncExternalStore, type CSSProperties } from "react";
import { B, UI_FONT, fieldLabel } from "./bunnyTheme";
import { Action, ProgressBar, StatusChip, hintText, nameText, UPLOAD_UI_CSS, type Tone } from "./uploadUi";
import type { BoardInfo } from "./info";

export type FileReceipt = { id: string; boardId: string; frameId: string; agentId: string; name: string; path: string; bytes: number; status: "queued" | "sending" | "accepted" | "unknown" | "failed"; preview: string; previewStatus: string; error?: string };
type Upload = { id: string; boardId: string; frameId: string; agentId: string; name: string; progress: number | null; busy: boolean; recovering?: boolean; receipt?: FileReceipt; error?: string; retry: () => void; check: () => void };
let uploads: Upload[] = [];
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => uploads;
const notify = () => listeners.forEach(listener => listener());

// The File and destination stay captured by this operation, never by current selection.
// Retry first recovers a stored receipt, even if its frame was deleted/rebound.
// Only a confirmed missing receipt permits another POST with the original key.
export function uploadFrameFile(boardId: string, frameId: string, agentId: string, file: File, destinationValid: () => boolean): void {
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error("Files must be between 1 byte and 20 MB.");
  if (!file.name || file.name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(file.name) || file.name === "." || file.name === "..") throw new Error("Use a plain filename up to 200 characters.");
  if (uploads.length >= 100) throw new Error("This tab has 100 file receipts. Keep them for review, then open a fresh tab for more uploads.");
  const id = `drop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  const name = file.name;
  const base = `/api/ui/boards/${encodeURIComponent(boardId)}/frames/${encodeURIComponent(frameId)}/uploads`;
  let busy = false;
  let attempted = false;
  let receipt: FileReceipt | undefined;
  let bytes: File | null = file;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (patch: Partial<Upload>) => { uploads = uploads.map(u => u.id === id ? { ...u, ...patch } : u); notify(); };
  const accept = (value: FileReceipt) => {
    if (!value || typeof value.id !== "string" || value.boardId !== boardId || value.frameId !== frameId || !["queued", "sending", "accepted", "unknown", "failed"].includes(value.status)) throw new Error("Server returned an invalid file receipt. Storage outcome unconfirmed.");
    receipt = value; bytes = null;
    update({ receipt, progress: null, error: value.agentId !== agentId ? "Frame binding changed during upload. Receipt belongs to the agent shown below; inspect that conversation." : undefined });
    if (value.status === "queued" || value.status === "sending") timer = setTimeout(() => void check(), 2000);
  };
  const check = async () => {
    if (busy || !receipt) return;
    clearTimeout(timer); busy = true; update({ busy: true });
    try {
      const response = await fetch(`${base}?id=${encodeURIComponent(receipt.id)}`, { signal: AbortSignal.timeout(12000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `Receipt check failed: HTTP ${response.status}`);
      accept(result.receipt);
    } catch (e) { update({ error: `Receipt check failed: ${(e as Error).message}. Last known status is shown.` }); }
    finally { busy = false; update({ busy: false, recovering: false }); }
  };
  const retry = async () => {
    if (busy || receipt || !bytes) return;
    busy = true; update({ busy: true, error: undefined, progress: null });
    try {
      const capabilityResponse = await fetch("/api/ui/info", { signal: AbortSignal.timeout(12000) });
      if (!capabilityResponse.ok) throw new Error(`Capability check failed: HTTP ${capabilityResponse.status}`);
      const info = await capabilityResponse.json() as BoardInfo;
      if (!info.capabilities?.frameUploads) throw new Error("File delivery is not enabled on this server yet. Keep this tab open and retry after the server release.");
      // Fail closed on older servers without original-binding enforcement.
      if (!info.capabilities?.frameUploadBindingGuard) throw new Error("File delivery is waiting for a server update that protects the original agent binding.");
      if (attempted) {
        if (!info.capabilities?.frameUploadRecoveryByUploadId) throw new Error("Receipt recovery is unavailable on this server. Upload was not repeated.");
        update({ recovering: true });
        const response = await fetch(`${base}?uploadId=${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(12000) });
        if (response.ok) {
          const result = await response.json();
          accept(result.receipt);
          return;
        }
        if (response.status !== 404) throw new Error(`Receipt recovery failed: HTTP ${response.status}. Upload was not repeated.`);
        update({ recovering: false });
      }
      const agentControls = await readAgentCapabilities(agentId);
      if (agentControls.fileContext !== true || agentControls.localArtifactPath !== true) throw new Error(`File delivery is unavailable here${agentControls.remoteHost ? `; use the owning host ${agentControls.remoteHost}` : ""}. No file bytes were sent.`);
      if (!destinationValid()) throw new Error("Original frame binding changed, was locked or removed. Upload stopped; nothing redirected to the current selection.");
      await new Promise<void>((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", `${base}?name=${encodeURIComponent(name)}`);
        request.timeout = 120000;
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.setRequestHeader("X-Upload-Id", id);
        request.setRequestHeader("X-Expected-Agent-Id", agentId);
        request.upload.onprogress = event => update({ progress: event.lengthComputable ? Math.round(event.loaded / event.total * 100) : null });
        request.onerror = () => reject(new Error("Connection failed. Storage outcome unconfirmed; retry reuses this upload ID."));
        request.ontimeout = () => reject(new Error("Upload timed out. Storage outcome unconfirmed; retry reuses this upload ID."));
        request.onload = () => {
          try {
            const result = JSON.parse(request.responseText);
            if (request.status < 200 || request.status >= 300) throw new Error(result.error ?? `Upload failed: HTTP ${request.status}`);
            accept(result.receipt); resolve();
          } catch (e) { reject(e); }
        };
        attempted = true;
        request.send(bytes);
      });
    } catch (e) { update({ error: (e as Error).message }); }
    finally { busy = false; update({ busy: false, recovering: false }); }
  };
  uploads = [...uploads, { id, boardId, frameId, agentId, name, progress: null, busy: false, retry, check }]; notify();
  void retry();
}

// Plain-language receipt states. Wording keeps the guarantees: stored is not delivered,
// accepted is not read, and nothing is redirected to a replacement agent.
const statusInfo: Record<FileReceipt["status"], { chip: string; tone: Tone; text: string }> = {
  queued: { chip: "Waiting", tone: "golden", text: "Saved. The agent gets it when it is running again; paused or offline agents wait." },
  sending: { chip: "Sending", tone: "violet", text: "Saved. Handing it to the agent now…" },
  accepted: { chip: "Delivered", tone: "green", text: "The agent has it. That does not mean it has read it or acted on it yet." },
  unknown: { chip: "Unconfirmed", tone: "golden", text: "Saved, but delivery was not confirmed. Check the conversation before sending it again; it will not resend on its own." },
  failed: { chip: "Not delivered", tone: "danger", text: "Saved, but it could not be delivered. It stays saved and was not sent to any other agent." },
};
const formatBytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const meta: CSSProperties = { ...hintText, fontSize: 11 };

export function FrameUploadReceipts({ boardId, frameId, compact = false }: { boardId: string; frameId: string; compact?: boolean }) {
  const current = useSyncExternalStore(subscribe, snapshot).filter(u => u.boardId === boardId && u.frameId === frameId);
  if (!current.length) return null;
  // Phone: one line per file (name and where its delivery is); the full receipt behind a tap.
  if (compact) return <section data-testid="frame-upload-receipts" aria-label="Files supplied to this frame" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: B.muted }}>
    {current.map(u => <details key={u.id} data-upload-id={u.id} data-upload-status={u.receipt?.status ?? (u.error ? "error" : "uploading")} style={{ overflowWrap: "anywhere" }}>
      <summary style={{ cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>📎 {u.name} · {u.receipt ? statusInfo[u.receipt.status].chip : u.error ? "Not sent" : u.busy ? "Uploading…" : "Waiting"}</summary>
      <div>{u.receipt ? statusInfo[u.receipt.status].text : u.error ?? ""}</div>
      {u.receipt ? <div>Receipt {u.receipt.id} · {formatBytes(u.receipt.bytes)}</div> : null}
      {!u.receipt && !u.busy ? <button type="button" data-testid="file-upload-retry" onClick={u.retry}>Try again</button> : null}
    </details>)}
  </section>;
  return <section data-testid="frame-upload-receipts" aria-label="Files supplied to this frame" className="bunny-fp" style={{ flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, padding: 12, maxHeight: 360, overflowY: "auto", background: B.cream, color: B.espresso, border: `1px solid ${B.line}`, borderRadius: 14, font: `13px/1.35 ${UI_FONT}`, overflowWrap: "anywhere" }}>
    <style>{UPLOAD_UI_CSS}</style>
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={fieldLabel}>Files sent to this agent</span>
      <p style={hintText}>Private context for the agent, not shared on the board. Keep this tab open until each file's status is final.</p>
    </div>
    {current.map(u => {
      const info = u.receipt ? statusInfo[u.receipt.status] : null;
      const uploading = !u.receipt && u.busy;
      return <div key={u.id} data-upload-id={u.id} data-upload-status={u.receipt?.status ?? (u.error ? "error" : "uploading")} style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 10px 6px", background: "#fff", border: `1px solid ${B.line}`, borderRadius: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
          <div style={nameText} title={u.name}>{u.name}</div>
          {info ? <StatusChip tone={info.tone}>{info.chip}</StatusChip> : uploading ? <StatusChip tone="violet">{u.recovering ? "Checking" : "Uploading"}</StatusChip> : u.error ? <StatusChip tone="danger">Not sent</StatusChip> : null}
        </div>
        {uploading ? <>
          <ProgressBar label={`Upload progress for ${u.name}`} value={u.recovering || u.progress === null || u.progress >= 100 ? null : u.progress} />
          <p role="status" style={hintText}>{u.recovering ? "Checking whether the file already arrived. Nothing is re-sent." : u.progress === null ? "Starting upload…" : u.progress >= 100 ? "Sent. Waiting for the server to confirm it saved the file…" : `Uploading… ${u.progress}%`}</p>
        </> : null}
        {info ? <p role="status" style={hintText}>{info.text}</p> : null}
        {u.receipt?.error ? <p role="alert" style={{ ...hintText, color: B.danger }}>{u.receipt.error}</p> : null}
        {u.error ? <p role="alert" style={{ ...hintText, color: B.danger }}>{u.error}</p> : null}
        {u.receipt && u.receipt.agentId !== u.agentId ? <div style={meta}>Receipt agent: {u.receipt.agentId}</div> : null}
        {!u.receipt && !u.busy ? <Action id={`${u.id}-retry`} testId="file-upload-retry" primary label="Try again" hint="First checks whether the file already arrived; sends it only if it did not." onClick={u.retry} /> : null}
        {u.receipt ? <Action id={`${u.id}-check`} label="Refresh status" hint="Re-checks delivery with the server." disabled={u.busy} onClick={u.check} /> : null}
        <details style={{ margin: "0 -10px -6px" }}>
          <summary style={{ fontSize: 12, padding: "4px 10px", color: B.muted }}>Details</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <div data-testid="file-upload-reference" style={meta}>Upload recovery ID: {u.id}</div>
            <div style={meta}>Sent to agent: {u.agentId}</div>
            {u.receipt ? <div style={meta}>Size: {formatBytes(u.receipt.bytes)}</div> : null}
            {u.receipt ? <>
              <div style={meta}>Receipt: {u.receipt.id}</div>
              <div style={meta}>Saved at: {u.receipt.path}</div>
              <div style={meta}>Preview: {u.receipt.previewStatus}</div>
              <pre style={{ ...meta, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "auto", background: B.hover, borderRadius: 8, padding: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>{u.receipt.preview || "No text preview available."}</pre>
            </> : null}
          </div>
        </details>
      </div>;
    })}
  </section>;
}
