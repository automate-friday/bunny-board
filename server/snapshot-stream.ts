import type {ServerResponse} from 'node:http';

// One latest value per agent while the socket drains. Pending values share the
// hub's snapshots; only the next packet is serialized, so cached bursts cannot
// fill the socket buffer and force a reconnect/refetch loop.
export class SnapshotStream {
 private readonly pending=new Map<string,unknown>();
 private paused=false;
 private closed=false;
 private timer:ReturnType<typeof setTimeout>|null=null;
 private readonly drained=()=>{this.paused=false;this.clearTimer();this.flush();};
 constructor(private readonly out:Pick<ServerResponse,'write'|'once'|'off'|'destroy'>,private readonly onStall:()=>void,private readonly stallMs=30000){}
 push(key:string,value:unknown):void {
  if(this.closed)return;
  //64 snapshots plus bounded overflow denials. The newest value replaces an old
  // update to that same agent; it does not append another history packet.
  if(!this.pending.has(key)&&this.pending.size>=128){this.fail();return;}
  this.pending.set(key,value);this.flush();
 }
 heartbeat():void {if(!this.closed&&!this.paused)this.write(': ping\n\n');}
 private flush():void {
  if(this.closed||this.paused)return;
  for(const [key,value] of this.pending){
   this.pending.delete(key);
   if(!this.write(`data: ${JSON.stringify(value)}\n\n`))return;
  }
 }
 private write(packet:string):boolean {
  try{
   if(this.out.write(packet))return true;
   this.paused=true;this.out.once('drain',this.drained);
   this.timer=setTimeout(()=>this.fail(),this.stallMs);this.timer.unref?.();
  }catch{this.close();this.out.destroy();}
  return false;
 }
 private clearTimer(){if(this.timer)clearTimeout(this.timer);this.timer=null;}
 private fail(){if(this.closed)return;this.close();this.onStall();this.out.destroy();}
 close(){if(this.closed)return;this.closed=true;this.clearTimer();this.out.off('drain',this.drained);this.pending.clear();}
 get queued(){return this.pending.size;}
}
