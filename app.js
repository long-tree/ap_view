const canvas = document.getElementById("viewer");
const ctx = canvas.getContext("2d");
const sampleSelect = document.getElementById("sampleSelect");
const fileInput = document.getElementById("fileInput");
const layerToggles = document.getElementById("layerToggles");
const summary = document.getElementById("summary");
const objectList = document.getElementById("objectList");
const fitButton = document.getElementById("fitButton");
const resetButton = document.getElementById("resetButton");
const cursorReadout = document.getElementById("cursorReadout");

const layerDefs = [
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
};

let layers = Object.fromEntries(layerDefs.map(([key]) => [key, true]));
let currentScenario = null;
let scene = null;
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
    bounds: boundsFor(allPoints),
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
  renderSummary(label);
  renderObjects();
  fitToBounds();
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

async function loadSample(file) {
  const json = await fetch(`./samples/${file}`).then((r) => r.json());
  setScenario(json, file);
}

function renderLayerToggles() {
  layerToggles.innerHTML = "";
  for (const [key, label] of layerDefs) {
    const row = document.createElement("label");
    row.className = "toggle";
    row.innerHTML = `<input type="checkbox" ${layers[key] ? "checked" : ""} data-layer="${key}" /><span>${label}</span>`;
    layerToggles.appendChild(row);
  }
  layerToggles.addEventListener("change", (event) => {
    const input = event.target.closest("input[data-layer]");
    if (!input) return;
    layers[input.dataset.layer] = input.checked;
    draw();
  });
}

function renderSummary(label) {
  const s = scene;
  const grading = s.scenario.gradingConfigInfo || {};
  const realistic = s.scenario.realisticPerceptionConfig;
  const intelligent = s.scenario.intelligentObstacleConfig;
  summary.innerHTML = [
    ["文件", label || "-"],
    ["名称", s.title],
    ["ID", s.id || "-"],
    ["地图", s.mapId || "-"],
    ["标签", s.tags.join(", ") || "-"],
    ["主车", `${pointText(s.ego.start)} -> ${pointText(s.ego.end)}`],
    ["对象", `${s.entities.length} 个，动态 spawn ${s.dynamic.length} 个，红绿灯 ${s.trafficLights.length} 个`],
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
    row.innerHTML = `
      <i class="swatch" style="background:${color}"></i>
      <div>
        <strong>${escapeHtml(entity.ref)} <span>${escapeHtml(entity.kind)}</span></strong>
        <small>pos ${pointText(entity.teleport)} | L ${entity.dims.length ?? "-"} W ${entity.dims.width ?? "-"} H ${entity.dims.height ?? "-"} | speed ${entity.speed ?? "-"}</small>
      </div>
    `;
    objectList.appendChild(row);
  }
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
  if (layers.grid) drawGrid(rect);
  if (layers.ego) drawEgo();
  if (layers.dynamic) drawDynamic();
  if (layers.trafficLights) drawTrafficLights();
  if (layers.objects) drawObjects();
  if (layers.objectRoutes) drawObjectRoutes();
  if (layers.triggers) drawTriggerBadges();
  if (layers.bounds) drawBounds();
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
  const length = Math.max(0.2, Number(entity.dims.length) || 0.8) * view.scale;
  const width = Math.max(0.2, Number(entity.dims.width) || 0.8) * view.scale;
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
    cursorReadout.textContent = `x: ${fmt(world.x, 3)}, y: ${fmt(world.y, 3)}`;
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
loadManifest().catch((error) => {
  summary.innerHTML = `<div class="kv"><b>错误</b><span>${escapeHtml(error.message)}</span></div>`;
});
