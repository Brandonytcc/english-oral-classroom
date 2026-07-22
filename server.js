const express = require('express');
const crypto = require('crypto');
const http = require('http');
const xlsx = require('xlsx');
const { WebSocketServer } = require('ws');
const db = require('./db');
const tencent = require('./tencent');

const PUBLIC_DIR = require('path').join(__dirname, 'public');
const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(PUBLIC_DIR));

/* ----------------------------- 工具 ----------------------------- */
function genId() { return crypto.randomBytes(8).toString('hex'); }
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (db.prepare('SELECT 1 FROM classes WHERE code=?').get(code));
  return code;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function pwdHash(pwd, code) {
  return crypto.createHash('sha256').update(pwd + '|' + code).digest('hex');
}
// 解析请求中的成员身份（教师或学生，必须属于该班级）
function resolveMember(code, token) {
  const cls = db.prepare('SELECT * FROM classes WHERE code=?').get(String(code).toUpperCase());
  if (!cls) return { error: 404 };
  if (cls.teacher_token === token) return { cls, member: { role: 'teacher' } };
  const st = db.prepare('SELECT * FROM students WHERE token=? AND class_id=?').get(token, cls.id);
  if (st) return { cls, member: { role: 'student', student: st } };
  return { error: 401 };
}
function tokenFromReq(req) {
  const auth = req.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : (req.body && req.body.token) || req.query.token;
}

// 本地评分（无云 key 时启用）：用识别出的文本与原文逐词比对
function toWords(t) { return t.toLowerCase().replace(/[^a-z0-9\s']/g, '').split(/\s+/).filter(Boolean); }
function localScore(target, transcript) {
  const tWords = toWords(target);
  const sWords = toWords(transcript || '');
  const bag = {};
  tWords.forEach(w => (bag[w] = (bag[w] || 0) + 1));
  let matched = 0;
  const tmp = Object.assign({}, bag);
  sWords.forEach(w => { if (tmp[w] > 0) { matched++; tmp[w]--; } });
  const accuracy = tWords.length ? Math.round((matched / tWords.length) * 100) : 0;
  const tUni = new Set(tWords).size;
  const covered = new Set(sWords.filter(w => bag[w] > 0)).size;
  const completeness = tUni ? Math.round((covered / tUni) * 100) : 0;
  const score = Math.round(accuracy * 0.5 + completeness * 0.3 + 80 * 0.2);
  return { score, accuracy, fluency: 80, completeness, transcript: (transcript || '').trim() };
}
// 单词朗读本地评分：朗读内容需与目标单词一致
function localWordScore(target, said) {
  const t = (target || '').trim().toLowerCase();
  const s = (said || '').trim().toLowerCase();
  if (!t) return { score: 0, accuracy: 0, completeness: 0 };
  if (s === t) return { score: 100, accuracy: 100, completeness: 100 };
  if (s && (s.includes(t) || t.includes(s))) return { score: 80, accuracy: 80, completeness: 80 };
  return { score: 40, accuracy: 40, completeness: 40 };
}

/* ----------------------------- 角色与鉴权 ----------------------------- */
// 教师身份：同一教师（姓名+密码）可归属多个班级，teacher_token 稳定
function teacherTokenOf(name, password) {
  return crypto.createHash('sha256').update('T|' + String(name).trim().toLowerCase() + '|' + password).digest('hex');
}
function classListOf(token) {
  return db.prepare('SELECT code,name FROM classes WHERE teacher_token=? ORDER BY created_at').all(token);
}
// 老师创建班级（同时作为教师账号注册/登录）
app.post('/api/teacher/register', (req, res) => {
  const { teacherName, password, className } = req.body || {};
  if (!teacherName || !teacherName.trim()) return res.status(400).json({ error: '请填写教师姓名' });
  if (!password || password.length < 4) return res.status(400).json({ error: '教师密码至少 4 位' });
  if (!className || !className.trim()) return res.status(400).json({ error: '请填写班级名称' });
  const tToken = teacherTokenOf(teacherName, password);
  const exist = db.prepare('SELECT * FROM teachers WHERE token=?').get(tToken);
  if (!exist) db.prepare('INSERT INTO teachers(name,token,pwd,created_at) VALUES(?,?,?,?)')
    .run(teacherName.trim(), tToken, pwdHash(password, 'T' + teacherName.trim().toLowerCase()), Date.now());
  const code = genCode();
  db.prepare('INSERT INTO classes(code,name,teacher_token,teacher_pwd,created_at) VALUES(?,?,?,?,?)')
    .run(code, className.trim(), tToken, pwdHash(password, code), Date.now());
  res.json({ teacherToken: tToken, teacherName: teacherName.trim(), code, className: className.trim(), classes: classListOf(tToken) });
});

// 老师登录（按教师姓名+密码，返回其名下所有班级）
app.post('/api/teacher/login', (req, res) => {
  const { teacherName, password } = req.body || {};
  if (!teacherName || !password) return res.status(400).json({ error: '请填写教师姓名和密码' });
  const tToken = teacherTokenOf(teacherName, password);
  const t = db.prepare('SELECT * FROM teachers WHERE token=?').get(tToken);
  if (!t) return res.status(401).json({ error: '教师账号不存在，请检查姓名或密码' });
  res.json({ teacherToken: tToken, teacherName: t.name, classes: classListOf(tToken) });
});

// 老师查看名下班级
app.get('/api/teacher/classes', (req, res) => {
  const token = tokenFromReq(req);
  if (!token) return res.status(401).json({ error: '未授权' });
  res.json({ classes: classListOf(token) });
});

// 学生加入
app.post('/api/students/join', (req, res) => {
  const { code, name } = req.body || {};
  const cls = db.prepare('SELECT * FROM classes WHERE code=?').get(String(code || '').toUpperCase());
  if (!cls) return res.status(404).json({ error: '班级码不存在' });
  if (!name || !name.trim()) return res.status(400).json({ error: '请填写姓名' });
  const exist = db.prepare('SELECT * FROM students WHERE class_id=? AND name=?').get(cls.id, name.trim());
  if (exist) {
    res.json({ token: exist.token, name: exist.name, className: cls.name, code: cls.code });
  } else {
    const token = genToken();
    db.prepare('INSERT INTO students(class_id,name,token,created_at) VALUES(?,?,?,?)')
      .run(cls.id, name.trim(), token, Date.now());
    res.json({ token, name: name.trim(), className: cls.name, code: cls.code });
  }
});

// 评测配置（前端据此决定录音方式）
app.get('/api/assess/config', (req, res) => res.json({ cloud: tencent.isConfigured() }));

/* ----------------------------- 成绩榜（同班互见） ----------------------------- */
app.get('/api/classes/:code/board', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error) return res.status(m.error === 404 ? 404 : 401).json({ error: m.error === 404 ? '班级不存在' : '请先登录' });
  const cls = m.cls;
  const students = db.prepare('SELECT * FROM students WHERE class_id=?').all(cls.id);
  const board = students.map(s => {
    const sub = db.prepare('SELECT * FROM submissions WHERE student_id=? ORDER BY created_at DESC LIMIT 1').get(s.id);
    const valid = db.prepare('SELECT * FROM checkins WHERE student_id=? AND valid=1').all(s.id);
    const days = new Set(valid.map(c => c.date)).size;
    const minutes = Math.round(valid.reduce((a, c) => a + (c.duration_sec || 0), 0) / 60);
    return {
      studentId: s.id, name: s.name,
      lastScore: sub ? { score: sub.score, accuracy: sub.accuracy, fluency: sub.fluency, completeness: sub.completeness, source: sub.source } : null,
      checkinDays: days, checkinMinutes: minutes
    };
  });
  board.sort((a, b) => (b.lastScore ? b.lastScore.score : -1) - (a.lastScore ? a.lastScore.score : -1));
  res.json({ className: cls.name, code: cls.code, board });
});

/* ----------------------------- 语音作业（assignment） ----------------------------- */
// 老师创建作业（支持 短文朗读 passage / 单词朗读 words 两种类型）
app.post('/api/assignments', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.body.code, token);
  if (m.error) return res.status(401).json({ error: '未授权' });
  if (m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可设置作业' });
  const { title, refText, requiredMinutes, dueDate, type, words } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: '请填写作业标题' });
  const isWords = type === 'words';
  let wordsJson = null, text = (refText || '').trim();
  if (isWords) {
    const list = Array.isArray(words) ? words : [];
    const cleaned = list.map(w => ({ word: String(w.word || '').trim(), meaning: String(w.meaning || '').trim() })).filter(w => w.word);
    if (!cleaned.length) return res.status(400).json({ error: '请至少添加一个单词' });
    wordsJson = JSON.stringify(cleaned);
    text = cleaned.map(w => w.word).join(' ');
  } else if (!text) {
    return res.status(400).json({ error: '请填写朗读内容' });
  }
  const info = db.prepare('INSERT INTO assignments(class_id,title,ref_text,required_minutes,due_date,type,words_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(m.cls.id, title.trim(), text, Number(requiredMinutes) || 0, dueDate || null, isWords ? 'words' : 'passage', wordsJson, Date.now());
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 班级作业列表（学生请求时附带「是否已提交」「我的分数」）
app.get('/api/classes/:code/assignments', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error) return res.status(m.error === 404 ? 404 : 401).json({ error: '未授权' });
  const isStudent = m.member.role === 'student';
  const list = db.prepare('SELECT * FROM assignments WHERE class_id=? ORDER BY created_at DESC').all(m.cls.id)
    .map(a => {
      const item = { id: a.id, title: a.title, ref_text: a.ref_text, type: a.type, words_json: a.words_json, due_date: a.due_date, required_minutes: a.required_minutes, created_at: a.created_at };
      if (isStudent) {
        const sub = db.prepare('SELECT score FROM submissions WHERE assignment_id=? AND student_id=? ORDER BY created_at DESC LIMIT 1').get(a.id, m.member.student.id);
        item.submitted = !!sub;
        item.myScore = sub ? sub.score : null;
      }
      return item;
    });
  res.json({ assignments: list });
});

// 学生提交作业（录音 / 文本；支持 短文 与 单词 两种类型）
app.post('/api/assignments/:id/submit', async (req, res) => {
  const token = tokenFromReq(req);
  const assign = db.prepare('SELECT * FROM assignments WHERE id=?').get(Number(req.params.id));
  if (!assign) return res.status(404).json({ error: '作业不存在' });
  const cls = db.prepare('SELECT * FROM classes WHERE id=?').get(assign.class_id);
  const mm = resolveMember(cls.code, token);
  if (mm.error || mm.member.role !== 'student') return res.status(401).json({ error: '请以学生身份提交' });
  const { audioBase64, transcript, durationSec, wordResults } = req.body || {};
  let result;
  try {
    if (assign.type === 'words') {
      const list = JSON.parse(assign.words_json || '[]');
      const details = list.map(w => {
        const said = (wordResults && wordResults[w.word]) ? wordResults[w.word] : '';
        const r = localWordScore(w.word, said);
        return { word: w.word, meaning: w.meaning, said, score: r.score };
      });
      const avg = details.length ? Math.round(details.reduce((a, r) => a + r.score, 0) / details.length) : 0;
      result = { score: avg, accuracy: avg, fluency: 80, completeness: avg, source: 'local', wordDetails: details, transcript: details.map(d => `${d.word}:${d.said || '—'}`).join(' | ') };
    } else if (tencent.isConfigured() && audioBase64) {
      result = await tencent.assess(audioBase64, assign.ref_text, req.body.voiceFormat);
      result.source = 'tencent';
    } else {
      result = localScore(assign.ref_text, transcript || '');
      result.source = 'local';
    }
  } catch (e) {
    result = localScore(assign.ref_text, transcript || '');
    result.source = 'local';
  }
  db.prepare(`INSERT INTO submissions(assignment_id,student_id,score,accuracy,fluency,completeness,transcript,duration_sec,source,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(assign.id, mm.member.student.id, result.score, result.accuracy, result.fluency, result.completeness, result.transcript, Number(durationSec) || 0, result.source, Date.now());
  res.json({ ok: true, result });
});

// 老师查看某作业提交情况
app.get('/api/assignments/:id/submissions', (req, res) => {
  const token = tokenFromReq(req);
  const assign = db.prepare('SELECT * FROM assignments WHERE id=?').get(Number(req.params.id));
  if (!assign) return res.status(404).json({ error: '作业不存在' });
  const cls = db.prepare('SELECT * FROM classes WHERE id=?').get(assign.class_id);
  const m = resolveMember(cls.code, token);
  if (m.error || m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可查看' });
  const rows = db.prepare(`SELECT s.name, sub.score, sub.accuracy, sub.fluency, sub.completeness, sub.transcript, sub.duration_sec, sub.source, sub.created_at
    FROM submissions sub JOIN students s ON s.id=sub.student_id WHERE sub.assignment_id=? ORDER BY sub.created_at DESC`).all(assign.id);
  res.json({ title: assign.title, submissions: rows });
});

// 老师导出某作业成绩 Excel
app.get('/api/assignments/:id/export', (req, res) => {
  const token = tokenFromReq(req);
  const assign = db.prepare('SELECT * FROM assignments WHERE id=?').get(Number(req.params.id));
  if (!assign) return res.status(404).json({ error: '作业不存在' });
  const cls = db.prepare('SELECT * FROM classes WHERE id=?').get(assign.class_id);
  const m = resolveMember(cls.code, token);
  if (m.error || m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可导出' });
  const rows = db.prepare(`SELECT s.name, sub.score, sub.accuracy, sub.fluency, sub.completeness, sub.transcript, sub.duration_sec, sub.source, sub.created_at
    FROM submissions sub JOIN students s ON s.id=sub.student_id WHERE sub.assignment_id=?`).all(assign.id);
  const aoa = [['姓名', '总分', '准确度', '流利度', '完整度', '朗读内容', '时长(秒)', '评测方式', '提交时间']];
  rows.forEach(r => aoa.push([r.name, r.score, r.accuracy + '%', r.fluency + '%', r.completeness + '%', r.transcript, r.duration_sec, r.source, new Date(r.created_at).toLocaleString('zh-CN')]));
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(aoa), '作业成绩');
  const out = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `作业成绩_${assign.title}_${todayStr()}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(out);
});

/* ----------------------------- 每日打卡（≥10 分钟） ----------------------------- */
const MIN = 600;
app.post('/api/checkins/start', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.body.code, token);
  if (m.error) return res.status(m.error === 404 ? 404 : 401).json({ error: '未授权' });
  const info = db.prepare('INSERT INTO checkins(class_id,student_id,started_at,date,valid) VALUES(?,?,?,?,0)')
    .run(m.cls.id, m.member.student.id, Date.now(), todayStr());
  res.json({ checkinId: info.lastInsertRowid, startedAt: Date.now() });
});
app.post('/api/checkins/end', (req, res) => {
  const token = tokenFromReq(req);
  const { code, checkinId } = req.body || {};
  const m = resolveMember(code, token);
  if (m.error) return res.status(401).json({ error: '未授权' });
  const rec = db.prepare('SELECT * FROM checkins WHERE id=? AND student_id=?').get(Number(checkinId), m.member.student.id);
  if (!rec) return res.status(404).json({ error: '记录不存在' });
  if (rec.ended_at) return res.status(400).json({ error: '已结束' });
  const durationSec = Math.round((Date.now() - rec.started_at) / 1000);
  if (durationSec < MIN) {
    db.prepare('DELETE FROM checkins WHERE id=?').run(rec.id);
    return res.status(400).json({ error: '打卡不足 10 分钟，本次不计入', durationSec });
  }
  db.prepare('UPDATE checkins SET ended_at=?, duration_sec=?, valid=1 WHERE id=?').run(Date.now(), durationSec, rec.id);
  res.json({ ok: true, durationSec, date: rec.date });
});
app.get('/api/classes/:code/checkins', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error) return res.status(m.error === 404 ? 404 : 401).json({ error: '未授权' });
  const nameMap = {};
  db.prepare('SELECT * FROM students WHERE class_id=?').all(m.cls.id).forEach(s => (nameMap[s.id] = s.name));
  const list = db.prepare('SELECT * FROM checkins WHERE class_id=? AND ended_at IS NOT NULL ORDER BY started_at DESC').all(m.cls.id)
    .map(c => ({ name: nameMap[c.student_id] || '未知', date: c.date, startedAt: c.started_at, endedAt: c.ended_at, durationSec: c.duration_sec, valid: !!c.valid }));
  res.json({ checkins: list });
});
// 导出班级打卡 Excel（明细 + 汇总）
app.get('/api/classes/:code/export', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error) return res.status(m.error === 404 ? 404 : 401).json({ error: '未授权' });
  const students = db.prepare('SELECT * FROM students WHERE class_id=?').all(m.cls.id);
  const nameMap = {};
  students.forEach(s => (nameMap[s.id] = s.name));
  const records = db.prepare('SELECT * FROM checkins WHERE class_id=? AND ended_at IS NOT NULL').all(m.cls.id)
    .map(c => ({ name: nameMap[c.student_id] || '未知', date: c.date, start: new Date(c.started_at).toLocaleString('zh-CN'), end: new Date(c.ended_at).toLocaleString('zh-CN'), min: Math.round(c.duration_sec / 60), status: c.valid ? '达标' : '未达标' }));
  const detail = [['姓名', '日期', '开始', '结束', '时长(分)', '状态'], ...records.map(r => [r.name, r.date, r.start, r.end, r.min, r.status])];
  const sum = {};
  students.forEach(s => (sum[s.name] = { days: new Set(), min: 0, n: 0 }));
  records.forEach(r => { const e = sum[r.name]; if (e) { e.days.add(r.date); e.min += r.min; e.n++; } });
  const summary = [['姓名', '打卡次数', '达标天数', '累计分钟'], ...students.map(s => { const e = sum[s.name]; return [s.name, e.n, e.days.size, e.min]; })];
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(detail), '打卡明细');
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(summary), '打卡汇总');
  const out = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = `打卡记录_${m.cls.name}_${todayStr()}.xlsx`;
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fname)}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(out);
});

/* ----------------------------- 点名 ----------------------------- */
app.get('/api/classes/:code/rollcall', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error) return res.status(m.error === 404 ? 404 : 401).json({ error: '未授权' });
  let rc = db.prepare('SELECT * FROM rollcall WHERE class_id=?').get(m.cls.id);
  if (!rc) rc = { method: 'random', groups: '{}', seq_index: 0 };
  res.json({ method: rc.method, groups: JSON.parse(rc.groups || '{}') });
});
app.put('/api/classes/:code/rollcall', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error || m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可设置' });
  const { method, groups } = req.body || {};
  const groupsJson = JSON.stringify(groups || {});
  const exist = db.prepare('SELECT * FROM rollcall WHERE class_id=?').get(m.cls.id);
  if (exist) db.prepare('UPDATE rollcall SET method=?, groups=?, updated_at=? WHERE class_id=?').run(method || 'random', groupsJson, Date.now(), m.cls.id);
  else db.prepare('INSERT INTO rollcall(class_id,method,groups,seq_index,updated_at) VALUES(?,?,?,0,?)').run(m.cls.id, method || 'random', groupsJson, Date.now());
  res.json({ ok: true });
});
app.post('/api/classes/:code/rollcall/pick', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error || m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可点名' });
  const students = db.prepare('SELECT * FROM students WHERE class_id=?').all(m.cls.id);
  if (!students.length) return res.status(400).json({ error: '班级还没有学生' });
  const rc = db.prepare('SELECT * FROM rollcall WHERE class_id=?').get(m.cls.id) || { method: 'random', groups: '{}', seq_index: 0 };
  const groups = JSON.parse(rc.groups || '{}');
  let pool = students;
  const { group } = req.body || {};
  if (rc.method === 'group') {
    if (!group || !groups[group]) return res.status(400).json({ error: '请选择有效的小组' });
    const names = groups[group];
    pool = students.filter(s => names.includes(s.name));
    if (!pool.length) return res.status(400).json({ error: '该小组没有匹配到的学生，请检查分组中的姓名是否与班级学生一致' });
  }
  let picked;
  if (rc.method === 'sequence') {
    const idx = rc.seq_index % students.length;
    picked = students[idx];
    db.prepare('UPDATE rollcall SET seq_index=? WHERE class_id=?').run(idx + 1, m.cls.id);
  } else {
    picked = pool[Math.floor(Math.random() * pool.length)];
  }
  res.json({ name: picked.name });
});

/* ----------------------------- 单词抢答游戏 ----------------------------- */
app.post('/api/words', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.body.code, token);
  if (m.error || m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可添加单词' });
  const { word, meaning } = req.body || {};
  if (!word || !word.trim()) return res.status(400).json({ error: '请填写单词' });
  db.prepare('INSERT INTO words(class_id,word,meaning,created_at) VALUES(?,?,?,?)').run(m.cls.id, word.trim(), (meaning || '').trim(), Date.now());
  res.json({ ok: true });
});
app.get('/api/classes/:code/words', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error) return res.status(m.error === 404 ? 404 : 401).json({ error: '未授权' });
  const words = db.prepare('SELECT * FROM words WHERE class_id=? ORDER BY created_at DESC').all(m.cls.id);
  res.json({ words });
});
app.delete('/api/words/:id', (req, res) => {
  const token = tokenFromReq(req);
  const w = db.prepare('SELECT * FROM words WHERE id=?').get(Number(req.params.id));
  if (!w) return res.status(404).json({ error: '不存在' });
  const cls = db.prepare('SELECT * FROM classes WHERE id=?').get(w.class_id);
  const m = resolveMember(cls.code, token);
  if (m.error || m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可删除' });
  db.prepare('DELETE FROM words WHERE id=?').run(w.id);
  res.json({ ok: true });
});
// 抽取一个单词
app.post('/api/classes/:code/game/round', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error || m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可开始' });
  const words = db.prepare('SELECT * FROM words WHERE class_id=?').all(m.cls.id);
  if (!words.length) return res.status(400).json({ error: '单词库为空，请先添加单词' });
  const w = words[Math.floor(Math.random() * words.length)];
  res.json({ word: w.word, meaning: w.meaning, wordId: w.id });
});
// 记分
app.post('/api/classes/:code/game/award', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error || m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可记分' });
  const { studentName, correct } = req.body || {};
  const st = db.prepare('SELECT * FROM students WHERE class_id=? AND name=?').get(m.cls.id, studentName);
  if (!st) return res.status(404).json({ error: '学生不存在' });
  const delta = correct ? 1 : 0;
  db.prepare('INSERT INTO game_scores(class_id,student_id,points) VALUES(?,?,?) ON CONFLICT(class_id,student_id) DO UPDATE SET points=points+?')
    .run(m.cls.id, st.id, delta, delta);
  const scores = db.prepare('SELECT s.name, COALESCE(g.points,0) as points FROM students s LEFT JOIN game_scores g ON g.class_id=s.class_id AND g.student_id=s.id WHERE s.class_id=? ORDER BY points DESC').all(m.cls.id);
  res.json({ ok: true, scores });
});
app.get('/api/classes/:code/game/scores', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error) return res.status(m.error === 404 ? 404 : 401).json({ error: '未授权' });
  const scores = db.prepare('SELECT s.name, COALESCE(g.points,0) as points FROM students s LEFT JOIN game_scores g ON g.class_id=s.class_id AND g.student_id=s.id WHERE s.class_id=? ORDER BY points DESC').all(m.cls.id);
  res.json({ scores });
});

/* ----------------------------- 删除班级（教师） ----------------------------- */
app.delete('/api/classes/:code', (req, res) => {
  const token = tokenFromReq(req);
  const m = resolveMember(req.params.code, token);
  if (m.error) return res.status(401).json({ error: '未授权' });
  if (m.member.role !== 'teacher') return res.status(403).json({ error: '仅教师可删除班级' });
  const cid = m.cls.id;
  db.prepare('DELETE FROM game_scores WHERE class_id=?').run(cid);
  db.prepare('DELETE FROM words WHERE class_id=?').run(cid);
  db.prepare('DELETE FROM rollcall WHERE class_id=?').run(cid);
  db.prepare('DELETE FROM checkins WHERE class_id=?').run(cid);
  db.prepare('DELETE FROM submissions WHERE assignment_id IN (SELECT id FROM assignments WHERE class_id=?)').run(cid);
  db.prepare('DELETE FROM assignments WHERE class_id=?').run(cid);
  db.prepare('DELETE FROM students WHERE class_id=?').run(cid);
  db.prepare('DELETE FROM classes WHERE id=?').run(cid);
  delete rooms[String(req.params.code).toUpperCase()];
  res.json({ ok: true });
});

/* ----------------------------- 实时抢答（WebSocket） ----------------------------- */
const rooms = {}; // code(大写) -> room
function getRoom(code) {
  code = String(code).toUpperCase();
  if (!rooms[code]) rooms[code] = { mode: null, word: null, roundId: 0, buzzOrder: [], status: 'idle', target: 'individual', groups: {}, scores: {} };
  return rooms[code];
}
const wsClients = new Map(); // ws -> {code, role, name}
function loadScores(classId) {
  const rows = db.prepare('SELECT s.name, COALESCE(g.points,0) as points FROM students s LEFT JOIN game_scores g ON g.class_id=s.class_id AND g.student_id=s.id WHERE s.class_id=?').all(classId);
  const map = {}; rows.forEach(r => (map[r.name] = r.points)); return map;
}
function publicRoom(room) {
  return { mode: room.mode, word: room.word, roundId: room.roundId, buzzOrder: room.buzzOrder, status: room.status, target: room.target, groups: room.groups, scores: room.scores };
}
function broadcast(code, obj) {
  const c = String(code).toUpperCase();
  for (const [ws, meta] of wsClients) if (meta.code === c && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function wsSend(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function wsErr(ws, error) { wsSend(ws, { type: 'error', error }); }

function attachWS(server) {
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    wsClients.set(ws, {});
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      const meta = wsClients.get(ws) || {};
      if (msg.type === 'join') {
        const m = resolveMember(msg.code, msg.token);
        if (m.error) return wsErr(ws, '身份无效，请重新进入课堂');
        const code = m.cls.code;
        const name = m.member.role === 'teacher' ? 'teacher' : (m.member.student ? m.member.student.name : '');
        wsClients.set(ws, { code, role: m.member.role, name });
        const room = getRoom(code);
        const rc = db.prepare('SELECT groups FROM rollcall WHERE class_id=?').get(m.cls.id);
        room.groups = JSON.parse((rc && rc.groups) || '{}');
        room.scores = loadScores(m.cls.id);
        return wsSend(ws, { type: 'state', room: publicRoom(room) });
      }
      if (!meta.role) return wsErr(ws, '请先加入房间');
      const room = getRoom(meta.code);
      if (msg.type === 'buzz:start') {
        if (meta.role !== 'teacher') return wsErr(ws, '仅教师可开始抢答');
        room.word = msg.word || null;
        room.roundId = (room.roundId || 0) + 1;
        room.buzzOrder = [];
        room.status = 'waiting';
        room.mode = 'buzz';
        return broadcast(meta.code, { type: 'state', room: publicRoom(room) });
      }
      if (msg.type === 'buzz') {
        if (meta.role !== 'student') return;
        if (room.status !== 'waiting') return;
        if (room.buzzOrder.find(b => b.name === meta.name)) return;
        room.buzzOrder.push({ name: meta.name, ts: Date.now() });
        return broadcast(meta.code, { type: 'state', room: publicRoom(room) });
      }
      if (msg.type === 'buzz:award') {
        if (meta.role !== 'teacher') return wsErr(ws, '仅教师可记分');
        const cls = db.prepare('SELECT * FROM classes WHERE code=?').get(meta.code);
        const st = db.prepare('SELECT * FROM students WHERE class_id=? AND name=?').get(cls.id, msg.name);
        if (!st) return wsErr(ws, '学生不存在');
        const delta = msg.correct ? 1 : 0;
        db.prepare('INSERT INTO game_scores(class_id,student_id,points) VALUES(?,?,?) ON CONFLICT(class_id,student_id) DO UPDATE SET points=points+?')
          .run(cls.id, st.id, delta, delta);
        room.scores = loadScores(cls.id);
        return broadcast(meta.code, { type: 'state', room: publicRoom(room) });
      }
      if (msg.type === 'buzz:setTarget') {
        if (meta.role !== 'teacher') return wsErr(ws, '仅教师可设置');
        room.target = msg.target === 'group' ? 'group' : 'individual';
        return broadcast(meta.code, { type: 'state', room: publicRoom(room) });
      }
      if (msg.type === 'buzz:reset') {
        if (meta.role !== 'teacher') return wsErr(ws, '仅教师可重置');
        room.buzzOrder = []; room.status = 'idle'; room.word = null; room.mode = null;
        return broadcast(meta.code, { type: 'state', room: publicRoom(room) });
      }
    });
    ws.on('close', () => wsClients.delete(ws));
  });
}

/* ----------------------------- SPA 兜底 ----------------------------- */
app.get('*', (req, res) => res.sendFile(require('path').join(PUBLIC_DIR, 'index.html')));

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
attachWS(server);
server.listen(PORT, () => console.log(`✅ 英语口语评测网站已启动： http://localhost:${PORT} (WebSocket 已启用)`));
