import {appendFileSync,existsSync,renameSync,statSync} from 'node:fs';

export interface OperationSummary {
 host:string;operation:string;count:number;failed:number;slow:number;totalMs:number;maxMs:number;
 reasons:Record<string,number>;p50Ms:number;p95Ms:number;sampled:boolean;
}
type Bucket=Omit<OperationSummary,'p50Ms'|'p95Ms'|'sampled'>&{samples:number[];lastDetail:number};
const collectors=new WeakMap<(m:string)=>void,HostMetrics>();
const sampleLimit=4096;
// Exact counts, bounded duration samples and at most one detail per operation/minute.
// Neither prompts nor raw error messages enter this collector.
export class HostMetrics {
 private readonly buckets=new Map<string,Bucket>();
 private readonly totals=new Map<string,{count:number;failed:number;slow:number;totalMs:number}>();
 private readonly timer:ReturnType<typeof setInterval>;
 private stopped=false;
 private since:number;
 constructor(private readonly log:(m:string)=>void,private readonly file?:string,private readonly now:()=>number=Date.now){
  this.since=now();this.timer=setInterval(()=>this.flush(),60000);this.timer.unref?.();
 }
 record(host:string,operation:string,durationMs:number,reason?:string):void {
  if(this.stopped)return;
  const key=JSON.stringify([host,operation]);
  if(!this.buckets.has(key)&&this.buckets.size>=128)return;
  let b=this.buckets.get(key);
  if(!b){b={host,operation,count:0,failed:0,slow:0,totalMs:0,maxMs:0,reasons:{},samples:[],lastDetail:-Infinity};this.buckets.set(key,b);}
  b.count++;b.totalMs+=durationMs;b.maxMs=Math.max(b.maxMs,durationMs);
  if(b.samples.length<sampleLimit)b.samples.push(durationMs);
  else b.samples[(b.count-1)%sampleLimit]=durationMs;
  if(reason){b.failed++;b.reasons[reason]=(b.reasons[reason]??0)+1;}
  if(durationMs>=1000)b.slow++;
  const total=this.totals.get(key)??{count:0,failed:0,slow:0,totalMs:0};
  total.count++;total.failed+=Number(!!reason);total.slow+=Number(durationMs>=1000);total.totalMs+=durationMs;this.totals.set(key,total);
  if((reason||durationMs>=1000)&&this.now()-b.lastDetail>=60000){
   b.lastDetail=this.now();this.log(`host-operation ${JSON.stringify({host,operation,durationMs,outcome:reason?'failed':'ok',...(reason?{reason}:{})})}`);
  }
 }
 snapshot(){return [...this.totals].map(([key,v])=>{const [host,operation]=JSON.parse(key) as [string,string];return {host,operation,...v};});}
 flush():void {
  const until=this.now();
  for(const b of this.buckets.values()){
   if(!b.count)continue;
   const sorted=[...b.samples].sort((a,b)=>a-b);
   const {samples:_samples,lastDetail:_detail,...rest}=b;
   const data={from:new Date(this.since).toISOString(),to:new Date(until).toISOString(),...rest,p50Ms:sorted[Math.floor((sorted.length-1)*.5)],p95Ms:sorted[Math.floor((sorted.length-1)*.95)],sampled:b.count>sampleLimit};
   const line=JSON.stringify(data);
   this.log(`host-operation-summary ${line}`);
   if(this.file)try{
    if(existsSync(this.file)&&statSync(this.file).size>2_000_000)renameSync(this.file,this.file+'.1');
    appendFileSync(this.file,JSON.stringify({...data,durationSamplesMs:sorted})+'\n',{mode:0o600});
   }catch{this.log('host-metrics file unavailable');}
   b.count=0;b.failed=0;b.slow=0;b.totalMs=0;b.maxMs=0;b.reasons={};b.samples=[];
  }
  this.since=until;
 }
 stop(){if(this.stopped)return;this.stopped=true;clearInterval(this.timer);this.flush();}
}
export function hostMetrics(log:(m:string)=>void,file?:string):HostMetrics {
 let result=collectors.get(log);if(!result){result=new HostMetrics(log,file);collectors.set(log,result);}return result;
}
