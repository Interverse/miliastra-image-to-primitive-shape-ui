'use strict';
const fs=require('node:fs'),path=require('node:path');
const {extract}=require('./upgrade-animation-player.cjs'),{optimize}=require('./animation-draw-order.cjs');
function buildPipeline(source){
 const optimized=optimize(source),meta=extract(optimized.source);
 const header=Object.entries(meta.lines).map(([name,value])=>'local '+name+'='+value).join('\n');
 const shared=fs.readFileSync(path.join(__dirname,'lua/animation-shared.lua'),'utf8');
 const runtime=fs.readFileSync(path.join(__dirname,'lua/animation-pipeline.lua'),'utf8').replace('-- @FAST_DISPATCH@',require('./animation-dispatch.cjs')(true));
 return '-- Animation pipeline experiment: rolling pools; fitted values preserved.\n'+header+'\nlocal VARIANT="pipeline"\nlocal LOSSLESS_DRAW_ORDER=true\n'+shared+'\n'+runtime;
}
if(require.main===module){const [input,prefix]=process.argv.slice(2);if(!input||!prefix||!/^[-a-zA-Z0-9_]+$/.test(prefix))throw Error('Usage: <saved.lua> <simple-output-prefix>');const output=path.resolve(__dirname,'../Lua',prefix+'_client_pipeline.lua');if(path.resolve(input)===output)throw Error('Preserve the input');if(fs.existsSync(output)&&!fs.readFileSync(output,'utf8').startsWith('-- Animation pipeline experiment:'))throw Error('Refusing to overwrite unrelated script');const code=buildPipeline(fs.readFileSync(input,'utf8'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,code);console.log(JSON.stringify({output,bytes:Buffer.byteLength(code)}));}
module.exports={buildPipeline};
