'use strict';
/*
 * 巡检版发布 / 只读查询的端到端集成测试：node tests/publish.test.js
 * 在临时数据目录中启动真实 HTTP 服务，覆盖：
 *  - 未发布时的明确提示（404 NO_PUBLICATION）
 *  - 发布必须携带所见图纸版本；版本冲突 409 且不留部分快照
 *  - 同一图纸版本重复发布幂等（不产生重复巡检版）
 *  - 发布后编辑 / 删区 / 同尺寸换图均不改变已发布内容（含快照原图字节）
 *  - 原图缺失时不得记为发布成功
 *  - 现有编辑 / 导出接口约定保持不变
 */
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hpa-publish-test-'));
process.env.DATA_DIR = DATA_DIR;
process.env.PORT = '0'; // 随机端口，避免冲突

const app = require('../server/app');
const { server, db } = app;

const base = () => `http://127.0.0.1:${server.address().port}`;

let n = 0;
async function check(name, fn) {
  await fn();
  n++;
  console.log('  ✓', name);
}

/** 构造可过服务端校验的最小 PNG（可选 tEXt 块区分字节内容） */
function makePng(width, height, tag = '') {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;
  const parts = [sig, ihdr];
  if (tag) {
    const data = Buffer.from(tag, 'utf8');
    const text = Buffer.alloc(12 + data.length);
    text.writeUInt32BE(data.length, 0);
    text.write('tEXt', 4, 'ascii');
    data.copy(text, 8);
    parts.push(text);
  }
  const iend = Buffer.alloc(12);
  iend.write('IEND', 4, 'ascii');
  parts.push(iend);
  return Buffer.concat(parts);
}

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(base() + url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* 无响应体 */ }
  return { status: res.status, data };
}

async function uploadPlan(png, name) {
  const fd = new FormData();
  fd.append('image', new Blob([png], { type: 'image/png' }), 'hall.png');
  if (name) fd.append('name', name);
  const res = await fetch(`${base()}/api/plans`, { method: 'POST', body: fd });
  return { status: res.status, data: await res.json() };
}

const R1 = [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 80 }, { x: 10, y: 80 }];
const R2 = [{ x: 150, y: 150 }, { x: 250, y: 150 }, { x: 250, y: 220 }, { x: 150, y: 220 }];
const R1_MOVED = [{ x: 12, y: 12 }, { x: 100, y: 12 }, { x: 100, y: 80 }, { x: 12, y: 80 }];

async function main() {
  await new Promise((resolve) => (server.listening ? resolve() : server.on('listening', resolve)));

  const pngV1 = makePng(400, 300, 'original');
  const pngV2 = makePng(400, 300, 'replaced-same-size');

  let planId;
  let planVersion;

  await check('上传平面图成功（现有接口约定不变）', async () => {
    const r = await uploadPlan(pngV1, '巡检测试馆');
    assert.equal(r.status, 201);
    assert.equal(r.data.plan.width, 400);
    planId = r.data.plan.id;
    planVersion = r.data.plan.version;
  });

  await check('未发布时：列表为空，latest 明确提示暂无巡检版', async () => {
    const list = await api('GET', `/api/plans/${planId}/publications`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.data.publications, []);
    const latest = await api('GET', `/api/plans/${planId}/publications/latest`);
    assert.equal(latest.status, 404);
    assert.equal(latest.data.error, 'NO_PUBLICATION');
    assert.match(latest.data.message, /暂无巡检版/);
  });

  await check('发布必须携带所见图纸版本 plan_version', async () => {
    const r = await api('POST', `/api/plans/${planId}/publish`, {});
    assert.equal(r.status, 400);
    assert.match(r.data.message, /plan_version/);
  });

  await check('图纸版本不符 → 409 冲突且不留部分快照', async () => {
    const r = await api('POST', `/api/plans/${planId}/publish`, { plan_version: 999 });
    assert.equal(r.status, 409);
    assert.equal(r.data.error, 'PLAN_VERSION_CONFLICT');
    const list = await api('GET', `/api/plans/${planId}/publications`);
    assert.deepEqual(list.data.publications, []); // 未留下任何快照
  });

  await check('新建两个区域（现有接口约定不变）', async () => {
    let r = await api('POST', `/api/plans/${planId}/regions`, {
      code: 'A-01', risk_level: '高风险', vertices: R1, plan_version: planVersion,
    });
    assert.equal(r.status, 201);
    planVersion = r.data.plan_version;
    r = await api('POST', `/api/plans/${planId}/regions`, {
      code: 'B-02', risk_level: '低风险', vertices: R2, plan_version: planVersion,
    });
    assert.equal(r.status, 201);
    planVersion = r.data.plan_version;
  });

  let pub1;
  await check('发布成功：固定编号 / 风险等级 / 原图坐标，发布不改变图纸版本', async () => {
    const r = await api('POST', `/api/plans/${planId}/publish`, { plan_version: planVersion });
    assert.equal(r.status, 201);
    assert.equal(r.data.duplicate, false);
    pub1 = r.data.publication;
    assert.equal(pub1.seq, 1);
    assert.equal(pub1.plan_version, planVersion);
    assert.equal(pub1.region_count, 2);
    assert.equal(r.data.regions.length, 2);
    const a = r.data.regions.find((x) => x.code === 'A-01');
    assert.equal(a.risk_level, '高风险');
    assert.deepEqual(a.vertices, R1);
    const after = await api('GET', `/api/plans/${planId}`);
    assert.equal(after.data.plan.version, planVersion); // 发布本身不 bump 图纸版本
  });

  await check('同一图纸版本重复发布：幂等返回已有巡检版，不产生重复', async () => {
    const r = await api('POST', `/api/plans/${planId}/publish`, { plan_version: planVersion });
    assert.equal(r.status, 200);
    assert.equal(r.data.duplicate, true);
    assert.equal(r.data.publication.seq, 1);
    const list = await api('GET', `/api/plans/${planId}/publications`);
    assert.equal(list.data.publications.length, 1);
  });

  await check('后续编辑区域：已发布内容不变', async () => {
    const detail = await api('GET', `/api/plans/${planId}`);
    const region = detail.data.regions.find((x) => x.code === 'A-01');
    const r = await api('PUT', `/api/plans/${planId}/regions/${region.id}`, {
      code: 'A-01-改', risk_level: '中风险', vertices: R1_MOVED,
      version: region.version, plan_version: planVersion,
    });
    assert.equal(r.status, 200);
    planVersion = r.data.plan_version;

    const pub = await api('GET', `/api/plans/${planId}/publications/1`);
    const a = pub.data.regions.find((x) => x.region_id === region.id);
    assert.equal(a.code, 'A-01');            // 快照仍是旧编号
    assert.equal(a.risk_level, '高风险');    // 快照仍是旧风险等级
    assert.deepEqual(a.vertices, R1);        // 快照仍是旧原图坐标
  });

  await check('同尺寸换图：巡检版快照原图字节保持发布时刻内容', async () => {
    const fd = new FormData();
    fd.append('image', new Blob([pngV2], { type: 'image/png' }), 'new.png');
    const res = await fetch(`${base()}/api/plans/${planId}`, { method: 'PUT', body: fd });
    assert.equal(res.status, 200);
    planVersion = (await res.json()).plan.version; // 换图会使图纸版本 +1

    const snapImg = await fetch(`${base()}/api/plans/${planId}/publications/1/image`);
    assert.equal(snapImg.status, 200);
    const buf = Buffer.from(await snapImg.arrayBuffer());
    assert.ok(buf.equals(pngV1)); // 快照仍是旧图
    const curImg = await fetch(`${base()}/api/plans/${planId}/image`);
    const curBuf = Buffer.from(await curImg.arrayBuffer());
    assert.ok(curBuf.equals(pngV2)); // 当前图已换新
  });

  await check('删除区域：已发布内容不变', async () => {
    const detail = await api('GET', `/api/plans/${planId}`);
    const region = detail.data.regions.find((x) => x.code === 'B-02');
    const r = await api('DELETE',
      `/api/plans/${planId}/regions/${region.id}?version=${region.version}&plan_version=${planVersion}`);
    assert.equal(r.status, 200);
    planVersion = r.data.plan_version;

    const pub = await api('GET', `/api/plans/${planId}/publications/1`);
    assert.equal(pub.data.publication.region_count, 2);
    assert.equal(pub.data.regions.length, 2); // 快照仍含已删除区域
  });

  await check('基于新图纸版本再次发布：序号递增，旧版保持原样', async () => {
    const r = await api('POST', `/api/plans/${planId}/publish`, { plan_version: planVersion });
    assert.equal(r.status, 201);
    assert.equal(r.data.publication.seq, 2);
    assert.equal(r.data.publication.region_count, 1);

    const latest = await api('GET', `/api/plans/${planId}/publications/latest`);
    assert.equal(latest.data.publication.seq, 2);
    assert.equal(latest.data.publication.latest, true);
    assert.equal(latest.data.regions[0].code, 'A-01-改');

    const old = await api('GET', `/api/plans/${planId}/publications/1`);
    assert.equal(old.data.publication.latest, false);
    assert.equal(old.data.regions.length, 2);
    assert.equal(old.data.regions.find((x) => x.code === 'A-01').risk_level, '高风险');
  });

  await check('序号非法 / 不存在时的明确提示', async () => {
    const bad = await api('GET', `/api/plans/${planId}/publications/abc`);
    assert.equal(bad.status, 400);
    const missing = await api('GET', `/api/plans/${planId}/publications/99`);
    assert.equal(missing.status, 404);
    assert.match(missing.data.message, /#99 不存在/);
  });

  await check('整图导出接口约定不变', async () => {
    const res = await fetch(`${base()}/api/plans/${planId}/export`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.format, 'hall-plan-annotator-export/v1');
    assert.equal(data.regions.length, 1);
  });

  await check('原图缺失时发布：410 且不记为发布成功', async () => {
    // 先改名使图纸版本 +1（否则同版本发布会命中幂等路径）
    const fd = new FormData();
    fd.append('name', '巡检测试馆（改名）');
    const res = await fetch(`${base()}/api/plans/${planId}`, { method: 'PUT', body: fd });
    assert.equal(res.status, 200);
    planVersion = (await res.json()).plan.version;

    const imgFile = path.join(DATA_DIR, 'uploads', `${planId}.png`);
    fs.unlinkSync(imgFile); // 模拟数据目录中原图丢失
    const r = await api('POST', `/api/plans/${planId}/publish`, { plan_version: planVersion });
    assert.equal(r.status, 410);
    assert.equal(r.data.error, 'IMAGE_MISSING');
    const list = await api('GET', `/api/plans/${planId}/publications`);
    assert.equal(list.data.publications.length, 2); // 未产生新巡检版
    // 已发布快照的原图是独立拷贝，当前原图缺失也不影响查看
    const snapImg = await fetch(`${base()}/api/plans/${planId}/publications/1/image`);
    assert.equal(snapImg.status, 200);
  });

  console.log(`\n巡检版集成测试通过：${n} 项`);
}

main()
  .then(() => {
    server.close(() => {
      db.close();
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
      process.exit(0);
    });
  })
  .catch((err) => {
    console.error('\n✗ 测试失败：', err);
    try { server.close(() => db.close()); } catch (_) {}
    process.exit(1);
  });

setTimeout(() => {
  console.error('✗ 测试超时');
  process.exit(1);
}, 30000).unref();
