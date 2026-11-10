import { offlineTranscribe } from "./video-transcribe";
export { offlineTranscribe } from "./video-transcribe";
import { hasRemoteRuntimeFiles, requestRuntimeFiles } from "./runtime-files";
// Durable path+content identity. The ledger is committed before any external effect.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, copyFileSync, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export interface VideoItem {
  id: string; path: string; hash: string; take: number | null; board: string;
  frameId: string; children: { content: string; feedback: string };
  status: 'queued' | 'transcribing' | 'transcribed' | 'ready' | 'failed' | 'handled' | 'skipped';
  retryable: boolean; error: string | null; transcript: string | null;
  sourceFingerprint?:string; disposition?: string; timedTranscript?: string | null;
  approval: 'pending' | 'approved' | 'rejected'; reviewUrl: string | null;
  routes: Array<{ id: string; owner: string; sourceClip: string; acceptance: string; receipt: string; delivery?: { board: string; frame: string; agentId: string; operationId: string; status: 'sending' | 'accepted' | 'unknown' } }>;
  updatedAt: string;
}
export class VideoLedger {
  private items: Record<string, VideoItem>;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<VideoItem>>();
  private file: string;
  private stopped = false;
  stop() { this.stopped = true; }
  constructor(private dir: string, private recordings: string, private board: string, private transcribe: (file: string, out: string) => Promise<string> = offlineTranscribe) {
    mkdirSync(dir, { recursive: true }); this.file = path.join(dir, 'ledger.json');
    this.items = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
    for (const item of Object.values(this.items)) if (item.status === 'transcribing') Object.assign(item, { status: 'failed', retryable: true, error: 'Server stopped during transcription; retry this intake.' });
    this.save();
  }
  private save() { if(this.stopped)return; writeFileSync(`${this.file}.tmp`, JSON.stringify(this.items, null, 2)); renameSync(`${this.file}.tmp`, this.file); }
  list() { return Object.values(this.items); }
  get(id: string): VideoItem { const i = this.items[id]; if (!i) throw Object.assign(new Error('unknown video intake'), { status: 404 }); return i; }
  update(id: string, patch: Partial<VideoItem>) { if(this.stopped)throw new Error('video intake stopped'); const i = this.get(id); Object.assign(i, patch, { updatedAt: new Date().toISOString() }); this.save(); return i; }
  setReview(id: string, url: string) {
    if (!/^https?:\/\//.test(url)) throw new Error('review URL must be HTTP(S)');
    return this.update(id, { reviewUrl: url, approval: 'pending' });
  }
  decide(id: string, decision: 'approved' | 'rejected', expectedReviewUrl?: string) {
    if (!this.get(id).reviewUrl) throw new Error('prepare a review URL before deciding');
    if (expectedReviewUrl !== this.get(id).reviewUrl) throw Object.assign(new Error('review changed; reopen it before deciding'), {status:409});
    if (!['approved', 'rejected'].includes(decision)) throw new Error('invalid approval decision');
    return this.update(id, { approval: decision });
  }
  route(id: string, route: VideoItem['routes'][number]) {
    if (!route || typeof route !== 'object') throw new Error('route object required');
    for (const key of ['id', 'owner', 'sourceClip', 'acceptance', 'receipt'] as const)
      if (typeof route[key] !== 'string' || !route[key].trim() || route[key].length > 12000) throw new Error(`route ${key} is required (max 12000 characters)`);
    const item = this.get(id); const prior = item.routes.find(r => r.id === route.id);
    if (prior && ['id','owner','sourceClip','acceptance','receipt'].some(k => (prior as unknown as Record<string,unknown>)[k] !== (route as unknown as Record<string,unknown>)[k])) throw new Error('route ID already recorded with different content; reconcile receipt explicitly');
    if (!prior) this.update(id, { routes: [...item.routes, {id:route.id,owner:route.owner,sourceClip:route.sourceClip,acceptance:route.acceptance,receipt:route.receipt}] });
    return this.get(id);
  }
  async register(file: string, history?:{status:'handled'|'skipped';reason:string;transcript?:string}): Promise<VideoItem> {
    if(hasRemoteRuntimeFiles({op:'recordings'})) {
      const reply=await requestRuntimeFiles({op:'inspect-video',path:file});const v=reply.video;
      if(!v)throw new Error('Runtime did not return video identity');
      if(history?.transcript)throw new Error('Remote historical intake must be seeded from the verified migration ledger');
      if(!history&&/(?:^|[-_])take_12\./i.test(path.basename(v.path)))throw new Error('take_12 is owned by manual intake; excluded');
      if(this.stopped)throw new Error('video intake stopped');
      const prior=this.items[v.id];if(prior)return prior;
      const suffix=v.id.slice(0,28);
      const item:VideoItem={id:v.id,path:v.path,hash:v.hash,take:Number(path.basename(v.path).match(/take_(\d+)/)?.[1])||null,board:this.board,frameId:`shape:video-${suffix}`,children:{content:`shape:content-${suffix}`,feedback:`shape:feedback-${suffix}`},status:history?.status??'queued',sourceFingerprint:`${v.size}:${v.mtimeMs}`,disposition:history?.reason,retryable:false,error:null,transcript:null,approval:'pending',reviewUrl:null,routes:[],updatedAt:new Date().toISOString()};
      this.items[v.id]=item;this.save();return item;
    }
    const root = realpathSync(this.recordings); const resolved = realpathSync(file);
    if (!resolved.startsWith(root + path.sep) || !statSync(resolved).isFile() || !/\.(mp4|mov|mkv|webm)$/i.test(resolved)) throw new Error('expected a regular video inside configured recordings directory');
    if (!history && /(?:^|[-_])take_12\./i.test(path.basename(resolved))) throw new Error('take_12 is owned by manual intake; excluded');
    if(history?.transcript&&!existsSync(history.transcript))throw new Error('Historical transcript does not exist');
    const before = statSync(resolved); const hash = createHash('sha256');
    for await (const chunk of createReadStream(resolved)) hash.update(chunk);
    const after = statSync(resolved);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('recording is still changing; retry after OBS completes');
    if(this.stopped)throw new Error('video intake stopped; retry after reload');
    const digest = hash.digest('hex'); const id = createHash('sha256').update(resolved + '\0' + digest).digest('hex');
    if (this.items[id]) return history?this.update(id,{status:history.status,sourceFingerprint:`${after.size}:${after.mtimeMs}`,disposition:history.reason,transcript:history.transcript??null,retryable:false,error:null}):this.items[id];
    const suffix = id.slice(0, 28);
    const item: VideoItem = { id, path: resolved, hash: digest, take: Number(path.basename(resolved).match(/take_(\d+)/)?.[1]) || null, board: this.board, frameId: `shape:video-${suffix}`, children: { content: `shape:content-${suffix}`, feedback: `shape:feedback-${suffix}` }, status: history?.status??'queued', sourceFingerprint:`${after.size}:${after.mtimeMs}`, disposition:history?.reason, retryable: false, error: null, transcript: history?.transcript??null, approval: 'pending', reviewUrl: null, routes: [], updatedAt: new Date().toISOString() };
    this.items[id] = item; this.save(); return item;
  }
  process(id: string): Promise<VideoItem> {
    const pending = this.pending.get(id); if (pending) return pending;
    const run = this.tail.then(async () => {
      const i = this.get(id); if(this.stopped||i.status==='handled'||i.status==='skipped')return i; if (i.transcript && (hasRemoteRuntimeFiles({op:'recordings'}) || existsSync(i.transcript))) return i;
      this.update(id, { status: 'transcribing', retryable: false, error: null });
      try {
        if(hasRemoteRuntimeFiles({op:'recordings'})){
          const reply=await requestRuntimeFiles({op:'transcribe',path:i.path,hash:i.hash});const v=reply.video;
          if(this.stopped)return i;
          if(!v||v.id!==id||!v.transcript||!v.text?.trim())throw new Error('Runtime transcription result is incomplete');
          const out=path.join(this.dir,id);mkdirSync(out,{recursive:true});
          writeFileSync(path.join(out,'transcript.txt'),v.text);if(v.timedText)writeFileSync(path.join(out,'parakeet.srt'),v.timedText);
          return this.update(id,{transcript:v.transcript,timedTranscript:v.timedTranscript??null,status:'transcribed',retryable:false});
        }
        const current = await this.register(i.path);
        if(this.stopped)return i;
        if (current.id !== id) throw new Error('recording bytes changed; register the new identity instead');
        const out = path.join(this.dir, id); mkdirSync(out, { recursive: true });
        const transcript = path.join(out, 'transcript.txt');
        const recovered = existsSync(transcript) ? readFileSync(transcript, 'utf8') : '';
        let text = recovered;
        if (!text.trim()) {
          const source=path.join(out,'source'+path.extname(i.path));
          copyFileSync(i.path,source,constants.COPYFILE_FICLONE);
          const hash=createHash('sha256'); for await(const chunk of createReadStream(source)) hash.update(chunk);
          if(hash.digest('hex')!==i.hash) throw new Error('recording changed while copying; retry with the completed file');
          if(this.stopped)return i;
          text=await this.transcribe(source,out);
        }
        if(this.stopped)return i;
        if (!text.trim()) throw new Error('transcription returned no text');
        writeFileSync(transcript + '.tmp', text); renameSync(transcript + '.tmp', transcript);
        return this.update(id, { transcript, timedTranscript:existsSync(path.join(out,'parakeet.srt'))?path.join(out,'parakeet.srt'):null, status: 'transcribed', retryable: false });
      } catch (e) { if(this.stopped)return i; return this.update(id, { status: 'failed', retryable: true, error: (e as Error).message }); }
    }).finally(() => this.pending.delete(id));
    this.pending.set(id, run); this.tail = run.catch(() => undefined); return run;
  }
}

