// ---------- view switching ----------
const views = ['browse', 'upload', 'solve'];
function show(view) {
  views.forEach(v => document.getElementById('view-' + v).hidden = v !== view);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'browse') loadQuestions();
}
document.querySelectorAll('nav button').forEach(b => b.onclick = () => show(b.dataset.view));

// ---------- helpers ----------
async function api(path, opts) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  return r.json();
}
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------- browse ----------
async function loadQuestions() {
  const company = document.getElementById('companyFilter').value;
  const difficulty = document.getElementById('diffFilter').value;
  const q = document.getElementById('search').value;
  const list = await api('/api/questions?' + new URLSearchParams({ company, difficulty, q }));
  document.getElementById('questionList').innerHTML = list.map((q, i) => `
    <tr data-id="${q.id}">
      <td>${i + 1}</td>
      <td class="title">${esc(q.title)}</td>
      <td>${esc(q.company)}</td>
      <td>${(q.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</td>
      <td>${q.acceptance || '—'}</td>
      <td class="${q.difficulty}">${q.difficulty}</td>
    </tr>`).join('') || '<tr><td colspan="6" style="text-align:center;color:#9ca3af">No questions yet — upload one!</td></tr>';
  document.querySelectorAll('#questionList tr[data-id]').forEach(r => r.onclick = () => openQuestion(r.dataset.id));
}

async function loadCompanies() {
  const companies = await api('/api/companies');
  const sel = document.getElementById('companyFilter');
  sel.innerHTML = '<option value="">All companies</option>' + companies.map(c => `<option>${esc(c.company)}</option>`).join('');
  document.getElementById('companyChips').innerHTML = companies.map(c =>
    `<span class="chip" data-company="${esc(c.company)}">${esc(c.company)} (${c.count})</span>`).join('');
  document.querySelectorAll('.chip').forEach(ch => ch.onclick = () => {
    sel.value = ch.dataset.company;
    document.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === ch));
    loadQuestions();
  });
}

document.getElementById('search').oninput = () => loadQuestions();
document.getElementById('companyFilter').onchange = () => loadQuestions();
document.getElementById('diffFilter').onchange = () => loadQuestions();

// ---------- AI autofill ----------
document.getElementById('aiFill').onclick = async () => {
  const fileInput = document.getElementById('aiImages');
  const text = document.getElementById('aiText').value;
  const status = document.getElementById('aiStatus');
  if (!fileInput.files.length && !text.trim()) { status.textContent = 'Please upload an image or paste the question text.'; return; }
  status.textContent = '🤖 Extracting with AI…';
  const images = await Promise.all([...fileInput.files].map(f => new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); })));
  try {
    const data = await api('/api/ai/extract', { method: 'POST', body: JSON.stringify({ images, text }) });
    if (data.error) { status.textContent = 'Error: ' + data.error; return; }
    const f = document.getElementById('uploadForm');
    const set = (name, val) => { const el = f.elements[name]; if (el) el.value = val ?? ''; };
    set('title', data.title); set('company', data.company); set('difficulty', data.difficulty || 'Medium');
    set('tags', (data.tags || []).join(', ')); set('description', data.description);
    set('inputFormat', data.inputFormat); set('outputFormat', data.outputFormat);
    if (Array.isArray(data.tests)) {
      f.elements['testsText'].value = data.tests.map(t => `${(t.input || '').trim()}\n===\n${(t.output || '').trim()}`).join('\n---\n');
    }
    set('starterPython', data.starterCode?.python); set('driverPython', data.driverCode?.python);
    set('starterCpp', data.starterCode?.cpp); set('driverCpp', data.driverCode?.cpp);
    set('starterJavascript', data.starterCode?.javascript); set('driverJavascript', data.driverCode?.javascript);
    document.querySelectorAll('#uploadForm details').forEach(d => d.open = true);
    status.textContent = '✅ Form filled — review and edit, then Upload!';
  } catch (e) { status.textContent = 'Failed: ' + e.message; }
};

// ---------- upload ----------
document.getElementById('uploadForm').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = Object.fromEntries(f.entries());
  body.tags = body.tags ? body.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  body.starterCode = { python: body.starterPython, cpp: body.starterCpp, javascript: body.starterJavascript };
  body.driverCode = { python: body.driverPython, cpp: body.driverCpp, javascript: body.driverJavascript };
  body.testsText = body.testsText;
  const res = await fetch('/api/questions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  document.getElementById('uploadMsg').textContent = res.ok ? `Uploaded! It will show up in Problems.` : `Error: ${data.error}`;
  if (res.ok) { e.target.reset(); loadCompanies(); }
};

// ---------- editor ----------
let editor, currentLang = 'python', currentQ = null;
let availableLangs = [];
const codeByLang = {}; // preserve user edits per language
const MONACO_LANG = { python: 'python', cpp: 'cpp', javascript: 'javascript' };

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.0/min/vs' } });
require(['vs/editor/editor.main'], () => {
  editor = monaco.editor.create(document.getElementById('editor'), {
    value: '', language: 'python', theme: 'vs-dark', automaticLayout: true,
    minimap: { enabled: false }, fontSize: 14, lineHeight: 22,
    padding: { top: 14, bottom: 14 }, wordWrap: 'on',
    lineNumbers: 'on', renderLineHighlight: 'all',
    scrollBeyondLastLine: false, cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on', smoothScrolling: true,
    tabSize: 4, fontLigatures: true,
    fontFamily: '"JetBrains Mono", "Fira Code", Consolas, "Courier New", monospace',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    contextmenu: true, selectionHighlight: true,
  });
});

document.getElementById('langSelect').onchange = async e => {
  if (editor && currentQ) codeByLang[currentLang] = editor.getValue();
  currentLang = e.target.value;
  monaco.editor.setModelLanguage(editor.getModel(), MONACO_LANG[currentLang]);
  if (currentQ && codeByLang[currentLang] !== undefined) {
    editor.setValue(codeByLang[currentLang]);
    return;
  }
  const saved = currentQ ? await api(`/api/questions/${currentQ.id}/solution/${currentLang}`).catch(() => ({})) : {};
  editor.setValue(saved.code || currentQ?.starterCode?.[currentLang] || '');
};

// ---------- timer ----------
let timeLeft = 1800, timerId = null;
function renderTimer() {
  const d = document.getElementById('timerDisplay');
  if (timeLeft === 0 && document.getElementById('timerPreset').value === '0') { d.textContent = '∞'; d.classList.remove('warn'); return; }
  const m = String(Math.floor(timeLeft / 60)).padStart(2, '0');
  const s = String(timeLeft % 60).padStart(2, '0');
  d.textContent = `${m}:${s}`;
  d.classList.toggle('warn', timeLeft <= 300 && timeLeft > 0);
}
document.getElementById('timerStart').onclick = () => {
  if (timerId) { clearInterval(timerId); timerId = null; document.getElementById('timerStart').textContent = '▶ Start'; return; }
  if (timeLeft <= 0) return;
  document.getElementById('timerStart').textContent = '⏸ Pause';
  timerId = setInterval(() => {
    if (timeLeft > 0) { timeLeft--; renderTimer(); }
    else {
      clearInterval(timerId); timerId = null;
      document.getElementById('timerStart').textContent = '▶ Start';
      alert('⏰ Time is up! The editor is now read-only.');
      editor?.updateOptions({ readOnly: true });
    }
  }, 1000);
};
document.getElementById('timerReset').onclick = () => {
  clearInterval(timerId); timerId = null;
  document.getElementById('timerStart').textContent = '▶ Start';
  timeLeft = Number(document.getElementById('timerPreset').value) * 60;
  editor?.updateOptions({ readOnly: false });
  renderTimer();
};
document.getElementById('timerPreset').onchange = () => document.getElementById('timerReset').click();
renderTimer();

// ---------- run / submit ----------
function renderResults(results, mode) {
  const el = document.getElementById('testResults');
  if (results.length === 1 && results[0].compileError) {
    el.innerHTML = `<pre class="wrap" style="color:#ef4743">Compile error:\n${esc(results[0].compileError)}</pre>`;
    return;
  }
  el.innerHTML = results.map((r, i) => `
    <div class="test-case ${r.passed ? 'tpass' : 'tfail'}">
      <div class="tc-head">Case ${i + 1}: ${r.passed ? '✓ Passed' : '✗ Failed'} ${r.code !== 0 && r.code !== undefined && r.code !== 'timeout' ? `(exit ${r.code})` : r.code === 'timeout' ? '(TLE)' : ''}</div>
      <div class="tc-cols">
        <div><h5>Input</h5><pre>${esc(r.input ?? '')}</pre></div>
        <div><h5>Your output</h5><pre>${esc(r.got ?? '')}</pre></div>
        ${r.expected != null ? `<div><h5>Expected</h5><pre>${esc(r.expected)}</pre></div>` : ''}
      </div>
      ${r.stderr ? `<pre style="color:#f87171">${esc(r.stderr)}</pre>` : ''}
    </div>`).join('');
}

function showBanner(allPassed, passed, total, mode) {
  const b = document.getElementById('verdictBanner');
  b.hidden = false;
  if (allPassed) { b.className = 'banner pass'; b.textContent = mode === 'submit' ? `✅ Accepted — all ${total} test cases passed` : '✅ Sample test passed'; }
  else { b.className = 'banner fail'; b.textContent = `❌ ${passed}/${total} test cases passed`; }
}

async function execute(mode) {
  document.getElementById('testResults').innerHTML = '<p style="color:#9ca3af">Running…</p>';
  try {
    const r = await fetch('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: currentQ.id, language: currentLang, code: editor.getValue(), stdin: currentQ.tests[0].input, mode }),
    });
    const data = await r.json();
    if (data.error) { document.getElementById('testResults').innerHTML = `<pre class="wrap">${esc(data.error)}</pre>`; return; }
    renderResults(data.results, mode);
    const passed = data.results.filter(r => r.passed).length;
    showBanner(data.allPassed, passed, data.results.length, mode);
    if (mode === 'submit') {
      fetch(`/api/questions/${currentQ.id}/attempts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: currentLang, verdict: data.allPassed ? 'Accepted' : 'Wrong Answer' }) });
    }
    return data;
  } catch (e) {
    document.getElementById('testResults').innerHTML = `<pre class="wrap">Run failed: ${esc(e.message)}</pre>`;
  }
}

document.getElementById('runBtn').onclick = () => execute('run');
document.getElementById('submitBtn').onclick = () => execute('submit');

// Ctrl+S saves current code for this question+language
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (!currentQ || !editor) return;
    fetch(`/api/questions/${currentQ.id}/solution`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: currentLang, code: editor.getValue() }) })
      .then(() => toast('💾 Solution saved'));
  }
});
function toast(msg) {
  let t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 1800);
}

// ---------- open question ----------
async function openQuestion(id) {
  const q = await api('/api/questions/' + id);
  currentQ = q;
  for (const k of Object.keys(codeByLang)) delete codeByLang[k];
  document.getElementById('qTitle').textContent = q.title;
  document.getElementById('qMeta').innerHTML =
    `<span class="badge ${q.difficulty}" style="background:none;padding-left:0">${q.difficulty}</span>` +
    `<span class="badge">${esc(q.company)}</span>` +
    (q.year ? `<span class="badge">${esc(q.year)}</span>` : '') +
    (q.role ? `<span class="badge">${esc(q.role)}</span>` : '') +
    `<span class="badge">by ${esc(q.uploadedBy || 'anonymous')}</span>`;
  document.getElementById('qDesc').textContent = q.description;
  document.getElementById('qIn').textContent = q.inputFormat || '—';
  document.getElementById('qOut').textContent = q.outputFormat || '—';
  document.getElementById('testResults').innerHTML = '';
  document.getElementById('verdictBanner').hidden = true;

  availableLangs = ['python', 'cpp', 'javascript'].filter(l => q.starterCode && q.starterCode[l] && q.driverCode && q.driverCode[l]);
  const sel = document.getElementById('langSelect');
  sel.innerHTML = availableLangs.map(l => `<option value="${l}">${{ python: 'Python', cpp: 'C++', javascript: 'JavaScript' }[l]}</option>`).join('') || '<option>Not configured</option>';
  currentLang = availableLangs[0] || 'python';
  document.getElementById('timerPreset').dispatchEvent(new Event('change'));
  show('solve');
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  // set editor after solve view is visible
  setTimeout(async () => {
    if (editor && currentQ) {
      monaco.editor.setModelLanguage(editor.getModel(), MONACO_LANG[currentLang]);
      const saved = await api(`/api/questions/${currentQ.id}/solution/${currentLang}`).catch(() => ({}));
      editor.setValue(saved.code || currentQ.starterCode[currentLang] || '');
      editor.updateOptions({ readOnly: false });
    }
  }, 50);
}
document.getElementById('backBtn').onclick = () => show('browse');

// init
loadCompanies();
loadQuestions();
