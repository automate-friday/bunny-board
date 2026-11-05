import {boardIdFromName}from'../shared/board-id';
export function legacyBoardIdFromName(name:string){return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64).replace(/-+$/g,'');}
export function resolveBoardName(name:string,exists:(id:string)=>boolean,aliases:Record<string,string>={}){
 const requestedName=name.trim();if(!requestedName)throw Object.assign(Error('Board name is empty'),{status:400});
 const result=(boardId:string,matchedBy:string)=>({requestedName,boardId,matchedBy,existing:exists(boardId)});
 // Selecting an existing id must never redirect to a different board via an alias.
 if(exists(requestedName))return result(requestedName,'exact');
 const canonical=boardIdFromName(requestedName);
 const alias=Object.hasOwn(aliases,requestedName)?aliases[requestedName]:Object.hasOwn(aliases,canonical)?aliases[canonical]:undefined;
 if(alias!==undefined){if(typeof alias!=='string'||!exists(alias))throw Object.assign(Error('Configured board alias has no existing target; choose a board from the list'),{status:409});return result(alias,'alias');}
 const legacy=legacyBoardIdFromName(requestedName);const matches=[...new Set([canonical,legacy])].filter(id=>id&&exists(id));
 if(matches.length>1)throw Object.assign(Error('Board name is ambiguous; choose an existing id: '+matches.join(', ')),{status:409});
 if(matches.length)return result(matches[0],matches[0]===canonical?'canonical':'legacy');
 if(!/^[A-Za-z0-9_-]{1,64}$/.test(canonical))throw Object.assign(Error('Board name is not usable'),{status:400});return result(canonical,'new');
}
