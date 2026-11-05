// Read-only release gate. Supply the candidate/rollback target's exact schema;
// component version numbers alone do not prove that stored records can load.
import type {RoomSnapshot} from '@tldraw/sync-core';
import type {TLRecord} from '@tldraw/tlschema';
import {schema} from './room-host';

export function snapshotCompatibility(snapshot:RoomSnapshot,target:typeof schema=schema):{compatible:boolean;records:number;reason?:string}{
 try{
  const copy=structuredClone(snapshot);
  if(!copy.schema)return {compatible:false,records:copy.documents.length,reason:"Snapshot has no serialized schema"};
  const ids=copy.documents.map(d=>d.state.id);
  if(new Set(ids).size!==ids.length)return {compatible:false,records:ids.length,reason:"Snapshot contains duplicate record IDs"};
  const store=Object.fromEntries(copy.documents.map(d=>[d.state.id,d.state as TLRecord]));
  const migrated=target.migrateStoreSnapshot({store,schema:copy.schema},{mutateInputStore:false});
  if(migrated.type!=='success')return {compatible:false,records:copy.documents.length,reason:'Target schema cannot migrate this snapshot'};
  const original=Object.keys(store).sort();const final=Object.keys(migrated.value).sort();
  if(copy.documents.length!==final.length||Object.entries(migrated.value).some(([id,record])=>record.id!==id)||JSON.stringify(original)!==JSON.stringify(final))return {compatible:false,records:original.length,reason:'Target migration changes record identity; manual review required'};
  for(const record of Object.values(migrated.value)){
   const validator=target.types[record.typeName as TLRecord['typeName']];
   if(!validator)return {compatible:false,records:original.length,reason:'Target lacks a stored record type'};
   validator.validate(record);
  }
  return {compatible:true,records:original.length};
 }catch{return {compatible:false,records:snapshot?.documents?.length??0,reason:'Snapshot or record is incompatible with target schema'};}
}
