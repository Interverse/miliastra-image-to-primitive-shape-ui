"use strict";
const fs=require('fs'),http=require('http'),path=require('path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=require('../runtime-root.cjs');
const server=http.createServer((req,res)=>{
 res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
 const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://local').pathname));
 if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
 fs.readFile(file,(error,data)=>{if(error){res.writeHead(404);res.end();return;}res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream');res.end(data);});
});
(async()=>{
 await new Promise(resolve=>server.listen(8351,'127.0.0.1',resolve));
 const launch={headless:true};if(process.env.CHROME_PATH)launch.executablePath=process.env.CHROME_PATH;else if(!fs.existsSync(chromium.executablePath()))launch.channel='chrome';
 const browser=await chromium.launch(launch);
 try{
 const page=await browser.newPage();await page.goto('http://127.0.0.1:8351/index.html');
 const result=await page.evaluate(async()=>{
   let checks=0;const check=(ok,label)=>{if(!ok)throw Error(label);checks++;};
   const reject=(text,format)=>{try{FinishedImport.parse(text,format);}catch(error){check(error.message.startsWith('import.'),'localized import error');return;}throw Error('Import accepted unsupported content: '+text.slice(0,100));};
   const payload={image_name:'roundtrip',image_size:{width:80,height:40},origin:{x:5,y:-7},config:{image_scale:.5},elements:[{type:'ellipse',relative:{x:15,y:-3},size:{rx:8,ry:4},rotation:{z:30},color:'#123456',alpha:.7,packed_color:0xb3123456}]};
   const source=JSON.stringify(payload),json=FinishedImport.parse(source,'json');
   check(json.elements[0].center.x===20&&json.elements[0].center.y===-10,'relative-only JSON reconstructs custom origin');
   check(json.config.pixel_per_unit===2&&json.elements[0].alpha===.7&&json.elements[0].packed_color===0xb3123456,'JSON units, alpha precision and game tint');
   check(JSON.stringify(payload)===source,'JSON input not mutated');
   const many=FinishedImport.parse(JSON.stringify({...payload,elements:Array.from({length:5000},(_,i)=>({...payload.elements[0],id:i}))}),'json');
   check(many.elements.length===5000,'finished import never truncates shapes');
   const outline=FinishedImport.parse(JSON.stringify({...payload,config:{mode:'outline',primitive_size:20}}),'json');
   check(outline.config.pixel_per_unit===20&&outline.config.image_scale===.05,'legacy outline units infer the pixel scale');
   const png=await FinishedImport.render(json);check(png.size>0&&json.image_rgba.byteLength===80*40*4,'finished result has source pixels without fitting');
   reject('{bad','json');reject(JSON.stringify({...payload,image_size:{width:-1,height:20}}),'json');
   reject(JSON.stringify({...payload,elements:[{...payload.elements[0],size:{rx:Infinity,ry:4}}]}),'json');
   reject(JSON.stringify({...payload,config:{allowed_shapes:{}}}),'json');
   for(const shape of ['circle','triangle','rect']){
     const svg=await(await fetch('/tests/primeval/fixtures/'+shape+'.svg')).text();
     const data=FinishedImport.parse(svg,'svg');check(data.elements.length===41,'native '+shape+' SVG retains all shapes');
     check((await FinishedImport.render(data)).size>0,'native '+shape+' SVG renders');
   }
   const svg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50"><g transform="translate(10 5)"><rect x="0" y="0" width="20" height="10" fill="#00ff00"/><circle cx="40" cy="20" r="5" fill="#ff0000"/></g></svg>';
   check(FinishedImport.parse('<svg width="20" height="10"><rect width="20" height="10"/></svg>','svg').elements.length===1,'pasted SVG without namespace');
   const vector=FinishedImport.parse(svg,'svg');check(vector.elements.length===2&&vector.elements[0].center.x===40&&vector.elements[0].center.y===-20,'SVG viewBox and nested transforms');
   const base='.shaper-container{width:80px;height:40px;background:transparent}.shaper-element{position:absolute;box-sizing:border-box}';
   const css=base+'.shaper-element.shaper-e0{left:20px;top:15px;width:12px;height:6px;background-color:#123456;opacity:.5;transform:translate(-50%,-50%) rotate(30deg);transform-origin:50% 50%;z-index:0;border-radius:50%}';
   const style=FinishedImport.parse(css,'css');check(style.elements.length===1&&Math.abs(style.elements[0].center.x-20)<1e-9&&Math.abs(style.elements[0].center.y+15)<1e-9,'CSS centres and transform origin');
   check(Math.abs(style.elements[0].size.rx-6)<1e-9&&Math.abs(style.elements[0].size.ry-3)<1e-9&&style.elements[0].alpha===.5,'CSS ellipse and alpha');
   const gradient=Gaussian.stops.map(([r,a])=>`rgba(12,34,56,${a.toFixed(6)}) ${(r*100).toFixed(3)}%`).join(', ');
   const gaussian=FinishedImport.parse(css.replace('background-color:#123456',`background:radial-gradient(ellipse closest-side, ${gradient})`),'css');
   check(gaussian.elements[0].primitive_type==='blurred_circle','CSS Gaussian profile is preserved');
   const stops=Gaussian.stops.map(([offset,alpha])=>`<stop offset="${offset}" stop-color="#123456" stop-opacity="${alpha}"/>`).join('');
   const gaussianSvg=FinishedImport.parse(`<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><defs><radialGradient id="blur">${stops}</radialGradient></defs><ellipse cx="40" cy="20" rx="10" ry="5" fill="url(#blur)"/></svg>`,'svg');
   check(gaussianSvg.elements[0].primitive_type==='blurred_circle'&&(await FinishedImport.render(gaussianSvg)).size>0,'SVG Gaussian profile is preserved');
   const tri=FinishedImport.parse(base+'.shaper-element.shaper-e0{left:20px;top:20px;width:12px;height:18px;background-color:#ff0000;transform:translate(-50%,-66.6667%) rotate(70deg);transform-origin:50% 66.6667%;clip-path:polygon(50% 0%,0% 100%,100% 100%)}','css');
   check(tri.elements[0].type==='triangle'&&tri.elements[0].triangle_pivot==='box','CSS triangle converts to supported box pivot');
   reject('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.importRan=true</script></svg>','svg');
   reject('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="https://example.com/a.png"/></svg>','svg');
   reject('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0 L10 10"/></svg>','svg');
   reject(base+'.shaper-element.shaper-e0{background-image:url(https://example.com/a.png)}','css');
   reject('@import url(https://example.com/a.css);'+base,'css');
   reject(base+'.shaper-container{transform:rotate(30deg)}','css');
   check(!window.importRan,'SVG code never executes');
   for(const language of I18N.LANGUAGES)for(const key of ['hint','drop','failed','invalid','unsupported','render'])check(typeof window.LOCALES[language.code]['import.'+key]==='string','import locale '+language.code);
   return checks;
 });
 console.log('PASS '+result+' finished import parsing, geometry, rendering and localization checks');
 }finally{await browser.close();server.close();}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
