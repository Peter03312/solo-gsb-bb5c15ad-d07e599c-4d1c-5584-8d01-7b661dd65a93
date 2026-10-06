'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

/**
 * 打开（并按需初始化）SQLite 数据库。
 * 幂等：表/索引已存在时不会重建，数据得以保留。
 * 同时可作为迁移脚本独立运行：npm run migrate
 */
function openDb() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadDir(), { recursive: true });

  const db = new Database(config.dbFile());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS plans (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      image_file   TEXT    NOT NULL,
      image_mime   TEXT    NOT NULL,
      width        INTEGER NOT NULL,
      height       INTEGER NOT NULL,
      version      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS regions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id      INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      code         TEXT    NOT NULL,
      risk_level   TEXT    NOT NULL,
      vertices     TEXT    NOT NULL,   -- JSON: [{"x":..,"y":..}, ...]，原图坐标
      version      INTEGER NOT NULL DEFAULT 1,
      deleted      INTEGER NOT NULL DEFAULT 0,  -- 软删除墓碑，用于版本/冲突语义
      created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 同一图上「未删除」区域编号唯一；编号删除后允许复用
    CREATE UNIQUE INDEX IF NOT EXISTS idx_regions_code_active
      ON regions(plan_id, code) WHERE deleted = 0;

    CREATE INDEX IF NOT EXISTS idx_regions_plan
      ON regions(plan_id, deleted);

    -- 巡检版（只读发布快照）：发布时刻的原图与全部未删除区域被整体冻结，
    -- 后续编辑、删区、同尺寸换图均不回写这些表。
    CREATE TABLE IF NOT EXISTS publications (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id       INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      seq           INTEGER NOT NULL,           -- 发布序号：同一图纸内从 1 递增
      plan_version  INTEGER NOT NULL,           -- 发布请求所见的图纸版本
      name          TEXT    NOT NULL,           -- 发布时刻的图纸名称快照
      width         INTEGER NOT NULL,
      height        INTEGER NOT NULL,
      image_mime    TEXT    NOT NULL,
      image_file    TEXT    NOT NULL,           -- 快照原图（独立拷贝，换图不影响）
      region_count  INTEGER NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- 发布序号在图纸内唯一
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_plan_seq
      ON publications(plan_id, seq);

    -- 幂等约束：同一图纸版本重复发布不会产生重复巡检版
    CREATE UNIQUE INDEX IF NOT EXISTS idx_publications_plan_version
      ON publications(plan_id, plan_version);

    CREATE TABLE IF NOT EXISTS publication_regions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id  INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      region_id       INTEGER NOT NULL,         -- 来源区域 id（发布时点，便于追溯）
      code            TEXT    NOT NULL,
      risk_level      TEXT    NOT NULL,
      vertices        TEXT    NOT NULL,         -- JSON 原图坐标快照
      region_version  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pub_regions_pub
      ON publication_regions(publication_id);
  `);

  return db;
}

// 直接执行 `node server/db.js` 时完成初始化并退出（供依赖初始化/CI 使用）
if (require.main === module) {
  const db = openDb();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%'"
  ).all();
  console.log('数据库初始化完成:', config.dbFile());
  console.log('对象:', tables.map((t) => t.name).join(', '));
  db.close();
}

module.exports = { openDb };
