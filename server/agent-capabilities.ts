// remoteStop: a remote host the board reaches over a paired Paseo connection (RemoteAgents.canCancel).
export function agentCapabilities(remoteHost:string|null,bound:boolean,options:{linked?:boolean;hasPaseoLink?:boolean;paseoServerId?:string|null;remoteStop?:boolean}={}){
 const local=remoteHost===null;
 return {source:local?'local-paseo':'af-network',read:true,prompt:bound,stop:(local||options.remoteStop===true)&&bound,restartWithTools:local&&bound&&options.linked===true,paseoLink:true,paseoServerId:options.paseoServerId??null,fileContext:local&&bound,localArtifactPath:local&&bound,exactTimeline:local,olderTimeline:local,toolRows:local,coverage:local?'projected-timeline':'messages-only',remoteHost};
}
