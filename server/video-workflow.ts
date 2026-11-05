// Recording-completed adapter. The ledger and board snapshot are saved before
// creating a processing agent; retries use deterministic identities throughout.
import { VideoLedger, type VideoItem } from './video-intake';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PaseoBridge } from './paseo-bridge';
import { baseShape, buildShape, nextIndex } from './records';
import type { BoardHost, BoardRoom } from './room-host';
import type { FrameWatcher } from './frame-watcher';
import type { BoardConfig } from './config';
import { gridSlots, topLevelBounds } from './layout';

export class VideoWorkflow {
  readonly ledger: VideoLedger;
  private stopped = false;
  stop() { this.stopped=true; this.ledger.stop(); }
  private running = new Map<string, Promise<VideoItem>>();
  constructor(private cfg: BoardConfig, private host: BoardHost, private watcher: FrameWatcher, recordings: string, board: string, transcribe?: (file: string, out: string) => Promise<string>) {
    this.ledger = new VideoLedger(path.join(cfg.stateDir, 'video-intake'), recordings, board, transcribe);
  }
  restore() {
    for (const item of this.ledger.list()) {
      if(item.status==='handled'||item.status==='skipped'||!this.host.exists(item.board))continue;
      for (const route of item.routes) if(route.delivery?.status==='sending') { route.delivery.status='unknown'; this.ledger.update(item.id,{routes:item.routes}); }
      this.show(item);
      if (item.status === 'queued' || item.status === 'transcribed') this.start(item.id);
    }
  }
  decide(id:string,decision:'approved'|'rejected',expectedReviewUrl:string) {
    const item=this.ledger.decide(id,decision,expectedReviewUrl); this.show(item); return item;
  }
  async deliver(id:string,routeId:string,board:string,frame:string,bridge:PaseoBridge) {
    const item=this.ledger.get(id); const route=item.routes.find(r=>r.id===routeId);
    if(!route) throw Object.assign(new Error('unknown feedback item'),{status:404});
    if(route.delivery) return route; // Includes unknown outcomes: never resend automatically.
    if(!this.host.exists(board)) throw new Error('target board does not exist');
    const target=this.host.get(board).records.get(frame); const agentId=target?.meta?.paseo?.agentId;
    if(!agentId || target?.type!=='frame') throw new Error('target must be an explicitly selected bound frame');
    if(agentId===this.host.get(item.board).records.get(item.frameId)?.meta?.paseo?.agentId) throw new Error('cannot route feedback to its processing agent');
    route.delivery={board,frame,agentId,operationId:randomUUID(),status:'sending'};
    this.ledger.update(id,{routes:item.routes});
    const text=`Feedback route ${route.id} from video intake ${id}. Intended owner: ${route.owner}. Source clip: ${route.sourceClip}. Requested acceptance: ${route.acceptance}. Operation ${route.delivery.operationId}. This is context for this frame; do not forward or resend it automatically.`;
    try {
      if(target.meta?.paseo?.host) {
        const receipt=await this.watcher.promptRemote(agentId,text);
        route.delivery.status=receipt.delivery==='accepted_by_paseo'?'accepted':'unknown';
      } else {
        if(!bridge.api) throw new Error('Paseo not connected');
        await bridge.api.agents.ref(agentId).send(text); route.delivery.status='accepted';
      }
    } catch { route.delivery.status='unknown'; }
    if(this.stopped)return route;
    this.ledger.update(id,{routes:item.routes}); this.show(item); return route;
  }
  async intake(file: string) {
    if(this.stopped)throw new Error('video intake stopped');
    const item = await this.ledger.register(file);
    if(this.stopped||item.status==='handled'||item.status==='skipped')return item;
    this.show(item);
    this.start(item.id);
    return item;
  }
  start(id: string) {
    if(this.stopped)return;
    const item=this.ledger.get(id);if(item.status==='handled'||item.status==='skipped')return; // Unknown IDs fail synchronously rather than rejecting in the background.
    void this.run(id).catch(e => { if(this.stopped)return; this.ledger.update(id, { status: 'failed', retryable: true, error: (e as Error).message }); this.show(this.ledger.get(id)); });
  }
  run(id: string): Promise<VideoItem> {
    const active = this.running.get(id); if (active) return active;
    const run = this.process(id).finally(() => this.running.delete(id));
    this.running.set(id,run); return run;
  }
  private async process(id: string) {
    const target=this.ledger.get(id);if(this.stopped||target.status==='handled'||target.status==='skipped')return target;
    this.show(target);
    if(!this.host.exists(target.board))return this.ledger.update(id,{status:'failed',retryable:true,error:'Video target board is archived or unavailable. Restore it, then retry this intake.'});
    const work = this.ledger.process(id);
    // process() starts on the next microtask; mirror the state once it has started.
    queueMicrotask(() => this.show(this.ledger.get(id)));
    const item = await work; if(this.stopped)return item; this.show(item);
    if (!item.transcript||item.status==='handled'||item.status==='skipped'||!this.host.exists(item.board)) return item;
    const room = this.host.get(item.board); const frame = room.records.get(item.frameId)!;
    if (!frame.meta?.paseo?.agentId || frame.meta?.paseo?.status === 'error') {
      // A UUID-shaped deterministic ID also covers an unknown create response.
      const h=item.id; const agentId=`${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
      room.write({ kind: 'server', reason: 'video-process' }, ops => {
        const cur = ops.get(item.frameId)!;
        ops.put({ ...cur, meta: { ...cur.meta, paseo: { ...cur.meta?.paseo, agentId, request: { kind: 'create', context: 'board', provider: 'codex/gpt-6.1-sol', requestedAt: Date.now(), prompt: this.prompt(item) }, status: 'requested' } } });
      }); room.save();
    }
    await this.watcher.fulfil(room, item.frameId);
    if(this.stopped)return this.ledger.get(id);
    const current=room.records.get(item.frameId);
    if (current?.meta?.paseo?.status === 'error') {
      this.ledger.update(id,{status:'failed',retryable:true,error:current.meta.paseo.error || 'Processing agent could not start; retry'});
      this.show(this.ledger.get(id));
    }
    return this.ledger.get(id);
  }
  private prompt(item: VideoItem) {
    return `Process completed recording ${path.basename(item.path)}. Intake ID ${item.id}. Plain transcript: ${item.transcript}. Timestamped transcript: ${item.timedTranscript??'unavailable; do not invent MM:SS'}. Original source: ${item.path}. Frozen media for extraction: ${path.join(path.dirname(item.transcript!),'source'+path.extname(item.path))}.\n` +
      `The backend already transcribed offline through the one shared sequential worker. Never run another transcription yourself; report missing timestamps visibly rather than guessing.\n` +
      `Call board_video({action:'children'}) FIRST. Exactly two child frames: Content approval and Feedback routing. Do not create any other frames or agents.\n` +
      `Use the manual intake brief: inspect this take and its timestamped transcript. List every actual feedback occurrence with MM:SS, a short exact quote or clearly labelled visual observation, requested acceptance, and source path. Mark silent spans; never infer speech. Distinguish Bugs, Workflow, and Content in THREE labelled columns inside the parent frame; leave header and child frames clear. Add a short Plan sticky with ordered item IDs and shared-root duplicates.\n` +
      `For each bug extract a relevant screenshot and a short source clip with ffmpeg at nice -n 10, one extraction at a time. Save under ${path.join(path.dirname(path.dirname(item.path)),'cuts',item.take===null?path.basename(item.path,path.extname(item.path)):path.basename(item.path).slice(0,10)+'-take_'+item.take)} in shots/ and bugs/, plus PLAN.md. Use board_add_artifact for screenshot/clip cards in this parent or its children. Existing media extraction only: do not render a new edited video. If a tool is unavailable, leave an explicit pending artifact, never pretend it exists.\n` +
      `Use Content approval for proposed content requiring the user's decision; never prewrite their conclusion or publish automatically. Use Feedback routing to record each actual item with board_video({action:'route',route:{id,owner,sourceClip,acceptance,receipt:'prepared-not-sent'}}). Keep source MM:SS and clip paths, never invent delivery. Content/feedback child IDs returned by board_video are stable across retry.\n` +
      `No repo rituals, backlog commands, product implementation, other agents, or unrelated investigation. Keep all board writes inside this parent and its two children. Stop after the three columns, bug evidence, Plan sticky and child summaries are posted.`;
  }
  show(item: VideoItem) {
    if(this.stopped||item.status==='handled'||item.status==='skipped')return;
    let room:BoardRoom;try{room=this.host.get(item.board);}catch(e){if((e as {status?:number}).status===410)return;throw e;} let frame = room.records.get(item.frameId);
    if (!frame) {
      const pageId=this.cfg.videoIntake?.pageId??room.pageId();
      if(room.records.get(pageId)?.typeName!=='page')throw new Error('configured video page does not exist');
      const bounds=topLevelBounds(room.records,pageId);const x=this.cfg.videoIntake?.columnX;
      const slot=x===undefined?gridSlots(bounds,1,undefined,{w:1800,h:2400})[0]:{x,y:Math.max(this.cfg.videoIntake?.startY??0,...bounds.filter(b=>b.x+b.w+60>x&&b.x<x+1860).map(b=>b.y+b.h+120))};
      frame = baseShape('frame', pageId, nextIndex(room.records, pageId), slot.x, slot.y, { w: 1800, h: 2400, name: `Video intake: ${path.basename(item.path)}`, color: 'violet' }, {});
      frame.id = item.frameId;
    }
    const msg = `${item.status === 'failed' ? `Failed (retryable): ${item.error}\nRetry: POST /api/ui/video-intake/${item.id}/retry` : `Intake ${item.status}`}\n${path.basename(item.path)}\nApproval: ${item.approval}\nTranscript: ${item.transcript ?? 'pending'}\nReview: ${item.reviewUrl ?? 'pending'}\nFeedback: ${item.routes.length} item(s) recorded`;
    const text = buildShape({ type: 'text', x: 20, y: 30, w: 1700, text: msg }, frame.id, 'a1',20,30, {author:{kind:'system',name:'Recording intake'}});
    text.id = `shape:video-state-${item.id.slice(0, 24)}`;
    room.write({ kind: 'server', reason: 'video-state' }, ops => {
      ops.put({ ...frame!, meta: { ...frame!.meta, videoIntake: { id: item.id, status: item.status, retryable: item.retryable, error: item.error, approval: item.approval, reviewUrl:item.reviewUrl } } }); ops.put(text);
    }); room.save();
  }
  itemFor(room: BoardRoom, frameId: string) {
    const item=this.ledger.list().find(i=>i.board===room.id && i.frameId===frameId);
    if (!item) throw Object.assign(new Error('not a video processing frame'),{status:409});
    return item;
  }
  children(room: BoardRoom, frameId: string) {
    const item = this.itemFor(room,frameId);
    if (!item.transcript) throw Object.assign(new Error('not a transcribed video processing frame'), { status: 409 });
    const agentId = room.records.get(frameId)?.meta?.paseo?.agentId;
    if (!agentId) throw new Error('processing frame is not bound');
    const specs = [{ id: item.children.content, x: 20, name: 'Content approval' }, { id: item.children.feedback, x: 910, name: 'Feedback routing' }];
    room.write({ kind: 'agent', agentId, frameId }, ops => {
      for (const [n,s] of specs.entries()) if (!ops.get(s.id)) {
        const child = baseShape('frame', frameId, `a${n+2}`, s.x, 1650, { w: 850, h: 700, name: s.name, color: 'black' }, { author: { kind: 'agent', agentId }, videoRole: s.name, intakeId: item.id }); child.id = s.id; ops.put(child);
      }
    }); room.save(); this.ledger.update(item.id, { status: 'ready',error:null,retryable:false }); this.show(this.ledger.get(item.id));
    return { id: item.id, children: item.children, approval: item.approval };
  }
  action(room:BoardRoom,frameId:string,body:Record<string,unknown>) {
    const item=this.itemFor(room,frameId);
    if(body.action==='children') return this.children(room,frameId);
    if(body.action==='review') this.ledger.setReview(item.id,String(body.url??''));
    else if(body.action==='route') this.ledger.route(item.id,body.route as VideoItem['routes'][number]);
    else if(body.action!=='read') throw new Error('expected children, review, route or read');
    this.show(this.ledger.get(item.id)); return this.ledger.get(item.id);
  }
}
