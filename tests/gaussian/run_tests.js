/* node tests/gaussian/run_tests.js — no third-party dependencies */
"use strict";
const assert = require("assert/strict"), fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.resolve(__dirname, "../..");
const W = require(path.join(root, "js/worker-gaussian.js"));
const Seeds = require(path.join(root, "js/gaussian-seed.js"));
const G = require(path.join(root, "js/gia.js"));
const Export = require(path.join(root, "js/gia-export.js"));
const Lua = require(path.join(root, "js/lua-export.js"));
const template = (name) => new Uint8Array(fs.readFileSync(fs.existsSync(path.join(root,"assets",name))?path.join(root,"assets",name):path.join(root,"tests/fixtures/gia",name)));
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
const near = (a, b, tol = 1e-5) => Math.abs(a - b) < tol;

// Finite differences independently verify all 9 parameter gradients for
// overlapping, rotated, anisotropic blobs, on transparent AND opaque targets.
async function main() {
  for (const transparent of [true, false]) {
   for (const weighted of [false,true]) {
    const p = new Float64Array([5.7,6.1,Math.log(2),Math.log(3),0.4,0.3,0.6,0.9,0.7,
      7.4,5.9,Math.log(3),Math.log(2),-0.3,0.8,0.1,0.4,0.6]);
    const truth = p.slice(); truth[0] += 0.6; truth[12] += 0.1; truth[14] -= 0.1;
    const target = W.evaluate(truth,14,14,null,transparent,1,0,false).pixels;
    const weights=weighted?Float32Array.from({length:196},(_,i)=>0.5+(i%7)/7):null;
    const analytic = W.evaluate(p,14,14,target,transparent,1,0,true,weights).grad;
    for (let i = 0; i < p.length; i++) {
      const h = 1e-5, plus = p.slice(), minus = p.slice(); plus[i] += h; minus[i] -= h;
      const numeric = (W.evaluate(plus,14,14,target,transparent,1,0,false,weights).loss - W.evaluate(minus,14,14,target,transparent,1,0,false,weights).loss) / (2*h);
      check(near(numeric, analytic[i], 2e-7), `gradient ${i}, transparent=${transparent}, weighted=${weighted}: ${numeric} vs ${analytic[i]}`);
    }
    const stats=W.evaluate(p,14,14,target,transparent,1,0,false,weights,true);
    for(let i=0;i<2;i++){
      const removed=Float64Array.from([...p.slice(0,i*9),...p.slice((i+1)*9)]);
      const actual=(W.evaluate(removed,14,14,target,transparent,1,0,false,weights).loss-stats.loss)*196;
      check(near(actual,stats.removalCosts[i],1e-6),`occlusion-aware removal cost ${i}, transparent=${transparent}, weighted=${weighted}`);
    }
   }
  }
  // Independently verify the moment-based candidate score against painting
  // that candidate and measuring the complete weighted pixel error.
  const flat=new Float32Array(16*16*4),background=new Float32Array(flat.length);
  for(let i=0;i<256;i++){flat.set([0.12,0.3,0.5,0.7],i*4);background.set([0.03,0.04,0.08,0.2],i*4);}
  const importance=Float32Array.from({length:256},(_,i)=>1+(i%5)/5);
  const candidate=Seeds.solve([8,8,Math.log(3),Math.log(4),0.3],background,flat,importance,16,16,true);
  const painted=background.slice();Seeds.paint(painted,candidate,16,16);
  let delta=0;
  for(let i=0;i<flat.length;i++)delta+=importance[Math.floor(i/4)]*((painted[i]-flat[i])**2-(background[i]-flat[i])**2);
  check(near(delta,candidate.delta,1e-5),"analytic seeding score matches actual source-over RGBA error change");
  check(delta<0,"new Gaussian placement reduces reconstruction error");
  const truth = new Float64Array([15,17,Math.log(4),Math.log(6),0.4,0.2,0.6,0.9,0.8]);
  const target = W.evaluate(truth,32,32,null,true,1,0,false).pixels;
  const p = new Float64Array([13,15,Math.log(5),Math.log(5),0.2,0.3,0.5,0.8,0.6]);
  const fitted = await W.optimize(p,32,32,target,true,{iterations:250});
  check(fitted.loss < fitted.initialLoss * 0.001, "joint Adam recovers a rotated Gaussian");
  const transformed = W.toElements(truth,128,9,300,20,{image_scale:1})[0];
  const angle = -transformed.rotation.z * Math.PI/180, c=Math.cos(angle), s=Math.sin(angle);
  const sx=transformed.size.rx/3,sy=transformed.size.ry/3,tc=Math.cos(truth[4]),ts=Math.sin(truth[4]);
  check(near(c*c*sx*sx+s*s*sy*sy,(300/128)**2*(tc*tc*16+ts*ts*36)),"nonuniform export resize transforms X covariance");
  check(near(s*s*sx*sx+c*c*sy*sy,(20/9)**2*(ts*ts*16+tc*tc*36)),"nonuniform export resize transforms Y covariance");
  check(near(c*s*(sx*sx-sy*sy),(300/128)*(20/9)*tc*ts*(16-36)),"nonuniform export resize preserves cross covariance");
  const rgba = new Uint8ClampedArray(32*32*4);
  for(let i=0;i<32*32;i++) {
    const a=target[i*4+3];
    for(let c=0;c<3;c++) rgba[i*4+c] = a ? Math.round(target[i*4+c]/a*255) : 0;
    rgba[i*4+3]=Math.round(a*255);
  }
  const cfg = { num_primitives: 8, gaussian_iterations: 100, enable_png_mode: true,
    image_scale: 2, output_alpha: 0.75, allowed_shapes: ["blurred_circle"], origin: {type:"custom",x:3,y:7} };
  const result = await W.processGaussian(rgba,32,32,cfg);
  check(result.elements.length===8, "honors element budget");
  check(result.config.output_has_transparency, "preserves alpha without white background");
  check(result.config.final_loss < result.config.initial_loss * 0.4, "fits uploaded RGBA target");
  check(result.elements.every(e=>e.image_asset_ref===106057&&e.image_type==="basic"), "correct resource and Basic type");
  check(result.elements.every(e=>e.alpha<=0.75), "global opacity scales fitted opacity");
  const zero = await W.processGaussian(rgba,32,32,{...cfg,output_alpha:0,gaussian_iterations:1});
  check(new Uint8Array(zero.preview_rgba).every((v,i)=>i%4!==3||v===0), "zero global opacity produces transparent output");
  const again = await W.processGaussian(rgba,32,32,cfg);
  check(JSON.stringify(again.elements)===JSON.stringify(result.elements), "deterministic results");
  const empty = await W.processGaussian(new Uint8ClampedArray(16*16*4),16,16,{...cfg,gaussian_iterations:20});
  check(empty.elements.every(e=>Number.isFinite(e.size.rx)), "fully transparent input remains finite");
  const opaque = await W.processGaussian(rgba,32,32,{...cfg,enable_png_mode:false,gaussian_iterations:20});
  check(new Uint8Array(opaque.preview_rgba).every((v,i)=>i%4!==3||v===255), "PNG mode off renders on white");
  check(await W.optimize(p,32,32,target,true,{cancelled:()=>true})===null, "cancellation stops optimization");
  const tiny = new Float64Array([1,1,0,0,0,0.2,0.5,0.8,0.8]);
  const tinyTarget = W.evaluate(tiny,2,2,null,true,1,0,false).pixels;
  let longProgress = 0;
  const cancelledLong = await W.optimize(tiny,2,2,tinyTarget,true,{iterations:4000,
    progress:(step)=>{longProgress=step;},cancelled:()=>longProgress>=3020});
  check(cancelledLong===null && longProgress>=3020,"optimization runs beyond 3000 steps and still cancels");
  let requestedTotal=0;
  const hugeRun=await W.optimize(tiny,2,2,tinyTarget,true,{iterations:100000000,
    progress:(_step,total)=>{requestedTotal=total;},cancelled:()=>requestedTotal>0});
  check(hugeRun===null && requestedTotal===100000000,"huge requested step count is preserved without an upper cap");
  const pyramidRgba=new Uint8ClampedArray(256*128*4);
  for(let y=0;y<128;y++)for(let x=0;x<256;x++)if((x-128)**2/90**2+(y-64)**2/50**2<1)pyramidRgba.set([30,100,190,255],(y*256+x)*4);
  let reportedTotal=0,lastProgress=0;
  const pyramid=await W.processGaussian(pyramidRgba,256,128,{num_primitives:24,gaussian_iterations:160,gaussian_resolution:256,enable_png_mode:true},
    {progress:(step,total)=>{check(step>=lastProgress,"pyramid progress never moves backwards");lastProgress=step;reportedTotal=total;}});
  check(pyramid.elements.length===24,"pyramid refinement and recycling preserve the exact requested budget");
  check(pyramid.config.fitting_stages.length===2,"large images fit from coarse to fine");
  check(pyramid.config.fitting_stages.reduce((n,s)=>n+s.steps,0)===160&&reportedTotal===160&&lastProgress===160,"pyramid consumes exactly the requested optimization steps");
  const wide=new Uint8ClampedArray(576*16*4);
  for(let i=0;i<576*16;i++)wide.set([i%576<288?10:240,90,160,255],i*4);
  const native=await W.processGaussian(wide,576,16,{num_primitives:2,gaussian_iterations:2,gaussian_resolution:768});
  check(native.config.gaussian_resolution===768&&native.config.training_size.width===576,"detail above 512 px is honored up to native image size");
  check(native.elements_count===2&&native.config.fitting_stages.reduce((n,s)=>n+s.steps,0)===2,"native fitting keeps both requested budgets");
  let stopPreparing=false;
  check(await W.processGaussian(pyramidRgba,256,128,{num_primitives:24,gaussian_iterations:160,enable_png_mode:true},
    {progress:()=>{stopPreparing=true;},cancelled:()=>stopPreparing})===null,"cancellation also interrupts error-driven placement");
  const cartoon=new Uint8ClampedArray(64*64*4);
  for(let y=0;y<64;y++)for(let x=0;x<64;x++){
    const at=(y*64+x)*4;
    if(((x-32)/23)**2+((y-33)/25)**2<1){
      cartoon.set([70,125,205,255],at);
      if((Math.abs(x-24)<3||Math.abs(x-40)<3)&&Math.abs(y-28)<2)cartoon.set([5,10,30,255],at);
      if(Math.abs(y-43)<1&&Math.abs(x-32)<8)cartoon.set([230,160,170,255],at);
    }
  }
  const cartoonTarget=W.downsample(cartoon,64,64,64,64,true);
  const randomFit=await W.optimize(W.initialize(24,64,64,cartoonTarget,true),64,64,cartoonTarget,true,{iterations:300});
  const adaptiveFit=await W.processGaussian(cartoon,64,64,{num_primitives:24,gaussian_iterations:300,enable_png_mode:true});
  check(adaptiveFit.config.final_loss<randomFit.loss*0.98,"adaptive placement improves a detailed synthetic image at the same 24-primitive/300-step budget");
  const json = Export.convertResultToGiaJson(result,cfg,"Gaussian",3,7);
  const clientBytes = G.convertJsonToGiaBytes(json,template("client_mask_off_template.gia"),G.MODE_CLIENT_IMAGE);
  const assetBytes = G.convertJsonToGiaBytes(Export.withAssetGroupMask(json),template("image_template.gia"),G.MODE_IMAGE);
  const assetMask = G.describeGia(assetBytes).container.mask;
  check(assetMask.enabled && assetMask.shapeType === 1, "Asset Group rectangular mask defaults on");
  check(near(assetMask.position.x,26) && near(assetMask.position.y,-18), "Asset Group mask follows custom origin and image scale");
  check(near(assetMask.size.x,64) && near(assetMask.size.y,64), "Asset Group mask covers full source image");
  check(json.mask.enabled === false, "Asset Group masking leaves shared Client/Server input untouched");
  const serverBytes = G.convertJsonToGiaBytes(json,template("blurred_circle_server.gia"),G.MODE_SERVER_IMAGE);
  check(G.validateClientImage(clientBytes,json).ok, "client GIA passes structural validator");
  for(const [bytes,cls,kind] of [[clientBytes,70,"client"],[assetBytes,61,"asset_group"],[serverBytes,21,"server"]]) {
    const model=G.describeGia(bytes);
    check(model.containerClass===cls&&model.templateKind===kind, `correct ${kind} root`);
    check(model.children.length===8,`${kind}: all children exported`);
    check(model.children.every(e=>e.imageAssetRef===106057),`${kind}: blurred resource survives export`);
    check(model.children.every(e=>e.parentGuid===model.container.guid),`${kind}: parent references valid`);
    const original=json.elements;
    for(const child of model.children) {
      const e=original.find(e=>near(e.relative.x,child.transform.offset.x+(cls===61?0:model.container.transform.offset.x),1e-3)&&
        near(e.relative.y,child.transform.offset.y+(cls===61?0:model.container.transform.offset.y),1e-3));
      check(!!e,`${kind}: world position includes parent offset exactly once`);
      check(near(child.transform.size.x,e.size.rx*2,1e-3),`${kind}: diameter preserved`);
    }
    check(G.describeGia(G.toClassic(bytes)).isClassic,`${kind}: Classic conversion`);
    if (cls===61) check(G.describeGia(G.toClassic(bytes)).container.mask.enabled, "Classic Asset Group retains enabled mask");
    check(!G.describeGia(G.toOverlimit(G.toClassic(bytes))).isClassic,`${kind}: Beyond conversion`);
  }
  const payload={...result,config:cfg,image_name:"Gaussian"};
  const lua=Lua.buildStandaloneLuaScript(payload,{imageTemplateIndex:1});
  check(lua.includes("circleAsset = 106057"),"Lua uses blurred resource");
  check(lua.includes("control.imageType = Enum.ImageType.Basic"),"Lua uses Basic image mode");
  check(!lua.includes("control.imageType = Enum.ImageType.Stretch"),"Lua does not force Stretch");

  // Decode raw protobuf payloads from the supplied known-Basic references.
  // They match the generated image/extra settings except tint and resource.
  const source=fs.readFileSync(path.join(root,"js/gia.js"),"utf8").replace("MODE_DECORATION: MODE_DECORATION,",
    "parse: parse_message_fields, bytes: _find_bytes, build: build_message, MODE_DECORATION: MODE_DECORATION,");
  const sandbox={module:{exports:{}},TextEncoder,TextDecoder};vm.runInNewContext(source,sandbox);
  const P=sandbox.module.exports;
  function settings(bytes,primary) {
    const entries=P.parse(bytes.subarray(20,bytes.length-4));
    const resource=entries.find(e=>e.tag===(primary?1:2));
    const content=P.bytes(P.parse(P.bytes(P.parse(resource.data),19)),1);
    return P.parse(content).filter(f=>f.tag===505).flatMap(f=>{
      const detail=P.bytes(P.parse(f.data),503);if(!detail)return [];
      return P.parse(detail).filter(f=>[31,84,85].includes(f.tag)).map(f=>({tag:f.tag,data:Array.from(P.build(P.parse(f.data).filter(x=>!
        (f.tag===31?[2,4]:f.tag===84?[502,503]:[]).includes(x.tag))))}));
    });
  }
  check(JSON.stringify(settings(clientBytes,false))===JSON.stringify(settings(template("blurred_circle_client.gia"),true)),"Client Basic payload equals supplied reference");
  check(JSON.stringify(settings(assetBytes,false))===JSON.stringify(settings(template("blurred_circle_asset_group.gia"),false)),"Asset Group Basic payload equals supplied reference");
  check(JSON.stringify(settings(serverBytes,false))===JSON.stringify(settings(template("blurred_circle_server.gia"),true)),"Server Basic payload equals supplied reference");
  check(JSON.stringify(settings(serverBytes,true))===JSON.stringify(settings(template("blurred_circle_server.gia"),true)),"Server parent settings preserved");
  console.log(`PASS: ${checks} Gaussian / GIA / Lua checks`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
