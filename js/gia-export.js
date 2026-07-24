/*
 * gia-export.js — exact port of server.py's _convert_result_to_gia_bytes
 * glue (result data → json_data for the GIA writer). Kept as a standalone
 * module so the parity suite can byte-compare it against the Python
 * original in Node.
 *
 * NOTE: server.py builds fresh element dicts and does NOT forward
 * `is_background` — the writer therefore never sees the flag from the web
 * pipeline. Preserve that behavior exactly.
 */
"use strict";

const GiaExport = (() => {

  const DEFAULT_IMAGE_ASSET_REFS = { rectangle: 100001, ellipse: 100002, triangle: 100003 };

  /* server.py _derive_upload_image_name + _export_basename */
  function exportBasename(imageName) {
    const base = String(imageName || "").trim().split(/[\\/]/).pop() || "";
    const stem = base.replace(/\.[^.]*$/, "").trim();
    if (stem) return stem;
    return String(imageName || "").trim() || "shaper_result";
  }

  function convertResultToGiaJson(resultData, cfg, imageName, originX, originY) {
    cfg = cfg || {};
    const pixelPerUnit = Number(
      (resultData.config && resultData.config.pixel_per_unit) || cfg.primitive_size || 1.0
    );
    const originUnitsX = originX / pixelPerUnit;
    const originUnitsY = -originY / pixelPerUnit;

    const elements = [];
    for (const element of resultData.elements || []) {
      let shapeType = element.type;
      if (shapeType === "circle") shapeType = "ellipse";
      else if (shapeType === "rect") shapeType = "rectangle";

      // Python: rotation = element.get("rotation", {}) or {} — a numeric
      // rotation (fill background element uses 0.0) is falsy → {}
      const rawRotation = element.rotation;
      const rotation = (rawRotation && typeof rawRotation === "object") ? rawRotation : {};
      const center = element.center || {};
      const exported = {
        type: shapeType,
        relative: {
          x: Number(center.x || 0) - originUnitsX,
          y: Number(center.y || 0) - originUnitsY,
        },
        size: element.size !== undefined ? element.size : {},
        rotation,
        color: element.color !== undefined ? element.color : null,
        alpha: element.alpha !== undefined ? element.alpha : null,
        packed_color: element.packed_color !== undefined ? element.packed_color : null,
        image_asset_ref: element.image_asset_ref !== undefined
          ? element.image_asset_ref
          : (DEFAULT_IMAGE_ASSET_REFS[shapeType] !== undefined ? DEFAULT_IMAGE_ASSET_REFS[shapeType] : 100002),
      };
      if (element.type_id !== undefined && element.type_id !== null) {
        exported.type_id = Math.trunc(element.type_id);
      } else if (element.element_type_id !== undefined && element.element_type_id !== null) {
        exported.type_id = Math.trunc(element.element_type_id);
      }
      if (element.element_type_id !== undefined && element.element_type_id !== null) {
        exported.element_type_id = Math.trunc(element.element_type_id);
      }
      if (rotation.y !== undefined && rotation.y !== null) {
        exported.rot_y_add = Number(rotation.y || 0);
      }
      elements.push(exported);
    }

    let maskCfg = null;
    const maskData = resultData.mask || null;
    if (maskData && Object.keys(maskData).length) {
      const maskCenter = maskData.center || {};
      const maskSize = maskData.size || {};
      maskCfg = {
        enabled: Boolean(maskData.enabled),
        shape_type: maskData.shape_type !== undefined ? maskData.shape_type : "rectangle",
        center: {
          x: Number(maskCenter.x || 0) - originUnitsX,
          y: Number(maskCenter.y || 0) - originUnitsY,
        },
        size: {
          width: Number(maskSize.width || 0),
          height: Number(maskSize.height || 0),
        },
      };
    }

    return {
      elements,
      mask: maskCfg,
      group_name: exportBasename(imageName),
    };
  }

  return { convertResultToGiaJson, exportBasename, DEFAULT_IMAGE_ASSET_REFS };
})();

if (typeof module !== "undefined") module.exports = GiaExport;
