const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const { registerRuntimeNodeModules, resolveRepoPath } = require('./lib/runtime.cjs');
registerRuntimeNodeModules();

const { initStore, nowIso, stripHtml } = require('./lib/storage.cjs');
const { sanitizeHtml } = require('./lib/sanitize.cjs');
const { renderMathInHtml } = require('./lib/mathjax.cjs');
const { fetchLookup, fetchQuestions, fetchQuestionBatch, fetchStateStandards, createLimiter, sleep } = require('./lib/eqb.cjs');
const { buildPracticeSet, buildFullTest, scoreSet } = require('./lib/generator.cjs');
const { renderPdfBuffer, renderPrintableHtml, toCsv } = require('./lib/export.cjs');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_EQB_COOKIE = process.env.EQB_COOKIE || '';
const DATA_DIR = resolveRepoPath('data');
const ASSET_ROOT = path.join(DATA_DIR, 'assets');
const PUBLIC_DIR = resolveRepoPath('public');
const VENDOR_DIR = resolveRepoPath('vendor');
const DIST_DIR = resolveRepoPath('dist');
const SERVE_DIST = process.env.SAT_SERVE_DIST === '1' || process.env.SAT_STATIC_BUILD === '1';
const STATIC_DIR = SERVE_DIST ? DIST_DIR : PUBLIC_DIR;
const SCORE_TABLES_PATH = resolveRepoPath('data', 'score-tables.json');
const EQB_ORIGIN = 'https://satsuiteeducatorquestionbank.collegeboard.org';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8'
};

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendJson(res, statusCode, data) {
  send(res, statusCode, JSON.stringify(data, null, 2), {
    'content-type': 'application/json; charset=utf-8'
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function loadScoreTables() {
  if (fs.existsSync(SCORE_TABLES_PATH)) {
    return normalizeScoreTables(JSON.parse(fs.readFileSync(SCORE_TABLES_PATH, 'utf8')));
  }
  return {
    source: 'local-placeholder',
    updatedAt: nowIso(),
    note: 'Replace with officially released College Board conversion tables.',
    rw: buildFallbackScoreTable(),
    math: buildFallbackScoreTable()
  };
}

function normalizeScoreTables(input) {
  if (!input || typeof input !== 'object') {
    return {
      source: 'local-placeholder',
      updatedAt: nowIso(),
      note: 'Replace with officially released College Board conversion tables.',
      rw: buildFallbackScoreTable(),
      math: buildFallbackScoreTable()
    };
  }

  const normalize = (table) => {
    if (!table) return buildFallbackScoreTable();
    const rows = Array.isArray(table)
      ? table
      : Array.isArray(table.rows)
        ? table.rows
        : Array.isArray(table.entries)
          ? table.entries
          : [];
    return rows.map((row) => {
      if (Array.isArray(row)) {
        const [raw, lower, upper] = row;
        const midpoint = Math.round((Number(lower) + Number(upper)) / 2);
        return { raw: Number(raw), scaled: midpoint, lower: Number(lower), upper: Number(upper) };
      }
      const raw = Number(row.raw);
      if (Number.isFinite(row.scaled)) {
        return { raw, scaled: Number(row.scaled) };
      }
      if (Number.isFinite(row.lower) && Number.isFinite(row.upper)) {
        return {
          raw,
          scaled: Math.round((Number(row.lower) + Number(row.upper)) / 2),
          lower: Number(row.lower),
          upper: Number(row.upper)
        };
      }
      return { raw, scaled: Number(row.value ?? row.score ?? 0) };
    }).filter((row) => Number.isFinite(row.raw) && Number.isFinite(row.scaled));
  };

  return {
    source: input.source || 'college-board-practice-test',
    updatedAt: input.updatedAt || nowIso(),
    note: input.note || 'Official College Board raw-to-scaled practice tables.',
    rw: normalize(input.rw || input.readingWriting || input.readingAndWriting),
    math: normalize(input.math)
  };
}

function buildFallbackScoreTable() {
  const entries = [];
  for (let raw = 0; raw <= 54; raw += 1) {
    const scaled = Math.max(200, Math.min(800, 200 + Math.round((raw / 54) * 600)));
    entries.push({ raw, scaled });
  }
  return entries;
}

function createSyncState() {
  return {
    status: 'idle',
    runId: null,
    progress: { done: 0, total: 0 },
    events: [],
    checkpoint: {},
    startedAt: null,
    completedAt: null,
    lastError: null
  };
}

let store;
let scoreTables = loadScoreTables();
let syncState = createSyncState();
let syncPromise = null;

function pushSyncEvent(title, detail, type = 'info') {
  syncState.events.push({
    title,
    detail,
    type,
    at: nowIso()
  });
  if (syncState.events.length > 120) {
    syncState.events = syncState.events.slice(-120);
  }
}

async function loadStore() {
  if (!store) {
    store = await initStore();
    const latest = store.latestSyncRun();
    if (latest) {
      syncState = {
        status: latest.status || 'idle',
        runId: latest.id || null,
        progress: safeJsonParse(latest.progress_json, { done: 0, total: 0 }),
        events: [],
        checkpoint: safeJsonParse(latest.checkpoint_json, {}),
        startedAt: latest.started_at || null,
        completedAt: latest.completed_at || null,
        lastError: latest.last_error || null
      };
    }
  }
  return store;
}

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function getCurrentScoreTables() {
  return scoreTables || { rw: buildFallbackScoreTable(), math: buildFallbackScoreTable() };
}

function normalizeLookup(lookup) {
  const rw = lookup.lookupData?.domain?.['R&W'] || [];
  const math = lookup.lookupData?.domain?.Math || [];
  return {
    assessments: lookup.lookupData?.assessment || [],
    tests: lookup.lookupData?.test || [],
    domains: {
      'R&W': rw.map((row) => ({ ...row, assessment_group: 'R&W' })),
      Math: math.map((row) => ({ ...row, assessment_group: 'Math' }))
    },
    stateOfferings: lookup.stateOfferings || []
  };
}

function domainGroupsFromLookup(lookup) {
  const normalized = normalizeLookup(lookup);
  return [
    {
      assessmentId: '99',
      assessmentText: 'SAT',
      testId: '1',
      testText: 'Reading and Writing',
      groupKey: 'R&W',
      domains: normalized.domains['R&W']
    },
    {
      assessmentId: '99',
      assessmentText: 'SAT',
      testId: '2',
      testText: 'Math',
      groupKey: 'Math',
      domains: normalized.domains.Math
    },
    {
      assessmentId: '100',
      assessmentText: 'PSAT/NMSQT & PSAT 10',
      testId: '1',
      testText: 'Reading and Writing',
      groupKey: 'R&W',
      domains: normalized.domains['R&W']
    },
    {
      assessmentId: '100',
      assessmentText: 'PSAT/NMSQT & PSAT 10',
      testId: '2',
      testText: 'Math',
      groupKey: 'Math',
      domains: normalized.domains.Math
    },
    {
      assessmentId: '102',
      assessmentText: 'PSAT 8/9',
      testId: '1',
      testText: 'Reading and Writing',
      groupKey: 'R&W',
      domains: normalized.domains['R&W']
    },
    {
      assessmentId: '102',
      assessmentText: 'PSAT 8/9',
      testId: '2',
      testText: 'Math',
      groupKey: 'Math',
      domains: normalized.domains.Math
    }
  ];
}

function toAbsoluteEqbUrl(src) {
  try {
    return new URL(src, EQB_ORIGIN).toString();
  } catch {
    return src;
  }
}

function extFromMime(mimeType, fallback = '.bin') {
  const map = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg'
  };
  return map[String(mimeType || '').toLowerCase()] || fallback;
}

function assetPathFromHash(hash, ext) {
  return path.join(ASSET_ROOT, 'sha256', hash.slice(0, 2), hash.slice(2, 4), `${hash}${ext}`);
}

function assetPublicPathFromHash(hash, ext) {
  return `/assets/sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}${ext}`;
}

async function downloadAsset(assetUrl, cookie = '') {
  const abs = toAbsoluteEqbUrl(assetUrl);
  const response = await fetch(abs, {
    headers: {
      ...(cookie ? { cookie } : {}),
      'user-agent': 'SAT-Generator/0.1 (+local)'
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to download asset ${abs}: ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = sha256Hex(bytes);
  const contentType = response.headers.get('content-type') || '';
  const ext = extFromMime(contentType, path.extname(new URL(abs).pathname) || '.bin');
  const localPath = assetPathFromHash(hash, ext);
  if (!fs.existsSync(localPath)) {
    ensureDir(localPath);
    fs.writeFileSync(localPath, bytes);
  }
  return {
    hash,
    ext,
    mimeType: contentType,
    originalUrl: abs,
    localPath,
    publicPath: assetPublicPathFromHash(hash, ext),
    sizeBytes: bytes.length
  };
}

function rewriteImgSources(html, onAssetUrl) {
  return String(html || '').replace(/<img\b([^>]*?)src=(["'])(.*?)\2([^>]*)>/gi, (full, before, quote, src, after) => {
    const replacement = onAssetUrl(src);
    return `<img${before}src="${replacement}"${after}>`;
  });
}

async function processQuestionContent(content, cookie = '') {
  const stemHtml = sanitizeHtml(content.stem || '');
  const stimulusHtml = sanitizeHtml(content.stimulus || '');
  const rationaleHtml = sanitizeHtml(content.rationale || '');
  const promptHtml = [stimulusHtml, stemHtml].filter(Boolean).join('');
  const answerOptions = (content.answerOptions || []).map((choice, index) => ({
    letter: String.fromCharCode(65 + index),
    id: choice.id || null,
    content: sanitizeHtml(choice.content || ''),
    raw_content: choice.content || '',
    rendered_html: ''
  }));

  const assetMap = new Map();
  const assetRefs = [];
  async function resolveAssets(html) {
    const sources = [...String(html || '').matchAll(/<img\b[^>]*src=(["'])(.*?)\1/gi)].map((match) => match[2]);
    let rendered = html;
    for (const src of sources) {
      if (assetMap.has(src)) {
        rendered = rendered.replaceAll(src, assetMap.get(src));
        continue;
      }
      const asset = await downloadAsset(src, cookie);
      const stored = store.upsertAsset(asset);
      assetMap.set(src, asset.publicPath);
      rendered = rendered.replaceAll(src, asset.publicPath);
      assetRefs.push({
        originalSrc: src,
        assetHash: stored.hash,
        assetId: stored.id
      });
    }
    return rendered;
  }

  let renderedPromptHtml = await resolveAssets(promptHtml);
  let renderedRationaleHtml = await resolveAssets(rationaleHtml);
  for (const choice of answerOptions) {
    choice.rendered_html = await resolveAssets(choice.content);
  }

  renderedPromptHtml = renderMathInHtml(renderedPromptHtml);
  renderedRationaleHtml = renderMathInHtml(renderedRationaleHtml);
  for (const choice of answerOptions) {
    choice.rendered_html = renderMathInHtml(choice.rendered_html);
  }

  const searchText = stripHtml([promptHtml, rationaleHtml, ...answerOptions.map((choice) => choice.content)].join(' '));
  const rationaleText = stripHtml(rationaleHtml);
  const contentHash = sha256Hex(JSON.stringify({
    externalid: content.externalid,
    stemHtml,
    stimulusHtml,
    rationaleHtml,
    answerOptions: answerOptions.map((choice) => choice.content),
    correct_answer: content.correct_answer || []
  }));

  return {
    stem_html: stemHtml,
    stimulus_html: stimulusHtml,
    prompt_html: promptHtml,
    rationale_html: rationaleHtml,
    rendered_prompt_html: renderedPromptHtml,
    rendered_rationale_html: renderedRationaleHtml,
    answer_options_json: answerOptions,
    correct_answer_json: content.correct_answer || [],
    search_text: searchText,
    rationale_text: rationaleText,
    content_hash: contentHash,
    raw_json: content,
    assetRefs
  };
}

async function syncEqb(cookie = '', resume = true) {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    await loadStore();
    const effectiveCookie = cookie || DEFAULT_EQB_COOKIE;
    const previousRun = resume ? store.latestSyncRun() : null;
    const checkpoint = previousRun ? safeJsonParse(previousRun.checkpoint_json, {}) : {};
    const priorProgress = previousRun ? safeJsonParse(previousRun.progress_json, { done: 0, total: 0 }) : { done: 0, total: 0 };
    const lookup = await fetchLookup(effectiveCookie);
    store.upsertLookup(lookup);
    const groups = domainGroupsFromLookup(lookup);
    const totalSteps = groups.reduce((acc, group) => acc + (group.domains?.length || 0), 0) + 36;
    const startingDone = Math.min(Number(priorProgress.done) || 0, totalSteps);
    syncState = {
      status: 'running',
      runId: store.replaceSyncRun({
        status: 'running',
        config: { cookie: Boolean(effectiveCookie), resume },
        checkpoint,
        progress: { done: startingDone, total: totalSteps },
        started_at: nowIso()
      }).id,
      progress: { done: startingDone, total: totalSteps },
      events: [],
      checkpoint,
      startedAt: nowIso(),
      completedAt: null,
      lastError: null
    };
    pushSyncEvent('Lookup loaded', 'Reference data and live item lists cached.');

    const liveSets = {
      '1': new Set(lookup.readingLiveItems || []),
      '2': new Set(lookup.mathLiveItems || [])
    };

    const limiter = createLimiter(3, 120);

    for (const group of groups) {
      for (const domain of group.domains || []) {
        const checkpointKey = `${group.assessmentId}:${group.testId}:${domain.primaryClassCd}`;
        if (resume && checkpoint[checkpointKey] === 'done') continue;

        pushSyncEvent('Fetching questions', `${group.assessmentText} • ${group.testText} • ${domain.text}`);
        const params = {
          asmtEventId: Number(group.assessmentId),
          test: Number(group.testId),
          domain: domain.primaryClassCd
        };
        const rows = await limiter(() => fetchQuestions(params, effectiveCookie));
        let itemIndex = 0;
        const rowsByExternalId = new Map();
        for (const row of rows) {
          rowsByExternalId.set(row.external_id, row);
        }

        for (let i = 0; i < rows.length; i += 20) {
          const batch = rows.slice(i, i + 20);
          const externalIds = batch.map((row) => row.external_id);
          let contentItems;
          try {
            contentItems = await limiter(() => fetchQuestionBatch(externalIds, effectiveCookie));
          } catch {
            contentItems = await Promise.all(externalIds.map((externalId) => limiter(() => fetchQuestionBatch([externalId], effectiveCookie).then((items) => items[0]))));
          }
          for (const content of contentItems || []) {
            const base = rowsByExternalId.get(content.externalid);
            if (!base) continue;
            const processed = await processQuestionContent(content, effectiveCookie);
            const questionBase = store.upsertQuestionBase({
              question_id: base.questionId,
              external_id: base.external_id,
              uId: base.uId,
              program: base.program,
              assessment_id: group.assessmentId,
              assessment_text: group.assessmentText,
              test_id: group.testId,
              test_text: group.testText,
              primary_class_cd: base.primary_class_cd,
              primary_class_cd_desc: base.primary_class_cd_desc,
              skill_cd: base.skill_cd,
              skill_desc: base.skill_desc,
              difficulty: base.difficulty,
              score_band_range_cd: base.score_band_range_cd,
              is_active: liveSets[group.testId]?.has(base.external_id) || false,
              question_order: itemIndex += 1,
              content_hash: processed.content_hash,
              search_text: processed.search_text,
              rationale_text: processed.rationale_text
            }, checkpointKey);
            const versionRow = store.upsertQuestionVersion(questionBase, processed);
            for (const assetRef of processed.assetRefs || []) {
              if (!assetRef.assetId) continue;
              store.linkQuestionAsset(versionRow.id, assetRef.assetId, 'image', assetRef.originalSrc);
            }
          }
        }

        checkpoint[checkpointKey] = 'done';
        store.updateSyncRun(syncState.runId, {
          checkpoint_json: JSON.stringify(checkpoint),
          progress_json: JSON.stringify(syncState.progress)
        });
        syncState.progress.done += 1;
        pushSyncEvent('Domain complete', `${group.assessmentText} • ${group.testText} • ${domain.text}`, 'success');
      }
    }

    // State standards for SAT only. This keeps the sync time bounded and matches the main use case.
    const satAssessment = groups.find((group) => group.assessmentId === '99');
    if (satAssessment) {
      for (const state of lookup.stateOfferings || []) {
        const checkpointKey = `standards:99:${state.stateCd}`;
        if (resume && checkpoint[checkpointKey] === 'done') continue;
        pushSyncEvent('Fetching standards', `${state.name} (${state.stateCd})`);
        const standards = await limiter(() => fetchStateStandards(state.stateCd, 99, effectiveCookie));
        store.upsertStateStandards(state.stateCd, 99, standards);
        checkpoint[checkpointKey] = 'done';
        store.updateSyncRun(syncState.runId, {
          checkpoint_json: JSON.stringify(checkpoint),
          progress_json: JSON.stringify(syncState.progress)
        });
        syncState.progress.done += 1;
      }
    }

    syncState.status = 'complete';
    syncState.progress = { done: totalSteps, total: totalSteps };
    syncState.completedAt = nowIso();
    pushSyncEvent('Sync complete', 'EQB catalog and state standards are cached locally.', 'success');
    store.updateSyncRun(syncState.runId, {
      status: 'complete',
      checkpoint_json: JSON.stringify(checkpoint),
      progress_json: JSON.stringify(syncState.progress),
      completed_at: syncState.completedAt,
      last_error: null
    });
    store.save();
    syncPromise = null;
    return syncState;
  })().catch((error) => {
    syncState.status = 'failed';
    syncState.lastError = error?.stack || error?.message || String(error);
    pushSyncEvent('Sync failed', syncState.lastError, 'error');
    if (syncState.runId) {
      store.updateSyncRun(syncState.runId, {
        status: 'failed',
        checkpoint_json: JSON.stringify(syncState.checkpoint || {}),
        progress_json: JSON.stringify(syncState.progress || {}),
        completed_at: null,
        last_error: syncState.lastError
      });
    }
    syncPromise = null;
    throw error;
  });
  return syncPromise;
}

function applyQuestionTransforms(question) {
  if (!question) return null;
  const version = question.raw_json || {};
  return {
    ...question,
    rendered_prompt_html: question.rendered_prompt_html || question.prompt_html || question.stimulus_html || question.stem_html || '',
    rendered_rationale_html: question.rendered_rationale_html || question.rationale_html || '',
    answerOptions: question.answerOptions || [],
    correctAnswer: question.correctAnswer || [],
    assessmentText: question.assessment_text,
    sectionText: question.test_text,
    domainText: question.primary_class_cd_desc,
    tracking: {
      seenCount: Number(question.seen_count || 0),
      firstSeenAt: question.first_seen_at || null,
      lastSeenAt: question.last_seen_at || null,
      lastSeenSetId: question.last_seen_set_id || null,
      lastSeenSetName: question.last_seen_set_name || null
    },
    raw: version
  };
}

async function handleApi(req, res, urlObj) {
  const { pathname, searchParams } = urlObj;
  if (req.method === 'GET' && pathname === '/api/meta') {
    await loadStore();
    sendJson(res, 200, {
      ...store.getMeta(),
      sync: syncState,
      scoreTables: {
        source: scoreTables.source || 'local',
        updatedAt: scoreTables.updatedAt || null,
        note: scoreTables.note || null
      }
    });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/sync/status') {
    sendJson(res, 200, syncState);
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/sync') {
    const body = await parseBody(req);
    syncEqb(body.cookie || DEFAULT_EQB_COOKIE, body.resume !== false).catch(() => {});
    sendJson(res, 202, { ok: true, status: 'running', sync: syncState });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/questions') {
    await loadStore();
    const filters = {
      assessment: searchParams.get('assessment') || '',
      test: searchParams.get('test') || '',
      domains: searchParams.getAll('domains'),
      difficulty: searchParams.getAll('difficulty'),
      excludeActive: searchParams.get('excludeActive') !== 'false',
      neverSeenBefore: searchParams.get('neverSeenBefore') === 'true',
      stateCd: searchParams.get('stateCd') || '',
      search: searchParams.get('search') || '',
      skill: searchParams.get('skill') || ''
    };
    const limit = Number(searchParams.get('limit') || 24);
    const rows = store.listQuestions(filters).slice(0, limit);
    sendJson(res, 200, rows.map(applyQuestionTransforms));
    return true;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/questions/') && pathname.endsWith('/history')) {
    await loadStore();
    const externalId = decodeURIComponent(pathname.replace('/api/questions/', '').replace('/history', ''));
    sendJson(res, 200, store.getQuestionHistory(externalId));
    return true;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/questions/')) {
    await loadStore();
    const externalId = decodeURIComponent(pathname.replace('/api/questions/', ''));
    const row = store.getQuestionByExternalId(externalId);
    if (!row) {
      sendJson(res, 404, { error: 'Question not found' });
      return true;
    }
    sendJson(res, 200, applyQuestionTransforms(row));
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/generate') {
    await loadStore();
    const body = await parseBody(req);
    const seed = body.seed || 'sat-generator';
    const mode = body.mode || 'practice';
    const sourceFilters = mode === 'full-test'
      ? {
          ...body,
          test: '',
          domains: []
        }
      : body;
    const allQuestions = store.listQuestions(sourceFilters);
    const output = mode === 'full-test'
      ? buildFullTest(allQuestions, body)
      : buildPracticeSet(allQuestions, body);
    const score = scoreSet(output.items, getCurrentScoreTables(), {
      showEstimate: mode === 'full-test'
        && Number(output.summary?.rwCount || 0) >= Number(body.fullTestCountRw || 54)
        && Number(output.summary?.mathCount || 0) >= Number(body.fullTestCountMath || 44)
    });
    const setId = `set_${sha256Hex(`${seed}:${mode}:${Date.now()}`).slice(0, 12)}`;
    const set = {
      id: setId,
      name: body.name || (mode === 'full-test' ? 'Full SAT test' : 'Practice set'),
      mode,
      seed,
      config: body,
      summary: output.summary,
      score,
      items: output.items.map(applyQuestionTransforms),
      created_at: nowIso()
    };
    store.saveGeneratedSet(set);
    sendJson(res, 200, set);
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/sets') {
    await loadStore();
    sendJson(res, 200, store.listGeneratedSets());
    return true;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/sets/') && pathname.endsWith('/export.json')) {
    await loadStore();
    const id = pathname.split('/')[3];
    const set = store.getGeneratedSet(id);
    if (!set) {
      sendJson(res, 404, { error: 'Set not found' });
      return true;
    }
    sendJson(res, 200, set);
    return true;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/sets/') && pathname.endsWith('/export.csv')) {
    await loadStore();
    const id = pathname.split('/')[3];
    const set = store.getGeneratedSet(id);
    if (!set) {
      sendJson(res, 404, { error: 'Set not found' });
      return true;
    }
    const csv = toCsv(set.items || []);
    send(res, 200, csv, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${id}.csv"`
    });
    return true;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/sets/') && pathname.endsWith('/export.pdf')) {
    await loadStore();
    const id = pathname.split('/')[3];
    const set = store.getGeneratedSet(id);
    if (!set) {
      sendJson(res, 404, { error: 'Set not found' });
      return true;
    }
    try {
      const pdf = await renderPdfBuffer(set, getCurrentScoreTables());
      send(res, 200, pdf, {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${id}.pdf"`
      });
    } catch (error) {
      sendJson(res, 500, { error: error.message || String(error) });
    }
    return true;
  }

  return false;
}

function staticCacheHeaders(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') {
    return { 'cache-control': 'no-store' };
  }
  if (SERVE_DIST && ['.js', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.pdf'].includes(ext)) {
    return { 'cache-control': 'public, max-age=31536000, immutable' };
  }
  return { 'cache-control': 'no-store' };
}

function sendStaticFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = mimeTypes[ext] || 'application/octet-stream';
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => send(res, 404, 'Not found', {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  }));
  res.writeHead(200, {
    'content-type': mimeType,
    ...staticCacheHeaders(filePath)
  });
  stream.pipe(res);
}

function handleStatic(req, res, pathname) {
  const target = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = path.join(STATIC_DIR, target);
  if (!candidate.startsWith(STATIC_DIR)) return false;
  if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) return false;
  sendStaticFile(res, candidate);
  return true;
}

function handleAsset(req, res, pathname) {
  if (!pathname.startsWith('/assets/') && !pathname.startsWith('/data/')) return false;
  const root = SERVE_DIST ? path.join(DIST_DIR, 'data') : DATA_DIR;
  const relative = pathname.startsWith('/assets/')
    ? path.join('assets', pathname.slice('/assets/'.length))
    : pathname.slice('/data/'.length);
  const candidate = path.join(root, relative);
  if (!candidate.startsWith(root)) return false;
  if (!fs.existsSync(candidate)) return false;
  sendStaticFile(res, candidate);
  return true;
}

function handleVendor(req, res, pathname) {
  if (!pathname.startsWith('/vendor/')) return false;
  const vendorRoot = SERVE_DIST ? path.join(DIST_DIR, 'vendor') : VENDOR_DIR;
  const candidate = path.join(vendorRoot, pathname.slice('/vendor/'.length));
  if (!candidate.startsWith(vendorRoot)) return false;
  if (!fs.existsSync(candidate) || fs.statSync(candidate).isDirectory()) return false;
  sendStaticFile(res, candidate);
  return true;
}

async function main() {
  await loadStore();
  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      if (await handleApi(req, res, urlObj)) return;
      if (handleAsset(req, res, urlObj.pathname)) return;
      if (handleVendor(req, res, urlObj.pathname)) return;
      if (handleStatic(req, res, urlObj.pathname)) return;
      send(res, 404, 'Not found', {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
      });
    } catch (error) {
      sendJson(res, 500, { error: error.stack || error.message || String(error) });
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`SAT Generator running on http://${HOST}:${PORT}`);
  });

  if (process.argv.includes('--sync')) {
    try {
      await syncEqb('', true);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
