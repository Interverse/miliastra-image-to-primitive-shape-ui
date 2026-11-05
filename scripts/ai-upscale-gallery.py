"""Build source/AI and fresh geometry comparison artifacts from retained runs."""
from pathlib import Path
import hashlib,json
from PIL import Image,ImageDraw
P=Path(__file__).resolve().parents[1]/'reference/ai-upscale'
html=['''<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>AI upscaling comparisons</title>
<style>
body{font:16px system-ui;background:#ddd;margin:20px;color:#222}
img{width:100%;display:block}figure{margin:0}
.compare{position:relative;max-width:1200px;background:#888;--split:50%;touch-action:pan-y}
.compare .overlay{position:absolute;inset:0;clip-path:inset(0 calc(100% - var(--split)) 0 0);background:#888}
.compare .overlay img{height:100%;object-fit:fill}
.compare input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:ew-resize;z-index:3}
.compare:focus-within{outline:3px solid #245ac8;outline-offset:3px}
.divider{position:absolute;top:0;bottom:0;left:var(--split);width:2px;background:white;pointer-events:none;transform:translateX(-1px)}
.divider:after{content:'↔';position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);padding:9px;background:#222;border:2px solid white;border-radius:50%;color:white}
.badge{position:absolute;top:10px;padding:5px 9px;background:#222d;color:white;border-radius:4px;pointer-events:none;font-size:13px}
.before{left:10px}.after{right:10px}
.links{margin:8px 0 24px}.links a{margin-right:20px}
</style>
<h1>Local AI upscaling comparisons</h1>
<p>Drag across each image to compare. Original is on the left, AI on the right. Move fully right for the original or fully left for AI. Keyboard arrow keys also work.</p>
<p>Browser CPU/WASM Real-ESRGAN, 2× source enhancement. Fits use the same native Turbo, Detail 512, seed 42, four CPU fitting threads, Focus off. These are development examples with uncalibrated visual evaluation.</p>''']

def comparison(before,after,label):
    return f'''<figure><div class="compare">
      <img src="{after}" alt="AI {label}" draggable="false">
      <div class="overlay"><img src="{before}" alt="Original {label}" draggable="false"></div>
      <span class="badge before">Original</span><span class="badge after">AI</span>
      <div class="divider" aria-hidden="true"></div>
      <input type="range" min="0" max="100" value="50" step="0.1" aria-label="Original versus AI, {label}" aria-valuetext="50% original">
    </div><figcaption class="links"><a href="{before}">Open original</a><a href="{after}">Open AI</a></figcaption></figure>'''
records=[]
for name in ['gold','blue','varka']:
    html.append(f'<h2>{name}</h2><h3>Source enhancement</h3>')
    html.append(comparison(f'{name}.png',f'{name}-ai.png',f'{name} source'))
    if name=='varka':
        html.append('<h3>400 controls, Detail 1024</h3>')
        html.append(comparison('varka-original-400-detail1024/vector-1024.png','varka-ai-400-detail1024/vector-1024.png','varka 400 controls, Detail 1024'))
        for variant in ['original','ai']:
            folder=f'varka-{variant}-400-detail1024'
            if (P/folder/'run.json').exists():
                records.append({'image':name,'variant':variant,'count':400,'detail':1024,'seed':42,'threads':4,'focus':'off','run':json.loads((P/folder/'run.json').read_text())})
    for count in [400,1000,2000]:
        html.append(f'<h3>{count} controls</h3>')
        if all((P/f'{name}-{variant}-{count}/vector-1024.png').exists() for variant in ['original','ai']):
            html.append(comparison(f'{name}-original-{count}/vector-1024.png',f'{name}-ai-{count}/vector-1024.png',f'{name} {count} controls'))
        for variant in ['original','ai']:
            d=P/f'{name}-{variant}-{count}'
            if (d/'run.json').exists():
                run=json.loads((d/'run.json').read_text());assert run['shapes']==count
                records.append({'image':name,'variant':variant,'count':count,'detail':512,'seed':42,'threads':4,'focus':'off','source_sha256':hashlib.sha256((P/(name+('-ai' if variant=='ai' else '')+'.png')).read_bytes()).hexdigest(),'run':run})
                html.append(f'<small>{variant} fitting time {run["seconds"]:.1f}s. </small>')
            else:html.append(f'<p>{variant} result unavailable</p>')
    # Side-by-side source and two 2000-control renders at identical display scale.
    sheet=Image.new('RGB',(1500,500),'#888');draw=ImageDraw.Draw(sheet)
    for i,(label,f) in enumerate([('Source',P/f'{name}.png'),('Original fit, 2000',P/f'{name}-original-2000/vector-1024.png'),('AI fit, 2000',P/f'{name}-ai-2000/vector-1024.png')]):
        if f.exists():
            im=Image.open(f).convert('RGBA');im.thumbnail((500,460));sheet.paste(im,(i*500,30),im);draw.text((i*500+8,8),label,fill='white')
    sheet.save(P/f'{name}-comparison.jpg')
html.append('''<script>
for(const frame of document.querySelectorAll('.compare')){
  const slider=frame.querySelector('input');
  const update=()=>{frame.style.setProperty('--split',slider.value+'%');slider.setAttribute('aria-valuetext',Math.round(slider.value)+'% original');};
  const move=event=>{const box=frame.getBoundingClientRect();slider.value=Math.max(0,Math.min(100,(event.clientX-box.left)/box.width*100));update();};
  slider.addEventListener('input',update);
  slider.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();slider.focus();slider.setPointerCapture(event.pointerId);move(event);});
  slider.addEventListener('pointermove',event=>{if(slider.hasPointerCapture(event.pointerId))move(event);});
  update();
}
</script>''')
(P/'comparison.html').write_text(''.join(html),encoding='utf8')
(P/'comparison-settings.json').write_text(json.dumps(records,indent=2))
print(len(records),'retained fitting results')
