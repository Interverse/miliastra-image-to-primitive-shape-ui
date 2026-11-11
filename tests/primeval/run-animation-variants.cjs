'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('child_process');
global.LuaExport=require('../../js/lua-export.js');const Player=require('../../js/animation-lua.js'),{buildVariants}=require('../../scripts/prepare-animation-variants.cjs'),{extract}=require('../../scripts/upgrade-animation-player.cjs');
const lua=['lua','texlua'].find(c=>{const r=spawnSync(c,['--version']);return !r.error&&r.status===0;});
const Payload=require('../../scripts/animation-payload.cjs'),Order=require('../../scripts/animation-draw-order.cjs'),Verifier=require('../../scripts/verify-animation-order.cjs');
{
 const make=frames=>Player.buildLegacy({width:64,height:32,controls:frames[0].length/8,frames,durations:frames.map(()=>.07),fps:15},{imageTemplateIndex:123});
 const pair=new Float64Array([2,0,0,100,100,0,0xff112233,0,2,10,10,100,100,0,0x80123456,1]),swapped=pair.slice();swapped[7]=1;swapped[15]=0;
 assert.throws(()=>Verifier.verify(make([pair]),make([swapped])),/Overlapping primitives reordered/);
 const separate=pair.slice();separate[1]=-200;separate[9]=200;const reordered=separate.slice();reordered[7]=1;reordered[15]=0;Verifier.verify(make([separate]),make([reordered]));
 const altered=reordered.slice();altered[2]++;assert.throws(()=>Verifier.verify(make([separate]),make([altered])),/Primitive changed/);
 for(const frames of [[pair,separate],[new Float64Array(8)]]){
  const source=make(frames),stripped=Payload.stripOrdering(source);assert.deepEqual(Payload.decode(stripped).frames,Payload.decode(source).frames,'dead-channel removal must preserve every decoded field');
  assert.equal(Order.optimize(source).source,Order.optimize(source).source,'offline planning must be deterministic');
 }
 console.log('PASS independent order oracle rejects overlapping inversions and field edits; dead-channel removal is exact and planning deterministic');
}
if(!lua){console.log('SKIP variant VM checks: native Lua unavailable');process.exit(0);}
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'animation-variants-'));
try{
 const N=12,frames=Array.from({length:5},(_,f)=>Float64Array.from({length:N*8},(_,i)=>{const id=Math.floor(i/8);return [id===f?0:id%3+1,id===10?10000:id*23-120+f*3,id*11-60,20+f*3,30-f,f*127+id*31,(id===9?0:0x80000000)+((id*7919+f*997)%0x1000000),(id+f*3)%N][i%8];}));frames[1]=frames[0].slice();
 for(const compact of [false,true])for(const kind of ['loop','nonloop','frozen','static']){
  const selected=kind==='static'?[frames[0]]:frames,animation={width:64,height:32,controls:N,frames:selected,durations:kind==='static'?[.1]:[.07,.11,.08,.06,.01],fps:15,loop:kind!=='nonloop'};
  const source=Player.buildLegacy(animation,{imageTemplateIndex:123,width:137.5,compact}),input=path.join(dir,'source.lua');fs.writeFileSync(input,source);
  for(const [mode,script] of Object.entries(buildVariants(source))){
   const output=path.join(dir,mode+'.lua'),code=kind==='frozen'?script.replace('local FREEZE_FRAME=0','local FREEZE_FRAME=1'):script;
   if(mode==='fast'){require('../../scripts/verify-animation-order.cjs').verify(source,code);assert.ok(extract(code).moveCounts.every(n=>n===0),'runtime must not decode unused order plans');}
   else assert.deepEqual(extract(code).lines,extract(source).lines,'saved payload and settings must be unchanged');fs.writeFileSync(output,code);
   const result=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),input,output,'jitter'],{encoding:'utf8',maxBuffer:2*1024*1024});
   assert.equal(result.status,0,`${mode}/${kind}/compact=${compact}\n${result.stdout}\n${result.stderr}`);
   if(kind==='loop'){const cancelled=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),input,output,'cancel'],{encoding:'utf8'});assert.equal(cancelled.status,0,cancelled.stdout+cancelled.stderr);}
   if(mode==='fast'&&kind==='loop'){
    assert.ok(code.includes('local NATIVE_BATCH=false'),'unverified native cache must stay opt-in');
    assert.ok(!code.includes('game.Tween'),'default fast file must omit the failed native cache');
    const nativeCode=buildVariants(source,{nativeBatch:true}).fast,nativeOutput=path.join(dir,'native-model.lua');fs.writeFileSync(nativeOutput,nativeCode);
    const partial=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),input,nativeOutput,'cancel_native'],{encoding:'utf8'});assert.equal(partial.status,0,partial.stdout+partial.stderr);
    const fallback=path.join(dir,'fallback.lua');fs.writeFileSync(fallback,nativeCode.replace('local NATIVE_BATCH=true','local NATIVE_BATCH=false'));
    const limited=path.join(dir,'limit.lua');fs.writeFileSync(limited,nativeCode.replace('local NATIVE_CACHE_LIMIT=65536','local NATIVE_CACHE_LIMIT=0'));
    for(const [file,env] of [[fallback,process.env],[limited,process.env],[nativeOutput,{...process.env,NO_NATIVE_SEQUENCE:'1'}]]){const run=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),input,file,'jitter'],{encoding:'utf8',env});assert.equal(run.status,0,run.stdout+run.stderr);}
    console.log('PASS partial native-cache cancellation, direct fallback and missing-native-API fallback');
   }
   if(mode==='fast'&&(kind==='loop'||kind==='nonloop')){
    for(const geometry of [true,false]){
     const cappedSource=source.replace(/^local PLAYBACK_FPS=.*$/m,'local PLAYBACK_FPS=4'),cappedScript=buildVariants(cappedSource).fast.replace('local TRANSFORM_GEOMETRY=true','local TRANSFORM_GEOMETRY='+geometry);
     const capInput=path.join(dir,'cap-source.lua'),capOutput=path.join(dir,'cap-fast.lua');fs.writeFileSync(capInput,cappedSource);fs.writeFileSync(capOutput,cappedScript);
     const seeks=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),capInput,capOutput,'seek'],{encoding:'utf8',env:{...process.env,BIND_METHODS:'1'}});assert.equal(seeks.status,0,seeks.stdout+seeks.stderr);
    }
    console.log(`PASS cached receiver-bound methods, both geometry modes and capped timeline seeks: ${kind}/compact=${compact}`);
   }
   console.log(`PASS ${mode}/${kind}/compact=${compact}: full geometry, alpha, culling, painter order, timing and cleanup`);
  }
 }
 const denseFrames=Array.from({length:3},(_,f)=>Float64Array.from({length:2000*8},(_,i)=>{const id=Math.floor(i/8);return [id%3+1,(id*17+f*3)%500-250,(id*11-f*5)%240-120,10+(id+f)%20,10+(id*3+f)%20,(id*13+f)%3600-1800,0xff000000+((id*7919+f*997)%0x1000000),(id+f*100)%2000][i%8];}));
 const denseSource=Player.buildLegacy({width:64,height:32,controls:2000,frames:denseFrames,durations:[.07,.07,.07],fps:15},{imageTemplateIndex:123}),denseInput=path.join(dir,'dense-source.lua');fs.writeFileSync(denseInput,denseSource);
 for(const [mode,code] of Object.entries(buildVariants(denseSource))){const output=path.join(dir,mode+'.lua');fs.writeFileSync(output,code);const result=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),denseInput,output,'jitter','75'],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);process.stdout.write(result.stdout);}
 const maskFrames=[new Float64Array([1,0,0,40,60,0,0xff123456,0])];
 for(let mask=1;mask<32;mask++){const next=maskFrames.at(-1).slice();if(mask&1)next[0]=next[0]===1?3:1;if(mask&2){next[1]+=10;next[2]+=3;}if(mask&4){next[3]++;next[4]+=2;}if(mask&8)next[5]+=37;if(mask&16)next[6]+=111;maskFrames.push(next);}
 const maskSource=Player.buildLegacy({width:64,height:32,controls:1,frames:maskFrames,durations:Array(32).fill(.07),fps:15},{imageTemplateIndex:123}),maskInput=path.join(dir,'masks-source.lua'),maskOutput=path.join(dir,'masks-fast.lua');fs.writeFileSync(maskInput,maskSource);fs.writeFileSync(maskOutput,buildVariants(maskSource).fast);
 const masks=spawnSync(process.execPath,[path.resolve(__dirname,'../../scripts/benchmark-lua-player.cjs'),maskInput,maskOutput,'jitter','75'],{encoding:'utf8',env:{...process.env,BIND_METHODS:'1'}});assert.equal(masks.status,0,masks.stdout+masks.stderr);console.log('PASS every solid-shape changed-field combination in grouped dispatch');
 const two= require('../../scripts/benchmark-standalone-instances.cjs').compare([maskOutput,maskOutput],120);process.stdout.write(two);
 console.log('PASS standalone variants preserve exported headers without modifying JSON or website files');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
