/* Offline experiments for saved animation exports; no website changes.
 * node scripts/prepare-animation-variants.cjs <saved.lua> [output-prefix]
 */
'use strict';
const fs=require('fs'),path=require('path'),{extract}=require('./upgrade-animation-player.cjs');
const dispatchSource=require('./animation-dispatch.cjs');
const {optimize}=require('./animation-draw-order.cjs');
const kernels=require('./animation-kernel.cjs');
function buildVariants(source,options={}){
 source=require('./animation-payload.cjs').asHuffman(source);
 const shared=fs.readFileSync(path.join(__dirname,'lua/animation-shared.lua'),'utf8'),optimized=optimize(source);
 return Object.fromEntries(['fast','preloaded'].map(mode=>{
  const meta=extract(mode==='fast'?optimized.source:source),header=Object.entries(meta.lines).map(([name,value])=>'local '+name+'='+value).join('\n');
  const kernel=options.kernel||{layout:'hybrid',blockSize:8,unroll:1,hoist:false};
  let runtime=fs.readFileSync(path.join(__dirname,'lua/animation-'+mode+'.lua'),'utf8').replace('-- @FAST_DISPATCH@',mode==='fast'&&kernel.layout!=='flat'?kernels.generate(kernel):dispatchSource()).replace('-- @APPEND_COMMAND@',kernels.append(kernel.layout,kernel.blockSize));
  if(mode==='fast'){
   const policy=options.nativeTransactions?fs.readFileSync(path.join(__dirname,'lua/animation-native-transaction.lua'),'utf8'):'local function initNativePolicy() return false end\nlocal function nativeTransaction(apply,target) apply(target) end\nlocal function destroyNativePolicy() end';
   runtime=runtime.replace('-- @NATIVE_TRANSACTION@',policy);
   if(!options.nativeTransactions)runtime=runtime.replace(/^local (?:NATIVE_TRANSACTION_MODE|AUTO_NATIVE_UPDATES|NATIVE_TEST_SECONDS)=[^\r\n]*\r?\n/gm,'');
  }
  if(mode==='fast'){
   if(kernel.scalarRotation)runtime=runtime.replace('then s[6](control,0,0,frame[a+6]) end','then control.localRotationZ=frame[a+6] end');
   runtime=runtime.replace(/^local TRANSFORM_GEOMETRY=true[^\r\n]*\r?\n/m,'').replace(/^local MAX_FRAME_CALLS=[^\r\n]*\r?\n/m,'');
   if(options.nativeBatch){
    const native=fs.readFileSync(path.join(__dirname,'lua/animation-native-batch.lua'),'utf8').replace(/^local TRANSFORM_GEOMETRY=true[^\r\n]*\r?\n/m,'').replace(/^local MAX_FRAME_CALLS=[^\r\n]*\r?\n/m,'');
    runtime='local USE_NATIVE_BATCH=NATIVE_BATCH and N*#durations<=NATIVE_CACHE_LIMIT and game.TweenSequence and game.Tween\nif NATIVE_BATCH and not USE_NATIVE_BATCH then print("GIF: native API unavailable or cache limit exceeded; direct playback active.") end\nlocal MAX_FRAME_CALLS=USE_NATIVE_BATCH and (2*N+2) or (6*N+2)\nif USE_NATIVE_BATCH then\n'+native+'\nelse\n'+runtime+'\nend';
   }else runtime='local MAX_FRAME_CALLS=6*N+2\n'+runtime;
  }
  return [mode,'-- Animation playback experiment: '+mode+'; fitted primitive values preserved.\n'+(mode==='fast'?'local NATIVE_BATCH='+Boolean(options.nativeBatch)+' -- Experimental native cache failed in-game; direct updates are the default.\nlocal NATIVE_CACHE_LIMIT=65536 -- Above this estimate, use direct playback; never remove frames.\nlocal TRANSFORM_GEOMETRY=true\n':'')+header+'\nlocal VARIANT="'+mode+'"\n'+(mode==='fast'?'local LOSSLESS_DRAW_ORDER=true -- Only disjoint padded draw bounds may exchange order.\n-- Offline planning: '+JSON.stringify(optimized.report)+'\n':'')+shared+'\n'+runtime];
 }));
}
if(require.main===module){
 const [input,prefix='jahoda']=process.argv.slice(2);if(!input||!/^[-a-zA-Z0-9_]+$/.test(prefix))throw Error('Usage: <saved.lua> [simple-output-prefix]');
 const variants=buildVariants(fs.readFileSync(input,'utf8')),dir=path.resolve(__dirname,'../Lua');fs.mkdirSync(dir,{recursive:true});
 for(const [mode,code] of Object.entries(variants)){const output=path.join(dir,prefix+'_client_'+mode+'.lua');if(path.resolve(input)===output)throw Error('Preserve the source');if(fs.existsSync(output)&&!fs.readFileSync(output,'utf8').startsWith('-- Animation playback experiment:'))throw Error('Refusing to overwrite unrelated script');fs.writeFileSync(output,code);console.log(JSON.stringify({output,bytes:Buffer.byteLength(code)}));}
}
module.exports={buildVariants};
