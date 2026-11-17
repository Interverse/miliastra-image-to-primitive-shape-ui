/* Animated image detection and timing without decoding pixels. Timing is only
 * used to avoid needless resampling. */
"use strict";
const AnimationMedia=(()=>{
 function gifTiming(input){
  const b=new Uint8Array(input);if(b.length<13||String.fromCharCode(...b.subarray(0,6)).match(/^GIF8[79]a$/)===null)return null;
  let at=13+((b[10]&128)?3*2**((b[10]&7)+1):0),duration=0,frames=0,delay=null;
  function blocks(){while(at<b.length){const length=b[at++];if(!length)return true;if(at+length>b.length)return false;at+=length;}return false;}
  while(at<b.length){const kind=b[at++];if(kind===59)break;
   if(kind===33){const label=b[at++];if(label===249){if(b[at]!==4||at+6>b.length)return null;delay=(b[at+2]|b[at+3]<<8)/100;at+=6;}else if(!blocks())return null;
   }else if(kind===44){if(at+9>b.length)return null;const flags=b[at+8];at+=9;if(flags&128)at+=3*2**((flags&7)+1);at++;if(!blocks()||!delay)return null;duration+=Math.max(.01,delay);frames++;delay=null;
   }else return null;
  }
  return frames?{frames,duration}:null;
 }
 const PNG=[137,80,78,71,13,10,26,10];
 const u32=(b,at)=>(b[at]<<24|b[at+1]<<16|b[at+2]<<8|b[at+3])>>>0;
 const tag=(b,at)=>String.fromCharCode(b[at],b[at+1],b[at+2],b[at+3]);
 const isPng=b=>b.length>=8&&PNG.every((v,i)=>b[i]===v);
 /* An APNG declares acTL before its first IDAT; a single-frame one is a still. */
 function apngFrames(input){
  const b=new Uint8Array(input);if(!isPng(b))return 0;
  for(let at=8;at+8<=b.length;){const length=u32(b,at),type=tag(b,at+4);
   if(type==='acTL')return at+16<=b.length?u32(b,at+8):0;
   if(type==='IDAT'||type==='IEND')return 0;
   at+=12+length;}
  return 0;
 }
 /* Sum of fcTL delays (den 0 means 1/100 s). Zero delays are browser-defined,
  * so timing is unknown, as for GIF. */
 function apngTiming(input){
  const b=new Uint8Array(input);if(!apngFrames(b))return null;
  let frames=0,duration=0;
  for(let at=8;at+8<=b.length;){const length=u32(b,at),type=tag(b,at+4);if(at+12+length>b.length)return null;
   if(type==='fcTL'){if(length!==26)return null;const num=b[at+28]<<8|b[at+29],den=b[at+30]<<8|b[at+31]||100;if(!num)return null;duration+=num/den;frames++;}
   if(type==='IEND')break;
   at+=12+length;}
  return frames?{frames,duration}:null;
 }
 const isGif=file=>file?.type==='image/gif'||/\.gif$/i.test(file?.name||'');
 /* Animated image type of a file already sniffed by `sniff`, else null. */
 function imageType(file){return isGif(file)?'image/gif':file?.type==='image/apng'?'image/apng':null;}
 const maybePng=file=>/^image\/a?png$/.test(file?.type||'')||/\.a?png$/i.test(file?.name||'');
 /* Retype a PNG by its contents: animated ones become image/apng (whatever their
  * extension), others image/png. Only chunk headers before IDAT are read. */
 async function sniff(file){
  if(!maybePng(file))return file;
  let frames=0;
  try{
   if(isPng(new Uint8Array(await file.slice(0,8).arrayBuffer())))
    for(let at=8;at+8<=file.size;){const h=new Uint8Array(await file.slice(at,at+16).arrayBuffer()),length=u32(h,0),type=tag(h,4);
     if(type==='acTL'){frames=h.length>=12?u32(h,8):0;break;}
     if(type==='IDAT'||type==='IEND')break;
     at+=12+length;}
  }catch{frames=0;}
  const type=frames>1?'image/apng':file.type==='image/apng'||!file.type?'image/png':file.type;
  return type===file.type?file:new File([file],file.name,{type,lastModified:file.lastModified});
 }
 function timing(type,bytes){return type==='image/apng'?apngTiming(bytes):gifTiming(bytes);}
 /* ImageDecoder type for an animated image; PNG decoders also read APNG. */
 async function decoderType(type){
  if(typeof ImageDecoder==='undefined')return null;
  for(const candidate of type==='image/apng'?['image/apng','image/png']:[type])if(await ImageDecoder.isTypeSupported(candidate))return candidate;
  return null;
 }
 return {gifTiming,apngFrames,apngTiming,imageType,maybePng,sniff,timing,decoderType};
})();
if(typeof module!=='undefined')module.exports=AnimationMedia;
