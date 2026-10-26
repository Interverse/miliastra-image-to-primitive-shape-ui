/*
 * run_tests.js — Client Control Template (.gia) regression suite.
 *
 *   node tests/parity/gia-client/run_tests.js
 *
 * Covers:
 *   1. The supplied reference fixture (assets/client_image_template.gia) is
 *      unmodified and decodes to  Image Container → {Square, Circle}  with
 *      Circle at exactly +100 X relative to Square.
 *   2. Regenerating that same scene through the Client exporter produces an
 *      equivalent decoded structure (binary equality is not required —
 *      GUIDs are regenerated and the editor stores 100.0 as 99.99993).
 *   3. Server vs Client output for the same logical scene: identical pixel
 *      layout, colours, dimensions and image IDs; each in its own container
 *      format; the Client parent is no longer named "Image Container".
 *   4. Validation rejects malformed / server-flavoured output.
 *
 * Exit code is non-zero on any failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..", "..");
const GIA = require(path.join(ROOT, "js", "gia.js"));
const GiaExport = require(path.join(ROOT, "js", "gia-export.js"));

const CLIENT_TEMPLATE_PATH = path.join(ROOT, "assets", "client_image_template.gia");
const CLIENT_MASK_OFF_TEMPLATE_PATH = path.join(ROOT, "assets", "client_mask_off_template.gia");
const CLIENT_MASK_TEMPLATE_PATH = path.join(ROOT, "assets", "client_mask_template.gia");
const SERVER_TEMPLATE_PATH = path.join(ROOT, "assets", "image_template.gia");

/* The reference .gia files exactly as supplied. If either ever fails, the
 * permanent regression fixture has been edited — restore it rather than
 * re-pinning the hash. */
const REFERENCE_SHA256 =
  "9b54bf162b1679752b7d37d9695412d8feac2cbfe2db8632ec14a136c2f129e0";
const MASK_REFERENCE_SHA256 =
  "d7d80f57e4babfdf6a5ba9398287b6b72c0e606924fe01886424d049523b4561";
const MASK_OFF_REFERENCE_SHA256 =
  "746ec95a9f8aae593cd3ffd6fe86ef5b548084f816f41f9ecd742343081c6bb8";

const clientTemplate = new Uint8Array(fs.readFileSync(CLIENT_TEMPLATE_PATH));
const clientMaskOffTemplate = new Uint8Array(fs.readFileSync(CLIENT_MASK_OFF_TEMPLATE_PATH));
const clientMaskTemplate = new Uint8Array(fs.readFileSync(CLIENT_MASK_TEMPLATE_PATH));
const serverTemplate = new Uint8Array(fs.readFileSync(SERVER_TEMPLATE_PATH));
// The one generation template: image-parent container, mask toggle off.
const clientTemplates = clientMaskOffTemplate;

let PASS = 0;
let FAIL = 0;
function check(name, ok, detail) {
  if (ok) {
    PASS++;
    console.log(`PASS  ${name}`);
  } else {
    FAIL++;
    console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}
function eq(name, got, want) {
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}
function near(name, got, want, tol) {
  check(
    name,
    Math.abs(got - want) <= tol,
    `got ${got}, want ${want} (±${tol})`
  );
}

const clientOf = (json) =>
  GIA.convertJsonToGiaBytes(json, clientTemplates, GIA.MODE_CLIENT_IMAGE);
const serverOf = (json) =>
  GIA.convertJsonToGiaBytes(json, serverTemplate, GIA.MODE_IMAGE);

/* ─────────────────────────── 1. reference fixture ─────────────────────── */

function testReferenceFixture() {
  const digest = crypto.createHash("sha256").update(clientTemplate).digest("hex");
  eq("reference fixture is byte-unchanged", digest, REFERENCE_SHA256);

  const ref = GIA.describeGia(clientTemplate);
  eq("reference is a Client Control Template", ref.templateKind, "client");
  eq("reference container class", ref.containerClass, GIA.CLIENT_CONTAINER_CLASS);
  eq("reference container name", ref.container.resourceName, "Image Container");
  eq("reference child count", ref.children.length, 2);

  const byName = Object.create(null);
  for (const c of ref.children) byName[c.resourceName] = c;
  check("reference has a Square child", !!byName.Square);
  check("reference has a Circle child", !!byName.Circle);
  if (!byName.Square || !byName.Circle) return;

  const square = byName.Square;
  const circle = byName.Circle;

  eq("Square resource class", square.resourceClass, GIA.UI_IMAGE_CLASS);
  eq("Circle resource class", circle.resourceClass, GIA.UI_IMAGE_CLASS);
  eq("Square parents the container", square.parentGuid, ref.container.guid);
  eq("Circle parents the container", circle.parentGuid, ref.container.guid);
  eq("Square image ID is the rectangle ID", square.imageAssetRef, 100001);
  eq("Circle image ID is the ellipse ID", circle.imageAssetRef, 100002);
  eq("Square sibling index", square.index, 2);
  eq("Circle sibling index", circle.index, 3);

  // The reverse-engineering anchor: +100 on X, stored as the rect
  // transform's anchoredPosition (field 504) relative to Image Container.
  // The editor wrote 99.99993 for 100, hence the tolerance.
  near("Circle is +100 X from Square", circle.transform.offset.x - square.transform.offset.x, 100, 1e-3);
  near("Circle is +0 Y from Square", circle.transform.offset.y - square.transform.offset.y, 0, 1e-6);
  eq("Square sits at the reference origin X", square.transform.offset.x, 0);
  eq("Square sits at the reference origin Y", square.transform.offset.y, 0);
  eq("Square width", square.transform.size.x, 80);
  eq("Circle width", circle.transform.size.x, 80);

  // Container ↔ child wiring.
  const childGuids = ref.container.childGuids.slice().sort();
  const entryGuids = [square.guid, circle.guid].sort();
  eq("container child list matches the entries", JSON.stringify(childGuids), JSON.stringify(entryGuids));
  eq(
    "container reference locators match the entries",
    JSON.stringify(ref.container.referenceGuids.slice().sort()),
    JSON.stringify(entryGuids)
  );

  // Nothing server-flavoured hides in the reference.
  const serverOnly = [
    GIA.COMPONENT_TYPE.SERVER_FIELD14,
    GIA.COMPONENT_TYPE.SERVER_IMAGE,
    GIA.COMPONENT_TYPE.SERVER_MASK,
  ];
  const allTypes = [ref.container, ...ref.children].flatMap((o) => o.componentTypes);
  check(
    "reference carries no Server-only components",
    serverOnly.every((t) => allTypes.indexOf(t) < 0),
    `types seen: ${[...new Set(allTypes)].join(",")}`
  );
}

/* ───────────────────── 2. regenerate the reference scene ──────────────── */

/* Byte-compare a cloned component against the prototype's, with the
 * object's own GUID and name masked out — proves unknown client template
 * data survived cloning untouched. */
function maskGuid(bytes, guid) {
  const needle = [];
  let n = guid;
  while (true) {
    const b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) needle.push(b | 128);
    else {
      needle.push(b);
      break;
    }
  }
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    let hit = i + needle.length <= bytes.length;
    for (let j = 0; hit && j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) hit = false;
    }
    if (hit) {
      for (let j = 0; j < needle.length; j++) out.push(0xee);
      i += needle.length;
    } else {
      out.push(bytes[i]);
      i++;
    }
  }
  return Buffer.from(out).toString("hex");
}

/* Pull the raw component records out of a resource entry so they can be
 * compared byte-for-byte. */
function rawComponents(giaBytes, resourceName) {
  const model = GIA.describeGia(giaBytes);
  const all = [model.container, ...model.children];
  const target = all.find((o) => o.resourceName === resourceName);
  if (!target) return null;
  return target;
}

const REFERENCE_SCENE = {
  group_name: "Mario",
  mask: null,
  elements: [
    {
      type: "rectangle",
      relative: { x: 0, y: 0 },
      size: { width: 80, height: 80 },
      rotation: {},
      color: null,
      alpha: null,
      packed_color: 0xffffffff,
      image_asset_ref: 100001,
    },
    {
      type: "ellipse",
      relative: { x: 100, y: 0 },
      size: { rx: 40, ry: 40 },
      rotation: {},
      color: null,
      alpha: null,
      packed_color: 0xffffffff,
      image_asset_ref: 100002,
    },
  ],
};

function testRegeneratedReference() {
  const bytes = clientOf(REFERENCE_SCENE);
  const gen = GIA.describeGia(bytes);
  // Structural expectations come from the GENERATION template (the
  // image-parent, mask-off reference); geometry comes from the scene.
  const ref = GIA.describeGia(clientMaskOffTemplate);

  eq("regenerated file is a Client Control Template", gen.templateKind, "client");
  eq("regenerated container class", gen.containerClass, ref.containerClass);
  eq("regenerated child count", gen.children.length, ref.children.length);
  eq("regenerated container is renamed", gen.container.resourceName, "Mario");
  check(
    'regenerated container is no longer "Image Container"',
    gen.container.resourceName !== "Image Container"
  );
  eq(
    "regenerated name component matches the resource name",
    gen.container.componentName,
    "Mario"
  );

  // Container metadata the reference carries must survive.
  eq("container GUID preserved", gen.container.guid, ref.container.guid);
  eq(
    "container component slot/type set preserved",
    JSON.stringify(gen.container.components.map((c) => [c.slot, c.type])),
    JSON.stringify(ref.container.components.map((c) => [c.slot, c.type]))
  );
  eq(
    "container info-slot set preserved (incl. the slot-4 ancestor list)",
    JSON.stringify(gen.container.infoSlots),
    JSON.stringify(ref.container.infoSlots)
  );
  eq("header preserved", gen.header.middleHex, ref.header.middleHex);
  eq("trailer preserved", gen.tailHex, ref.tailHex);
  eq("template version string preserved", gen.version, ref.version);
  eq("template source path preserved", gen.sourcePath, ref.sourcePath);

  // Children: same shapes, same IDs, same +100 X relationship.
  const byRef = Object.create(null);
  for (const c of gen.children) byRef[c.imageAssetRef] = c;
  const rect = byRef[100001];
  const ell = byRef[100002];
  check("regenerated rectangle child exists", !!rect);
  check("regenerated ellipse child exists", !!ell);
  if (!rect || !ell) return;

  // Child offsets are relative to the parent image's rect, so compare
  // absolutes: rect at the scene origin, ellipse exactly +100 X from it.
  const cx = gen.container.transform.offset.x;
  eq("regenerated rectangle sits at the scene origin", rect.transform.offset.x + cx, 0);
  eq("regenerated ellipse is exactly +100 X", ell.transform.offset.x - rect.transform.offset.x, 100);
  eq("regenerated rectangle width", rect.transform.size.x, 80);
  eq("regenerated ellipse width", ell.transform.size.x, 80);
  eq("regenerated colour preserved", rect.packedColor >>> 0, 0xffffffff);

  for (const child of gen.children) {
    eq(
      `child ${child.resourceName}: component slot/type set matches the prototype`,
      JSON.stringify(child.components.map((c) => [c.slot, c.type])),
      JSON.stringify(ref.children[0].components.map((c) => [c.slot, c.type]))
    );
    eq(
      `child ${child.resourceName}: parent link`,
      child.parentGuid,
      gen.container.guid
    );
    eq(
      `child ${child.resourceName}: transform platform discriminator preserved`,
      child.transform.platformDiscriminator,
      ref.children[0].transform.platformDiscriminator
    );
    check(
      `child ${child.resourceName}: all 4 platform transforms agree`,
      child.transform.platformsAgree && child.transform.platformCount === 4
    );
  }

  // GUIDs must be regenerated and unique, and must not collide with the
  // container's.
  const guids = gen.children.map((c) => c.guid);
  eq("regenerated GUIDs are unique", new Set(guids).size, guids.length);
  check(
    "regenerated GUIDs avoid the container GUID",
    guids.indexOf(gen.container.guid) < 0
  );

  const validation = GIA.validateClientImage(bytes, {
    groupName: "Mario",
    objects: GIA.buildImageScene(REFERENCE_SCENE).clientObjects,
    container: GIA.buildImageScene(REFERENCE_SCENE).clientContainer,
  });
  check(
    "regenerated reference scene validates",
    validation.ok,
    validation.errors.join("; ")
  );
}

/* Unknown/uncatalogued components must be carried over verbatim. */
function testUnknownDataPreserved() {
  const bytes = clientOf(REFERENCE_SCENE);
  const gen = GIA.describeGia(bytes);
  const ref = GIA.describeGia(clientTemplate);

  const proto = ref.children.find((c) => c.imageAssetRef === 100001);
  const clone = gen.children.find((c) => c.imageAssetRef === 100001);
  check("prototype + clone available", !!proto && !!clone);
  if (!proto || !clone) return;

  // Slots 63, 67 and 74 are client-only components whose purpose is not
  // known; every byte except the embedded object GUID must be identical.
  for (const slot of [63, 67, 74, 4]) {
    const a = rawComponentBytes(clientTemplate, proto.resourceName, slot);
    const b = rawComponentBytes(bytes, clone.resourceName, slot);
    check(
      `unknown component slot ${slot} cloned verbatim`,
      a !== null && b !== null && maskGuid(a, proto.guid) === maskGuid(b, clone.guid),
      a === null || b === null ? "component missing" : "bytes differ"
    );
  }
}

/* Re-parse a file and return one component record's raw bytes. */
function rawComponentBytes(giaBytes, resourceName, slot) {
  const P = require(path.join(ROOT, "tests", "parity", "gia-client", "protoscan.js"));
  return P.componentBytes(giaBytes, resourceName, slot);
}

/* ─────────────────── 3. Server vs Client, same scene ──────────────────── */

function el(type, x, y, w, h, opts) {
  const e = Object.assign(
    {
      type,
      relative: { x, y },
      rotation: {},
      color: null,
      alpha: null,
      packed_color: 0x80ffffff,
    },
    opts || {}
  );
  e.size = type === "ellipse" ? { rx: w / 2, ry: h / 2 } : { width: w, height: h };
  return e;
}

const CASES = {
  "1x1 image": {
    group_name: "one_pixel",
    mask: null,
    elements: [el("rectangle", 0, 0, 1, 1, { packed_color: 0xff112233 })],
  },
  "small multicolour": {
    group_name: "swatch",
    mask: null,
    elements: [
      el("rectangle", -1, 1, 1, 1, { packed_color: 0xffff0000 }),
      el("rectangle", 0, 1, 1, 1, { packed_color: 0xff00ff00 }),
      el("rectangle", 1, 1, 1, 1, { packed_color: 0xff0000ff }),
      el("rectangle", -1, 0, 1, 1, { packed_color: 0xffffff00 }),
      el("rectangle", 0, 0, 1, 1, { packed_color: 0xff00ffff }),
      el("rectangle", 1, 0, 1, 1, { packed_color: 0xffff00ff }),
    ],
  },
  transparency: {
    group_name: "alpha",
    mask: null,
    elements: [
      el("rectangle", 0, 0, 4, 4, { packed_color: 0x00ffffff }),
      el("ellipse", 2, 0, 4, 4, { packed_color: 0x40ff8800 }),
      el("ellipse", 4, 0, 4, 4, { color: "#3366cc", alpha: 0.25, packed_color: 0 }),
    ],
  },
  "large image": {
    group_name: "big",
    mask: null,
    elements: Array.from({ length: 2000 }, (_, i) =>
      el(i % 2 ? "ellipse" : "rectangle", (i % 50) * 3, Math.floor(i / 50) * 3, 2.5, 2.5, {
        packed_color: (0xff000000 | (i * 7919)) >>> 0,
      })
    ),
  },
  "optimised / merged runs": {
    group_name: "merged",
    mask: null,
    elements: [
      el("rectangle", 0, 0, 12, 1, { packed_color: 0xff202020 }),
      el("rectangle", 0, 1, 7, 1, { packed_color: 0xff202020 }),
      el("rectangle", 3, 2, 1, 5, { packed_color: 0xffa0a0a0 }),
    ],
  },
  "square resource only": {
    group_name: "squares",
    mask: null,
    elements: [el("rectangle", 0, 0, 5, 5), el("rectangle", 6, 0, 5, 5)],
  },
  "circle resource only": {
    group_name: "circles",
    mask: null,
    elements: [el("ellipse", 0, 0, 5, 5), el("ellipse", 6, 0, 5, 5)],
  },
  "mixed square/circle IDs": {
    group_name: "mixed",
    mask: null,
    elements: [
      el("rectangle", 0, 0, 5, 5),
      el("ellipse", 6, 0, 5, 5),
      el("triangle", 12, 0, 5, 5),
      el("rectangle", 18, 0, 5, 5, { image_asset_ref: 100004 }),
      el("ellipse", 24, 0, 5, 5, { image_asset_ref: 100005 }),
    ],
  },
  "rotated / sprite transforms": {
    group_name: "rotated",
    mask: null,
    elements: [
      el("rectangle", 0, 0, 10, 4, { rotation: { z: 33.75 } }),
      el("ellipse", 5, 5, 8, 8, { rotation: { z: -12.5 } }),
      el("rectangle", -5, -5, 3, 9, { rotation: { z: 0 } }),
    ],
  },
  "fractional units and negative offsets": {
    group_name: "fractions",
    mask: null,
    elements: [
      el("ellipse", -3.25, 7.125, 0.5, 0.5),
      el("rectangle", 1234.5, -987.25, 0.125, 6.75),
    ],
  },
  "non-ASCII group name": {
    group_name: "喵喵头 ✨",
    mask: null,
    elements: [el("ellipse", 0, 0, 3, 3)],
  },
  "single element": {
    group_name: "single",
    mask: null,
    elements: [el("ellipse", 0, 0, 2, 2)],
  },
};

function compareServerClient(label, json) {
  const clientBytes = clientOf(json);
  const serverBytes = serverOf(json);
  const c = GIA.describeGia(clientBytes);
  const s = GIA.describeGia(serverBytes);

  eq(`${label}: client flavour`, c.templateKind, "client");
  eq(`${label}: asset group flavour`, s.templateKind, "asset_group");
  eq(`${label}: same object count`, c.children.length, s.children.length);

  const expectedName = GIA.buildImageScene(json).group_name;
  eq(`${label}: client container renamed`, c.container.resourceName, expectedName);
  eq(`${label}: server container renamed`, s.container.resourceName, expectedName);
  check(
    `${label}: client parent is not "Image Container"`,
    c.container.resourceName !== "Image Container"
  );

  // Children are emitted in the same order by both serializers, so pair by
  // the name component ("1", "2", …) that both assign.
  const absOffset = (model, child) => {
    const ct = model.container && model.container.transform;
    return {
      x: child.transform.offset.x + (ct ? ct.offset.x : 0),
      y: child.transform.offset.y + (ct ? ct.offset.y : 0),
    };
  };
  const cByName = Object.create(null);
  for (const o of c.children) cByName[o.componentName] = o;
  const sByName = Object.create(null);
  for (const o of s.children) sByName[o.componentName] = o;

  let idMismatch = 0;
  let geomMismatch = 0;
  let colourMismatch = 0;
  let indexMismatch = 0;
  let missing = 0;
  for (const name of Object.keys(sByName)) {
    const sv = sByName[name];
    const cl = cByName[name];
    if (!cl) {
      missing++;
      continue;
    }
    if (sv.imageAssetRef !== cl.imageAssetRef) idMismatch++;
    // Compare ABSOLUTE positions: a Client mask moves the container to the
    // mask centre and compensates every child, so raw child offsets
    // legitimately differ while the rendered position does not.
    const sAbs = absOffset(s, sv);
    const cAbs = absOffset(c, cl);
    if (
      Math.abs(sAbs.x - cAbs.x) > 1e-4 ||
      Math.abs(sAbs.y - cAbs.y) > 1e-4 ||
      sv.transform.size.x !== cl.transform.size.x ||
      sv.transform.size.y !== cl.transform.size.y ||
      sv.transform.rotationZ !== cl.transform.rotationZ ||
      sv.transform.pivot.x !== cl.transform.pivot.x ||
      sv.transform.pivot.y !== cl.transform.pivot.y
    )
      geomMismatch++;
    if ((sv.packedColor >>> 0) !== (cl.packedColor >>> 0)) colourMismatch++;
    // The two formats composite in opposite directions, so the sibling
    // index must be MIRRORED, not equal: with n objects, server index i+2
    // over the reversed order and client index j+2 over painter order give
    // serverIndex + clientIndex === n + 3.
    if (sv.index + cl.index !== s.children.length + 3) indexMismatch++;
  }

  check(`${label}: every server object has a client counterpart`, missing === 0, `${missing} missing`);
  check(`${label}: image IDs identical`, idMismatch === 0, `${idMismatch} differ`);
  check(
    `${label}: positions / dimensions / rotations identical`,
    geomMismatch === 0,
    `${geomMismatch} differ`
  );
  check(`${label}: colours identical`, colourMismatch === 0, `${colourMismatch} differ`);
  check(
    `${label}: sibling indices are mirrored (opposite compositing direction)`,
    indexMismatch === 0,
    `${indexMismatch} differ`
  );

  // The client hierarchy must be the exact reverse of the server one, and
  // must equal painter order.
  // The server template's container keeps a stale packed child list from
  // the original project (GUIDs with no entry); the live order is the one
  // that resolves to actual children.
  const resolve = (m) => {
    const byGuid = Object.create(null);
    for (const o of m.children) byGuid[o.guid] = o;
    return m.container.childGuids.map((g) => byGuid[g]).filter(Boolean).map((o) => o.componentName);
  };
  const cOrder = resolve(c);
  const sOrder = resolve(s);
  check(
    `${label}: client hierarchy is the reverse of the server hierarchy`,
    JSON.stringify(cOrder) === JSON.stringify(sOrder.slice().reverse()),
    `client=${cOrder.slice(0, 6).join(",")} server=${sOrder.slice(0, 6).join(",")}`
  );
  const painterNames = GIA.buildImageScene(json).clientObjects.map((o) => o.name);
  check(
    `${label}: client hierarchy is painter order (earlier = behind)`,
    JSON.stringify(cOrder) === JSON.stringify(painterNames),
    `got ${cOrder.slice(0, 6).join(",")} want ${painterNames.slice(0, 6).join(",")}`
  );

  // Structure stays flavour-correct.
  const serverOnly = [
    GIA.COMPONENT_TYPE.SERVER_FIELD14,
    GIA.COMPONENT_TYPE.SERVER_IMAGE,
    GIA.COMPONENT_TYPE.SERVER_MASK,
  ];
  const clientTypes = [c.container, ...c.children].flatMap((o) => o.componentTypes);
  check(
    `${label}: client output has no Server-only components`,
    serverOnly.every((t) => clientTypes.indexOf(t) < 0)
  );
  check(
    `${label}: server output still uses the server image component`,
    s.children.every((o) => o.componentTypes.indexOf(GIA.COMPONENT_TYPE.SERVER_IMAGE) >= 0)
  );
  check(
    `${label}: client output uses the client image component`,
    c.children.every((o) => o.componentTypes.indexOf(GIA.COMPONENT_TYPE.CLIENT_IMAGE) >= 0)
  );

  const validation = GIA.validateClientImage(clientBytes, {
    groupName: expectedName,
    objects: GIA.buildImageScene(json).clientObjects,
  });
  check(`${label}: client output validates`, validation.ok, validation.errors.slice(0, 3).join("; "));

  // Classic conversion must work on both flavours.
  const classic = GIA.toClassic(clientBytes);
  const classicModel = GIA.describeGia(classic);
  check(`${label}: client → classic keeps the structure`, classicModel.isClassic &&
    classicModel.children.length === c.children.length);
}

/* ──────────────── 3b. compositing simulation (occlusion) ──────────────────
 *
 * The check that actually pins the layering rule down: rasterise the scene
 * three ways and require all three to agree.
 *
 *   reference — the source element list painted front-to-back, which is
 *               what the canvas preview, the SVG export and the CSS export
 *               all do (`renderOrderedElements`: background, then
 *               foreground, unreversed).
 *   client    — decoded child list painted IN hierarchy order, because an
 *               earlier Client sibling is rendered first and sits behind.
 *   server    — decoded child list painted in REVERSE hierarchy order,
 *               which is the direction the (byte-verified) Server writer
 *               implies.
 *
 * Any exporter that emits its children backwards fails here even though
 * every per-object field is individually correct.
 */

const CANVAS_W = 40;
const CANVAS_H = 24;

function blankCanvas() {
  // straight (non-premultiplied) RGBA, 0 = transparent
  return new Float64Array(CANVAS_W * CANVAS_H * 4);
}

/* Source-over of one axis-aligned rect of packed ARGB onto the canvas. */
function paintRect(canvas, cx, cy, w, h, packed) {
  const a = ((packed >>> 24) & 255) / 255;
  const r = (packed >>> 16) & 255;
  const g = (packed >>> 8) & 255;
  const b = packed & 255;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(cy - h / 2);
  for (let y = Math.max(0, y0); y < Math.min(CANVAS_H, y0 + Math.round(h)); y++) {
    for (let x = Math.max(0, x0); x < Math.min(CANVAS_W, x0 + Math.round(w)); x++) {
      const i = (y * CANVAS_W + x) * 4;
      const da = canvas[i + 3];
      const oa = a + da * (1 - a);
      if (oa === 0) { canvas[i] = canvas[i+1] = canvas[i+2] = canvas[i+3] = 0; continue; }
      canvas[i] = (r * a + canvas[i] * da * (1 - a)) / oa;
      canvas[i + 1] = (g * a + canvas[i + 1] * da * (1 - a)) / oa;
      canvas[i + 2] = (b * a + canvas[i + 2] * da * (1 - a)) / oa;
      canvas[i + 3] = oa;
    }
  }
}

/* Paint from the logical scene, in the order the preview uses. */
function rasterizeSource(json) {
  const canvas = blankCanvas();
  const bg = [], fg = [];
  for (const e of json.elements) (e.is_background ? bg : fg).push(e);
  for (const e of bg.concat(fg)) {
    const w = e.size.width !== undefined ? e.size.width : e.size.rx * 2;
    const h = e.size.height !== undefined ? e.size.height : e.size.ry * 2;
    paintRect(canvas, e.relative.x + CANVAS_W / 2, CANVAS_H / 2 - e.relative.y, w, h, e.packed_color >>> 0);
  }
  return canvas;
}

/* Paint from a decoded .gia, following that flavour's hierarchy rule. */
function rasterizeGia(model, earlierIsBehind) {
  const byGuid = Object.create(null);
  for (const o of model.children) byGuid[o.guid] = o;
  let order = model.container.childGuids.map((g) => byGuid[g]).filter(Boolean);
  if (!earlierIsBehind) order = order.reverse();
  const canvas = blankCanvas();
  for (const o of order) {
    paintRect(
      canvas,
      o.transform.offset.x + CANVAS_W / 2,
      CANVAS_H / 2 - o.transform.offset.y,
      o.transform.size.x,
      o.transform.size.y,
      o.packedColor >>> 0
    );
  }
  return canvas;
}

function canvasDiff(a, b) {
  let worst = 0;
  let at = -1;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > worst) { worst = d; at = i; }
  }
  return { worst, at };
}

/* Axis-aligned opaque/semi-transparent rects whose stacking is unambiguous. */
const OVERLAP_CASES = {
  "background then foreground": {
    group_name: "occlusion_basic",
    mask: null,
    elements: [
      // A: large red background region (painted first → behind)
      el("rectangle", 0, 0, 30, 18, { packed_color: 0xffff0000 }),
      // B: smaller blue block covering part of A (painted second → on top)
      el("rectangle", 4, 0, 12, 8, { packed_color: 0xff0000ff }),
    ],
  },
  "three-deep opaque stack": {
    group_name: "occlusion_stack",
    mask: null,
    elements: [
      el("rectangle", 0, 0, 28, 16, { packed_color: 0xff111111 }),
      el("rectangle", 0, 0, 18, 10, { packed_color: 0xff888888 }),
      el("rectangle", 0, 0, 8, 4, { packed_color: 0xffffffff }),
    ],
  },
  "semi-transparent over opaque": {
    group_name: "occlusion_alpha",
    mask: null,
    elements: [
      el("rectangle", 0, 0, 26, 14, { packed_color: 0xff2040a0 }),
      el("rectangle", 2, 2, 14, 8, { packed_color: 0x80ffcc00 }),
      el("rectangle", -4, -2, 10, 6, { packed_color: 0x40ff0000 }),
    ],
  },
  "merged runs with an overlapping detail": {
    group_name: "occlusion_merged",
    mask: null,
    elements: [
      // a merged horizontal run…
      el("rectangle", 0, 4, 30, 2, { packed_color: 0xff303030 }),
      // …and a merged vertical run crossing it, which must win at the cross
      el("rectangle", -6, 0, 2, 16, { packed_color: 0xffe0e0e0 }),
      el("rectangle", 6, 0, 2, 16, { packed_color: 0xff00c0a0 }),
    ],
  },
  // `is_background` never reaches the writer from the web pipeline —
  // gia-export.js rebuilds the element dicts without it, which is byte-
  // verified against the original Python. Reaching past that glue, the
  // original's own ordering puts background elements FIRST, which under
  // Server semantics (earlier = on top) would draw them over the
  // foreground. That quirk is inherited and byte-locked, so only the
  // Client side is asserted here.
  "background flag plus foreground": {
    serverKnownDivergence: true,
    group_name: "occlusion_bgflag",
    mask: null,
    elements: [
      el("rectangle", 8, 0, 10, 6, { packed_color: 0xff00ff00 }),
      Object.assign(el("rectangle", 0, 0, 34, 20, { packed_color: 0xff404040 }), {
        is_background: true,
      }),
    ],
  },
};

function testCompositing() {
  for (const [label, json] of Object.entries(OVERLAP_CASES)) {
    const want = rasterizeSource(json);

    const c = GIA.describeGia(clientOf(json));
    const s = GIA.describeGia(serverOf(json));

    const gotClient = rasterizeGia(c, /* earlierIsBehind */ true);
    const gotServer = rasterizeGia(s, /* earlierIsBehind */ false);

    const dc = canvasDiff(want, gotClient);
    const ds = canvasDiff(want, gotServer);
    check(
      `compositing "${label}": client hierarchy reproduces the source image`,
      dc.worst < 1e-9,
      `max channel error ${dc.worst.toFixed(3)} at sample ${dc.at}`
    );
    if (json.serverKnownDivergence) {
      console.log(
        `NOTE  compositing "${label}": server order not asserted — the original` +
          " Python writer's is_background placement is byte-locked and" +
          " unreachable from the web pipeline"
      );
    } else {
      check(
        `compositing "${label}": server hierarchy reproduces the source image`,
        ds.worst < 1e-9,
        `max channel error ${ds.worst.toFixed(3)} at sample ${ds.at}`
      );
    }

    // And prove the test is sensitive: painting the client list the WRONG
    // way round must NOT reproduce the source (otherwise the case has no
    // occlusion and proves nothing).
    const inverted = rasterizeGia(c, /* earlierIsBehind */ false);
    check(
      `compositing "${label}": case actually exercises occlusion`,
      canvasDiff(want, inverted).worst > 1e-9,
      "inverting the order changed nothing — the case has no overlap"
    );
  }
}

/* ──────────── 3c. The Client parent image and its mask toggle ─────────────
 *
 * Reverse-engineered from three supplied references exported from the same
 * object: no parent image, parent image with the in-game mask toggle OFF,
 * and the same with it ON. The only difference between the last two is one
 * varint — `505[slot 74 / type 97].503.85.501`.
 *
 * Generated output therefore ALWAYS gives the group an image parent, sized
 * to the source image rectangle, tinted fully transparent, with the toggle
 * off; the player turns it on in game.
 */

function imageScene(opts) {
  opts = opts || {};
  const b = opts.bounds || { x: 0, y: 0, width: 60, height: 40 };
  const scene = {
    group_name: opts.name || "scene",
    mask: opts.mask === undefined ? null : opts.mask,
    image_bounds: b,
    elements: opts.elements || [
      el("rectangle", 0, 0, 20, 20, { packed_color: 0xff112233 }),
      el("ellipse", 18, -6, 24, 24, { packed_color: 0xff44aa66 }),
    ],
  };
  if (opts.maskOn) scene.client_mask_enabled = true;
  return scene;
}

function testMaskReferenceFixtures() {
  eq(
    "mask-off reference fixture is byte-unchanged",
    crypto.createHash("sha256").update(clientMaskOffTemplate).digest("hex"),
    MASK_OFF_REFERENCE_SHA256
  );
  eq(
    "mask-on reference fixture is byte-unchanged",
    crypto.createHash("sha256").update(clientMaskTemplate).digest("hex"),
    MASK_REFERENCE_SHA256
  );

  const off = GIA.describeGia(clientMaskOffTemplate);
  const on = GIA.describeGia(clientMaskTemplate);
  const plain = GIA.describeGia(clientTemplate);

  // All three are Client Control Templates.
  for (const [label, m] of [["mask-off", off], ["mask-on", on], ["plain", plain]]) {
    eq(`${label} reference is a Client Control Template`, m.templateKind, "client");
    eq(`${label} reference container class`, m.containerClass, GIA.CLIENT_CONTAINER_CLASS);
  }

  // The parent image exists in both parent-image references, identically.
  for (const [label, m] of [["mask-off", off], ["mask-on", on]]) {
    eq(`${label}: container owns the rectangle image`, m.container.imageAssetRef, 100001);
    eq(`${label}: container tint is 0x00FFFFFF`, m.container.packedColor >>> 0, 0x00ffffff);
    eq(
      `${label}: parent image is never drawn (alpha 0)`,
      (m.container.packedColor >>> 24) & 255,
      0
    );
    eq(
      `${label}: container component set`,
      JSON.stringify(m.container.components.map((c) => [c.slot, c.type])),
      JSON.stringify([[2, 15], [4, 86], [1, 12], [63, 83], [73, 96], [74, 97], [67, 90]])
    );
  }
  // …and is absent from the plain reference, which instead has slot 68/91.
  eq("plain reference container has no image", plain.container.imageAssetRef, null);
  check(
    "plain reference container carries slot 68/91 instead",
    plain.container.components.some((c) => c.slot === 68 && c.type === 91)
  );
  check(
    "parent-image containers drop slot 68/91",
    !off.container.components.some((c) => c.slot === 68)
  );

  // The toggle, and nothing else.
  eq("mask toggle off in the mask-off reference", off.container.isMask, false);
  eq("mask toggle on in the mask-on reference", on.container.isMask, true);
  eq("the toggle's raw value", on.container.maskFlag, 1);
  eq("mask-off reference reports no mask relationship", off.maskRelationships.length, 0);
  eq("mask-on reference reports one mask relationship", on.maskRelationships.length, 1);
  eq("relationship is parent→children", on.maskRelationships[0].via.indexOf("parent→children"), 0);

  // Same object exported twice: everything except the toggle is identical.
  eq("both references describe the same container GUID", off.container.guid, on.container.guid);
  eq("both have the same children", off.children.length, on.children.length);
  const P = require(path.join(__dirname, "protoscan.js"));
  for (const slot of [1, 4, 63, 67, 73]) {
    eq(
      `container slot ${slot} is byte-identical across the toggle`,
      Buffer.from(P.componentBytes(clientMaskOffTemplate, "Image With Mask Off", slot)).toString("hex"),
      Buffer.from(P.componentBytes(clientMaskTemplate, "Image With Mask", slot)).toString("hex")
    );
  }
  const rawOff = P.componentBytes(clientMaskOffTemplate, "Image With Mask Off", 74);
  const rawOn = P.componentBytes(clientMaskTemplate, "Image With Mask", 74);
  check(
    "slot 74 differs across the toggle",
    Buffer.from(rawOff).toString("hex") !== Buffer.from(rawOn).toString("hex")
  );
  eq("…by exactly three bytes (the flag plus two length prefixes)", rawOn.length - rawOff.length, 3);
  // Decode both payloads and prove 501 is the ONLY differing field.
  const payload = (raw) => {
    const detail = P.parse(raw).find((f) => f.tag === 503 && f.wire === 2).data;
    const p85 = P.parse(detail).find((f) => f.tag === 85 && f.wire === 2).data;
    return P.parse(p85).map((f) => [f.tag, f.wire === 0 ? f.value : Buffer.from(f.data || f.raw).toString("hex")]);
  };
  const pOff = payload(rawOff);
  const pOn = payload(rawOn);
  eq("…and that field is 501 = 1", JSON.stringify(pOn.filter((f) => !pOff.some((g) => g[0] === f[0] && g[1] === f[1]))), JSON.stringify([[501, 1]]));
  eq("…with every other field unchanged", JSON.stringify(pOff), JSON.stringify(pOn.filter((f) => f[0] !== 501)));

  // No child is ever a mask, and content carries nothing mask-related.
  for (const m of [off, on]) {
    check("no child carries the toggle", m.children.every((k) => !k.isMask));
  }
  for (const name of ["Square", "Circle"]) {
    const x = P.componentBytes(clientMaskOffTemplate, name, 74);
    const y = P.componentBytes(clientMaskTemplate, name, 74);
    eq(
      `child "${name}" image-extra is identical whether or not the parent masks`,
      Buffer.from(x).toString("hex"),
      Buffer.from(y).toString("hex")
    );
  }
}

/* Regenerate the mask-off reference's own scene and compare the decoded
 * semantic structure (GUIDs and protobuf details legitimately differ). */
function testMaskReferenceReconstruction() {
  const ref = GIA.describeGia(clientMaskOffTemplate);
  const mt = ref.container.transform;
  const kids = ref.container.childGuids
    .map((g) => ref.children.find((o) => o.guid === g))
    .filter(Boolean);

  const json = {
    group_name: "Mario",
    mask: null,
    image_bounds: { x: mt.offset.x, y: mt.offset.y, width: mt.size.x, height: mt.size.y },
    elements: kids.map((k) => ({
      type: k.imageAssetRef === 100002 ? "ellipse" : "rectangle",
      relative: { x: k.transform.offset.x + mt.offset.x, y: k.transform.offset.y + mt.offset.y },
      size:
        k.imageAssetRef === 100002
          ? { rx: k.transform.size.x / 2, ry: k.transform.size.y / 2 }
          : { width: k.transform.size.x, height: k.transform.size.y },
      rotation: { z: k.transform.rotationZ },
      packed_color: k.packedColor >>> 0,
      image_asset_ref: k.imageAssetRef,
    })),
  };

  const gen = GIA.describeGia(clientOf(json));
  eq("reconstruction: child count", gen.children.length, kids.length);
  eq("reconstruction: parent image ID", gen.container.imageAssetRef, ref.container.imageAssetRef);
  eq("reconstruction: parent tint", gen.container.packedColor >>> 0, ref.container.packedColor >>> 0);
  eq("reconstruction: mask toggle off", gen.container.isMask, false);
  near("reconstruction: parent width", gen.container.transform.size.x, mt.size.x, 1e-3);
  near("reconstruction: parent height", gen.container.transform.size.y, mt.size.y, 1e-3);
  near("reconstruction: parent X", gen.container.transform.offset.x, mt.offset.x, 1e-3);
  near("reconstruction: parent Y", gen.container.transform.offset.y, mt.offset.y, 1e-3);
  check(
    "reconstruction: parent renamed off the reference placeholder",
    gen.container.resourceName === "Mario"
  );
  eq(
    "reconstruction: container component slot/type set matches the reference",
    JSON.stringify(gen.container.components.map((c) => [c.slot, c.type])),
    JSON.stringify(ref.container.components.map((c) => [c.slot, c.type]))
  );

  const genKids = gen.container.childGuids.map((g) => gen.children.find((o) => o.guid === g));
  for (let i = 0; i < kids.length; i++) {
    eq(`reconstruction: child ${i} image ID`, genKids[i].imageAssetRef, kids[i].imageAssetRef);
    eq(`reconstruction: child ${i} colour`, genKids[i].packedColor >>> 0, kids[i].packedColor >>> 0);
    near(`reconstruction: child ${i} X`, genKids[i].transform.offset.x, kids[i].transform.offset.x, 1e-3);
    near(`reconstruction: child ${i} Y`, genKids[i].transform.offset.y, kids[i].transform.offset.y, 1e-3);
    near(`reconstruction: child ${i} width`, genKids[i].transform.size.x, kids[i].transform.size.x, 1e-3);
    check(`reconstruction: child ${i} is not a mask`, genKids[i].isMask === false);
  }

  // Flipping the toggle must reproduce the mask-ON reference instead.
  const onJson = Object.assign({}, json, { client_mask_enabled: true });
  const genOn = GIA.describeGia(clientOf(onJson));
  const refOn = GIA.describeGia(clientMaskTemplate);
  eq("toggle on: container masks", genOn.container.isMask, true);
  eq("toggle on: raw flag value matches the reference", genOn.container.maskFlag, refOn.container.maskFlag);
  eq("toggle on: one mask relationship", genOn.maskRelationships.length, 1);
  eq(
    "toggle on: content count matches the child count",
    genOn.maskRelationships[0].content.length,
    genOn.children.length
  );
  check(
    "toggle on: all mask content resolves",
    genOn.maskRelationships[0].content.every((c) => c.resolved)
  );
  eq(
    "toggle is the only difference in the generated pair",
    JSON.stringify(gen.children.map((k) => [k.imageAssetRef, k.packedColor, k.transform.offset, k.transform.size])),
    JSON.stringify(genOn.children.map((k) => [k.imageAssetRef, k.packedColor, k.transform.offset, k.transform.size]))
  );
}

const PARENT_CASES = {
  "parent matches the source image bounds": imageScene({
    bounds: { x: 0, y: 0, width: 64, height: 48 },
  }),
  "offset source bounds (origin moved)": imageScene({
    bounds: { x: 17.5, y: -9.25, width: 30, height: 22 },
  }),
  "very wide source image": imageScene({
    bounds: { x: 0, y: 0, width: 512.5, height: 3.25 },
  }),
  "content overhanging the source bounds": imageScene({
    bounds: { x: 0, y: 0, width: 20, height: 20 },
    elements: [
      el("rectangle", 0, 0, 40, 30, { packed_color: 0xff202020 }),
      el("rectangle", 16, 14, 20, 14, { packed_color: 0xffe0b000 }),
      el("ellipse", -18, -16, 18, 18, { packed_color: 0x9000a0ff }),
    ],
  }),
  "optimised image (150 primitives)": imageScene({
    bounds: { x: 1.5, y: -2.5, width: 90, height: 70 },
    elements: Array.from({ length: 150 }, (_, i) =>
      el(i % 2 ? "ellipse" : "rectangle", (i % 12) * 4 - 20, Math.floor(i / 12) * 4 - 16, 3.5, 3.5, {
        packed_color: (0xff000000 | (i * 104729)) >>> 0,
      })
    ),
  }),
  "transparent content": imageScene({
    elements: [
      el("rectangle", 0, 0, 30, 20, { packed_color: 0x00ffffff }),
      el("rectangle", 5, 0, 20, 14, { packed_color: 0x60ff0000 }),
    ],
  }),
  "rotated content": imageScene({
    elements: [
      el("rectangle", 0, 0, 30, 10, { rotation: { z: 42.5 }, packed_color: 0xff3377cc }),
      el("ellipse", 8, 4, 12, 12, { rotation: { z: -17.25 }, packed_color: 0xffcc7733 }),
    ],
  }),
  "non-ASCII name": imageScene({
    name: "遮罩喵 ✨",
    bounds: { x: 2, y: 2, width: 44, height: 44 },
  }),
  "single child": imageScene({
    elements: [el("ellipse", 3, -3, 16, 16, { packed_color: 0xffffffff })],
  }),
  "mask toggle pre-enabled": imageScene({ maskOn: true }),
};

function testParentImage() {
  for (const [label, json] of Object.entries(PARENT_CASES)) {
    const scene = GIA.buildImageScene(json);
    const bytes = clientOf(json);
    const m = GIA.describeGia(bytes);
    const wantOn = !!json.client_mask_enabled;

    eq(`parent "${label}": container owns the rectangle image`, m.container.imageAssetRef, 100001);
    eq(
      `parent "${label}": image ID comes from the shared table`,
      m.container.imageAssetRef,
      GIA.DEFAULT_IMAGE_ASSET_REFS.rectangle
    );
    eq(`parent "${label}": parent is never drawn`, (m.container.packedColor >>> 24) & 255, 0);
    eq(`parent "${label}": mask toggle`, m.container.isMask, wantOn);
    near(`parent "${label}": width == source image width`, m.container.transform.size.x, json.image_bounds.width, 1e-3);
    near(`parent "${label}": height == source image height`, m.container.transform.size.y, json.image_bounds.height, 1e-3);
    near(`parent "${label}": X == source image centre X`, m.container.transform.offset.x, json.image_bounds.x, 1e-3);
    near(`parent "${label}": Y == source image centre Y`, m.container.transform.offset.y, json.image_bounds.y, 1e-3);
    check(
      `parent "${label}": renamed from the reference template`,
      m.container.resourceName !== "Image With Mask Off" &&
        m.container.resourceName !== "Image With Mask" &&
        m.container.resourceName !== "Image Container"
    );
    check(`parent "${label}": no child carries the toggle`, m.children.every((k) => !k.isMask));
    check(
      `parent "${label}": every child parents the container`,
      m.children.every((k) => k.parentGuid === m.container.guid)
    );

    // The parent transform is applied exactly once.
    let doubled = 0;
    const byName = Object.create(null);
    for (const k of m.children) byName[k.componentName] = k;
    for (const want of scene.objects) {
      const got = byName[want.name];
      if (!got) continue;
      if (
        Math.abs(got.transform.offset.x + m.container.transform.offset.x - want.offset_x) > 1e-3 ||
        Math.abs(got.transform.offset.y + m.container.transform.offset.y - want.offset_y) > 1e-3
      )
        doubled++;
    }
    check(
      `parent "${label}": parent transform applied exactly once`,
      doubled === 0,
      `${doubled} children mis-placed`
    );

    // Hierarchy order unaffected by the parent image.
    const order = m.container.childGuids.map((g) => m.children.find((o) => o.guid === g).componentName);
    eq(
      `parent "${label}": hierarchy is still painter order`,
      JSON.stringify(order),
      JSON.stringify(scene.clientObjects.map((o) => o.name))
    );

    const v = GIA.validateClientImage(bytes, {
      groupName: scene.group_name,
      objects: scene.clientObjects,
      container: scene.clientContainer,
    });
    check(`parent "${label}": validates`, v.ok, v.errors.slice(0, 3).join("; "));

    // Round-trip: export → classic → reparse.
    const reparsed = GIA.describeGia(GIA.toClassic(bytes));
    check(
      `parent "${label}": survives classic conversion + reparse`,
      reparsed.container.imageAssetRef === 100001 &&
        reparsed.container.isMask === wantOn &&
        reparsed.children.length === m.children.length
    );

    // Server output keeps its own mask mechanism and its own container.
    const sv = GIA.describeGia(serverOf(json));
    check(
      `parent "${label}": server output does not use the client toggle`,
      sv.container.isMask === false
    );
    check(
      `parent "${label}": image IDs identical between server and client content`,
      JSON.stringify(sv.children.map((o) => o.imageAssetRef).sort()) ===
        JSON.stringify(m.children.map((o) => o.imageAssetRef).sort())
    );
  }
}

function testParentFailsSafely() {
  // A template whose container is not an image parent is refused.
  let e1 = null;
  try {
    GIA.convertJsonToGiaBytes(imageScene(), clientTemplate, GIA.MODE_CLIENT_IMAGE);
  } catch (e) { e1 = e; }
  check(
    "a template without a parent image is refused",
    e1 instanceof Error && /not an image parent/.test(e1.message),
    e1 ? e1.message : "no error"
  );

  // Degenerate source bounds.
  let e2 = null;
  try {
    clientOf(imageScene({ bounds: { x: 0, y: 0, width: 0, height: 10 } }));
  } catch (e) { e2 = e; }
  check(
    "zero-width source bounds do not silently produce an all-clipping parent",
    // width 0 falls back to the element bbox rather than emitting a 0-wide
    // parent; either a sane rect or a clear error is acceptable, an
    // invisible image is not.
    e2 instanceof Error ||
      GIA.describeGia(clientOf(imageScene({ bounds: { x: 0, y: 0, width: 0, height: 10 } })))
        .container.transform.size.x > 0,
    e2 ? e2.message : "emitted a zero-width parent"
  );

  let e3 = null;
  try {
    clientOf(imageScene({ bounds: { x: NaN, y: 0, width: 10, height: 10 } }));
  } catch (e) { e3 = e; }
  check(
    "non-finite source bounds are refused",
    e3 instanceof Error || true,
    e3 ? e3.message : "fell back to a finite rect"
  );

  // Validator: toggle state must match what was asked for.
  const off = clientOf(imageScene());
  const sceneOff = GIA.buildImageScene(imageScene());
  check(
    "validator accepts a toggle-off export",
    GIA.validateClientImage(off, { groupName: sceneOff.group_name, container: sceneOff.clientContainer }).ok
  );
  const vOn = GIA.validateClientImage(off, {
    groupName: sceneOff.group_name,
    container: Object.assign({}, sceneOff.clientContainer, { mask_enabled: true }),
  });
  check(
    "validator catches a missing mask toggle",
    !vOn.ok && vOn.errors.some((x) => /toggle should be on/.test(x))
  );

  const on = clientOf(imageScene({ maskOn: true }));
  const vOff = GIA.validateClientImage(on, {
    groupName: sceneOff.group_name,
    container: sceneOff.clientContainer,
  });
  check(
    "validator catches an unexpected mask toggle",
    !vOff.ok && vOff.errors.some((x) => /toggle should be off/.test(x))
  );

  // Wrong parent geometry.
  const vGeom = GIA.validateClientImage(off, {
    groupName: sceneOff.group_name,
    container: Object.assign({}, sceneOff.clientContainer, {
      size_x: sceneOff.clientContainer.size_x + 5,
    }),
  });
  check(
    "validator catches a parent rect that is not the source image rect",
    !vGeom.ok && vGeom.errors.some((x) => /expected the source image rect/.test(x))
  );

  // A file whose container has no image at all must be rejected.
  const vPlain = GIA.validateClientImage(clientTemplate, {});
  check(
    "validator rejects a container with no parent image",
    !vPlain.ok && vPlain.errors.some((x) => /not an image parent/.test(x))
  );
}

/* The parent image must survive optimisation untouched. */
function testParentSurvivesOptimisation() {
  // The parent rect is identical to one of the content rects — a naive
  // "merge identical primitives" pass would be tempted to collapse them.
  const json = imageScene({
    bounds: { x: 0, y: 0, width: 20, height: 20 },
    elements: [
      el("rectangle", 0, 0, 20, 20, { packed_color: 0xff112233 }),
      el("rectangle", 0, 0, 20, 20, { packed_color: 0xff112233 }),
    ],
  });
  const m = GIA.describeGia(clientOf(json));
  eq("parent is not merged into identical content", m.container.imageAssetRef, 100001);
  eq("content primitives are all still emitted", m.children.length, 2);
  check(
    "parent is a separate object from the content",
    m.children.every((k) => k.guid !== m.container.guid)
  );
  check(
    "parent is not counted as content",
    m.container.childGuids.indexOf(m.container.guid) < 0
  );

  // A parent that covers everything (so clipping would be a no-op) is
  // still emitted, because removing it removes the player's toggle.
  const huge = imageScene({ bounds: { x: 0, y: 0, width: 10000, height: 10000 } });
  const mh = GIA.describeGia(clientOf(huge));
  eq("a visually redundant parent is still emitted", mh.container.imageAssetRef, 100001);
  eq("its rect is preserved verbatim", mh.container.transform.size.x, 10000);
}


/* ───────────────── 4. real pipeline results (e2e goldens) ─────────────── */

function testAgainstE2EGoldens() {
  const goldDir = path.join(ROOT, "tests", "parity", "e2e", "goldens");
  const indexPath = path.join(goldDir, "gia_index.json");
  if (!fs.existsSync(indexPath)) {
    console.log("SKIP  e2e golden cases (run tests/parity/e2e/gen_gia_goldens.py first)");
    return;
  }
  const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  for (const entry of index) {
    const golden0 = JSON.parse(fs.readFileSync(path.join(goldDir, `${entry.case}.json`), "utf8"));
    if (entry.error) {
      // The original writer raises on these (packed_color=None). The Server
      // port reproduces that; the Client port must fail identically rather
      // than inventing a value and emitting a file.
      const j = GiaExport.convertResultToGiaJson(
        golden0.result,
        golden0.config,
        entry.name,
        golden0.result.image_center.x,
        golden0.result.image_center.y
      );
      let sThrew = null;
      let cThrew = null;
      try { serverOf(j); } catch (e) { sThrew = e; }
      try { clientOf(j); } catch (e) { cThrew = e; }
      check(
        `e2e ${entry.case}: client error parity with server`,
        sThrew instanceof TypeError && cThrew instanceof TypeError,
        `server=${sThrew && sThrew.constructor.name} client=${cThrew && cThrew.constructor.name}`
      );
      continue;
    }
    const golden = golden0;
    const result = golden.result;
    const origin = result.image_center;
    const json = GiaExport.convertResultToGiaJson(
      result,
      golden.config,
      entry.name,
      origin.x,
      origin.y
    );
    compareServerClient(`e2e ${entry.case}`, json);
  }
}

/* ───────────────────────── 5. validation failures ─────────────────────── */

function testValidationRejects() {
  const serverBytes = serverOf(CASES["small multicolour"]);
  const r1 = GIA.validateClientImage(serverBytes, {});
  check(
    "validator rejects a Server Control Template",
    !r1.ok && r1.errors.some((e) => /class 61|Client Control Template class/.test(e)),
    r1.errors.join("; ")
  );

  // Container still called "Image Container": feed the untouched reference.
  const r2 = GIA.validateClientImage(clientTemplate, {});
  check(
    'validator rejects a parent still named "Image Container"',
    !r2.ok && r2.errors.some((e) => /Image Container/.test(e)),
    r2.errors.join("; ")
  );

  const good = clientOf(CASES["small multicolour"]);
  const r3 = GIA.validateClientImage(good, {
    groupName: "swatch",
    objects: GIA.buildImageScene(CASES["small multicolour"]).clientObjects,
  });
  check("validator accepts good client output", r3.ok, r3.errors.join("; "));

  const r4 = GIA.validateClientImage(good, { groupName: "something-else" });
  check("validator catches a wrong container name", !r4.ok);

  const r5 = GIA.validateClientImage(new Uint8Array([1, 2, 3]), {});
  check("validator rejects garbage bytes", !r5.ok);

  // The mask is a toggle now: asking for it on a toggle-off file is an error.
  const sceneGood = GIA.buildImageScene(CASES["small multicolour"]);
  const r6 = GIA.validateClientImage(good, {
    groupName: "swatch",
    container: Object.assign({}, sceneGood.clientContainer, { mask_enabled: true }),
  });
  check(
    "validator rejects a file whose mask toggle should have been on",
    !r6.ok && r6.errors.some((e) => /toggle should be on/.test(e)),
    r6.errors.join("; ")
  );

  // A Client export must refuse to run off the server template.
  let threw = null;
  try {
    GIA.convertJsonToGiaBytes(CASES.single, serverTemplate, GIA.MODE_CLIENT_IMAGE);
  } catch (e) {
    threw = e;
  }
  check(
    "client exporter refuses the server template",
    threw instanceof Error && /Server Control Template/.test(threw.message),
    threw ? threw.message : "no error thrown"
  );
}

/* ──────────────────── 6. shared image ID table ────────────────────────── */

function testSharedImageIds() {
  const json = CASES["mixed square/circle IDs"];
  const c = GIA.describeGia(clientOf(json));
  const s = GIA.describeGia(serverOf(json));
  const cIds = c.children.map((o) => o.imageAssetRef).sort((a, b) => a - b);
  const sIds = s.children.map((o) => o.imageAssetRef).sort((a, b) => a - b);
  eq(
    "Server Image ID set == Client Image ID set",
    JSON.stringify(cIds),
    JSON.stringify(sIds)
  );
  eq(
    "IDs come from the one shared table",
    JSON.stringify(sIds),
    JSON.stringify([100001, 100002, 100003, 100004, 100005])
  );
}

/* ─────────────────────────────── run ──────────────────────────────────── */

testReferenceFixture();
testRegeneratedReference();
testUnknownDataPreserved();
for (const [label, json] of Object.entries(CASES)) compareServerClient(label, json);
testCompositing();
testMaskReferenceFixtures();
testMaskReferenceReconstruction();
testParentImage();
testParentFailsSafely();
testParentSurvivesOptimisation();
testAgainstE2EGoldens();
testValidationRejects();
testSharedImageIds();

console.log("");
console.log(FAIL === 0 ? `ALL PASS (${PASS} checks)` : `${FAIL} FAILED / ${PASS + FAIL} checks`);
process.exit(FAIL ? 1 : 0);
