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
 *     What the button actually downloads: one self-contained script with the
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
      "    circleAsset = 100002,",
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

  function buildStandaloneLuaScript(data, options) {
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
      libraryBody().replace(/\n$/, ""),
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
      "            width = 600,        -- display width; height follows the source aspect ratio",
      "            -- height = 400,    -- set both to stretch freely",
      "            -- x = 0, y = 0,    -- anchored position of the root control",
      "            -- rotation = 0,    -- degrees",
      "            -- opacity = 1,     -- 0–1, multiplies every primitive's alpha",
      "            -- quality = 1,     -- 0.01–1, fraction of primitives to draw",
      "            -- clip = true,     -- mask primitives to the root rect",
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

  /* A name inside a `--` comment must not open a long comment or a new line. */
  function luaComment(text) {
    return String(text).replace(/[\r\n]+/g, " ").replace(/\[\[/g, "[ [");
  }

  return {
    convertJsonToLuaText,
    buildStandaloneLuaScript,
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
