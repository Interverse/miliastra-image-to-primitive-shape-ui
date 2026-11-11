/* Keep large, lossless animation compression off the UI thread. */
'use strict';
importScripts('lua-export.js','animation-codec.js?v=1','animation-order.js?v=1','animation-player-runtime.js?v=3','animation-lua.js?v=12');
self.onmessage=({data})=>{
 try{self.postMessage({text:AnimationLua.build(data.animation,data.options)});}
 catch(error){self.postMessage({error:error.message||String(error)});}
};
