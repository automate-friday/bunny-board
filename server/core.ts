import { BoardSnapshots } from "./board-snapshots";
import { configureRuntimeFiles, hasRemoteRuntimeFiles, requestRuntimeFiles } from "./runtime-files";
import { readFile } from "node:fs/promises";
import { timed } from "./perf";
import { bunnyEnv } from "./bunny-env";
import {hostMetrics} from './host-metrics';
import { PromptOutbox, promptLanding, turnBehavior } from "./prompt-outbox";
import { sendCapabilities, sendNow } from "../shared/send-capabilities";
// A remote agent's af-network status read older than this is not trusted to say idle.
const REMOTE_STATUS_FRESH_MS = 10_000;
import { withDaemonRead } from "./daemon-health";
import {resolveBoardName} from "./board-resolve";
import {FrameUploads} from "./frame-uploads";
import {readLocks} from "../shared/locks";
import { deferredStart } from "./deferred-start";
import { DirectoryRecordingSource } from './recording-watch';
import { ObsRecordingSource } from './video-source';
import path from 'node:path';
import { FrameChannels } from './frame-channels';
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { AgentApi } from "./agent-api";
import { CloudSessions, cloudCountChanged, defaultCloudRunner } from "./cloud-sessions";
import { claudeActivitySource } from "./widgets/claude-activity";
import { loadConfig } from "./config";
import { FrameWatcher } from "./frame-watcher";
import { FrameHistory } from "./frame-history";
import { FrameArchive } from "./frame-archive";
import { startHttp } from "./http";
import { loadBasicAuth } from "./basic-auth";
import { localDaemonUrl, PaseoBridge, statusOf } from "./paseo-bridge";
import { BoardHost } from "./room-host";
import { TranscriptHub } from "./transcripts";
import { SubagentTracker } from "./subagents";
import { addAgentRpc, agentLinkRpc, boardsRpc, bootstrapRpc, infoRpc } from "../shared/rpc";
import { AgentDirectory } from "./agent-directory";
import { BoardImporter, boardSummaries } from "./board-import";
import { migrateAssetOrigins } from "./room-host";
import { VideoWorkflow } from "./video-workflow";
import { RemoteAgents } from "./remote";
import { Organizer } from "./organizer";
import { resolvePluginDir } from "./plugin-dir";
import { PluginRegistry } from "./plugins";
import { defaultWidgetSources, WidgetHub } from "./widgets";
import { appSource, boardOrigins } from "./widgets/app/source";

// The live Mac checkout when it exists, else the repo root above this bundle (plugin-dir.ts).
const PLUGIN_DIR = resolvePluginDir(bunnyEnv("PLUGIN_DIR"), __dirname);
const PLUGIN_ID = bunnyEnv("PLUGIN_ID") ?? "board";
const DAEMON_WS = bunnyEnv("DAEMON_WS") ?? "ws://127.0.0.1:6767/ws";

const log = (m: string) => console.log(`[board] ${m}`);

export function contribute(server: PluginServerContext) {
  // First, before any state, timer or connection exists: a half-set BUNNYBOARD_AUTH_*
  // throws here, so the plugin contribution (or standalone process) fails to start
  // instead of running its background work behind a closed HTTP port.
  const auth = loadBasicAuth();
  const cfg = loadConfig(PLUGIN_DIR);
  configureRuntimeFiles();
  const metrics=hostMetrics(log,path.join(cfg.stateDir,"host-operations.jsonl"));
  const bridge = new PaseoBridge(PLUGIN_ID, DAEMON_WS, log, bunnyEnv("DAEMON_WS")?undefined:()=>localDaemonUrl(DAEMON_WS));
  const watcher = new FrameWatcher(cfg, bridge, log);
  const history = new FrameHistory(path.join(cfg.stateDir, "frame-history"), cfg, log);
  watcher.history = history;
  const archive = new FrameArchive(path.join(cfg.stateDir, "frame-archive"), history, log);
  watcher.archive = archive;
  let channels: FrameChannels | null = null;
  let cloud: CloudSessions | null = null;
  // Each part of the change listener is timed for /api/ui/debug/perf (change.*).
  const host = new BoardHost(cfg.boardsDir, (room, source, changes) => { timed("change.watcher", () => watcher.onChanges(room, source, changes)); timed("change.channels", () => channels?.changed(room.id, changes)); if (cloud && cloudCountChanged(changes)) timed("change.cloud-recount", () => cloud?.recount()); }, log,room=>watcher.detachBoard(room.id));
  watcher.attach(host);
  // Automatic board snapshots (every 10 min when changed, and before bulk deletes).
  const snapshots = new BoardSnapshots(path.join(cfg.stateDir, "snapshots"), host, cfg.boardsDir, log);
  snapshots.start();
  let uploads: FrameUploads | null = null;
  let wasConnected = false;
  let prompts: PromptOutbox | null = null;
  bridge.onHealth=()=>{watcher.onHostReady();void uploads?.drain();void prompts?.drain();transcripts.connectionChanged();const up=bridge.health().state==='connected';if(up&&!wasConnected)subagents.recheck(watcher.boundAgentIds());wasConnected=up;};
  const transcripts = new TranscriptHub(bridge, log);
  watcher.transcripts = transcripts;
  // Background subagents keep a finished-looking parent shown as working.
  const subagents = new SubagentTracker(bridge, (id, n) => {
    watcher.setSubagents(id, n);
    transcripts.setSubagents(id, n);
  }, log, id=>transcripts.isWatched(id)&&transcripts.summary(id)?.availability!=='not-loaded', id=>watcher.remoteHostOf(id) || transcripts.remote?.isRemote(id) || null);
  watcher.onBind = (id) => subagents.check(id);
  watcher.subagentCount = (id) => subagents.running(id);
  // ponytail: only agents the board shows; turn events arrive for every daemon agent.
  const checkShown = (id: string) => { if (transcripts.isWatched(id)) subagents.check(id); };
  transcripts.onWatch = (id) => subagents.check(id);
  transcripts.onUnwatch=id=>{subagents.unwatch(id);remote?.unwatchView(id);};
  transcripts.onStatus = (id) => checkShown(id);
  const agentApi = new AgentApi(cfg, watcher, log, bridge);
  // Cloud session cards (bin/cloud-task start pins them): status from GitHub and the builder.
  cloud = new CloudSessions(host, defaultCloudRunner(path.dirname(path.dirname(cfg.mcpEntry))), log, (b, f) => watcher.cloudChanged(b, f));
  agentApi.cloudSessions = cloud;
  watcher.cloudCount = (b, f) => cloud?.activeIn(b, f) ?? 0;
  const widgets = new WidgetHub(defaultWidgetSources([claudeActivitySource(cloud), appSource({ boardOrigins: boardOrigins(cfg.publicBase) })]), log);
  widgets.plugins = PluginRegistry.inStateDir(cfg.stateDir, log);
  watcher.widgets = widgets;
  agentApi.widgets = widgets;
  const directory = new AgentDirectory(bridge, log);
  // Agents on the user's other Macs (af-network); off with config remoteAgents:false.
  const remote = cfg.remoteAgents ? new RemoteAgents(log) : null;
  if (remote?.enabled) {
    remote.visible=id=>transcripts.isWatched(id);
    watcher.remote = remote;
    transcripts.remote = remote;
    remote.onSnapshot = (id, snap) => transcripts.pushRemote(id, snap);
    remote.onStatus = (id, status) => watcher.onRemoteStatus(id, status);
  }
  channels = new FrameChannels(path.join(cfg.stateDir,'frame-channels'), id => host.peek(id), async (board,frame,agentId,text) => {
    const target=host.get(board).records.get(frame);
    if(target?.meta?.paseo?.agentId!==agentId) return 'unknown';
    if(target.meta.paseo.host) return (await watcher.promptRemote(agentId,text)).delivery==='accepted_by_paseo'?'accepted':'unknown';
    if(!bridge.api) throw new Error('Paseo not connected');
    await bridge.api.agents.ref(agentId).send(text);return 'accepted';
  });
  prompts = new PromptOutbox(path.join(cfg.stateDir, "prompt-outbox"), r => {
    const ref = watcher.boundRef(r.agentId);
    const binding=host.peek(r.boardId)?.get(r.frameId)?.meta?.paseo;
    return binding?.agentId===r.agentId && (binding.host??null)===r.host && ref?.boardId === r.boardId && ref.frameId === r.frameId;
  }, r => {
    if(!watcher.isBoundAgent(r.agentId))return false;
    if(r.kind==='delta' && readLocks(host.peek(r.boardId)?.get('document:document')?.meta).agentsPaused)return false;
    // The board's own daemon socket is all a send needs. Board health also waits for the
    // plugin API, whose bootstrap RPC times out on a busy daemon: sidebar sends then sat
    // queued for good while the Paseo app, on its own socket, still worked.
    return r.host ? !!remote?.enabled : bridge.aux?.isConnected === true;
  }, async (r, wireId) => {
    if (r.host) {
      const receipt = await remote!.send(r.host, r.agentId, {reason:"Board prompt",workRef:`bunny/${r.boardId}/${r.frameId}`,returnTo:`board ${watcher.deepLink(r.boardId,r.frameId)}`,message:r.text,messageId:wireId});
      if(receipt.delivery !== "accepted_by_paseo") throw Error("Remote message delivery unconfirmed");
    } else {
      if(!bridge.aux?.isConnected) throw Error("Paseo disconnected");
      const durable=bridge.aux.getLastServerInfoMessage()?.features?.agentRequestReceipts===true;
      // Steer, as the Paseo app does: a busy agent takes the message into its current
      // turn instead of having that turn cancelled (the daemon default is interrupt).
      // An urgent message (a stop stamp) interrupts: halting the turn is the point.
      try{await bridge.aux.sendMessage(r.agentId,r.text,{messageId:wireId,activeTurnBehavior:turnBehavior(r)});}
      catch(error){if(!durable)throw Error('Message delivery unconfirmed; host has no durable receipts');throw error;}
    }
    transcripts.poke(r.agentId);
  },log, (r,signal) => r.host ? Promise.resolve('unsupported' as const) : promptLanding(bridge,r,undefined,signal));
  // Before each send: would it cancel a busy agent's turn? Paseo replaces the turn when a
  // provider cannot steer, so those messages wait on the board until the agent is idle
  // (shared/send-capabilities.ts). Another Mac's agent waits for af-network's status read
  // to say idle; the read is refreshed on demand. Unknown status means hold.
  prompts.hold=async r=>{
    // A stop stamp halts the turn on purpose: never wait for it to end.
    if(r.urgent&&!r.host)return {wait:null,mode:'interrupt'};
    if(r.host){
      const caps=sendCapabilities({host:r.host});
      if(!remote?.enabled)return {wait:'waiting-host',mode:caps.midTurn};
      const snap=remote.snapshot(r.agentId);
      const polledAt=snap?.remote?.polledAt??0;
      const fresh=!!snap&&!snap.error&&!!polledAt&&Date.now()-polledAt<=REMOTE_STATUS_FRESH_MS;
      if(!fresh){remote.watchStatus(r.host,r.agentId);remote.prefetch(r.agentId);}
      const d=sendNow(caps,fresh?snap!.status==='running'||snap!.status==='needs-permission':null,r.text);
      return {wait:d.send?null:d.reason,mode:d.mode};
    }
    const aux=bridge.aux;if(!aux?.isConnected)return {wait:'waiting-host'};
    const agent=(await withDaemonRead(()=>aux.fetchAgent(r.agentId)))?.agent as {provider?:string;status?:string;activeTurn?:unknown}|undefined;
    if(!agent)return {wait:null}; // the send itself reports a missing agent
    const busy=agent.status==='running'||agent.status==='initializing'||!!agent.activeTurn;
    const d=sendNow(sendCapabilities({host:null,provider:agent.provider}),busy,r.text);
    return {wait:d.send?null:d.reason,mode:d.mode};
  };
  prompts.requireStart=true;
  transcripts.onTimeline=(agentId,item)=>{
    const wireId=item.clientMessageId??item.messageId;
    if(item.type==='user_message'&&typeof wireId==='string')prompts?.noteLanded(agentId,wireId);
  };
  watcher.promptOutbox = prompts;
  prompts.onChange = receipt => watcher.promptReceiptChanged(receipt);
  const organizer = new Organizer(cfg, host, watcher, bridge, log);
  const importer = new BoardImporter(cfg, host, watcher, directory, bridge, log, remote?.enabled ? remote : null);

  server.handle(bootstrapRpc, (_input, { paseo }) => {
    bridge.capture(paseo);
    return { ok: true };
  });
  server.handle(infoRpc, () => ({ publicBase: cfg.publicBase, port: cfg.port, boards: host.all().map((r) => r.id) }));
  server.handle(agentLinkRpc, async ({ agentId }, { paseo }) => {
    bridge.capture(paseo);
    const b = [...host.all()].flatMap((room) =>
      [...room.records.values()].filter((r) => r.type === "frame" && r.meta?.paseo?.agentId === agentId).map((r) => ({ boardId: room.id, frameId: r.id })),
    )[0];
    if (b) return { url: watcher.deepLink(b.boardId, b.frameId), ...b };
    const snap = await paseo.agents.ref(agentId).refresh().catch(() => null);
    const labels = (snap?.agent.labels ?? {}) as Record<string, string>;
    if (labels.board && labels.frame) return { url: watcher.deepLink(labels.board, labels.frame), boardId: labels.board, frameId: labels.frame };
    return { url: null, boardId: null, frameId: null };
  });

  server.handle(boardsRpc, () => ({
    boards: boardSummaries(host, cfg.publicBase).map(({ id, frames, boundFrames, lastActivityAt, url }) => ({ id, frames, boundFrames, lastActivityAt, url })),
  }));
  server.handle(addAgentRpc, async ({ agentId, boardId, requestId }, { paseo }) => {
    bridge.capture(paseo);
    // A picked board keeps its id (ids may have capitals); a typed name becomes one.
    const id = resolveBoardName(boardId,id=>host.exists(id),cfg.boardAliases).boardId;
    if (!BoardHost.validId(id)) throw new Error(`"${boardId}" is not a usable board name (letters, digits, - and _)`);
    const out = await importer.import(id, { agentIds: [agentId], requestId: requestId ?? null });
    const made = out.created[0];
    if (made) return { url: made.url, boardId: id, frameId: made.frameId, created: true, reason: null };
    const skip = out.skipped[0];
    return { url: out.url, boardId: skip?.boardId ?? id, frameId: skip?.frameId ?? null, created: false, reason: skip?.reason ?? "nothing imported" };
  });

  // Fallback injection for agents created elsewhere with FRAME_ID/BOARD_ID in env
  // (labels are not visible to this hook). Our own creations already carry mcpServers.
  server.before("agent.create", ({ request }, { paseo }) => {
    bridge.capture(paseo);
    const env = request.env ?? {};
    if (!env.FRAME_ID || !env.BOARD_ID || request.config.mcpServers?.board) return undefined;
    // Tokens name the agent, so the creator must choose the id and pass it in env.
    if (!env.BOARD_AGENT_ID) {
      log(`agent.create fallback: ${env.BOARD_ID}/${env.FRAME_ID} has no BOARD_AGENT_ID; not injecting`);
      return undefined;
    }
    log(`agent.create fallback: injecting board MCP for ${env.BOARD_ID}/${env.FRAME_ID}`);
    return {
      ...request,
      config: { ...request.config, mcpServers: { ...request.config.mcpServers, board: watcher.mcpServerFor(env.BOARD_ID, env.FRAME_ID, env.BOARD_AGENT_ID) } },
    };
  });

  server.on("agent.created", (_e, { paseo }) => { bridge.capture(paseo); directory.invalidate(); });

  server.on("agent.turn_started", (e, { paseo }) => {
    bridge.capture(paseo);
    watcher.onAgentEvent(e.agent.id, "running", false, "turn_started");
    watcher.onAgentTitle(e.agent.id, e.agent.title);
    directory.noteStatus(e.agent.id, "running");
    transcripts.setStatus(e.agent.id, "running");
    // ponytail: a watched card's status change also checks (onStatus); the tracker coalesces
    // the pair, and bound frames without an open card need this call.
    checkShown(e.agent.id);
  });
  server.on("agent.turn_ended", (e) => {
    const status = e.outcome.kind === "failed" ? "error" : "idle";
    watcher.onAgentEvent(e.agent.id, status, true, `turn_ended:${e.outcome.kind}`);
    watcher.onAgentTitle(e.agent.id, e.agent.title);
    directory.noteStatus(e.agent.id, status);
    transcripts.setStatus(e.agent.id, status);
    checkShown(e.agent.id);
  });
  server.on("agent.permission_requested", (e) => {
    watcher.onAgentEvent(e.agent.id, "needs-permission", false, "permission_requested");
    directory.noteStatus(e.agent.id, "needs-permission");
    transcripts.setStatus(e.agent.id, "needs-permission");
  });
  server.on("agent.permission_resolved", async (e, { paseo }) => {
    const snap = await paseo.agents.ref(e.agent.id).refresh().catch(() => null);
    watcher.onAgentEvent(e.agent.id, statusOf(snap?.agent), false, "permission_resolved");
    transcripts.setStatus(e.agent.id, statusOf(snap?.agent));
  });
  server.on("agent.archived", (e) => {
    watcher.onAgentEvent(e.agent.id, "archived", false, "archived");
    directory.invalidate();
    transcripts.setStatus(e.agent.id, "archived");
  });

  const video = cfg.videoIntake ? new VideoWorkflow(cfg, host, watcher, cfg.videoIntake.recordingsDir, cfg.videoIntake.boardId) : null;

  // Expensive persisted-room restoration must not consume the daemon plugin-init deadline.
  // The deferred task is fenced by unload; persisted rooms load before HTTP starts.

  const videoSource = video && cfg.videoIntake?.source==='directory' ? new DirectoryRecordingSource(path.join(cfg.stateDir,'recording-watch'),cfg.videoIntake.recordingsDir,video.ledger.list().filter(i=>i.status==='handled'||i.status==='skipped').map(i=>({path:i.path,sourceFingerprint:i.sourceFingerprint})),file=>video.intake(file),cfg.videoIntake.pollMs,cfg.videoIntake.settleMs,cfg.videoIntake.watchFrom,undefined,log) : video && cfg.videoIntake?.obsUrl ? new ObsRecordingSource(path.join(cfg.stateDir,'video-completions'),cfg.videoIntake.recordingsDir,cfg.videoIntake.obsUrl,process.env[cfg.videoIntake.obsPasswordEnv ?? 'BOARD_OBS_PASSWORD'] ?? '',file=>video.intake(file),log) : null;


  let httpServer: import("node:http").Server | null = null;
  let stopped = false;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  const cancelStartup = deferredStart(() => {
    video?.restore();
    const rooms = host.loadAll();
    for (const room of rooms) migrateAssetOrigins(room, cfg.publicBase, log);
    log(`loaded ${rooms.length} board(s): ${rooms.map((r) => r.id).join(", ") || "none"}`);
    uploads=new FrameUploads(path.join(cfg.stateDir,'frame-uploads'),r=>{
      const records=host.peek(r.boardId),frame=records?.get(r.frameId);
      if(!frame||frame.meta?.paseo?.agentId!==r.agentId||frame.meta?.paseo?.host)return 'gone';
      if(!bridge.aux?.isConnected||readLocks(records?.get('document:document')?.meta).agentsPaused)return 'wait';
      return 'ready';
    },async(r,text)=>{const api=bridge.api??bridge.readApi;if(!api)throw Error('Paseo disconnected');//0.10.2 forwards this supported wire option despite omitting it from its public SendOptions declaration.
      if(hasRemoteRuntimeFiles()){const remote=await requestRuntimeFiles({op:'upload',id:r.id,name:r.name,hash:r.hash,bytes:(await readFile(r.path)).toString('base64')});text=text.replace('Path on this host: '+JSON.stringify(r.path),'Path on this host: '+JSON.stringify(remote.path));}
      const options={messageId:r.id,activeTurnBehavior:'steer' as const};await api.agents.ref(r.agentId).send(text,options);});
    void startHttp({ cfg, host, watcher, agentApi, bridge, transcripts, directory, importer, video, videoSource, channels, uploads, prompts, organizer, widgets, cloud, remote: remote?.enabled ? remote : null, auth, snapshots, log })
      .then((s) => {
        if (stopped) s.close();
        else httpServer = s;
      })
      .catch((e) => log(`http failed to start: ${(e as Error).message}`));
    void bridge.start().then(() => {
      subagents.attach();
      // Bindings resumed before the daemon connection was up could not be listed yet.
      for (const id of watcher.boundAgentIds()) subagents.check(id);
    });
    directory.warm();
    const resuming=watcher.resume(rooms); // restores binding identities before its first await
    prompts?.reconcile();prompts?.start();
    statusTimer=setInterval(()=>void watcher.reconcileStatuses(),15000);statusTimer.unref();
    void resuming.catch((e) => log(`resume failed: ${(e as Error).stack}`));
    videoSource?.start();
    uploads.start();
    cloud?.start();
  }, e => log(`startup failed: ${e instanceof Error ? e.stack : String(e)}`));

  return async () => {
    stopped = true;
    cancelStartup();
    metrics.stop();
    log("stopping");
    cloud?.stop();
    videoSource?.stop();
    uploads?.stop();
    prompts?.stop();
    if (statusTimer) clearInterval(statusTimer);
    video?.stop();
    watcher.stop();
    history.stop();
    archive.stop();
    subagents.stop();
    remote?.stop();
    await transcripts.stop();
    organizer.stop();
    snapshots.stop();
    host.closeAll();
    widgets.closeAll();
    await new Promise<void>((resolve) => {
      if (!httpServer) return resolve();
      httpServer.closeAllConnections?.();
      httpServer.close(() => resolve());
    });
    await bridge.stop();
  };
}
