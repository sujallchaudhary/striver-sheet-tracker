// Conversational input: LLM parsing (Claude or Gemini) with a keyword-rule fallback.
const Anthropic = require('@anthropic-ai/sdk');
const { getDb, saveDb, setStatus, VALID_STATUSES } = require('./store');
const { getOrCreateAssignment, addProblemToDay, removeProblemFromDay } = require('./assignment');

const DEFAULT_MODELS = { anthropic: 'claude-opus-4-8', gemini: 'gemini-2.5-flash' };

function llmConfig() {
  const s = getDb().settings;
  const anthropicKey = (s.provider === 'anthropic' && s.apiKey) || process.env.ANTHROPIC_API_KEY;
  const geminiKey   = (s.provider === 'gemini'    && s.apiKey) || process.env.GEMINI_API_KEY;
  if (s.provider === 'none')      return { mode: 'rules' };
  if (s.provider === 'anthropic') return anthropicKey ? { mode: 'anthropic', key: anthropicKey } : { mode: 'rules' };
  if (s.provider === 'gemini')    return geminiKey    ? { mode: 'gemini',    key: geminiKey    } : { mode: 'rules' };
  if (anthropicKey) return { mode: 'anthropic', key: anthropicKey };
  if (geminiKey)    return { mode: 'gemini',    key: geminiKey };
  return { mode: 'rules' };
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
    reply: { type: 'string', description: 'Short, friendly acknowledgement of everything done' },
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

function chatSystemPrompt(assignment, byId) {
  const lines = assignment.items.map((it, i) => {
    const p = byId[it.problemId];
    return `${i + 1}. "${p.title}" (id ${p.id}, ${it.type}) — status: ${p.status}`;
  });
  return `You are an assistant for a personal DSA (Data Structures & Algorithms) problem tracker.

Today's assignment (${lines.length} problem${lines.length === 1 ? '' : 's'}):
${lines.join('\n')}

Statuses: completed, solved_with_help, attempted, revision_needed, pending.

You can perform three kinds of actions based on the user's message:
1. UPDATE STATUS  – set a problem's status. Reference by slot number or problem name.
2. ADD PROBLEM    – add a problem to today. Use "next_from_queue:true" for "add next" requests,
                    or "problem_name" for a specific problem by name.
3. REMOVE PROBLEM – remove a problem from today by slot number or name.

Rules:
- Numbers like "problem 2" or "slot 2" refer to today's slot above.
- Only act on things the user clearly stated.
- If nothing matches, return empty arrays and explain in reply.
- Respond with JSON only.`;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function parseChatLLM(message, assignment, byId) {
  const cfg = llmConfig();
  const system = chatSystemPrompt(assignment, byId);
  const model = getDb().settings.model || DEFAULT_MODELS[cfg.mode];

  if (cfg.mode === 'anthropic') {
    const client = new Anthropic({ apiKey: cfg.key });
    const resp = await client.messages.create({
      model,
      max_tokens: 1024,
      system,
      output_config: { format: { type: 'json_schema', schema: UPDATE_SCHEMA } },
      messages: [{ role: 'user', content: message }],
    });
    if (resp.stop_reason === 'refusal') throw new Error('model refused');
    const text = resp.content.find((b) => b.type === 'text');
    console.log('[chat] claude raw:', (text?.text || '').slice(0, 500).replace(/\n/g, ' '));
    return JSON.parse(text.text);
  }

  if (cfg.mode === 'gemini') {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${cfg.key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: message }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: GEMINI_SCHEMA,
          },
        }),
      }
    );
    if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    console.log('[chat] gemini raw:', raw.slice(0, 500).replace(/\n/g, ' '));
    return JSON.parse(raw);
  }

  return null; // rules mode
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

async function parseChat(message, date) {
  const db = getDb();
  const assignment = getOrCreateAssignment(date);
  const byId = Object.fromEntries(db.problems.map((p) => [p.id, p]));
  const slots = assignment.items.map((it) => it.problemId);

  let parsed = null;
  let mode = llmConfig().mode;
  if (mode !== 'rules') {
    try {
      parsed = await parseChatLLM(message, assignment, byId);
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
    return { updates, adds, removes, reply: parsed.reply || '', mode };
  }

  // Rules fallback (status updates only; add/remove via chat requires LLM)
  const updates = parseChatRules(message, date);
  return { updates, adds: [], removes: [], reply: '', mode: 'rules' };
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
