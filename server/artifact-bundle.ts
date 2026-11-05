import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,mkdirSync,readdirSync,realpathSync,renameSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import path from 'node:path';
export function bundleFilePath(root:string,name:string):string {
 if(!name||/[\\\x00-\x1f\x7f]/.test(name)||name.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.')))throw Error('Invalid bundle resource path');
 const resolved=path.resolve(root,...name.split('/'));if(!resolved.startsWith(path.resolve(root)+path.sep))throw Error('Bundle resource escapes root');return resolved;
}
// Explicit opt-in: copy a report-only directory, never follow links or silently omit files.
export function collectArtifactBundle(entry:string,read:(file:string)=>Buffer) {
 if(lstatSync(entry).isSymbolicLink())throw Error('Report bundle refuses symlink entry');
 if(!/\.html?$/i.test(entry))throw Error('bundle:true needs an HTML entry in a report-only directory');
 const root=path.dirname(realpathSync(entry));const files:Array<{name:string;bytes:Buffer}>=[];let total=0;let entries=0;
 function visit(dir:string,prefix='',depth=0){
  if(depth>6)throw Error('Report bundle exceeds6 directory levels');
  for(const name of readdirSync(dir).sort()){
   if(++entries>200)throw Error('Report bundle exceeds200 entries');
   const relative=prefix+name;const file=bundleFilePath(root,relative);const st=lstatSync(file);
   if(st.isSymbolicLink())throw Error('Report bundle refuses symlinks: '+relative);
   if(st.isDirectory()){visit(file,relative+'/',depth+1);continue;}
   if(!st.isFile())throw Error('Report bundle contains a non-regular file');
   if(files.length>=100||total+st.size>20*1024*1024)throw Error('Report bundle exceeds100 files or20MB; use a report-only folder');
   const bytes=read(file);total+=bytes.length;if(total>20*1024*1024)throw Error('Report bundle exceeds20MB');files.push({name:relative,bytes});
  }
 }
 visit(root);
 const entryName=path.basename(realpathSync(entry));if(!files.some(f=>f.name===entryName))throw Error('HTML entry not in bundle');
 return {entryName, files};
}
export function persistArtifactBundle(entry:string,assetsDir:string,read:(file:string)=>Buffer) {
 const {entryName,files}=collectArtifactBundle(entry,read);return persistBundleFiles(entryName,files,assetsDir);
}
export function persistBundleFiles(entryName:string,files:Array<{name:string;bytes:Buffer}>,assetsDir:string) {
 let total=0;const names=new Set<string>();
 if(!files.length||files.length>100)throw Error('Report bundle exceeds100 files');
 for(const file of files){bundleFilePath(assetsDir,file.name);if(names.has(file.name))throw Error('Duplicate bundle path');names.add(file.name);total+=file.bytes.length;}
 if(total>20*1024*1024||!names.has(entryName))throw Error('Invalid report bundle');
 const hash=createHash('sha256');for(const f of files)hash.update(JSON.stringify([f.name,f.bytes.length])).update(f.bytes);
 const sha=hash.digest('hex').slice(0,32);const base=path.join(assetsDir,'bundles');const target=path.join(base,sha);
 if(!existsSync(target)){
  const stage=path.join(base,'.stage-'+randomUUID());mkdirSync(stage,{recursive:true});
  try{for(const f of files){const dest=bundleFilePath(stage,f.name);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,f.bytes,{flag:'wx'});}renameSync(stage,target);}finally{rmSync(stage,{recursive:true,force:true});}
 }
 return {sha,name:entryName,bytes:total,fileCount:files.length,urlPath:`/api/assets/bundles/${sha}/${encodeURIComponent(entryName)}`};
}
