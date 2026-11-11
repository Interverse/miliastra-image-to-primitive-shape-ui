'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
global.LuaExport=require('../../js/lua-export.js');
const Player=require('../../js/animation-lua.js'),{buildVariants}=require('../../scripts/prepare-animation-variants.cjs');
const {capture,html,differences}=require('../../scripts/preview-lua-player.cjs');
const frames=Array.from({length:3},(_,f)=>new Float64Array([
 2,f*30-20,0,120,80,f*100,0xff123456+f*500,0,
 1,100-f*20,30,60,50,-f*200,0x8012ab34,1,
 3,-100,f*20,40,40,0,0xff89abcd,2
]));
const input=Player.build({width:64,height:32,controls:3,frames,durations:[.07,.11,.08],fps:15},{imageTemplateIndex:123});
const direct=buildVariants(input).fast,report=capture(direct);
assert.equal(report.mismatchCount,0);assert.equal(report.summary.tweens,0);assert.equal(report.summary.controls,4);assert.ok(report.timeline.length>frames.length*2);
assert.deepEqual([...new Set(report.timeline.map(s=>s.frame))].sort(),[1,2,3]);
assert.equal(capture(buildVariants(input).preloaded).mismatchCount,0);
for(const code of [direct.replace('local FREEZE_FRAME=0','local FREEZE_FRAME=2'),direct.replace(/^local LOOP=true/m,'local LOOP=false'),direct.replace(/^local PLAYBACK_FPS=.*$/m,'local PLAYBACK_FPS=4')])assert.equal(capture(code).mismatchCount,0,'frozen, nonloop and FPS-limited timing');
const fault=capture(direct,{fault:true});assert.ok(fault.mismatchCount>0,'negative control must fail');
const stalled=capture(direct.replaceAll('clock=clock+dt*1000000','clock=clock+0*dt*1000000'));assert.ok(stalled.mismatchCount>0,'a frozen clock must fail the independent timeline oracle');
const native=capture(buildVariants(input,{nativeBatch:true}).fast);assert.equal(native.mismatchCount,0);assert.ok(native.native&&native.summary.tweens>0,'native results must be labeled as a model');
assert.throws(()=>capture(direct+'\nos.execute("must not run")'),/nil value|nil value.*os/s);
assert.throws(()=>capture(direct+'\nwhile true do end'),/instruction limit/);
assert.throws(()=>capture(direct+'\nthis is broken lua'),/saved-animation.lua/);
assert.ok(differences([[1,100001,0,0,10,10,360,0xff112233]],[[1,100001,0,0,10,10,0,0xff112233]]).length===0);
console.log('PASS visual Lua mock: direct/preloaded/native-model traces, frozen/nonloop/FPS timing, stale pose and clock faults, syntax error, sandbox, instruction timeout');
async function browserCheck(){
 const {chromium}=require('playwright'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'lua-preview-browser-'));let browser;
 try{const file=path.join(dir,'preview.html');fs.writeFileSync(file,html({...report,name:'Fixture'}));const launch={headless:true};if(process.env.CHROME_PATH)launch.executablePath=process.env.CHROME_PATH;else if(!fs.existsSync(chromium.executablePath()))launch.channel='chrome';browser=await chromium.launch(launch);
  for(const width of [1440,390]){const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(require('node:url').pathToFileURL(file).href);assert.match(await page.locator('#status').innerText(),/^PASS/);
   await page.locator('#next').click();assert.match(await page.locator('#position').innerText(),/^2 /);await page.locator('#copies').selectOption('4');await page.locator('#play').click();await page.waitForTimeout(350);assert.notEqual(await page.locator('#position').innerText(),'2 / '+report.timeline.length);await page.locator('#play').click();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'no horizontal overflow');assert.deepEqual(errors,[]);
   await page.close();
  }
  fs.writeFileSync(file,html(fault));const page=await browser.newPage();await page.goto(require('node:url').pathToFileURL(file).href);assert.match(await page.locator('#status').innerText(),/^FAIL/);console.log('PASS visual report browser checks: desktop/narrow, playback, stepping, copies, visible failure');
 }finally{if(browser)await browser.close();fs.rmSync(dir,{recursive:true,force:true});}
}
browserCheck().catch(e=>{console.error(e);process.exitCode=1;});
