# OA Arena

Upload, browse and solve real company OA questions — LeetCode-style editor,
hidden test harness, countdown timer, and it deploys anywhere via Docker.

## Features
- 📋 LeetCode-like problem table with company, tags, acceptance %, difficulty
- ⬆️ Upload questions with per-language **starter code + hidden driver code**
- 💻 Monaco editor (VS Code) with per-question function signatures: Python, C++, JavaScript
- ▶ Run / Submit — your function body is wrapped by the question's hidden driver and executed
- ⏱ Timer (15/30/45/60 min or no limit); editor locks at 0:00
- 💾 Zero-config storage in `questions.json`; acceptance tracked from submissions

## Run locally
```bash
npm install
npm start          # http://localhost:3000
```
Requires `python3`, `node`, and `g++` on the machine (all code runs locally).

## Deploy it so it works 24/7 (not just while your device is on)

### Option A — Render (free, easiest)
1. Push this folder to a GitHub repo (`git init && git add -A && git commit -m init && git push`)
2. Go to render.com → New → Blueprint, pick your repo — `render.yaml` is auto-detected
3. Click Apply. Your site goes live at `https://oa-arena-xxxx.onrender.com`

### Option B — Railway / Fly.io (also free tiers)
Same thing: connect the repo; both auto-detect the `Dockerfile`.

### Option C — Any VPS (DigitalOcean, etc.)
```bash
docker build -t oa-arena .
docker run -d -p 80:3000 --name oa-arena oa-arena
```

> Note: on Render/Railway the code-execution sandbox runs inside the container,
> so the same Dockerfile guarantees Python/C++/JS all keep working. Keep it as a
> private community site — uploaded code is executed on the server.

## Environment variables
| Variable | Purpose |
|---|---|
| `PORT` | Port to listen on (default 3000) |
| `MONGODB_URI` | If set, questions/attempts/solutions are stored in MongoDB instead of `questions.json` |
| `OPENROUTER_API_KEY` | Enables the 🤖 AI autofill (image/text → question form) |
| `OPENROUTER_MODEL` | Vision model for autofill (default `google/gemini-2.0-flash-001`) |

## How the LeetCode-style harness works
Each question stores, per language:
- `starterCode` — shown in the editor (the class/function signature)
- `driverCode` — hidden; reads stdin, calls your function, prints the result

When you hit Run/Submit, the server concatenates `starter+driver` (adding C++ includes) and runs it. So every question defines its own interface, like LeetCode. **Run** tests the first sample; **Submit** runs all of the question's test cases in parallel (C++ binaries are cached by code hash, so re-submits skip recompilation). Ctrl+S saves your current code per question.
