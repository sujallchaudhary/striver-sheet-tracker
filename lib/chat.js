// Conversational input: LLM parsing (Claude or Gemini) with a keyword-rule fallback.
const Anthropic = require('@anthropic-ai/sdk');
const { getDb, saveDb, setStatus, VALID_STATUSES } = require('./store');
const { getOrCreateAssignment, addProblemToDay, removeProblemFromDay } = require('./assignment');

const DEFAULT_MODELS = { anthropic: 'claude-opus-4-8', gemini: 'gemini-2.5-flash' };

// Each account brings its own API key — on a shared instance the server's
// environment keys are never used, so nobody can spend the host's credit.
//
// In 'auto' the provider is inferred from the key's shape: Anthropic keys are
// prefixed 'sk-ant-', Google AI Studio keys 'AIza'.
function llmConfig() {
  const s = getDb().settings;
  const key = (s.apiKey || '').trim();
  if (s.provider === 'none' || !key) return { mode: 'rules' };
  if (s.provider === 'anthropic') return { mode: 'anthropic', key };
  if (s.provider === 'gemini')    return { mode: 'gemini', key };
  if (key.startsWith('sk-ant-'))  return { mode: 'anthropic', key };
  if (key.startsWith('AIza'))     return { mode: 'gemini', key };
  return { mode: 'anthropic', key };
}

// ── Schemas ───────────────────────────────────────────────────────────────────
//
// Three action arrays in the response:
//   updates  – status changes  { slot, problem_id, status }
//   adds     – add to today    { problem_name (fuzzy) or next_from_queue:true }
//   removes  – remove from today { slot or problem_id }

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot:       { anyOf: [{ type: 'integer' }, { type: 'null' }], description: "Today's assignment slot (1-based)" },
          problem_id: { anyOf: [{ type: 'string' },  { type: 'null' }], description: 'Problem ID if outside today\'s slots' },
          status:     { type: 'string', enum: VALID_STATUSES },
        },
        required: ['slot', 'problem_id', 'status'],
        additionalProperties: false,
      },
    },
    adds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          problem_name:    { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Name of the problem to add (fuzzy match OK)' },
          next_from_queue: { type: 'boolean', description: 'True to add the next problem from the sheet queue' },
        },
        required: ['problem_name', 'next_from_queue'],
        additionalProperties: false,
      },
    },
    removes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot:       { anyOf: [{ type: 'integer' }, { type: 'null' }], description: "Slot number to remove from today" },
          problem_id: { anyOf: [{ type: 'string' },  { type: 'null' }], description: 'Problem ID to remove' },
        },
        required: ['slot', 'problem_id'],
        additionalProperties: false,
      },
    },
    reply: { type: 'string', description: 'Natural-language coaching answer or concise acknowledgement of tracker actions' },
  },
  required: ['updates', 'adds', 'removes', 'reply'],
  additionalProperties: false,
};

// Gemini responseSchema doesn't support additionalProperties or anyOf — use nullable:true.
const GEMINI_SCHEMA = {
  type: 'object',
  properties: {
    updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot:       { type: 'integer', nullable: true },
          problem_id: { type: 'string',  nullable: true },
          status:     { type: 'string',  enum: VALID_STATUSES },
        },
        required: ['slot', 'problem_id', 'status'],
      },
    },
    adds: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          problem_name:    { type: 'string',  nullable: true },
          next_from_queue: { type: 'boolean' },
        },
        required: ['problem_name', 'next_from_queue'],
      },
    },
    removes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          slot:       { type: 'integer', nullable: true },
          problem_id: { type: 'string',  nullable: true },
        },
        required: ['slot', 'problem_id'],
      },
    },
    reply: { type: 'string' },
  },
  required: ['updates', 'adds', 'removes', 'reply'],
};

// ── System prompt ─────────────────────────────────────────────────────────────

function chatSystemPrompt(assignment, byId, context = {}) {
  const lines = assignment.items.map((it, i) => {
    const p = byId[it.problemId];
    return `${i + 1}. "${p.title}" (id ${p.id}, ${it.type}) — status: ${p.status}`;
  });
  const p = context.selectedProblem;
  const level = context.hintLevel || 1;
  const levelRules = {
    1: 'Give only a Socratic nudge: identify the likely concept and ask one useful question. Do not give the algorithm.',
    2: 'Explain the core approach and invariant, but leave the implementation steps for the user.',
    3: 'Give structured steps or pseudocode, one important edge case, and expected complexity. Do not provide full code.',
    4: 'Give a detailed walkthrough, pseudocode, edge cases, and complexity. Provide full code only if the user explicitly asks for code or the complete solution.',
  };
  const selected = p
    ? `\nSelected problem for coaching:\n- Title: ${p.title}\n- Problem ID: ${p.id}\n- Topic: ${p.step}\n- Subsection: ${p.subsection}\n- Difficulty: ${p.difficulty}\n- Requested hint level: ${level}/4\n- Coaching rule: ${levelRules[level]}`
    : '\nNo problem is selected. Answer general DSA questions normally and ask the user to select a problem when problem-specific context is required.';
  const interviewMode = getDb().settings.coachMode === 'interview';
  const interactionStyle = interviewMode
    ? `\nInterview mode is ON. This overrides the requested hint-level disclosure rules. Act as a realistic technical interviewer, not a solution tutor:
- Begin by asking for missing constraints or asking the candidate to explain their approach; do not volunteer a solution.
- Probe one dimension at a time: brute force baseline, optimality, invariant/correctness, time and space complexity, then edge cases.
- Respond to an approach with concise interviewer feedback and the next targeted question. Do not praise without evidence.
- Do not provide pseudocode, a full algorithm, or code unless the user explicitly asks for the solution, pseudocode, or implementation.
- If the user asks for a hint, give one small interviewer-style prompt rather than revealing the answer.`
    : '\nRegular coach mode is ON. Use the selected progressive hint level.';

  return `You are a focused DSA coach and an assistant for a personal problem tracker.

Today's assignment (${lines.length} problem${lines.length === 1 ? '' : 's'}):
${lines.join('\n') || '(empty)'}
${selected}
${interactionStyle}

Tracker statuses: completed, solved_with_help, attempted, revision_needed, pending.

You have two responsibilities:
1. COACH — help the user reason about the selected problem. Prefer questions, pattern recognition, invariants, examples, and progressive hints over revealing the answer. Treat the title and metadata only as identifying context; if the exact statement or constraints are ambiguous, ask the user to paste them rather than inventing details.
2. TRACK — update statuses, add a problem to today, or remove one only when the user clearly and explicitly requests that action. Never infer a status change from asking for a hint, discussing an attempt, or pasting code.

Tracker action rules:
- Numbers like "problem 2" or "slot 2" refer to today's numbered assignment.
- "This problem" refers to the selected problem when one exists; use its problem ID.
- Use next_from_queue:true only for an explicit request to add the next problem.
- If no tracker action was requested, return empty action arrays.
- Put the complete natural-language coaching answer or acknowledgement in reply.
- Format coaching replies in clear Markdown. Use fenced code blocks with a language tag for pseudocode or code, and keep prose concise.
- Return JSON only, matching the response schema.`;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function parseChatLLM(message, assignment, byId, context = {}) {
  const cfg = llmConfig();
  const system = chatSystemPrompt(assignment, byId, context);
  const model = getDb().settings.model || DEFAULT_MODELS[cfg.mode];
  const history = (context.history || []).map((entry) => ({
    role: entry.role,
    content: entry.content,
  }));

  if (cfg.mode === 'anthropic') {
    const client = new Anthropic({ apiKey: cfg.key });
    const resp = await client.messages.create({
      model,
      max_tokens: 1800,
      system,
      output_config: { format: { type: 'json_schema', schema: UPDATE_SCHEMA } },
      messages: [...history, { role: 'user', content: message }],
    });
    if (resp.stop_reason === 'refusal') throw new Error('model refused');
    const text = resp.content.find((b) => b.type === 'text');
    if (!text?.text) throw new Error('empty model response');
    return JSON.parse(text.text);
  }

  if (cfg.mode === 'gemini') {
    const contents = [...history, { role: 'user', content: message }].map((entry) => ({
      role: entry.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: entry.content }],
    }));
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SCHEMA,
          },
        }),
      }
    );
    if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    const raw = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
    if (!raw) throw new Error('empty model response');
    return JSON.parse(raw);
  }

  return null;
}

// ── Fuzzy problem search ──────────────────────────────────────────────────────

function findProblemByName(name, exclude = new Set()) {
  const db = getDb();
  const needle = name.toLowerCase().trim();
  // exact title match first
  let p = db.problems.find((x) => x.title.toLowerCase() === needle && !exclude.has(x.id));
  if (p) return p;
  // starts-with
  p = db.problems.find((x) => x.title.toLowerCase().startsWith(needle) && !exclude.has(x.id));
  if (p) return p;
  // contains all words
  const words = needle.split(/\s+/).filter(Boolean);
  p = db.problems.find((x) => {
    const t = x.title.toLowerCase();
    return words.every((w) => t.includes(w)) && !exclude.has(x.id);
  });
  return p || null;
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function parseChat(message, date, options = {}) {
  const db = getDb();
  const assignment = getOrCreateAssignment(date);
  const byId = Object.fromEntries(db.problems.map((p) => [p.id, p]));
  const slots = assignment.items.map((it) => it.problemId);
  const requestedProblemId = options.problemId == null ? null : String(options.problemId);
  const selectedProblem = requestedProblemId ? byId[requestedProblemId] : null;
  if (requestedProblemId && !selectedProblem) throw new Error('unknown coaching problem');
  const hintLevel = Math.min(4, Math.max(1, Number.parseInt(options.hintLevel, 10) || 1));
  const context = {
    selectedProblem,
    hintLevel,
    history: Array.isArray(options.history) ? options.history : [],
  };
  const coach = {
    problem: selectedProblem ? {
      id: selectedProblem.id,
      title: selectedProblem.title,
      step: selectedProblem.step,
      subsection: selectedProblem.subsection,
      difficulty: selectedProblem.difficulty,
    } : null,
    hintLevel,
  };

  let parsed = null;
  let mode = llmConfig().mode;
  if (mode !== 'rules') {
    try {
      parsed = await parseChatLLM(message, assignment, byId, context);
    } catch (err) {
      console.error('LLM parse failed, falling back to rules:', err.message);
      mode = 'rules';
    }
  }

  if (parsed) {
    let dirty = false;

    // 1. Status updates
    const updates = [];
    for (const u of parsed.updates || []) {
      let problemId = null;
      if (u.slot != null && u.slot >= 1 && u.slot <= slots.length) problemId = slots[u.slot - 1];
      else if (u.problem_id != null && byId[String(u.problem_id)]) problemId = String(u.problem_id);
      if (!problemId) continue;
      const p = setStatus(problemId, u.status, date);
      if (p) { updates.push({ problemId, title: p.title, status: u.status }); dirty = true; }
    }

    // 2. Removes (do before adds so slot refs stay valid)
    const removes = [];
    // re-read slots after potential updates (statuses don't change slots)
    const currentSlots = () => getOrCreateAssignment(date).items.map((it) => it.problemId);
    for (const rem of parsed.removes || []) {
      let problemId = null;
      const liveSlots = currentSlots();
      if (rem.slot != null && rem.slot >= 1 && rem.slot <= liveSlots.length) problemId = liveSlots[rem.slot - 1];
      else if (rem.problem_id != null && byId[String(rem.problem_id)]) problemId = String(rem.problem_id);
      if (!problemId) continue;
      const result = removeProblemFromDay(date, problemId);
      if (!result.error) { removes.push(result.removed); dirty = true; }
    }

    // 3. Adds
    const adds = [];
    for (const a of parsed.adds || []) {
      let result;
      if (a.next_from_queue) {
        result = addProblemToDay(date, null);
      } else if (a.problem_name) {
        const inDay = new Set(getOrCreateAssignment(date).items.map((it) => it.problemId));
        const found = findProblemByName(a.problem_name, inDay);
        if (!found) {
          console.log(`[chat] could not find problem matching "${a.problem_name}"`);
          continue;
        }
        result = addProblemToDay(date, found.id);
      }
      if (result && !result.error) { adds.push(result.added); dirty = true; }
    }

    if (dirty) saveDb();
    const totalActions = updates.length + adds.length + removes.length;
    console.log(
      `[chat] LLM actions — updates:${updates.length} adds:${adds.length} removes:${removes.length}` +
      (updates.length ? ' | ' + updates.map((u) => `${u.title}->${u.status}`).join(', ') : '') +
      (adds.length    ? ' | added: '   + adds.map((a) => a.title).join(', ')    : '') +
      (removes.length ? ' | removed: ' + removes.map((r) => r.title).join(', ') : '')
    );
    return { updates, adds, removes, reply: parsed.reply || '', mode, ...coach };
  }

  // Rules fallback keeps deterministic status updates. Coaching needs an LLM,
  // so explain that clearly instead of pretending the hint was understood.
  const updates = parseChatRules(message, date);
  const reply = selectedProblem
    ? 'AI coaching is unavailable. Add an Anthropic or Gemini API key in Settings to get progressive hints.'
    : '';
  return { updates, adds: [], removes: [], reply, mode: 'rules', ...coach };
}

// ── Keyword-rule fallback (status only) ───────────────────────────────────────

function parseChatRules(message, date) {
  const db = getDb();
  const assignment = getOrCreateAssignment(date);
  const slots = assignment.items.map((it) => it.problemId);
  const clauses = message
    .toLowerCase()
    .split(/[.;!\n]|\bbut\b|\bhowever\b|\bthough\b/)
    .map((s) => s.trim())
    .filter(Boolean);

  const updates = [];
  for (const clause of clauses) {
    const nums = (clause.match(/\d+/g) || []).map(Number);
    if (!nums.length) continue;

    let status = null;
    if (/(couldn'?t|could ?not|can'?t|unable|failed|didn'?t|did ?not|not solve|stuck|gave up|no luck)/.test(clause)) {
      status = 'attempted';
    } else if (/(with (some )?help|hint|editorial|looked at|saw the solution|needed help)/.test(clause)) {
      status = 'solved_with_help';
    } else if (/(revis|review|redo|again later|come back)/.test(clause)) {
      status = 'revision_needed';
    } else if (/(complet|solv|done|finish|did|crack|nail|got)/.test(clause)) {
      status = 'completed';
    }
    if (!status) continue;

    for (const n of nums) {
      let problemId = null;
      if (n >= 1 && n <= slots.length) problemId = slots[n - 1];
      else if (db.problems.some((p) => p.id === String(n))) problemId = String(n);
      if (!problemId) continue;
      const p = setStatus(problemId, status, date);
      if (p) updates.push({ problemId, title: p.title, status });
    }
  }
  if (updates.length) saveDb();
  return updates;
}

module.exports = { parseChat, llmConfig };
