/* Reuse untouched native geometry; reconstruct only edited assets. */
(function(root){
  const originalMaps=new WeakMap();
  function drawing(data,original,originalElements){
    const unit=Number(data.config.image_scale)||1,W=data.image_size.width,H=data.image_size.height;
    const scale=Math.min(W/original.width,H/original.height),ox=(W-original.width*scale)/2,oy=(H-original.height*scale)/2;
    let originals=originalMaps.get(original);if(!originals){originals=new Map();let index=0;for(const el of originalElements)if(!el.is_background)originals.set(JSON.stringify(el),original.shapes[index++]);originalMaps.set(original,originals);}
    const color=e=>{const hex=e.color.replace('#','');return [0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)).concat(Math.round(e.alpha*255));};
    const result={width:original.width,height:original.height,background:[0,0,0,0],shapes:[]};
    for(const e of data.elements){
      if(e.is_background){result.background=color(e);continue;}
      const old=originals.get(JSON.stringify(e));if(old){result.shapes.push(old);continue;}
      const x=(e.center.x/unit-ox)/scale,y=(-e.center.y/unit-oy)/scale,a=-(typeof e.rotation==='object'?e.rotation.z:e.rotation||0);
      let kind,geometry;
      if(e.type==='ellipse'){kind='ellipse';geometry=[x,y,e.size.rx/unit/scale,e.size.ry/unit/scale,a];}
      else{
        kind='polygon';const w=e.size.width/unit/scale,h=e.size.height/unit/scale,c=Math.cos(a*Math.PI/180),s=Math.sin(a*Math.PI/180);
        const points=e.type==='triangle'?[[0,-h/2],[-w/2,h/2],[w/2,h/2]]:[[-w/2,-h/2],[w/2,-h/2],[w/2,h/2],[-w/2,h/2]];
        const pivot=e.type==='triangle'&&e.triangle_pivot!=='box'?-h/6:0;
        geometry=points.flatMap(([px,py])=>[x+px*c-(py+pivot)*s,y+px*s+(py+pivot)*c]);
      }
      result.shapes.push({kind,geometry,color:color(e)});
    }
    return result;
  }
  let worker,serial=0;const pending=new Map();
  function render(data,original,originalElements){
    if(!worker){worker=new Worker('js/worker-native-render.js?v=2');worker.onmessage=({data})=>{const p=pending.get(data.id);if(!p)return;pending.delete(data.id);data.error?p.reject(Error(data.error)):p.resolve(data.result);};worker.onerror=e=>{for(const p of pending.values())p.reject(Error(e.message));pending.clear();worker.terminate();worker=null;};}
    return new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});worker.postMessage({id,drawing:drawing(data,original,originalElements),outputSize:Math.max(data.image_size.width,data.image_size.height)});});
  }
  root.NativeEdit={drawing,render};
  if(typeof module!=='undefined')module.exports={drawing};
})(typeof self!=='undefined'?self:globalThis);
