/*
 * splat-export.js — JSON and Lua output for Splat results.
 *
 * The Lua script follows the site's packed Lua layout (transparent masked
 * root, scaling canvas, one Image Control per shape) and mw_splat's adapter:
 * a 900-unit-tall canvas, image 106057 stretched to each splat's size, then
 * scaled by the splat's own X/Y scale. Splats keep their fitted order.
 */
"use strict";

const SplatExport = (() => {
  const Core = typeof SplatCore !== "undefined" ? SplatCore : require("./splat-core.js");
  const Lua = () => (typeof LuaExport !== "undefined" ? LuaExport : require("./lua-export.js"));

  // Columns: x, y, width, height (0.1 units), rotation (0.1°), scale x/y
  // (0.001), red, green − red, blue − green, alpha.
  const READER = `local function PackedReader(s,cols)
local digits={}
local alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
for i=1,64 do digits[string.byte(alphabet,i)]=i-1 end
local at,buffer,available=1,0,0
local values={}
for i=1,#cols do values[i]=0 end
local function read(left)
local n,shift=0,0
while left>0 do
if available==0 then buffer=digits[string.byte(s,at)] at=at+1 available=6 end
local take=math.min(left,available)
local base=2^take
n=n+buffer%base*2^shift
buffer=math.floor(buffer/base) available=available-take left=left-take shift=shift+take
end
return n
end
return function()
for col=1,#cols do
local c=cols[col]
local n
if c[3]>=3 then
local q=0 while read(1)==1 do q=q+1 end
n=q*2^c[2]+read(c[2])
else n=read(c[2]) end
if c[3]==1 or c[3]==4 then
local delta=math.floor(n/2) if n%2==1 then delta=-delta-1 end
values[col]=values[col]+delta
elseif c[3]==2 then values[col]=c[4][n+1]
else values[col]=n+c[1] end
end
return values
end
end`;

  function readerFor(lz) {
    if (!lz) return READER;
    return READER.replace("local function read(", Lua().LZ_SYMBOL_READER + "local function read(")
      .replace("digits[string.byte(s,at)] at=at+1 available=6", "digits[string.byte(symbol())] available=6");
  }

  const fixed = (v, digits = 4) => {
    const s = (Math.round(v * 10 ** digits) / 10 ** digits).toFixed(digits).replace(/\.?0+$/, "");
    return s === "-0" ? "0" : s;
  };

  function channels(el) {
    const hex = String(el.color || "#000000").replace("#", "");
    const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
    const a = Math.max(0, Math.min(255, Math.round((Number(el.alpha) || 0) * 255)));
    return [parseInt(full.slice(0, 2), 16) || 0, parseInt(full.slice(2, 4), 16) || 0, parseInt(full.slice(4, 6), 16) || 0, a];
  }

  /* Integer rows on the 900-unit canvas, centred, y up. */
  function rows(payload) {
    const width = Number(payload.image_size.width), height = Number(payload.image_size.height);
    const ppu = Number(payload.config?.pixel_per_unit) || 1 / (Number(payload.config?.image_scale) || 1);
    const k = Core.REF_HEIGHT / height;
    const values = [];
    for (const el of payload.elements || []) {
      if (!Core.isSplat(el)) continue;
      const px = el.center.x * ppu, py = -el.center.y * ppu;
      let rot = Math.round(Number(el.rotation?.z ?? el.rotation ?? 0) * 10) % 3600;
      if (rot > 1800) rot -= 3600; else if (rot <= -1800) rot += 3600;
      const [r, g, b, a] = channels(el);
      values.push([
        Math.round((px - width / 2) * k * 10), Math.round((height / 2 - py) * k * 10),
        Math.round(el.size.width * ppu * k * 10), Math.round(el.size.height * ppu * k * 10), rot,
        Math.round(Number(el.scale?.x ?? 1) * 1000), Math.round(Number(el.scale?.y ?? 1) * 1000),
        r, g - r, b - g, a,
      ].map((v) => v || 0)); // no negative zero
    }
    for (const row of values) if (row.some((v) => !Number.isSafeInteger(v))) throw Error("Lua export integer exceeds lossless packed range");
    const bg = (payload.elements || []).find((el) => el.is_background);
    return { values, count: values.length, background: bg ? channels(bg) : null, canvasWidth: width * k, canvasHeight: Core.REF_HEIGHT };
  }

  function buildLuaScript(payload, options = {}) {
    const L = Lua(), data = rows(payload);
    const art = L.packRiceRows(data.values.length ? data.values : []);
    const columns = data.values.length ? art.columns : "{}";
    const index = L.parseTemplateIndex(options.imageTemplateIndex);
    const scale = Number(payload.config?.image_scale) || 1;
    const displayWidth = Number(fixed(Number(payload.image_size.width) * scale, 4));
    const mask = L.maskOffset({ ...payload, image_size: payload.image_size, config: { ...payload.config, image_scale: scale } });
    const base = data.background ? 1 : 0;
    const name = String(payload.image_name ?? "").replace(/[\r\n]+/g, " ").replace(/\[\[/g, "[ [");
    return [
      `-- Splat packed v1${name ? ` (${name})` : ""}. Attach to the parent UI control.`,
      `-- ${data.count} soft rectangles (image ${Core.ASSET}) on a ${fixed(data.canvasWidth, 2)} x ${Core.REF_HEIGHT} canvas.`,
      `local IMAGE_TEMPLATE_INDEX=${index === null ? L.IMAGE_TEMPLATE_PLACEHOLDER : index}`,
      `local WIDTH=${displayWidth} -- display width`,
      `local DW=${displayWidth}`,
      `local W,H=${fixed(data.canvasWidth, 4)},${Core.REF_HEIGHT}`,
      `local MX,MY=${fixed(mask.x, 4)},${fixed(mask.y, 4)}`,
      `local COUNT=${data.count}`,
      `local DATA="${data.values.length ? art.packed : ""}"`,
      `local COLS=${columns}`,
      readerFor(data.values.length && art.lz),
      `local function image(parent,asset,color)
local c=game.InstantiateClientUIControl(IMAGE_TEMPLATE_INDEX,parent)
assert(c,"Image Control Template failed")
c:SetActive(true) c:SetVisible(true)
c:SetImage(Enum.ImageSource.StaticReference,asset)
c.imageColor=color
c.imageType=Enum.ImageType.Stretch
return c
end
local function rect(c,x,y,w,h,r)
c:SetAnchorMin(0.5,0.5) c:SetAnchorMax(0.5,0.5) c:SetPivot(0.5,0.5)
c:SetSizeDelta(w,h) c:SetAnchoredPosition(x,y)
if r~=nil then c:SetLocalRotation(0,0,r) end
end
local root
function OnStart()
local clear=Color.FromRGBA(255,255,255,0)
root=image(script.object,100001,clear)
rect(root,MX*WIDTH/DW,MY*WIDTH/DW,WIDTH,WIDTH*H/W)
root.enableMask=true
root.enableSoftEdge=false
root.reverseMaskArea=false
local canvas=image(root,100001,clear)
rect(canvas,0,0,W,H)
canvas:SetLocalScale(WIDTH/W,WIDTH/W,1)
${data.background ? `local bg=image(canvas,${Core.BACKGROUND_ASSET},Color.FromRGBA(${data.background.join(",")}))
rect(bg,0,0,W,H)
bg:SetSiblingIndex(0)
` : ""}local nextSplat=PackedReader(DATA,COLS)
for i=1,COUNT do
local p=nextSplat()
local r=p[8] local g=r+p[9] local b=g+p[10]
local c=image(canvas,${Core.ASSET},Color.FromRGBA(r,g,b,p[11]))
rect(c,p[1]*0.1,p[2]*0.1,p[3]*0.1,p[4]*0.1,p[5]*0.1)
c:SetLocalScale(p[6]*0.001,p[7]*0.001,1)
c:SetSiblingIndex(i-1+${base})
end
end
function OnDestroy()
if root and root.alive then game.DestroyClientUIControl(root) end
root=nil
end`, "",
    ].join("\n");
  }

  /* Adds mw_splat's splats.json fields so the file also loads in mw_splat
   * (`learn --reuse`) and its convert.nu script. */
  function jsonPayload(payload) {
    const width = Number(payload.image_size.width), height = Number(payload.image_size.height);
    const ppu = Number(payload.config?.pixel_per_unit) || 1 / (Number(payload.config?.image_scale) || 1);
    return { ...payload, ...Core.toIr(payload.elements || [], width, height, ppu) };
  }

  /* JS decoder for the packed stream, used by tests. */
  function decodeForTest(lua) {
    const L = Lua();
    let data = lua.match(/local DATA="([^"]*)"/)[1];
    const cols = JSON.parse(lua.match(/local COLS=(.*)/)[1].replace(/\{/g, "[").replace(/\}/g, "]"));
    const count = Number(lua.match(/local COUNT=(\d+)/)[1]);
    const digit = (ch) => L.PACK_ALPHABET.indexOf(ch);
    if (lua.includes("symbol()")) {
      let out = "";
      for (let i = 0; i < data.length;) {
        if (data[i] === "~") {
          const distance = digit(data[i + 1]) + 64 * digit(data[i + 2]), length = digit(data[i + 3]) + 64 * digit(data[i + 4]);
          for (let j = 0; j < length; j++) out += out[out.length - distance];
          i += 5;
        } else out += data[i++];
      }
      data = out;
    }
    let at = 0, buffer = 0, available = 0;
    const read = (left) => {
      let n = 0, shift = 0;
      while (left > 0) {
        if (available === 0) { buffer = digit(data[at++]); available = 6; }
        const take = Math.min(left, available), base = 2 ** take;
        n += (buffer % base) * 2 ** shift;
        buffer = Math.floor(buffer / base); available -= take; left -= take; shift += take;
      }
      return n;
    };
    const values = cols.map(() => 0), out = [];
    for (let row = 0; row < count; row++) {
      cols.forEach((c, col) => {
        let n;
        if (c[2] >= 3) { let q = 0; while (read(1) === 1) q++; n = q * 2 ** c[1] + read(c[1]); } else n = read(c[1]);
        if (c[2] === 1 || c[2] === 4) { let d = Math.floor(n / 2); if (n % 2 === 1) d = -d - 1; values[col] += d; }
        else if (c[2] === 2) values[col] = c[3][n];
        else values[col] = n + c[0];
      });
      out.push(values.slice());
    }
    return out;
  }

  return { rows, buildLuaScript, jsonPayload, decodeForTest, READER };
})();

if (typeof module !== "undefined") module.exports = SplatExport;
