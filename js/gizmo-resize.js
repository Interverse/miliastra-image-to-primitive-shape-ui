/* Rotated box edges are draggable along their own local axis. */
(function(root){
  const local=(box,p)=>{const x=p.x-box.c.x,y=p.y-box.c.y;return {x:x*Math.cos(box.a)+y*Math.sin(box.a),y:-x*Math.sin(box.a)+y*Math.cos(box.a)};};
  function hit(box,p,tolerance){
    const q=local(box,p),w=box.w,h=box.h;
    const segment=(x,y,dx,dy)=>{const t=Math.max(0,Math.min(1,((q.x-x)*dx+(q.y-y)*dy)/(dx*dx+dy*dy)));return Math.hypot(q.x-x-t*dx,q.y-y-t*dy);};
    const edges=[segment(-w,-h,2*w,0),segment(w,-h,0,2*h),segment(w,h,-2*w,0),segment(-w,h,0,-2*h)];
    const side=edges.indexOf(Math.min(...edges));
    const corner=Math.min(...[-w,w].flatMap(x=>[-h,h].map(y=>Math.hypot(q.x-x,q.y-y))));
    const middle=Math.min(Math.hypot(q.x,q.y+h),Math.hypot(q.x-w,q.y),Math.hypot(q.x,q.y-h),Math.hypot(q.x+w,q.y));
    if(corner<tolerance*0.7&&corner<middle)return {axis:'xy',side:null};
    return edges[side]<=tolerance?{axis:side%2?'x':'y',side}:null;
  }
  function resize(box,start,p,side,minSize){
    const from=local(box,start),to=local(box,p),xAxis=side%2===1,sign=side===1||side===2?1:-1;
    const oldSize=2*(xAxis?box.w:box.h),delta=(xAxis?to.x-from.x:to.y-from.y)*sign;
    const size=Math.max(minSize,oldSize+delta),shift=sign*(size-oldSize)/2;
    return {sx:xAxis?size/oldSize:1,sy:xAxis?1:size/oldSize,c:{x:box.c.x+(xAxis?shift*Math.cos(box.a):-shift*Math.sin(box.a)),y:box.c.y+(xAxis?shift*Math.sin(box.a):shift*Math.cos(box.a))}};
  }
  root.GizmoResize={hit,resize};if(typeof module!=='undefined')module.exports=root.GizmoResize;
})(typeof self!=='undefined'?self:globalThis);
