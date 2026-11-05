import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { ListResponse, PickerRow } from "./ImportPicker";

const SIZE = 200;
const FIRST_PAGE_SIZE = 50; // Keep initial mount small; later pages retain bulk discovery.
// Refresh the local snapshot on open/filter/import/manual refresh. Offset pages
// reuse that snapshot instead of starting another scan for every page.
export function readDirectoryPage(query: string, offset = 0, signal?: AbortSignal, forceRemote = false) {
  const p = new URLSearchParams(query); p.set("limit", String(offset === 0 ? FIRST_PAGE_SIZE : SIZE)); p.set("offset", String(offset));
  if ((offset === 0 && p.get("source") !== "remote") || (forceRemote && p.get("source") === "remote")) p.set("fresh", "1");
  else p.delete("fresh");
  const timeout = p.get("source") === "remote" || p.get("archived") === "1" ? 30000 : 12000;
  return api<ListResponse>(`/api/ui/agents/list?${p}`, { cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
}
const asking = (data: ListResponse) => data.directoryState === "asking";
const pollDelay = (data: ListResponse) => Math.min(30000, Math.max(500, typeof data.retryAfterMs === "number" && Number.isFinite(data.retryAfterMs) ? data.retryAfterMs : 2000));
function waitForPoll(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
interface ScanPage { rows: PickerRow[]; scanned: number; hasMore: boolean; nextCursor: string | null; total: null }
export async function readDirectoryScan(query: string, cursor: string | null, signal: AbortSignal) {
  const p = new URLSearchParams(query); for (const key of ["limit", "offset", "fresh", "source"]) p.delete(key);
  if (cursor) p.set("cursor", cursor);
  return api<ScanPage>(`/api/ui/agents/scan?${p}`, { cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]) });
}
interface State { scan: boolean; scanned: number; cursor: string | null; key: string; data: ListResponse | null; loading: boolean; slow: boolean; moreBusy: boolean; error: string | null; offset: number; ended: boolean; updatedAt: number | null; refreshing: boolean }
const empty = (key: string): State => ({scan:false,scanned:0,cursor:null,key,data:null,loading:true,slow:false,moreBusy:false,error:null,offset:0,ended:false,updatedAt:null,refreshing:false});
export function useDirectoryPages(query: string, remote: boolean) {
  const [state, setState] = useState<State>(() => empty(""));
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now());
  const seenCursors = useRef(new Set<string>());
  const generation = useRef(0), moreInFlight = useRef(false), allowRefresh = useRef(true);
  const failedOperation = useRef<"refresh" | "more">("refresh");
  const controller = useRef<AbortController | null>(null);
  const forceQuery = useRef<string | null>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const token = ++generation.current, ctl = new AbortController(), openedAt = Date.now(); controller.current = ctl;
    moreInFlight.current = false; allowRefresh.current = true; failedOperation.current = "refresh";
    const forceFirst = remote && forceQuery.current === query; forceQuery.current = null;
    setState(empty(query)); seenCursors.current.clear();
    // Do not label a slow/unavailable directory as an empty match set.
    const watchdog = setTimeout(() => { if (token === generation.current && !ctl.signal.aborted) setState(old => old.data ? old : {...old,loading:false,slow:true}); },1500);
    let retry: ReturnType<typeof setTimeout> | undefined;
    const run = async (force = false) => {
      try {
        const data = await readDirectoryPage(query,0,ctl.signal,force);
        if (token !== generation.current || ctl.signal.aborted || !allowRefresh.current) return;
        clearTimeout(watchdog);
        const receivedAt = Date.now();
        const updatedAt = data.hasSnapshot !== false && typeof data.cacheAgeMs === "number" && Number.isFinite(data.cacheAgeMs) ? receivedAt - Math.max(0,data.cacheAgeMs) : null;
        const predatesOpen = updatedAt !== null && updatedAt < openedAt - 100;
        const pending = remote && asking(data);
        // New remote terminal states are final even when failed coverage is stale.
        const refreshing = pending || (!data.directoryState && (data.stale || predatesOpen) && receivedAt - openedAt < (remote ? 75000 : 20000));
        setState({scan:false,scanned:0,cursor:null,key:query,data,loading:false,slow:false,moreBusy:false,error:null,offset:pending?0:data.rows.length,ended:!pending&&(data.rows.length===0||data.rows.length>=data.matched),updatedAt,refreshing});
        if (refreshing) {
          const delay = pending ? pollDelay(data) : data.stale ? (remote?9000:500) : Math.max(200,(remote?60000:5000) - (data.cacheAgeMs ?? 0) + 100);
          retry = setTimeout(() => { if(allowRefresh.current)void run(); },delay);
        }
      } catch(error) {
        if(token===generation.current&&!ctl.signal.aborted&&allowRefresh.current){clearTimeout(watchdog);failedOperation.current="refresh";setState(old=>({...old,loading:false,slow:false,refreshing:false,error:(error as Error).message}));}
      }
    };
    void run(forceFirst);
    return () => { generation.current++; ctl.abort(); clearTimeout(retry); clearTimeout(watchdog); };
  },[query,remote,revision]);
  const current = state.key === query ? state : empty(query);
  const loadMore = async (startScan = false, force = false) => {
    if(state.key!==query||!state.data||(asking(state.data)&&!state.error)||(state.ended && !startScan)||moreInFlight.current||!controller.current)return;
    moreInFlight.current=true;allowRefresh.current=false;
    const token=generation.current,ctl=controller.current;
    setState(old=>({...old,scan:old.scan||startScan,ended:startScan?false:old.ended,moreBusy:true,error:null,refreshing:false}));
    try{
      const scanning = !remote && (state.scan || startScan);
      if (scanning) {
        const cursor = startScan ? null : state.cursor;
        const page = await readDirectoryScan(query,cursor,ctl.signal);
        if(token!==generation.current||ctl.signal.aborted)return;
        if(page.hasMore && (!page.nextCursor || page.nextCursor === cursor || seenCursors.current.has(page.nextCursor))) throw Error("Directory cursor repeated or missing. Refresh list to restart safely.");
        if(cursor) seenCursors.current.add(cursor);
        setState(old=>{if(old.key!==query||!old.data)return old;
          const merged=new Map(old.data.rows.map(row=>[row.id,row])); for(const row of page.rows)merged.set(row.id,row);
          return {...old,scan:true,scanned:(startScan?0:old.scanned)+page.scanned,cursor:page.nextCursor,ended:!page.hasMore,moreBusy:false,error:null,data:{...old.data,rows:[...merged.values()],truncated:false}};
        });
        return;
      }
      const requestedOffset = state.offset;
      let data: ListResponse;
      do {
        data = await readDirectoryPage(query, requestedOffset, ctl.signal, force);
        force = false; // Manual force applies to exactly one request, never its polling loop.
        if(token!==generation.current||ctl.signal.aborted)return;
        if (remote && asking(data)) {
          const pending = data;
          setState(old => {
            if (old.key !== query || !old.data) return old;
            const merged = new Map(old.data.rows.map(row => [`${row.host ?? "local"}:${row.id}`, row]));
            for (const row of pending.rows) merged.set(`${row.host ?? "local"}:${row.id}`, row);
            return {...old, data:{...pending,rows:[...merged.values()]},refreshing:true};
          });
          await waitForPoll(pollDelay(data), ctl.signal);
        }
      } while (remote && asking(data));
      if (remote && data.directoryState === "error") {
        failedOperation.current = "more";
        const failed = data;
        setState(old => old.key !== query || !old.data ? old : {...old, data:{...failed,rows:old.data.rows},moreBusy:false,refreshing:false,error:null});
        return; // Keep the requested offset available for an explicit retry.
      }
      failedOperation.current = "refresh";
      setState(old=>{if(old.key!==query||!old.data)return old;const merged=new Map(old.data.rows.map(row=>[`${row.host??"local"}:${row.id}`,row]));for(const row of data.rows)merged.set(`${row.host??"local"}:${row.id}`,row);const offset=state.offset+data.rows.length;return{...old,data:{...data,rows:[...merged.values()]},offset,ended:!data.rows.length||offset>=data.matched,moreBusy:false,refreshing:false,error:null,updatedAt:data.hasSnapshot !== false && typeof data.cacheAgeMs === "number" && Number.isFinite(data.cacheAgeMs) ? Date.now()-Math.max(0,data.cacheAgeMs) : null};});
    }catch(error){if(token===generation.current&&!ctl.signal.aborted){failedOperation.current="more";setState(old=>({...old,moreBusy:false,refreshing:false,error:(error as Error).message}));}}
    finally{if(token===generation.current)moreInFlight.current=false;}
  };
  const refresh = () => { forceQuery.current = query; setRevision(n => n + 1); };
  return {...current,updatedSeconds:current.updatedAt === null ? null : Math.max(0,Math.floor((now-current.updatedAt)/1000)),loadMore:()=>loadMore(),startScan:()=>loadMore(true),retry:()=>failedOperation.current==="more"?void loadMore(false,remote):refresh(),refresh};
}
