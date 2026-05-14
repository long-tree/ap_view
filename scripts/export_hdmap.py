#!/usr/bin/env python3
import json
import sys
from pathlib import Path

from google.protobuf.json_format import MessageToDict


PROTO_ROOT = Path(
    "/apollo_workspace/.cache/bazel/679551712d2357b63e6e0ce858ebf90e/"
    "execroot/application-pnc/bazel-out/k8-opt/bin/external/apollo_src"
)


def point(p):
    return {"x": round(p.x, 4), "y": round(p.y, 4), "z": round(p.z, 4)}


def point_xy(p):
    return {"x": round(p.x, 4), "y": round(p.y, 4)}


def curve_points(curve):
    points = []
    for segment in curve.segment:
        if not segment.HasField("line_segment"):
            continue
        for p in segment.line_segment.point:
            q = point_xy(p)
            if not points or points[-1] != q:
                points.append(q)
    return points


def polygon_points(poly):
    return [point_xy(p) for p in poly.point]


def enum_name(message, field_name, value):
    enum = message.DESCRIPTOR.fields_by_name[field_name].enum_type
    return enum.values_by_number.get(value).name if value in enum.values_by_number else str(value)


def boundary_types(boundary):
    types = []
    for item in boundary.boundary_type:
        enum = item.DESCRIPTOR.fields_by_name["types"].enum_type
        names = [enum.values_by_number.get(v).name for v in item.types]
        types.extend(name for name in names if name)
    return sorted(set(types))


def ids(values):
    return [value.id for value in values]


def stop_lines(item):
    return [curve_points(curve) for curve in item.stop_line if curve_points(curve)]


def bounds_for(points):
    valid = [p for p in points if "x" in p and "y" in p]
    if not valid:
        return None
    return {
        "minX": min(p["x"] for p in valid),
        "maxX": max(p["x"] for p in valid),
        "minY": min(p["y"] for p in valid),
        "maxY": max(p["y"] for p in valid),
    }


def add_points(out, points):
    for p in points:
        if "x" in p and "y" in p:
            out.append(p)


def render_data(hdmap, src):
    lane_to_road = {}
    for road in hdmap.road:
        for section in road.section:
            for lane_id in section.lane_id:
                lane_to_road[lane_id.id] = {
                    "roadId": road.id.id,
                    "sectionId": section.id.id,
                }

    data = {
        "source": str(src),
        "lanes": [],
        "roads": [],
        "junctions": [],
        "crosswalks": [],
        "parkingSpaces": [],
        "signals": [],
        "stopSigns": [],
        "yieldSigns": [],
        "clearAreas": [],
        "speedBumps": [],
        "pncJunctions": [],
        "rsus": [],
        "adAreas": [],
        "barrierGates": [],
        "overlaps": [],
        "summary": {},
        "bounds": None,
    }
    all_points = []

    for lane in hdmap.lane:
        road_ref = lane_to_road.get(lane.id.id, {})
        item = {
            "id": lane.id.id,
            "roadId": road_ref.get("roadId"),
            "sectionId": road_ref.get("sectionId"),
            "center": curve_points(lane.central_curve),
            "left": curve_points(lane.left_boundary.curve),
            "right": curve_points(lane.right_boundary.curve),
            "leftTypes": boundary_types(lane.left_boundary),
            "rightTypes": boundary_types(lane.right_boundary),
            "speedLimit": round(lane.speed_limit, 3),
            "length": round(lane.length, 3),
            "type": enum_name(lane, "type", lane.type),
            "turn": enum_name(lane, "turn", lane.turn),
            "direction": enum_name(lane, "direction", lane.direction),
            "predecessorIds": ids(lane.predecessor_id),
            "successorIds": ids(lane.successor_id),
            "leftNeighborForwardLaneIds": ids(lane.left_neighbor_forward_lane_id),
            "rightNeighborForwardLaneIds": ids(lane.right_neighbor_forward_lane_id),
            "leftNeighborReverseLaneIds": ids(lane.left_neighbor_reverse_lane_id),
            "rightNeighborReverseLaneIds": ids(lane.right_neighbor_reverse_lane_id),
            "overlapIds": ids(lane.overlap_id),
        }
        data["lanes"].append(item)
        add_points(all_points, item["center"])
        add_points(all_points, item["left"])
        add_points(all_points, item["right"])

    for road in hdmap.road:
        item = {
            "id": road.id.id,
            "sectionIds": [section.id.id for section in road.section],
        }
        data["roads"].append(item)

    for junction in hdmap.junction:
        item = {"id": junction.id.id, "polygon": polygon_points(junction.polygon), "overlapIds": ids(junction.overlap_id)}
        data["junctions"].append(item)
        add_points(all_points, item["polygon"])

    for crosswalk in hdmap.crosswalk:
        item = {"id": crosswalk.id.id, "polygon": polygon_points(crosswalk.polygon), "overlapIds": ids(crosswalk.overlap_id)}
        data["crosswalks"].append(item)
        add_points(all_points, item["polygon"])

    for parking in hdmap.parking_space:
        item = {
            "id": parking.id.id,
            "polygon": polygon_points(parking.polygon),
            "overlapIds": ids(parking.overlap_id),
            "heading": round(parking.heading, 5),
        }
        data["parkingSpaces"].append(item)
        add_points(all_points, item["polygon"])

    for signal in hdmap.signal:
        item = {
            "id": signal.id.id,
            "boundary": polygon_points(signal.boundary),
            "stopLines": stop_lines(signal),
            "overlapIds": ids(signal.overlap_id),
            "type": enum_name(signal, "type", signal.type),
        }
        data["signals"].append(item)
        add_points(all_points, item["boundary"])
        for line in item["stopLines"]:
            add_points(all_points, line)

    for stop_sign in hdmap.stop_sign:
        item = {"id": stop_sign.id.id, "stopLines": stop_lines(stop_sign), "overlapIds": ids(stop_sign.overlap_id)}
        data["stopSigns"].append(item)
        for line in item["stopLines"]:
            add_points(all_points, line)

    for yield_sign in getattr(hdmap, "yield"):
        item = {"id": yield_sign.id.id, "stopLines": stop_lines(yield_sign), "overlapIds": ids(yield_sign.overlap_id)}
        data["yieldSigns"].append(item)
        for line in item["stopLines"]:
            add_points(all_points, line)

    for clear_area in hdmap.clear_area:
        item = {"id": clear_area.id.id, "polygon": polygon_points(clear_area.polygon), "overlapIds": ids(clear_area.overlap_id)}
        data["clearAreas"].append(item)
        add_points(all_points, item["polygon"])

    for speed_bump in hdmap.speed_bump:
        item = {"id": speed_bump.id.id, "position": [curve_points(curve) for curve in speed_bump.position], "overlapIds": ids(speed_bump.overlap_id)}
        data["speedBumps"].append(item)
        for line in item["position"]:
            add_points(all_points, line)

    for pnc_junction in hdmap.pnc_junction:
        data["pncJunctions"].append(MessageToDict(pnc_junction, preserving_proto_field_name=True))

    for rsu in hdmap.rsu:
        data["rsus"].append(MessageToDict(rsu, preserving_proto_field_name=True))

    for ad_area in hdmap.ad_area:
        data["adAreas"].append(MessageToDict(ad_area, preserving_proto_field_name=True))

    for barrier_gate in hdmap.barrier_gate:
        data["barrierGates"].append(MessageToDict(barrier_gate, preserving_proto_field_name=True))

    for overlap in hdmap.overlap:
        data["overlaps"].append(MessageToDict(overlap, preserving_proto_field_name=True))

    data["summary"] = {
        "lanes": len(data["lanes"]),
        "roads": len(data["roads"]),
        "junctions": len(data["junctions"]),
        "crosswalks": len(data["crosswalks"]),
        "parkingSpaces": len(data["parkingSpaces"]),
        "signals": len(data["signals"]),
        "stopSigns": len(data["stopSigns"]),
        "yieldSigns": len(data["yieldSigns"]),
        "clearAreas": len(data["clearAreas"]),
        "speedBumps": len(data["speedBumps"]),
        "pncJunctions": len(data["pncJunctions"]),
        "rsus": len(data["rsus"]),
        "adAreas": len(data["adAreas"]),
        "barrierGates": len(data["barrierGates"]),
        "overlaps": len(data["overlaps"]),
    }
    data["bounds"] = bounds_for(all_points)
    return data


def main():
    if len(sys.argv) != 4:
        raise SystemExit("usage: export_hdmap.py <base_map.bin> <render-output.json> <full-output.json>")

    sys.path.insert(0, str(PROTO_ROOT))
    from modules.common_msgs.map_msgs import map_pb2

    src = Path(sys.argv[1])
    render_dst = Path(sys.argv[2])
    full_dst = Path(sys.argv[3])

    hdmap = map_pb2.Map()
    hdmap.ParseFromString(src.read_bytes())

    render_dst.parent.mkdir(parents=True, exist_ok=True)
    full_dst.parent.mkdir(parents=True, exist_ok=True)

    render = render_data(hdmap, src)
    render_dst.write_text(json.dumps(render, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    full = MessageToDict(hdmap, preserving_proto_field_name=True)
    full_dst.write_text(json.dumps(full, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    print(f"wrote render {render_dst}")
    print(f"wrote full {full_dst}")
    print(json.dumps(render["summary"], sort_keys=True))


if __name__ == "__main__":
    main()
