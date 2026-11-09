/*
 * lua-export.js — the result page's **Lua Script** download.
 *
 * Two layers:
 *
 *   convertJsonToLuaText(payload)
 *     Port of `primitive_shaper_to_lua.py` (the community JSON → Lua
 *     converter). Takes the payload `Export JSON` writes (buildJsonExportPayload
 *     in app.js) and returns character-for-character what the Python script
 *     produces — a `return { ... }` data table. tests/parity/lua/run_tests.js
 *     compares the two.
 *
 *   buildStandaloneLuaScript(payload)
 *     What the button downloads: a losslessly packed self-contained script.
 *     buildReadableLuaScript retains the reference implementation with the
 *     `PrimitiveImage` runtime library (embedded verbatim below), the data
 *     table as a local, and the OnStart/OnDestroy hooks from the community
 *     Example.lua — no `require` calls, ready to drop into a client script
 *     slot after filling in the Image Control Template index.
 *
 * Where the Python script would simply crash, the converter degrades instead:
 *   - a numeric `rotation` (the fill background rectangle) is used as the
 *     Z angle rather than indexed with ["z"];
 *   - a missing `packed_color` (outline results carry only `color`/`alpha`)
 *     is packed the same way the GIA writer does (ARGB, alpha half-to-even).
 * Every other detail — 0.1-unit quantisation, half-away-from-zero rounding,
 * `%.4f` formatting, asset IDs, counters — mirrors the script exactly.
 */
"use strict";

const LuaExport = (() => {

  const ELLIPSE = 1;
  const RECTANGLE = 2;
  const TRIANGLE = 3;

  const DEFAULT_PACKED_COLOR = 0x80FFFFFF;

  /* Placeholder from the community Example.lua — the user replaces it with
   * the index of the Image Control Template in their own project. */
  const IMAGE_TEMPLATE_PLACEHOLDER = "1234567890";
  const DATA_VARIABLE = "MyImage";

  /* PrimitiveImage.lua, verbatim (tests/parity/lua/PrimitiveImage.lua is the
   * reference copy and the suite asserts this string equals it). */
  const PRIMITIVE_IMAGE_LIBRARY = `local PrimitiveImage = {}

local configuredImageTemplate = nil

local ELLIPSE = 1
local RECTANGLE = 2
local TRIANGLE = 3

local DEFAULT_CIRCLE_ASSET = 100002
local DEFAULT_RECTANGLE_ASSET = 100001
local DEFAULT_TRIANGLE_ASSET = 100003

local function Clamp(value, minimum, maximum)
    return math.max(minimum, math.min(value, maximum))
end

local function Round(value)
    return math.floor(value + 0.5)
end

local function DecodeColor(packedColor, opacity)
    local alpha = math.floor(packedColor / 16777216)
    local rgb = packedColor - alpha * 16777216

    local red = math.floor(rgb / 65536)
    local greenBlue = rgb - red * 65536
    local green = math.floor(greenBlue / 256)
    local blue = greenBlue - green * 256

    alpha = Clamp(
        Round(alpha * Clamp(tonumber(opacity) or 1, 0, 1)),
        0,
        255
    )

    return Color.FromRGBA(red, green, blue, alpha)
end

local function ResolveSize(sourceWidth, sourceHeight, props)
    local width = tonumber(props.width)
    local height = tonumber(props.height)

    if width == nil and height == nil then
        width = sourceWidth
        height = sourceHeight
    elseif height == nil then
        height = width * sourceHeight / sourceWidth
    elseif width == nil then
        width = height * sourceWidth / sourceHeight
    end

    return width, height
end

local function ConfigureControlRect(control, x, y, width, height, rotation)
    control:SetAnchorMin(0.5, 0.5)
    control:SetAnchorMax(0.5, 0.5)
    control:SetPivot(0.5, 0.5)
    control:SetSizeDelta(width, height)
    control:SetAnchoredPosition(x, y)

    if rotation ~= nil then
        control:SetLocalRotation(0, 0, rotation)
    end
end

local function CreateImageControl(templateIndex, parent, imageAsset, color)
    local control = game.InstantiateClientUIControl(templateIndex, parent)

    assert(
        control ~= nil,
        "PrimitiveImage failed to instantiate the configured Image Control Template"
    )

    control:SetActive(true)
    control:SetVisible(true)
    control:SetImage(Enum.ImageSource.StaticReference, imageAsset)
    control.imageColor = color
    control.imageType = Enum.ImageType.Stretch

    return control
end

function PrimitiveImage.Configure(imageTemplateIndex)
    assert(
        type(imageTemplateIndex) == "number",
        "PrimitiveImage.Configure requires an Image Control Template index"
    )

    configuredImageTemplate = imageTemplateIndex
end

function PrimitiveImage.Create(parent, art, props)
    assert(parent ~= nil, "PrimitiveImage.Create requires a parent UI control")
    assert(type(art) == "table", "PrimitiveImage.Create requires converted image data")
    assert(type(art.primitives) == "table", "Converted image data is missing primitives")

    props = props or {}

    local imageTemplate = tonumber(props.imageTemplate) or configuredImageTemplate

    assert(
        imageTemplate ~= nil,
        "PrimitiveImage has no Image Control Template. Call PrimitiveImage.Configure(templateIndex) first, or pass imageTemplate in props."
    )

    local sourceWidth = tonumber(art.sourceWidth) or 1
    local sourceHeight = tonumber(art.sourceHeight) or 1
    local width, height = ResolveSize(sourceWidth, sourceHeight, props)

    local rectangleAsset = tonumber(art.rectangleAsset) or DEFAULT_RECTANGLE_ASSET
    local circleAsset = tonumber(art.circleAsset) or DEFAULT_CIRCLE_ASSET
    local triangleAsset = tonumber(art.triangleAsset) or DEFAULT_TRIANGLE_ASSET

    local transparent = Color.FromRGBA(255, 255, 255, 0)

    local root = CreateImageControl(
        imageTemplate,
        parent,
        rectangleAsset,
        transparent
    )

    ConfigureControlRect(
        root,
        tonumber(props.x) or 0,
        tonumber(props.y) or 0,
        width,
        height,
        tonumber(props.rotation)
    )

    if props.clip == true then
        root.enableMask = true
        root.enableSoftEdge = false
        root.reverseMaskArea = false
    else
        root.enableMask = false
    end

    local canvas = CreateImageControl(
        imageTemplate,
        root,
        rectangleAsset,
        transparent
    )

    ConfigureControlRect(
        canvas,
        0,
        0,
        sourceWidth,
        sourceHeight,
        nil
    )

    local mirrorX = props.mirrorX == true and -1 or 1
    local mirrorY = props.mirrorY == true and -1 or 1

    local function ApplyCanvasScale(targetWidth, targetHeight)
        canvas:SetLocalScale(
            targetWidth / sourceWidth * mirrorX,
            targetHeight / sourceHeight * mirrorY,
            1
        )
    end

    ApplyCanvasScale(width, height)

    local opacity = Clamp(tonumber(props.opacity) or 1, 0, 1)
    local quality = Clamp(tonumber(props.quality) or 1, 0.01, 1)

    local primitiveLimit = math.max(
        1,
        math.min(
            #art.primitives,
            math.floor(#art.primitives * quality + 0.5)
        )
    )

    local controls = {}

    for index = 1, primitiveLimit do
        local primitive = art.primitives[index]

        local primitiveType = primitive[1]
        local centerX = primitive[2] * 0.1
        local centerY = primitive[3] * 0.1
        local extentX = primitive[4] * 0.1
        local extentY = primitive[5] * 0.1
        local rotationZ = primitive[6] * 0.1
        local packedColor = primitive[7]

        local imageAsset

        if primitiveType == ELLIPSE then
            imageAsset = circleAsset
        elseif primitiveType == RECTANGLE then
            imageAsset = rectangleAsset
        elseif primitiveType == TRIANGLE then
            imageAsset = triangleAsset
        else
            error(
                "PrimitiveImage encountered unsupported primitive type "
                .. tostring(primitiveType)
            )
        end

        local control = CreateImageControl(
            imageTemplate,
            canvas,
            imageAsset,
            DecodeColor(packedColor, opacity)
        )

        ConfigureControlRect(
            control,
            centerX,
            centerY,
            extentX * 2,
            extentY * 2,
            rotationZ
        )

        control:SetSiblingIndex(index - 1)
        controls[index] = control
    end

    local object = {
        root = root,
        canvas = canvas,
        controls = controls,
        art = art,
        width = width,
        height = height,
        primitiveCount = primitiveLimit,
    }

    function object:SetVisible(visible)
        self.root:SetVisible(visible == true)
        return self
    end

    function object:SetPosition(x, y)
        self.root:SetAnchoredPosition(
            tonumber(x) or 0,
            tonumber(y) or 0
        )

        return self
    end

    function object:SetSize(newWidth, newHeight)
        newWidth = tonumber(newWidth) or self.width
        newHeight = tonumber(newHeight)

        if newHeight == nil then
            newHeight = newWidth * sourceHeight / sourceWidth
        end

        self.width = newWidth
        self.height = newHeight

        self.root:SetSizeDelta(newWidth, newHeight)
        ApplyCanvasScale(newWidth, newHeight)

        return self
    end

    function object:Destroy()
        if self.root ~= nil and self.root.alive then
            game.DestroyClientUIControl(self.root)
        end

        self.root = nil
        self.canvas = nil
        self.controls = {}
    end

    return object
end

return PrimitiveImage
`;

  /* Python: math.floor(v + 0.5) / math.ceil(v - 0.5) — same IEEE doubles. */
  function roundNearest(value) {
    if (value >= 0) return Math.floor(value + 0.5);
    return Math.ceil(value - 0.5);
  }

  function quantizeToTenths(value) {
    return roundNearest(Number(value) * 10);
  }

  /* Exact decimal expansion of a finite double as {sign, int, frac} where
   * value = sign * (int + frac / 2^shift). Used to reproduce CPython's
   * correctly-rounded "%.4f" (round-half-even on the exact binary value);
   * Number.prototype.toFixed rounds exact ties upward instead. */
  function pythonFixed4(value) {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const hi = view.getUint32(0);
    const lo = view.getUint32(4);
    const sign = hi >>> 31;
    const exponent = (hi >>> 20) & 0x7ff;
    let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let shift; // value = mantissa * 2^shift
    if (exponent === 0) {
      shift = -1074;
    } else {
      mantissa |= 1n << 52n;
      shift = exponent - 1075;
    }
    // scaled = |value| * 10^4 as an exact rational num / den
    let num = mantissa * 10000n;
    let den = 1n;
    if (shift >= 0) num <<= BigInt(shift);
    else den <<= BigInt(-shift);
    let q = num / den;
    const r = num % den;
    const twice = r * 2n;
    if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
    const digits = q.toString().padStart(5, "0");
    const intPart = digits.slice(0, -4);
    const fracPart = digits.slice(-4);
    const text = `${intPart}.${fracPart}`;
    // "-0.0000" is what Python prints for a negative value that rounds to 0
    return (sign ? "-" : "") + text;
  }

  /* Python format_number: integers print as int(); everything else as
   * "%.4f" with trailing zeros (and a bare ".") stripped. */
  function formatNumber(value) {
    const n = Number(value);
    if (Number.isInteger(n)) return String(BigInt(n));
    return pythonFixed4(n).replace(/0+$/, "").replace(/\.$/, "");
  }

  function roundHalfEven(x) {
    const f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  /* Fallback for elements without packed_color; matches gia.js
   * _color_to_packed for the hex-string case. */
  function packColor(color, alpha) {
    let alphaInt;
    if (alpha === null || alpha === undefined) {
      alphaInt = (DEFAULT_PACKED_COLOR >>> 24) & 255;
    } else if (typeof alpha === "number" && alpha >= 0 && alpha <= 1) {
      alphaInt = Math.trunc(Math.max(0, Math.min(255, roundHalfEven(alpha * 255))));
    } else {
      alphaInt = Math.trunc(Math.max(0, Math.min(255, roundHalfEven(Number(alpha)))));
    }
    if (typeof color === "number" && Number.isInteger(color)) return color >>> 0;
    if (typeof color !== "string") return DEFAULT_PACKED_COLOR;
    let hex = color.trim().replace(/^#+/, "");
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length !== 6) return DEFAULT_PACKED_COLOR;
    const rgb = parseInt(hex, 16);
    if (Number.isNaN(rgb)) return DEFAULT_PACKED_COLOR;
    return (alphaInt * 16777216 + rgb) >>> 0;
  }

  function resolvePackedColor(element) {
    const raw = element.packed_color;
    if (raw !== undefined && raw !== null && raw !== "") {
      const n = Math.trunc(Number(raw));
      if (Number.isFinite(n)) return n;
    }
    return packColor(element.color, element.alpha);
  }

  function resolveRotationZ(rotation) {
    if (rotation && typeof rotation === "object") return Number(rotation.z || 0);
    return Number(rotation || 0);
  }

  function normalizeType(type) {
    if (type === "circle") return "ellipse";
    if (type === "rect") return "rectangle";
    return type;
  }

  /* Python writes the name into an f-string verbatim; escaping the few
   * characters that would break the Lua string literal is the only
   * intentional difference. */
  function luaString(text) {
    return String(text)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
  }

  /* ── data table (== primitive_shaper_to_lua.py output) ─────────────── */

  function convertJsonToLuaText(data) {
    const config = data.config || {};
    const imageScale = Number(config.image_scale || 1) || 1;

    const originalWidth = Number(data.image_size.width);
    const originalHeight = Number(data.image_size.height);
    const sourceWidth = originalWidth * imageScale;
    const sourceHeight = originalHeight * imageScale;

    const hasGaussian = (data.elements || []).some(el => el.primitive_type === "blurred_circle");
    const primitives = [];
    let ellipseCount = 0;
    let rectangleCount = 0;
    let triangleCount = 0;

    for (const element of data.elements || []) {
      const type = normalizeType(element.type);
      const size = element.size || {};
      let typeCode, extentX, extentY;

      if (type === "ellipse") {
        typeCode = ELLIPSE;
        extentX = Number(size.rx);
        extentY = Number(size.ry);
        ellipseCount += 1;
      } else if (type === "rectangle") {
        typeCode = RECTANGLE;
        extentX = Number(size.width) * 0.5;
        extentY = Number(size.height) * 0.5;
        rectangleCount += 1;
      } else if (type === "triangle") {
        typeCode = TRIANGLE;
        extentX = Number(size.width) * 0.5;
        extentY = Number(size.height) * 0.5;
        triangleCount += 1;
      } else {
        throw new Error("Unsupported primitive type: " + String(element.type));
      }

      const relative = element.relative || {};
      primitives.push([
        typeCode,
        quantizeToTenths(relative.x),
        quantizeToTenths(relative.y),
        quantizeToTenths(extentX),
        quantizeToTenths(extentY),
        quantizeToTenths(resolveRotationZ(element.rotation)),
        resolvePackedColor(element),
        ...(typeCode===ELLIPSE && element.primitive_type!=="blurred_circle" && hasGaussian ? [100002] : []),
      ]);
    }

    const name = data.image_name === undefined || data.image_name === null
      ? "None" // str(None) — what the script prints for a missing name
      : data.image_name;

    const lines = [
      "return {",
      `    name = "${luaString(name)}",`,
      `    sourceWidth = ${formatNumber(sourceWidth)},`,
      `    sourceHeight = ${formatNumber(sourceHeight)},`,
      `    originalWidth = ${formatNumber(originalWidth)},`,
      `    originalHeight = ${formatNumber(originalHeight)},`,
      `    circleAsset = ${hasGaussian ? 106057 : 100002},`,
      "    rectangleAsset = 100001,",
      "    triangleAsset = 100003,",
      `    primitiveCount = ${primitives.length},`,
      `    ellipseCount = ${ellipseCount},`,
      `    rectangleCount = ${rectangleCount},`,
      `    triangleCount = ${triangleCount},`,
      "    primitives = {",
    ];

    for (const primitive of primitives) {
      lines.push("        {" + primitive.map((v) => String(v)).join(",") + "},");
    }

    lines.push("    },", "}", "");
    return lines.join("\n");
  }

  /* ── single-file script (library + data + hooks) ────────────────────── */

  /* The library ends with `return PrimitiveImage`, which a module needs but
   * a standalone script cannot have mid-file: drop that one statement. */
  function libraryBody() {
    return PRIMITIVE_IMAGE_LIBRARY.replace(/\nreturn PrimitiveImage\n$/, "\n");
  }

  /* The Image Control Template index is a non-negative integer typed by the
   * user; anything else means "not provided" and the script keeps the TODO
   * placeholder. Returns a number or null. */
  function parseTemplateIndex(text) {
    const s = String(text === undefined || text === null ? "" : text).trim();
    if (!/^\d+$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }

  function maskOffset(data) {
    if(!data.origin)return {x:0,y:0};
    const scale=Number(data.config?.image_scale)||1;
    const w=Number(formatNumber(Number(data.image_size.width)*scale)),h=Number(formatNumber(Number(data.image_size.height)*scale));
    return {x:w/2-Number(data.origin.x||0),y:-h/2-Number(data.origin.y||0)};
  }

  function buildReadableLuaScript(data, options) {
    options = options || {};
    const dataTable = convertJsonToLuaText(data);
    if (!dataTable.startsWith("return {\n")) throw new Error("unexpected data table");
    const dataBlock = `local ${DATA_VARIABLE} = {\n` + dataTable.slice("return {\n".length);

    const name = data.image_name === undefined || data.image_name === null ? "None" : String(data.image_name);
    const count = (data.elements || []).length;
    const templateIndex = parseTemplateIndex(options.imageTemplateIndex);
    const templateLine = templateIndex === null
      ? `local IMAGE_TEMPLATE_INDEX = ${IMAGE_TEMPLATE_PLACEHOLDER} -- TODO: replace with your Image Control Template index`
      : `local IMAGE_TEMPLATE_INDEX = ${templateIndex} -- Image Control Template index`;
    const setupStep1 = templateIndex === null
      ? [
        "--   1. Create an Image Control Template in your project and paste its",
        "--      index into IMAGE_TEMPLATE_INDEX below.",
      ]
      : [
        `--   1. IMAGE_TEMPLATE_INDEX is set to ${templateIndex}; it must be the index of an`,
        "--      Image Control Template in your project.",
      ];

    const mask=maskOffset(data);
    const runtime=libraryBody()
      .replace("        canvas,\n        0,\n        0,", `        canvas,\n        ${-mask.x},\n        ${-mask.y},`)
      .replace("imageAsset = circleAsset", "imageAsset = primitive[8] or circleAsset")
      .replace("control.imageType = Enum.ImageType.Stretch", "if imageAsset == 106057 then\n        control.imageType = Enum.ImageType.Basic\n    else\n        control.imageType = Enum.ImageType.Stretch\n    end");
    return [
      "-- " + luaComment(name) + " — primitive image as a client UI script",
      "-- Generated by Primitive Shaper. " + count + " primitives.",
      "--",
      "-- Setup:",
      ...setupStep1,
      "--   2. Attach this script to the UI control that should hold the image;",
      "--      it is built under script.object in OnStart and torn down in OnDestroy.",
      "--   3. Tune the props passed to PrimitiveImage.Create (see the list there).",
      "--",
      "-- Sections: PrimitiveImage runtime library · image data · script hooks.",
      "",
      "-- ═══════════════ PrimitiveImage runtime library ═══════════════",
      "",
      runtime.replace(/\n$/, ""),
      "",
      "-- ═══════════════ image data ═══════════════",
      "",
      dataBlock.replace(/\n$/, ""),
      "",
      "-- ═══════════════ script hooks ═══════════════",
      "",
      templateLine,
      "",
      "local artwork = nil",
      "",
      "function OnStart()",
      "    PrimitiveImage.Configure(IMAGE_TEMPLATE_INDEX)",
      "",
      "    artwork = PrimitiveImage.Create(",
      "        script.object,",
      `        ${DATA_VARIABLE},`,
      "        {",
      `            width = ${formatNumber(Number(data.image_size.width)*(Number(data.config?.image_scale)||1))}, -- display width`,
      "            -- height = 400,    -- set both to stretch freely",
      "            -- x = 0, y = 0,    -- anchored position of the root control",
      "            -- rotation = 0,    -- degrees",
      "            -- opacity = 1,     -- 0–1, multiplies every primitive's alpha",
      "            -- quality = 1,     -- 0.01–1, fraction of primitives to draw",
      "            clip = true,        -- mask primitives to the root rect",
      ...(mask.x||mask.y?[`            x = ${mask.x}, y = ${mask.y},`]:[]),
      "            -- mirrorX = false, mirrorY = false,",
      "        }",
      "    )",
      "end",
      "",
      "function OnDestroy()",
      "    if artwork ~= nil then",
      "        artwork:Destroy()",
      "        artwork = nil",
      "    end",
      "end",
      "",
    ].join("\n");
  }

  // Fixed-width column bit packing with optional palettes/delta prediction.
  // All arithmetic stays within exact JS/Lua integer precision; JSON is untouched.
  const PACK_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  // Optional LZ backreferences over the packed alphabet. A streaming Lua
  // reader retains only a 4096-symbol window, never the full decoded image.
  function compressSymbols(input) {
    const seen=new Map();let output='';
    const pair=n=>PACK_ALPHABET[n%64]+PACK_ALPHABET[Math.floor(n/64)];
    function remember(at){
      if(at>=4096){const oldKey=input.slice(at-4096,at-4092),old=seen.get(oldKey);if(old){while(old.length&&old[0]<=at-4096)old.shift();if(!old.length)seen.delete(oldKey);}}
      const key=input.slice(at,at+4),list=seen.get(key)||[];
      list.push(at);while(list.length>32||list[0]<at-4095)list.shift();seen.set(key,list);
    }
    for(let at=0;at<input.length;){
      const candidates=seen.get(input.slice(at,at+4))||[];let length=0,distance=0;
      for(let i=candidates.length-1;i>=0;i--){
        const offset=at-candidates[i];if(offset>4095)break;
        let n=0;while(n<4095&&at+n<input.length&&input[at+n]===input[at+n-offset])n++;
        if(n>length){length=n;distance=offset;}if(n===4095)break;
      }
      if(length>=6){output+='~'+pair(distance)+pair(length);for(let i=0;i<length;i++)remember(at+i);at+=length;}
      else {output+=input[at];remember(at++);}
    }
    return output;
  }
  function packLuaDataV2(data, sourceTable) {
    const table=sourceTable || convertJsonToLuaText(data);
    const rows=[...table.matchAll(/^        \{([^}]+)\},$/gm)].map(m=>m[1].split(',').map(Number));
    const columns=[], encoded=[];
    const bits=n=>n===0?0:Math.floor(Math.log2(n))+1;
    const descriptor=c=>`{${c.low},${c.bits},${c.mode}${c.palette?',{'+c.palette.join(',')+'}':''}}`;
    for(let col=0;col<8;col++){
      const values=rows.map(row=>row[col]??0);
      if(values.some(v=>!Number.isSafeInteger(v)))throw Error('Lua export integer exceeds lossless packed range');
      let low=0,high=0;
      if(values.length){low=values[0];high=low;for(const v of values){low=Math.min(low,v);high=Math.max(high,v);}}
      const range=high-low;
      if(!Number.isSafeInteger(range))throw Error('Lua export integer exceeds lossless packed range');
      const raw={mode:0,low,bits:bits(range),values:values.map(v=>v-low)};
      const palette=[...new Set(values)];
      const indices=new Map(palette.map((v,i)=>[v,i]));
      const choices=[raw,{mode:2,low:0,bits:bits(Math.max(0,palette.length-1)),palette,values:values.map(v=>indices.get(v))}];
      let prev=0;
      const deltas=values.map(v=>{const d=v-prev;prev=v;return d<0?-d*2-1:d*2;});
      if(deltas.every(Number.isSafeInteger))choices.push({mode:1,low:0,bits:bits(deltas.reduce((a,b)=>Math.max(a,b),0)),values:deltas});
      choices.sort((a,b)=>(descriptor(a).length+a.bits*rows.length/6)-(descriptor(b).length+b.bits*rows.length/6));
      columns.push(choices[0]);encoded.push(choices[0].values);
    }
    let packed='',buffer=0,available=0;
    function write(n,width){
      while(width){const take=Math.min(6-available,width),base=2**take;
        buffer+=(n%base)*2**available;n=Math.floor(n/base);available+=take;width-=take;
        if(available===6){packed+=PACK_ALPHABET[buffer];buffer=0;available=0;}
      }
    }
    for(let row=0;row<rows.length;row++)for(let col=0;col<8;col++)write(encoded[col][row],columns[col].bits);
    if(available)packed+=PACK_ALPHABET[buffer];
    const compressed=compressSymbols(packed),lz=packed.length-compressed.length>700;
    if(lz)packed=compressed;
    return {packed,lz,columns:'{'+columns.map(descriptor).join(',')+'}',count:rows.length,
      width:table.match(/sourceWidth = ([^,]+),/)[1],height:table.match(/sourceHeight = ([^,]+),/)[1],circle:table.match(/circleAsset = (\d+),/)[1]};
  }

  const PACKED_READER = `local function PackedReader(s,cols)
local digits={}
local alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
for i=1,64 do digits[string.byte(alphabet,i)]=i-1 end
local at,buffer,available=1,0,0
local row={0,0,0,0,0,0,0,0}
return function()
for col=1,8 do
local c=cols[col]
local n,shift,left=0,0,c[2]
while left>0 do
if available==0 then buffer=digits[string.byte(s,at)] at=at+1 available=6 end
local take=math.min(left,available)
local base=2^take
n=n+buffer%base*2^shift
buffer=math.floor(buffer/base) available=available-take left=left-take shift=shift+take
end
if c[3]==1 then
local delta=math.floor(n/2) if n%2==1 then delta=-delta-1 end
row[col]=row[col]+delta
elseif c[3]==2 then row[col]=c[4][n+1]
else row[col]=n+c[1] end
end
return row
end
end`;

  const LZ_SYMBOL_READER = `local history={}
local written,remaining,distance=0,0,0
local function symbol()
local ch
if remaining==0 then
ch=string.sub(s,at,at) at=at+1
if ch=="~" then
distance=digits[string.byte(s,at)]+64*digits[string.byte(s,at+1)]
remaining=digits[string.byte(s,at+2)]+64*digits[string.byte(s,at+3)] at=at+4
end
end
if remaining>0 then ch=history[(written-distance)%4096] remaining=remaining-1 end
history[written%4096]=ch written=written+1
return ch
end
`;

  // Rice codes spend fewer bits on small values without letting a single
  // large background primitive set the width of an entire geometry column.
  const RICE_READER = `local function PackedReader(s,cols)
local digits={}
local alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
for i=1,64 do digits[string.byte(alphabet,i)]=i-1 end
local at,buffer,available=1,0,0
local values={0,0,0,0,0,0,0,0,0,0,0}
local row={}
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
for i=1,6 do row[i]=values[i] end
if #cols==11 then
local r=values[7] local g=r+values[8] local b=g+values[9]
row[7]=values[10]*16777216+r*65536+g*256+b row[8]=values[11]
else row[7]=values[7] row[8]=values[8] end
return row
end
end`;

  function packRiceRows(rows) {
    const columns=[],encoded=[];
    const descriptor=c=>`{${c.low},${c.bits},${c.mode}${c.palette?',{'+c.palette.join(',')+'}':''}}`;
    const bits=n=>n===0?0:Math.floor(Math.log2(n))+1;
    for(let col=0;col<(rows[0]?.length||8);col++){
      const values=rows.map(row=>row[col]??0);
      let low=0,high=0;if(values.length){low=high=values[0];for(const v of values){low=Math.min(low,v);high=Math.max(high,v);}}
      const raw=values.map(v=>v-low),palette=[...new Set(values)],indices=new Map(palette.map((v,i)=>[v,i]));
      const choices=[{low,bits:bits(high-low),mode:0,values:raw},{low:0,bits:bits(Math.max(0,palette.length-1)),mode:2,palette,values:values.map(v=>indices.get(v))}];
      let previous=0;const delta=values.map(v=>{const d=v-previous;previous=v;return d<0?-d*2-1:d*2;});
      if(delta.every(Number.isSafeInteger))choices.push({low:0,bits:bits(delta.reduce((a,b)=>Math.max(a,b),0)),mode:1,values:delta});
      for(const [numbers,mode,offset] of [[raw,3,low],[delta,4,0]]){
        if(!numbers.every(Number.isSafeInteger))continue;
        const max=numbers.reduce((a,b)=>Math.max(a,b),0);
        let best=null;
        for(let k=0;k<=bits(max);k++){
          const base=2**k,cost=numbers.reduce((sum,n)=>sum+Math.floor(n/base)+1+k,0);
          if(!best||cost<best.cost)best={low:offset,bits:k,mode,values:numbers,cost};
        }
        choices.push(best);
      }
      for(const c of choices)c.score=descriptor(c).length+(c.cost ?? c.bits*rows.length)/6;
      choices.sort((a,b)=>a.score-b.score);columns.push(choices[0]);encoded.push(choices[0].values);
    }
    let packed='',buffer=0,available=0;
    function write(n,width){while(width){const take=Math.min(6-available,width),base=2**take;buffer+=(n%base)*2**available;n=Math.floor(n/base);available+=take;width-=take;if(available===6){packed+=PACK_ALPHABET[buffer];buffer=0;available=0;}}}
    for(let row=0;row<rows.length;row++)for(let col=0;col<columns.length;col++){
      const c=columns[col],n=encoded[col][row];
      if(c.mode>=3){const base=2**c.bits,q=Math.floor(n/base);for(let i=0;i<q;i++)write(1,1);write(0,1);write(n%base,c.bits);}else write(n,c.bits);
    }
    if(available)packed+=PACK_ALPHABET[buffer];
    const compressed=compressSymbols(packed),lz=packed.length-compressed.length>700;
    return {packed:lz?compressed:packed,lz,columns:'{'+columns.map(descriptor).join(',')+'}',reader:RICE_READER,version:3,columnCount:columns.length};
  }

  function readerFor(art) {
    const reader=art.reader || PACKED_READER;
    return art.lz ? reader.replace('local row=',LZ_SYMBOL_READER+'local row=').replace('digits[string.byte(s,at)] at=at+1 available=6','digits[string.byte(symbol())] available=6') : reader;
  }
  function packLuaData(data) {
    const table=convertJsonToLuaText(data),original=packLuaDataV2(data,table);
    const rows=[...table.matchAll(/^        \{([^}]+)\},$/gm)].map(m=>{const row=m[1].split(',').map(Number);if(row.length===7)row.push(0);return row;});
    const split=rows.map(row=>{
      const color=row[6];
      const a=Math.floor(color/16777216),rgb=color-a*16777216,r=Math.floor(rgb/65536),g=Math.floor((rgb-r*65536)/256),b=rgb-r*65536-g*256;
      return [...row.slice(0,6),r,g-r,b-g,a,row[7]];
    });
    const candidates=[original,{...original,...packRiceRows(rows)},{...original,...packRiceRows(split)}];
    const size=art=>art.packed.length+art.columns.length+readerFor(art).length;
    candidates.sort((a,b)=>size(a)-size(b));
    return candidates[0];
  }

  function buildStandaloneLuaScript(data, options) {
    const art=packLuaData(data),index=parseTemplateIndex(options?.imageTemplateIndex),mask=maskOffset(data);
    // A dedicated renderer replaces the general-purpose library. It keeps all
    // native setup calls and layer order, but needs no per-control Lua tables.
    return [
      `-- Primitive Shaper packed v${art.version||2}. Attach to the parent UI control.`,
      `local IMAGE_TEMPLATE_INDEX=${index===null?IMAGE_TEMPLATE_PLACEHOLDER:index}`,
      `local WIDTH=${art.width} -- display width`,
      `local W,H=${art.width},${art.height}`,
      `local DATA="${art.packed}"`,
      `local COLS=${art.columns}`,
      readerFor(art),
      `local function image(parent,asset,color)
local c=game.InstantiateClientUIControl(IMAGE_TEMPLATE_INDEX,parent)
assert(c,"Image Control Template failed")
c:SetActive(true) c:SetVisible(true)
c:SetImage(Enum.ImageSource.StaticReference,asset)
c.imageColor=color
c.imageType=asset==106057 and Enum.ImageType.Basic or Enum.ImageType.Stretch
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
rect(root,${mask.x?`(${mask.x})*WIDTH/W`:0},${mask.y?`(${mask.y})*WIDTH/W`:0},WIDTH,WIDTH*H/W)
root.enableMask=true
root.enableSoftEdge=false
root.reverseMaskArea=false
local canvas=image(root,100001,clear)
rect(canvas,${mask.x?`(${-mask.x})*WIDTH/W`:0},${mask.y?`(${-mask.y})*WIDTH/W`:0},W,H)
canvas:SetLocalScale(WIDTH/W,WIDTH/W,1)
local nextPrimitive=PackedReader(DATA,COLS)
for i=1,${art.count} do
local p=nextPrimitive()
local a=math.floor(p[7]/16777216)
local rgb=p[7]-a*16777216
local r=math.floor(rgb/65536)
local g=math.floor((rgb-r*65536)/256)
local b=rgb-r*65536-g*256
local asset=p[1]==1 and (p[8]~=0 and p[8] or ${art.circle}) or (p[1]==2 and 100001 or 100003)
local c=image(canvas,asset,Color.FromRGBA(r,g,b,math.max(0,math.min(255,a))))
rect(c,p[2]*0.1,p[3]*0.1,p[4]*0.1*2,p[5]*0.1*2,p[6]*0.1)
c:SetSiblingIndex(i-1)
end
end
function OnDestroy()
if root and root.alive then game.DestroyClientUIControl(root) end
root=nil
end`, '',
    ].join('\n');
  }

  /* A name inside a `--` comment must not open a long comment or a new line. */
  function luaComment(text) {
    return String(text).replace(/[\r\n]+/g, " ").replace(/\[\[/g, "[ [");
  }

  return {
    convertJsonToLuaText,
    buildStandaloneLuaScript,
    buildReadableLuaScript,
    packLuaData,
    parseTemplateIndex,
    formatNumber,
    quantizeToTenths,
    roundNearest,
    packColor,
    PRIMITIVE_IMAGE_LIBRARY,
    DATA_VARIABLE,
    IMAGE_TEMPLATE_PLACEHOLDER,
  };
})();

if (typeof module !== "undefined") module.exports = LuaExport;
