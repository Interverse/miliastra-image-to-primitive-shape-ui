const fs = require('fs');
const path = require('path');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const PrimevalResult = require('../js/primeval-result.js');
const root = path.resolve(process.argv[2] || 'reference/ai-upscale');
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const page = await browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});
  for (const entry of fs.readdirSync(root,{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(root,entry.name);
    if (!fs.existsSync(path.join(folder,'run.json'))) continue;
    const info = JSON.parse(fs.readFileSync(path.join(folder,'run.json')));
    const drawing = fs.readFileSync(path.join(folder,'drawing.json'),'utf8');
    const pattern = /DrawnShape \{ geometry: (Polygon\(\[(.*?)\]\)|Ellipse \{ cx: ([-\d.e]+), cy: ([-\d.e]+), rx: ([-\d.e]+), ry: ([-\d.e]+), rotation: ([-\d.e]+) \}), color: Color \{ r: (\d+), g: (\d+), b: (\d+), a: (\d+) \} \}/g;
    const parts = [], shapes = [];
    for (const match of drawing.matchAll(pattern)) {
      const color = match.slice(8,12).map(Number);
      const fill = `fill="rgb(${color.slice(0,3)})" fill-opacity="${color[3]/255}"`;
      if (match[2] !== undefined) {
        const points = [...match[2].matchAll(/x: ([-\d.e]+), y: ([-\d.e]+)/g)].map(p=>[Number(p[1]),Number(p[2])]);
        parts.push(`<polygon points="${points.map(p=>p.join(',')).join(' ')}" ${fill}/>`);
        shapes.push({kind:'polygon',geometry:points.flat(),color});
      } else {
        const [cx,cy,rx,ry,rotation] = match.slice(3,8).map(Number);
        parts.push(`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rotation} ${cx} ${cy})" ${fill}/>`);
        shapes.push({kind:'ellipse',geometry:[cx,cy,rx,ry,rotation],color});
      }
    }
    if (shapes.length !== info.shapes) throw Error('Drawing parse mismatch');
    const elements = PrimevalResult.drawingToElements({width:info.width,height:info.height,background:[0,0,0,0],shapes},info.width,info.height,{}).elements;
    if (elements.length !== info.shapes) throw Error('Export count mismatch');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="${Math.round(1024*info.height/info.width)}" viewBox="0 0 ${info.width} ${info.height}">${parts.join('')}</svg>`;
    fs.writeFileSync(path.join(folder,'output.svg'),svg);
    await page.setContent(`<body style="margin:0;background:#888">${svg}</body>`);
    await page.locator('svg').screenshot({path:path.join(folder,'vector-1024.png')});
    fs.writeFileSync(path.join(folder,'export-check.json'),JSON.stringify({controls:shapes.length,elements:elements.length}));
  }
  await browser.close();
})().catch(error=>{console.error(error);process.exit(1);});
