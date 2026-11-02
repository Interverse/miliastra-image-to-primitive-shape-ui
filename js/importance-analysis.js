/* General visual-attention preprocessing. Inference lives in its own worker. */
export function normalizeAttention(values,width,height,alpha){
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height!==values.length||alpha.length!==values.length)throw Error('Invalid importance map');
  const visible=[];
  for(let i=0;i<values.length;i++){if(!Number.isFinite(values[i]))throw Error('Invalid importance map');if(alpha[i]>0)visible.push(values[i]);}
  if(!visible.length)return null;
  visible.sort((a,b)=>a-b);
  const low=visible[Math.floor((visible.length-1)*0.02)],high=visible[Math.floor((visible.length-1)*0.98)];
  if(high-low<=1e-12)return null;
  const result=new Float32Array(values.length);
  // Range comes from visible pixels; transparent pixels keep their value so the
  // fitter can protect attended holes (eyes, counters of letters) from paint.
  for(let i=0;i<values.length;i++)result[i]=Math.max(0,Math.min(1,(values[i]-low)/(high-low)));
  return {width,height,values:result};
}

export function prepareAttention(rgba,width,height,matte=[128,128,128]){
  if(rgba.length!==width*height*4||width<1||height<1)throw Error('Invalid analysis image');
  const source=new OffscreenCanvas(width,height),ctx=source.getContext('2d');
  const pixels=new Uint8ClampedArray(rgba.length);
  for(let i=0;i<rgba.length;i+=4){const a=rgba[i+3]/255;for(let c=0;c<3;c++)pixels[i+c]=rgba[i+c]*a+matte[c]*(1-a);pixels[i+3]=255;}
  ctx.putImageData(new ImageData(pixels,width,height),0,0);
  const w=384,h=288,scale=Math.min(w/width,h/height),dw=Math.max(1,Math.round(width*scale)),dh=Math.max(1,Math.round(height*scale));
  const x=Math.floor((w-dw)/2),y=Math.floor((h-dh)/2);
  const canvas=new OffscreenCanvas(w,h),out=canvas.getContext('2d');out.fillStyle=`rgb(${matte.join(',')})`;out.fillRect(0,0,w,h);out.drawImage(source,x,y,dw,dh);
  const data=out.getImageData(0,0,w,h).data,tensor=new Float32Array(3*w*h),mean=[.485,.456,.406],std=[.229,.224,.225];
  for(let i=0;i<w*h;i++)for(let c=0;c<3;c++)tensor[c*w*h+i]=(data[i*4+c]/255-mean[c])/std[c];
  return {tensor,crop:{x,y,width:dw,height:dh},width:w,height:h};
}

export function cropAttention(values,crop,stride){
  const result=new Float32Array(crop.width*crop.height);
  for(let y=0;y<crop.height;y++)result.set(values.subarray((crop.y+y)*stride+crop.x,(crop.y+y)*stride+crop.x+crop.width),y*crop.width);
  return result;
}
