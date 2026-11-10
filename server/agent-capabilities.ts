// remoteStop: a remote host the board reaches over a paired Paseo connection (RemoteAgents.canCancel).
export function agentCapabilities(remoteHost:string|null,bound:boolean,options:{linked?:boolean;hasPaseoLink?:boolean;paseoServerId?:string|null;remoteStop?:boolean;remoteNative?:boolean}={}){
 const local=remoteHost===null;
 return {source:(local||options.remoteNative)?'local-paseo':'af-network',read:true,prompt:bound,stop:(local||options.remoteStop===true)&&bound,restartWithTools:local&&bound&&options.linked===true,paseoLink:true,paseoServerId:options.paseoServerId??null,fileContext:local&&bound,localArtifactPath:local&&bound,exactTimeline:local||!!options.remoteNative,olderTimeline:local||!!options.remoteNative,toolRows:local||!!options.remoteNative,coverage:(local||options.remoteNative)?'projected-timeline':'messages-only',remoteHost};
}
