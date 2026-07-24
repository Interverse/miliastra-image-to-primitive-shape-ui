"""GIA export goldens: run the ORIGINAL server-side glue
(server.py _convert_result_to_gia_bytes, copied verbatim minus Flask) over
the outline/fill E2E golden results, through the reconstructed GIA writer
and the classic converter. The JS side must produce identical bytes."""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "gia"))

import json_to_gia_reconstructed as json_to_gia  # noqa: E402
import convert_to_classic  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), "goldens")

DEFAULT_IMAGE_ASSET_REFS = {"rectangle": 100001, "ellipse": 100002, "triangle": 100003}


def _derive_upload_image_name(filename):
    if not filename:
        return ""
    base_name = os.path.basename(str(filename).strip())
    stem, _ = os.path.splitext(base_name)
    return stem.strip()


def _export_basename(image_name):
    normalized = _derive_upload_image_name(image_name)
    if normalized:
        return normalized
    return (image_name or "").strip() or "shaper_result"


def convert_result_to_gia_bytes(result_data, cfg=None, image_name="", origin_x=None, origin_y=None):
    """Verbatim port of server.py _convert_result_to_gia_bytes (paths swapped)."""
    cfg = cfg or {}
    pixel_per_unit = float(result_data.get("config", {}).get("pixel_per_unit") or cfg.get("primitive_size") or 1.0)
    origin_default = result_data.get("image_center", {"x": 0, "y": 0})
    resolved_origin_x = float(origin_default.get("x", 0) if origin_x is None else origin_x)
    resolved_origin_y = float(origin_default.get("y", 0) if origin_y is None else origin_y)

    origin_units_x = resolved_origin_x / pixel_per_unit
    origin_units_y = -resolved_origin_y / pixel_per_unit

    elements = []
    for element in result_data.get("elements", []):
        shape_type = element.get("type")
        if shape_type == "circle":
            shape_type = "ellipse"
        elif shape_type == "rect":
            shape_type = "rectangle"

        rotation = element.get("rotation", {}) or {}
        center = element.get("center", {}) or {}
        exported = {
            "type": shape_type,
            "relative": {
                "x": float(center.get("x", 0)) - origin_units_x,
                "y": float(center.get("y", 0)) - origin_units_y,
            },
            "size": element.get("size", {}),
            "rotation": rotation,
            "color": element.get("color"),
            "alpha": element.get("alpha"),
            "packed_color": element.get("packed_color"),
            "image_asset_ref": element.get("image_asset_ref", DEFAULT_IMAGE_ASSET_REFS.get(shape_type, 100002)),
        }
        if element.get("type_id") is not None:
            exported["type_id"] = int(element["type_id"])
        elif element.get("element_type_id") is not None:
            exported["type_id"] = int(element["element_type_id"])
        if element.get("element_type_id") is not None:
            exported["element_type_id"] = int(element["element_type_id"])
        if rotation.get("y") is not None:
            exported["rot_y_add"] = float(rotation.get("y", 0))
        elements.append(exported)

    mask_cfg = None
    mask_data = result_data.get("mask") or {}
    if mask_data:
        mask_center = mask_data.get("center") or {}
        mask_size = mask_data.get("size") or {}
        mask_cfg = {
            "enabled": bool(mask_data.get("enabled", False)),
            "shape_type": mask_data.get("shape_type", "rectangle"),
            "center": {
                "x": float(mask_center.get("x", 0)) - origin_units_x,
                "y": float(mask_center.get("y", 0)) - origin_units_y,
            },
            "size": {
                "width": float(mask_size.get("width", 0)),
                "height": float(mask_size.get("height", 0)),
            },
        }

    json_data = {
        "elements": elements,
        "mask": mask_cfg,
        "group_name": _export_basename(image_name),
    }

    return json_to_gia.convert_json_to_gia_bytes(
        json_data=json_data,
        base_gia_path=os.path.join(ROOT, "assets", "image_template.gia"),
        mode=json_to_gia.MODE_IMAGE,
    )


def process_index(index_file, prefix):
    idx_path = os.path.join(OUT, index_file)
    if not os.path.exists(idx_path):
        print(f"skip {index_file} (not generated)")
        return []
    cases = json.load(open(idx_path))
    produced = []
    for case_id in cases:
        golden = json.load(open(os.path.join(OUT, f"{case_id}.json"), encoding="utf-8"))
        result = golden["result"]
        cfg = golden["config"]
        # default origin = image center; unicode export name exercises UTF-8
        name = f"{case_id}_素材"
        origin = result["image_center"]
        try:
            gia = convert_result_to_gia_bytes(result, cfg, name, origin["x"], origin["y"])
        except TypeError as exc:
            # The original errors here for outline results (packed_color=None,
            # the currently-broken decoration export). Error IS the golden.
            produced.append({"case": case_id, "name": name, "error": str(exc)})
            print(f"{case_id}: ERROR (golden): {exc}")
            continue
        classic = convert_to_classic.convert_gia_bytes_to_classic(gia)
        with open(os.path.join(OUT, f"{case_id}.gia"), "wb") as f:
            f.write(gia)
        with open(os.path.join(OUT, f"{case_id}_classic.gia"), "wb") as f:
            f.write(classic)
        produced.append({"case": case_id, "name": name})
        print(f"{case_id}: gia {len(gia)}B classic {len(classic)}B")
    return produced


all_cases = []
all_cases += process_index("outline_index.json", "outline")
all_cases += process_index("fill_index.json", "fill")
with open(os.path.join(OUT, "gia_index.json"), "w", encoding="utf-8") as f:
    json.dump(all_cases, f, ensure_ascii=False)
print("gia goldens done:", len(all_cases))
