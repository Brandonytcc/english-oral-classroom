// SQLite 数据层（Node 内置 node:sqlite，无需联网安装原生模块）
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS teachers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  token      TEXT UNIQUE NOT NULL,
  pwd        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS classes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  teacher_token TEXT NOT NULL,
  teacher_pwd   TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  token      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(class_id, name)
);
CREATE TABLE IF NOT EXISTS assignments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id         INTEGER NOT NULL,
  title            TEXT NOT NULL,
  ref_text         TEXT NOT NULL,
  required_minutes INTEGER DEFAULT 0,
  due_date         TEXT,
  created_at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  student_id   INTEGER NOT NULL,
  score        REAL,
  accuracy     REAL,
  fluency      REAL,
  completeness REAL,
  transcript   TEXT,
  duration_sec INTEGER,
  source       TEXT DEFAULT 'local',
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id     INTEGER NOT NULL,
  student_id   INTEGER NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  duration_sec INTEGER,
  date         TEXT NOT NULL,
  valid        INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rollcall (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id   INTEGER NOT NULL,
  method     TEXT DEFAULT 'random',
  groups     TEXT,           -- JSON: {"第一组":["张三","李四"], ...}
  seq_index  INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS words (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id   INTEGER NOT NULL,
  word       TEXT NOT NULL,
  meaning    TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS game_scores (
  class_id   INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  points     INTEGER DEFAULT 0,
  PRIMARY KEY (class_id, student_id)
);
`);

// 字段迁移：作业支持「单词朗读」类型
function colExists(table, col) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
  return cols.includes(col);
}
if (!colExists('assignments', 'type')) db.exec("ALTER TABLE assignments ADD COLUMN type TEXT DEFAULT 'passage'");
if (!colExists('assignments', 'words_json')) db.exec("ALTER TABLE assignments ADD COLUMN words_json TEXT");

module.exports = db;
