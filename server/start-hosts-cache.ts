// Stale-while-revalidate: opening a form never waits for fleet connections.
export class StartHostsCache<T> {
  private hosts:T[]=[];
  private at:number|null=null;
  private pending:Promise<T[]>|null=null;
  private error:string|undefined;
  private version=0;
  private maxAge=60_000;
  constructor(private load:()=>Promise<T[]>,private ttl=60_000,private cacheable:(rows:T[])=>boolean=()=>true,private negativeTtl=1000){}
  invalidate(){this.version++;this.at=null;}
  snapshot(force=false) {
    if(force || this.at===null || Date.now()-this.at>=this.maxAge)void this.refresh().catch(()=>{});
    return {hosts:this.hosts,refreshing:!!this.pending,...(this.error?{note:this.error}:{})};
  }
  get():Promise<T[]> {
    if(this.at!==null&&Date.now()-this.at<this.maxAge)return Promise.resolve(this.hosts);
    return this.refresh();
  }
  private refresh():Promise<T[]> {
    if(this.pending)return this.pending;
    const version=this.version;
    this.pending=this.load().then(hosts=>{this.hosts=hosts;this.error=undefined;this.maxAge=this.cacheable(hosts)?this.ttl:this.negativeTtl;return hosts;},error=>{
      this.maxAge=this.negativeTtl;
      this.error=`Could not refresh hosts: ${(error as Error).message}`;throw error;
    }).finally(()=>{if(version===this.version)this.at=Date.now();this.pending=null;});
    return this.pending;
  }
}
export async function hostDeadline<T>(work:Promise<T>,ms=2500):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`Host check timed out after ${ms} ms`)),ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
