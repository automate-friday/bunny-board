import {useEffect,useState} from 'react';
import {api} from './api';
type Settings={maxConcurrentWorkers:number;ttlSeconds:number};
export function WorkerSettings({visible}:{visible:boolean}){
 const [enabled,setEnabled]=useState(false),[count,setCount]=useState('10'),[hours,setHours]=useState('24'),[status,setStatus]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{if(!visible)return;let cancelled=false;api<{workerSettings?:boolean}>('/api/ui/info').then(async info=>{if(!info.workerSettings)return;const value=await api<Settings>('/api/ui/worker-settings');if(cancelled)return;setEnabled(true);setCount(String(value.maxConcurrentWorkers));setHours(String(value.ttlSeconds/3600));}).catch(e=>{if(!cancelled)setStatus(e.message);});return()=>{cancelled=true;};},[visible]);
 if(!enabled)return null;
 return <details data-testid="worker-settings" style={{marginTop:12}}>
  <summary style={{cursor:'pointer',fontWeight:600}}>Upstash workers</summary>
  <form onSubmit={async e=>{e.preventDefault();setBusy(true);setStatus('');try{const saved=await api<Settings>('/api/ui/worker-settings',{method:'PUT',body:JSON.stringify({maxConcurrentWorkers:Number(count),ttlSeconds:Math.round(Number(hours)*3600)})});setCount(String(saved.maxConcurrentWorkers));setHours(String(saved.ttlSeconds/3600));setStatus('Saved. Applies to new workers.');}catch(error){setStatus((error as Error).message);}finally{setBusy(false);}}}>
   <label style={{display:'block',marginTop:8}}>Concurrent workers <input aria-label="Concurrent workers" type="number" min="1" max="25" step="1" required value={count} onChange={e=>setCount(e.target.value)} style={{width:65}} /></label>
   <label style={{display:'block',marginTop:8}}>Maximum age (hours) <input aria-label="Maximum age (hours)" type="number" min="0.05" max="72" step="0.05" required value={hours} onChange={e=>setHours(e.target.value)} style={{width:65}} /></label>
   <p style={{fontSize:12}}>Shared across boards. Lowering the limit lets running workers finish. At expiry, work is saved; send another message to resume on a fresh worker. Subscription expiry can release a worker sooner. Your Upstash account quota also applies.</p>
   <button type="submit" disabled={busy}>{busy?'Saving…':'Save worker limits'}</button>
   <p role="status" style={{fontSize:12}}>{status}</p>
  </form>
 </details>;
}
