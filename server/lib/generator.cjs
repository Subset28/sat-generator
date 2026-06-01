const crypto = require('node:crypto');

function seededRandom(seed) {
  const hash = crypto.createHash('sha256').update(String(seed || 'sat-generator')).digest();
  let a = hash.readUInt32LE(0);
  let b = hash.readUInt32LE(4);
  let c = hash.readUInt32LE(8);
  let d = hash.readUInt32LE(12);
  return function random() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0;
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

function matchesFilters(row, filters = {}) {
  if (filters.assessment && String(row.assessment_id) !== String(filters.assessment)) return false;
  if (filters.test && String(row.test_id) !== String(filters.test)) return false;
  if (filters.domains?.length && !filters.domains.includes(row.primary_class_cd)) return false;
  if (filters.difficulty?.length && !filters.difficulty.includes(row.difficulty)) return false;
  if (filters.excludeActive && row.is_active) return false;
  if (filters.stateCd && (!row.stateCd || String(row.stateCd) !== String(filters.stateCd))) return false;
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

function buildPracticeSet(rows, filters = {}) {
  const effectiveFilters = filters.practiceOnlyHard
    ? { ...filters, difficulty: [] }
    : filters;
  const base = rows.filter((row) => matchesFilters(row, effectiveFilters));
  const hardest = filters.practiceOnlyHard ? hardestDifficulty(base) : null;
  const filteredBase = hardest
    ? base.filter((row) => String(row.difficulty || '').toUpperCase() === hardest)
    : base;
  const limit = Math.max(1, Number(filters.limit || 24));
  const shuffled = shuffle(filteredBase, filters.seed || 'sat-generator');
  return {
    items: shuffled.slice(0, limit),
    summary: {
      count: Math.min(limit, shuffled.length),
      available: filteredBase.length,
      hardestDifficulty: hardest
    }
  };
}

function buildFullTest(rows, filters = {}) {
  const rwTarget = Math.max(1, Number(filters.fullTestCountRw || 54));
  const mathTarget = Math.max(1, Number(filters.fullTestCountMath || 44));
  const sharedFilters = {
    ...filters,
    test: '',
    domains: []
  };
  const rwFilters = { ...sharedFilters, test: '1', limit: rwTarget };
  const mathFilters = { ...sharedFilters, test: '2', limit: mathTarget };
  const rw = buildPracticeSet(rows, rwFilters).items;
  const math = buildPracticeSet(rows, mathFilters).items;
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

function lookupScaled(rawScore, table = []) {
  const exact = table.find((entry) => Number(entry.raw) === Number(rawScore));
  if (exact) return Number(exact.scaled);
  const sorted = [...table].sort((a, b) => Number(a.raw) - Number(b.raw));
  if (!sorted.length) return null;
  if (rawScore <= Number(sorted[0].raw)) return Number(sorted[0].scaled);
  if (rawScore >= Number(sorted[sorted.length - 1].raw)) return Number(sorted[sorted.length - 1].scaled);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (rawScore >= Number(left.raw) && rawScore <= Number(right.raw)) {
      const ratio = (rawScore - Number(left.raw)) / (Number(right.raw) - Number(left.raw));
      return Math.round(Number(left.scaled) + ratio * (Number(right.scaled) - Number(left.scaled)));
    }
  }
  return null;
}

module.exports = {
  buildPracticeSet,
  buildFullTest,
  scoreSet,
  matchesFilters,
  shuffle
};
