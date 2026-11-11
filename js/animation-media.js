/* Read GIF timing without decoding pixels; only used to avoid needless resampling. */
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
 return {gifTiming};
})();
if(typeof module!=='undefined')module.exports=AnimationMedia;
