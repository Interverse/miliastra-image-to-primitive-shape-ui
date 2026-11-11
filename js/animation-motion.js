/* Motion prediction for Primeval warm starts; never used as output pixels. */
"use strict";
const AnimationMotion=(()=>{
 function gradient(rgba,width,height,limit=120){
  const scale=Math.max(1,Math.max(width,height)/limit),w=Math.max(5,Math.round(width/scale)),h=Math.max(5,Math.round(height/scale));
  const gray=new Float32Array(w*h),colors=new Float32Array(w*h*3),gx=new Float32Array(w*h),gy=new Float32Array(w*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const x0=Math.floor(x*width/w),x1=Math.max(x0+1,Math.floor((x+1)*width/w)),y0=Math.floor(y*height/h),y1=Math.max(y0+1,Math.floor((y+1)*height/h));let sum=0,n=0,r=0,g=0,b=0;for(let yy=y0;yy<y1;yy++)for(let xx=x0;xx<x1;xx++){const p=(Math.min(height-1,yy)*width+Math.min(width-1,xx))*4;const alpha=rgba[p+3]/255;r+=rgba[p]*alpha;g+=rgba[p+1]*alpha;b+=rgba[p+2]*alpha;sum+=(rgba[p]*.2126+rgba[p+1]*.7152+rgba[p+2]*.0722)*alpha;n++;}gray[y*w+x]=sum/n;const color=(y*w+x)*3;colors[color]=r/n;colors[color+1]=g/n;colors[color+2]=b/n;}
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const p=y*w+x;gx[p]=gray[p+1]-gray[p-1];gy[p]=gray[p+w]-gray[p-w];}
  return {w,h,gx,gy,colors};
 }
 function estimateGrid(previous,current,width,height,limit,prior=null){
  const a=gradient(previous,width,height,limit),b=gradient(current,width,height,limit),step=limit<=60?5:6,margin=limit<=60?Math.min(4,Math.floor((Math.min(a.w,a.h)-1)/2)):2,cols=Math.max(1,Math.ceil((a.w-margin*2)/step)),rows=Math.max(1,Math.ceil((a.h-margin*2)/step)),vectors=new Float32Array(cols*rows*2),confidences=new Float32Array(cols*rows),valid=[],stationary=[];
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
   const x=Math.min(a.w-margin-1,margin+col*step),y=Math.min(a.h-margin-1,margin+row*step);let energy=0;
   for(let yy=-margin;yy<=margin;yy++)for(let xx=-margin;xx<=margin;xx++){const p=(y+yy)*a.w+x+xx;energy+=a.gx[p]**2+a.gy[p]**2;}
   if(energy<100)continue;
   function score(dx,dy){if(x+dx<margin||x+dx>=a.w-margin||y+dy<margin||y+dy>=a.h-margin)return -2;let dot=0,other=0;for(let yy=-margin;yy<=margin;yy++)for(let xx=-margin;xx<=margin;xx++){const p=(y+yy)*a.w+x+xx,q=p+dy*a.w+dx;dot+=a.gx[p]*b.gx[q]+a.gy[p]*b.gy[q];other+=b.gx[q]**2+b.gy[q]**2;}return other<100?-2:dot/Math.sqrt(energy*other);}
   const zero=score(0,0),initial=prior?priorSample(prior,x/a.w*width,y/a.h*height):[0,0],centerX=Math.round(initial[0]*a.w/width),centerY=Math.round(initial[1]*a.h/height),radius=prior?4:10;let best=zero,bx=0,by=0;
   for(let dy=centerY-radius;dy<=centerY+radius;dy++)for(let dx=centerX-radius;dx<=centerX+radius;dx++){const candidate=score(dx,dy)-.0001*(dx*dx+dy*dy);if(candidate>best){best=candidate;bx=dx;by=dy;}}
   const confidence=score(bx,by);if(confidence<.72||confidence-zero<.035){if(zero>.85)stationary.push([0,0]);if(zero>.995)confidences[row*cols+col]=zero;continue;}
   function sub(axis){const left=score(bx-(axis===0?1:0),by-(axis===1?1:0)),mid=score(bx,by),right=score(bx+(axis===0?1:0),by+(axis===1?1:0)),denom=left-2*mid+right;return left>-1&&right>-1&&denom<-.001?Math.max(-.5,Math.min(.5,.5*(left-right)/denom)):0;}
   const at=row*cols+col,dx=(bx+sub(0))*width/a.w,dy=(by+sub(1))*height/a.h;
   vectors[at*2]=dx;vectors[at*2+1]=dy;confidences[at]=confidence;valid.push([dx,dy]);
  }
  const globalPoints=valid.concat(stationary);
  const median=axis=>globalPoints.length?globalPoints.map(v=>v[axis]).sort((a,b)=>a-b)[Math.floor(globalPoints.length/2)]:0;
  return {width,height,w:a.w,h:a.h,cols,rows,step,margin,vectors,confidences,colors:a.colors,global:[median(0),median(1)],tracked:valid.length};
 }
 function priorSample(flow,x,y){
  const fx=(x/flow.width*flow.w-(flow.margin??2))/flow.step,fy=(y/flow.height*flow.h-(flow.margin??2))/flow.step,qx=Math.max(0,Math.min(flow.w-1,Math.round(x/flow.width*flow.w))),qy=Math.max(0,Math.min(flow.h-1,Math.round(y/flow.height*flow.h))),q=(qy*flow.w+qx)*3;let best=Infinity,result=[0,0];
  for(let yy=Math.floor(fy)-1;yy<=Math.ceil(fy)+1;yy++)for(let xx=Math.floor(fx)-1;xx<=Math.ceil(fx)+1;xx++){if(xx<0||yy<0||xx>=flow.cols||yy>=flow.rows)continue;const id=yy*flow.cols+xx,confidence=flow.confidences[id];if(confidence<.75)continue;const p=(Math.min(flow.h-(flow.margin??2)-1,(flow.margin??2)+yy*flow.step)*flow.w+Math.min(flow.w-(flow.margin??2)-1,(flow.margin??2)+xx*flow.step))*3;let color=0;for(let c=0;c<3;c++)color+=(flow.colors[p+c]-flow.colors[q+c])**2;if(color>3*70**2)continue;const cost=(xx-fx)**2+(yy-fy)**2+color/1500+(1-confidence)*4;if(cost<best){best=cost;result=[flow.vectors[id*2],flow.vectors[id*2+1]];}}
  return result;
 }
 function estimate(previous,current,width,height){const coarse=estimateGrid(previous,current,width,height,60);return estimateGrid(previous,current,width,height,120,coarse);}
 function sample(flow,x,y){
  const fx=Math.max(0,Math.min(flow.cols-1,(x/flow.width*flow.w-(flow.margin??2))/flow.step)),fy=Math.max(0,Math.min(flow.rows-1,(y/flow.height*flow.h-(flow.margin??2))/flow.step)),x0=Math.floor(fx),y0=Math.floor(fy),x1=Math.min(x0+1,flow.cols-1),y1=Math.min(y0+1,flow.rows-1),tx=fx-x0,ty=fy-y0;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,plainX=0,plainY=0;
  for(let corner=0;corner<4;corner++){const xx=corner%2?x1:x0,yy=corner>1?y1:y0,weight=(corner%2?tx:1-tx)*(corner>1?ty:1-ty),at=(yy*flow.cols+xx)*2;if(weight>.01){minX=Math.min(minX,flow.vectors[at]);maxX=Math.max(maxX,flow.vectors[at]);minY=Math.min(minY,flow.vectors[at+1]);maxY=Math.max(maxY,flow.vectors[at+1]);}plainX+=flow.vectors[at]*weight;plainY+=flow.vectors[at+1]*weight;}
  if(maxX-minX<1&&maxY-minY<1)return [plainX,plainY];
  const query=(Math.max(0,Math.min(flow.h-1,Math.round(y/flow.height*flow.h)))*flow.w+Math.max(0,Math.min(flow.w-1,Math.round(x/flow.width*flow.w))))*3;
  let sum=0,dx=0,dy=0;
  for(let corner=0;corner<4;corner++){const xx=corner%2?x1:x0,yy=corner>1?y1:y0;let weight=(corner%2?tx:1-tx)*(corner>1?ty:1-ty);
   if(flow.colors){const at=(Math.min(flow.h-(flow.margin??2)-1,(flow.margin??2)+yy*flow.step)*flow.w+Math.min(flow.w-(flow.margin??2)-1,(flow.margin??2)+xx*flow.step))*3;let distance=0;for(let c=0;c<3;c++)distance+=(flow.colors[at+c]-flow.colors[query+c])**2;weight*=Math.exp(-distance/2700);}
   const at=(yy*flow.cols+xx)*2;dx+=flow.vectors[at]*weight;dy+=flow.vectors[at+1]*weight;sum+=weight;
  }
  return sum<.03?[0,0]:[dx/sum,dy/sum];
 }
 function predict(drawing,flow){
  const sx=drawing.width/flow.width,sy=drawing.height/flow.height;
  return {...drawing,shapes:drawing.shapes.map(shape=>{
   const g=shape.geometry;let x,y,u,v,apex=0,a=1,b=2;
   if(shape.kind==='ellipse'){const angle=g[4]*Math.PI/180;x=g[0];y=g[1];u=[Math.cos(angle)*g[2],Math.sin(angle)*g[2]];v=[-Math.sin(angle)*g[3],Math.cos(angle)*g[3]];}
   else if(shape.kind==='rectangle'){x=g[0]+g[2]/2;y=g[1]+g[3]/2;u=[g[2]/2,0];v=[0,g[3]/2];}
   else if(g.length===8){x=(g[0]+g[2]+g[4]+g[6])/4;y=(g[1]+g[3]+g[5]+g[7])/4;u=[(g[2]-g[0])/2,(g[3]-g[1])/2];v=[(g[6]-g[0])/2,(g[7]-g[1])/2];}
   else{let best=Infinity;for(let i=0;i<3;i++){const j=(i+1)%3,k=(i+2)%3,ux=(g[k*2]-g[j*2])/2,uy=(g[k*2+1]-g[j*2+1])/2,vx=g[i*2]-(g[j*2]+g[k*2])/2,vy=g[i*2+1]-(g[j*2+1]+g[k*2+1])/2,error=Math.abs(ux*vx+uy*vy)/Math.max(1e-9,Math.hypot(ux,uy)*Math.hypot(vx,vy));if(error<best){best=error;apex=i;a=j;b=k;u=[ux,uy];v=[vx,vy];x=(g[i*2]+(g[j*2]+g[k*2])/2)/2;y=(g[i*2+1]+(g[j*2+1]+g[k*2+1])/2)/2;}}}
   const area=4*Math.hypot(...u)*Math.hypot(...v),large=area>drawing.width*drawing.height*.15;let point=sample(flow,x/sx,y/sy),localLarge=false;
   if(large){let best=Infinity,chosen=null;for(const [du,dv] of [[0,0],[-.5,0],[.5,0],[0,-.5],[0,.5]]){const px=(x+du*u[0]+dv*v[0])/sx,py=(y+du*u[1]+dv*v[1])/sy,xx=Math.max(0,Math.min(flow.w-1,Math.round(px/flow.width*flow.w))),yy=Math.max(0,Math.min(flow.h-1,Math.round(py/flow.height*flow.h)));let error=0;for(let c=0;c<3;c++)error+=(flow.colors[(yy*flow.w+xx)*3+c]-shape.color[c])**2;if(error<best){best=error;chosen=[px,py];}}if(best<3*80**2){point=sample(flow,...chosen);localLarge=Math.hypot(...point)>.5;}else point=flow.global;}

   let j00=1,j01=0,j10=0,j11=1;
   if(!large||localLarge){const px=x/sx,py=y/sy,limit=Math.max(4,Math.hypot(...point)*.25),neighbor=(dx,dy)=>{const v=sample(flow,px+dx,py+dy);return Math.hypot(v[0]-point[0],v[1]-point[1])>limit?point:v;},left=neighbor(-8,0),right=neighbor(8,0),top=neighbor(0,-8),bottom=neighbor(0,8);j00+=(right[0]-left[0])/16;j01=(bottom[0]-top[0])/16*sx/sy;j10=(right[1]-left[1])/16*sy/sx;j11+=(bottom[1]-top[1])/16;}
   const tu=[j00*u[0]+j01*u[1],j10*u[0]+j11*u[1]],tv=[j00*v[0]+j01*v[1],j10*v[0]+j11*v[1]];
   const scaleU=Math.max(.8,Math.min(1.2,Math.hypot(...tu)/Math.max(1e-9,Math.hypot(...u)))),scaleV=Math.max(.8,Math.min(1.2,Math.hypot(...tv)/Math.max(1e-9,Math.hypot(...v))));
   let rotation=Math.atan2(tu[1],tu[0])-Math.atan2(u[1],u[0]);rotation=Math.atan2(Math.sin(rotation),Math.cos(rotation));rotation=Math.max(-.12,Math.min(.12,rotation));
   const cos=Math.cos(rotation),sin=Math.sin(rotation),ru=[(u[0]*cos-u[1]*sin)*scaleU,(u[0]*sin+u[1]*cos)*scaleU],rv=[(v[0]*cos-v[1]*sin)*scaleV,(v[0]*sin+v[1]*cos)*scaleV],cx=x+point[0]*sx,cy=y+point[1]*sy;
   let geometry;
   if(shape.kind==='ellipse')geometry=[cx,cy,g[2]*scaleU,g[3]*scaleV,g[4]+rotation*180/Math.PI];
   else if(shape.kind==='rectangle')geometry=[cx-ru[0]-rv[0],cy-ru[1]-rv[1],cx+ru[0]-rv[0],cy+ru[1]-rv[1],cx+ru[0]+rv[0],cy+ru[1]+rv[1],cx-ru[0]+rv[0],cy-ru[1]+rv[1]];
   else if(g.length===8)geometry=[cx-ru[0]-rv[0],cy-ru[1]-rv[1],cx+ru[0]-rv[0],cy+ru[1]-rv[1],cx+ru[0]+rv[0],cy+ru[1]+rv[1],cx-ru[0]+rv[0],cy-ru[1]+rv[1]];
   else{geometry=g.slice();geometry[apex*2]=cx+rv[0]/2;geometry[apex*2+1]=cy+rv[1]/2;geometry[a*2]=cx-rv[0]/2-ru[0];geometry[a*2+1]=cy-rv[1]/2-ru[1];geometry[b*2]=cx-rv[0]/2+ru[0];geometry[b*2+1]=cy-rv[1]/2+ru[1];}
   return {...shape,kind:shape.kind==='rectangle'?'polygon':shape.kind,geometry};
  })};
 }
 function warpImportance(map,flow){if(!map||!flow.tracked)return map;const values=new Float32Array(map.values.length);
  for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++){const v=sample(flow,(x+.5)/map.width*flow.width,(y+.5)/map.height*flow.height),sx=Math.max(0,Math.min(map.width-1,x-v[0]/flow.width*map.width)),sy=Math.max(0,Math.min(map.height-1,y-v[1]/flow.height*map.height)),x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(x0+1,map.width-1),y1=Math.min(y0+1,map.height-1),tx=sx-x0,ty=sy-y0;values[y*map.width+x]=(map.values[y0*map.width+x0]*(1-tx)+map.values[y0*map.width+x1]*tx)*(1-ty)+(map.values[y1*map.width+x0]*(1-tx)+map.values[y1*map.width+x1]*tx)*ty;}
  return {...map,values};
 }
 function quality(source,sourceWidth,sourceHeight,fitted,width,height,map){let loss=0,focusLoss=0,mass=0,n=0,gradientLoss=0,focusGradient=0;
  for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2){const a=(Math.min(sourceHeight-1,y)*sourceWidth+Math.min(sourceWidth-1,x))*4,b=(y*width+x)*4,ta=source[a+3]/255,pa=fitted[b+3]/255;let error=4*(ta-pa)**2;for(let c=0;c<3;c++)error+=(source[a+c]/255*ta-fitted[b+c]/255*pa)**2;let attention=1;
   if(map){const sx=Math.max(0,Math.min(map.width-1,(x+.5)/width*map.width-.5)),sy=Math.max(0,Math.min(map.height-1,(y+.5)/height*map.height-.5)),x0=Math.floor(sx),y0=Math.floor(sy),x1=Math.min(x0+1,map.width-1),y1=Math.min(y0+1,map.height-1),tx=sx-x0,ty=sy-y0;attention=(map.values[y0*map.width+x0]*(1-tx)+map.values[y0*map.width+x1]*tx)*(1-ty)+(map.values[y1*map.width+x0]*(1-tx)+map.values[y1*map.width+x1]*tx)*ty;}
   let gradient=0;const left=(Math.min(sourceHeight-1,y)*sourceWidth+Math.max(0,x-2))*4,above=(Math.max(0,y-2)*sourceWidth+Math.min(sourceWidth-1,x))*4,la=source[left+3]/255,ua=source[above+3]/255;
   for(let c=0;c<3;c++)gradient+=Math.abs(source[a+c]/255*ta-source[left+c]/255*la)+Math.abs(source[a+c]/255*ta-source[above+c]/255*ua);
   gradient+=4*(Math.abs(ta-la)+Math.abs(ta-ua));
   const weight=attention*attention;gradientLoss+=gradient;focusGradient+=gradient*weight;loss+=error;focusLoss+=error*weight;mass+=weight;n++;
  }const global=Math.sqrt(loss/Math.max(1,n*7));return {global,focus:mass<1e-9?global:Math.sqrt(focusLoss/(mass*7)),complexity:Math.max(1e-9,gradientLoss/Math.max(1,n*7))**.4,focusComplexity:Math.max(1e-9,focusGradient/Math.max(1e-9,mass*7))**.4};
 }
 // Spatial block changes plus histogram distance distinguish jump cuts from
 // small tracked motion. The former raw threshold missed same-palette cuts.
 function sceneChange(previous,current,width,height){
  let difference=0,changed=0,n=0;const ha=new Float64Array(48),hb=new Float64Array(48);
  const step=Math.max(2,Math.floor(Math.max(width,height)/32));
  for(let y=0;y<height;y+=step)for(let x=0;x<width;x+=step){const a=[0,0,0],b=[0,0,0];let count=0;for(let dy=0;dy<step&&y+dy<height;dy++)for(let dx=0;dx<step&&x+dx<width;dx++){const p=((y+dy)*width+x+dx)*4,aa=previous[p+3]/255,ab=current[p+3]/255;for(let c=0;c<3;c++){a[c]+=previous[p+c]*aa;b[c]+=current[p+c]*ab;}count++;}let delta=0;for(let c=0;c<3;c++){a[c]/=count;b[c]/=count;delta+=Math.abs(a[c]-b[c]);ha[c*16+Math.min(15,Math.floor(a[c]/16))]++;hb[c*16+Math.min(15,Math.floor(b[c]/16))]++;}delta/=3;difference+=delta;if(delta>24)changed++;n++;}
  let histogram=0;for(let i=0;i<ha.length;i++)histogram+=Math.abs(ha[i]-hb[i]);difference/=Math.max(1,n);changed/=Math.max(1,n);histogram/=Math.max(1,n*6);
  return {cut:difference>55||(difference>32&&changed>.45&&histogram>.06),difference,changed,histogram};
 }
 // Compare edges after a 3x3 box filter: GIF checkerboard dithering must
 // not dominate the guard while real facial outlines disappear.
 function detailQuality(source,sw,sh,fitted,width,height,map){
  function blur(data,w,h){
   const small=new Float32Array(width*height*4),out=new Float32Array(small.length);
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(y*width+x)*4,x0=Math.floor(x*w/width),x1=Math.max(x0+1,Math.floor((x+1)*w/width)),y0=Math.floor(y*h/height),y1=Math.max(y0+1,Math.floor((y+1)*h/height));let n=0;for(let sy=y0;sy<y1;sy++)for(let sx=x0;sx<x1;sx++){const q=(Math.min(h-1,sy)*w+Math.min(w-1,sx))*4,alpha=data[q+3]/255;for(let c=0;c<3;c++)small[p+c]+=data[q+c]/255*alpha;small[p+3]+=alpha;n++;}for(let c=0;c<4;c++)small[p+c]/=n;}
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){const p=(y*width+x)*4;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const q=(Math.max(0,Math.min(height-1,y+dy))*width+Math.max(0,Math.min(width-1,x+dx)))*4;for(let c=0;c<4;c++)out[p+c]+=small[q+c]/9;}}return out;
  }
  const a=blur(source,sw,sh),b=blur(fitted,width,height);let error=0,energy=0,fitEnergy=0,focusError=0,focusEnergy=0,focusFit=0;
  for(let y=2;y<height-2;y+=2)for(let x=2;x<width-2;x+=2){let weight=1;if(map){const mx=Math.min(map.width-1,Math.floor(x/width*map.width)),my=Math.min(map.height-1,Math.floor(y/height*map.height));weight=map.values[my*map.width+mx]**2;}
   const p=(y*width+x)*4;for(const offset of [8,width*8])for(let c=0;c<4;c++){const gain=c===3?4:1,da=a[p+offset+c]-a[p-offset+c],db=b[p+offset+c]-b[p-offset+c],e=gain*(da-db)**2,sa=gain*da*da,sb=gain*db*db;error+=e;energy+=sa;fitEnergy+=sb;focusError+=e*weight;focusEnergy+=sa*weight;focusFit+=sb*weight;}}
  const edge=energy>1e-8?Math.sqrt(error/energy):0,retention=energy>1e-8?Math.sqrt(fitEnergy/energy):1;
  return {edge,focusEdge:focusEnergy>1e-8?Math.sqrt(focusError/focusEnergy):edge,retention,focusRetention:focusEnergy>1e-8?Math.sqrt(focusFit/focusEnergy):retention};
 }
 function detailAccepts(reference,value,preflight=false){
  if(!reference)return true;const errorFactor=preflight?3:1.35,retentionFactor=preflight ? .45 : .90;
  return value.edge<=reference.edge*errorFactor+.02&&value.focusEdge<=reference.focusEdge*errorFactor+.02&&value.retention>=reference.retention*retentionFactor&&value.focusRetention>=reference.focusRetention*retentionFactor;
 }
 return {estimate,sample,predict,warpImportance,quality,detailQuality,detailAccepts,sceneChange};
})();
if(typeof module!=='undefined')module.exports=AnimationMotion;
