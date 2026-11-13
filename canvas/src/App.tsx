import { TLDRAW_LICENSE_KEY } from "./tldraw-license";
import { BoardStylePanel } from "./BoardStylePanel";
import { readSetting } from "../../shared/bunny-storage";
import { FrameCompression } from "./FrameCompression";
import { Comments, CommentToolIcon } from "./comments/Comments";
import { COMMENT_TOOL, CommentTool, installCommentAnchorKeeper, setShowPins, showPins } from "./comments/state";
import { EmptyBoardHint } from "./EmptyBoardHint";
import { moveFramesToPage, newPage, showMoved } from "./moveFrames";
import { installTextBoundsMeasurements } from "./measuredTextBounds";
import { useSync } from "@tldraw/sync";
import { useCachedSync } from "./cachedSync";
import { installSnapshotResponder, onBoardMessage } from "./frameSnapshot";
import { boardCacheEnabled } from "./boardCache";
import { markLaunch } from "./launchTiming";
import { MenuPanelWithNewAgent } from "./NewAgentButton";
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  DefaultContextMenu,
  ArrangeMenuSubmenu,
  ClipboardMenuGroup,
  ConversionsMenuGroup,
  CursorChatItem,
  EditMenuSubmenu,
  MoveToPageMenu,
  ReorderMenuSubmenu,
  SelectAllMenuItem,
  useShowCollaborationUi,
  defaultHandleExternalUrlContent,
  DefaultToolbar,
  SelectToolbarItem,
  HandToolbarItem,
  DrawToolbarItem,
  EraserToolbarItem,
  ArrowToolbarItem,
  TextToolbarItem,
  NoteToolbarItem,
  AssetToolbarItem,
  RectangleToolbarItem,
  EllipseToolbarItem,
  TriangleToolbarItem,
  DiamondToolbarItem,
  HexagonToolbarItem,
  OvalToolbarItem,
  RhombusToolbarItem,
  StarToolbarItem,
  CloudToolbarItem,
  HeartToolbarItem,
  XBoxToolbarItem,
  CheckBoxToolbarItem,
  ArrowLeftToolbarItem,
  ArrowUpToolbarItem,
  ArrowDownToolbarItem,
  ArrowRightToolbarItem,
  LineToolbarItem,
  HighlightToolbarItem,
  LaserToolbarItem,
  FrameToolbarItem,
  defaultShapeUtils,
  type Editor,
  FrameShapeUtil,
  type TLAssetStore,
  type TLEventInfo,
  type TLFrameShape,
  type TLShape,
  type TLShapeId,
  type TLPageId,
  type TLUiContextMenuProps,
  type TLUiOverrides,
  Tldraw,
  TldrawUiMenuGroup,
  TldrawUiMenuItem,
  TldrawUiMenuSubmenu,
  useToasts,
  react,
  TldrawUiMenuToolItem,
  useEditor,
  useValue,
} from "tldraw";
import "tldraw/tldraw.css";
import { LINK_TYPE, linkDefaults, parseBoardUrl } from "../../shared/components/link";
import { COMPONENTS_VERSION } from "../../shared/components/transcript";
import { HostRecoveryBanner } from "./HostRecoveryBanner";
import { ReviewRegions } from "./ReviewRegion";
import { Channels } from "./Channels";
import { LinkChannels } from "./LinkChannels";
import { ConnectPicker } from "./ConnectPicker";
import { handleImageDrop } from "./fileDrop";
import { uploadImage, UploadProgress } from "./uploads";
import { ReportBookmarkShapeUtil } from "./components/report/shape";
import { agentStore } from "./agents";
import { conversationFrameOf } from "./conversationFrame";
import { frameTitleName, tabTitle } from "./tabTitle";
import { placeAt } from "./components/place";
import { componentShapeUtils, handleComponentDrop, StampTool, StampToolButton, WidgetTrayButton } from "./components/registry";
import { boardInfo, infoNow, publicBaseNow } from "./info";
import { type ReleasedAgent, ReleasedPrompt } from "./ReleasedPrompt";
import { BoardControls, PausedBadges, useNarrow } from "./BoardControls";
import { BoardHeader } from "./BoardHeader";
import { initDeviceLock, installLayoutGuard } from "./locks";
import { FramePanel } from "./FramePanel";
import { ChannelLayer } from "./ChannelLayer";
import { usePanelDock } from "./framePanelDock";
import { DockRow } from "./DockRow";
import { noteViewed } from "./jumpPaletteModel";
import { PIN_LIMIT, usePins } from "./pins";
import { FrameHistoryView, HistoryCtx } from "./FrameHistory";
import { archiveTargets } from "./archiveTarget";
import { api } from "./api";
import { ArchiveCtx, ArchivePanel, type ArchiveTab, archiveFrames, ProposalBanner, restoreArchived } from "./FrameArchive";
import { OrganizerPopover } from "./OrganizerPopover";
import { ImportPicker, type ImportResponse, type PickerTarget } from "./ImportPicker";
import { Sidebar } from "./Sidebar";
import { SidebarToggle } from "./SidebarToggle";
import { readSidebar, writeSidebar } from "./sidebarMemory";
import { BoardUiCtx } from "./ui";
import { JumpPalette } from "./JumpPalette";
import { framePeek, pinToScreen, Portals } from "./portals/Portals";
import { ScreenPills } from "./portals/ScreenPills";
import { updateScreenPin } from "./portals/screenPins";
import { PORTAL_TOOL, PortalTool, PortalToolIcon } from "./portals/PortalTool";
import { installEditKeyBuffer } from "./editKeyBuffer";
import { installFrameRenameFocus } from "./frameRename";
import { PortalMenuItems } from "./portals/PortalMenu";
import { MobileCtx, useMobileShell } from "./mobile/mobileMode";
import { MobileShell } from "./mobile/MobileShell";
import { askOpenFrame } from "./mobile/CreateSheet";
import { ShellErrorBoundary } from "./mobile/ShellErrorBoundary";
import { MOBILE_TLDRAW } from "./mobile/mobileMode";
import { PhoneCanvas } from "./mobile/PhoneCanvas";
import { capPhonePixelRatio } from "./mobile/lod";
import { VARIANT_WIDTHS, variantUrl, variantWidth } from "../../shared/image-variants";
import { phoneOpenFrame, phoneView, setPhoneView } from "./mobile/visibility";
import { rememberPlace, setFrameInUrl } from "./places";
import { PhoneFrameShapeUtil, PhoneGeoShapeUtil, PhoneNoteShapeUtil, PhoneTextShapeUtil, phoneGeometryOn, setPhoneGeometry } from "./mobile/phoneGeometry";
import { keepCollaborativeSyncRate } from "./syncRate";

// Desktop only: loaded on its own, so phones never download or run it.
const FrameTabs = lazy(() => import("./FrameTabs").then((m) => ({ default: m.FrameTabs })));

declare global {
  interface Window {
    __editor?: Editor;
    __board?: { boardId: string; userId: string; userName: string };
  }
}

// Phones and the home-screen app draw a saved copy of the board at once and fetch only what
// changed (cachedSync.ts); desktop tabs sync as before. Fixed for the page's life.
const useBoardSync: (o: { uri: string; assets: TLAssetStore; shapeUtils: typeof shapeUtils; boardId: string }) => ReturnType<typeof useSync> = boardCacheEnabled() ? useCachedSync : ({ uri, assets, shapeUtils }) => useSync({ uri, assets, shapeUtils, onCustomMessageReceived: onBoardMessage });

function params() {
  const q = new URLSearchParams(window.location.search);
  return { boardId: q.get("board") || "main", frameId: q.get("frame") };
}

function identity() {
  let userId = readSetting(localStorage, "bunny-user");
  if (!userId) {
    userId = `user-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem("bunny-user", userId);
  }
  const q = new URLSearchParams(window.location.search);
  const userName = q.get("as") || readSetting(localStorage, "bunny-name") || infoNow()?.humanName || "User";
  return { userId, userName };
}

// The variant width for an image on the phone. On the open frame or board a larger copy is
// taken at once and a smaller one only once it needs a quarter of the width or less: pinching
// back and forth does not swap copies (each swap is a new <img>, and a browser can keep the
// decoded pixels of the one it replaced). Thumbnails (under the tiles) always get their size.
const phoneWidths = new Map<string, number>();
function phoneImageWidth(assetId: string, wanted: number): number {
  const want = variantWidth(wanted) ?? VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1];
  if (phoneView.get().mode === "tiles") return want;
  const last = phoneWidths.get(assetId);
  const w = last && want < last && want * 4 > last ? last : want;
  phoneWidths.set(assetId, w);
  return w;
}

const assets: TLAssetStore = {
  async upload(_asset, file, signal) {
    return uploadImage(params().boardId, file, signal);
  },
  // Board-served assets load from this page's own origin, whatever host and port the
  // stored URL names (the board moved from :8791 to :8793 on 2026-10-27; boards keep
  // the old absolute URLs).
  resolve(asset, ctx) {
    const src = asset.props.src;
    if (!src) return src;
    let url = src;
    try {
      const u = new URL(src);
      if (u.pathname.startsWith("/api/assets/")) url = `${window.location.origin}${u.pathname}`;
    } catch {
      /* not a URL */
    }
    // Phone: an image at the size it is drawn, not its full resolution (a 1320x2868
    // screenshot is ~15 MB decoded; shared/image-variants.ts). Pixel ratio capped at 2.
    if (phoneGeometryOn() && asset.type === "image" && !ctx.shouldResolveToOriginal) return variantUrl(url, phoneImageWidth(asset.id, asset.props.w * ctx.steppedScreenScale * Math.min(2, ctx.dpr || 1)), asset.props.w);
    return url;
  },
};

// Frame colours show agent status. useSync builds its schema from exactly this list,
// so it must carry every default shape util, with frame swapped for the configured one,
// plus the board components (canvas/src/components/registry.ts). The server schema
// gets the same components from shared/components.
// Note, text, geo and frame are tldraw's own (frames with status colours), with a phone-only
// geometry fast path (mobile/phoneGeometry.ts).
const shapeUtils = [...defaultShapeUtils.filter((u) => !["frame", "bookmark", "note", "text", "geo"].includes(u.type)), PhoneNoteShapeUtil, PhoneTextShapeUtil, PhoneGeoShapeUtil, ReportBookmarkShapeUtil, PhoneFrameShapeUtil, ...componentShapeUtils];

// Comment mode (C) and Show comments (Shift+C), as in Figma. See canvas/src/comments.
// Stamp tool: standard reactions on shapes that reach the frame's agent (components/stamp).
const tools = [CommentTool, StampTool, PortalTool];
const uiOverrides: TLUiOverrides = {
  tools(editor, t) {
    t[COMMENT_TOOL] = { id: COMMENT_TOOL, label: "Comment", icon: <CommentToolIcon />, kbd: "c", readonlyOk: true, onSelect: () => editor.setCurrentTool(COMMENT_TOOL) };
    // Make a portal from the selected sticky to a shape or an area (portals/PortalTool.tsx).
    t[PORTAL_TOOL] = { id: PORTAL_TOOL, label: "Portal", icon: <PortalToolIcon />, onSelect: () => editor.setCurrentTool(PORTAL_TOOL) };
    return t;
  },
  actions(_editor, a) {
    a["toggle-comments"] = { id: "toggle-comments", label: "Show comments", kbd: "shift+c", readonlyOk: true, onSelect: () => setShowPins(!showPins.get()) };
    return a;
  },
};

function BoardToolbar() {
  return (
    <DefaultToolbar>
      <TldrawUiMenuToolItem toolId={COMMENT_TOOL} />
      <StampToolButton />
      <WidgetTrayButton />
      {/* tldraw's tools, with Portal next to Arrow (the toolbar shows nine items on a
          desktop width; the rest, Text and Sticky included, are under its ^ menu). */}
      <SelectToolbarItem />
      <HandToolbarItem />
      <DrawToolbarItem />
      <EraserToolbarItem />
      <ArrowToolbarItem />
      <TldrawUiMenuToolItem toolId={PORTAL_TOOL} />
      <TextToolbarItem />
      <NoteToolbarItem />
      <AssetToolbarItem />
      <RectangleToolbarItem />
      <EllipseToolbarItem />
      <TriangleToolbarItem />
      <DiamondToolbarItem />
      <HexagonToolbarItem />
      <OvalToolbarItem />
      <RhombusToolbarItem />
      <StarToolbarItem />
      <CloudToolbarItem />
      <HeartToolbarItem />
      <XBoxToolbarItem />
      <CheckBoxToolbarItem />
      <ArrowLeftToolbarItem />
      <ArrowUpToolbarItem />
      <ArrowDownToolbarItem />
      <ArrowRightToolbarItem />
      <LineToolbarItem />
      <HighlightToolbarItem />
      <LaserToolbarItem />
      <FrameToolbarItem />
    </DefaultToolbar>
  );
}

// Interactions that move, resize or rotate shapes and do not end on a pinch's interrupt.
const PINCH_CANCELS = ["select.translating", "select.resizing", "select.rotating", "select.dragging_handle", "select.scribble_brushing", "select.crop.cropping", "select.crop.translating_crop"];

// Proof counter (window.__pinchResets): pinches ended by the next one-finger touch.
let pinchResets = 0;
(window as unknown as { __pinchResets: () => number }).__pinchResets = () => pinchResets;

export function stuckInteraction(editor: Editor): boolean {
  const path = editor.getPath();
  return PINCH_CANCELS.some((p) => path === p || path.startsWith(`${p}.`));
}

const browserStorage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};
const SidebarCtx = createContext<{ open(frameId: string): void; current: string | null }>({ open() {}, current: null });

// Mounted when the context menu opens (right click, or a long press on touch, where no
// contextmenu event reaches the page): the pointer is still where the menu was opened.
function CapturePoint() {
  const editor = useEditor();
  const ui = useContext(BoardUiCtx);
  useEffect(() => {
    ui.setContextPoint(editor.inputs.getCurrentPagePoint().toJson());
  }, [editor, ui]);
  return null;
}

// Mounted when the context menu opens: the frame(s) to archive are fixed then, from the
// pointer (anywhere on a frame, a shape inside it, or its label) or a frame selection, so
// moving over the menu does not change them.
function ArchiveFrameItem() {
  const archive = useContext(ArchiveCtx);
  const editor = useEditor();
  const [frames] = useState(() => archiveTargets(editor, editor.inputs.getCurrentPagePoint()));
  if (!frames.length) return null;
  const name = frames.length === 1 ? (editor.getShape(frames[0]) as TLFrameShape | undefined)?.props.name : "";
  return <TldrawUiMenuItem id="paseo-archive-frames" label={frames.length === 1 ? `Archive frame${name ? ` “${name.length > 28 ? `${name.slice(0, 27)}…` : name}”` : ""}` : `Archive ${frames.length} frames`} onSelect={() => archive.archive(frames)} />;
}

// "Fork conversation to new frame": one bound frame under the pointer (frame-fork.ts on the server).
function ForkFrameItem() {
  const editor = useEditor();
  const { addToast } = useToasts();
  const [frame] = useState(() => {
    const ids = archiveTargets(editor, editor.inputs.getCurrentPagePoint());
    const f = ids.length === 1 ? editor.getShape(ids[0]) : undefined;
    const p = (f?.meta as { paseo?: { agentId?: string; request?: unknown; host?: string } } | undefined)?.paseo;
    return f && p?.agentId && !p.request && !p.host ? f.id : null;
  });
  if (!frame) return null;
  const fork = () =>
    api(`/api/ui/boards/${encodeURIComponent(params().boardId)}/frames/${encodeURIComponent(frame)}/fork`, { method: "POST", body: "{}" })
      .then(() => addToast({ title: "Forked into a new frame beside this one" }))
      .catch((e: Error) => addToast({ title: `Fork failed: ${e.message}`, severity: "warning" }));
  return <TldrawUiMenuItem id="bunny-fork-frame" label="Fork conversation to new frame" onSelect={() => void fork()} />;
}

// "Move to page": the same frame(s) Archive acts on, to another page or a new one. Stays on
// this page (a toast offers the jump), so a page can be sorted out frame after frame.
function MoveFramesToPageItem() {
  const editor = useEditor();
  const { addToast } = useToasts();
  const [frames] = useState(() => archiveTargets(editor, editor.inputs.getCurrentPagePoint()));
  if (!frames.length) return null;
  const here = editor.getAncestorPageId(frames[0]);
  const pages = editor.getPages().filter((p) => p.id !== here);
  const move = (pageId: TLPageId) => {
    const r = moveFramesToPage(editor, frames, pageId);
    const name = editor.getPage(pageId)?.name ?? "the page";
    if (!r.ok) addToast({ title: r.reason, severity: "warning" });
    else addToast({ title: `Moved ${r.moved.length === 1 ? "frame" : `${r.moved.length} frames`} to “${name}”`, actions: [{ label: "Go there", type: "primary", onClick: () => showMoved(editor, pageId, r.moved) }] });
  };
  return (
    <TldrawUiMenuSubmenu id="bunny-move-to-page" label={frames.length === 1 ? "Move frame to page" : `Move ${frames.length} frames to page`}>
      <TldrawUiMenuGroup id="bunny-move-to-page-pages">
        {pages.map((p) => (
          <TldrawUiMenuItem key={p.id} id={`bunny-move-to-${p.id}`} label={p.name} onSelect={() => move(p.id)} />
        ))}
      </TldrawUiMenuGroup>
      <TldrawUiMenuGroup id="bunny-move-to-page-new">
        <TldrawUiMenuItem id="bunny-move-to-new-page" label="New page" onSelect={() => move(newPage(editor))} />
      </TldrawUiMenuGroup>
    </TldrawUiMenuSubmenu>
  );
}

// tldraw's default context menu, without its own "Move to page" when the menu is about frames:
// "Move frame to page" above (MoveFramesToPageItem) does that, staying on this page and finding
// the frames room. Other shapes (a loose sticky) keep tldraw's.
function BoardContextMenuContent() {
  const editor = useEditor();
  const showCollaborationUi = useShowCollaborationUi();
  const [frames] = useState(() => archiveTargets(editor, editor.inputs.getCurrentPagePoint()).length > 0);
  const multiPage = useValue("bunny-multi-page", () => editor.options.maxPages > 1, [editor]);
  return (
    <>
      {showCollaborationUi ? <CursorChatItem /> : null}
      <TldrawUiMenuGroup id="modify">
        <EditMenuSubmenu />
        <ArrangeMenuSubmenu />
        <ReorderMenuSubmenu />
        {multiPage && !frames ? <MoveToPageMenu /> : null}
      </TldrawUiMenuGroup>
      <ClipboardMenuGroup />
      <ConversionsMenuGroup />
      <TldrawUiMenuGroup id="select-all">
        <SelectAllMenuItem />
      </TldrawUiMenuGroup>
    </>
  );
}

function BoardContextMenu(props: TLUiContextMenuProps) {
  const ui = useContext(BoardUiCtx);
  return (
    <DefaultContextMenu {...props}>
      <TldrawUiMenuGroup id="bunny">
        <CapturePoint />
        <PortalMenuItems />
        <ForkFrameItem />
        <MoveFramesToPageItem />
        <ArchiveFrameItem />
        <TldrawUiMenuItem id="paseo-import-here" label="Import conversations here" onSelect={() => ui.openPicker({ kind: "grid", at: ui.contextPoint() })} />
      </TldrawUiMenuGroup>
      <BoardContextMenuContent />
    </DefaultContextMenu>
  );
}

// Pin / Unpin in a frame peek's title chip (Portals.tsx).
function PeekPin({ editor, boardId, frameId }: { editor: Editor; boardId: string; frameId: string }) {
  const [pins, toggle] = usePins(editor, boardId);
  const pinned = pins.includes(frameId);
  const full = !pinned && pins.length >= PIN_LIMIT;
  return (
    <button type="button" role="menuitem" data-testid="peek-pin" aria-pressed={pinned} title={pinned ? "Unpin this frame" : full ? `Pin (replaces your least used of ${PIN_LIMIT} pins)` : "Pin this frame (on every device)"} onClick={() => toggle(frameId)}>
      {pinned ? "Unpin from tabs" : "Pin to tabs"}
    </button>
  );
}

// A frame peek's conversation pane: unfolded (bunny-peek-chat, on by default) and widened for
// reading (bunny-peek-chat-wide, off by default), remembered on this device.
function useStoredFlag(key: string, fallback: boolean): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  });
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        /* the choice lasts until reload */
      }
    },
    [key],
  );
  return [on, set];
}
const usePeekChat = () => useStoredFlag("bunny-peek-chat", true);
const usePeekChatWide = () => useStoredFlag("bunny-peek-chat-wide", false);

function Overlay({ boardId, focusFrame }: { boardId: string; focusFrame: string | null }) {
  const editor = useEditor();
  const sidebar = useContext(SidebarCtx);
  const ui = useContext(BoardUiCtx);
  const mobile = useContext(MobileCtx);
  const portalRift = useMemo(() => ({ shapeUtils }), []);
  const selected = useValue("selection", () => editor.getOnlySelectedShape(), [editor]);
  const hoverAgent=useValue('hover-connect-agent',()=>{
    const shape=editor.getHoveredShape();
    if(shape?.type==='transcript')return String((shape.props as {agentId?:string}).agentId??'');
    const meta=shape?conversationFrameOf(editor,shape)?.meta?.paseo as {agentId?:string}|undefined:undefined;
    return meta?.agentId??'';
  },[editor]);
  useEffect(()=>{if(hoverAgent)agentStore.prefetch(hoverAgent);},[hoverAgent]);
  const [dock] = usePanelDock();
  const history = useContext(HistoryCtx);
  const bound = useValue("bound-of-selection", () => (selected ? conversationFrameOf(editor, selected) : null), [editor, selected]);
  // A selected frame without an agent gets its frame panel (Start conversation; floating near
  // it, or docked bottom-right). A frame with an agent has everything in its conversation's
  // ⋯ menu (FrameActions.tsx) instead.
  // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
  const selectedPaseo = selected?.type === "frame" ? (selected.meta as any)?.paseo : null;
  const selectedFrame = selected?.type === "frame" && !(selectedPaseo?.agentId && !selectedPaseo?.request) ? (selected as TLFrameShape) : null;
  // A frame peek: Pin and (for a frame with an agent) Chat in its title chip, and the
  // agent's conversation in a pane beside the frame, to reply without going there.
  const [peekChat, setPeekChat] = usePeekChat();
  const [peekChatWide, setPeekChatWide] = usePeekChatWide();
  const peekId = useValue(framePeek);
  const peekBound = useValue(
    "peek-bound",
    () => {
      // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
      const p = peekId ? (editor.getShape(peekId as TLShapeId)?.meta as any)?.paseo : null;
      return !!(p?.agentId || p?.request);
    },
    [editor, peekId],
  );
  const peekExtra = useCallback(
    (id: string) => (
      <>
        <PeekPin editor={editor} boardId={boardId} frameId={id} />
        <button type="button" role="menuitem" data-testid="peek-pin-screen" title="Keep a small window on this frame while you work elsewhere (its pill is at the bottom)" onClick={() => pinToScreen(editor, id, ui.toast)}>
          Pin to screen
        </button>
      </>
    ),
    [editor, boardId, ui],
  );
  // When the main sidebar already shows the peeked frame's conversation, the peek's copy
  // starts folded (no duplicate by default) but its strip is always there to open it; that
  // choice lasts for this peek only.
  const peekDup = !!peekId && sidebar.current === peekId;
  const [dupOpen, setDupOpen] = useState(false);
  useEffect(() => setDupOpen(false), [peekId]);
  const peekChatShown = peekDup ? dupOpen : peekChat;
  const togglePeekChat = useCallback(() => (peekDup ? setDupOpen((o) => !o) : setPeekChat(!peekChat)), [peekDup, peekChat, setPeekChat]);
  // A screen window's conversation (Portals.tsx folds it into a strip until opened).
  // ⛶ in the embedded conversation widens it to 3/4 of the window (as the main sidebar's ⛶ does).
  const windowConversation = useCallback(
    (id: string, wide: boolean, setWide: (wide: boolean) => void) => <Sidebar key={id} embedded editor={editor} frameId={id} boardId={boardId} reading={wide} onReadingChange={setWide} onClose={() => updateScreenPin(id, { chat: false })} />,
    [editor, boardId],
  );
  const peekSide = useCallback(
    (id: string) => (peekBound ? <Sidebar key={id} embedded editor={editor} frameId={id} boardId={boardId} reading={peekChatWide} onReadingChange={setPeekChatWide} onClose={() => (sidebar.current === id ? setDupOpen(false) : setPeekChat(false))} /> : null),
    [editor, boardId, peekBound, setPeekChat, sidebar.current, peekChatWide, setPeekChatWide],
  );

  // The nearest frame owns the selection, including an unbound nested frame.
  // Never leave its ancestor conversation in the sidebar.
  // On the phone shell an empty frame shows its frame panel (Start conversation) alone.
  // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
  const boundPaseo = (bound?.meta as any)?.paseo;
  const threadable = !mobile || !!(boundPaseo?.agentId || boundPaseo?.request);
  // The phone shell opens threads itself (thread peek, need-you pill, Follow agent).
  useEffect(() => {
    if (bound && !mobile) sidebar.open(bound.id);
  }, [bound?.id, sidebar.open, mobile]);

  // Deep link: select and zoom to ?frame= once it exists in the store.
  useEffect(() => {
    if (!focusFrame) return;
    let done = false;
    const tryFocus = () => {
      if (done) return;
      const s = editor.getShape(focusFrame as TLShapeId);
      if (!s) return;
      done = true;
      editor.select(s.id);
      editor.zoomToSelection({ animation: { duration: 300 } });
    };
    tryFocus();
    return editor.store.listen(tryFocus, { scope: "document" });
  }, [editor, focusFrame]);

  return (
    <>
      <Comments editor={editor} />
      <PausedBadges editor={editor} />
      <FrameCompression editor={editor} boardId={boardId} />
      <ChannelLayer editor={editor}>
        <Channels editor={editor} boardId={boardId} />
        <LinkChannels editor={editor} boardId={boardId} />
      </ChannelLayer>
      <ReviewRegions editor={editor} />
      <Portals editor={editor} toast={ui.toast} rift={portalRift} peekExtra={peekExtra} peekSide={peekSide} peekChatOpen={peekChatShown} onPeekChat={togglePeekChat} peekChatWide={peekChatWide} boardId={mobile ? undefined : boardId} conversation={windowConversation} />
      <ProposalBanner editor={editor} />
      <EmptyBoardHint editor={editor} />
      {mobile ? (
        // Phone shell: the thread sheet is the bound frame's panel; empty frames keep theirs.
        selectedFrame && !threadable ? <FramePanel frame={selectedFrame} boardId={boardId} onOpen={() => sidebar.open(selectedFrame.id)} /> : null
      ) : (
      <>
      {selectedFrame && dock === "float" ? <FramePanel frame={selectedFrame} boardId={boardId} onOpen={() => sidebar.open(selectedFrame.id)} /> : null}
      {/* Bottom dock: the docked panel (or its pill) for the selected frame. Pinned frames
          live in the frame tabs (FrameTabs.tsx). */}
      <DockRow>
        {dock === "float" || !selectedFrame ? null : <FramePanel frame={selectedFrame} boardId={boardId} onOpen={() => sidebar.open(selectedFrame.id)} />}
        <ScreenPills editor={editor} />
      </DockRow>
      </>
      )}
      {history.frameId ? <FrameHistoryView key={history.frameId} editor={editor} boardId={boardId} frameId={history.frameId} shapeUtils={shapeUtils} /> : null}
    </>
  );
}

export function App() {
  const { boardId, frameId } = useMemo(params, []);
  const { userId, userName } = useMemo(identity, []);
  // `components` lets the server refuse canvases older than its board components.
  const uri = `${window.location.origin.replace(/^http/, "ws")}/api/connect/${encodeURIComponent(boardId)}?userId=${encodeURIComponent(userId)}&userName=${encodeURIComponent(userName)}&components=${COMPONENTS_VERSION}`;
  const store = useBoardSync({ uri, assets, shapeUtils, boardId });
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [toast, setToast] = useState<{ text: string; action?: { label: string; run(): void } } | null>(null);
  const toastText = toast?.text ?? null;
  const setToastText = useCallback((text: string | null) => setToast(text === null ? null : { text }), []);
  const contextPointRef = useRef<{ x: number; y: number } | null>(null);
  const phone = useNarrow();
  const mobile = useMobileShell();
  const components = useMemo(
    () => ({
      InFrontOfTheCanvas: () => <Overlay boardId={boardId} focusFrame={frameId} />,
      SharePanel: () => <BoardHeader boardId={boardId} onImport={() => setPicker({ kind: "grid", at: null })} />,
      ContextMenu: BoardContextMenu,
      Toolbar: BoardToolbar,
      StylePanel: BoardStylePanel,
      ...(mobile ? { Canvas: PhoneCanvas } : { MenuPanel: MenuPanelWithNewAgent }),
    }),
    [boardId, frameId, mobile],
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const editorRef = useRef<Editor | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.action ? 10000 : 7000);
    return () => clearTimeout(t);
  }, [toast]);
  const boardUi = useMemo(
    () => ({
      openPicker: (t: PickerTarget) => setPicker(t),
      contextPoint: () => contextPointRef.current,
      setContextPoint: (p: { x: number; y: number }) => {
        contextPointRef.current = p;
      },
      toast: (text: string, action?: { label: string; run(): void }) => setToast({ text, action }),
      openConversation: (id: string) => setSidebarFrame(id),
    }),
    [],
  );
  // Bound frames this tab deleted: ask whether to archive their agents.
  const [released, setReleased] = useState<ReleasedAgent[]>([]);
  // Zoom to frames the server just created, once they reach this tab.
  const focusFrames = useCallback((ids: string[], openSidebar: boolean) => {
    const ed = editorRef.current;
    if (!ed || !ids.length) return;
    let done = false;
    let stopListen: () => void = () => undefined;
    const tryFocus = () => {
      if (done) return;
      const bounds = ids.map((id) => ed.getShapePageBounds(id as TLShapeId)).filter((b): b is Box => !!b);
      if (bounds.length < ids.length) return;
      done = true;
      stopListen();
      ed.select(...(ids as TLShapeId[]));
      ed.zoomToBounds(Box.Common(bounds), { animation: { duration: 300 }, inset: 80 });
      if (openSidebar) setSidebarFrame(ids[0]);
    };
    stopListen = ed.store.listen(tryFocus, { scope: "document" });
    tryFocus();
    setTimeout(() => stopListen(), 15000);
  }, []);
  const onImported = useCallback(
    (res: ImportResponse, target: PickerTarget) => {
      setPicker(null);
      const skipped = res.skipped.map((s) => `${s.reason}`);
      const made = res.created.length;
      setToastText(
        made
          ? `${target.kind === "frame" ? "Linked" : `Imported ${made} conversation${made === 1 ? "" : "s"}`}${skipped.length ? ` · skipped ${skipped.length}: ${[...new Set(skipped)].join(", ")}` : ""}`
          : `Nothing imported: ${[...new Set(skipped)].join(", ") || "no conversations"}`,
      );
      // The phone shell opens the (first) imported frame itself, on its page.
      if (made && mobile) askOpenFrame(res.created[0].frameId);
      else if (made) focusFrames(res.created.map((c) => c.frameId), made === 1);
      else {
        const here = res.skipped.find((s) => s.boardId === boardId && s.frameId);
        if (here?.frameId) focusFrames([here.frameId], true);
      }
    },
    [boardId, focusFrames, mobile],
  );
  // Sidebar drag handles and image files drop board components here (see components/registry.ts).
  const options = useMemo(
    () => ({
      // Phone: no font scan of every shape on the page before the first render (~90 ms at 4x
      // CPU under the tiles); a thumbnail export loads its own frame's fonts (LiveThumb.tsx).
      ...(mobile ? { maxFontsToLoadBeforeRender: 0 } : {}),
      experimental__onDropOnCanvas: ({ point, event }: { point: { x: number; y: number }; event: React.DragEvent }) =>
        editorRef.current ? (handleComponentDrop(editorRef.current, point, event) || handleImageDrop(editorRef.current, boardId, point, event, setToastText, setSidebarFrame)) : false,
    }),
    [],
  );
  // Desktop: the sidebar comes back after a reload as it was left (open or collapsed, and on
  // which conversation); SidebarToggle reopens the last conversation with one click.
  const [remembered] = useState(() => readSidebar(browserStorage(), boardId));
  const [sidebarFrame, setSidebarFrame] = useState<string | null>(frameId ?? (!mobile && remembered.open ? remembered.frame : null));
  // Opening a frame's conversation counts as looking at it (the frame tabs' Recent).
  useEffect(() => {
    if (sidebarFrame) noteViewed(boardId, userId, sidebarFrame);
  }, [boardId, userId, sidebarFrame]);
  const [reading, setReading] = useState(remembered.reading === true);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(remembered.width ?? null);
  const [lastSidebarFrame, setLastSidebarFrame] = useState<string | null>(frameId ?? remembered.frame);
  useEffect(() => {
    if (sidebarFrame) setLastSidebarFrame(sidebarFrame);
  }, [sidebarFrame]);
  useEffect(() => {
    if (!mobile) writeSidebar(browserStorage(), boardId, { frame: sidebarFrame ?? lastSidebarFrame, open: !!sidebarFrame, reading, ...(sidebarWidth !== null ? { width: sidebarWidth } : {}) });
  }, [boardId, mobile, sidebarFrame, lastSidebarFrame, reading, sidebarWidth]);
  // The frame whose History slider is open (FrameHistory.tsx); one at a time.
  const [historyFrame, setHistoryFrame] = useState<string | null>(null);
  // Tab title: the frame whose conversation is selected or open, then the board.
  const titleFrame = useValue(
    "tab-title-frame",
    () => {
      if (!editor) return null;
      const sel = editor.getOnlySelectedShape();
      const frame = (sel ? conversationFrameOf(editor, sel) : null) ?? (sidebarFrame ? editor.getShape(sidebarFrame as TLShapeId) : null);
      return frame?.type === "frame" ? frameTitleName(frame as TLFrameShape) : null;
    },
    [editor, sidebarFrame],
  );
  useEffect(() => {
    document.title = tabTitle(boardId, titleFrame);
  }, [boardId, titleFrame]);
  const historyApi = useMemo(() => ({ frameId: historyFrame, open: (id: string) => setHistoryFrame(id), close: () => setHistoryFrame(null) }), [historyFrame]);
  // `open` stays the same function; `current` (the frame shown) changes with it.
  const openSidebar = useCallback((id: string) => setSidebarFrame(id), []);
  const sidebarApi = useMemo(() => ({ open: openSidebar, current: sidebarFrame }), [openSidebar, sidebarFrame]);
  // The Archive panel (FrameArchive.tsx) takes the sidebar's place while open.
  const [archiveTab, setArchiveTab] = useState<ArchiveTab | null>(null);
  const archiveApi = useMemo(
    () => ({
      tab: archiveTab,
      open: (t: ArchiveTab = "archived") => setArchiveTab(t),
      close: () => setArchiveTab(null),
      archive: (ids: string[]) => {
        void archiveFrames(boardId, ids)
          .then((items) => {
            setSidebarFrame((cur) => (cur && ids.includes(cur) ? null : cur));
            setHistoryFrame((cur) => (cur && ids.includes(cur) ? null : cur));
            setToast({
              text: `Archived ${items.length === 1 ? `“${items[0].name}”` : `${items.length} frames`}`,
              action: {
                label: "Undo",
                run: () =>
                  void restoreArchived(boardId, items.map((i) => i.id))
                    .then((r) => setToast({ text: `Restored ${r.restored.length === 1 ? `“${r.restored[0].name}”` : `${r.restored.length} frames`}` }))
                    .catch((e) => setToast({ text: (e as Error).message })),
              },
            });
          })
          .catch((e) => setToast({ text: (e as Error).message }));
      },
    }),
    [archiveTab, boardId],
  );
  // Phone: the shell's first render (tiles) gets its own task after tldraw's mount, instead of
  // adding to it (one ~350 ms task at 4x CPU throttle became two shorter ones; bench/phone.ts).
  const [shellEditor, setShellEditor] = useState<Editor | null>(null);
  useEffect(() => {
    if (!editor) return;
    const t = setTimeout(() => setShellEditor(editor), 0);
    return () => clearTimeout(t);
  }, [editor]);
  // Remember this board and the frame open on it (places.ts: the home-screen app reopens it,
  // the phone shell offers a jump back to it from another board). On the phone the open frame
  // also goes in the URL, so an iOS reload after the app was evicted comes back to it.
  useEffect(() => {
    if (!editor) return;
    const name = (id: string | null) => (id ? (editor.getShape(id as TLShapeId) as TLFrameShape | undefined)?.props.name : undefined);
    if (!mobile) {
      rememberPlace(boardId, frameId, name(frameId));
      return;
    }
    // This board's frame from now on (set here, not while rendering: the App being replaced
    // for a board switch still watches it until its effects are cleaned up).
    phoneOpenFrame.set(frameId);
    return react("remember-place", () => {
      const id = phoneOpenFrame.get();
      if (id && !editor.getShape(id as TLShapeId)) return;
      rememberPlace(boardId, id, name(id));
      setFrameInUrl(id);
    });
  }, [editor, boardId, frameId, mobile]);
  const onMount = useCallback(
    (editor: Editor) => {
      markLaunch("bunny:editor");
      setEditor(editor);
      editorRef.current = editor;
      window.__editor = editor;
      window.__board = { boardId, userId, userName };
      const stopAnchorKeeper = installCommentAnchorKeeper(editor);
      // board_snapshot: draw a frame for its agent when the server asks (frameSnapshot.tsx).
      const stopSnapshots = installSnapshotResponder(editor, boardId, shapeUtils);
      // Agent edits arrive within a frame, not batched once a second (see syncRate.ts).
      const stopSyncRate = keepCollaborativeSyncRate(editor);
      editor.user.updateUserPreferences({ name: userName });
      void boardInfo().catch(() => undefined);
      // A pasted or dropped board deep link becomes a board link card; other URLs stay
      // bookmarks (tldraw's default).
      editor.registerExternalContentHandler("url", async (content) => {
        const origins = [window.location.origin, new URL(publicBaseNow()).origin];
        const hit = parseBoardUrl(content.url, origins);
        if (hit) {
          placeAt(editor, LINK_TYPE, linkDefaults(hit.board, hit.frameId, "") as never, content.point ?? editor.getViewportPageBounds().center);
          return;
        }
        return defaultHandleExternalUrlContent(editor, content, {
          toasts: {
            addToast: (t: { title?: string }) => {
              setToastText(t.title ?? "Could not make a bookmark for that link");
              return "";
            },
            removeToast: () => "",
            clearToasts: () => undefined,
            toasts: { get: () => [] },
          },
          msg: () => "Could not make a bookmark for that link",
        } as never);
      });
      // Two-finger gestures on a phone. tldraw interrupts the current interaction when a
      // pinch starts, but its translating, resizing, rotating and handle-dragging states
      // ignore the interrupt (tldraw 5.2.2). So a first finger that moved 6 px before
      // the second one landed left the editor in select.translating after the pinch, and
      // the next touch anywhere dragged that sticky and dropped it (reported 2026-10-27).
      // Cancel those interactions at the start and end of every pinch.
      const onPinch = (info: TLEventInfo) => {
        if (info.type !== "pinch" || (info.name !== "pinch_start" && info.name !== "pinch_end")) return;
        if (stuckInteraction(editor) || editor.isIn("select.brushing")) editor.cancel();
      };
      // Belt and braces: a new touch that finds the editor still translating (a pinch tldraw
      // never reported, a lost pointer_up) cancels that drag instead of continuing it. A
      // single pointer never sends pointer_down mid-translation.
      // Also, a one-finger touch that arrives while tldraw still thinks a pinch is on (its
      // pinch_end is scheduled on an animation frame and can lose the race with the next
      // touch) would be dropped, and the editor stuck: end that pinch first.
      let touches = 0;
      const countTouches = (e: TouchEvent) => {
        touches = e.touches.length;
      };
      for (const t of ["touchstart", "touchend", "touchcancel"]) window.addEventListener(t, countTouches as EventListener, { capture: true, passive: true });
      const onPointerDown = (info: TLEventInfo) => {
        if (info.type !== "pointer" || info.name !== "pointer_down") return;
        if (editor.inputs.getIsPinching() && touches < 2) {
          pinchResets++;
          (editor.inputs as unknown as { setIsPinching(v: boolean): void }).setIsPinching(false);
        }
        if (stuckInteraction(editor) || editor.isIn("select.brushing")) editor.cancel();
      };
      editor.on("event", onPinch);
      editor.on("before-event", onPointerDown);
      const stopPinchFix = () => {
        editor.off("event", onPinch);
        editor.off("before-event", onPointerDown);
        for (const t of ["touchstart", "touchend", "touchcancel"]) window.removeEventListener(t, countTouches as EventListener, { capture: true });
      };
      // Lock layout (board header): block moves, resizes and deletes before they leave the tab.
      initDeviceLock(boardId);
      // Backend must suppress measurement-only agent deltas before enabling globally.
      let measurementDisposed = false;
      let stopMeasurements = () => {};
      void boardInfo().then(info => {
        if (!measurementDisposed && info.capabilities?.textBoundsMeasurementsSafe === true && !phoneGeometryOn()) stopMeasurements = installTextBoundsMeasurements(editor);
      }).catch(() => undefined);
      const stopGuard = installLayoutGuard(editor, (what) => setToastText(what));
      // Keys typed right after a double-click, before the sticky's text box has focus, are
      // replayed instead of dropped (canvas/src/editKeyBuffer.ts).
      const stopEditKeys = installEditKeyBuffer(editor);
      // A double-clicked frame title keeps its name input focused (canvas/src/frameRename.ts).
      const stopFrameRename = installFrameRenameFocus(editor);
      const stopDelete = editor.sideEffects.registerAfterDeleteHandler("shape", (shape, source) => {
        // biome-ignore lint/suspicious/noExplicitAny: meta JSON.
        const p = (shape.meta as any)?.paseo;
        if (source !== "user" || shape.type !== "frame" || !p?.agentId) return;
        const agentId = String(p.agentId);
        // "Move to page" (moveFrames.ts, tldraw's own Move to) deletes the frame and puts it
        // back with the same id on the other page in one go: that frame was moved, not deleted.
        setTimeout(() => {
          if (editor.getShape(shape.id)) return;
          const title = agentStore.get(agentId)?.title || (shape as TLFrameShape).props.name || agentId.slice(0, 8);
          setReleased((list) => (list.some((a) => a.agentId === agentId) ? list : [...list, { agentId, title, frameName: (shape as TLFrameShape).props.name }]));
          setSidebarFrame((cur) => (cur === shape.id ? null : cur));
        }, 0);
      });
      return () => {
        measurementDisposed = true;
        stopMeasurements();
        stopDelete();
        stopAnchorKeeper();
        stopSnapshots();
        stopSyncRate();
        stopPinchFix();
        stopGuard();
        stopEditKeys();
        stopFrameRename();
      };
    },
    [boardId, userId, userName],
  );
  // Phone: render nothing under the tiles from tldraw's very first render (mobile/visibility.ts);
  // MobileShell takes over once mounted.
  useState(() => {
    if (mobile) setPhoneView(frameId ? "frame" : "tiles", frameId, () => undefined);
    setPhoneGeometry(mobile);
    if (mobile) capPhonePixelRatio();
    return null;
  });
  return (
    <div style={{ position: "fixed", inset: 0, display: "flex", flexDirection: "column" }}>
      <HostRecoveryBanner boardId={boardId} editor={editor} />
      {editor ? <JumpPalette editor={editor} boardId={boardId} userId={userId} onFindConversations={() => setPicker({ kind: "grid", at: null })} /> : null}
      {/* "Connect to…" from a conversation's ⋯ menu: the ⌘K list over the frames it can be connected to. */}
      {editor ? <BoardUiCtx.Provider value={boardUi}><ConnectPicker editor={editor} boardId={boardId} userId={userId} mobile={mobile} /></BoardUiCtx.Provider> : null}
      <div style={{ flex: 1, minHeight: 0, display: "flex", position: "relative" }}>
      {editor && !mobile && !phone ? <BoardUiCtx.Provider value={boardUi}><Suspense fallback={null}><FrameTabs key={boardId} editor={editor} boardId={boardId} userId={userId} /></Suspense></BoardUiCtx.Provider> : null}
      <SidebarCtx.Provider value={sidebarApi}>
        <BoardUiCtx.Provider value={boardUi}>
        <HistoryCtx.Provider value={historyApi}>
        <ArchiveCtx.Provider value={archiveApi}>
          <MobileCtx.Provider value={mobile}>
          <div
            style={{ flex: 1, position: "relative", minWidth: 0 }}
            // Remember where the context menu was opened (right click or long press) for
            // "Import conversations here".
            onContextMenuCapture={(e) => {
              const ed = editorRef.current;
              if (ed) contextPointRef.current = ed.screenToPage({ x: e.clientX, y: e.clientY });
            }}
          >
            <Tldraw licenseKey={TLDRAW_LICENSE_KEY} store={store} shapeUtils={shapeUtils} tools={tools} overrides={uiOverrides} onMount={onMount} components={components} options={options} {...(mobile ? MOBILE_TLDRAW : {})} />
            {/* Inside the canvas column, so the bunny sits in the canvas corner, clear of the sidebar. */}
            {editor ? <OrganizerPopover editor={editor} boardId={boardId} /> : null}
            {editor && !mobile ? <SidebarToggle editor={editor} open={!!sidebarFrame} last={lastSidebarFrame} onCollapse={() => setSidebarFrame(null)} onRestore={(id) => setSidebarFrame(id)} /> : null}
            {shellEditor && mobile ? (
              // A shell error shows "Reload view" (and is reported) instead of blanking the page.
              <ShellErrorBoundary onReset={() => setSidebarFrame(null)}>
                <MobileShell editor={shellEditor} boardId={boardId} userId={userId} initialFrame={frameId} threadOpen={!!sidebarFrame} openThread={(id) => setSidebarFrame(id)} closeThread={() => setSidebarFrame(null)} importConversations={() => setPicker({ kind: "grid", at: null })} />
              </ShellErrorBoundary>
            ) : null}
          </div>
          </MobileCtx.Provider>
        </ArchiveCtx.Provider>
        </HistoryCtx.Provider>
        </BoardUiCtx.Provider>
      </SidebarCtx.Provider>
      {editor && archiveTab ? (
        <BoardUiCtx.Provider value={boardUi}>
          <ArchiveCtx.Provider value={archiveApi}>
            <ArchivePanel editor={editor} boardId={boardId} shapeUtils={shapeUtils} sheet={phone} />
          </ArchiveCtx.Provider>
        </BoardUiCtx.Provider>
      ) : released.length ? (
        <ReleasedPrompt agents={released} onDone={(id) => setReleased((list) => list.filter((a) => a.agentId !== id))} />
      ) : editor && sidebarFrame ? (
        // The board's contexts reach the sidebar too (its ⋯ menu toasts, opens history, archives).
        <BoardUiCtx.Provider value={boardUi}>
          <HistoryCtx.Provider value={historyApi}>
            <ArchiveCtx.Provider value={archiveApi}>
              <MobileCtx.Provider value={mobile}>
                <Sidebar key={sidebarFrame} editor={editor} frameId={sidebarFrame} boardId={boardId} sheet={phone || mobile} mobile={mobile} reading={reading} onReadingChange={setReading} width={sidebarWidth} onWidthChange={setSidebarWidth} onClose={() => setSidebarFrame(null)} />
              </MobileCtx.Provider>
            </ArchiveCtx.Provider>
          </HistoryCtx.Provider>
        </BoardUiCtx.Provider>
      ) : null}
      {picker ? (
        <ImportPicker
          boardId={boardId}
          target={picker}
          onClose={() => setPicker(null)}
          onDone={(res) => onImported(res, picker)}
          measure={() => {
            // The canvas measures text and drawings; the server only estimates them.
            const ed = editorRef.current;
            if (!ed) return [];
            return ed
              .getCurrentPageShapes()
              .filter((s) => s.parentId === ed.getCurrentPageId())
              .map((s) => ed.getShapePageBounds(s))
              .filter((b): b is Box => !!b)
              .map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }));
          }}
          onShowFrame={(id) => {
            setPicker(null);
            focusFrames([id], true);
          }}
        />
      ) : null}
      <UploadProgress />
      {toastText ? (
        <div
          data-testid="board-toast"
          // Above the organizer's corner launcher (1150), so an action (Undo) is never covered.
          style={{ position: "fixed", bottom: 70, left: "50%", transform: "translateX(-50%)", background: "#222", color: "#fff", padding: "8px 14px", borderRadius: 8, font: "13px system-ui, sans-serif", zIndex: 1160, maxWidth: "90vw" }}
        >
          {toastText}
          {toast?.action ? (
            <button
              type="button"
              data-testid="board-toast-action"
              onClick={() => {
                const run = toast.action!.run;
                setToast(null);
                run();
              }}
              style={{ marginLeft: 12, background: "none", border: "none", color: "light-dark(#74c0fc, hsl(206 88% 74%))", font: "600 13px system-ui, sans-serif", cursor: "pointer", padding: 0 }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
}
