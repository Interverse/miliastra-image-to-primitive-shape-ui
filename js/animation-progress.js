/* Coalesce native shape deltas without dropping layers from live previews. */
"use strict";
const AnimationProgress=(()=>{
 class Stream{
  constructor(send,context){this.send=send;this.context=context;this.shapes=new Map();this.svg=null;this.last=0;this.info={};}
  push(data){this.info={step:data.step,total:data.total,phase:data.phase,refinementStep:data.refinementStep,refinementTotal:data.refinementTotal};if(data.previewSvg){this.svg=data.previewSvg;this.directSvg=!!data.directSvg;this.shapes.clear();}if(data.shapeSvg&&Number.isInteger(data.previewIndex))this.shapes.set(data.previewIndex,data.shapeSvg);if(performance.now()-this.last>=100)this.flush();}
  flush(){if(!this.svg&&!this.shapes.size&&!this.info.phase)return;this.send({...this.context,...this.info,type:'animation-frame-progress',previewSvg:this.svg,directSvg:this.directSvg,previewShapes:Array.from(this.shapes,([previewIndex,shapeSvg])=>({previewIndex,shapeSvg}))});this.svg=null;this.shapes.clear();this.last=performance.now();}
 }
 return {Stream};
})();
if(typeof module!=='undefined')module.exports=AnimationProgress;
