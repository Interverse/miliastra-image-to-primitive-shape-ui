/* Replace only the player of a recognized channel-compressed animation export.
 * Data/geometry/timing are parsed as literals, never executed from the input.
 * node scripts/upgrade-animation-player.cjs <input.lua> <workspace/Lua/output.lua>
 */
'use strict';
const fs=require('fs'),path=require('path');global.LuaExport=require('../js/lua-export.js');const Player=require('../js/animation-lua.js');
function extract(source){
 const names=['IMAGE_TEMPLATE_INDEX','PLAYBACK_FPS','ENCODED_FPS','WIDTH,W,H,N','GEOMETRY,ROTATION,COMPACT','LOOP','DATA','books','durations','moveCounts'],lines={};
 for(const name of names){const match=source.match(new RegExp('^local '+name+'=([^\\r\\n]*)','m'));if(!match)throw Error('Unrecognized animation codec: '+name);lines[name]=match[1];}
 for(const name of ['CODEC','COLOR_TRANSFORM']){const match=source.match(new RegExp('^local '+name+'=([^\\r\\n]*)','m'));if(match)lines[name]=match[1];}
 if(lines.CODEC!==undefined&&!['1','2'].includes(lines.CODEC))throw Error('Unknown animation codec');
 if(lines.COLOR_TRANSFORM!==undefined&&!['true','false'].includes(lines.COLOR_TRANSFORM))throw Error('Invalid color transform');
 const scalar=name=>Number(lines[name].split('--')[0].trim()),array=name=>{const value=lines[name].trim();if(!/^[0-9{},\s-]+$/.test(value))throw Error('Invalid literal: '+name);return JSON.parse(value.replaceAll('{','[').replaceAll('}',']'));};
 const dimensions=lines['WIDTH,W,H,N'].split(',').map(Number);
 if(dimensions.length!==4||dimensions.some(v=>!Number.isFinite(v)||v<=0)||!Number.isSafeInteger(dimensions[3]))throw Error('Invalid dimensions');
 if(!/^"[A-Za-z0-9_-]*"$/.test(lines.DATA.trim()))throw Error('Invalid encoded data');
 if(!['0.1,0.1,false','0.5,1,true'].includes(lines['GEOMETRY,ROTATION,COMPACT'].trim()))throw Error('Unknown quantization');
 if(!['true','false'].includes(lines.LOOP.trim()))throw Error('Invalid loop flag');
 for(const name of ['IMAGE_TEMPLATE_INDEX','PLAYBACK_FPS','ENCODED_FPS'])if(!Number.isSafeInteger(scalar(name))||scalar(name)<0)throw Error('Invalid '+name);
 const books=array('books'),durations=array('durations'),moveCounts=array('moveCounts');
 if(books.length!==12||!durations.length||moveCounts.length!==durations.length+1||durations.some(v=>!Number.isSafeInteger(v)||v<=0)||moveCounts.some(v=>!Number.isSafeInteger(v)||v<0||v%2))throw Error('Invalid animation tables');
 for(const book of books)if(!Array.isArray(book)||book.length!==2||!Number.isSafeInteger(book[0])||!Array.isArray(book[1])||book[1].some(v=>!Number.isSafeInteger(v)))throw Error('Invalid Huffman table');
 return {lines,dimensions,books,durations,moveCounts,compact:lines['GEOMETRY,ROTATION,COMPACT'].trim().endsWith('true'),templateIndex:scalar('IMAGE_TEMPLATE_INDEX')};
}
function upgrade(source){
 const meta=extract(source);
 if(meta.lines.CODEC!==undefined){
  const runtime=require('../js/animation-player-runtime.js');
  const body=meta.lines.CODEC==='2'?runtime.replace('LOAD_BATCH,SPAWN_BATCH,ORDER_BATCH=6144,128,256','LOAD_BATCH,SPAWN_BATCH,ORDER_BATCH=384,128,256'):runtime.replace(/-- @BEGIN_RANGE_CODEC@[\s\S]*?-- @END_RANGE_CODEC@\r?\n/,'').replaceAll('releaseRange() ','');
  const order=source.match(/^local LOSSLESS_DRAW_ORDER=(true|false)\s*$/m)?.[0]||'';
  return {code:Object.entries(meta.lines).map(([name,value])=>'local '+name+'='+value).join('\n')+'\nlocal VARIANT="fast"\n'+order+'\n'+Player.minify(body)+'\n',meta};
 }
 const dummy={width:1,height:1,controls:1,frames:[new Float64Array([2,0,0,10,10,0,0xffffffff,0])],durations:[1],fps:0};
 let code=Player.buildLegacy(dummy,{imageTemplateIndex:meta.templateIndex});
 for(const [name,value] of Object.entries(meta.lines))code=code.replace(new RegExp('^local '+name+'=[^\\r\\n]*','m'),()=> 'local '+name+'='+value);
 return {code,meta};
}
if(require.main===module){const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: <input.lua> <workspace/Lua/output.lua>');const target=path.resolve(output),luaDir=path.resolve(__dirname,'../Lua');if(!target.startsWith(luaDir+path.sep))throw Error('Output must be inside workspace/Lua');if(path.resolve(input)===target)throw Error('Preserve the input export');const {code,meta}=upgrade(fs.readFileSync(input,'utf8'));if(fs.existsSync(target)&&!fs.readFileSync(target,'utf8').startsWith('-- Budgeted player replacement'))throw Error('Refusing to overwrite unrelated script');fs.mkdirSync(luaDir,{recursive:true});fs.writeFileSync(target,'-- Budgeted player replacement; fitted data, scale and timing preserved.\n'+code);console.log(JSON.stringify({output:target,controlsPerBuffer:meta.dimensions[3],frames:meta.durations.length,compact:meta.compact}));}
module.exports={extract,upgrade};
