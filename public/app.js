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

// ---------- upload ----------
document.getElementById('uploadForm').onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = Object.fromEntries(f.entries());
  body.tags = body.tags ? body.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  body.starterCode = { python: body.starterPython, cpp: body.starterCpp, javascript: body.starterJavascript };
  body.driverCode = { python: body.driverPython, cpp: body.driverCpp, javascript: body.driverJavascript };
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
    minimap: { enabled: false }, fontSize: 14, padding: { top: 12 },
  });
});

document.getElementById('langSelect').onchange = e => {
  if (editor && currentQ) codeByLang[currentLang] = editor.getValue();
  currentLang = e.target.value;
  monaco.editor.setModelLanguage(editor.getModel(), MONACO_LANG[currentLang]);
  editor.setValue(codeByLang[currentLang] ?? currentQ.starterCode[currentLang] ?? '');
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
async function runCode() {
  document.getElementById('runOutput').textContent = 'Running…';
  try {
    const r = await fetch('/api/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: currentQ.id, language: currentLang, code: editor.getValue(), stdin: currentQ.sampleInput }),
    });
    const run = await r.json();
    if (run.code !== 0 && run.compileError) {
      document.getElementById('runOutput').textContent = 'Compile error:\n' + run.compileError;
      return null;
    }
    const out = run.code === 'timeout' ? 'Time limit exceeded' : (run.stdout || '') + (run.stderr ? (run.stdout ? '\n' : '') + run.stderr : '');
    document.getElementById('runOutput').textContent = out || '(no output)';
    return run.stdout ?? '';
  } catch (e) {
    document.getElementById('runOutput').textContent = 'Run failed: ' + e.message;
    return null;
  }
}

document.getElementById('runBtn').onclick = () => runCode();
document.getElementById('submitBtn').onclick = async () => {
  const out = await runCode();
  if (out === null) return;
  const got = out.trim().replace(/\r\n/g, '\n');
  const expected = (currentQ.sampleOutput || '').trim().replace(/\r\n/g, '\n');
  const accepted = got === expected;
  const vEl = document.getElementById('verdict');
  vEl.textContent = accepted ? '✅ Accepted' : `❌ Wrong Answer — expected "${expected}"`;
  vEl.className = accepted ? 'pass' : 'fail';
  fetch(`/api/questions/${currentQ.id}/attempts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: currentLang, verdict: accepted ? 'Accepted' : 'Wrong Answer' }) });
};

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
  document.getElementById('qSampleIn').textContent = q.sampleInput;
  document.getElementById('qSampleOut').textContent = q.sampleOutput;
  document.getElementById('runOutput').textContent = '—';
  document.getElementById('verdict').textContent = '';

  availableLangs = ['python', 'cpp', 'javascript'].filter(l => q.starterCode && q.starterCode[l] && q.driverCode && q.driverCode[l]);
  const sel = document.getElementById('langSelect');
  sel.innerHTML = availableLangs.map(l => `<option value="${l}">${{ python: 'Python', cpp: 'C++', javascript: 'JavaScript' }[l]}</option>`).join('') || '<option>Not configured</option>';
  currentLang = availableLangs[0] || 'python';
  document.getElementById('timerPreset').dispatchEvent(new Event('change'));
  show('solve');
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  // set editor after solve view is visible
  setTimeout(() => {
    if (editor && currentQ) {
      monaco.editor.setModelLanguage(editor.getModel(), MONACO_LANG[currentLang]);
      editor.setValue(currentQ.starterCode[currentLang] ?? '');
      editor.updateOptions({ readOnly: false });
    }
  }, 50);
}
document.getElementById('backBtn').onclick = () => show('browse');

// init
loadCompanies();
loadQuestions();
