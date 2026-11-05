// Absolute offsets from the interaction; one owned timer per agent.
export class QuickPoll {
 private timer:ReturnType<typeof setTimeout>|undefined;
 private generation=0;
 constructor(private read:()=>Promise<boolean>){}
 start(){this.stop();const generation=this.generation;const at=Date.now();const offsets=[2000,5000,10000];
  const next=(i:number)=>{if(i>=offsets.length||generation!==this.generation)return;
   this.timer=setTimeout(async()=>{this.timer=undefined;let terminal=false;try{terminal=await this.read();}catch{}
    if(!terminal&&generation===this.generation)next(i+1);
   },Math.max(0,at+offsets[i]-Date.now()));this.timer.unref?.();
  };next(0);
 }
 stop(){this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
}
