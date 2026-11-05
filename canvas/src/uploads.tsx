import { useSyncExternalStore } from "react";
import { B, UI_FONT, fieldLabel, surface } from "./bunnyTheme";
import { Action, ProgressBar, StatusChip, UPLOAD_UI_CSS, hintText, nameText } from "./uploadUi";

type Upload = { id: number; name: string; progress: number | null; error?: string; retry: () => void; cancel: () => void };
let nextId = 0;
let uploads: Upload[] = [];
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

// Keep one asset upload promise across retries. Tldraw owns the one pending asset
// and its placement; retrying must never insert a second shape.
export function uploadImage(boardId: string, file: File, signal?: AbortSignal): Promise<{ src: string; w: number; h: number }> {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return Promise.reject(new Error("Use PNG, JPEG, GIF or WebP for an image shape."));
  if (file.size > 20 * 1024 * 1024) return Promise.reject(new Error("Image exceeds the 20 MB limit."));
  if (signal?.aborted) return Promise.reject(new Error("Upload canceled."));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    let xhr: XMLHttpRequest | undefined;
    let finished = false;
    const update = (patch: Partial<Upload>) => { uploads = uploads.map(u => u.id === id ? { ...u, ...patch } : u); notify(); };
    const finish = () => { finished = true; signal?.removeEventListener("abort", cancel); uploads = uploads.filter(u => u.id !== id); notify(); };
    const cancel = () => { if (finished) return; finish(); xhr?.abort(); reject(new Error("Upload canceled.")); };
    const attempt = () => {
      if (finished || (xhr && xhr.readyState !== XMLHttpRequest.DONE)) return;
      update({ progress: null, error: undefined });
      const request = new XMLHttpRequest(); xhr = request;
      request.open("POST", `/api/ui/boards/${encodeURIComponent(boardId)}/assets`);
      request.timeout = 120000;
      request.setRequestHeader("content-type", file.type);
      request.upload.onprogress = e => { if (!finished) update({ progress: e.lengthComputable ? Math.round(100 * e.loaded / e.total) : null }); };
      const failed = (message: string) => { if (!finished) update({ error: message, progress: null }); };
      request.onerror = () => failed("Connection failed. No image placement confirmed.");
      request.ontimeout = () => failed("Upload timed out. Retry uses the same image bytes.");
      request.onload = () => {
        if (finished) return;
        let data: { src?: string; w?: number; h?: number; error?: string };
        try { data = JSON.parse(request.responseText); } catch { failed(`Upload returned HTTP ${request.status} with an invalid response.`); return; }
        if (request.status < 200 || request.status >= 300 || !data.src || !data.w || !data.h) { failed(data.error ?? `Upload failed: HTTP ${request.status}`); return; }
        finish(); resolve({ src: data.src, w: data.w, h: data.h });
      };
      request.send(file);
    };
    uploads = [...uploads, { id, name: file.name, progress: null, retry: attempt, cancel }]; notify();
    signal?.addEventListener("abort", cancel, { once: true });
    attempt();
  });
}

// Plain-language status for one image upload. At 100% the bytes are sent but the board
// has not yet confirmed it stored them.
function uploadStatus(u: Upload): string {
  if (u.progress === null) return "Starting upload…";
  if (u.progress >= 100) return "Sent. Waiting for the board to save it…";
  return "Sending to the board…";
}

export function UploadProgress() {
  const current = useSyncExternalStore(subscribe, () => uploads);
  if (!current.length) return null;
  const failed = current.filter(u => u.error).length;
  const title = failed ? (failed === 1 ? "Image upload failed" : `${failed} image uploads failed`) : current.length === 1 ? "Uploading image" : `Uploading ${current.length} images`;
  return <div data-testid="upload-progress" role="status" aria-label={title} className="bunny-fp bfp-pop" style={{ ...surface, position: "fixed", left: 12, bottom: 110, zIndex: 1200, width: "min(340px, calc(100vw - 24px))", boxSizing: "border-box", padding: 14, maxHeight: "40vh", overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
    <style>{UPLOAD_UI_CSS}</style>
    <span style={fieldLabel}>{title}</span>
    {current.map(u => <div key={u.id} data-upload-state={u.error ? "error" : "uploading"} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between" }}>
        <div style={nameText} title={u.name}>{u.name}</div>
        {u.error ? <StatusChip tone="danger">Failed</StatusChip> : u.progress !== null ? <span style={{ font: `600 12px ${UI_FONT}`, color: B.violetDeep, flex: "none" }}>{Math.min(100, u.progress)}%</span> : null}
      </div>
      <ProgressBar label={`Upload progress for ${u.name}`} value={u.error ? 100 : u.progress !== null && u.progress >= 100 ? null : u.progress} tone={u.error ? "danger" : "violet"} />
      {u.error ? <p role="alert" style={{ ...hintText, color: B.danger }}>{u.error}</p> : <p style={hintText}>{uploadStatus(u)}</p>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {u.error ? <Action id={`upload-${u.id}-retry`} testId="upload-retry" primary label="Try again" hint="Sends the same image again." onClick={u.retry} /> : null}
        <Action id={`upload-${u.id}-cancel`} label="Cancel upload" hint="Stops it. Nothing is added to the board." onClick={u.cancel} />
      </div>
    </div>)}
    <p style={{ ...hintText, paddingTop: 10, borderTop: `1px solid ${B.line}` }}>The image appears on the board once it is saved. In a frame with an agent, the frame’s chat then shows whether the agent got it.</p>
  </div>;
}
