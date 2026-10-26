/* Reproducible native-size quality check. No packages or browser required.
 * node tests/gaussian/benchmark.cjs image.png --count 800 --steps 1200
 *   --detail 512 --out result-prefix
 */
"use strict";
const fs=require("fs"),path=require("path"),zlib=require("zlib");
const P=require("../../js/png-decode.js"),W=require("../../js/worker-gaussian.js");

function png(rgba,width,height){
  const crcTable=Uint32Array.from({length:256},(_,n)=>{
    for(let i=0;i<8;i++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;
  });
  function chunk(type,data){
    const body=Buffer.concat([Buffer.from(type),data]),out=Buffer.alloc(body.length+8);
    out.writeUInt32BE(data.length);body.copy(out,4);let crc=0xffffffff;
    for(const b of body)crc=crcTable[(crc^b)&255]^(crc>>>8);
    out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const rows=Buffer.alloc(height*(width*4+1));
  for(let y=0;y<height;y++)Buffer.from(rgba.buffer,rgba.byteOffset+y*width*4,width*4).copy(rows,y*(width*4+1)+1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),chunk("IDAT",zlib.deflateSync(rows)),chunk("IEND",Buffer.alloc(0))]);
}

function metrics(reference,output,width,height){
  const a=new Float32Array(width*height*3),b=a.slice(),background=[240,240,245];let mse=0,alphaMse=0;
  for(let i=0;i<width*height;i++){
    const p=i*4,oa=output[p+3]/255,ra=reference[p+3]/255;alphaMse+=(oa-ra)**2;
    for(let c=0;c<3;c++){
      const at=i*3+c;
      a[at]=(output[p+c]*oa+background[c]*(1-oa))/255;
      b[at]=(reference[p+c]*ra+background[c]*(1-ra))/255;mse+=(a[at]-b[at])**2;
    }
  }
  mse/=width*height*3;
  const edgeErrors=[];
  for(const distance of [1,3])for(let axis=0;axis<2;axis++){
    const fw=width-(axis===1?distance:0),fh=height-(axis===0?distance:0);
    if(fw<=0||fh<=0)continue;
    const energies=new Float64Array(fw*fh);let i=0;
    const offset=(axis===0?width*distance:distance)*3;
    for(let y=0;y<fh;y++)for(let x=0;x<fw;x++){
      const p=(y*width+x)*3;let energy=0;
      for(let c=0;c<3;c++)energy+=(b[p+offset+c]-b[p+c])**2;energies[i++]=energy;
    }
    const sorted=energies.slice().sort(),threshold=sorted[Math.floor((sorted.length-1)*0.85)];
    let error=0,count=0;i=0;
    for(let y=0;y<fh;y++)for(let x=0;x<fw;x++){
      if(energies[i++]<=threshold)continue;
      const p=(y*width+x)*3;
      for(let c=0;c<3;c++)error+=((a[p+offset+c]-a[p+c])-(b[p+offset+c]-b[p+c]))**2;count+=3;
    }
    if(count)edgeErrors.push(error/count);
  }
  return {rgb_mse:mse,psnr_db:mse?10*Math.log10(1/mse):null,
    edge_mse:edgeErrors.length?edgeErrors.reduce((x,y)=>x+y,0)/edgeErrors.length:0,alpha_mse:alphaMse/(width*height)};
}

async function main(){
  const args=process.argv.slice(2),file=args.shift();
  if(!file||args.length%2)throw Error("Usage: node tests/gaussian/benchmark.cjs image.png [--count 800 --steps 1200 --detail 512 --out prefix]");
  const options={};
  while(args.length){const key=args.shift();if(!["--count","--steps","--detail","--out"].includes(key))throw Error("Unknown option: "+key);options[key]=args.shift();}
  for(const key of ["--count","--steps","--detail"])if(options[key]!=null&&(!Number.isSafeInteger(Number(options[key]))||Number(options[key])<1))throw Error("Invalid positive integer: "+key);
  const source=await P.decode(new Uint8Array(fs.readFileSync(file)));
  const config={num_primitives:Number(options["--count"])||800,gaussian_iterations:Number(options["--steps"])||1200,
    gaussian_resolution:Number(options["--detail"])||512,enable_png_mode:true,seed:1};
  const started=Date.now(),result=await W.processGaussian(source.rgba,source.width,source.height,config);
  const output=new Uint8Array(result.preview_rgba);
  const report={input:path.resolve(file),width:source.width,height:source.height,seconds:(Date.now()-started)/1000,
    primitives:result.elements_count,steps:result.config.gaussian_iterations,detail:result.config.training_size,
    ...metrics(source.rgba,output,source.width,source.height),quality_version:result.config.quality_version};
  if(options["--out"]){
    fs.writeFileSync(options["--out"]+".png",png(output,source.width,source.height));
    fs.writeFileSync(options["--out"]+".json",JSON.stringify(report,null,2)+"\n");
  }
  console.log(JSON.stringify(report,null,2));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={metrics,png};
