'use strict';
const assert=require('node:assert/strict'),zlib=require('node:zlib');
const Json=require('../../js/animation-json.js'),Core=require('../../js/animation-core.js'),Zip=require('../../js/zip.js');
const animation={kind:'primeval',width:64,height:32,controls:2,unit:1,fps:0,loop:true,durations:[.07,.11,.08],frames:Array.from({length:3},(_,f)=>new Float64Array([1,f*30,-20,80,60,0,0xff123456,1,3,-50,30+f,90,40,-120,0x80abcdef,0]))};
const poster={image_name:'sample',group_name:'sample',origin:{x:64,y:-32},image_size:{width:64,height:32},config:{image_scale:2,pixel_per_unit:.5},mask:null,elements:Core.elements(animation,0,2)};
(async()=>{
 const exported=JSON.parse(await(await Json.blob(animation,poster,2)).text()),restored=Json.restore(exported.animation);
 const {animation:extra,...unchanged}=exported;assert.deepEqual(unchanged,poster,'legacy first-frame payload is untouched');
 assert.deepEqual(restored.frames,animation.frames);assert.deepEqual(restored.durations,animation.durations);assert.equal(restored.unit,2);assert.equal(restored.fps,0);assert.equal(restored.loop,true);
 assert.deepEqual(Core.elements(restored,2,restored.unit),Core.elements(animation,2,2),'scaled playback survives JSON roundtrip');
 const bad=structuredClone(exported.animation);bad.frames[0][6]=-1;assert.throws(()=>Json.restore(bad),/import.invalid/);
 assert.throws(()=>Json.restore({...extra,version:2}),/import.unsupported/);assert.throws(()=>Json.restore({...extra,durations:[NaN]}),/import.invalid/);
 assert.throws(()=>Json.restore({...extra,controls:100000000}),/animation.limit/);
 const controller=new AbortController();await assert.rejects(Json.blob(animation,poster,2,{signal:controller.signal,onProgress:()=>controller.abort()}),{name:'AbortError'});
 const raw=new TextEncoder().encode(JSON.stringify(poster).repeat(4)),files=[{name:'first.json',data:raw},{name:'second.json',data:new TextEncoder().encode('[]')}];
 async function verifyZip(blob){const bytes=new Uint8Array(await blob.arrayBuffer()),v=new DataView(bytes.buffer);let at=0,count=0;while(v.getUint32(at,true)===0x04034b50){const method=v.getUint16(at+8,true),size=v.getUint32(at+18,true),length=v.getUint16(at+26,true),extra=v.getUint16(at+28,true),data=bytes.subarray(at+30+length+extra,at+30+length+extra+size),plain=method===8?zlib.inflateRawSync(data):data;assert.ok(method===0||method===8);assert.deepEqual([...plain],[...files[count].data]);assert.equal(Zip.crc32(plain),v.getUint32(at+14,true));assert.equal(plain.length,v.getUint32(at+22,true));at+=30+length+extra+size;count++;}assert.equal(count,2);}
 await verifyZip(Zip.build(files));const compressed=await Zip.buildAsync(files);await verifyZip(compressed);assert.ok(compressed.size<raw.length,'frame ZIP uses actual compression');
 const cancelled=new AbortController();await assert.rejects(Zip.buildAsync(files,{signal:cancelled.signal,onProgress:()=>cancelled.abort()}),{name:'AbortError'});
 console.log('PASS animation JSON layout, every frame/timing, zoom, validation, ZIP compression/CRC and cancellation');
})().catch(error=>{console.error(error);process.exitCode=1;});
