const canvas = document.getElementById("viewer");
const ctx = canvas.getContext("2d");
const sampleSelect = document.getElementById("sampleSelect");
const fileInput = document.getElementById("fileInput");
const hdmapSelect = document.getElementById("hdmapSelect");
const hdmapStatus = document.getElementById("hdmapStatus");
const scenarioLayerToggles = document.getElementById("scenarioLayerToggles");
const hdmapLayerToggles = document.getElementById("hdmapLayerToggles");
const summary = document.getElementById("summary");
const objectList = document.getElementById("objectList");
const fitButton = document.getElementById("fitButton");
const resetButton = document.getElementById("resetButton");
const cursorReadout = document.getElementById("cursorReadout");

const hdmapLayerDefs = [
  ["map", "启用HDMap"],
  ["laneCenters", "Lane中心"],
  ["laneBoundaries", "Lane边界"],
  ["laneTopology", "Lane拓扑"],
  ["junctions", "路口区域"],
  ["crosswalks", "人行横道"],
  ["parking", "停车位"],
  ["mapSignals", "地图信号"],
  ["speedBumps", "减速带"],
  ["yieldSigns", "让行线"],
  ["mapLabels", "地图标签"],
];

const scenarioLayerDefs = [
  ["grid", "坐标网格"],
  ["ego", "主车路径"],
  ["waypoints", "路由点"],
  ["objects", "障碍物"],
  ["objectRoutes", "障碍物轨迹"],
  ["dynamic", "动态交通"],
  ["trafficLights", "红绿灯"],
  ["triggers", "触发条件"],
  ["labels", "标签"],
  ["bounds", "范围框"],
  ["swapDims", "长宽翻转"],
];

const colors = {
  ego: "#126b78",
  waypoint: "#0f7c47",
  static: "#b98514",
  vehicle: "#b63f46",
  pedestrian: "#7b4eb3",
  dynamic: "#7357b8",
  traffic: "#2d7d46",
  trigger: "#6d7880",
  bounds: "#c2582c",
  laneCenter: "#7b858b",
  laneBoundary: "#4d5961",
  junction: "#8a7a2d",
  crosswalk: "#5b7f8c",
  parking: "#526fa8",
  mapSignal: "#8d4c73",
  topology: "#1f6f9d",
  speedBump: "#984f22",
};

let layers = Object.fromEntries([...scenarioLayerDefs, ...hdmapLayerDefs].map(([key]) => [key, true]));
layers.map = false;
layers.laneTopology = false;
layers.mapLabels = false;
layers.swapDims = false;
let currentScenario = null;
let scene = null;
let hdmapManifest = [];
let selectedHdmap = null;
let mapLayer = { key: null, data: null, status: "off", promise: null };
let view = { scale: 1, offsetX: 0, offsetY: 0 };
let dragging = false;
let dragStart = null;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function fmt(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function kindOf(obj) {
  return Object.keys(obj?.entityObject || {})[0] || "unknown";
}

function dimsOf(obj) {
  const kind = kindOf(obj);
  return obj?.entityObject?.[kind]?.boundingBox?.dimensions || {};
}

function collectWorldPositions(value, out = []) {
  if (!value) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectWorldPositions(item, out);
    return out;
  }
  if (typeof value !== "object") return out;
  if (value.worldPosition && Number.isFinite(value.worldPosition.x) && Number.isFinite(value.worldPosition.y)) {
    out.push(value.worldPosition);
  }
  for (const child of Object.values(value)) collectWorldPositions(child, out);
  return out;
}

function collectCoordinatePairs(value, out = [], path = "") {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCoordinatePairs(item, out, `${path}[${index}]`));
    return out;
  }
  if (typeof value !== "object") return out;

  if (Number.isFinite(value.x) && Number.isFinite(value.y)) {
    out.push({ x: value.x, y: value.y, path });
  }
  if (Number.isFinite(value.spawnX) && Number.isFinite(value.spawnY)) {
    out.push({ x: value.spawnX, y: value.spawnY, path: `${path}.spawn` });
  }
  if (Number.isFinite(value.endX) && Number.isFinite(value.endY)) {
    out.push({ x: value.endX, y: value.endY, path: `${path}.end` });
  }

  for (const [key, child] of Object.entries(value)) {
    collectCoordinatePairs(child, out, path ? `${path}.${key}` : key);
  }
  return out;
}

function dedupePoints(points) {
  const seen = new Set();
  const unique = [];
  for (const p of points) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    const key = `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ x: p.x, y: p.y });
  }
  return unique;
}

function extractScenario(json) {
  const scenario = json.scenario || {};
  const objects = new Map((scenario.entities?.scenarioObjects || []).map((obj) => [String(obj.name), obj]));
  const privates = scenario.storyboard?.init?.actions?.privates || [];

  const entities = privates.map((entry) => {
    const ref = String(entry.entityRef?.entityRef || "");
    const object = objects.get(ref) || { name: ref, entityObject: {} };
    const actions = entry.privateActions || [];
    const teleport = actions.find((a) => a.teleportAction)?.teleportAction?.position?.worldPosition;
    const routeAction = actions.find((a) => a.routingAction)?.routingAction;
    const routePoints = collectWorldPositions(routeAction);
    const speedAction = actions.find((a) => a.longitudinalAction)?.longitudinalAction?.speedAction;
    return {
      ref,
      id: object.id,
      kind: kindOf(object),
      dims: dimsOf(object),
      teleport,
      routePoints,
      speed: speedAction?.speedActionTarget?.absoluteTargetSpeed?.value,
      dynamics: speedAction?.speedActionDynamics,
      raw: object,
    };
  });

  const auto = scenario.autoCarInfo || {};
  const routeWaypoints = (auto.routingRequest?.waypoint || [])
    .map((w) => w.pose)
    .filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y));
  const ego = {
    start: auto.start,
    end: auto.end,
    route: routeWaypoints.length ? routeWaypoints : [auto.start, auto.end].filter(Boolean),
    startVelocity: auto.startVelocity,
  };

  const dynamic = scenario.dynamicTrafficFlowConfig?.spawnPoints || [];
  const trafficLights = scenario.roadNetwork?.trafficLights || [];
  const triggers = collectTriggers(scenario.storyboard);
  const allPoints = [];

  for (const p of ego.route) addPoint(allPoints, p);
  for (const entity of entities) {
    addPoint(allPoints, entity.teleport);
    for (const p of entity.routePoints) addPoint(allPoints, p);
  }
  for (const light of trafficLights) addPoint(allPoints, light.location);
  for (const spawn of dynamic) {
    addPoint(allPoints, { x: spawn.spawnX, y: spawn.spawnY });
    addPoint(allPoints, { x: spawn.endX, y: spawn.endY });
    for (const p of spawn.routeWaypoints || []) addPoint(allPoints, p);
  }
  const coordinatePoints = dedupePoints([...allPoints, ...collectCoordinatePairs(scenario)]);

  return {
    json,
    scenario,
    title: json.descriptionEnTokens?.join(", ") || json.descriptionEn || json.id || "scenario",
    id: json.id,
    mapId: json.mapId,
    tags: json.tags || [],
    entities,
    ego,
    dynamic,
    trafficLights,
    triggers,
    coordinatePoints,
    bounds: boundsFor(coordinatePoints),
  };
}

function addPoint(points, p) {
  if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) points.push({ x: p.x, y: p.y });
}

function boundsFor(points) {
  if (!points.length) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  return {
    minX: Math.min(...points.map((p) => p.x)),
    maxX: Math.max(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

function collectTriggers(storyboard) {
  const triggers = [];
  const walk = (value, path = "") => {
    if (!value) return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof value !== "object") return;
    if (value.startTrigger || value.stopTrigger) {
      triggers.push({ path, trigger: value.startTrigger || value.stopTrigger });
    }
    for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
  };
  walk(storyboard);
  return triggers;
}

function setScenario(json, label) {
  currentScenario = json;
  scene = extractScenario(json);
  scene.label = label;
  renderSummary(label);
  renderObjects();
  fitToBounds();
  if (layers.map) ensureMapLoaded();
}

async function loadManifest() {
  const manifest = await fetch("./samples/manifest.json").then((r) => r.json());
  sampleSelect.innerHTML = "";
  for (const item of manifest.scenarios) {
    const option = document.createElement("option");
    option.value = item.file;
    option.textContent = item.name;
    sampleSelect.appendChild(option);
  }
  sampleSelect.addEventListener("change", () => loadSample(sampleSelect.value));
  if (manifest.scenarios[0]) loadSample(manifest.scenarios[0].file);
}

async function loadHdmapManifest() {
  const manifest = await fetch("./hdmaps/manifest.json").then((r) => r.json());
  hdmapManifest = manifest.maps || [];
  hdmapSelect.innerHTML = "";
  for (const item of hdmapManifest) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name || item.id;
    hdmapSelect.appendChild(option);
  }
  hdmapSelect.addEventListener("change", () => {
    selectedHdmap = hdmapManifest.find((item) => item.id === hdmapSelect.value) || null;
    mapLayer = { key: null, data: null, status: "off", promise: null };
    if (layers.map) ensureMapLoaded();
    renderSummary();
    renderHdmapStatus();
    draw();
  });
  selectedHdmap = hdmapManifest[0] || null;
  renderHdmapStatus();
}

async function loadSample(file) {
  const json = await fetch(`./samples/${file}`).then((r) => r.json());
  setScenario(json, file);
}

function renderLayerToggles() {
  renderToggleGroup(scenarioLayerToggles, scenarioLayerDefs);
  renderToggleGroup(hdmapLayerToggles, hdmapLayerDefs);
}

function renderToggleGroup(container, defs) {
  container.innerHTML = "";
  for (const [key, label] of defs) {
    const row = document.createElement("label");
    row.className = "toggle";
    row.innerHTML = `<input type="checkbox" ${layers[key] ? "checked" : ""} data-layer="${key}" /><span>${label}</span>`;
    container.appendChild(row);
  }
  container.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-layer]");
    if (!input) return;
    layers[input.dataset.layer] = input.checked;
    if (input.dataset.layer === "swapDims") renderObjects();
    if (input.dataset.layer === "map" && input.checked) ensureMapLoaded();
    renderHdmapStatus();
    draw();
  });
}

function mapKeyForScene() {
  const path = scene?.scenario?.roadNetwork?.logicFile?.filepath || "";
  const sceneKey = path.split("/").filter(Boolean).pop() || null;
  if (selectedHdmap) return selectedHdmap.id;
  return sceneKey;
}

async function ensureMapLoaded() {
  const key = mapKeyForScene();
  if (!key || !layers.map) return;
  if (mapLayer.key === key && mapLayer.data) return;
  if (mapLayer.key === key && mapLayer.promise) return mapLayer.promise;

  mapLayer = { key, data: null, status: `loading ${key}`, promise: null };
  renderSummary();
  renderHdmapStatus();
  const mapInfo = selectedHdmap || hdmapManifest.find((item) => item.id === key);
  const renderPath = mapInfo?.render || `samples/maps/${key}.json`;
  const renderUrl = mapInfo ? `./hdmaps/${renderPath}` : `./${renderPath}`;
  mapLayer.promise = fetch(renderUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`map ${key} not found`);
      return response.json();
    })
    .then((data) => {
      mapLayer = { key, data, status: "loaded", promise: null };
      renderSummary();
      renderHdmapStatus();
      draw();
    })
    .catch((error) => {
      mapLayer = { key, data: null, status: `${error.message}: ${renderUrl}`, promise: null };
      renderSummary();
      renderHdmapStatus();
      draw();
    });
  return mapLayer.promise;
}

function mapLayerSummary() {
  if (!layers.map) return "关闭";
  if (!mapLayer.data) return mapLayer.status || "未加载";
  const m = mapLayer.data;
  const summary = m.summary || {};
  return `${mapLayer.key}: lane ${summary.lanes ?? m.lanes?.length ?? 0}, road ${summary.roads ?? 0}, overlap ${summary.overlaps ?? 0}, signal ${summary.signals ?? m.signals?.length ?? 0}`;
}

function renderHdmapStatus() {
  if (!hdmapStatus) return;
  if (!selectedHdmap) {
    hdmapStatus.textContent = "无 HDMap manifest";
    return;
  }
  const state = layers.map ? mapLayerSummary() : "未启用";
  hdmapStatus.textContent = `${selectedHdmap.name || selectedHdmap.id} | ${state}`;
}

function renderSummary(label) {
  const s = scene;
  if (!s) return;
  const grading = s.scenario.gradingConfigInfo || {};
  const realistic = s.scenario.realisticPerceptionConfig;
  const intelligent = s.scenario.intelligentObstacleConfig;
  summary.innerHTML = [
    ["文件", label || s.label || "-"],
    ["名称", s.title],
    ["ID", s.id || "-"],
    ["地图", s.mapId || "-"],
    ["地图图层", mapLayerSummary()],
    ["标签", s.tags.join(", ") || "-"],
    ["主车", `${pointText(s.ego.start)} -> ${pointText(s.ego.end)}`],
    ["对象", `${s.entities.length} 个，动态 spawn ${s.dynamic.length} 个，红绿灯 ${s.trafficLights.length} 个`],
    ["坐标范围", `${fmt(s.bounds.minX, 1)}, ${fmt(s.bounds.minY, 1)} - ${fmt(s.bounds.maxX, 1)}, ${fmt(s.bounds.maxY, 1)} (${s.coordinatePoints.length} 点)`],
    ["评分", grading.baseGradeConfigFile || "-"],
    ["感知", realistic ? `miss ${percent(realistic.missDetection?.rate)}, id ${percent(realistic.idSwitch?.rate)}, range ${realistic.detectionRange?.rangeMax ?? "-"}` : "-"],
    ["智能障碍", intelligent ? `speed ${intelligent.cruiseSpeedMin ?? "-"}-${intelligent.cruiseSpeedMax ?? "-"} m/s, detection ${intelligent.detectionDistance ?? "-"} m` : "-"],
  ].map(([k, v]) => `<div class="kv"><b>${k}</b><span>${escapeHtml(String(v))}</span></div>`).join("");
}

function pointText(p) {
  return Number.isFinite(p?.x) ? `${fmt(p.x, 2)}, ${fmt(p.y, 2)}` : "-";
}

function percent(v) {
  return Number.isFinite(v) ? `${Math.round(v * 100)}%` : "-";
}

function renderObjects() {
  objectList.innerHTML = "";
  for (const entity of scene.entities) {
    const row = document.createElement("div");
    row.className = "object-row";
    const color = colorForKind(entity.kind);
    const dims = effectiveDims(entity);
    const suffix = layers.swapDims ? " | 已翻转" : "";
    row.innerHTML = `
      <i class="swatch" style="background:${color}"></i>
      <div>
        <strong>${escapeHtml(entity.ref)} <span>${escapeHtml(entity.kind)}</span></strong>
        <small>pos ${pointText(entity.teleport)} | L ${dims.length ?? "-"} W ${dims.width ?? "-"} H ${entity.dims.height ?? "-"} | speed ${entity.speed ?? "-"}${suffix}</small>
      </div>
    `;
    objectList.appendChild(row);
  }
}

function effectiveDims(entity) {
  const length = entity.dims.length;
  const width = entity.dims.width;
  if (!layers.swapDims) return { length, width };
  return { length: width, width: length };
}

function colorForKind(kind) {
  if (kind === "vehicle") return colors.vehicle;
  if (kind === "pedestrian") return colors.pedestrian;
  if (kind === "unknownUnmovableObject") return colors.static;
  return "#65737e";
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fitToBounds() {
  if (!scene) return;
  const rect = canvas.getBoundingClientRect();
  const pad = 80;
  const b = scene.bounds;
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxY - b.minY);
  const scaleX = (rect.width - pad * 2) / w;
  const scaleY = (rect.height - pad * 2) / h;
  view.scale = Math.max(0.05, Math.min(scaleX, scaleY));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  view.offsetX = rect.width / 2 - cx * view.scale;
  view.offsetY = rect.height / 2 + cy * view.scale;
  draw();
}

function worldToScreen(p) {
  return {
    x: p.x * view.scale + view.offsetX,
    y: -p.y * view.scale + view.offsetY,
  };
}

function screenToWorld(x, y) {
  return {
    x: (x - view.offsetX) / view.scale,
    y: -(y - view.offsetY) / view.scale,
  };
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  ctx.fillStyle = "#dfe7ea";
  ctx.fillRect(0, 0, rect.width, rect.height);
  if (!scene) return;
  if (layers.map) drawMapLayer(rect);
  if (layers.grid) drawGrid(rect);
  if (layers.ego) drawEgo();
  if (layers.dynamic) drawDynamic();
  if (layers.trafficLights) drawTrafficLights();
  if (layers.objects) drawObjects();
  if (layers.objectRoutes) drawObjectRoutes();
  if (layers.triggers) drawTriggerBadges();
  if (layers.bounds) drawBounds();
}

function drawMapLayer(rect) {
  const map = mapLayer.data;
  if (!map) {
    drawMapStatus();
    return;
  }
  const viewport = worldViewport(rect);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (layers.junctions) {
    for (const junction of map.junctions || []) drawPolygon(junction.polygon, colors.junction, 0.12, viewport);
  }
  if (layers.crosswalks) {
    for (const crosswalk of map.crosswalks || []) drawPolygon(crosswalk.polygon, colors.crosswalk, 0.18, viewport);
  }
  if (layers.parking) {
    for (const parking of map.parkingSpaces || []) drawPolygon(parking.polygon, colors.parking, 0.12, viewport);
  }
  for (const lane of map.lanes || []) {
    if (layers.laneBoundaries) {
      drawMapLine(lane.left, boundaryColor(lane.leftTypes), 1.4, boundaryDash(lane.leftTypes), viewport);
      drawMapLine(lane.right, boundaryColor(lane.rightTypes), 1.4, boundaryDash(lane.rightTypes), viewport);
    }
    if (layers.laneCenters) {
      drawMapLine(lane.center, colors.laneCenter, 1, [4, 8], viewport);
      if (layers.mapLabels && view.scale > 5 && lane.center?.length) {
        drawLabel(lane.center[Math.floor(lane.center.length / 2)], lane.id, colors.laneCenter, 5, -5);
      }
    }
    if (layers.laneTopology && view.scale > 2.5) {
      drawLaneTopology(lane, map, viewport);
    }
  }
  if (layers.mapSignals) {
    for (const signal of map.signals || []) {
      drawPolygon(signal.boundary, colors.mapSignal, 0.22, viewport);
      for (const line of signal.stopLines || []) drawMapLine(line, colors.mapSignal, 2, [], viewport);
      if (layers.mapLabels && view.scale > 4 && signal.boundary?.[0]) drawLabel(signal.boundary[0], signal.id, colors.mapSignal, 5, -5);
    }
    for (const stopSign of map.stopSigns || []) {
      for (const line of stopSign.stopLines || []) drawMapLine(line, colors.bounds, 2.5, [], viewport);
      if (layers.mapLabels && view.scale > 4 && stopSign.stopLines?.[0]?.[0]) drawLabel(stopSign.stopLines[0][0], stopSign.id, colors.bounds, 5, -5);
    }
  }
  if (layers.yieldSigns) {
    for (const yieldSign of map.yieldSigns || []) {
      for (const line of yieldSign.stopLines || []) drawMapLine(line, colors.trigger, 2.5, [8, 5], viewport);
      if (layers.mapLabels && view.scale > 4 && yieldSign.stopLines?.[0]?.[0]) drawLabel(yieldSign.stopLines[0][0], yieldSign.id, colors.trigger, 5, -5);
    }
  }
  if (layers.speedBumps) {
    for (const bump of map.speedBumps || []) {
      for (const line of bump.position || []) drawMapLine(line, colors.speedBump, 3, [5, 4], viewport);
      if (layers.mapLabels && view.scale > 4 && bump.position?.[0]?.[0]) drawLabel(bump.position[0][0], bump.id, colors.speedBump, 5, -5);
    }
  }
  ctx.restore();
}

function drawLaneTopology(lane, map, viewport) {
  if (!lane.center?.length || !polylineIntersects(lane.center, viewport)) return;
  const laneById = map._laneById || (map._laneById = new globalThis.Map((map.lanes || []).map((item) => [item.id, item])));
  const from = lane.center[lane.center.length - 1];
  for (const id of lane.successorIds || []) {
    const next = laneById.get(id);
    if (!next?.center?.length) continue;
    drawMapLine([from, next.center[0]], colors.topology, 0.8, [3, 5], viewport);
  }
}

function drawMapStatus() {
  const text = `map: ${mapLayer.status || "未加载"}`;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.strokeStyle = "rgba(99,112,122,0.35)";
  roundRect(ctx, 20, 42, Math.min(420, 28 + text.length * 7), 20, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = colors.laneBoundary;
  ctx.font = "12px system-ui";
  ctx.fillText(text, 30, 56);
}

function worldViewport(rect) {
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(rect.width, rect.height);
  return {
    minX: Math.min(topLeft.x, bottomRight.x),
    maxX: Math.max(topLeft.x, bottomRight.x),
    minY: Math.min(topLeft.y, bottomRight.y),
    maxY: Math.max(topLeft.y, bottomRight.y),
  };
}

function drawPolygon(points, color, alpha, viewport) {
  if (!points?.length || !polylineIntersects(points, viewport)) return;
  ctx.beginPath();
  points.forEach((p, i) => {
    const q = worldToScreen(p);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.closePath();
  ctx.fillStyle = hexToRgba(color, alpha);
  ctx.strokeStyle = hexToRgba(color, 0.45);
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
}

function drawMapLine(points, color, width, dash, viewport) {
  if (!points?.length || !polylineIntersects(points, viewport)) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  points.forEach((p, i) => {
    const q = worldToScreen(p);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.stroke();
  ctx.setLineDash([]);
}

function polylineIntersects(points, viewport) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return maxX >= viewport.minX && minX <= viewport.maxX && maxY >= viewport.minY && minY <= viewport.maxY;
}

function boundaryColor(types = []) {
  if (types.some((type) => type.includes("YELLOW"))) return "#aa8b25";
  if (types.some((type) => type.includes("CURB"))) return "#7a4c38";
  return colors.laneBoundary;
}

function boundaryDash(types = []) {
  if (types.some((type) => type.includes("DOTTED"))) return [7, 7];
  return [];
}

function drawGrid(rect) {
  const stepWorld = chooseGridStep(80 / view.scale);
  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(rect.width, rect.height);
  const minX = Math.floor(topLeft.x / stepWorld) * stepWorld;
  const maxX = Math.ceil(bottomRight.x / stepWorld) * stepWorld;
  const minY = Math.floor(bottomRight.y / stepWorld) * stepWorld;
  const maxY = Math.ceil(topLeft.y / stepWorld) * stepWorld;
  ctx.strokeStyle = "rgba(99,112,122,0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = minX; x <= maxX; x += stepWorld) {
    const a = worldToScreen({ x, y: minY });
    const b = worldToScreen({ x, y: maxY });
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (let y = minY; y <= maxY; y += stepWorld) {
    const a = worldToScreen({ x: minX, y });
    const b = worldToScreen({ x: maxX, y });
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
}

function chooseGridStep(minStep) {
  const pow = Math.pow(10, Math.floor(Math.log10(minStep)));
  for (const m of [1, 2, 5, 10]) {
    if (pow * m >= minStep) return pow * m;
  }
  return pow * 10;
}

function drawEgo() {
  const pts = scene.ego.route.filter((p) => Number.isFinite(p?.x));
  if (pts.length >= 2) drawPolyline(pts, colors.ego, 3, []);
  if (layers.waypoints) pts.forEach((p, i) => drawPoint(p, i === 0 ? "S" : i === pts.length - 1 ? "E" : String(i), colors.ego, 8));
}

function drawDynamic() {
  for (const spawn of scene.dynamic) {
    const pts = [{ x: spawn.spawnX, y: spawn.spawnY }, ...(spawn.routeWaypoints || []), { x: spawn.endX, y: spawn.endY }]
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length >= 2) drawPolyline(pts, colors.dynamic, 2, [8, 6]);
    drawArrow({ x: spawn.spawnX, y: spawn.spawnY }, spawn.spawnHeading || 0, colors.dynamic);
    if (layers.labels) drawLabel({ x: spawn.spawnX, y: spawn.spawnY }, `${spawn.name || "spawn"} ${spawn.cruiseSpeedMin ?? "-"}-${spawn.cruiseSpeedMax ?? "-"}m/s`, colors.dynamic, 12, -12);
  }
}

function drawTrafficLights() {
  for (const light of scene.trafficLights) {
    const color = light.initialState?.color === "RED" ? "#c53f3f" : light.initialState?.color === "YELLOW" ? "#c99a20" : colors.traffic;
    drawPoint(light.location, "", color, 9);
    if (layers.labels) drawLabel(light.location, `${light.id} ${light.initialState?.color || ""}`, color, 12, -12);
  }
}

function drawObjects() {
  for (const entity of scene.entities) {
    if (!Number.isFinite(entity.teleport?.x)) continue;
    const color = colorForKind(entity.kind);
    drawObjectBox(entity, color);
    if (layers.labels) drawLabel(entity.teleport, `${entity.ref}`, color, 8, -8);
  }
}

function drawObjectRoutes() {
  for (const entity of scene.entities) {
    if (entity.routePoints.length >= 2) drawPolyline(entity.routePoints, colorForKind(entity.kind), 1.5, [4, 5]);
  }
}

function drawTriggerBadges() {
  let i = 0;
  for (const trigger of scene.triggers) {
    const text = summarizeTrigger(trigger.trigger);
    if (!text) continue;
    const x = 20;
    const y = 68 + i * 24;
    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.strokeStyle = "rgba(99,112,122,0.35)";
    roundRect(ctx, x, y, Math.min(520, 24 + text.length * 7), 18, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = colors.trigger;
    ctx.font = "12px system-ui";
    ctx.fillText(text, x + 8, y + 13);
    i += 1;
    if (i > 8) break;
  }
}

function summarizeTrigger(trigger) {
  const json = JSON.stringify(trigger);
  const sim = json.match(/"simulationTimeCondition":\{"rule":"([^"]+)","value":([^}]+)\}/);
  if (sim) return `trigger simulationTime ${sim[1]} ${sim[2]}`;
  const rel = json.match(/"relativeDistanceCondition":\{.*?"entityRef":"([^"]+)".*?"rule":"([^"]+)","value":([^}]+)\}/);
  if (rel) return `trigger distance to ${rel[1]} ${rel[2]} ${rel[3]}`;
  return json.length ? `trigger ${json.slice(0, 90)}` : "";
}

function drawBounds() {
  const b = scene.bounds;
  const a = worldToScreen({ x: b.minX, y: b.minY });
  const c = worldToScreen({ x: b.maxX, y: b.maxY });
  ctx.setLineDash([8, 6]);
  ctx.strokeStyle = colors.bounds;
  ctx.lineWidth = 2;
  ctx.strokeRect(a.x, c.y, c.x - a.x, a.y - c.y);
  ctx.setLineDash([]);
  if (layers.labels) drawLabel({ x: b.minX, y: b.maxY }, `${fmt(b.minX, 1)}, ${fmt(b.minY, 1)} - ${fmt(b.maxX, 1)}, ${fmt(b.maxY, 1)}`, colors.bounds, 4, -8);
}

function drawPolyline(points, color, width, dash) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  points.forEach((p, i) => {
    const q = worldToScreen(p);
    if (i === 0) ctx.moveTo(q.x, q.y);
    else ctx.lineTo(q.x, q.y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawPoint(p, label, color, radius) {
  const q = worldToScreen(p);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(q.x, q.y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 11px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (label) ctx.fillText(label, q.x, q.y);
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function drawObjectBox(entity, color) {
  const p = entity.teleport;
  const q = worldToScreen(p);
  const dims = effectiveDims(entity);
  const length = Math.max(0.2, Number(dims.length) || 0.8) * view.scale;
  const width = Math.max(0.2, Number(dims.width) || 0.8) * view.scale;
  const heading = Number(p.h || 0);
  ctx.save();
  ctx.translate(q.x, q.y);
  ctx.rotate(-heading);
  ctx.fillStyle = hexToRgba(color, 0.25);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.fillRect(-length / 2, -width / 2, length, width);
  ctx.strokeRect(-length / 2, -width / 2, length, width);
  ctx.restore();
}

function drawArrow(p, heading, color) {
  const q = worldToScreen(p);
  ctx.save();
  ctx.translate(q.x, q.y);
  ctx.rotate(-heading);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(12, 0);
  ctx.lineTo(-8, -6);
  ctx.lineTo(-4, 0);
  ctx.lineTo(-8, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawLabel(p, text, color, dx, dy) {
  const q = worldToScreen(p);
  ctx.font = "12px system-ui";
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.strokeStyle = hexToRgba(color, 0.35);
  roundRect(ctx, q.x + dx, q.y + dy - 14, w, 18, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, q.x + dx + 5, q.y + dy);
}

function roundRect(context, x, y, w, h, r) {
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + w - r, y);
  context.quadraticCurveTo(x + w, y, x + w, y + r);
  context.lineTo(x + w, y + h - r);
  context.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  context.lineTo(x + r, y + h);
  context.quadraticCurveTo(x, y + h, x, y + h - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function nearestLaneSl(point) {
  const map = mapLayer.data;
  if (!map?.lanes?.length) return null;
  const maxDistance = Math.max(6, 36 / Math.max(view.scale, 0.001));
  const maxDistanceSq = maxDistance * maxDistance;
  let best = null;

  for (const lane of map.lanes) {
    const center = lane.center || [];
    if (center.length < 2) continue;
    let sBase = 0;
    for (let i = 0; i < center.length - 1; i += 1) {
      const a = center[i];
      const b = center[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq <= 1e-9) continue;
      const rawT = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq;
      const t = Math.max(0, Math.min(1, rawT));
      const proj = { x: a.x + dx * t, y: a.y + dy * t };
      const px = point.x - proj.x;
      const py = point.y - proj.y;
      const distSq = px * px + py * py;
      if (distSq <= maxDistanceSq && (!best || distSq < best.distanceSq)) {
        const segLen = Math.sqrt(lenSq);
        const cross = dx * (point.y - a.y) - dy * (point.x - a.x);
        const signedL = Math.sign(cross || 1) * Math.sqrt(distSq);
        best = {
          lane,
          roadId: lane.roadId || "-",
          sectionId: lane.sectionId || "-",
          laneId: lane.id || "-",
          s: sBase + segLen * t,
          l: signedL,
          distance: Math.sqrt(distSq),
          distanceSq: distSq,
          projection: proj,
        };
      }
      sBase += Math.sqrt(lenSq);
    }
  }
  return best;
}

function cursorText(world) {
  const sl = nearestLaneSl(world);
  const xy = `x: ${fmt(world.x, 3)}, y: ${fmt(world.y, 3)}`;
  if (!sl) return `${xy} | road: -, lane: -, s: -, l: -`;
  return `${xy} | road: ${sl.roadId}, lane: ${sl.laneId}, s: ${fmt(sl.s, 2)}, l: ${fmt(sl.l, 2)}`;
}

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = event.clientX - rect.left;
  const my = event.clientY - rect.top;
  const before = screenToWorld(mx, my);
  const factor = event.deltaY < 0 ? 1.12 : 0.89;
  view.scale = Math.max(0.02, Math.min(500, view.scale * factor));
  const after = worldToScreen(before);
  view.offsetX += mx - after.x;
  view.offsetY += my - after.y;
  draw();
}, { passive: false });

canvas.addEventListener("mousedown", (event) => {
  dragging = true;
  dragStart = { x: event.clientX, y: event.clientY, offsetX: view.offsetX, offsetY: view.offsetY };
  canvas.classList.add("dragging");
});

window.addEventListener("mouseup", () => {
  dragging = false;
  canvas.classList.remove("dragging");
});

window.addEventListener("mousemove", (event) => {
  const rect = canvas.getBoundingClientRect();
  if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
    const world = screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
    cursorReadout.textContent = cursorText(world);
  }
  if (!dragging || !dragStart) return;
  view.offsetX = dragStart.offsetX + event.clientX - dragStart.x;
  view.offsetY = dragStart.offsetY + event.clientY - dragStart.y;
  draw();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  const json = JSON.parse(await file.text());
  setScenario(json, file.name);
});

fitButton.addEventListener("click", fitToBounds);
resetButton.addEventListener("click", () => currentScenario && setScenario(currentScenario, "current"));
window.addEventListener("resize", resizeCanvas);

renderLayerToggles();
resizeCanvas();
Promise.all([loadManifest(), loadHdmapManifest()]).catch((error) => {
  summary.innerHTML = `<div class="kv"><b>错误</b><span>${escapeHtml(error.message)}</span></div>`;
});
