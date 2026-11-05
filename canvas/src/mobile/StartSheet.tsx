import {startHostsMemo,watchStartHosts} from "../startHosts";
// Phone shell: the New agent start form as a bottom sheet above everything else (scrim,
// spotlight, frame panel), sized to the visual viewport so the keyboard never hides Cancel
// or Start. Same request as the desktop frame panel's start form (FramePanel.tsx): the
// conversation's model, an opening message and where it runs (the board's runtime, a fleet
// host, or an ephemeral worker with its cloud builder). The runtime choice names the machine
// the agent will really run on (/api/ui/info agentMachine), never "this Mac".
// Start is one request per tap (disabled while it is written); a frame the shell drew for
// this sheet goes away again if the sheet is dismissed without Start.

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Editor, TLFrameShape, TLShapeId } from "tldraw";
import { useValue } from "tldraw";
import { api } from "../api";
import { boardInfo, infoNow } from "../info";
import { ModelSheet } from "./ModelSheet";
import { placePhotos } from "./placePhotos";
import { useModalHold } from "./modalHold";
import { cleanName, nameFromRequest } from "../../../shared/frame-names";
import { B, BUNNY_CONTROLS_CSS, fieldLabel } from "../bunnyTheme";
import { FALLBACK_PROVIDERS, fallbackCatalogue, findChoice, initialChoice, type StartCatalogue } from "../../../shared/start-catalogue";
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABEL, type CloudProvider } from "../../../shared/cloud-provider";
import { fleetHostsForRuntime, initialRunsOn, runsOnRequest } from "../../../shared/conversation-links";
import "./startSheet.css";

// "Open the start sheet for this frame", from anywhere on the phone (the frame panel's
// Start conversation on an empty frame); the shell shows it.
let asked: string | null = null;
const listeners = new Set<() => void>();
export function askStartSheet(frameId: string | null) {
  asked = frameId;
  for (const l of listeners) l();
}
export function useAskedStartSheet(): string | null {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => asked);
}

// What the sheet starts with when a thread asks for "an agent like this one, next to it"
// (+ Agent here, Start agent about this): the model, where it runs, the opening message.
// `name` and `files` (screenshots placed in the frame before the agent starts) come from Tell Bunny.
export type StartPrefill = { provider?: string | null; host?: string; worker?: boolean; cloudProvider?: string | null; prompt?: string; name?: string; files?: File[] };
// "Start an agent next to this frame": from the thread sheet (Sidebar); the shell draws the
// frame beside `source` and opens the sheet on it with `prefill`.
export type BesideAsk = { source: string; prefill: StartPrefill; at: number };
let beside: BesideAsk | null = null;
const besideListeners = new Set<() => void>();
export function askStartBeside(source: string | null, prefill: StartPrefill = {}) {
  beside = source ? { source, prefill, at: Date.now() } : null;
  for (const l of besideListeners) l();
}
export function useAskedStartBeside(): BesideAsk | null {
  return useSyncExternalStore((l) => (besideListeners.add(l), () => besideListeners.delete(l)), () => beside);
}

// The visible part of the layout viewport (the keyboard takes the rest on iOS).
export function useVisibleViewport(): { top: number; height: number } {
  const read = () => {
    const v = window.visualViewport;
    return v ? { top: v.offsetTop, height: v.height } : { top: 0, height: window.innerHeight };
  };
  const [vp, setVp] = useState(read);
  useEffect(() => {
    const v = window.visualViewport;
    const update = () => setVp(read());
    v?.addEventListener("resize", update);
    v?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      v?.removeEventListener("resize", update);
      v?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return vp;
}

// The machine local agents run on: the board's Paseo daemon's host, or null when unknown.
function useAgentMachine(): string | null {
  const now = () => (infoNow() as { agentMachine?: string | null } | null)?.agentMachine ?? null;
  const [machine, setMachine] = useState(now);
  useEffect(() => {
    let live = true;
    boardInfo().then((i) => live && setMachine((i as { agentMachine?: string | null }).agentMachine ?? null)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return machine;
}

// An empty frame: no agent, no start request, nothing drawn or dropped in it.
export function emptyFrame(editor: Editor, id: string): boolean {
  const f = editor.getShape(id as TLShapeId);
  if (!f || f.type !== "frame") return false;
  // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
  const p = ((f.meta as any)?.paseo ?? {}) as Record<string, unknown>;
  return !p.agentId && !p.request && editor.getSortedChildIdsForParent(f.id).length === 0;
}

// `where`: where the frame is or goes ("New frame right of “Pricing page” · Page 1").
// `beside`: the sheet is on an existing frame without an agent. It starts "In this frame" by
// default; "New frame next to it" draws a frame beside it at Start (`beside.make`) instead.
export function StartSheet({ editor, frameId, onCancel, onStarted, prefill, where, boardId, beside }: { editor: Editor; frameId: string; onCancel: () => void; onStarted: (frameId: string) => void; prefill?: StartPrefill; where?: string; boardId?: string; beside?: { name: string; make: () => string | null } }) {
  const [placeNew, setPlaceNew] = useState(false);
  useModalHold();
  const live = useValue("start-sheet-frame", () => editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined, [editor, frameId]);
  const vp = useVisibleViewport();
  const machine = useAgentMachine();
  const [catalogue, setCatalogue] = useState<StartCatalogue | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [line, setLine] = useState(prefill?.prompt ?? "");
  // The frame's (and so the agent's) name. Empty keeps "New agent", or takes a title from the
  // opening message the way the server would (shared/frame-names.ts).
  const [name, setName] = useState(() => {
    if (prefill?.name) return prefill.name;
    const n = (editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined)?.props.name ?? "";
    return n === "New agent" ? "" : n;
  });
  // Runs on: shared with the desktop form's choice (localStorage "bunny:runs-on").
  const saved = () => { try { return localStorage.getItem("bunny:runs-on"); } catch { return null; } };
  // A prefill (same as the agent it was started from) wins over the remembered choice.
  const fromAgent = !!prefill && (prefill.host !== undefined || prefill.worker !== undefined);
  const [cloud, setCloud] = useState(() => (fromAgent ? !!prefill?.worker && !prefill?.host : initialRunsOn(infoNow(), saved())));
  const [startHost, setStartHost] = useState(() => (fromAgent ? prefill?.host ?? "" : saved()?.startsWith("host:") ? saved()!.slice(5) : ""));
  const remember = (value: string) => { try { localStorage.setItem("bunny:runs-on", value); } catch { /* storage blocked */ } };
  const pick = (target: { host: string } | "runtime" | "worker") => {
    if (typeof target === "object") { setStartHost(target.host); setCloud(false); remember(`host:${target.host}`); }
    else { setStartHost(""); setCloud(target === "worker"); remember(target); }
  };
  type StartHost = { host: string; state: string; enabled: boolean; reason?: string };
  const [hosts, setHosts] = useState<{ list: StartHost[]; note: string | null; loading: boolean; error: string | null }>({ list: startHostsMemo().hosts, note: null, loading: startHostsMemo().refreshing, error: null });
  const [hostsTick, setHostsTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hostsTick` asks again.
  useEffect(() => {
    return watchStartHosts(r=>setHosts({list:fleetHostsForRuntime(r.hosts,infoNow()?.runtimeHostname || ""),note:r.note??null,loading:r.refreshing,error:null}),
      e=>setHosts(h=>({...h,loading:false,error:`Could not check hosts: ${e.message}`})),hostsTick>0);
  }, [hostsTick]);
  const worker = !startHost && cloud;
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>(() => ((CLOUD_PROVIDERS as readonly string[]).includes(prefill?.cloudProvider ?? "") ? (prefill!.cloudProvider as CloudProvider) : "claude"));
  const [codexReadiness, setCodexReadiness] = useState<{ ready: boolean; error?: string } | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  // Paseo's harness and model catalogue; asked again while a harness is still loading.
  const loadingHarness = !!catalogue?.harnesses.some((h) => h.status === "loading");
  useEffect(() => {
    if (catalogue && !loadingHarness) return;
    let gone = false;
    const t = setTimeout(
      () =>
        api<StartCatalogue>("/api/ui/start-options")
          .catch((e: Error) => fallbackCatalogue(FALLBACK_PROVIDERS[0], `Could not load models (${e.message})`))
          .then((c) => {
            if (gone) return;
            setCatalogue(c);
            // The prefilled model when the catalogue offers it, else the usual default.
            // (a harness with no model known: that harness's default model).
            setProvider((p) => {
              if (p) return p;
              const like = prefill?.provider ? findChoice(c, prefill.provider) : null;
              return like?.model?.value ?? (like?.harness ? (like.harness.models.find((m) => m.isDefault) ?? like.harness.models[0])?.value : undefined) ?? initialChoice(c);
            });
          }),
      catalogue ? 5000 : 0,
    );
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [catalogue, loadingHarness]);

  useEffect(() => {
    if (!worker || cloudProvider !== "codex") return;
    let gone = false;
    setCodexReadiness(null);
    const load = () =>
      api<{ codex: { ready: boolean; error?: string } }>("/api/ui/cloud-doctor")
        .then((r) => !gone && setCodexReadiness(r.codex))
        .catch(() => !gone && setCodexReadiness({ ready: false, error: "Could not check Codex Cloud readiness" }));
    void load();
    const timer = setInterval(load, 30_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, [worker, cloudProvider]);

  // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
  const paseo = ((live?.meta as any)?.paseo ?? {}) as Record<string, any>;
  // Started elsewhere (another tab, the frame panel) or gone: nothing left to start here.
  const taken = !live || !!paseo.agentId || !!paseo.request;
  useEffect(() => {
    if (taken && !busy.current) onCancel();
  }, [taken, onCancel]);

  const [photoError, setPhotoError] = useState<string | null>(null);
  const start = async () => {
    if (busy.current || !ready || !provider || !live || paseo.agentId || paseo.request) return;
    busy.current = true;
    setPending(true);
    // Screenshots first, so the agent finds them in its frame when it starts.
    if (prefill?.files?.length && boardId) {
      try {
        await placePhotos(editor, boardId, live.id, prefill.files);
      } catch (e) {
        setPhotoError(`Photos not placed: ${(e as Error).message}. Starting without them.`);
      }
    }
    const by = window.__board?.userName ?? "User";
    const request = { kind: "create", provider, prompt: line.trim() || undefined, ...runsOnRequest(cloud, cloudProvider, startHost), requestedAt: Date.now(), by };
    // "New frame next to it": the frame is drawn now, beside this one.
    const targetId = placeNew && beside ? beside.make() : live.id;
    const target = targetId ? (editor.getShape(targetId as TLShapeId) as TLFrameShape | undefined) : undefined;
    if (!target) {
      busy.current = false;
      setPending(false);
      return;
    }
    // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
    const { phoneDraft: _draft, ...meta } = (target.meta ?? {}) as Record<string, any>;
    // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
    const was = ((meta as any).paseo ?? {}) as Record<string, unknown>;
    editor.updateShape<TLFrameShape>({
      id: target.id,
      type: "frame",
      props: { color: "violet", name: placeNew && cleanName(name) === beside?.name ? derivedNew : finalName },
      // (tldraw merges meta: the draft mark is cleared explicitly.)
      meta: { ...meta, phoneDraft: null, paseo: JSON.parse(JSON.stringify({ ...was, request, status: "requested", error: undefined })) },
    });
    (document.activeElement as HTMLElement | null)?.blur?.();
    onStarted(target.id);
  };

  // The board's runtime: the machine its Paseo daemon reports, else the configured runtime host.
  const runtime = machine || infoNow()?.runtimeHostname || "";
  const runtimeText = runtime || "Board's agent machine";
  const hostOk = !startHost || (hosts.list.some((h) => h.host === startHost && h.enabled));
  const ready = !!provider && hostOk;
  // (A quoted message, from "Start agent about this", is named by its text, not its "> ".)
  const derived = nameFromRequest(line.replace(/^[ \t]*> ?/gm, "")) || (live?.props.name && live.props.name !== "New agent" ? live.props.name : "New agent");
  const finalName = cleanName(name) || derived;
  // A new frame beside this one does not take this frame's name.
  const derivedNew = nameFromRequest(line.replace(/^[ \t]*> ?/gm, "")) || "New agent";
  const runsOn = startHost || (worker ? "an ephemeral worker" : runtime || "the board's agent machine");
  return (
    <div className="bm-start-layer" data-mobile-ui data-testid="mobile-start-layer" style={{ top: vp.top, height: vp.height }}>
      <style>{BUNNY_CONTROLS_CSS}</style>
      <div className="bm-start-scrim" onPointerDown={() => !busy.current && onCancel()} />
      <div className="bm-start-sheet" data-testid="mobile-start-sheet" role="dialog" aria-modal="true" aria-label="Start a new agent" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" && !busy.current) onCancel(); }}>
        <div className="bm-start-head">
          <span className="bm-grip-bar" aria-hidden="true" />
          <b>New agent</b>
          {beside ? null : where ? <small data-testid="start-where">{where}</small> : null}
          {prefill?.files?.length ? <small data-testid="start-photos">{prefill.files.length} screenshot{prefill.files.length === 1 ? "" : "s"} go into the frame</small> : null}
          {photoError ? <small role="alert" style={{ color: B.danger }}>{photoError}</small> : null}
        </div>
        <div className="bm-start-body" data-testid="start-form">
          {beside ? (
            <div role="radiogroup" aria-label="Where" data-testid="start-place" className="bm-start-seg bm-start-wrap">
              <button type="button" role="radio" data-testid="start-place-here" aria-checked={!placeNew} data-on={!placeNew} onClick={() => setPlaceNew(false)}>
                In this frame
              </button>
              <button type="button" role="radio" data-testid="start-place-new" aria-checked={placeNew} data-on={placeNew} onClick={() => setPlaceNew(true)}>
                New frame next to it
              </button>
            </div>
          ) : null}
          {beside ? <small data-testid="start-where" className="bm-start-runs">{placeNew ? `A new frame beside “${beside.name}”` : `In “${beside.name}”`}</small> : null}
          <label className="bm-start-field">
            <span style={fieldLabel}>Name</span>
            <input data-testid="start-name" className="bm-start-input" type="text" maxLength={80} enterKeyHint="next" autoComplete="off" placeholder={derived} aria-label="Agent name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="bm-start-field">
            <span style={fieldLabel}>Model</span>
            <ModelSheet catalogue={catalogue} value={provider} onChange={setProvider} />
          </div>
          <textarea data-testid="opening-line" className="bm-start-text" rows={3} aria-label="Opening message" placeholder="Opening message (optional)" value={line} onChange={(e) => setLine(e.target.value)} />
          <div role="radiogroup" aria-label="Runs on" data-testid="start-runs-on" className="bm-start-seg bm-start-wrap">
            <span data-testid="start-host-label" style={{display:"inline-flex",alignItems:"center",gap:4,flexBasis:"100%",whiteSpace:"nowrap"}}><span style={fieldLabel}>Runs on</span><button className="bm-start-refresh" type="button" aria-label="Refresh hosts" onClick={()=>setHostsTick(n=>n+1)}>↻</button></span>
            <button type="button" role="radio" data-testid="start-host-scope" data-machine={machine ?? ""} aria-checked={!startHost && !cloud} data-on={!startHost && !cloud} title={runtime ? `The board's Paseo runtime on ${runtime}` : "The board's Paseo runtime (its machine name is not known yet)"} onClick={() => pick("runtime")}>
              {runtimeText}
            </button>
            {hosts.list.map((h) => (
              <button key={h.host} type="button" role="radio" data-testid={`start-host-${h.host}`} aria-checked={startHost === h.host} data-on={startHost === h.host} disabled={!h.enabled} title={h.reason || `Start on ${h.host}`} onClick={() => pick(h)}>
                {h.host}
              </button>
            ))}
            <button type="button" role="radio" data-testid="start-cloud" aria-checked={worker} data-on={worker} onClick={() => pick("worker")}>
              ☁ Ephemeral worker
            </button>
          </div>
          {worker ? (
            <div role="radiogroup" aria-label="Cloud builder: who writes the code (not the Model above)" data-testid="start-cloud-provider" className="bm-start-seg bm-start-wrap">
              <span style={{...fieldLabel,flexBasis:"100%"}}>Cloud builder</span>
              {CLOUD_PROVIDERS.map((p) => (
                <label key={p} data-on={cloudProvider === p}>
                  <input type="radio" name={`m-cloud-provider-${frameId}`} value={p} data-testid={`start-cloud-provider-${p}`} checked={cloudProvider === p} onChange={() => setCloudProvider(p)} />
                  {CLOUD_PROVIDER_LABEL[p]}
                </label>
              ))}
            </div>
          ) : null}
          {worker && cloudProvider === "codex" && codexReadiness?.ready === false ? (
            <div data-testid="start-codex-hint" className="bm-start-note" style={{ background: B.peachSoft }}>
              {codexReadiness.error || "Codex Cloud is not ready on the agent machine. Run cloud-task doctor --provider codex there for details."}
            </div>
          ) : null}
          <div data-testid="start-identity" className="bm-start-runs">
            Board: {infoNow()?.boardHostname || machine || "unknown"} · Agent runs on <b>{runsOn}</b>
          </div>
          {hosts.list.filter((h) => !h.enabled).map((h) => (
            <div key={h.host} data-testid="start-host-reason" className="bm-start-note">
              {h.host}: {h.reason}
            </div>
          ))}
          {hosts.loading ? <div role="status" className="bm-start-note">Refreshing hosts…</div> : null}
          {hosts.note ? <div className="bm-start-note">{hosts.note}</div> : null}
          {hosts.error ? <div role="alert" className="bm-start-note" style={{ color: B.danger }}>{hosts.error}</div> : null}
        </div>
        <div className="bm-start-foot">
          <button type="button" data-testid="start-cancel" className="bm-start-cancel" disabled={pending} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" data-testid="start-go" className="bm-start-go" disabled={!ready || pending} aria-busy={pending} onClick={() => void start()}>
            {pending ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </div>
  );
}
