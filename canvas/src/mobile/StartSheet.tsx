import { rememberFrameStart } from "../jumpPaletteModel";
import {startHostsMemo,watchStartHosts} from "../startHosts";
// Phone shell: the New agent start form as a bottom sheet above everything else (scrim,
// spotlight, frame panel), sized to the visual viewport so the keyboard never hides Cancel
// or Start. Same request as the desktop frame panel's start form (FramePanel.tsx): the
// conversation's model, an opening message and where it runs: one choice naming the machine
// (the board's runtime or a fleet host) plus a Cloud agent switch (a cloud builder writes the
// code; the agent itself still runs on the board's machine). The runtime choice names the
// machine the agent will really run on (/api/ui/info agentMachine), never "this Mac".
// Start is one request per tap or ⌘/Ctrl+Enter (disabled while it is written); a frame the shell drew for
// this sheet goes away again if the sheet is dismissed without Start.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Editor, TLFrameShape, TLPageId, TLShapeId } from "tldraw";
import { useValue } from "tldraw";
import { api } from "../api";
import { boardInfo, infoNow } from "../info";
import { ModelSheet } from "./ModelSheet";
import { placePhotos } from "./placePhotos";
import { PhotoIcon, PhotoTray } from "./PhotoTray";
import { usePages } from "./pages";
import { whereOnBoard } from "./Reveal";
import { newFrameSpot } from "./mobileMode";
import { useModalHold } from "./modalHold";
import { useSwipeDismiss } from "./sheetDrag";
import { cleanName, nameFromRequest } from "../../../shared/frame-names";
import { B, BUNNY_CONTROLS_CSS, fieldLabel } from "../bunnyTheme";
import { modEnterSubmits } from "../submitShortcut";
import { FALLBACK_PROVIDERS, effortFor, fallbackCatalogue, rememberedChoice, type StartCatalogue, withCustomModels } from "../../../shared/start-catalogue";
import { addCustomModel, customModels, lastStartChoice, lastStartPage, rememberStartChoice, rememberStartPage } from "../startChoice";
import { CLOUD_PROVIDERS, CLOUD_PROVIDER_LABEL, type CloudProvider } from "../../../shared/cloud-provider";
import { upstashDefault, executionLabel, fleetHostsForRuntime, initialRunsOn, machineLabel, runsOnRequest, runsOnSummary } from "../../../shared/conversation-links";
import "./startSheet.css";
import { SuggestField, useQuickStartData } from "../QuickStarts";
import { recordOpeningPrompt, takePendingPrompt } from "../quickStartPrompts";

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
// (+ New in the top bar, Start agent about this): the model, where it runs, the opening message.
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
    // iOS reports the keyboard closing before its animation ends, and can leave the page scrolled
    // by the focused field: the sheet then sat up the screen with a gap below it. Read again
    // once things settle, and with the keyboard gone put the page back (the phone shell never
    // scrolls the document).
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = () => {
      setVp(read());
      const kb = !!v && v.height < window.innerHeight - 120;
      if (!kb && (window.scrollY || document.documentElement.scrollTop)) {
        window.scrollTo(0, 0);
        setVp(read());
      }
    };
    const update = () => {
      setVp(read());
      timers.splice(0).forEach(clearTimeout);
      timers.push(setTimeout(settle, 120), setTimeout(settle, 450));
    };
    v?.addEventListener("resize", update);
    v?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      timers.forEach(clearTimeout);
      v?.removeEventListener("resize", update);
      v?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return vp;
}

const MAX_PHOTOS = 6;
// Image files from a paste (a screenshot copied on the phone or the clipboard).
const pastedImages = (e: React.ClipboardEvent) => Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));

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
// `movable`: the shell drew this frame for the sheet, so the page it goes on can still change.
export function StartSheet({ editor, frameId, onCancel, onStarted, prefill, where, boardId, beside, movable }: { editor: Editor; frameId: string; onCancel: () => void; onStarted: (frameId: string) => void; prefill?: StartPrefill; where?: string; boardId?: string; beside?: { name: string; make: () => string | null }; movable?: boolean }) {
  const [placeNew, setPlaceNew] = useState(false);
  useModalHold();
  const live = useValue("start-sheet-frame", () => editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined, [editor, frameId]);
  const vp = useVisibleViewport();
  // Pages: a new frame can move to another page (free space there); an existing frame keeps its own.
  const pages = usePages(editor);
  const pageId = useValue("start-sheet-page", () => editor.getAncestorPageId(frameId as TLShapeId) ?? null, [editor, frameId]);
  // The page dropdown names the page, so the line under it leaves it out.
  const pickPage = movable && pages.length > 1;
  const liveWhere = useValue("start-sheet-where", () => (movable ? `New frame ${whereOnBoard(editor, frameId, !pickPage)}` : null), [editor, frameId, movable, pickPage]);
  // Offered first in the dropdown: the page the sheet opened on (where you are) and the page
  // last started on from this device.
  const [herePage] = useState(pageId);
  const lastPage = useMemo(() => (boardId ? lastStartPage(boardId) : null), [boardId]);
  const toPage = (page: string) => {
    if (!movable || page === pageId || busy.current) return;
    const boxes = editor.getSortedChildIdsForParent(page as TLPageId).flatMap((id) => {
      const s = editor.getShape(id);
      return s?.type === "frame" ? (editor.getShapePageBounds(id) ?? []) : [];
    });
    const at = newFrameSpot(boxes);
    editor.moveShapesToPage([frameId as TLShapeId], page as TLPageId);
    editor.updateShape({ id: frameId as TLShapeId, type: "frame", x: at.x, y: at.y });
  };
  // Keyboard up (or a field tapped): the field being typed in scrolls into the part of the
  // sheet still visible, never left under the keyboard.
  const bodyRef = useRef<HTMLDivElement>(null);
  const revealField = () => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || !bodyRef.current?.contains(el) || !el.matches("input, textarea")) return;
    requestAnimationFrame(() => el.scrollIntoView({ block: "nearest" }));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: on each visible-viewport change.
  useEffect(() => {
    revealField();
    const t = setTimeout(revealField, 320); // after iOS's keyboard animation
    return () => clearTimeout(t);
  }, [vp.height, vp.top]);
  const machine = useAgentMachine();
  const [catalogue, setCatalogue] = useState<StartCatalogue | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  // Reasoning effort (Paseo thinkingOptionId); null is the model's default.
  const [effort, setEffort] = useState<string | null>(null);
  const [custom, setCustom] = useState(customModels);
  const shownCatalogue = catalogue ? withCustomModels(catalogue, custom) : null;
  const [line, setLine] = useState(() => prefill?.prompt ?? takePendingPrompt(frameId) ?? "");
  // Next-step suggestions sit inside the message box while it is empty and no name has been
  // typed (naming the agent is the person saying what they want).
  const quick = useQuickStartData({ editor, frameId });
  const [nameTyped, setNameTyped] = useState(false);
  const suggesting = !line.trim() && !nameTyped;
  const firstIdea = suggesting ? quick.cards[0]?.prompt : undefined;
  // Screenshots go into the frame before the agent starts: Tell Bunny's, plus any added here.
  const [photos, setPhotos] = useState<File[]>(() => prefill?.files ?? []);
  const previews = useMemo(() => photos.map((f) => URL.createObjectURL(f)), [photos]);
  useEffect(() => () => previews.forEach((u) => URL.revokeObjectURL(u)), [previews]);
  const picker = useRef<HTMLInputElement>(null);
  const addPhotos = (more: File[]) => more.length && setPhotos((p) => [...p, ...more].slice(0, MAX_PHOTOS));
  // The opening message full screen (the rest of the form folds away until it closes).
  const [full, setFull] = useState(false);
  // The frame's (and so the agent's) name. Empty keeps "New agent", or takes a title from the
  // opening message the way the server would (shared/frame-names.ts).
  const [name, setName] = useState(() => {
    if (prefill?.name) return prefill.name;
    const n = (editor.getShape(frameId as TLShapeId) as TLFrameShape | undefined)?.props.name ?? "";
    return n === "New agent" ? "" : n;
  });
  // Runs on: shared with the desktop form's choice (localStorage "bunny:runs-on").
  const ephemeral = upstashDefault(infoNow());
  const saved = () => { try { return localStorage.getItem("bunny:runs-on"); } catch { return null; } };
  // A prefill (same as the agent it was started from) wins over the remembered choice.
  const fromAgent = !!prefill && (prefill.host !== undefined || prefill.worker !== undefined);
  const [cloud, setCloud] = useState(() => (fromAgent ? !!prefill?.worker && !prefill?.host : initialRunsOn(infoNow(), saved())));
  const [startHost, setStartHost] = useState(() => (fromAgent ? prefill?.host ?? "" : ephemeral ? "" : saved()?.startsWith("host:") ? saved()!.slice(5) : ""));
  const remember = (value: string) => { try { localStorage.setItem("bunny:runs-on", value); } catch { /* storage blocked */ } };
  // A fleet host; "runtime" (the board's machine, keeping the cloud box as it was); or the
  // ☁ Use cloud agent box on/off ("worker"/"local"), which always runs on the board's machine.
  const pick = (target: { host: string } | "runtime" | "worker" | "local") => {
    if (typeof target === "object") { setStartHost(target.host); setCloud(false); remember(`host:${target.host}`); return; }
    const next = target === "runtime" ? !startHost && cloud : target === "worker";
    setStartHost(""); setCloud(next); remember(next ? "worker" : "runtime");
  };
  type StartHost = { host: string; state: string; enabled: boolean; reason?: string };
  const [hosts, setHosts] = useState<{ list: StartHost[]; note: string | null; loading: boolean; error: string | null }>({ list: startHostsMemo().hosts, note: null, loading: startHostsMemo().refreshing, error: null });
  // No refresh button: the list is asked for fresh when the sheet opens, again every 30 s while
  // it is open, and when the phone comes back to the page.
  const [hostsTick, setHostsTick] = useState(0);
  useEffect(() => {
    const again = () => document.visibilityState === "visible" && setHostsTick((n) => n + 1);
    const timer = setInterval(again, 30_000);
    document.addEventListener("visibilitychange", again);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", again); };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `hostsTick` asks again.
  useEffect(() => {
    return watchStartHosts(r=>setHosts({list:fleetHostsForRuntime(r.hosts,infoNow()?.runtimeHostname || ""),note:r.note??null,loading:r.refreshing,error:null}),
      e=>setHosts(h=>({...h,loading:false,error:e.message})),true);
  }, [hostsTick]);
  const worker = !ephemeral && !startHost && cloud;
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>(() => ((CLOUD_PROVIDERS as readonly string[]).includes(prefill?.cloudProvider ?? "") ? (prefill!.cloudProvider as CloudProvider) : "claude"));
  const [codexReadiness, setCodexReadiness] = useState<{ ready: boolean; error?: string } | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  // Swipe down to dismiss, not while a start is in flight (Cancel is the same).
  const swipe = useSwipeDismiss(() => !busy.current && onCancel(), !pending);

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
            // A prefill (an agent like that one) first, then the model and effort last started
            // from this device, when the catalogue still offers them; else the usual default.
            setProvider((p) => {
              if (p) return p;
              const last = lastStartChoice();
              const r = rememberedChoice(withCustomModels(c, customModels()), prefill?.provider ? { provider: prefill.provider, effort: last?.effort } : last);
              setEffort(r.effort);
              return r.provider;
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
    rememberStartChoice({ provider, effort });
    if (movable && boardId && pageId) rememberStartPage(boardId, pageId);
    const by = window.__board?.userName ?? "User";
    recordOpeningPrompt(line);
    const request = { kind: "create", provider, ...(effort ? { thinkingOptionId: effort } : {}), prompt: line.trim() || undefined, ...runsOnRequest(ephemeral ? false : cloud, cloudProvider, startHost), requestedAt: Date.now(), by };
    // "New frame next to it": the frame is drawn now, beside this one.
    const targetId = placeNew && beside ? beside.make() : live.id;
    const target = targetId ? (editor.getShape(targetId as TLShapeId) as TLFrameShape | undefined) : undefined;
    if (!target) {
      busy.current = false;
      setPending(false);
      return;
    }
    // Starting counts as your first message (frame tabs' Recent, the phone's recent order).
    rememberFrameStart(target.id);
    // Screenshots first, so the agent finds them in its frame when it starts.
    if (photos.length && boardId) {
      try {
        await placePhotos(editor, boardId, target.id, photos);
      } catch (e) {
        setPhotoError(`Photos not placed: ${(e as Error).message}. Starting without them.`);
      }
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
  const runtimeText = runtime ? machineLabel(runtime, infoNow()?.boardHostname) : "The board's Mac";
  const hostOk = !startHost || (hosts.list.some((h) => h.host === startHost && h.enabled));
  const ready = !!provider && hostOk;
  // (A quoted message, from "Start agent about this", is named by its text, not its "> ".)
  const derived = nameFromRequest(line.replace(/^[ \t]*> ?/gm, "")) || (live?.props.name && live.props.name !== "New agent" ? live.props.name : "New agent");
  const finalName = cleanName(name) || derived;
  // A new frame beside this one does not take this frame's name.
  const derivedNew = nameFromRequest(line.replace(/^[ \t]*> ?/gm, "")) || "New agent";
  const boardName = !boardId || boardId === "main" ? "Bunny board" : boardId;
  const pageName = pages.find((p) => p.id === pageId)?.name ?? "";
  const whereText = beside ? (placeNew ? `A new frame beside “${beside.name}”` : `In “${beside.name}”`) + (pageName && pages.length > 1 ? ` · ${pageName}` : "") : liveWhere ?? where;
  return (
    <div className="bm-start-layer" data-mobile-ui data-testid="mobile-start-layer" style={{ top: vp.top, height: vp.height }}>
      <style>{BUNNY_CONTROLS_CSS}</style>
      <div className="bm-start-scrim" onPointerDown={() => !busy.current && onCancel()} />
      <div ref={swipe} className="bm-start-sheet" data-testid="mobile-start-sheet" data-full={full} data-kb={vp.height < window.innerHeight - 120} role="dialog" aria-modal="true" aria-label="Start a new agent" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape" && !busy.current) onCancel(); else if (modEnterSubmits(e.nativeEvent)) { e.preventDefault(); void start(); } }}>
        <div className="bm-start-head">
          <span className="bm-grip-bar" aria-hidden="true" />
          <b>New agent</b>
          {photoError ? <small role="alert" style={{ color: B.danger }}>{photoError}</small> : null}
        </div>
        <div className="bm-start-body" data-testid="start-form" ref={bodyRef} onFocus={revealField}>
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
          <div className="bm-start-target" data-testid="start-target">
            <span style={fieldLabel}>Adds to</span>
            <b data-testid="start-board">{boardName}</b>
            {whereText ? <small data-testid="start-where">{whereText}</small> : null}
            {pickPage ? (
              // One dropdown (the phone's own picker), not a wall of page buttons: the page you
              // are on and the one last used first, then every page.
              <label className="bm-start-pagepick" data-testid="start-page">
                <span className="bm-start-sr">Page</span>
                <select data-testid="start-page-select" aria-label="Page" value={pageId ?? ""} disabled={pending} onChange={(e) => toPage(e.target.value)}>
                  {(() => {
                    const top = [herePage ? { id: herePage, note: "this page" } : null, lastPage && lastPage !== herePage ? { id: lastPage, note: "last used" } : null].flatMap((t) => (t && pages.some((p) => p.id === t.id) ? [t] : []));
                    const name = (id: string) => pages.find((p) => p.id === id)?.name ?? "";
                    return (
                      <>
                        {top.length ? (
                          <optgroup label="Suggested">
                            {top.map((t) => <option key={t.id} value={t.id} data-testid="start-page-option" data-page-id={t.id}>{`${name(t.id)} · ${t.note}`}</option>)}
                          </optgroup>
                        ) : null}
                        <optgroup label="All pages">
                          {pages.filter((p) => !top.some((t) => t.id === p.id)).map((p) => <option key={p.id} value={p.id} data-testid="start-page-option" data-page-id={p.id}>{p.name}</option>)}
                        </optgroup>
                      </>
                    );
                  })()}
                </select>
                <ChevronIcon />
              </label>
            ) : null}
          </div>
          <label className="bm-start-field">
            <span style={fieldLabel}>Name</span>
            <input data-testid="start-name" className="bm-start-input" type="text" maxLength={80} enterKeyHint="next" autoComplete="off" placeholder={derived} aria-label="Agent name" value={name} onChange={(e) => { setName(e.target.value); setNameTyped(!!e.target.value.trim()); }} />
          </label>
          <div className="bm-start-field">
            <span style={fieldLabel}>Model</span>
            <ModelSheet
              catalogue={shownCatalogue}
              value={provider}
              effort={effort}
              onChange={(v) => { const e = effortFor(shownCatalogue, v, effort); setProvider(v); setEffort(e); rememberStartChoice({ provider: v, effort: e }); }}
              onEffort={(e) => { setEffort(e); rememberStartChoice({ provider, effort: e }); }}
              onCustom={(v) => { setCustom(addCustomModel(v)); setProvider(v); rememberStartChoice({ provider: v, effort }); }}
            />
          </div>
          <SuggestField data={quick} show={suggesting} layout="compact" insetRight={40} className="bm-start-message" onPick={(s) => setLine(s.prompt)}>
            {(minHeight) => (
              <>
                <textarea data-testid="opening-line" className="bm-start-text" rows={3} style={minHeight ? { minHeight } : undefined} aria-label="Opening message" placeholder="Opening message (optional)" value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => { if (e.key === "Tab" && !e.shiftKey && firstIdea && !line) { e.preventDefault(); setLine(firstIdea); } }} onPaste={(e) => { const imgs = pastedImages(e); if (imgs.length) { e.preventDefault(); addPhotos(imgs); } }} />
                <button type="button" className="bm-start-expand" data-testid="start-fullscreen" aria-pressed={full} aria-label={full ? "Close full screen message" : "Write the message full screen"} onClick={() => setFull((f) => !f)}>
                  {full ? <CollapseIcon /> : <ExpandIcon />}
                </button>
              </>
            )}
          </SuggestField>
          <div className="bm-start-photos" data-testid="start-photos">
            <PhotoTray photos={photos} previews={previews} setPhotos={setPhotos} disabled={pending} />
            <input ref={picker} type="file" accept="image/*" multiple hidden data-testid="start-photo-input" onChange={(e) => { const picked = Array.from(e.target.files ?? []); e.target.value = ""; addPhotos(picked); }} />
            {photos.length < MAX_PHOTOS ? (
              <button type="button" className="bm-start-photo" data-testid="start-photo" disabled={pending} onClick={() => picker.current?.click()}>
                <PhotoIcon /> {photos.length ? "Add more" : "Add screenshots"}
              </button>
            ) : null}
          </div>
          <div className="bm-start-field">
            <span data-testid="start-host-label" className="bm-start-checks-head"><span style={fieldLabel} id={`m-runs-on-${frameId}`}>Runs on</span>{hosts.loading ? <small role="status" data-testid="start-hosts-checking">Checking machines…</small> : null}</span>
            {/* One machine at a time: the same segmented choice as the desktop form, not checkboxes. */}
            <div role="radiogroup" aria-labelledby={`m-runs-on-${frameId}`} aria-describedby={`m-start-identity-${frameId}`} data-testid="start-runs-on" className="bm-start-seg bm-start-wrap">
              <button type="button" role="radio" data-testid="start-host-scope" data-machine={machine ?? ""} aria-checked={!startHost} data-on={!startHost} title={runtime ? `The board's Paseo runtime on ${runtime}` : "The board's Paseo runtime (its machine name is not known yet)"} onClick={() => pick("runtime")}>
                {ephemeral ? "Upstash · ephemeral worker" : runtimeText}
              </button>
              {hosts.list.map((h) => (
                <button key={h.host} type="button" role="radio" data-testid={`start-host-${h.host}`} aria-checked={startHost === h.host} data-on={startHost === h.host} disabled={!h.enabled} title={h.reason || `Run the agent on ${h.host}`} onClick={() => pick(h)}>
                  {executionLabel(h.host)}
                </button>
              ))}
            </div>
          </div>
          {!ephemeral && (
            <button type="button" role="switch" data-testid="start-cloud" aria-checked={worker} className="bm-start-switch" title={`The agent runs on ${runtime || "the board's Mac"}; a cloud builder (Claude or Codex) writes the code.`} onClick={() => pick(worker ? "local" : "worker")}>
              <span aria-hidden="true" className="bm-start-switch-track"><span className="bm-start-switch-thumb" /></span>
              Cloud agent
            </button>
          )}
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
          {/* The selected machine already says where it runs; read out with the choice, not shown. */}
          <div id={`m-start-identity-${frameId}`} data-testid="start-identity" className="bm-start-sr">
            {ephemeral ? (startHost ? `The agent runs on ${executionLabel(startHost)}.` : "The agent runs on an ephemeral Upstash worker. Your selected subscription is used.") : runsOnSummary({ machine: startHost || runtime, boardHost: infoNow()?.boardHostname, cloudProvider: worker ? cloudProvider : null })}
          </div>
          {hosts.list.filter((h) => !h.enabled).map((h) => (
            <div key={h.host} data-testid="start-host-reason" className="bm-start-note">
              {h.host}: {h.reason}
            </div>
          ))}
          {hosts.note ? <div className="bm-start-note">{hosts.note}</div> : null}
          {hosts.error ? (
            <div role="alert" data-testid="start-hosts-error" className="bm-start-note bm-start-alert">
              <b>Other machines could not be listed.</b> {runtimeText} still works. The list tries again every 30 s, or close and reopen this sheet. If it keeps failing, check the fleet host is online. ({hosts.error})
            </div>
          ) : null}
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

const ChevronIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
);
const ExpandIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
);
const CollapseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /></svg>
);
