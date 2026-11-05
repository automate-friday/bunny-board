// Bound relay reads globally and per host. A slow first host cannot block other hosts' queue slots.
export class BoundedWork {
 private active=0;private keys=new Set<string>();private stopped=false;
 private queue:Array<{key:string;work:()=>Promise<unknown>;resolve:(value:unknown)=>void;reject:(error:unknown)=>void}>=[];
 constructor(private limit=2,private maxQueued=200){}
 run<T>(key:string,work:()=>Promise<T>):Promise<T>{
  if(this.stopped)return Promise.reject(Error('Remote reads stopped'));if(this.queue.length>=this.maxQueued)return Promise.reject(Error('Remote read queue full; cached state is stale'));
  return new Promise<T>((resolve,reject)=>{this.queue.push({key,work,resolve:resolve as (value:unknown)=>void,reject});this.pump();});
 }
 prioritize(key:string){const chosen=this.queue.filter(q=>q.key===key);this.queue=[...chosen,...this.queue.filter(q=>q.key!==key)];this.pump();}
 private pump(){
  while(!this.stopped&&this.active<this.limit){const index=this.queue.findIndex(q=>!this.keys.has(q.key));if(index<0)return;const [task]=this.queue.splice(index,1);this.active++;this.keys.add(task.key);
   Promise.resolve().then(()=>{if(this.stopped)throw Error('Remote reads stopped');return task.work();}).then(task.resolve,task.reject).finally(()=>{this.active--;this.keys.delete(task.key);this.pump();});
  }
 }
 stop(){this.stopped=true;for(const q of this.queue)q.reject(Error('Remote reads stopped'));this.queue=[];}
}
