'use strict';
/* 展馆平面图协作标注 —— 前端逻辑（原生 JS + SVG） */

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';

const RISK_COLORS = {
  '低风险': { fill: 'rgba(22,163,74,.15)', stroke: '#16a34a' },
  '中风险': { fill: 'rgba(217,119,6,.17)', stroke: '#d97706' },
  '高风险': { fill: 'rgba(220,38,38,.18)', stroke: '#dc2626' },
};
const DRAFT_COLOR = { fill: 'rgba(37,99,235,.10)', stroke: '#2563eb' };

const state = {
  plans: [],
  plan: null,
  regions: [],
  draft: null,            // {mode, id?, code, riskLevel, vertices, baseVersion?, closed}
  transform: { scale: 1, tx: 0, ty: 0 },
  pointer: null,          // 绘制时鼠标悬停的原图坐标
  drag: null,             // {type:'pan'|'vertex'|'newvertex', idx?, startX,startY, moved}
  pollTimer: null,
};

/* 巡检版只读视图的独立状态（与编辑画布互不影响） */
const inspect = {
  pubs: [],               // 发布列表（摘要）
  current: null,          // 当前查看的 {publication, regions}
  selected: null,         // 列表中选中的区域 code（仅高亮展示）
  transform: { scale: 1, tx: 0, ty: 0 },
  drag: null,
};

/* ------------------------------- 工具 ------------------------------- */

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 无响应体 */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `请求失败：HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.error;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(message, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, ms);
  setTimeout(() => el.remove(), ms + 400);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pointsStr(verts) {
  return verts.map((p) => `${p.x},${p.y}`).join(' ');
}

function centroid(verts) {
  let x = 0, y = 0;
  for (const p of verts) { x += p.x; y += p.y; }
  return { x: x / verts.length, y: y / verts.length };
}

/* --------------------------- 视图切换 / 列表 --------------------------- */

function showView(name) {
  $('view-list').classList.toggle('hidden', name !== 'list');
  $('view-editor').classList.toggle('hidden', name !== 'editor');
  $('view-inspect').classList.toggle('hidden', name !== 'inspect');
}

async function loadPlans() {
  const data = await api('GET', '/api/plans');
  state.plans = data.plans;
  const tbody = $('planList');
  tbody.innerHTML = '';
  $('emptyHint').classList.toggle('hidden', state.plans.length > 0);
  for (const p of state.plans) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td>${esc(p.name)}</td>
      <td>${p.width} × ${p.height}</td>
      <td>${p.region_count}</td>
      <td>v${p.version}</td>
      <td class="muted">${esc(p.updated_at || '')}</td>
      <td class="actions"></td>`;
    const td = tr.querySelector('.actions');
    const openBtn = document.createElement('button');
    openBtn.className = 'btn primary';
    openBtn.textContent = '打开';
    openBtn.onclick = () => openPlan(p.id);
    const expBtn = document.createElement('button');
    expBtn.className = 'btn';
    expBtn.textContent = '导出';
    expBtn.style.marginLeft = '6px';
    expBtn.onclick = () => { window.location.href = `/api/plans/${p.id}/export`; };
    td.append(openBtn, expBtn);
    tbody.appendChild(tr);
  }
}

$('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = $('upFile');
  if (!fileInput.files[0]) return toast('请选择 PNG/JPEG 图片', 'err');
  const fd = new FormData();
  fd.append('image', fileInput.files[0]);
  if ($('upName').value.trim()) fd.append('name', $('upName').value.trim());
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/plans', { method: 'POST', body: fd }).then(handleUploadRes);
    toast('上传成功', 'ok');
    await openPlan(res.plan.id);
    fileInput.value = '';
  } catch (err) {
    toast(err.message, 'err', 6000);
  } finally {
    btn.disabled = false;
  }
});

$('importForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fileInput = $('importFile');
  if (!fileInput.files[0]) return toast('请选择导出的 JSON 文件', 'err');
  const fd = new FormData();
  fd.append('file', fileInput.files[0]);
  if ($('importName').value.trim()) fd.append('name', $('importName').value.trim());
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const res = await fetch('/api/import/file', { method: 'POST', body: fd }).then(handleUploadRes);
    toast(`导入成功：恢复 ${res.imported_regions} 个区域，尺寸与版本保持一致`, 'ok', 5000);
    await openPlan(res.plan.id);
    fileInput.value = '';
  } catch (err) {
    toast('导入失败，未产生任何数据：' + err.message, 'err', 8000);
  } finally {
    btn.disabled = false;
  }
});

async function handleUploadRes(res) {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.message) || `HTTP ${res.status}`);
  }
  return data;
}

/* ------------------------------ 打开图纸 ------------------------------ */

async function openPlan(id) {
  const data = await api('GET', `/api/plans/${id}`);
  state.plan = data.plan;
  state.regions = data.regions;
  state.draft = null;
  state.pointer = null;
  showView('editor');
  setupSvgSize();
  const img = $('planImage');
  img.setAttribute('href', `/api/plans/${id}/image?t=${Date.now()}`);
  // 兼容老版本浏览器对 SVG <image> 的 xlink:href 要求
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href',
    `/api/plans/${id}/image?t=${Date.now()}`);
  img.setAttribute('width', state.plan.width);
  img.setAttribute('height', state.plan.height);
  $('bgRect').setAttribute('width', state.plan.width);
  $('bgRect').setAttribute('height', state.plan.height);
  $('planTitle').textContent = state.plan.name;
  $('planSize').textContent = `${state.plan.width} × ${state.plan.height} px`;
  updatePlanVersionBadge();
  renderRegions();
  renderRegionList();
  renderDraft();
  updateForm();
  fitView();
  refreshPublishStatus();
  startPolling();
}

$('btnBack').addEventListener('click', () => {
  stopPolling();
  showView('list');
  loadPlans();
});

$('btnExport').addEventListener('click', () => {
  if (state.plan) window.location.href = `/api/plans/${state.plan.id}/export`;
});

function updatePlanVersionBadge() {
  $('planVersion').textContent = `图纸版本 v${state.plan.version}`;
}

/* ----------------------------- 坐标 / 视口 ----------------------------- */

const svg = $('svg');

function setupSvgSize() {
  // SVG 用 CSS 像素作为用户单位，getBoundingClientRect 即可与事件坐标互算
  applyTransform();
}

function applyTransform() {
  const t = state.transform;
  $('viewport').setAttribute('transform',
    `translate(${t.tx} ${t.ty}) scale(${t.scale})`);
  $('zoomLevel').textContent = `缩放 ${Math.round(t.scale * 100)}%`;
}

function screenToOrig(clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const t = state.transform;
  return {
    x: (clientX - rect.left - t.tx) / t.scale,
    y: (clientY - rect.top - t.ty) / t.scale,
  };
}

function clampToImage(p) {
  return {
    x: Math.min(state.plan.width, Math.max(0, p.x)),
    y: Math.min(state.plan.height, Math.max(0, p.y)),
  };
}

function zoomAt(clientX, clientY, factor) {
  const rect = svg.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const t = state.transform;
  const ns = Math.min(20, Math.max(0.05, t.scale * factor));
  const f = ns / t.scale;
  t.tx = mx - (mx - t.tx) * f;
  t.ty = my - (my - t.ty) * f;
  t.scale = ns;
  applyTransform();
}

function fitView() {
  if (!state.plan) return;
  const rect = svg.getBoundingClientRect();
  const pad = 40;
  const s = Math.min(
    (rect.width - pad * 2) / state.plan.width,
    (rect.height - pad * 2) / state.plan.height
  );
  state.transform.scale = Math.min(8, Math.max(0.05, s));
  state.transform.tx = (rect.width - state.plan.width * state.transform.scale) / 2;
  state.transform.ty = (rect.height - state.plan.height * state.transform.scale) / 2;
  applyTransform();
}

$('btnZoomIn').onclick = () => zoomAtCenter(1.25);
$('btnZoomOut').onclick = () => zoomAtCenter(0.8);
$('btnFit').onclick = fitView;
$('btn100').onclick = () => {
  const rect = svg.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / state.transform.scale);
};
function zoomAtCenter(f) {
  const rect = svg.getBoundingClientRect();
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, f);
}

svg.addEventListener('wheel', (e) => {
  if (!state.plan) return;
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

/* ----------------------------- 区域渲染 ----------------------------- */

function renderRegions() {
  const layer = $('regionLayer');
  layer.innerHTML = '';
  for (const r of state.regions) {
    const c = RISK_COLORS[r.risk_level] || { fill: 'rgba(107,114,128,.15)', stroke: '#6b7280' };
    const dimmed = state.draft ? 0.45 : 1;

    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', pointsStr(r.vertices));
    poly.setAttribute('fill', c.fill);
    poly.setAttribute('stroke', c.stroke);
    poly.setAttribute('class',
      'polygon-region' + (state.draft && state.draft.mode === 'edit' && state.draft.id === r.id
        ? ' selected' : ''));
    poly.setAttribute('opacity', dimmed);
    poly.dataset.regionId = r.id;
    layer.appendChild(poly);

    const ctr = centroid(r.vertices);
    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('x', ctr.x);
    label.setAttribute('y', ctr.y);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('class', 'poly-label');
    label.setAttribute('opacity', dimmed);
    label.textContent = `${r.code} · ${r.risk_level}`;
    label.dataset.regionId = r.id;
    layer.appendChild(label);
  }
}

function renderRegionList() {
  const ul = $('regionList');
  ul.innerHTML = '';
  $('regionCount').textContent = `（${state.regions.length}）`;
  for (const r of state.regions) {
    const li = document.createElement('li');
    if (state.draft && state.draft.id === r.id) li.classList.add('active');
    li.innerHTML = `
      <span class="risk-dot ${esc(r.risk_level)}"></span>
      <span class="r-code">${esc(r.code)}</span>
      <span class="muted">${esc(r.risk_level)}</span>
      <span class="r-ver">v${r.version}</span>`;
    li.onclick = () => selectRegion(r.id);
    ul.appendChild(li);
  }
}

/* ------------------------------ 编辑草稿 ------------------------------ */

function beginDraw() {
  if (state.draft) {
    toast('请先保存或取消当前未完成的编辑', 'err');
    return;
  }
  state.draft = {
    mode: 'draw', code: '', riskLevel: '',
    vertices: [], closed: false,
  };
  svg.classList.add('drawing');
  renderRegions();
  renderRegionList();
  renderDraft();
  updateForm();
}

function selectRegion(id) {
  if (state.draft && state.draft.id !== id) {
    toast('当前有未保存的编辑，请先保存或取消', 'err');
    return;
  }
  if (state.draft && state.draft.id === id) return;
  const r = state.regions.find((x) => x.id === id);
  if (!r) return;
  state.draft = {
    mode: 'edit', id: r.id,
    code: r.code, riskLevel: r.risk_level,
    vertices: r.vertices.map((p) => ({ ...p })),
    baseVersion: r.version,
    closed: true,
  };
  renderRegions();
  renderRegionList();
  renderDraft();
  updateForm();
}

function cancelDraft() {
  state.draft = null;
  svg.classList.remove('drawing');
  hideBanner();
  renderRegions();
  renderRegionList();
  renderDraft();
  updateForm();
}

function closeDraftPolygon() {
  const d = state.draft;
  if (!d || d.mode !== 'draw') return;
  // 去掉双击产生的重复尾点（按屏幕像素换算容差）
  const tol = 8 / state.transform.scale;
  while (d.vertices.length >= 2) {
    const a = d.vertices[d.vertices.length - 1];
    const b = d.vertices[d.vertices.length - 2];
    if (Math.abs(a.x - b.x) < tol && Math.abs(a.y - b.y) < tol) d.vertices.pop();
    else break;
  }
  if (d.vertices.length < 3) {
    toast('至少需要 3 个顶点才能形成区域', 'err');
    return;
  }
  d.closed = true;
  renderDraft();
  updateForm();
  toast('顶点已闭合，请填写编号与风险等级后保存', 'ok');
}

$('btnDraw').addEventListener('click', beginDraw);
$('btnCancel').addEventListener('click', cancelDraft);
$('btnFinish').addEventListener('click', closeDraftPolygon);

$('fCode').addEventListener('input', (e) => {
  if (state.draft) { state.draft.code = e.target.value; runLiveValidate(); }
});
$('fRisk').addEventListener('change', (e) => {
  if (state.draft) { state.draft.riskLevel = e.target.value; runLiveValidate(); }
});

function updateForm() {
  const d = state.draft;
  $('editorForm').hidden = !d;
  if (!d) {
    $('fCode').value = '';
    $('fRisk').value = '';
    $('fValidate').textContent = '';
    return;
  }
  $('formTitle').textContent = d.mode === 'draw' ? '新建区域' : `编辑区域 #${d.id}`;
  $('fCode').value = d.code;
  $('fRisk').value = d.riskLevel;
  $('fBaseVersion').textContent = d.mode === 'draw'
    ? '新区域（保存后为 v1）'
    : `基于版本 v${d.baseVersion}`;
  $('btnDelete').style.display = d.mode === 'edit' ? '' : 'none';
  $('btnFinish').hidden = !(d.mode === 'draw' && !d.closed);
  $('fVertCount').textContent = `${d.vertices.length} 个顶点${d.closed ? ' · 已闭合' : ''}`;
  runLiveValidate();
}

/** 客户端预校验（服务端仍会独立做完整校验） */
function runLiveValidate() {
  const d = state.draft;
  const box = $('fValidate');
  if (!d) return;
  if (!d.code.trim()) { setValidate('请填写唯一编号', false); return; }
  if (!d.riskLevel) { setValidate('请选择风险等级', false); return; }
  if (d.mode === 'draw' && !d.closed) { setValidate('绘制中：双击或回车闭合多边形', false); return; }
  if (d.vertices.length < 3) { setValidate('至少需要 3 个顶点', false); return; }

  const err = window.Geometry.validateVertices(d.vertices, {
    width: state.plan.width, height: state.plan.height,
  });
  if (err) { setValidate(err, false); return; }

  const others = state.regions
    .filter((r) => r.id !== d.id)
    .map((r) => ({ id: r.id, code: r.code, vertices: r.vertices }));
  const ov = window.Geometry.validateOverlap(others, d.vertices);
  if (ov) { setValidate(ov, false); return; }

  setValidate('校验通过：形状合法且与其他区域无重叠', true);
}

function setValidate(text, ok) {
  const box = $('fValidate');
  box.textContent = text;
  box.className = 'validate-msg' + (ok ? ' ok' : '');
}

/* ----------------------------- 草稿渲染 ----------------------------- */

function renderDraft() {
  const layer = $('draftLayer');
  layer.innerHTML = '';
  const d = state.draft;
  if (!d) return;

  if (d.vertices.length >= 2) {
    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', pointsStr(d.vertices));
    poly.setAttribute('fill', DRAFT_COLOR.fill);
    poly.setAttribute('stroke', DRAFT_COLOR.stroke);
    poly.setAttribute('class', 'polygon-region draft');
    layer.appendChild(poly);
  }

  // 顶点拖拽手柄
  const handlesActive = d.mode === 'edit' || d.closed;
  d.vertices.forEach((p, i) => {
    if (handlesActive) {
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 6);
      c.setAttribute('class', 'handle');
      c.dataset.handle = 'vertex';
      c.dataset.idx = i;
      layer.appendChild(c);
    }
    // 序号
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('x', p.x); t.setAttribute('y', p.y - 10 / state.transform.scale);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'poly-label');
    t.textContent = i + 1;
    layer.appendChild(t);
  });

  // 中点插入手柄
  if (handlesActive && d.vertices.length >= 3) {
    for (let i = 0; i < d.vertices.length; i++) {
      const a = d.vertices[i];
      const b = d.vertices[(i + 1) % d.vertices.length];
      const c = document.createElementNS(SVGNS, 'circle');
      c.setAttribute('cx', (a.x + b.x) / 2);
      c.setAttribute('cy', (a.y + b.y) / 2);
      c.setAttribute('r', 4);
      c.setAttribute('class', 'handle mid');
      c.dataset.handle = 'newvertex';
      c.dataset.idx = i;
      layer.appendChild(c);
    }
  }

  // 绘制中橡皮筋
  if (d.mode === 'draw' && !d.closed && d.vertices.length > 0 && state.pointer) {
    const last = d.vertices[d.vertices.length - 1];
    const line = document.createElementNS(SVGNS, 'line');
    line.setAttribute('x1', last.x); line.setAttribute('y1', last.y);
    line.setAttribute('x2', state.pointer.x); line.setAttribute('y2', state.pointer.y);
    line.setAttribute('class', 'rubber');
    layer.appendChild(line);
  }
}

/* ------------------------ SVG 指针交互（统一处理） ------------------------ */

svg.addEventListener('mousedown', (e) => {
  if (!state.plan || e.button !== 0) return;
  const target = e.target;
  const d = state.draft;

  // 1) 拖拽已有顶点
  if (target.dataset && target.dataset.handle === 'vertex' && d) {
    state.drag = { type: 'vertex', idx: parseInt(target.dataset.idx, 10) };
    e.preventDefault();
    return;
  }
  // 2) 中点插入新顶点
  if (target.dataset && target.dataset.handle === 'newvertex' && d) {
    const at = parseInt(target.dataset.idx, 10) + 1;
    d.vertices.splice(at, 0, { ...d.vertices[at - 1] });
    state.drag = { type: 'vertex', idx: at };
    renderDraft();
    runLiveValidate();
    e.preventDefault();
    return;
  }

  // 3) 绘制模式：按下记录候选顶点；未移动松开才加入，移动了则当作平移
  if (d && d.mode === 'draw' && !d.closed) {
    const p0 = clampToImage(screenToOrig(e.clientX, e.clientY));
    const last = d.vertices[d.vertices.length - 1];
    // 双击的第二次 click 与 dblclick 落点极近，直接忽略，交给 dblclick 闭合
    if (last) {
      const tol = 8 / state.transform.scale; // 8 屏幕像素换算到原图坐标
      if (Math.abs(last.x - p0.x) < tol && Math.abs(last.y - p0.y) < tol) {
        state.drag = { type: 'ignoredrag' };
        return;
      }
    }
    state.drag = {
      type: 'drawpending', point: p0,
      startX: e.clientX, startY: e.clientY,
    };
    svg.classList.add('panning');
    return;
  }

  // 4) 点击已有区域 → 选中（有未提交编辑时不跳转）
  if (target.dataset && target.dataset.regionId) {
    selectRegion(parseInt(target.dataset.regionId, 10));
    return;
  }

  // 5) 否则平移
  state.drag = { type: 'pan', startX: e.clientX, startY: e.clientY, moved: false };
  svg.classList.add('panning');
});

svg.addEventListener('mousemove', (e) => {
  if (!state.plan) return;
  const p = screenToOrig(e.clientX, e.clientY);
  const clamped = clampToImage(p);
  $('cursorPos').textContent =
    (p.x >= 0 && p.y >= 0 && p.x <= state.plan.width && p.y <= state.plan.height)
      ? `原图坐标 X:${Math.round(clamped.x)}, Y:${Math.round(clamped.y)}`
      : '（光标在画布范围外）';

  const drag = state.drag;
  const d = state.draft;
  if (drag && drag.type === 'vertex' && d) {
    d.vertices[drag.idx] = clamped;
    renderDraft();
    renderRegionList();
    runLiveValidate();
  } else if (drag && (drag.type === 'pan' || drag.type === 'drawpending')) {
    // 绘制模式下拖动超过阈值即升级为平移，该次按下不再产生顶点
    if (drag.type === 'drawpending' &&
        Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 5) {
      drag.type = 'pan';
    }
    if (drag.type === 'pan') {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      state.transform.tx += dx;
      state.transform.ty += dy;
      drag.startX = e.clientX;
      drag.startY = e.clientY;
      applyTransform();
    }
  } else if (d && d.mode === 'draw' && !d.closed) {
    state.pointer = clamped;
    renderDraft();
  }
});

window.addEventListener('mouseup', (e) => {
  const drag = state.drag;
  if (drag && drag.type === 'drawpending') {
    // 未发生拖动 → 本次按下是一次点击，提交顶点
    const dd = state.draft;
    if (dd && dd.mode === 'draw' && !dd.closed) {
      dd.vertices.push(drag.point);
      $('fVertCount').textContent = `${dd.vertices.length} 个顶点`;
      renderDraft();
    }
  }
  state.drag = null;
  svg.classList.remove('panning');
});

svg.addEventListener('dblclick', (e) => {
  const d = state.draft;
  if (d && d.mode === 'draw' && !d.closed) {
    e.preventDefault();
    closeDraftPolygon();
  }
});

window.addEventListener('keydown', (e) => {
  if (!state.draft) return;
  if (e.key === 'Enter' && state.draft.mode === 'draw' && !state.draft.closed &&
      document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'SELECT') {
    closeDraftPolygon();
  }
  if (e.key === 'Escape') cancelDraft();
});

/* ------------------------------ 保存 / 删除 ------------------------------ */

/** 提交当前草稿（新建或更新）；按钮与冲突横幅的「重试」共用此函数 */
async function saveDraft() {
  const d = state.draft;
  if (!d) return;
  if (!d.code.trim()) return toast('请填写唯一编号', 'err');
  if (!d.riskLevel) return toast('请选择风险等级', 'err');
  if (d.mode === 'draw' && !d.closed) return toast('请先双击或回车闭合多边形', 'err');

  const shapeErr = window.Geometry.validateVertices(d.vertices, {
    width: state.plan.width, height: state.plan.height,
  });
  if (shapeErr) return toast(shapeErr, 'err', 6000);
  const others = state.regions
    .filter((r) => r.id !== d.id)
    .map((r) => ({ id: r.id, code: r.code, vertices: r.vertices }));
  const ov = window.Geometry.validateOverlap(others, d.vertices);
  if (ov) return toast(ov, 'err', 6000);

  const payload = {
    code: d.code.trim(),
    risk_level: d.riskLevel,
    vertices: d.vertices.map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 })),
    plan_version: state.plan.version,
  };
  const btn = $('btnSave');
  btn.disabled = true;
  try {
    let res;
    if (d.mode === 'draw') {
      res = await api('POST', `/api/plans/${state.plan.id}/regions`, payload);
      toast(`区域「${payload.code}」已创建（v1）`, 'ok');
    } else {
      payload.version = d.baseVersion;
      res = await api('PUT', `/api/plans/${state.plan.id}/regions/${d.id}`, payload);
      toast(`区域「${payload.code}」已保存（v${res.region.version}）`, 'ok');
    }
    applyServerState(res);
    state.draft = null;
    svg.classList.remove('drawing');
    hideBanner();
    renderRegions();
    renderRegionList();
    renderDraft();
    updateForm();
  } catch (err) {
    handleSaveError(err);
  } finally {
    btn.disabled = false;
  }
}

$('btnSave').addEventListener('click', saveDraft);

$('btnDelete').addEventListener('click', async () => {
  const d = state.draft;
  if (!d || d.mode !== 'edit') return;
  if (!confirm(`确认删除区域「${d.code}」？\n删除不可撤销，其他设备基于旧版本的提交将无法恢复该区域。`)) {
    return;
  }
  const url = `/api/plans/${state.plan.id}/regions/${d.id}` +
    `?version=${d.baseVersion}&plan_version=${state.plan.version}`;
  try {
    const res = await api('DELETE', url);
    applyServerState(res);
    state.draft = null;
    hideBanner();
    toast(`区域「${d.code}」已删除`, 'ok');
    renderRegions();
    renderRegionList();
    renderDraft();
    updateForm();
  } catch (err) {
    handleSaveError(err);
  }
});

/** 把保存/删除响应中的最新服务端状态应用到本地 */
function applyServerState(res) {
  if (res.plan_version) state.plan.version = res.plan_version;
  if (Array.isArray(res.regions)) state.regions = res.regions;
  updatePlanVersionBadge();
}

/**
 * 冲突处理：按要求保留未提交编辑（表单/顶点不动），
 * 仅刷新服务端最新区域与版本，并给出明确原因。
 */
function handleSaveError(err) {
  if (err.status === 409 || err.status === 410) {
    const snap = err.data && err.data.server;
    if (snap) {
      if (snap.plan_version) state.plan.version = snap.plan_version;
      if (Array.isArray(snap.regions)) state.regions = snap.regions;
      updatePlanVersionBadge();
      renderRegions();
      renderRegionList();
      runLiveValidate();
    }
    let actions;
    if (err.code === 'REGION_DELETED') {
      actions = [
        { label: '放弃编辑（该区域已删除）', action: () => cancelDraft() },
        { label: '保留顶点，作为新区域另存', action: () => convertDraftToNew() },
      ];
    } else if (err.code === 'VERSION_CONFLICT' && snap && snap.region) {
      // 以服务端最新版本为新基准后，可带着自己的修改直接重试（仍会再过一次重叠/编号校验）
      actions = [
        { label: `以最新 v${snap.region.version} 为基准重试保存`, action: () => {
            if (state.draft && state.draft.mode === 'edit') {
              state.draft.baseVersion = snap.region.version;
              updateForm();
            }
            hideBanner();
            saveDraft();
          } },
        { label: '先保留我的编辑，我手动处理', action: () => hideBanner() },
      ];
    } else {
      // PLAN_VERSION_CONFLICT / CODE_CONFLICT：已刷新为最新状态，编辑保留，用户自行合并后再保存
      actions = [{ label: '我知道了（编辑内容已保留）', action: () => hideBanner() }];
    }
    const prefix = err.code === 'REGION_DELETED' ? '⛔ ' : '⚠ 冲突：';
    showBanner(prefix + err.message, actions);
  } else {
    toast(err.message, 'err', 6000);
  }
}

function convertDraftToNew() {
  const d = state.draft;
  if (!d) return;
  state.draft = {
    mode: 'draw',
    code: '', riskLevel: '',
    vertices: d.vertices.map((p) => ({ ...p })),
    closed: true,
  };
  hideBanner();
  renderRegions();
  renderRegionList();
  renderDraft();
  updateForm();
  toast('已转为新建草稿，请填写新的唯一编号后保存', 'info');
}

function showBanner(message, actions) {
  const b = $('conflictBanner');
  b.innerHTML = '';
  const p = document.createElement('div');
  p.textContent = message;
  b.appendChild(p);
  if (actions) {
    const row = document.createElement('div');
    row.className = 'banner-actions';
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = a.label;
      btn.onclick = a.action;
      row.appendChild(btn);
    }
    b.appendChild(row);
  }
  b.classList.remove('hidden');
}
function hideBanner() { $('conflictBanner').classList.add('hidden'); }

/* -------------------------- 协作轮询（每 3 秒） -------------------------- */

function startPolling() {
  stopPolling();
  let first = true;
  state.pollTimer = setInterval(async () => {
    if (!state.plan) return;
    try {
      const data = await api('GET', `/api/plans/${state.plan.id}`);
      if (data.plan.version !== state.plan.version) {
        state.plan.version = data.plan.version;
        state.regions = data.regions;
        updatePlanVersionBadge();
        renderRegions();
        renderRegionList();
        runLiveValidate();
        if (!first && state.draft) {
          const badge = $('collabHint');
          badge.classList.remove('hidden');
          setTimeout(() => badge.classList.add('hidden'), 4000);
        }
      }
      refreshPublishStatus();
    } catch (_) { /* 轮询失败静默，下轮重试 */ }
    first = false;
  }, 3000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

/* -------------------------- 巡检版：发布与只读查看 -------------------------- */

/** 刷新编辑器面板中的发布状态摘要，并同步巡检视图的序号选择器 */
async function refreshPublishStatus() {
  if (!state.plan) return;
  try {
    const data = await api('GET', `/api/plans/${state.plan.id}/publications`);
    inspect.pubs = data.publications;
    const el = $('pubStatus');
    if (!inspect.pubs.length) {
      el.textContent = '暂无巡检版：当前图纸尚未发布。';
    } else {
      const latest = inspect.pubs[inspect.pubs.length - 1];
      el.textContent = `最新巡检版 #${latest.seq}（基于图纸 v${latest.plan_version} · ` +
        `${latest.region_count} 个区域 · ${latest.created_at}）`;
    }
    renderInspectSeqOptions();
  } catch (_) { /* 状态刷新失败静默，下轮重试 */ }
}

function renderInspectSeqOptions() {
  const sel = $('inspectSeq');
  if (!sel) return;
  const keep = inspect.current ? String(inspect.current.publication.seq) : sel.value;
  sel.innerHTML = '';
  for (const p of inspect.pubs) {
    const opt = document.createElement('option');
    opt.value = String(p.seq);
    opt.textContent = `巡检版 #${p.seq}（基于图纸 v${p.plan_version}）${p.latest ? ' · 最新' : ''}`;
    sel.appendChild(opt);
  }
  if (keep && inspect.pubs.some((p) => String(p.seq) === keep)) sel.value = keep;
}

$('btnPublish').addEventListener('click', async () => {
  if (!state.plan) return;
  if (state.draft) {
    return toast('有未保存的编辑：请先保存或取消，再以最新图纸版本发布', 'err', 5000);
  }
  const btn = $('btnPublish');
  btn.disabled = true;
  try {
    const res = await api('POST', `/api/plans/${state.plan.id}/publish`, {
      plan_version: state.plan.version,
    });
    if (res.duplicate) {
      toast(`图纸版本 v${state.plan.version} 已发布过（巡检版 #${res.publication.seq}），未重复创建`,
        'info', 5000);
    } else {
      toast(`已发布巡检版 #${res.publication.seq}（基于图纸 v${res.publication.plan_version} · ` +
        `${res.publication.region_count} 个区域）`, 'ok', 5000);
    }
    await refreshPublishStatus();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.server) {
      // 发布期间图纸被改动：未产生任何快照，应用最新状态后由用户重新发布
      const snap = err.data.server;
      if (snap.plan_version) state.plan.version = snap.plan_version;
      if (Array.isArray(snap.regions)) state.regions = snap.regions;
      updatePlanVersionBadge();
      renderRegions();
      renderRegionList();
    }
    toast((err.status === 409 ? '发布取消：' : '发布失败：') + err.message, 'err', 8000);
  } finally {
    btn.disabled = false;
  }
});

$('btnViewInspect').addEventListener('click', () => openInspectView());
$('btnInspectBack').addEventListener('click', () => {
  showView('editor');
});

async function openInspectView() {
  if (!state.plan) return;
  showView('inspect');
  await refreshPublishStatus();
  if (!inspect.pubs.length) {
    inspect.current = null;
    renderInspectEmpty();
    return;
  }
  // 默认打开最新版；若之前看过某版且仍存在则保持
  const keep = inspect.current &&
    inspect.pubs.find((p) => p.seq === inspect.current.publication.seq);
  await loadInspection(keep ? keep.seq : 'latest');
}

function renderInspectEmpty() {
  $('inspectEmpty').classList.remove('hidden');
  $('inspectSeqBadge').textContent = '暂无巡检版';
  $('inspectPlanVer').textContent = '';
  $('inspectLatestBadge').classList.add('hidden');
  $('inspectMeta').textContent = '发布后可在此按序号查看只读快照。';
  $('inspectRegionCount').textContent = '';
  $('inspectRegionList').innerHTML = '';
  $('inspectRegionDetail').classList.add('hidden');
  $('inspectLayer').innerHTML = '';
  $('inspectImage').removeAttribute('href');
  renderInspectSeqOptions();
}

async function loadInspection(seq) {
  try {
    const data = await api('GET', `/api/plans/${state.plan.id}/publications/${seq}`);
    inspect.current = data;
    inspect.selected = null;
    renderInspection();
  } catch (err) {
    if (err.code === 'NO_PUBLICATION') {
      inspect.current = null;
      renderInspectEmpty();
    } else {
      toast(err.message, 'err', 6000);
    }
  }
}

function renderInspection() {
  const { publication: pub, regions } = inspect.current;
  $('inspectEmpty').classList.add('hidden');
  $('inspectSeqBadge').textContent = `巡检版 #${pub.seq}`;
  $('inspectPlanVer').textContent = `基于图纸 v${pub.plan_version}`;
  $('inspectLatestBadge').classList.toggle('hidden', !pub.latest);
  $('inspectMeta').textContent =
    `发布于 ${pub.created_at} · ${pub.width}×${pub.height}px · ${regions.length} 个区域`;

  const img = $('inspectImage');
  const url = `/api/plans/${state.plan.id}/publications/${pub.seq}/image`;
  img.setAttribute('href', url);
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', url);
  img.setAttribute('width', pub.width);
  img.setAttribute('height', pub.height);
  $('inspectBg').setAttribute('width', pub.width);
  $('inspectBg').setAttribute('height', pub.height);

  renderInspectSeqOptions();
  $('inspectSeq').value = String(pub.seq);
  renderInspectRegions();
  renderInspectList();
  inspectFit();
}

function renderInspectRegions() {
  const layer = $('inspectLayer');
  layer.innerHTML = '';
  const { regions } = inspect.current;
  for (const r of regions) {
    const c = RISK_COLORS[r.risk_level] || { fill: 'rgba(107,114,128,.15)', stroke: '#6b7280' };
    const poly = document.createElementNS(SVGNS, 'polygon');
    poly.setAttribute('points', pointsStr(r.vertices));
    poly.setAttribute('fill', c.fill);
    poly.setAttribute('stroke', c.stroke);
    poly.setAttribute('class',
      'polygon-region' + (inspect.selected === r.code ? ' inspect-selected' : ''));
    poly.dataset.code = r.code;
    poly.addEventListener('click', () => selectInspectRegion(r.code));
    layer.appendChild(poly);

    const ctr = centroid(r.vertices);
    const label = document.createElementNS(SVGNS, 'text');
    label.setAttribute('x', ctr.x);
    label.setAttribute('y', ctr.y);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('dominant-baseline', 'central');
    label.setAttribute('class', 'poly-label');
    label.textContent = `${r.code} · ${r.risk_level}`;
    layer.appendChild(label);
  }
}

function renderInspectList() {
  const { regions } = inspect.current;
  $('inspectRegionCount').textContent = `（${regions.length}）`;
  const ul = $('inspectRegionList');
  ul.innerHTML = '';
  for (const r of regions) {
    const li = document.createElement('li');
    if (inspect.selected === r.code) li.classList.add('active');
    li.innerHTML = `
      <span class="risk-dot ${esc(r.risk_level)}"></span>
      <span class="r-code">${esc(r.code)}</span>
      <span class="muted">${esc(r.risk_level)}</span>`;
    li.onclick = () => selectInspectRegion(r.code);
    ul.appendChild(li);
  }
  renderInspectDetail();
}

function selectInspectRegion(code) {
  inspect.selected = inspect.selected === code ? null : code;
  renderInspectRegions();
  renderInspectList();
}

function renderInspectDetail() {
  const box = $('inspectRegionDetail');
  const r = inspect.current &&
    inspect.current.regions.find((x) => x.code === inspect.selected);
  if (!r) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const verts = r.vertices.map((p) => `(${p.x}, ${p.y})`).join(' ');
  box.innerHTML = `
    <h4>${esc(r.code)} · ${esc(r.risk_level)}</h4>
    <div class="verts">原图坐标：${esc(verts)}</div>`;
  box.classList.remove('hidden');
}

$('inspectSeq').addEventListener('change', (e) => loadInspection(e.target.value));
$('btnInspectLatest').addEventListener('click', () => loadInspection('latest'));

/* ----------------------- 巡检视图：缩放 / 平移（只读） ----------------------- */

const inspectSvg = $('inspectSvg');

function applyInspectTransform() {
  const t = inspect.transform;
  $('inspectViewport').setAttribute('transform',
    `translate(${t.tx} ${t.ty}) scale(${t.scale})`);
  $('inspectZoom').textContent = `缩放 ${Math.round(t.scale * 100)}%`;
}

function inspectZoomAt(clientX, clientY, factor) {
  const rect = inspectSvg.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  const t = inspect.transform;
  const ns = Math.min(20, Math.max(0.05, t.scale * factor));
  const f = ns / t.scale;
  t.tx = mx - (mx - t.tx) * f;
  t.ty = my - (my - t.ty) * f;
  t.scale = ns;
  applyInspectTransform();
}

function inspectFit() {
  if (!inspect.current) return;
  const pub = inspect.current.publication;
  const rect = inspectSvg.getBoundingClientRect();
  const pad = 40;
  const s = Math.min(
    (rect.width - pad * 2) / pub.width,
    (rect.height - pad * 2) / pub.height
  );
  inspect.transform.scale = Math.min(8, Math.max(0.05, s));
  inspect.transform.tx = (rect.width - pub.width * inspect.transform.scale) / 2;
  inspect.transform.ty = (rect.height - pub.height * inspect.transform.scale) / 2;
  applyInspectTransform();
}

$('btnInspectZoomIn').onclick = () => inspectZoomCenter(1.25);
$('btnInspectZoomOut').onclick = () => inspectZoomCenter(0.8);
$('btnInspectFit').onclick = inspectFit;
$('btnInspect100').onclick = () => {
  const rect = inspectSvg.getBoundingClientRect();
  inspectZoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
    1 / inspect.transform.scale);
};
function inspectZoomCenter(f) {
  const rect = inspectSvg.getBoundingClientRect();
  inspectZoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, f);
}

inspectSvg.addEventListener('wheel', (e) => {
  if (!inspect.current) return;
  e.preventDefault();
  inspectZoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

inspectSvg.addEventListener('mousedown', (e) => {
  if (!inspect.current || e.button !== 0) return;
  if (e.target.dataset && e.target.dataset.code) return; // 点击区域：选中，不平移
  inspect.drag = { startX: e.clientX, startY: e.clientY };
  inspectSvg.classList.add('panning');
});

inspectSvg.addEventListener('mousemove', (e) => {
  if (!inspect.current) return;
  const pub = inspect.current.publication;
  const rect = inspectSvg.getBoundingClientRect();
  const t = inspect.transform;
  const px = (e.clientX - rect.left - t.tx) / t.scale;
  const py = (e.clientY - rect.top - t.ty) / t.scale;
  $('inspectCursor').textContent =
    (px >= 0 && py >= 0 && px <= pub.width && py <= pub.height)
      ? `原图坐标 X:${Math.round(px)}, Y:${Math.round(py)}`
      : '（光标在画布范围外）';
  const drag = inspect.drag;
  if (drag) {
    t.tx += e.clientX - drag.startX;
    t.ty += e.clientY - drag.startY;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    applyInspectTransform();
  }
});

window.addEventListener('mouseup', () => {
  inspect.drag = null;
  inspectSvg.classList.remove('panning');
});

window.addEventListener('resize', () => {
  if (inspect.current) applyInspectTransform();
});

/* ------------------------------ 初始化 ------------------------------ */

window.addEventListener('resize', () => {
  if (state.plan) applyTransform();
});

showView('list');
loadPlans().catch((e) => toast('加载平面图列表失败：' + e.message, 'err', 8000));
