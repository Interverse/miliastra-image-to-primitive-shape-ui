'use strict';
/* Builds a small valid APNG (RGBA, one fcTL per frame, frame 0 in IDAT). */
const zlib=require('zlib');
const table=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc(bytes){let c=0xffffffff;for(const b of bytes)c=table[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function chunk(type,data){const out=Buffer.alloc(12+data.length);out.writeUInt32BE(data.length,0);out.write(type,4,'latin1');data.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,8+data.length)),8+data.length);return out;}
function u32(...values){const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeUInt32BE(v,i*4));return b;}
/* frames: [{rgba: Uint8Array(width*height*4), num, den}] */
function apng(width,height,frames,{plays=0,animated=true}={}){
 const ihdr=Buffer.concat([u32(width,height),Buffer.from([8,6,0,0,0])]);
 const parts=[Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr)];
 if(animated)parts.push(chunk('acTL',u32(frames.length,plays)));
 let sequence=0;
 frames.forEach((frame,i)=>{
  const raw=Buffer.alloc(height*(width*4+1));for(let y=0;y<height;y++)Buffer.from(frame.rgba.subarray(y*width*4,(y+1)*width*4)).copy(raw,y*(width*4+1)+1);
  const data=zlib.deflateSync(raw);
  if(animated){const fc=Buffer.alloc(26);fc.writeUInt32BE(sequence++,0);fc.writeUInt32BE(width,4);fc.writeUInt32BE(height,8);fc.writeUInt16BE(frame.num,20);fc.writeUInt16BE(frame.den,22);parts.push(chunk('fcTL',fc));}
  if(i===0)parts.push(chunk('IDAT',data));
  else if(animated)parts.push(chunk('fdAT',Buffer.concat([u32(sequence++),data])));
 });
 parts.push(chunk('IEND',Buffer.alloc(0)));
 return Buffer.concat(parts);
}
/* Three solid 4x4 frames: red, green, blue at 1/10, 20/100 and 3/0 (0 means 100). */
function sample(options){
 const solid=(r,g,b)=>{const rgba=new Uint8Array(4*4*4);for(let i=0;i<rgba.length;i+=4)rgba.set([r,g,b,255],i);return rgba;};
 return apng(4,4,[{rgba:solid(255,0,0),num:1,den:10},{rgba:solid(0,255,0),num:20,den:100},{rgba:solid(0,0,255),num:3,den:0}],options);
}
module.exports={apng,sample};
