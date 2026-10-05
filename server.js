require('dotenv').config();
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'questions.json');
const MONGODB_URI = process.env.MONGODB_URI || '';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- storage: MongoDB when MONGODB_URI is set, else local JSON ----------
let mongoCol = null; // { questions, attempts, solutions } collections
let mongo = null;

async function getStore() {
  if (mongoCol) return 'mongo';
  if (MONGODB_URI && !mongo) {
    try {
      const { MongoClient } = require('mongodb');
      mongo = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
      await mongo.connect();
      const db = mongo.db('oa_arena');
      mongoCol = { questions: db.collection('questions'), attempts: db.collection('attempts'), solutions: db.collection('solutions') };
      console.log('Connected to MongoDB');
      return 'mongo';
    } catch (e) {
      console.error('MongoDB connection failed, falling back to JSON file:', e.message);
      mongo = null;
    }
  }
  return 'json';
}

function loadJSON() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { questions: [], attempts: [], solutions: [] }; }
}
function saveJSON(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const q = {
  list: async () => (await getStore()) === 'mongo' ? mongoCol.questions.find({}).toArray() : loadJSON().questions,
  get: async id => (await getStore()) === 'mongo' ? mongoCol.questions.findOne({ id }) : loadJSON().questions.find(q => q.id === id),
  add: async question => { if ((await getStore()) === 'mongo') await mongoCol.questions.insertOne(question); else { const db = loadJSON(); db.questions.push(question); saveJSON(db); } },
  remove: async id => { if ((await getStore()) === 'mongo') return (await mongoCol.questions.deleteOne({ id })).deletedCount > 0; const db = loadJSON(); const before = db.questions.length; db.questions = db.questions.filter(q => q.id !== id); saveJSON(db); return db.questions.length !== before; },
  attempts: async () => (await getStore()) === 'mongo' ? mongoCol.attempts.find({}).toArray() : loadJSON().attempts,
  addAttempt: async a => { if ((await getStore()) === 'mongo') await mongoCol.attempts.insertOne(a); else { const db = loadJSON(); db.attempts.push(a); saveJSON(db); } },
  getSolution: async (questionId, language) => (await getStore()) === 'mongo' ? mongoCol.solutions.findOne({ questionId, language }) : (loadJSON().solutions || []).find(s => s.questionId === questionId && s.language === language),
  saveSolution: async s => { if ((await getStore()) === 'mongo') { await mongoCol.solutions.updateOne({ questionId: s.questionId, language: s.language }, { $set: s }, { upsert: true }); } else { const db = loadJSON(); db.solutions = db.solutions || []; const i = db.solutions.findIndex(x => x.questionId === s.questionId && x.language === s.language); if (i >= 0) db.solutions[i] = s; else db.solutions.push(s); saveJSON(db); } },
};

// ---------- code execution ----------
const CACHE_DIR = path.join(os.tmpdir(), 'oa-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });
const COMPILED = new Map(); // hash -> binary path

function spawn(cmd, args, stdin, timeoutMs) {
  return new Promise(resolve => {
    const p = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = /TIMEOUT/i.test(String(err.message || err.killed)) || err.signal === 'SIGTERM' ? 'timeout' : (typeof err.code === 'number' ? err.code : 1);
      resolve({ stdout: (stdout || '').slice(0, 20000), stderr: (stderr || '').slice(0, 20000), code });
    });
    if (p.stdin) { p.stdin.write(stdin || ''); p.stdin.end(); }
  });
}

// Compile a C++ program once, cache the binary by code hash (huge speedup on re-submits)
async function compileCppCached(fullCode) {
  const hash = crypto.createHash('sha1').update(fullCode).digest('hex');
  if (COMPILED.has(hash) && fs.existsSync(COMPILED.get(hash))) return { bin: COMPILED.get(hash) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-'));
  const src = path.join(dir, 'main.cpp');
  const bin = path.join(CACHE_DIR, hash);
  fs.writeFileSync(src, fullCode);
  const compile = await spawn('g++', ['-O2', '-o', bin, src], '', 30000);
  fs.rmSync(dir, { recursive: true, force: true });
  if (compile.code !== 0) return { compileError: compile.stderr };
  COMPILED.set(hash, bin);
  return { bin };
}

function assemble(language, code, question) {
  const driver = question?.driverCode?.[language];
  if (question && !driver) throw new Error(`Language "${language}" is not configured for this question`);
  if (!question) return code;
  if (language === 'cpp') return `#include <bits/stdc++.h>\n\n` + code + driver;
  return code + driver;
}

async function executeOnce(language, fullCode, stdin, cppBin) {
  if (language === 'cpp') return spawn(cppBin, [], stdin, 8000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oa-'));
  try {
    if (language === 'python') { const f = path.join(dir, 'm.py'); fs.writeFileSync(f, fullCode); return await spawn('python3', [f], stdin, 8000); }
    if (language === 'javascript') { const f = path.join(dir, 'm.js'); fs.writeFileSync(f, fullCode); return await spawn('node', [f], stdin, 8000); }
    return { stdout: '', stderr: 'Unsupported language', code: 1 };
  } finally { setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 30000).unref(); }
}

app.post('/api/run', async (req, res) => {
  const { language, code, stdin, questionId, mode = 'run' } = req.body || {};
  if (!language || !code) return res.status(400).json({ error: 'language and code required' });

  const question = questionId ? await q.get(questionId) : null;
  if (questionId && !question) return res.status(404).json({ error: 'Question not found' });

  let fullCode, cppBin = null;
  try {
    fullCode = assemble(language, code, question);
    if (language === 'cpp') {
      const compiled = await compileCppCached(fullCode);
      if (compiled.compileError) return res.json({ results: [{ compileError: compiled.compileError }], allPassed: false });
      cppBin = compiled.bin;
    }
  } catch (e) { return res.status(400).json({ error: e.message }); }

  const normalize = s => (s || '').trim().replace(/\r\n/g, '\n');
  let tests;
  if (mode === 'submit' && question?.tests?.length) {
    tests = question.tests;
  } else if (question?.tests?.length) {
    tests = [question.tests[0]];
  } else {
    tests = [{ input: stdin || '', output: question?.sampleOutput || null }];
  }

  // run tests in parallel for speed
  const results = await Promise.all(tests.map(async t => {
    const out = await executeOnce(language, fullCode, t.input, cppBin);
    const expected = t.output != null ? normalize(t.output) : null;
    const got = normalize(out.code === 'timeout' ? '' : out.stdout);
    return {
      passed: out.code !== 'timeout' && out.code === 0 && (expected === null || got === expected),
      expected, got: out.code === 'timeout' ? 'Time limit exceeded' : normalize(out.stdout),
      stderr: out.stderr, code: out.code,
      input: t.input,
    };
  }));

  res.json({ results, allPassed: results.every(r => r.passed) });
});

// ---------- questions API ----------
app.get('/api/companies', async (req, res) => {
  const all = await q.list();
  const map = new Map();
  for (const question of all) map.set(question.company, (map.get(question.company) || 0) + 1);
  res.json([...map.entries()].map(([company, count]) => ({ company, count })).sort((a, b) => a.company.localeCompare(b.company)));
});

app.get('/api/questions', async (req, res) => {
  const { company, difficulty, q: search } = req.query;
  let list = await q.list();
  const attempts = await q.attempts();
  const stats = new Map();
  for (const a of attempts) {
    const s = stats.get(a.questionId) || { accepted: 0, total: 0 };
    s.total++; if (a.verdict === 'Accepted') s.accepted++;
    stats.set(a.questionId, s);
  }
  if (company) list = list.filter(x => x.company.toLowerCase() === String(company).toLowerCase());
  if (difficulty) list = list.filter(x => x.difficulty === difficulty);
  if (search) {
    const s = String(search).toLowerCase();
    list = list.filter(x => x.title.toLowerCase().includes(s) || (x.tags || []).some(t => t.toLowerCase().includes(s)) || x.company.toLowerCase().includes(s));
  }
  res.json(list.map(({ description, driverCode, starterCode, tests, ...rest }) => {
    const s = stats.get(rest.id);
    return { ...rest, acceptance: s && s.total ? Math.round(100 * s.accepted / s.total) + '%' : '—', languages: Object.keys(starterCode || {}).filter(k => starterCode[k]), testCount: (tests || []).length };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get('/api/questions/:id', async (req, res) => {
  const question = await q.get(req.params.id);
  if (!question) return res.status(404).json({ error: 'Not found' });
  res.json(question);
});

app.post('/api/questions', async (req, res) => {
  const b = req.body || {};
  // parse tests either as array or as a human-friendly text format
  let tests = Array.isArray(b.tests) ? b.tests : [];
  if (!tests.length && b.testsText) {
    tests = String(b.testsText).split(/^-{3,}\s*$/m).map(block => {
      const [input, ...rest] = block.split(/^===\s*$/m);
      return { input: (input || '').trim() + '\n', output: rest.join('===\n').trim() + '\n' };
    }).filter(t => t.input.trim() && t.output.trim());
  }
  if (!b.title || !b.company || !b.description || !tests.length) {
    return res.status(400).json({ error: 'title, company, description and at least one test case are required' });
  }
  const question = {
    id: crypto.randomUUID(),
    title: String(b.title).slice(0, 200),
    company: String(b.company).slice(0, 100),
    difficulty: ['Easy', 'Medium', 'Hard'].includes(b.difficulty) ? b.difficulty : 'Medium',
    tags: Array.isArray(b.tags) ? b.tags.slice(0, 10).map(t => String(t).slice(0, 30)) : [],
    description: String(b.description).slice(0, 20000),
    inputFormat: String(b.inputFormat || '').slice(0, 5000),
    outputFormat: String(b.outputFormat || '').slice(0, 5000),
    year: String(b.year || '').slice(0, 20),
    role: String(b.role || '').slice(0, 100),
    uploadedBy: String(b.uploadedBy || 'anonymous').slice(0, 50),
    tests: tests.slice(0, 20).map(t => ({ input: String(t.input).slice(0, 5000), output: String(t.output).slice(0, 5000) })),
    starterCode: b.starterCode && typeof b.starterCode === 'object' ? {
      python: String(b.starterCode.python || '').slice(0, 10000),
      cpp: String(b.starterCode.cpp || '').slice(0, 10000),
      javascript: String(b.starterCode.javascript || '').slice(0, 10000),
    } : {},
    driverCode: b.driverCode && typeof b.driverCode === 'object' ? {
      python: String(b.driverCode.python || '').slice(0, 10000),
      cpp: String(b.driverCode.cpp || '').slice(0, 10000),
      javascript: String(b.driverCode.javascript || '').slice(0, 10000),
    } : {},
    createdAt: new Date().toISOString(),
  };
  await q.add(question);
  res.status(201).json(question);
});

app.delete('/api/questions/:id', async (req, res) => {
  const ok = await q.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.post('/api/questions/:id/attempts', async (req, res) => {
  const question = await q.get(req.params.id);
  if (!question) return res.status(404).json({ error: 'Not found' });
  await q.addAttempt({
    questionId: question.id,
    language: String(req.body?.language || '').slice(0, 30),
    verdict: String(req.body?.verdict || '').slice(0, 30),
    by: String(req.body?.by || 'anonymous').slice(0, 50),
    at: new Date().toISOString(),
  });
  res.json({ ok: true });
});

// saved solutions per question+language (Ctrl+S)
app.get('/api/questions/:id/solution/:language', async (req, res) => {
  const s = await q.getSolution(req.params.id, req.params.language);
  res.json(s || {});
});
app.post('/api/questions/:id/solution', async (req, res) => {
  const code = req.body?.code;
  if (typeof code !== 'string') return res.status(400).json({ error: 'code required' });
  await q.saveSolution({ questionId: req.params.id, language: String(req.body.language || 'python').slice(0, 30), code: code.slice(0, 50000), at: new Date().toISOString() });
  res.json({ ok: true });
});

// ---------- AI: extract question from image ----------
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.8-27b:free';

const AI_PROMPT = `You are helping build a coding practice site. The attached image is a screenshot of an online assessment (OA) coding question from a company.
Extract the question and respond with STRICT JSON only (no markdown, no code fences) with these exact fields:
{
  "title": string,
  "company": string (e.g. "Amazon", guess "Unknown" if not visible),
  "difficulty": "Easy" | "Medium" | "Hard",
  "tags": string[] (topics like "arrays", "dp", "graphs"),
  "description": string (full problem statement, keep examples),
  "inputFormat": string,
  "outputFormat": string,
  "tests": [{"input": string, "output": string}] (at least 2 test cases; derive expected outputs by reading the statement carefully),
  "starterCode": {"python": string, "cpp": string, "javascript": string} (LeetCode-style; for cpp use: using namespace std; and a 'class Solution { public: ... };' signature; empty string if you cannot infer one),
  "driverCode": {"python": string, "cpp": string, "javascript": string} (hidden driver that reads stdin, calls the solution function, and prints the answer; must match the starter code's signature; for cpp do NOT include #include lines, they are added automatically)
}`;

app.post('/api/ai/extract', async (req, res) => {
  if (!OPENROUTER_API_KEY) return res.status(400).json({ error: 'Set OPENROUTER_API_KEY env var first' });
  const images = Array.isArray(req.body?.images) ? req.body.images.slice(0, 4) : [];
  const textIn = typeof req.body?.text === 'string' ? req.body.text.slice(0, 20000) : '';
  if (!images.length && !textIn.trim()) return res.status(400).json({ error: 'Provide an image or question text' });
  try {
    const content = textIn.trim()
      ? [{ type: 'text', text: AI_PROMPT + '\n\nThe question text:\n' + textIn }]
      : [
          { type: 'text', text: AI_PROMPT },
          ...images.map(img => ({ type: 'image_url', image_url: { url: img.startsWith('data:') ? img : `data:image/png;base64,${img}` } })),
        ];
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'http://localhost:3000' },
      body: JSON.stringify({ model: OPENROUTER_MODEL, messages: [{ role: 'user', content }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error?.message || 'OpenRouter error' });
    const text = data.choices?.[0]?.message?.content || '';
    const json = JSON.parse(text.replace(/^```json\s*|```$/g, '').trim());
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: 'AI extraction failed: ' + e.message });
  }
});

getStore().finally(() => app.listen(PORT, () => console.log(`OA Arena running at http://localhost:${PORT}`)));
