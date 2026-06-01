const STORAGE_KEY_PREFIX = 'sat-generator-demo-state';

function nowIso() {
  return new Date().toISOString();
}

function loadJsonStorage(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJsonStorage(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures in demo mode.
  }
}

function seededRandom(seed) {
  let a = 0x9e3779b9;
  let b = 0x243f6a88;
  let c = 0xb7e15162;
  let d = 0xdeadbeef;
  const text = String(seed || 'sat-generator-demo');
  for (let i = 0; i < text.length; i += 1) {
    a = (a ^ text.charCodeAt(i)) >>> 0;
    b = (b + ((a << 5) - a)) >>> 0;
    c = (c ^ ((b << 7) | (b >>> 25))) >>> 0;
    d = (d + c + i) >>> 0;
  }
  return function random() {
    const t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    const result = (t + d) | 0;
    c = (c + result) | 0;
    return ((result >>> 0) / 4294967296);
  };
}

function shuffle(list, seed) {
  const random = seededRandom(seed);
  const next = [...list];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase();
}

function hardestDifficulty(rows) {
  const order = ['H', 'M', 'E'];
  for (const difficulty of order) {
    if (rows.some((row) => String(row.difficulty || '').toUpperCase() === difficulty)) {
      return difficulty;
    }
  }
  return null;
}

function serializeCsv(set) {
  const rows = ['set_id,position,external_id,question_id,test_id,difficulty,selected_answer,correct_answer'];
  for (const [index, item] of (set.items || []).entries()) {
    const selected = item.correctAnswer?.join?.(';') || item.correctAnswer || '';
    rows.push([
      escapeCsv(set.id),
      index + 1,
      escapeCsv(item.external_id),
      escapeCsv(item.question_id),
      escapeCsv(item.test_id),
      escapeCsv(item.difficulty),
      '',
      escapeCsv(selected)
    ].join(','));
  }
  return `${rows.join('\n')}\n`;
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[,"\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function lookupScaled(rawScore, table = []) {
  const exact = table.find((entry) => Number(entry[0]) === Number(rawScore));
  if (exact) return Math.round((Number(exact[1]) + Number(exact[2])) / 2);
  const sorted = [...table].sort((a, b) => Number(a[0]) - Number(b[0]));
  if (!sorted.length) return null;
  if (rawScore <= Number(sorted[0][0])) return Math.round((Number(sorted[0][1]) + Number(sorted[0][2])) / 2);
  if (rawScore >= Number(sorted[sorted.length - 1][0])) {
    const last = sorted[sorted.length - 1];
    return Math.round((Number(last[1]) + Number(last[2])) / 2);
  }
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (rawScore >= Number(left[0]) && rawScore <= Number(right[0])) {
      const leftScore = Math.round((Number(left[1]) + Number(left[2])) / 2);
      const rightScore = Math.round((Number(right[1]) + Number(right[2])) / 2);
      const ratio = (rawScore - Number(left[0])) / (Number(right[0]) - Number(left[0]));
      return Math.round(leftScore + ratio * (rightScore - leftScore));
    }
  }
  return null;
}

function scoreSet(items, scoreTables, options = {}) {
  const bySection = {
    '1': items.filter((item) => String(item.test_id) === '1'),
    '2': items.filter((item) => String(item.test_id) === '2')
  };
  const rawScores = {
    rw: bySection['1'].length,
    math: bySection['2'].length
  };
  const estimate = {};
  if (options.showEstimate && scoreTables?.rw && scoreTables?.math) {
    estimate.rw = lookupScaled(rawScores.rw, scoreTables.rw);
    estimate.math = lookupScaled(rawScores.math, scoreTables.math);
    if (Number.isFinite(estimate.rw) && Number.isFinite(estimate.math)) {
      estimate.total = estimate.rw + estimate.math;
    }
  }
  return {
    raw_total: rawScores.rw + rawScores.math,
    raw_rw: rawScores.rw,
    raw_math: rawScores.math,
    estimated_rw: estimate.rw ?? null,
    estimated_math: estimate.math ?? null,
    estimated_total: estimate.total ?? null
  };
}

function buildQuestionIndex(generatedSets) {
  const index = new Map();
  for (const set of generatedSets) {
    const createdAt = set.created_at || set.createdAt || nowIso();
    for (const item of set.items || []) {
      const bucket = index.get(item.external_id) || [];
      bucket.push({
        set_id: set.id,
        set_name: set.name,
        mode: set.mode,
        seed: set.seed,
        seen_at: createdAt,
        section_name: item.sectionSlot || item.test_text || '',
        position: item.position || 0
      });
      index.set(item.external_id, bucket);
    }
  }
  return index;
}

function createTracking(externalId, index) {
  const history = index.get(externalId) || [];
  return {
    seenCount: history.length,
    firstSeenAt: history[0]?.seen_at || null,
    lastSeenAt: history[history.length - 1]?.seen_at || null,
    lastSeenSetId: history[history.length - 1]?.set_id || null,
    lastSeenSetName: history[history.length - 1]?.set_name || null
  };
}

function normalizeQuestion(question, tracking) {
  return {
    ...question,
    answerOptions: question.answerOptions || [],
    correctAnswer: Array.isArray(question.correctAnswer) ? question.correctAnswer : [],
    rendered_prompt_html: question.rendered_prompt_html || question.prompt_html || question.stimulus_html || question.stem_html || '',
    rendered_rationale_html: question.rendered_rationale_html || question.rationale_html || '',
    assessmentText: question.assessment_text,
    sectionText: question.test_text,
    domainText: question.primary_class_cd_desc,
    tracking: tracking || question.tracking || {
      seenCount: 0,
      firstSeenAt: null,
      lastSeenAt: null,
      lastSeenSetId: null,
      lastSeenSetName: null
    },
    raw: question.raw_json || null
  };
}

function matchesFilters(row, filters = {}, seenLookup = () => 0) {
  if (filters.assessment && String(row.assessment_id) !== String(filters.assessment)) return false;
  if (filters.test && String(row.test_id) !== String(filters.test)) return false;
  if (filters.domains?.length && !filters.domains.includes(row.primary_class_cd)) return false;
  if (filters.difficulty?.length && !filters.difficulty.includes(row.difficulty)) return false;
  if (filters.excludeActive && row.is_active) return false;
  if (filters.neverSeenBefore && seenLookup(row.external_id) > 0) return false;
  if (filters.skill && !normalizeText(row.skill_desc).includes(normalizeText(filters.skill))) return false;
  if (filters.search) {
    const hay = normalizeText([
      row.question_id,
      row.external_id,
      row.skill_desc,
      row.primary_class_cd_desc,
      row.search_text,
      row.rationale_text
    ].join(' '));
    if (!hay.includes(normalizeText(filters.search))) return false;
  }
  return true;
}

function buildPracticeSet(rows, filters = {}, seenLookup = () => 0) {
  const effectiveFilters = filters.practiceOnlyHard
    ? { ...filters, difficulty: [] }
    : filters;
  const base = rows.filter((row) => matchesFilters(row, effectiveFilters, seenLookup));
  const hardest = filters.practiceOnlyHard ? hardestDifficulty(base) : null;
  const filteredBase = hardest
    ? base.filter((row) => String(row.difficulty || '').toUpperCase() === hardest)
    : base;
  const limit = Math.max(1, Number(filters.limit || 24));
  const shuffled = shuffle(filteredBase, filters.seed || 'sat-generator-demo');
  return {
    items: shuffled.slice(0, limit),
    summary: {
      count: Math.min(limit, shuffled.length),
      available: filteredBase.length,
      hardestDifficulty: hardest
    }
  };
}

function buildFullTest(rows, filters = {}, seenLookup = () => 0) {
  const rwTarget = Math.max(1, Number(filters.fullTestCountRw || 54));
  const mathTarget = Math.max(1, Number(filters.fullTestCountMath || 44));
  const sharedFilters = {
    ...filters,
    test: '',
    domains: []
  };
  const rwFilters = { ...sharedFilters, test: '1', limit: rwTarget };
  const mathFilters = { ...sharedFilters, test: '2', limit: mathTarget };
  const rw = buildPracticeSet(rows, rwFilters, seenLookup).items;
  const math = buildPracticeSet(rows, mathFilters, seenLookup).items;
  const items = [
    ...rw.map((row) => ({ ...row, sectionSlot: 'Reading and Writing' })),
    ...math.map((row) => ({ ...row, sectionSlot: 'Math' }))
  ];
  return {
    items,
    summary: {
      count: items.length,
      rwCount: rw.length,
      mathCount: math.length
    }
  };
}

function buildPrintableHtml(set, scoreTables) {
  const score = set.score || {};
  const items = set.items || [];
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(set.name || 'Demo set')}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 32px; color: #111; }
      h1 { margin: 0 0 8px; }
      .meta { display: flex; gap: 16px; flex-wrap: wrap; color: #444; margin-bottom: 24px; }
      .item { border-top: 1px solid #ddd; padding: 16px 0; }
      .prompt { margin-bottom: 8px; }
      .choice { margin-left: 16px; }
      .note { margin: 18px 0; color: #555; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(set.name || 'Demo set')}</h1>
    <div class="meta">
      <div>Mode: ${escapeHtml(set.mode || '')}</div>
      <div>Items: ${escapeHtml(String(set.summary?.count ?? items.length))}</div>
      <div>Raw: ${escapeHtml(String(score.raw_total ?? '—'))}</div>
      <div>Estimated: ${escapeHtml(String(score.estimated_total ?? '—'))}</div>
      <div>${escapeHtml(scoreTables?.note || '')}</div>
    </div>
    ${items.map((item, index) => `
      <div class="item">
        <div><strong>${index + 1}.</strong> ${escapeHtml(item.skill_desc || item.skill || '')}</div>
        <div class="prompt">${item.rendered_prompt_html || ''}</div>
        <div>
          ${(item.answerOptions || []).map((choice, choiceIndex) => `
            <div class="choice">${String.fromCharCode(65 + choiceIndex)}. ${choice.rendered_html || choice.content || ''}</div>
          `).join('')}
        </div>
      </div>
    `).join('')}
  </body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.json();
}

function parseUrl(path) {
  const base = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
  return new URL(path, base);
}

export async function createDemoRuntime({
  demoDataUrl,
  scoreTablesUrl,
  buildId = 'dev'
} = {}) {
  const storageKey = `${STORAGE_KEY_PREFIX}:${String(buildId || 'dev')}:v1`;
  const [demoData, scoreTableData] = await Promise.all([
    fetchJson(demoDataUrl || './data/demo-data.json'),
    fetchJson(scoreTablesUrl || './data/score-tables.json')
  ]);
  const generatedSets = Array.isArray(loadJsonStorage(storageKey, []))
    ? loadJsonStorage(storageKey, [])
    : [];
  const questionIndex = buildQuestionIndex(generatedSets);
  const questions = Array.isArray(demoData.questions) ? demoData.questions : [];
  const scoreTables = {
    source: scoreTableData.source || '',
    updatedAt: scoreTableData.updatedAt || null,
    note: scoreTableData.note || null,
    rw: scoreTableData.rw || [],
    math: scoreTableData.math || []
  };

  function persist() {
    saveJsonStorage(storageKey, generatedSets);
  }

  function seenCount(externalId) {
    return (questionIndex.get(externalId) || []).length;
  }

  function decorate(question) {
    return normalizeQuestion(question, createTracking(question.external_id, questionIndex));
  }

  function filteredQuestions(filters = {}) {
    return questions
      .filter((row) => matchesFilters(row, filters, seenCount))
      .map(decorate);
  }

  function getQuestion(externalId) {
    const question = questions.find((row) => row.external_id === externalId);
    return question ? decorate(question) : null;
  }

  function getHistory(externalId) {
    return (questionIndex.get(externalId) || []).slice();
  }

  function rebuildIndex() {
    const nextIndex = buildQuestionIndex(generatedSets);
    questionIndex.clear();
    for (const [key, value] of nextIndex.entries()) {
      questionIndex.set(key, value);
    }
  }

  function saveGeneratedSet(set) {
    generatedSets.unshift(set);
    rebuildIndex();
    persist();
  }

  function generateSet(filters = {}) {
    const currentRows = questions.map((row) => decorate(row));
    const mode = String(filters.mode || 'practice');
    const isFullTest = mode === 'fulltest' || mode === 'full-test';
    const selected = isFullTest
      ? buildFullTest(currentRows, filters, seenCount)
      : buildPracticeSet(currentRows, filters, seenCount);
    const items = selected.items.map((row, index) => ({
      ...row,
      position: index + 1,
      tracking: createTracking(row.external_id, questionIndex)
    }));
    const set = {
      id: `demo-${Date.now()}`,
      name: isFullTest ? 'Demo full test' : 'Demo practice set',
      mode,
      seed: filters.seed || 'sat-generator-demo',
      config: { ...filters },
      score: isFullTest
        ? scoreSet(items, scoreTables, { showEstimate: true })
        : {
            raw_total: items.length,
            raw_rw: items.filter((item) => String(item.test_id) === '1').length,
            raw_math: items.filter((item) => String(item.test_id) === '2').length,
            estimated_rw: null,
            estimated_math: null,
            estimated_total: null
          },
      created_at: nowIso(),
      updated_at: nowIso(),
      items
    };
    saveGeneratedSet(set);
    return {
      ...set,
      summary: selected.summary || { count: items.length }
    };
  }

  function getMeta() {
    return {
      ...demoData.meta,
      counts: {
        questions: questions.length,
        assets: 0,
        sets: generatedSets.length
      },
      sync: getSyncStatus(),
      scoreTables: {
        source: scoreTables.source || 'demo',
        updatedAt: scoreTables.updatedAt || null,
        note: scoreTables.note || null
      }
    };
  }

  function getSyncStatus() {
    return {
      status: 'complete',
      progress: {
        done: questions.length,
        total: questions.length
      },
      events: [
        {
          title: 'Pages demo',
          detail: 'Static demo content is bundled in data/demo-data.json. Run the local server to sync the live question bank.'
        }
      ]
    };
  }

  function handleApi(path, options = {}) {
    const url = parseUrl(path);
    const pathname = url.pathname;
    const method = String(options.method || 'GET').toUpperCase();
    if (method === 'POST' && pathname === '/api/generate') {
      const body = options.body ? JSON.parse(options.body) : {};
      return Promise.resolve(generateSet(body));
    }
    if (method === 'POST' && pathname === '/api/sync') {
      return Promise.resolve(getSyncStatus());
    }
    if (method === 'GET' && pathname === '/api/meta') {
      return Promise.resolve(getMeta());
    }
    if (method === 'GET' && pathname === '/api/sync/status') {
      return Promise.resolve(getSyncStatus());
    }
    if (method === 'GET' && pathname === '/api/questions') {
      const filters = {
        assessment: url.searchParams.get('assessment') || '',
        test: url.searchParams.get('test') || '',
        domains: url.searchParams.getAll('domains'),
        difficulty: url.searchParams.getAll('difficulty'),
        excludeActive: url.searchParams.get('excludeActive') !== 'false',
        neverSeenBefore: url.searchParams.get('neverSeenBefore') === 'true',
        stateCd: url.searchParams.get('stateCd') || '',
        search: url.searchParams.get('search') || '',
        skill: url.searchParams.get('skill') || '',
        limit: Number(url.searchParams.get('limit') || 24),
        seed: url.searchParams.get('seed') || 'sat-generator-demo',
        mode: url.searchParams.get('mode') || 'practice',
        practiceOnlyHard: url.searchParams.get('practiceOnlyHard') === 'true',
        practiceTimerMinutes: Number(url.searchParams.get('practiceTimerMinutes') || 30),
        fullTestCountRw: Number(url.searchParams.get('fullTestCountRw') || 54),
        fullTestCountMath: Number(url.searchParams.get('fullTestCountMath') || 44)
      };
      return Promise.resolve(filteredQuestions(filters));
    }
    if (method === 'GET' && pathname.startsWith('/api/questions/') && pathname.endsWith('/history')) {
      const externalId = decodeURIComponent(pathname.split('/')[3] || '');
      return Promise.resolve(getHistory(externalId));
    }
    if (method === 'GET' && pathname.startsWith('/api/questions/')) {
      const externalId = decodeURIComponent(pathname.split('/')[3] || '');
      return Promise.resolve(getQuestion(externalId));
    }
    if (method === 'GET' && pathname.startsWith('/api/sets/') && pathname.endsWith('/export.json')) {
      const id = pathname.split('/')[3];
      const set = generatedSets.find((entry) => entry.id === id);
      return Promise.resolve(set || null);
    }
    return Promise.reject(new Error(`Demo mode does not implement ${pathname}`));
  }

  function buildExportBlob(set, format) {
    if (format === 'json') {
      return new Blob([JSON.stringify(set, null, 2)], { type: 'application/json' });
    }
    if (format === 'csv') {
      return new Blob([serializeCsv(set)], { type: 'text/csv' });
    }
    return null;
  }

  function buildPdfPreviewHtml(set) {
    return buildPrintableHtml(set, scoreTables);
  }

  return {
    handleApi,
    getMeta,
    getSyncStatus,
    filteredQuestions,
    getQuestion,
    getHistory,
    generateSet,
    buildExportBlob,
    buildPdfPreviewHtml
  };
}
