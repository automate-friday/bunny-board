// Shared browser/agent image storage. No caller-provided path is ever read.
import { imageVariant, VARIANT_WIDTHS } from './image-variants';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,renameSync,writeFileSync} from 'node:fs';
import path from 'node:path';
export const MAX_IMAGE_BYTES=20*1024*1024;
function bad(message:string,status=400):Error{return Object.assign(new Error(message),{status});}
export async function readImageUpload(stream:AsyncIterable<Uint8Array>,max=MAX_IMAGE_BYTES):Promise<Buffer>{
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of stream){size+=chunk.length;if(size>max)throw bad(`Image exceeds ${Math.round(max/1024/1024)} MB upload limit`,413);chunks.push(Buffer.from(chunk));}
 if(!size)throw bad('Image upload is empty');return Buffer.concat(chunks);
}
export function inspectImage(buf:Buffer):{w:number;h:number;mimeType:string;ext:string}{
 let w=0,h=0,mimeType='',ext='';
 if(buf.length>=33&&buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
  if(buf.readUInt32BE(8)!==13||buf.toString('ascii',12,16)!=='IHDR')throw bad('Invalid PNG image header');
  w=buf.readUInt32BE(16);h=buf.readUInt32BE(20);mimeType='image/png';ext='png';
  let data=false,end=false;
  for(let i=8;i+12<=buf.length;){const n=buf.readUInt32BE(i);if(n>buf.length-i-12)throw bad('Truncated PNG image');const type=buf.toString('ascii',i+4,i+8);if(type==='IDAT'&&n>0)data=true;if(type==='IEND'){end=true;break;}i+=n+12;}
  if(!data||!end)throw bad('Incomplete PNG image');
 }else if(buf.length>=12&&buf[0]===255&&buf[1]===216){
  for(let i=2;i+4<buf.length;){if(buf[i]!==255)break;const marker=buf[i+1];if(marker===255){i++;continue;}if(marker===217||marker===218)break;const n=buf.readUInt16BE(i+2);if(n<2||i+2+n>buf.length)throw bad('Truncated JPEG image');if(marker>=192&&marker<=207&&![196,200,204].includes(marker)){if(n<7)throw bad('Invalid JPEG image dimensions');h=buf.readUInt16BE(i+5);w=buf.readUInt16BE(i+7);break;}i+=2+n;}
  // Dimensions alone are not an image: require a scan and final marker.
  if(buf.indexOf(Buffer.from([255,218]),2)<0||buf.length<4||buf[buf.length-2]!==255||buf[buf.length-1]!==217)throw bad('Incomplete JPEG image');
  mimeType='image/jpeg';ext='jpg';
 }else if(buf.length>=14&&['GIF87a','GIF89a'].includes(buf.toString('ascii',0,6))){w=buf.readUInt16LE(6);h=buf.readUInt16LE(8);
  let i=13+((buf[10]&128)?3*(1<<((buf[10]&7)+1)):0),pixels=false,end=false;
  const blocks=()=>{while(i<buf.length){const n=buf[i++];if(!n)return;if(i+n>buf.length)throw bad('Truncated GIF image');i+=n;}throw bad('Incomplete GIF image');};
  while(i<buf.length){const marker=buf[i++];if(marker===59){end=true;break;}if(marker===33){i++;blocks();continue;}if(marker!==44||i+9>buf.length)throw bad('Invalid GIF image');const left=buf.readUInt16LE(i),top=buf.readUInt16LE(i+2),iw=buf.readUInt16LE(i+4),ih=buf.readUInt16LE(i+6);if(!iw||!ih||left+iw>w||top+ih>h||iw*ih>100000000)throw bad('Invalid GIF image dimensions');const packed=buf[i+8];i+=9;if(packed&128)i+=3*(1<<((packed&7)+1));if(i+2>buf.length||buf[i]<2||buf[i]>8)throw bad('Invalid GIF image data');i++;if(!buf[i])throw bad('Empty GIF image');blocks();pixels=true;}
  if(!pixels||!end)throw bad('Incomplete GIF image');mimeType='image/gif';ext='gif';
 }else if(buf.length>=30&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP'){
  const type=buf.toString('ascii',12,16);
  if(type==='VP8X'){w=1+buf.readUIntLE(24,3);h=1+buf.readUIntLE(27,3);}
  else if(type==='VP8 '&&buf[23]===157&&buf[24]===1&&buf[25]===42){w=buf.readUInt16LE(26)&16383;h=buf.readUInt16LE(28)&16383;}
  else if(type==='VP8L'&&buf[20]===47){w=1+(buf[21]|((buf[22]&63)<<8));h=1+((buf[22]>>6)|(buf[23]<<2)|((buf[24]&15)<<10));}
  if(buf.readUInt32LE(4)+8!==buf.length)throw bad('Truncated WebP image');
  const pixelChunks=(start:number,end:number,frames:boolean):boolean=>{
   let pixels=false;
   for(let i=start;i<end;){if(i+8>end)throw bad('Truncated WebP image');const n=buf.readUInt32LE(i+4),chunk=buf.toString('ascii',i,i+4),next=i+8+n+(n%2);if(next>end)throw bad('Truncated WebP image');
    if((chunk==='VP8 '&&n>10)||(chunk==='VP8L'&&n>5))pixels=true;
    if(chunk==='ANMF'&&frames){if(n<16)throw bad('Invalid WebP frame');const x=2*buf.readUIntLE(i+8,3),y=2*buf.readUIntLE(i+11,3),fw=1+buf.readUIntLE(i+14,3),fh=1+buf.readUIntLE(i+17,3);if(x+fw>w||y+fh>h)throw bad('Invalid WebP frame dimensions');if(!pixelChunks(i+24,i+8+n,false))throw bad('Missing WebP frame data');pixels=true;}i=next;
   }return pixels;
  };
  if(!pixelChunks(12,buf.length,true))throw bad('Missing WebP image data');mimeType='image/webp';ext='webp';
 }else throw bad('Upload must be a PNG, JPEG, GIF or WebP image');
 if(!w||!h||w>32768||h>32768||w*h>100000000)throw bad('Image dimensions are invalid or too large');
 return {w,h,mimeType,ext};
}
export function persistImage(cfg:{assetsDir:string;publicBase:string},buf:Buffer){
 if(buf.length>MAX_IMAGE_BYTES)throw bad('Image exceeds 20 MB upload limit',413);
 const image=inspectImage(buf);const hash=createHash('sha256').update(buf).digest('hex');const file=hash.slice(0,32)+'.'+image.ext;
 mkdirSync(cfg.assetsDir,{recursive:true});const target=path.join(cfg.assetsDir,file);
 if(!existsSync(target)){const tmp=target+'.'+randomUUID()+'.tmp';writeFileSync(tmp,buf);renameSync(tmp,target);}
 // The phone's first look at a frame asks for the smallest copy (server/image-variants.ts): make it now, off the event loop.
 if((image.ext==='png'||image.ext==='jpg')&&image.w>VARIANT_WIDTHS[0])void imageVariant(cfg.assetsDir,file,VARIANT_WIDTHS[0]).catch(()=>null);
 return {src:`${cfg.publicBase}/api/assets/${file}`,file,hash,bytes:buf.length,w:image.w,h:image.h,mimeType:image.mimeType};
}
