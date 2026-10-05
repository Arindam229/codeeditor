const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'questions.json');

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- local code execution ----------
const os = require('os');
const { execFile } = require('child_process');

function run(cmd, args, stdin, timeoutMs = 10000) {
  return new Promise(resolve => {
    const p = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout: (stdout || '').slice(0, 20000), stderr: (stderr || '').slice(0, 20000), code: err ? (err.code === 'ERR_CHILD_PROCESS_TIMEOUT' || String(err.message).includes('TIMEOUT') ? 'timeout' : err.code ?? 1) : 0 });
    });
    if (p.stdin) { p.stdin.write(stdin || ''); p.stdin.end(); }
  });
}

app.post('/api/run', async (req, res) => {
  const { language, code, stdin, questionId } = req.body || {};
  if (!language || !code) return res.status(400).json({ error: 'language and code required' });

  // Assemble full program: user code (function/class) + hidden driver from the question
  let fullCode = code;
  if (questionId) {
    const db = loadDB();
    const q = db.questions.find(q => q.id === questionId);
    if (!q) return res.status(404).json({ error: 'Question not found' });
    const driver = q.driverCode?.[language];
    if (!driver) return res.status(400).json({ error: `Language "${language}" is not configured for this question` });
    if (language === 'cpp') {
      fullCode = `#include <bits/stdc++.h>\nusing namespace std;\n\n` + code + driver;
    } else {
      fullCode = code + driver;
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-'));
  try {
    if (language === 'python') {
      const f = path.join(dir, 'main.py');
      fs.writeFileSync(f, fullCode);
      return res.json(await run('python3', [f], stdin));
    }
    if (language === 'javascript') {
      const f = path.join(dir, 'main.js');
      fs.writeFileSync(f, fullCode);
      return res.json(await run('node', [f], stdin));
    }
    if (language === 'cpp') {
      const src = path.join(dir, 'main.cpp');
      const bin = path.join(dir, 'main');
      fs.writeFileSync(src, fullCode);
      const compile = await run('g++', ['-O2', '-o', bin, src], '', 30000);
      if (compile.code !== 0) return res.json({ compileError: compile.stderr, stdout: '', code: 1 });
      return res.json(await run(bin, [], stdin));
    }
    res.status(400).json({ error: 'Supported languages: python, cpp, javascript' });
  } finally {
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 60000).unref?.();
  }
});

// ---------- tiny JSON "database" ----------
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { questions: [], attempts: [] };
  }
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- API ----------
// List companies with counts
app.get('/api/companies', (req, res) => {
  const db = loadDB();
  const map = new Map();
  for (const q of db.questions) map.set(q.company, (map.get(q.company) || 0) + 1);
  res.json([...map.entries()].map(([company, count]) => ({ company, count })).sort((a, b) => a.company.localeCompare(b.company)));
});

// List / filter questions (without description payload for speed)
app.get('/api/questions', (req, res) => {
  const db = loadDB();
  const { company, difficulty, q } = req.query;
  let list = db.questions;
  if (company) list = list.filter(q => q.company.toLowerCase() === String(company).toLowerCase());
  if (difficulty) list = list.filter(q => q.difficulty === difficulty);
  if (q) {
    const s = String(q).toLowerCase();
    list = list.filter(q =>
      q.title.toLowerCase().includes(s) ||
      (q.tags || []).some(t => t.toLowerCase().includes(s)) ||
      q.company.toLowerCase().includes(s));
  }
  const stats = new Map();
  for (const a of db.attempts) {
    const s = stats.get(a.questionId) || { accepted: 0, total: 0 };
    s.total++;
    if (a.verdict === 'Accepted') s.accepted++;
    stats.set(a.questionId, s);
  }
  res.json(list.map(({ description, sampleInput, sampleOutput, driverCode, starterCode, ...rest }) => {
    const s = stats.get(rest.id);
    return { ...rest, acceptance: s && s.total ? Math.round(100 * s.accepted / s.total) + '%' : '—', languages: Object.keys(starterCode || {}).filter(k => starterCode[k]) };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

// Full question
app.get('/api/questions/:id', (req, res) => {
  const db = loadDB();
  const q = db.questions.find(q => q.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  res.json(q);
});

// Upload a new question
app.post('/api/questions', (req, res) => {
  const { title, company, difficulty, tags, description, inputFormat, outputFormat, sampleInput, sampleOutput, year, role, uploadedBy } = req.body || {};
  if (!title || !company || !description || !sampleInput || !sampleOutput) {
    return res.status(400).json({ error: 'title, company, description, sampleInput and sampleOutput are required' });
  }
  const db = loadDB();
  const q = {
    id: crypto.randomUUID(),
    title: String(title).slice(0, 200),
    company: String(company).slice(0, 100),
    difficulty: ['Easy', 'Medium', 'Hard'].includes(difficulty) ? difficulty : 'Medium',
    tags: Array.isArray(tags) ? tags.slice(0, 10).map(t => String(t).slice(0, 30)) : [],
    description: String(description).slice(0, 20000),
    inputFormat: String(inputFormat || '').slice(0, 5000),
    outputFormat: String(outputFormat || '').slice(0, 5000),
    sampleInput: String(sampleInput).slice(0, 5000),
    sampleOutput: String(sampleOutput).slice(0, 5000),
    starterCode: req.body?.starterCode && typeof req.body.starterCode === 'object' ? {
      python: String(req.body.starterCode.python || '').slice(0, 10000),
      cpp: String(req.body.starterCode.cpp || '').slice(0, 10000),
      javascript: String(req.body.starterCode.javascript || '').slice(0, 10000),
    } : {},
    driverCode: req.body?.driverCode && typeof req.body.driverCode === 'object' ? {
      python: String(req.body.driverCode.python || '').slice(0, 10000),
      cpp: String(req.body.driverCode.cpp || '').slice(0, 10000),
      javascript: String(req.body.driverCode.javascript || '').slice(0, 10000),
    } : {},
    year: String(year || '').slice(0, 20),
    role: String(role || '').slice(0, 100),
    uploadedBy: String(uploadedBy || 'anonymous').slice(0, 50),
    createdAt: new Date().toISOString(),
  };
  db.questions.push(q);
  saveDB(db);
  res.status(201).json(q);
});

// Delete a question
app.delete('/api/questions/:id', (req, res) => {
  const db = loadDB();
  const before = db.questions.length;
  db.questions = db.questions.filter(q => q.id !== req.params.id);
  if (db.questions.length === before) return res.status(404).json({ error: 'Not found' });
  saveDB(db);
  res.json({ ok: true });
});

// Log a submission attempt
app.post('/api/questions/:id/attempts', (req, res) => {
  const db = loadDB();
  const q = db.questions.find(q => q.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  db.attempts.push({
    questionId: q.id,
    language: String(req.body?.language || '').slice(0, 30),
    verdict: String(req.body?.verdict || '').slice(0, 30),
    by: String(req.body?.by || 'anonymous').slice(0, 50),
    at: new Date().toISOString(),
  });
  saveDB(db);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`OA Arena running at http://localhost:${PORT}`));
