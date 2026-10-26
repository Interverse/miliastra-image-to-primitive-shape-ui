/* node tests/gaussian/run_tests.js — no third-party dependencies */
"use strict";
const assert = require("assert/strict"), fs = require("fs"), path = require("path"), vm = require("vm");
const root = path.resolve(__dirname, "../..");
const W = require(path.join(root, "js/worker-gaussian.js"));
const G = require(path.join(root, "js/gia.js"));
const Export = require(path.join(root, "js/gia-export.js"));
const Lua = require(path.join(root, "js/lua-export.js"));
const template = (name) => new Uint8Array(fs.readFileSync(path.join(root, "assets", name)));
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
const near = (a, b, tol = 1e-5) => Math.abs(a - b) < tol;

// Finite differences independently verify all 9 parameter gradients for
// overlapping, rotated, anisotropic blobs, on transparent AND opaque targets.
async function main() {
  for (const transparent of [true, false]) {
    const p = new Float64Array([5.7,6.1,Math.log(2),Math.log(3),0.4,0.3,0.6,0.9,0.7,
      7.4,5.9,Math.log(3),Math.log(2),-0.3,0.8,0.1,0.4,0.6]);
    const truth = p.slice(); truth[0] += 0.6; truth[12] += 0.1; truth[14] -= 0.1;
    const target = W.evaluate(truth,14,14,null,transparent,1,0,false).pixels;
    const analytic = W.evaluate(p,14,14,target,transparent).grad;
    for (let i = 0; i < p.length; i++) {
      const h = 1e-5, plus = p.slice(), minus = p.slice(); plus[i] += h; minus[i] -= h;
      const numeric = (W.evaluate(plus,14,14,target,transparent,1,0,false).loss - W.evaluate(minus,14,14,target,transparent,1,0,false).loss) / (2*h);
      check(near(numeric, analytic[i], 2e-7), `gradient ${i}, transparent=${transparent}: ${numeric} vs ${analytic[i]}`);
    }
  }
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
