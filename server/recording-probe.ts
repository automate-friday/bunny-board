import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {constants,closeSync,fstatSync,openSync,readSync} from "node:fs";
const exec=promisify(execFile);
export function finalizedRecording(file:string):boolean {
 let fd:number|undefined;
 try {
  fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);const size=fstatSync(fd).size;let offset=0,atoms=0,media=false,movie=false,format=false;
  const header=Buffer.alloc(16);
  while(offset<size){
   if(++atoms>1024)return false;
   if(size-offset<8)return false;
   const count=readSync(fd,header,0,Math.min(16,size-offset),offset);if(count<8)return false;
   let n=header.readUInt32BE(0);const type=header.toString('ascii',4,8);
   if(n===1){if(count<16)return false;const wide=header.readBigUInt64BE(8);if(wide>BigInt(Number.MAX_SAFE_INTEGER))return false;n=Number(wide);}
   if(n<8||offset+n>size||type==='moof')return false;
   if(type==='ftyp'&&n>=16)format=true;if(type==='moov'&&n>8)movie=true;if(type==='mdat'&&n>8)media=true;offset+=n;
  }
  return offset===size&&format&&movie&&media;
 }catch{return false;}finally{if(fd!==undefined)closeSync(fd);}
}
export async function readableRecording(file:string){const {stdout}=await exec('nice',['-n','10','ffprobe','-v','error','-show_entries','format=duration:stream=codec_type','-of','json',file],{timeout:10000,maxBuffer:64000});const data=JSON.parse(stdout);return Number(data.format?.duration)>0&&data.streams?.some((s:{codec_type:string})=>s.codec_type==='video');}
