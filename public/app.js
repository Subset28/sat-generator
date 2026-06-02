import { createDemoRuntime } from './demo-runtime.js';

const app = document.querySelector('#app');
const APP_CONFIG = window.SAT_APP_CONFIG || {};
const IS_DEMO = String(APP_CONFIG.mode || '').toLowerCase() === 'demo';
const BUILD_ID = String(APP_CONFIG.buildId || 'dev');
const DEMO_DATA_URL = APP_CONFIG.demoDataUrl || './data/demo-data.json';
const SCORE_TABLES_URL = APP_CONFIG.scoreTablesUrl || './data/score-tables.json';
const DESMOS_API_KEY = 'REDACTED_KEY';
const DESMOS_SCRIPT_SRC = `https://www.desmos.com/api/v1.12/calculator.js?apiKey=${DESMOS_API_KEY}`;

const state = {
  meta: null,
  questions: [],
  generated: null,
  testAttempt: null,
  demoRuntime: null,
  scoreTables: null,
  tab: 'library',
  sync: null,
  uiNotice: '',
  ui: {
    loading: {
      refresh: false,
      sync: false,
      generate: false,
      initial: true
    }
  },
  practice: {
    currentIndex: 0,
    responses: {},
    markedForReview: new Set(),
    moduleFlow: null,
    stageIndex: 0,
    navOpen: false,
    showDirections: false,
    reviewReady: false,
    resultsTab: 'all',
    showCorrectAnswers: false,
    viewSize: 10,
    page: 1,
    sortKey: 'number',
    sortDir: 'asc',
    reviewModal: {
      open: false,
      questionNumber: null,
      showExplanation: false
    },
    timerHidden: false,
    timer: {
      minutes: 30,
      remainingMs: 30 * 60 * 1000,
      running: false,
      completed: false,
      startedAt: null,
      lastTickAt: null
    }
  },
  calculator: {
    open: false,
    loading: false,
    ready: false,
    error: '',
    mode: 'graphing'
  },
  reference: {
    open: false
  },
  filters: {
    assessment: IS_DEMO ? '100' : '99',
    test: '1',
    domains: new Set(['INI', 'CAS', 'EOI', 'SEC']),
    difficulty: new Set(['E', 'M', 'H']),
    excludeActive: true,
    neverSeenBefore: false,
    stateCd: '',
    search: '',
    skill: '',
    limit: 24,
    seed: 'sat-01',
    mode: 'practice',
    practiceOnlyHard: false,
    practiceTimerMinutes: 30,
    fullTestCountRw: 54,
    fullTestCountMath: 44
  }
};

const dom = {
  libraryList: null,
  generatedList: null,
  syncLog: null,
  calculatorOverlay: null,
  calculatorHost: null,
  referenceOverlay: null
};

let practiceTimerHandle = null;
let desmosLoadPromise = null;
let desmosInstance = null;
let demoRuntimePromise = null;
let scoreTablesPromise = null;

const difficultyLabel = {
  E: 'Easy',
  M: 'Medium',
  H: 'Hard'
};

const scoreDetailsDomainMeta = {
  'Reading and Writing': {
    'Information and Ideas': '26% of test section, 12 - 14 questions',
    'Craft and Structure': '28% of test section, 13 - 15 questions',
    'Expression of Ideas': '20% of test section, 8 - 12 questions',
    'Standard English Conventions': '26% of test section, 11 - 15 questions'
  },
  Math: {
    Algebra: '35% of test section, 13 - 15 questions',
    'Advanced Math': '35% of test section, 13 - 15 questions',
    'Problem-Solving and Data Analysis': '15% of test section, 5 - 7 questions',
    'Geometry and Trigonometry': '15% of test section, 5 - 7 questions'
  }
};

function defaultDomainsForTest(testId) {
  return new Set(String(testId) === '2' ? ['H', 'P', 'Q', 'S'] : ['INI', 'CAS', 'EOI', 'SEC']);
}

function sortQuestionsByDifficulty(rows, order = ['H', 'M', 'E']) {
  const rank = new Map(order.map((code, index) => [code, index]));
  return rows.slice().sort((a, b) => {
    const left = rank.get(String(a.difficulty || '').toUpperCase()) ?? 99;
    const right = rank.get(String(b.difficulty || '').toUpperCase()) ?? 99;
    if (left !== right) return left - right;
    return String(a.external_id || '').localeCompare(String(b.external_id || ''));
  });
}

function html(strings, ...values) {
  return strings.reduce((acc, part, i) => acc + part + (values[i] ?? ''), '');
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setLoadingState(key, value) {
  if (!state.ui?.loading) return;
  state.ui.loading[key] = Boolean(value);
}

function isBusy(key) {
  return Boolean(state.ui?.loading?.[key]);
}

function isAnyBusy() {
  return Object.values(state.ui?.loading || {}).some(Boolean);
}

function currentLoadingMessage() {
  if (isBusy('initial')) return 'Loading your SAT workspace...';
  if (isBusy('sync')) return 'Syncing the question bank...';
  if (isBusy('generate')) return state.tab === 'fulltest'
    ? 'Building your full SAT test...'
    : 'Building your practice session...';
  if (isBusy('refresh')) return 'Refreshing questions...';
  return '';
}

function formatAttemptDate(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}

async function getScoreTables() {
  if (state.scoreTables) return state.scoreTables;
  if (!scoreTablesPromise) {
    scoreTablesPromise = fetch(SCORE_TABLES_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load score tables (${response.status})`);
        return response.json();
      })
      .then((data) => {
        state.scoreTables = data;
        return data;
      });
  }
  return scoreTablesPromise;
}

function lookupScaledFromTable(rawScore, tableRows = []) {
  const rows = tableRows.map((row) => Array.isArray(row) ? row : [row.raw, row.lower, row.upper]);
  const exact = rows.find((entry) => Number(entry[0]) === Number(rawScore));
  if (exact) return Math.round((Number(exact[1]) + Number(exact[2])) / 2);
  const sorted = rows.slice().sort((a, b) => Number(a[0]) - Number(b[0]));
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
      const leftMid = (Number(left[1]) + Number(left[2])) / 2;
      const rightMid = (Number(right[1]) + Number(right[2])) / 2;
      const ratio = (rawScore - Number(left[0])) / (Number(right[0]) - Number(left[0]));
      return Math.round(leftMid + ratio * (rightMid - leftMid));
    }
  }
  return null;
}

function buildFullTestModuleFlow(items = []) {
  const rw = items.filter((item) => String(item.test_id || item.testId || item.test) === '1');
  const math = items.filter((item) => String(item.test_id || item.testId || item.test) === '2');
  const rw1 = rw.slice(0, 27);
  const rw2Pool = rw.slice(27, 54);
  const math1 = math.slice(0, 22);
  const math2Pool = math.slice(22, 44);
  return {
    stages: [
      {
        id: 'rw1',
        type: 'module',
        section: 'Reading and Writing',
        moduleNumber: 1,
        durationMinutes: 32,
        items: rw1,
        locked: false,
        submitted: false
      },
      {
        id: 'rw2',
        type: 'module',
        section: 'Reading and Writing',
        moduleNumber: 2,
        durationMinutes: 32,
        items: [],
        variants: {
          hard: sortQuestionsByDifficulty(rw2Pool, ['H', 'M', 'E']),
          easy: sortQuestionsByDifficulty(rw2Pool, ['E', 'M', 'H'])
        },
        adaptiveFrom: 'rw1',
        locked: true,
        submitted: false
      },
      {
        id: 'break',
        type: 'break',
        durationMinutes: 10
      },
      {
        id: 'math1',
        type: 'module',
        section: 'Math',
        moduleNumber: 1,
        durationMinutes: 35,
        items: math1,
        locked: true,
        submitted: false
      },
      {
        id: 'math2',
        type: 'module',
        section: 'Math',
        moduleNumber: 2,
        durationMinutes: 35,
        items: [],
        variants: {
          hard: sortQuestionsByDifficulty(math2Pool, ['H', 'M', 'E']),
          easy: sortQuestionsByDifficulty(math2Pool, ['E', 'M', 'H'])
        },
        adaptiveFrom: 'math1',
        locked: true,
        submitted: false
      }
    ]
  };
}

function buildTestAttempt(result) {
  const items = (result?.items || []).map((item, index) => ({
    ...item,
    id: item.external_id || item.id || `q_${index + 1}`,
    domain: item.domainText || item.primary_class_cd_desc || 'Unknown domain',
    difficulty: item.difficulty || 'E',
    correctAnswer: Array.isArray(item.correctAnswer) ? item.correctAnswer.slice() : [item.correctAnswer].filter(Boolean),
    correctLetters: normalizeAnswerTokens(item.correctAnswer).map((entry) => entry.trim().toUpperCase()).filter(Boolean),
    userAnswer: null,
    isCorrect: null
  }));
  const moduleFlow = buildFullTestModuleFlow(items);
  const sectionByName = {
    'Reading and Writing': [],
    Math: []
  };
  for (const stage of moduleFlow.stages) {
    if (stage.type !== 'module') continue;
    const section = sectionByName[stage.section];
    if (!section) continue;
    section.push({
      id: stage.id,
      name: `Module ${stage.moduleNumber}`,
      moduleNumber: stage.moduleNumber,
      durationMinutes: stage.durationMinutes,
      locked: stage.locked,
      questions: stage.items || []
    });
  }
  return {
    id: result?.id || `attempt-${Date.now()}`,
    testName: result?.name || 'SAT Practice Test',
    date: result?.created_at || new Date().toISOString(),
    status: 'inProgress',
    score: null,
    sections: [
      { name: 'Reading and Writing', modules: sectionByName['Reading and Writing'] },
      { name: 'Math', modules: sectionByName.Math }
    ],
    timeline: moduleFlow.stages,
    questions: items
  };
}

function getAttemptQuestions() {
  return Array.isArray(state.testAttempt?.questions) ? state.testAttempt.questions : [];
}

function getAttemptQuestion(externalId) {
  if (!externalId) return null;
  return getAttemptQuestions().find((question) => String(question.external_id || question.id) === String(externalId)) || null;
}

function normalizeAnswerTokens(value) {
  return Array.isArray(value)
    ? value.flatMap((entry) => String(entry).split(/[,\s]+/))
    : String(value ?? '').split(/[,\s]+/);
}

function answersMatch(userAnswer, correctAnswer) {
  const userTokens = normalizeAnswerTokens(userAnswer).map((item) => item.trim().toUpperCase()).filter(Boolean);
  const correctTokens = normalizeAnswerTokens(correctAnswer).map((item) => item.trim().toUpperCase()).filter(Boolean);
  if (!userTokens.length) return false;
  if (!correctTokens.length) return false;
  if (userTokens.length === 1 && correctTokens.length === 1) return userTokens[0] === correctTokens[0];
  return userTokens.length === correctTokens.length && userTokens.every((token) => correctTokens.includes(token));
}

function gradeTest(testAttempt) {
  const questions = Array.isArray(testAttempt?.questions) ? testAttempt.questions : [];
  const answeredQuestions = questions.filter((question) => {
    const value = question.userAnswer;
    return value != null && String(value).trim() !== '';
  }).length;
  if (answeredQuestions === 0) {
    return { ok: false, warning: 'No answers submitted' };
  }
  for (const question of questions) {
    const userAnswer = question.userAnswer == null || String(question.userAnswer).trim() === '' ? null : question.userAnswer;
    question.userAnswer = userAnswer;
    question.isCorrect = Boolean(userAnswer) ? answersMatch(userAnswer, question.correctAnswer) : false;
  }
  testAttempt.status = 'submitted';
  const rawRw = questions.filter((question) => String(question.test_id || question.testId || question.test) === '1' && question.isCorrect).length;
  const rawMath = questions.filter((question) => String(question.test_id || question.testId || question.test) === '2' && question.isCorrect).length;
  const rawTotal = rawRw + rawMath;
  const scoreTables = state.scoreTables || {};
  const estimatedRw = lookupScaledFromTable(rawRw, scoreTables.rw || []);
  const estimatedMath = lookupScaledFromTable(rawMath, scoreTables.math || []);
  testAttempt.score = {
    raw_total: rawTotal,
    raw_rw: rawRw,
    raw_math: rawMath,
    estimated_rw: estimatedRw,
    estimated_math: estimatedMath,
    estimated_total: Number.isFinite(estimatedRw) && Number.isFinite(estimatedMath) ? estimatedRw + estimatedMath : null
  };
  return { ok: true, testAttempt };
}

function setHashTab(tab) {
  location.hash = `#${tab}`;
}

function activeTabFromHash() {
  return ['library', 'builder', 'fulltest', 'exports'].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : 'builder';
}

function normalizePracticeMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 30;
  return Math.min(180, Math.max(1, Math.round(minutes)));
}

function getAvailableQuestionSlices() {
  return Array.isArray(state.meta?.availableQuestionSlices) ? state.meta.availableQuestionSlices : [];
}

function hasAvailableQuestionSlice(assessmentId, testId) {
  return getAvailableQuestionSlices().some((row) => (
    String(row.assessment_id) === String(assessmentId)
    && String(row.test_id) === String(testId)
    && Number(row.count || 0) > 0
  ));
}

function findFallbackQuestionSlice(preferredAssessmentId = state.filters.assessment) {
  const slices = getAvailableQuestionSlices().filter((row) => Number(row.count || 0) > 0);
  return slices.find((row) => String(row.assessment_id) === String(preferredAssessmentId)) || slices[0] || null;
}

function alignFiltersToAvailableQuestions() {
  if (hasAvailableQuestionSlice(state.filters.assessment, state.filters.test)) {
    return false;
  }
  const fallback = findFallbackQuestionSlice(state.filters.assessment);
  if (!fallback) {
    return false;
  }
  const previousAssessment = state.filters.assessment;
  const previousTest = state.filters.test;
  state.filters.assessment = String(fallback.assessment_id);
  state.filters.test = String(fallback.test_id);
  state.filters.domains = defaultDomainsForTest(fallback.test_id);
  if (String(previousAssessment) !== state.filters.assessment || String(previousTest) !== state.filters.test) {
    state.uiNotice = `Switched to ${fallback.assessment_text} ${fallback.test_text} because the previous selection has no cached questions.`;
    return true;
  }
  return false;
}

function formatDuration(totalMs) {
  const safeMs = Math.max(0, Number(totalMs) || 0);
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDateLabel(value) {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}

function clearPracticeTimer() {
  if (practiceTimerHandle) {
    clearInterval(practiceTimerHandle);
    practiceTimerHandle = null;
  }
}

function resetPracticeTimer(minutes = state.filters.practiceTimerMinutes) {
  const normalized = normalizePracticeMinutes(minutes);
  state.practice.timer = {
    minutes: normalized,
    remainingMs: normalized * 60 * 1000,
    running: false,
    completed: false,
    startedAt: null,
    lastTickAt: null
  };
  clearPracticeTimer();
  state.practice.timerHidden = false;
}

function finishPracticeTimer() {
  state.practice.timer.running = false;
  state.practice.timer.completed = true;
  state.practice.timer.remainingMs = 0;
  state.practice.timer.lastTickAt = Date.now();
  clearPracticeTimer();
  if (isFullTestMode() && state.testAttempt?.status !== 'submitted') {
    advanceFullTestFlow(true);
  }
}

function updatePracticeTimerDisplay() {
  const timer = state.practice.timer;
  const timerText = state.practice.timerHidden ? '••:••' : formatDuration(timer.remainingMs);
  const timerClass = timer.remainingMs <= 60_000 ? 'danger' : timer.remainingMs <= 300_000 ? 'warn' : '';
  document.querySelectorAll('.sat-timer').forEach((element) => {
    element.textContent = timerText;
    element.classList.remove('danger', 'warn');
    if (timerClass) element.classList.add(timerClass);
  });
  const breakTimer = document.querySelector('.sat-break-timer');
  if (breakTimer) {
    breakTimer.textContent = formatDuration(timer.remainingMs);
  }
  const hideButton = document.querySelector('.sat-hide-btn');
  if (hideButton) {
    hideButton.textContent = state.practice.timerHidden ? 'Show' : 'Hide';
  }
}

function tickPracticeTimer() {
  if (!isPracticeMode()) {
    clearPracticeTimer();
    return;
  }
  if (!state.practice.timer.running) return;
  const now = Date.now();
  const lastTickAt = state.practice.timer.lastTickAt || now;
  const delta = Math.max(0, now - lastTickAt);
  state.practice.timer.remainingMs = Math.max(0, state.practice.timer.remainingMs - delta);
  state.practice.timer.lastTickAt = now;
  if (state.practice.timer.remainingMs <= 0) {
    finishPracticeTimer();
    renderGenerated();
    return;
  }
  updatePracticeTimerDisplay();
}

function startPracticeTimer() {
  if (!isPracticeMode()) return;
  if (state.practice.timer.completed) return;
  if (state.practice.timer.running) return;
  state.practice.timer.running = true;
  state.practice.timer.startedAt = Date.now();
  state.practice.timer.lastTickAt = Date.now();
  if (!practiceTimerHandle) {
    practiceTimerHandle = setInterval(tickPracticeTimer, 1000);
  }
  updatePracticeTimerDisplay();
}

function pausePracticeTimer() {
  if (!state.practice.timer.running) return;
  tickPracticeTimer();
  state.practice.timer.running = false;
  clearPracticeTimer();
  updatePracticeTimerDisplay();
}

function setPracticeSetState(result) {
  state.generated = result;
  state.testAttempt = null;
  state.practice.currentIndex = 0;
  state.practice.responses = {};
  state.practice.markedForReview = new Set();
  state.practice.moduleFlow = isFullTestMode() || result?.mode === 'full-test' ? buildFullTestModuleFlow(result.items || []) : null;
  if (isFullTestMode() || result?.mode === 'full-test') {
    state.testAttempt = buildTestAttempt(result);
    state.practice.moduleFlow = { stages: state.testAttempt.timeline };
  }
  state.practice.stageIndex = 0;
  state.practice.showDirections = false;
  state.practice.navOpen = false;
  state.practice.reviewReady = false;
  state.practice.resultsTab = 'all';
  state.practice.showCorrectAnswers = false;
  state.practice.viewSize = 10;
  state.practice.page = 1;
  state.practice.sortKey = 'number';
  state.practice.sortDir = 'asc';
  state.practice.reviewModal = {
    open: false,
    questionNumber: null,
    showExplanation: false
  };
  const firstStage = getCurrentStage();
  resetPracticeTimer(firstStage?.durationMinutes || state.filters.practiceTimerMinutes);
  if (result?.mode === 'practice' || result?.mode === 'full-test') {
    startPracticeTimer();
  }
}

function ensureCalculatorOverlay() {
  let overlay = document.querySelector('#desmosOverlay');
  if (overlay) {
    dom.calculatorOverlay = overlay;
    dom.calculatorHost = overlay.querySelector('#desmosHost');
    return overlay;
  }

  overlay = document.createElement('div');
  overlay.id = 'desmosOverlay';
  overlay.className = 'desmos-overlay hidden';
  overlay.innerHTML = `
    <div class="desmos-shell">
      <button class="desmos-close" type="button" aria-label="Close calculator" data-action="calculator-close">✕</button>
      <div class="desmos-status" aria-live="polite"></div>
      <div id="desmosHost" class="desmos-host"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  dom.calculatorOverlay = overlay;
  dom.calculatorHost = overlay.querySelector('#desmosHost');
  return overlay;
}

function destroyDesmosCalculator() {
  if (desmosInstance?.destroy) {
    try {
      desmosInstance.destroy();
    } catch {
      // Ignore destroy failures during teardown.
    }
  }
  desmosInstance = null;
  state.calculator.ready = false;
}

function loadDesmosScript() {
  if (window.Desmos?.GraphingCalculator) return Promise.resolve(window.Desmos);
  if (desmosLoadPromise) return desmosLoadPromise;

  desmosLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-desmos-api="true"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Desmos));
      existing.addEventListener('error', () => reject(new Error('Failed to load Desmos calculator.')));
      return;
    }

    const script = document.createElement('script');
    script.src = DESMOS_SCRIPT_SRC;
    script.async = true;
    script.dataset.desmosApi = 'true';
    script.onload = () => resolve(window.Desmos);
    script.onerror = () => reject(new Error('Failed to load Desmos calculator.'));
    document.head.appendChild(script);
  });

  return desmosLoadPromise;
}

async function mountDesmosCalculator() {
  const overlay = ensureCalculatorOverlay();
  overlay.classList.remove('hidden');
  state.calculator.loading = true;
  state.calculator.error = '';
  const status = overlay.querySelector('.desmos-status');
  if (status) status.textContent = 'Loading Desmos Graphing Calculator...';

  try {
    await loadDesmosScript();
    if (!dom.calculatorHost) {
      dom.calculatorHost = overlay.querySelector('#desmosHost');
    }
    if (!desmosInstance && dom.calculatorHost) {
      desmosInstance = window.Desmos.GraphingCalculator(dom.calculatorHost, {
        graphpaper: true,
        expressions: true,
        settingsMenu: true,
        zoomButtons: true,
        keypad: true,
        images: false,
        folders: false,
        notes: false,
        links: false,
        actions: 'auto',
        substitutions: true
      });
    }
    if (desmosInstance?.resize) {
      desmosInstance.resize();
    }
    state.calculator.ready = true;
    if (status) status.textContent = 'Desmos Graphing Calculator';
  } catch (error) {
    state.calculator.error = error.message || String(error);
    if (status) status.textContent = state.calculator.error;
  } finally {
    state.calculator.loading = false;
    renderGenerated();
  }
}

function openCalculator() {
  state.calculator.open = true;
  ensureCalculatorOverlay();
  renderGenerated();
  mountDesmosCalculator();
}

function closeCalculator() {
  state.calculator.open = false;
  const overlay = ensureCalculatorOverlay();
  overlay.classList.add('hidden');
  renderGenerated();
}

function toggleCalculator() {
  if (state.calculator.open) {
    closeCalculator();
  } else {
    openCalculator();
  }
}

function ensureReferenceOverlay() {
  let overlay = document.querySelector('#referenceOverlay');
  if (overlay) {
    dom.referenceOverlay = overlay;
    return overlay;
  }

  overlay = document.createElement('div');
  overlay.id = 'referenceOverlay';
  overlay.className = 'reference-overlay hidden';
  overlay.innerHTML = `
    <div class="reference-shell">
      <button class="reference-close" type="button" aria-label="Close reference sheet" data-action="reference-close">✕</button>
      <div class="reference-sheet">
        <div class="reference-title">Reference Sheet</div>
        <div class="reference-grid">
          <section class="reference-block">
            <div class="ref-diagram circle">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <circle cx="46" cy="46" r="35"></circle>
                <circle cx="46" cy="46" r="3.2" fill="currentColor"></circle>
                <line x1="46" y1="46" x2="78" y2="46"></line>
                <text x="64" y="41">r</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>A = πr²</div>
              <div>C = 2πr</div>
            </div>
          </section>
          <section class="reference-block">
            <div class="ref-diagram rectangle">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <rect x="18" y="25" width="70" height="38"></rect>
                <line x1="53" y1="25" x2="53" y2="16"></line>
                <line x1="88" y1="44" x2="100" y2="44"></line>
                <text x="47" y="14">l</text>
                <text x="105" y="48">w</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>A = lw</div>
            </div>
          </section>
          <section class="reference-block">
            <div class="ref-diagram triangle">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <polygon points="16,64 48,16 94,64"></polygon>
                <line x1="48" y1="16" x2="48" y2="64"></line>
                <line x1="48" y1="51" x2="57" y2="51"></line>
                <text x="52" y="37">h</text>
                <text x="53" y="78">b</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>A = 1/2 bh</div>
            </div>
          </section>
          <section class="reference-block">
            <div class="ref-diagram pythag">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <polygon points="18,66 66,18 66,66"></polygon>
                <path d="M66 50 L56 50 L56 60" fill="none"></path>
                <text x="33" y="80">a</text>
                <text x="52" y="48">b</text>
                <text x="72" y="38">c</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>c² = a² + b²</div>
            </div>
          </section>
          <section class="reference-block special">
            <div class="ref-diagram special-right-triangles">
              <svg viewBox="0 0 180 92" aria-hidden="true">
                <polygon points="14,66 86,22 86,66"></polygon>
                <path d="M86 22 L86 66 L14 66" fill="none"></path>
                <text x="41" y="80">30°</text>
                <text x="70" y="34">60°</text>
                <text x="92" y="48">x</text>
                <text x="52" y="22">2x</text>
                <text x="66" y="76">x√3</text>
                <polygon points="108,66 158,66 108,16"></polygon>
                <path d="M108 66 L108 16 L158 66" fill="none"></path>
                <text x="119" y="50">45°</text>
                <text x="145" y="50">45°</text>
                <text x="105" y="80">s</text>
                <text x="148" y="12">s√2</text>
                <text x="102" y="22">s</text>
              </svg>
            </div>
            <div class="ref-formulas special-caption">Special Right Triangles</div>
          </section>
          <section class="reference-block">
            <div class="ref-diagram prism">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <rect x="18" y="34" width="58" height="36"></rect>
                <polygon points="18,34 38,18 96,18 76,34"></polygon>
                <polygon points="76,34 96,18 96,54 76,70"></polygon>
                <line x1="18" y1="70" x2="76" y2="70"></line>
                <text x="45" y="88">l</text>
                <text x="82" y="56">h</text>
                <text x="91" y="43">w</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>V = lwh</div>
            </div>
          </section>
          <section class="reference-block">
            <div class="ref-diagram cylinder">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <ellipse cx="58" cy="24" rx="30" ry="10"></ellipse>
                <path d="M28 24 v34 c0 6 13 10 30 10s30-4 30-10V24"></path>
                <line x1="58" y1="24" x2="58" y2="14"></line>
                <circle cx="58" cy="24" r="3" fill="currentColor"></circle>
                <text x="67" y="21">r</text>
                <text x="91" y="58">h</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>V = πr²h</div>
            </div>
          </section>
          <section class="reference-block">
            <div class="ref-diagram sphere">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <circle cx="60" cy="44" r="34"></circle>
                <path d="M26 44c10 12 24 18 34 18s24-6 34-18" fill="none" stroke-dasharray="4 4"></path>
                <path d="M26 44c10-12 24-18 34-18s24 6 34 18" fill="none"></path>
                <circle cx="60" cy="44" r="3" fill="currentColor"></circle>
                <line x1="60" y1="44" x2="88" y2="44"></line>
                <text x="73" y="40">r</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>V = 4/3 πr³</div>
            </div>
          </section>
          <section class="reference-block">
            <div class="ref-diagram cone">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <path d="M22 66 L60 16 L98 66 Z"></path>
                <path d="M30 62c10-7 50-7 60 0" fill="none" stroke-dasharray="4 4"></path>
                <line x1="60" y1="16" x2="60" y2="66"></line>
                <line x1="60" y1="41" x2="77" y2="41"></line>
                <circle cx="60" cy="41" r="2.8" fill="currentColor"></circle>
                <text x="66" y="36">r</text>
                <text x="67" y="48">h</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>V = 1/3 πr²h</div>
            </div>
          </section>
          <section class="reference-block">
            <div class="ref-diagram pyramid">
              <svg viewBox="0 0 120 92" aria-hidden="true">
                <polygon points="20,68 56,16 100,44 76,68"></polygon>
                <polygon points="20,68 56,16 56,56"></polygon>
                <polygon points="56,16 100,44 76,68"></polygon>
                <line x1="56" y1="16" x2="56" y2="68"></line>
                <line x1="56" y1="43" x2="70" y2="43"></line>
                <text x="43" y="76">l</text>
                <text x="63" y="35">h</text>
                <text x="88" y="62">w</text>
              </svg>
            </div>
            <div class="ref-formulas">
              <div>V = 1/3 lwh</div>
            </div>
          </section>
        </div>
        <div class="reference-footer">
          <div>The number of degrees of arc in a circle is 360.</div>
          <div>The number of radians of arc in a circle is 2π.</div>
          <div>The sum of the measures in degrees of the angles of a triangle is 180.</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  dom.referenceOverlay = overlay;
  return overlay;
}

function openReferenceSheet() {
  state.reference.open = true;
  const overlay = ensureReferenceOverlay();
  overlay.classList.remove('hidden');
  renderGenerated();
}

function closeReferenceSheet() {
  state.reference.open = false;
  const overlay = ensureReferenceOverlay();
  overlay.classList.add('hidden');
  renderGenerated();
}

function toggleReferenceSheet() {
  if (state.reference.open) {
    closeReferenceSheet();
  } else {
    openReferenceSheet();
  }
}

function isPracticeMode() {
  return state.generated?.mode === 'practice' || state.generated?.mode === 'full-test';
}

function isFullTestMode() {
  return state.generated?.mode === 'full-test';
}

function getCurrentStage() {
  return state.practice.moduleFlow?.stages?.[state.practice.stageIndex] || null;
}

function getCurrentModuleItems() {
  const stage = getCurrentStage();
  if (!stage || stage.type !== 'module') return [];
  return Array.isArray(stage.items) ? stage.items : [];
}

function isBreakStage() {
  return getCurrentStage()?.type === 'break';
}

function getStageById(id) {
  return state.practice.moduleFlow?.stages?.find((stage) => stage.id === id) || null;
}

function getFullTestModuleAccuracy(stage) {
  const items = stage?.items || [];
  if (!items.length) return 0;
  const correct = items.reduce((count, item) => {
    const response = getPracticeResponse(item.external_id);
    if (!response.selected) return count;
    const correctLetters = getCorrectLetters(item);
    const selectedChoice = findSelectedChoice(item, response);
    const selectedIndex = (item.answerOptions || []).findIndex((choice, index) => getChoiceLetter(choice, index) === response.selected);
    return count + (selectedChoice && choiceMatchesCorrect(selectedChoice, selectedIndex, correctLetters) ? 1 : 0);
  }, 0);
  return correct / items.length;
}

function unlockNextAdaptiveModule(stage) {
  if (!stage?.adaptiveFrom || !stage.variants) return;
  const sourceStage = getStageById(stage.adaptiveFrom);
  const accuracy = getFullTestModuleAccuracy(sourceStage);
  stage.items = accuracy > 0.75 ? stage.variants.hard.slice() : stage.variants.easy.slice();
  stage.locked = false;
}

function openNextStage(index) {
  const nextStage = state.practice.moduleFlow?.stages?.[index] || null;
  if (!nextStage) {
    submitPracticeTest();
    return;
  }
  if (nextStage.type === 'module') {
    if (nextStage.variants && !nextStage.items.length) {
      unlockNextAdaptiveModule(nextStage);
    } else {
      nextStage.locked = false;
    }
  }
  state.practice.stageIndex = index;
  state.practice.currentIndex = 0;
  resetPracticeTimer(nextStage.durationMinutes || state.filters.practiceTimerMinutes);
  startPracticeTimer();
  render();
}

function advanceFullTestFlow(auto = false) {
  if (!isFullTestMode() || !state.practice.moduleFlow) return;
  const stage = getCurrentStage();
  if (!stage) return;
  if (stage.type === 'break') {
    openNextStage(state.practice.stageIndex + 1);
    return;
  }
  for (const item of stage.items || []) {
    const response = getPracticeResponse(item.external_id);
    response.submitted = true;
  }
  stage.submitted = true;
  stage.locked = true;
  if (!auto) {
    clearPracticeTimer();
  }
  openNextStage(state.practice.stageIndex + 1);
}

function getPracticeSubjectLabel(current) {
  if (current?.testText) return current.testText;
  if (String(current?.test || state.filters.test || '') === '2') return 'Math';
  return 'Reading and Writing';
}

function getPracticeSectionNumber(currentIndex) {
  return currentIndex >= Math.ceil((state.generated?.items?.length || 1) / 2) ? 2 : 1;
}

function getPracticeDirectionsText() {
  const subject = getPracticeSubjectLabel(getCurrentPracticeQuestion());
  return subject === 'Math'
    ? 'For each question, choose the best answer. You may use your calculator on approved questions. Some questions include an embedded reference panel.'
    : 'For each question, choose the best answer. Some questions include notes, passages, or paired information. You may use the provided tools when available.';
}

function togglePracticeReview() {
  const current = getCurrentPracticeQuestion();
  if (!current) return;
  const id = current.external_id;
  if (state.practice.markedForReview.has(id)) {
    state.practice.markedForReview.delete(id);
  } else {
    state.practice.markedForReview.add(id);
  }
  renderGenerated();
}

function togglePracticeTimerHidden() {
  state.practice.timerHidden = !state.practice.timerHidden;
  updatePracticeTimerDisplay();
}

function getCurrentPracticeQuestion() {
  const items = isFullTestMode() ? getCurrentModuleItems() : (state.generated?.items || []);
  if (!items.length) return null;
  const safeIndex = Math.min(Math.max(0, state.practice.currentIndex), items.length - 1);
  return items[safeIndex] || null;
}

function getPracticeResponse(externalId) {
  if (!externalId) {
    return { userAnswer: null, selected: null, eliminated: [], submitted: false };
  }
  if (!state.practice.responses[externalId]) {
    state.practice.responses[externalId] = {
      userAnswer: null,
      selected: null,
      eliminated: [],
      submitted: false
    };
  }
  const attemptQuestion = getAttemptQuestion(externalId);
  if (attemptQuestion) {
    state.practice.responses[externalId].userAnswer = attemptQuestion.userAnswer ?? null;
    state.practice.responses[externalId].selected = attemptQuestion.userAnswer ?? null;
    state.practice.responses[externalId].submitted = state.testAttempt?.status === 'submitted';
  }
  return state.practice.responses[externalId];
}

function getCorrectLetters(row) {
  const raw = Array.isArray(row?.correctAnswer) ? row.correctAnswer : [row?.correctAnswer].filter(Boolean);
  return raw
    .flatMap((item) => String(item).split(/[,\s]+/))
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function getChoiceLetter(choice, index) {
  return String(choice?.letter || String.fromCharCode(65 + index)).toUpperCase();
}

function choiceMatchesCorrect(choice, index, correctValues) {
  const tokens = [
    getChoiceLetter(choice, index),
    choice?.id,
    choice?.choiceId,
    choice?.answerId,
    choice?.optionId,
    choice?.externalId,
    String(index + 1)
  ]
    .filter(Boolean)
    .map((value) => String(value).trim().toUpperCase());
  return tokens.some((token) => correctValues.includes(token));
}

function findSelectedChoice(row, response) {
  if (!row?.answerOptions?.length || !response?.selected) return null;
  return row.answerOptions.find((choice, index) => getChoiceLetter(choice, index) === response.selected) || null;
}

function getAnsweredCount() {
  const items = isFullTestMode() ? getCurrentModuleItems() : (state.generated?.items || []);
  if (!items.length) return 0;
  return items.filter((item) => Boolean(getPracticeResponse(item.external_id).selected)).length;
}

function goToPracticeIndex(nextIndex) {
  const items = isFullTestMode() ? getCurrentModuleItems() : (state.generated?.items || []);
  if (!items.length) return;
  if (!isFullTestMode()) {
    submitPracticeAnswer();
  }
  const clamped = Math.min(Math.max(0, nextIndex), items.length - 1);
  state.practice.currentIndex = clamped;
  renderGenerated();
}

function togglePracticeElimination(choiceLetter) {
  const current = getCurrentPracticeQuestion();
  if (!current) return;
  const response = getPracticeResponse(current.external_id);
  const letter = String(choiceLetter || '').toUpperCase();
  if (!letter) return;
  if (response.selected === letter) {
    response.selected = null;
  }
  if (response.eliminated.includes(letter)) {
    response.eliminated = response.eliminated.filter((entry) => entry !== letter);
  } else {
    response.eliminated = [...response.eliminated, letter];
  }
  renderGenerated();
}

function selectPracticeChoice(choiceLetter) {
  const current = getCurrentPracticeQuestion();
  if (!current) return;
  const response = getPracticeResponse(current.external_id);
  const letter = String(choiceLetter || '').toUpperCase();
  if (!letter) return;
  const attemptQuestion = getAttemptQuestion(current.external_id);
  if (attemptQuestion) {
    attemptQuestion.userAnswer = letter;
    attemptQuestion.isCorrect = null;
  }
  response.userAnswer = letter;
  response.selected = letter;
  response.eliminated = response.eliminated.filter((entry) => entry !== letter);
  renderGenerated();
}

function submitPracticeAnswer() {
  const current = getCurrentPracticeQuestion();
  if (!current) return;
  const response = getPracticeResponse(current.external_id);
  response.userAnswer = response.userAnswer ?? response.selected ?? null;
  renderGenerated();
}

function submitPracticeTest() {
  if (!state.testAttempt?.questions?.length) return;
  const graded = gradeTest(state.testAttempt);
  if (!graded.ok) {
    state.uiNotice = graded.warning || 'No answers submitted';
    render();
    return;
  }
  clearPracticeTimer();
  state.practice.reviewReady = true;
  state.practice.showCorrectAnswers = false;
  state.practice.reviewModal.open = false;
  state.uiNotice = '';
  render();
}

function countPracticeCorrect() {
  const items = isFullTestMode() ? getCurrentModuleItems() : (state.generated?.items || []);
  if (!items.length) return 0;
  return items.reduce((count, item) => {
    const response = getPracticeResponse(item.external_id);
    if (!response.submitted || !response.selected) return count;
    const correctLetters = getCorrectLetters(item);
    const selectedChoice = findSelectedChoice(item, response);
    const selectedIndex = (item.answerOptions || []).findIndex((choice, index) => getChoiceLetter(choice, index) === response.selected);
    return count + (selectedChoice && choiceMatchesCorrect(selectedChoice, selectedIndex, correctLetters) ? 1 : 0);
  }, 0);
}

function scoreIndicatorCount(correct, total) {
  if (!total) return 0;
  const ratio = correct / total;
  if (ratio >= 0.99) return 7;
  if (ratio >= 0.78) return 6;
  if (ratio >= 0.64) return 5;
  if (ratio >= 0.5) return 4;
  if (ratio >= 0.34) return 3;
  if (ratio >= 0.17) return 2;
  if (ratio > 0) return 1;
  return 0;
}

function scoreDifficultyLevel(questions) {
  const buckets = {
    H: { total: 0, correct: 0 },
    M: { total: 0, correct: 0 },
    E: { total: 0, correct: 0 }
  };
  for (const question of questions) {
    const bucket = buckets[question.difficultyCode] || buckets.E;
    bucket.total += 1;
    if (question.isCorrect) bucket.correct += 1;
  }
  if (buckets.H.total > 0 && buckets.H.correct / buckets.H.total >= 0.7) return 'Hard';
  if (buckets.M.total > 0 && buckets.M.correct / buckets.M.total >= 0.6) return 'Medium';
  return 'Easy';
}

function normalizeUserAnswer(response) {
  return response?.selected || '';
}

function buildResultsModel() {
  const attempt = state.testAttempt;
  if (!attempt || attempt.status !== 'submitted') return null;
  const items = (Array.isArray(attempt.questions) ? attempt.questions : []).map((item, index) => {
    const correctLetters = Array.isArray(item.correctLetters) && item.correctLetters.length
      ? item.correctLetters
      : normalizeAnswerTokens(item.correctAnswer).map((entry) => entry.trim().toUpperCase()).filter(Boolean);
    const userAnswer = item.userAnswer == null || String(item.userAnswer).trim() === '' ? 'Blank' : String(item.userAnswer).trim().toUpperCase();
    return {
      number: index + 1,
      externalId: item.external_id || item.id,
      section: item.section || (String(item.test_id || '') === '2' ? 'Math' : 'Reading and Writing'),
      domain: item.domain || item.domainText || item.primary_class_cd_desc || 'Unknown domain',
      difficultyCode: item.difficulty || 'E',
      difficulty: difficultyLabel[item.difficulty] || item.difficulty || 'Easy',
      correctAnswer: correctLetters.join(', '),
      correctLetters,
      userAnswer,
      isCorrect: Boolean(item.isCorrect),
      questionText: item.rendered_prompt_html || item.prompt_html || item.stimulus_html || item.stem_html || '',
      choices: (item.answerOptions || []).map((choice, choiceIndex) => ({
        letter: getChoiceLetter(choice, choiceIndex),
        content: choice.rendered_html || choice.content || ''
      })),
      explanation: item.rendered_rationale_html || item.rationale_html || '',
      raw: item
    };
  });

  const totalQuestions = items.length;
  const correctAnswers = items.filter((item) => item.isCorrect).length;
  const incorrectAnswers = totalQuestions - correctAnswers;
  const sections = {
    'Reading and Writing': items.filter((item) => item.section === 'Reading and Writing'),
    Math: items.filter((item) => item.section === 'Math')
  };
  const domains = Object.entries(scoreDetailsDomainMeta).flatMap(([sectionName, domainMap]) => (
    Object.entries(domainMap).map(([domainName, description]) => {
      const domainQuestions = sections[sectionName].filter((item) => item.domain === domainName);
      const correct = domainQuestions.filter((item) => item.isCorrect).length;
      return {
        section: sectionName,
        name: domainName,
        description,
        indicatorCount: scoreIndicatorCount(correct, domainQuestions.length),
        difficultyLevel: scoreDifficultyLevel(domainQuestions),
        total: domainQuestions.length,
        correct,
        accuracy: domainQuestions.length ? correct / domainQuestions.length : 0
      };
    })
  ));
  const score = attempt.score || {};
  return {
    testName: attempt.testName || 'SAT Practice Test',
    date: formatAttemptDate(attempt.date),
    totalScore: Number.isFinite(score.estimated_total) ? score.estimated_total : null,
    totalQuestions,
    correctAnswers,
    incorrectAnswers,
    sectionScores: {
      readingWriting: Number.isFinite(score.estimated_rw) ? score.estimated_rw : null,
      math: Number.isFinite(score.estimated_math) ? score.estimated_math : null
    },
    domains,
    questions: items
  };
}

function isResultsMode() {
  return isFullTestMode() && state.testAttempt?.status === 'submitted';
}

function filteredResultQuestions(result) {
  const sectionFilter = state.practice.resultsTab;
  const base = sectionFilter === 'rw'
    ? result.questions.filter((question) => question.section === 'Reading and Writing')
    : sectionFilter === 'math'
      ? result.questions.filter((question) => question.section === 'Math')
      : result.questions.slice();
  const dir = state.practice.sortDir === 'desc' ? -1 : 1;
  const sorted = base.slice().sort((a, b) => {
    let left;
    let right;
    if (state.practice.sortKey === 'userAnswer') {
      left = a.userAnswer;
      right = b.userAnswer;
    } else if (state.practice.sortKey === 'domain') {
      left = a.domain;
      right = b.domain;
    } else {
      left = a.number;
      right = b.number;
    }
    if (typeof left === 'number' && typeof right === 'number') return (left - right) * dir;
    return String(left).localeCompare(String(right)) * dir;
  });
  return sorted;
}

function toggleResultsSort(key) {
  if (state.practice.sortKey === key) {
    state.practice.sortDir = state.practice.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.practice.sortKey = key;
    state.practice.sortDir = 'asc';
  }
  state.practice.page = 1;
}

function getCurrentResultsQuestion(result) {
  if (!state.practice.reviewModal.open) return null;
  return result.questions.find((question) => question.number === state.practice.reviewModal.questionNumber) || null;
}

function renderResultsDomainCard(domain) {
  return html`
    <article class="score-domain-card">
      <div class="score-domain-title">${esc(domain.name)}</div>
      <div class="score-domain-copy">${esc(domain.description)}</div>
      <div class="score-domain-indicators" aria-label="${esc(`${domain.indicatorCount} of 7 indicators filled`)}">
        ${Array.from({ length: 7 }, (_, index) => `<span class="score-indicator ${index < domain.indicatorCount ? 'filled' : ''}"></span>`).join('')}
      </div>
      <div class="score-domain-difficulty">Difficulty level: <span>${esc(domain.difficultyLevel)}</span></div>
    </article>
  `;
}

function renderResultsTable(result) {
  const sorted = filteredResultQuestions(result);
  const totalPages = state.practice.viewSize === 'all' ? 1 : Math.max(1, Math.ceil(sorted.length / state.practice.viewSize));
  const page = Math.min(state.practice.page, totalPages);
  const pageRows = state.practice.viewSize === 'all'
    ? sorted
    : sorted.slice((page - 1) * state.practice.viewSize, page * state.practice.viewSize);

  return html`
    <section class="score-table-section">
      <div class="score-table-controls">
        <label class="score-toggle">
          <input type="checkbox" data-action="results-toggle-correct" ${state.practice.showCorrectAnswers ? 'checked' : ''} />
          <span>Show Correct Answers</span>
        </label>
        <div class="score-view-switch">
          <span>View:</span>
          ${['10', '30', 'all'].map((value) => `
            <button class="${String(state.practice.viewSize) === value ? 'active' : ''}" data-action="results-view-size" data-value="${value}">
              ${value === 'all' ? 'All' : value}
            </button>
          `).join('')}
        </div>
      </div>
      <div class="score-table-wrap">
        <table class="score-table">
          <thead>
            <tr>
              <th><button data-action="results-sort" data-key="number">Question</button></th>
              <th>Section</th>
              ${state.practice.showCorrectAnswers ? '<th>Correct Answer</th>' : ''}
              <th><button data-action="results-sort" data-key="userAnswer">Your Answer</button></th>
              <th>Actions</th>
              <th><button data-action="results-sort" data-key="domain">Domain</button></th>
            </tr>
          </thead>
          <tbody>
            ${pageRows.map((question) => `
              <tr>
                <td>${question.number}</td>
                <td>${esc(question.section)}</td>
                ${state.practice.showCorrectAnswers ? `<td>${esc(question.correctAnswer || '—')}</td>` : ''}
                <td class="${question.isCorrect ? 'answer-correct' : 'answer-incorrect'}">${esc(question.userAnswer)}</td>
                <td><button class="score-link-btn" data-action="results-review" data-question-number="${question.number}">Review</button></td>
                <td>${esc(question.domain)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="score-pagination">
        <button data-action="results-page" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        ${Array.from({ length: totalPages }, (_, index) => index + 1).slice(0, 10).map((pageNumber) => `
          <button class="${pageNumber === page ? 'active' : ''}" data-action="results-page" data-page="${pageNumber}">${pageNumber}</button>
        `).join('')}
        <button data-action="results-page" data-page="${Math.min(totalPages, page + 1)}" ${page >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    </section>
  `;
}

function renderResultsModal(result) {
  const question = getCurrentResultsQuestion(result);
  if (!question) return '';
  const domain = result.domains.find((entry) => entry.name === question.domain && entry.section === question.section);
  return html`
    <div class="score-modal-backdrop" data-action="results-modal-close">
      <div class="score-modal" data-modal-panel="true" role="dialog" aria-modal="true" aria-label="Question review">
        <header class="score-modal-header">
          <div>
            <div class="score-modal-kicker">${esc(result.testName)} - ${esc(result.date)}</div>
            <div class="score-modal-domain">Knowledge and Skills: ${esc(question.domain)}</div>
            <div class="score-domain-indicators compact">
              ${Array.from({ length: 7 }, (_, index) => `<span class="score-indicator ${index < (domain?.indicatorCount || 0) ? 'filled' : ''}"></span>`).join('')}
            </div>
            <div class="score-domain-difficulty">Difficulty level: <span>${esc(domain?.difficultyLevel || question.difficulty)}</span></div>
          </div>
          <button class="score-close-btn" data-action="results-modal-close">×</button>
        </header>
        <div class="score-modal-body">
          <h3>${esc(`${question.section}: Question ${question.number}`)}</h3>
          <div class="rich">${question.questionText}</div>
          <ol class="score-modal-choices">
            ${question.choices.map((choice) => {
              const isCorrect = Array.isArray(question.correctLetters)
                ? question.correctLetters.includes(choice.letter)
                : choice.letter === question.correctAnswer;
              const isWrongSelection = choice.letter === question.userAnswer && !question.isCorrect;
              const reveal = state.practice.reviewModal.showExplanation;
              const classes = [
                'score-modal-choice',
                reveal && isCorrect ? 'correct' : '',
                reveal && isWrongSelection ? 'incorrect' : ''
              ].filter(Boolean).join(' ');
              return `<li class="${classes}"><strong>${esc(choice.letter)}.</strong> <span>${choice.content}</span></li>`;
            }).join('')}
          </ol>
          ${state.practice.reviewModal.showExplanation ? `
            <div class="score-modal-explanation">
              <div><strong>Correct answer:</strong> ${esc(question.correctAnswer || '—')}</div>
              <div><strong>Your answer:</strong> ${esc(question.userAnswer)}</div>
              ${question.explanation ? `<div class="rich">${question.explanation}</div>` : ''}
            </div>
          ` : ''}
        </div>
        <footer class="score-modal-footer">
          <label class="score-toggle">
            <input type="checkbox" data-action="results-modal-toggle" ${state.practice.reviewModal.showExplanation ? 'checked' : ''} />
            <span>Show correct answer and explanation</span>
          </label>
          <div class="score-modal-nav">
            <button data-action="results-modal-prev" ${question.number <= 1 ? 'disabled' : ''}>Previous</button>
            <button data-action="results-modal-next" ${question.number >= result.questions.length ? 'disabled' : ''}>Next</button>
          </div>
        </footer>
      </div>
    </div>
  `;
}

function renderScoreDetailsPage() {
  const result = buildResultsModel();
  if (!result) return '<div class="empty-state">No score details are available yet.</div>';
  const visibleDomains = state.practice.resultsTab === 'rw'
    ? result.domains.filter((domain) => domain.section === 'Reading and Writing')
    : state.practice.resultsTab === 'math'
      ? result.domains.filter((domain) => domain.section === 'Math')
      : result.domains;

  return html`
    <div class="score-page">
      <header class="score-header">
        <div class="score-header-inner">
          <div class="score-brand">SAT Level Practice</div>
          <button class="score-home-link" data-action="results-home">Home</button>
        </div>
      </header>

      <section class="score-hero">
        <div class="score-hero-inner">
          <h1>Score Details</h1>
          <h2>${esc(result.testName)} - ${esc(result.date)}</h2>
          <div class="score-hero-metrics">
            ${result.totalScore ? `<div class="score-hero-score">${esc(result.totalScore)}</div>` : ''}
            ${result.sectionScores.readingWriting ? `<div class="score-hero-subscore">Reading and Writing ${esc(result.sectionScores.readingWriting)}</div>` : ''}
            ${result.sectionScores.math ? `<div class="score-hero-subscore">Math ${esc(result.sectionScores.math)}</div>` : ''}
          </div>
          <div class="score-hero-actions">
            <button data-action="results-review-all">Review All Questions</button>
            <button data-action="results-practice-specific">Practice Specific Questions</button>
            <button data-action="results-bank">Student Question Bank</button>
            <button data-action="export-pdf">Download Score Report</button>
            <a href="https://www.khanacademy.org/test-prep/sat" target="_blank" rel="noreferrer">Practice on Khan Academy</a>
            <a href="https://satsuite.collegeboard.org/sat/practice-preparation/official-sat-prep" target="_blank" rel="noreferrer">Official SAT Tutoring</a>
          </div>
        </div>
      </section>

      <div class="score-breadcrumb">
        <div class="score-breadcrumb-inner">My Tests &gt; ${esc(result.testName)} - ${esc(result.date)} &gt; Score Details</div>
      </div>

      <nav class="score-tabs">
        <div class="score-tabs-inner">
          <button class="${state.practice.resultsTab === 'all' ? 'active' : ''}" data-action="results-tab" data-tab="all">All Questions</button>
          <button class="${state.practice.resultsTab === 'rw' ? 'active' : ''}" data-action="results-tab" data-tab="rw">Reading and Writing</button>
          <button class="${state.practice.resultsTab === 'math' ? 'active' : ''}" data-action="results-tab" data-tab="math">Math</button>
        </div>
      </nav>

      <main class="score-main">
        <section>
          <div class="score-section-title-row">
            <h2>Knowledge and Skills</h2>
            <span class="score-new-pill">New!</span>
          </div>
          <p class="score-section-copy">View your performance across the 8 content domains measured on the SAT.</p>
          <div class="score-domain-grid">
            ${visibleDomains.map(renderResultsDomainCard).join('')}
          </div>
        </section>

        <section class="score-overview">
          <h2>Questions Overview</h2>
          <p class="score-section-copy">Review your results for each question from this practice test.</p>
          <div class="score-tally-row">
            <div class="score-tally-card"><strong>${esc(result.totalQuestions)}</strong><span>Total Questions</span></div>
            <div class="score-tally-card"><strong>${esc(result.correctAnswers)}</strong><span>Correct Answers</span></div>
            <div class="score-tally-card"><strong>${esc(result.incorrectAnswers)}</strong><span>Incorrect Answers</span></div>
          </div>
          ${renderResultsTable(result)}
        </section>
      </main>

      ${state.practice.reviewModal.open ? renderResultsModal(result) : ''}
    </div>
  `;
}

function render() {
  const meta = state.meta || {};
  const sync = state.sync || {};
  const practiceMode = isPracticeMode();
  const resultsMode = isResultsMode();
  const availableSlices = getAvailableQuestionSlices();
  const assessmentRows = IS_DEMO
    ? (meta.lookupData?.assessment || []).filter((row) => String(row.id) !== '99')
    : (availableSlices.length
      ? (meta.lookupData?.assessment || []).filter((row) => (
          availableSlices.some((slice) => String(slice.assessment_id) === String(row.id) && Number(slice.count || 0) > 0)
        ))
      : (meta.lookupData?.assessment || []));
  const loadingLabel = IS_DEMO
    ? 'Pages Demo'
    : sync.status === 'running'
    ? `Syncing ${sync.progress?.done ?? 0}/${sync.progress?.total ?? 0}`
    : sync.status === 'failed'
      ? 'Sync failed'
      : sync.status === 'complete'
        ? 'Synced'
        : 'Idle';

  document.body.classList.toggle('practice-mode', practiceMode && !resultsMode);
  document.body.classList.toggle('results-mode', resultsMode);
  if (!practiceMode && state.calculator.open) {
    state.calculator.open = false;
    dom.calculatorOverlay?.classList.add('hidden');
  }
  if (!practiceMode && state.reference.open) {
    state.reference.open = false;
    dom.referenceOverlay?.classList.add('hidden');
  }

  if (resultsMode) {
    app.innerHTML = renderScoreDetailsPage();
    dom.libraryList = null;
    dom.generatedList = null;
    dom.syncLog = null;
    scheduleMathTypeset();
    return;
  }

  app.innerHTML = html`
    <div class="app-shell ${practiceMode ? 'practice-shell' : ''}">
      <section class="topbar">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <h1>SAT Generator</h1>
            <p>${IS_DEMO ? 'Static Pages demo with bundled sample questions.' : 'EQB sync, filtered practice sets, full tests, and offline review.'}</p>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="badge">Status: <strong>${esc(loadingLabel)}</strong></div>
          <button class="btn ${isBusy('refresh') ? 'loading' : ''}" data-action="refresh" ${isAnyBusy() ? 'disabled' : ''}>${isBusy('refresh') ? 'Refreshing...' : 'Refresh'}</button>
          <button class="btn primary ${isBusy('sync') ? 'loading' : ''}" data-action="sync" ${isAnyBusy() ? 'disabled' : ''}>${isBusy('sync') ? 'Syncing...' : (IS_DEMO ? 'Reload Demo' : 'Sync EQB')}</button>
          <button class="btn" data-action="export-json" ${isAnyBusy() ? 'disabled' : ''}>Export JSON</button>
          <button class="btn" data-action="export-csv" ${isAnyBusy() ? 'disabled' : ''}>Export CSV</button>
          <button class="btn" data-action="export-pdf" ${isAnyBusy() ? 'disabled' : ''}>Export PDF</button>
        </div>
      </section>
      ${isAnyBusy() ? `
        <div class="app-loading-overlay" aria-live="polite" aria-busy="true">
          <div class="loading-card">
            <div class="loading-spinner" aria-hidden="true"></div>
            <div class="loading-copy">
              <strong>${esc(currentLoadingMessage())}</strong>
              <span>Please wait. The app is still working.</span>
            </div>
          </div>
        </div>
      ` : ''}

      <section class="layout">
        <aside class="panel ${practiceMode ? 'hidden' : ''}">
          <div class="panel-header">
            <h2 class="panel-title">Session Setup</h2>
            <p class="panel-subtitle">These controls shape the next session you launch. The advanced filters are optional.</p>
          </div>
          <div class="panel-body">
            <div class="stack">
              <div class="session-card">
                <div class="session-card-copy">
                  <div class="session-kicker">Ready when you are</div>
                  <div class="session-title">${state.tab === 'fulltest' ? 'Build a full test' : 'Start a practice session'}</div>
                  <div class="session-note">${state.tab === 'fulltest'
                    ? 'The controls below set the length of the full test.'
                    : 'The controls below decide which practice questions you will see.'}</div>
                </div>
                <button class="btn primary session-cta ${isBusy('generate') ? 'loading' : ''}" data-action="generate" ${isAnyBusy() ? 'disabled' : ''}>${esc(isBusy('generate') ? (state.tab === 'fulltest' ? 'Building full test...' : 'Starting session...') : getSessionPrimaryActionLabel())}</button>
              </div>

              <div class="filter-group">
                <h3>Session type</h3>
                <div class="tabbar">
                  ${['library', 'builder', 'fulltest', 'exports'].map((tab) => `
                    <button class="tab ${state.tab === tab ? 'active' : ''}" data-tab="${tab}">
                      ${tab === 'library' ? 'Library' : tab === 'builder' ? 'Practice' : tab === 'fulltest' ? 'Full Test' : 'Exports'}
                    </button>
                  `).join('')}
                </div>
              </div>

              <div class="filter-group">
                <h3>Affects this session</h3>
                <div class="field">
                  <label for="assessment">Assessment</label>
                  <select id="assessment" data-filter="assessment">
                    ${assessmentRows.map((row) => `
                      <option value="${esc(row.id)}" ${String(row.id) === state.filters.assessment ? 'selected' : ''}>${esc(row.text)}</option>
                    `).join('')}
                  </select>
                  ${IS_DEMO ? '<div class="field-help">This demo bundle only includes Digital SAT sample questions.</div>' : ''}
                </div>
                <div class="field">
                  <label for="test">Section</label>
                  <select id="test" data-filter="test">
                    ${(meta.lookupData?.test || []).map((row) => `
                      <option value="${esc(row.id)}" ${String(row.id) === state.filters.test ? 'selected' : ''} ${(availableSlices.length && !hasAvailableQuestionSlice(state.filters.assessment, row.id)) ? 'disabled' : ''}>${esc(row.text)}</option>
                    `).join('')}
                  </select>
                </div>
                <div class="field-help">These choices change the questions in the practice session.</div>
              </div>

              <div class="filter-group">
                <h3>${state.tab === 'fulltest' ? 'Full test length' : 'Practice session length'}</h3>
                <div class="field">
                  ${state.tab === 'fulltest' ? html`
                    <label for="fullTestCountRw">Full test RW count</label>
                    <input id="fullTestCountRw" data-filter="fullTestCountRw" type="number" min="1" max="60" value="${esc(state.filters.fullTestCountRw)}" />
                  ` : html`
                    <label for="limit">Practice count</label>
                    <input id="limit" data-filter="limit" type="number" min="1" max="200" value="${esc(state.filters.limit)}" />
                  `}
                </div>
                ${state.tab === 'fulltest' ? html`
                  <div class="field">
                    <label for="fullTestCountMath">Full test Math count</label>
                    <input id="fullTestCountMath" data-filter="fullTestCountMath" type="number" min="1" max="60" value="${esc(state.filters.fullTestCountMath)}" />
                  </div>
                ` : html`
                  <div class="field">
                    <label for="practiceTimerMinutes">Practice timer</label>
                    <input id="practiceTimerMinutes" data-filter="practiceTimerMinutes" type="number" min="1" max="180" value="${esc(state.filters.practiceTimerMinutes)}" />
                    <div class="field-help">Starts when you launch a practice session.</div>
                  </div>
                `}
              </div>

              <div class="filter-group">
                <h3>Current setup</h3>
                <div class="session-summary">
                  ${summarizeSession(meta)}
                </div>
              </div>

              <details class="advanced-filters">
                <summary>Advanced filters and topic scope</summary>
                <div class="advanced-filters-body">
                  <div class="filter-group compact">
                    <h3>Topics</h3>
                    <div class="chips">
                      ${buildDomainChips(meta)}
                    </div>
                  </div>

                  <div class="filter-group compact">
                    <h3>Difficulty</h3>
                    <div class="chips">
                      ${['E', 'M', 'H'].map((code) => `
                        <label class="chip">
                          <input type="checkbox" data-difficulty="${code}" ${state.filters.difficulty.has(code) ? 'checked' : ''} />
                          ${difficultyLabel[code]}
                        </label>
                      `).join('')}
                    </div>
                  </div>

                  <div class="filter-group compact">
                    <div class="chips">
                      <label class="chip">
                        <input type="checkbox" data-filter="excludeActive" ${state.filters.excludeActive ? 'checked' : ''} />
                        Exclude active items
                      </label>
                      <label class="chip">
                        <input type="checkbox" data-filter="neverSeenBefore" ${state.filters.neverSeenBefore ? 'checked' : ''} />
                        Only never seen before
                      </label>
                      <label class="chip">
                        <input type="checkbox" data-filter="practiceOnlyHard" ${state.filters.practiceOnlyHard ? 'checked' : ''} />
                        Hardest practice questions only
                      </label>
                    </div>
                  </div>

                  <div class="field">
                    <label for="search">Text search</label>
                    <input id="search" data-filter="search" value="${esc(state.filters.search)}" placeholder="Search prompt, skill, or rationale" />
                  </div>
                  <div class="field">
                    <label for="skill">Skill contains</label>
                    <input id="skill" data-filter="skill" value="${esc(state.filters.skill)}" placeholder="e.g. Inferences" />
                  </div>
                  <div class="field">
                    <label for="stateCd">State standards</label>
                    <select id="stateCd" data-filter="stateCd">
                      <option value="">All states</option>
                      ${(meta.stateOfferings || []).map((row) => `
                        <option value="${esc(row.stateCd)}" ${row.stateCd === state.filters.stateCd ? 'selected' : ''}>${esc(row.name)} (${esc(row.stateCd)})</option>
                      `).join('')}
                    </select>
                  </div>
                  <div class="field">
                    <label for="seed">Seed</label>
                    <input id="seed" data-filter="seed" value="${esc(state.filters.seed)}" />
                  </div>
                </div>
              </details>

              <div class="stat-row">
                <div class="stat">
                  <div class="value">${meta.counts?.questions ?? 0}</div>
                  <div class="label">Questions cached</div>
                </div>
                <div class="stat">
                  <div class="value">${meta.counts?.assets ?? 0}</div>
                  <div class="label">Assets stored</div>
                </div>
                <div class="stat">
                  <div class="value">${meta.counts?.sets ?? 0}</div>
                  <div class="label">Saved sets</div>
                </div>
              </div>
            </div>
          </div>
        </aside>

        <main class="panel ${practiceMode ? 'practice-panel' : ''}">
          ${practiceMode ? '<div id="practiceList"></div>' : html`
            <div class="content-toolbar">
              <div>
                <h2 class="panel-title">${state.tab === 'fulltest' ? 'Full Test Builder' : state.tab === 'builder' ? 'Practice Session' : 'Question Library'}</h2>
                <p class="panel-subtitle">${state.tab === 'fulltest'
                  ? 'Set the section counts, then generate a full test.'
                  : state.tab === 'builder'
                    ? 'Choose the questions you want, then launch a timed practice session.'
                    : 'Browse, inspect, and filter the synced bank.'}</p>
              </div>
              <div class="badge">Showing <strong>${state.questions.length}</strong> questions</div>
            </div>
            ${state.uiNotice ? `<div class="notice" style="margin: 0 18px 12px;">${esc(state.uiNotice)}</div>` : ''}
            ${state.tab === 'fulltest'
              ? `<div class="empty-state" style="margin: 18px;">Build Full Test launches the timed full-test runner. The question library does not control the generated order.</div>`
              : '<div class="content-list" id="libraryList"></div>'}
          `}
        </main>

        <aside class="panel right-panel ${practiceMode ? 'hidden' : ''}">
          <div class="panel-header">
            <h2 class="panel-title">${isPracticeMode() ? 'Practice Runner' : state.generated?.mode === 'inspect' ? 'Question History' : 'Generated Set'}</h2>
            <p class="panel-subtitle">${isPracticeMode()
              ? 'Timed practice with answer elimination, highlighting, and SAT-style navigation.'
              : state.generated?.mode === 'inspect'
                ? 'See when this question was generated in the past.'
              : 'Saved selections, score view, and export targets.'}</p>
          </div>
          <div class="panel-body">
            <div class="stack">
              <div class="notice">
                The full-test score estimate appears only after both sections are generated and scored. Raw score remains the source of truth.
              </div>
              <div class="set-list" id="generatedList"></div>
              <div class="sync-log" id="syncLog"></div>
            </div>
          </div>
        </aside>
      </section>
    </div>
  `;

  dom.libraryList = document.querySelector('#libraryList');
  dom.generatedList = document.querySelector('#practiceList') || document.querySelector('#generatedList');
  dom.syncLog = document.querySelector('#syncLog');
  renderQuestions();
  renderGenerated();
  renderSyncLog();
  scheduleMathTypeset();
}

let mathTypesetTimer = null;
function scheduleMathTypeset() {
  if (!window.MathJax?.typesetPromise) return;
  clearTimeout(mathTypesetTimer);
  mathTypesetTimer = setTimeout(() => {
    window.MathJax.typesetClear?.([app]);
    window.MathJax.typesetPromise([app]).catch(() => {});
  }, 0);
}

function buildDomainChips(meta) {
  const domains = (meta.lookupData?.domain || {})[state.filters.test === '2' ? 'Math' : 'R&W'] || [];
  if (!domains.length) {
    return '<div class="empty-state">Load sync data to see topic chips.</div>';
  }
  return domains.map((row) => `
    <label class="chip">
      <input type="checkbox" data-domain="${esc(row.primaryClassCd)}" ${state.filters.domains.has(row.primaryClassCd) ? 'checked' : ''} />
      ${esc(row.text)}
    </label>
  `).join('');
}

function getSessionPrimaryActionLabel() {
  return state.tab === 'fulltest' ? 'Build Full Test' : 'Start Practice Session';
}

function summarizeSession(meta) {
  const assessmentText = (meta.lookupData?.assessment || []).find((row) => String(row.id) === String(state.filters.assessment))?.text || '';
  const sectionText = (meta.lookupData?.test || []).find((row) => String(row.id) === String(state.filters.test))?.text || '';
  const domainRows = (meta.lookupData?.domain || {})[state.filters.test === '2' ? 'Math' : 'R&W'] || [];
  const selectedDomains = domainRows.filter((row) => state.filters.domains.has(row.primaryClassCd)).map((row) => row.text);
  const selectedDifficulty = ['E', 'M', 'H'].filter((code) => state.filters.difficulty.has(code)).map((code) => difficultyLabel[code]).join(', ');
  const guards = [
    state.filters.excludeActive ? 'exclude active' : 'include active',
    state.filters.neverSeenBefore ? 'never seen before' : 'seen questions allowed'
  ];
  const timing = state.tab === 'fulltest'
    ? `Full test counts: ${Number(state.filters.fullTestCountRw) || 0} RW / ${Number(state.filters.fullTestCountMath) || 0} Math`
    : `Practice count: ${Number(state.filters.limit) || 24} | Timer: ${normalizePracticeMinutes(state.filters.practiceTimerMinutes)} min${state.filters.practiceOnlyHard ? ' | hardest only' : ''}`;
  return html`
    <div class="session-summary-grid">
      <div><span>Assessment</span><strong>${esc(assessmentText || 'Not set')}</strong></div>
      <div><span>Section</span><strong>${esc(sectionText || 'Not set')}</strong></div>
      <div><span>Topics</span><strong>${esc(selectedDomains.length ? selectedDomains.join(', ') : 'All topics')}</strong></div>
      <div><span>Difficulty</span><strong>${esc(selectedDifficulty || 'All difficulty levels')}</strong></div>
      <div><span>Filters</span><strong>${esc(guards.join(' | '))}</strong></div>
      <div><span>${state.tab === 'fulltest' ? 'Full test' : 'Session'}</span><strong>${esc(timing)}</strong></div>
    </div>
  `;
}
function formatQuestionCard(row, index) {

  const answerChoices = Array.isArray(row.answerOptions) ? row.answerOptions : [];
  const correct = Array.isArray(row.correctAnswer) ? row.correctAnswer.join(', ') : row.correctAnswer || '';
  const tracking = row.tracking || {};
  const seenLabel = Number(tracking.seenCount || 0) > 0
    ? `Seen ${tracking.seenCount}x`
    : 'Never seen';
  const lastSeenLabel = Number(tracking.seenCount || 0) > 0
    ? `Last ${formatDateLabel(tracking.lastSeenAt)}`
    : '';
  return html`
    <article class="question-card">
      <header>
        <div>
          <div class="question-meta">
            <span class="pill">${esc(row.assessmentText || row.assessment)}</span>
            <span class="pill accent">${esc(row.sectionText || row.testText)}</span>
            <span class="pill">${esc(row.domainText || row.primary_class_cd_desc || row.domain)}</span>
            <span class="pill warn">${esc(difficultyLabel[row.difficulty] || row.difficulty)}</span>
            ${row.is_active ? '<span class="pill good">Active item</span>' : '<span class="pill">Inactive</span>'}
          </div>
        </div>
        <div class="question-meta">
          <button class="btn" data-action="inspect" data-external-id="${esc(row.external_id)}">Inspect</button>
          <button class="btn" data-action="add" data-external-id="${esc(row.external_id)}">Add</button>
        </div>
      </header>
      <div class="body">
        <h4>${index + 1}. ${esc(row.skill_desc || row.skill || '')}</h4>
        <div class="rich">${row.rendered_prompt_html || row.prompt_html || row.stimulus_html || row.stem_html || ''}</div>
        ${row.rendered_choices_html ? `<div class="answer-list">${row.rendered_choices_html}</div>` : answerChoices.length ? `<div class="answer-list">${answerChoices.map((choice, i) => `<div class="answer"><strong>${String.fromCharCode(65 + i)}.</strong>${choice.rendered_html || choice.content || ''}</div>`).join('')}</div>` : ''}
      </div>
      <div class="question-footer">
        <div class="small">ID ${esc(row.external_id)} ??? ${esc(row.questionId || '')} ??? Score band ${esc(row.score_band_range_cd ?? '')}</div>
        <div class="small">Correct: ${esc(correct)}</div>
        <div class="small">${esc(seenLabel)}${lastSeenLabel ? ` ??? ${esc(lastSeenLabel)}` : ''}</div>
      </div>
      ${row.rationale_html ? `<div class="body"><div class="notice">${row.rationale_html}</div></div>` : ''}
    </article>
  `;
}

function renderQuestions() {
  if (!dom.libraryList) return;
  if (!state.questions.length) {
    dom.libraryList.innerHTML = '<div class="empty-state">No questions match the current filters yet. Run sync, then generate or filter a set.</div>';
    return;
  }
  dom.libraryList.innerHTML = state.questions.map((row, index) => formatQuestionCard(row, index)).join('');
}

function renderPracticeChoice(row, choice, index, response, correctLetters) {
  const letter = getChoiceLetter(choice, index);
  const eliminated = response.eliminated.includes(letter);
  const selected = response.selected === letter;
  const reviewVisible = !isFullTestMode() || state.testAttempt?.status === 'submitted';
  const submitted = reviewVisible && response.submitted;
  const correct = submitted && choiceMatchesCorrect(choice, index, correctLetters);
  const wrong = submitted && selected && !correct;
  const classes = [
    'choice-row',
    eliminated ? 'eliminated' : '',
    selected ? 'selected' : '',
    correct ? 'correct' : '',
    wrong ? 'incorrect' : ''
  ].filter(Boolean).join(' ');
  return html`
    <div class="${classes}">
      <div class="choice-main" role="button" tabindex="0" data-action="practice-select" data-choice="${esc(letter)}" data-external-id="${esc(row.external_id)}" aria-disabled="${submitted ? 'true' : 'false'}">
        <span class="choice-letter">${esc(letter)}</span>
        <div class="choice-content">${choice.rendered_html || choice.content || ''}</div>
      </div>
      <button class="choice-eliminate" data-action="practice-eliminate" data-choice="${esc(letter)}" data-external-id="${esc(row.external_id)}" ${submitted ? 'disabled' : ''}>
        <span aria-hidden="true">${eliminated ? '↺' : '⊘'}</span>
        <span class="sr-only">${eliminated ? 'Restore choice' : 'Eliminate choice'}</span>
      </button>
    </div>
  `;
}

function renderPracticeProgress(currentIndex) {
  return getCurrentModuleItems().map((item, index) => {
    const itemResponse = getPracticeResponse(item.external_id);
    const marked = state.practice.markedForReview.has(item.external_id);
    const active = index === currentIndex;
    const done = Boolean(itemResponse.selected);
    return `<span class="exam-progress-segment ${active ? 'active' : ''} ${done ? 'done' : ''} ${marked ? 'marked' : ''}"></span>`;
  }).join('');
}

function renderPracticeQuestionPicker(currentIndex) {
  const moduleItems = getCurrentModuleItems();
  const total = moduleItems.length || 0;
  return html`
    <details class="question-picker" ${state.practice.navOpen ? 'open' : ''}>
      <summary data-action="practice-nav-toggle">Question ${esc(currentIndex + 1)} of ${esc(total)} <span class="picker-caret">▾</span></summary>
      <div class="question-picker-menu">
        ${moduleItems.map((item, index) => {
          const itemResponse = getPracticeResponse(item.external_id);
          const active = index === currentIndex;
          const done = Boolean(itemResponse.selected);
          const marked = state.practice.markedForReview.has(item.external_id);
          return `
            <button class="question-picker-item ${active ? 'active' : ''} ${done ? 'done' : ''} ${marked ? 'marked' : ''}" data-action="practice-jump" data-index="${index}">
              <span class="picker-num">${index + 1}</span>
              <span class="picker-state">${marked ? 'Review' : done ? 'Done' : 'Open'}</span>
            </button>
          `;
        }).join('')}
      </div>
    </details>
  `;
}

function renderBreakScreen() {
  const timer = state.practice.timer;
  return html`
    <div class="practice-runner">
      <div class="sat-exam sat-break-screen">
        <div class="sat-break-panel">
          <div class="sat-break-kicker">Mandatory Break</div>
          <h2>Break Time</h2>
          <p>You have completed the Reading and Writing section.</p>
          <p>The Math section will begin after your break.</p>
          <div class="sat-break-timer-label">Break Remaining</div>
          <div class="sat-break-timer">${esc(formatDuration(timer.remainingMs))}</div>
          <div class="sat-break-actions">
            <button class="sat-nav-btn" data-action="break-start-early">Start Early</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderPracticeRunner() {
  const moduleItems = isFullTestMode() ? getCurrentModuleItems() : (state.generated?.items || []);
  const stage = getCurrentStage();
  if (isBreakStage()) {
    return renderBreakScreen();
  }
  if (!moduleItems.length) {
    return '<div class="empty-state">Generate a practice set to start the timed runner.</div>';
  }
  const summary = state.generated.summary || {};
  const current = getCurrentPracticeQuestion();
  const currentIndex = Math.min(Math.max(0, state.practice.currentIndex), moduleItems.length - 1);
  const response = current ? getPracticeResponse(current.external_id) : { selected: null, eliminated: [], submitted: false };
  const correctLetters = getCorrectLetters(current);
  const selectedChoice = findSelectedChoice(current, response);
  const selectedChoiceIndex = (current?.answerOptions || []).findIndex((choice, index) => getChoiceLetter(choice, index) === response.selected);
  const selectedIsCorrect = Boolean(selectedChoice) && choiceMatchesCorrect(selectedChoice, selectedChoiceIndex, correctLetters);
  const answered = getAnsweredCount();
  const correct = countPracticeCorrect();
  const reviewVisible = !isFullTestMode() || state.testAttempt?.status === 'submitted';
  const timer = state.practice.timer;
  const hardestOnly = Boolean(state.generated?.config?.practiceOnlyHard);
  const hardestDifficulty = summary.hardestDifficulty || null;
  const sectionNumber = stage?.section === 'Math' ? 2 : 1;
  const moduleNumber = stage?.moduleNumber || 1;
  const subject = stage?.section || getPracticeSubjectLabel(current);
  const markedForReview = current ? state.practice.markedForReview.has(current.external_id) : false;
  const showMathTools = subject === 'Math';
  return html`
    <div class="practice-runner">
      <div class="sat-exam">
        <header class="sat-topbar">
          <div class="sat-top-left">
            <div class="sat-section">${esc(`Section ${sectionNumber}, Module ${moduleNumber}:`)}</div>
            <div class="sat-subject">${esc(subject)}</div>
            <button class="sat-directions" data-action="practice-toggle-directions">
              <span>Directions</span>
              <span class="sat-caret">${state.practice.showDirections ? '▴' : '▾'}</span>
            </button>
            ${state.practice.showDirections ? `
              <div class="sat-directions-panel">
                ${esc(getPracticeDirectionsText())}
              </div>
            ` : ''}
          </div>
          <div class="sat-top-center">
            <div class="sat-timer ${timer.remainingMs <= 60_000 ? 'danger' : timer.remainingMs <= 300_000 ? 'warn' : ''}">
              ${state.practice.timerHidden ? '••:••' : esc(formatDuration(timer.remainingMs))}
            </div>
            <button class="sat-hide-btn" data-action="practice-toggle-timer">
              ${state.practice.timerHidden ? 'Show' : 'Hide'}
            </button>
          </div>
          ${showMathTools ? `
            <div class="sat-top-right">
              <button class="sat-tool ${state.calculator.open ? 'active' : ''}" type="button" aria-label="Calculator" data-action="calculator-toggle">
                <span class="sat-tool-icon">⌗</span>
                <span class="sat-tool-label">Calculator</span>
              </button>
              <button class="sat-tool ${state.reference.open ? 'active' : ''}" type="button" aria-label="Reference" data-action="reference-toggle">
                <span class="sat-tool-icon">x²</span>
                <span class="sat-tool-label">Reference</span>
              </button>
              <button class="sat-tool" type="button" aria-label="More">
                <span class="sat-tool-icon">⋮</span>
                <span class="sat-tool-label">More</span>
              </button>
            </div>
          ` : '<div class="sat-top-right"></div>'}
        </header>

        <div class="sat-practice-banner">THIS IS A PRACTICE TEST</div>

        <div class="sat-progress" aria-hidden="true">
          ${renderPracticeProgress(currentIndex)}
        </div>

        <main class="sat-question">
          <div class="sat-question-strip">
            <div class="sat-question-number">${esc(currentIndex + 1)}</div>
            <button class="sat-review" data-action="practice-toggle-review">
              <span class="sat-review-box">${markedForReview ? '☑' : '☐'}</span>
              <span>Mark for Review</span>
            </button>
          </div>

          <div class="sat-question-body">
            <div class="sat-question-text rich">${current?.rendered_prompt_html || current?.prompt_html || current?.stimulus_html || current?.stem_html || ''}</div>

            <div class="choice-list sat-choice-list">
              ${(current?.answerOptions || []).map((choice, index) => renderPracticeChoice(current, choice, index, response, correctLetters)).join('')}
            </div>

            ${reviewVisible && response.submitted ? html`
              <div class="sat-feedback">
                <div class="notice sat-feedback-box">
                  ${selectedIsCorrect
                    ? `Correct. ${current?.rationale_html ? 'Review the explanation below.' : 'Move to the next question when ready.'}`
                    : `Submitted ${response.selected || 'blank'}. The correct answer is ${correctLetters.join(', ') || 'not available'}.`}
                </div>
                ${current?.rationale_html ? `<div class="notice sat-rationale">${current.rendered_rationale_html || current.rationale_html}</div>` : ''}
              </div>
            ` : ''}
          </div>
        </main>

        <div class="sat-progress sat-progress-bottom" aria-hidden="true">
          ${renderPracticeProgress(currentIndex)}
        </div>

        <footer class="sat-footer">
          <div class="sat-footer-left">
            <div class="sat-footer-meta">${esc(answered)} of ${esc(moduleItems.length)} answered</div>
            ${reviewVisible ? `<div class="sat-footer-meta">${esc(correct)} correct</div>` : ''}
            ${hardestDifficulty ? `<div class="sat-footer-meta">Hardest: ${esc(hardestDifficulty)}</div>` : ''}
            ${hardestOnly ? '<div class="sat-footer-meta">Hardest only</div>' : ''}
          </div>
          <div class="sat-footer-center">
            ${renderPracticeQuestionPicker(currentIndex)}
          </div>
          <div class="sat-footer-right">
            ${isFullTestMode() && state.testAttempt?.status !== 'submitted' ? `<button class="sat-nav-btn secondary" data-action="practice-submit">${currentIndex >= moduleItems.length - 1 ? (stage?.id === 'math2' ? 'Submit Test' : 'Submit Module') : 'Submit Module'}</button>` : ''}
            <button class="sat-nav-btn" data-action="practice-prev" ${currentIndex <= 0 ? 'disabled' : ''}>Back</button>
            <button class="sat-nav-btn" data-action="practice-next" ${currentIndex >= moduleItems.length - 1 ? 'disabled' : ''}>Next</button>
          </div>
        </footer>
      </div>
    </div>
  `;
}

function renderFullGenerated() {
  const summary = state.generated?.summary || {};
  const score = state.testAttempt?.status === 'submitted' ? (state.testAttempt?.score || {}) : {};
  const scoreLabel = state.testAttempt?.status === 'submitted' ? 'Graded' : 'Not graded yet';
  return html`
    <div class="set-row">
      <div class="line1">
        <div class="title">${esc(state.generated.name || 'Generated set')}</div>
        <span class="pill">${esc(state.generated.mode)}</span>
      </div>
      <div class="meta">
        <span>Items: ${esc(summary.count ?? state.generated.items?.length ?? 0)}</span>
        <span>Seed: ${esc(state.generated.seed || '')}</span>
        <span>Raw: ${esc(score.raw_total ?? '?')}</span>
        <span>Estimated: ${esc(score.estimated_total ?? '?')}</span>
        <span>${esc(scoreLabel)}</span>
      </div>
      <div class="notice">${state.generated.note || 'Questions are ordered and stored with the current filters.'}</div>
      <div class="set-list">
        ${(state.generated.items || []).slice(0, 8).map((row, idx) => `
          <div class="set-row">
            <div class="line1">
              <div class="title">${idx + 1}. ${esc(row.skill_desc || row.skill || '')}</div>
              <span class="pill ${row.difficulty === 'H' ? 'warn' : row.difficulty === 'M' ? 'accent' : ''}">${esc(difficultyLabel[row.difficulty] || row.difficulty)}</span>
            </div>
            <div class="meta">
              <span>${esc(row.domainText || row.primary_class_cd_desc || '')}</span>
              <span>${esc(row.external_id)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderInspection() {
  if (!state.generated?.items?.length) {
    return '<div class="empty-state">Open a question to see its history.</div>';
  }
  const question = state.generated.items[0];
  const history = state.generated.history || [];
  const tracking = question.tracking || {};
  return html`
    <div class="set-row">
      <div class="line1">
        <div class="title">Question tracking</div>
        <span class="pill accent">${esc(history.length)} past appearances</span>
      </div>
      <div class="meta">
        <span>First seen: ${esc(formatDateLabel(tracking.firstSeenAt))}</span>
        <span>Last seen: ${esc(formatDateLabel(tracking.lastSeenAt))}</span>
        <span>Seen count: ${esc(tracking.seenCount || 0)}</span>
      </div>
      <div class="notice">This view shows every saved set where the question appeared and the date it was generated.</div>
    </div>
    <div class="set-row">
      <div class="title">History</div>
      <div class="tracking-list">
        ${history.length ? history.map((entry) => `
          <div class="tracking-item">
            <div class="line1">
              <div class="title">${esc(formatDateLabel(entry.seen_at))}</div>
              <span class="pill">${esc(entry.mode)}</span>
            </div>
            <div class="meta">
              <span>${esc(entry.set_name || entry.set_id)}</span>
              <span>${esc(entry.section_name || '')}</span>
              <span>#${esc(entry.position)}</span>
            </div>
          </div>
        `).join('') : '<div class="empty-state">No saved appearances yet.</div>'}
      </div>
    </div>
    ${formatQuestionCard(question, 0)}
  `;
}

function renderGenerated() {
  if (!dom.generatedList) return;
  if (!state.generated) {
    clearPracticeTimer();
    dom.generatedList.innerHTML = '<div class="empty-state">Generate a set to pin questions here.</div>';
    scheduleMathTypeset();
    return;
  }
  if (isPracticeMode()) {
    const currentSubject = getPracticeSubjectLabel(getCurrentPracticeQuestion());
    if (currentSubject !== 'Math') {
      if (state.calculator.open) {
        state.calculator.open = false;
        dom.calculatorOverlay?.classList.add('hidden');
      }
      if (state.reference.open) {
        state.reference.open = false;
        dom.referenceOverlay?.classList.add('hidden');
      }
    }
    dom.generatedList.innerHTML = renderPracticeRunner();
    scheduleMathTypeset();
    return;
  }
  if (state.generated.mode === 'inspect') {
    clearPracticeTimer();
    dom.generatedList.innerHTML = renderInspection();
    scheduleMathTypeset();
    return;
  }
  clearPracticeTimer();
  dom.generatedList.innerHTML = renderFullGenerated();
  scheduleMathTypeset();
}

function renderSyncLog() {
  if (!dom.syncLog) return;
  const events = state.sync?.events || [];
  if (!events.length) {
    dom.syncLog.innerHTML = '<div class="empty-state">Sync events will appear here when you import the bank.</div>';
    return;
  }
  dom.syncLog.innerHTML = events.slice().reverse().map((event) => `
    <div class="log-item">
      <strong>${esc(event.title || event.type)}</strong>
      <div>${esc(event.detail || '')}</div>
    </div>
  `).join('');
}

async function getDemoRuntime() {
  if (!IS_DEMO) return null;
  if (!demoRuntimePromise) {
    demoRuntimePromise = createDemoRuntime({
      demoDataUrl: DEMO_DATA_URL,
      scoreTablesUrl: SCORE_TABLES_URL,
      buildId: BUILD_ID
    }).then((runtime) => {
      state.demoRuntime = runtime;
      return runtime;
    });
  }
  return demoRuntimePromise;
}

function openPrintablePreview(htmlContent) {
  const win = window.open('', '_blank', 'noopener,noreferrer');
  if (!win) return false;
  win.document.open();
  win.document.write(htmlContent);
  win.document.close();
  win.focus();
  setTimeout(() => {
    try {
      win.print();
    } catch {
      // Ignore print failures if the preview is blocked.
    }
  }, 250);
  return true;
}

async function api(path, options = {}) {
  if (IS_DEMO) {
    const runtime = await getDemoRuntime();
    return runtime.handleApi(path, options);
  }
  const response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  if (response.headers.get('content-type')?.includes('application/json')) {
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || response.statusText);
    }
    return data;
  }
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response;
}

function readFilters() {
  return {
    assessment: state.filters.assessment,
    test: state.filters.test,
    domains: [...state.filters.domains],
    difficulty: [...state.filters.difficulty],
    excludeActive: state.filters.excludeActive,
    neverSeenBefore: state.filters.neverSeenBefore,
    stateCd: state.filters.stateCd,
    search: state.filters.search,
    skill: state.filters.skill,
    limit: Number(state.filters.limit) || 24,
    seed: state.filters.seed,
    mode: state.filters.mode,
    practiceOnlyHard: state.filters.practiceOnlyHard,
    practiceTimerMinutes: normalizePracticeMinutes(state.filters.practiceTimerMinutes),
    fullTestCountRw: Number(state.filters.fullTestCountRw) || 54,
    fullTestCountMath: Number(state.filters.fullTestCountMath) || 44
  };
}

async function refreshQuestions() {
  setLoadingState('refresh', true);
  render();
  try {
    alignFiltersToAvailableQuestions();
    const query = new URLSearchParams();
    const filters = readFilters();
    for (const [key, value] of Object.entries(filters)) {
      if (Array.isArray(value)) {
        value.forEach((entry) => query.append(key, entry));
      } else if (value !== '' && value !== false && value != null) {
        query.set(key, String(value));
      }
    }
    state.questions = await api(`/api/questions?${query.toString()}`);
  } finally {
    setLoadingState('refresh', false);
    render();
  }
}

async function refreshMeta() {
  try {
    state.meta = await api('/api/meta');
    state.sync = await api('/api/sync/status');
    render();
  } finally {
    setLoadingState('initial', false);
  }
}

async function startSync() {
  setLoadingState('sync', true);
  render();
  try {
    if (IS_DEMO) {
      await refreshMeta();
      await refreshQuestions();
      render();
      return;
    }
    state.sync = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({
        cookie: '',
        resume: true
      })
    });
    render();
  } finally {
    if (IS_DEMO) {
      setLoadingState('sync', false);
      render();
    }
  }
}

async function generateSet() {
  setLoadingState('generate', true);
  render();
  try {
    alignFiltersToAvailableQuestions();
    const payload = {
      ...readFilters(),
      mode: state.tab === 'fulltest' ? 'full-test' : 'practice'
    };
    const result = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (result.mode === 'practice') {
      if (!Array.isArray(result.items) || result.items.length === 0) {
        clearPracticeTimer();
        state.generated = null;
        state.uiNotice = 'No questions matched the current setup. Change the section or broaden the advanced filters, then try again.';
        render();
        return;
      }
      setPracticeSetState(result);
      render();
    } else {
      if (result.mode === 'full-test' && Array.isArray(result.items) && result.items.length > 0) {
        setPracticeSetState(result);
        render();
      } else {
        clearPracticeTimer();
        state.generated = result;
        renderGenerated();
      }
    }
  } finally {
    setLoadingState('generate', false);
    render();
  }
}

async function exportSet(format) {
  if (!state.generated?.id) {
    await generateSet();
  }
  if (IS_DEMO) {
    const runtime = await getDemoRuntime();
    if (format === 'pdf') {
      const html = runtime.buildPdfPreviewHtml(state.generated);
      if (!openPrintablePreview(html)) {
        window.alert('Popup blocked. Allow popups to open the printable PDF preview.');
      }
      return;
    }
    const blob = runtime.buildExportBlob(state.generated, format);
    if (!blob) {
      throw new Error(`Demo export does not support ${format}.`);
    }
    downloadBlob(blob, `${state.generated.id}.${format}`);
    return;
  }
  const response = await fetch(`/api/sets/${state.generated.id}/export.${format}`);
  if (!response.ok) {
    throw new Error(await response.text());
  }
  if (format === 'json') {
    const blob = await response.blob();
    downloadBlob(blob, `${state.generated.id}.json`);
  } else if (format === 'csv') {
    const blob = await response.blob();
    downloadBlob(blob, `${state.generated.id}.csv`);
  } else if (format === 'pdf') {
    const blob = await response.blob();
    downloadBlob(blob, `${state.generated.id}.pdf`);
  }
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function inspectQuestion(externalId) {
  clearPracticeTimer();
  const question = await api(`/api/questions/${encodeURIComponent(externalId)}`);
  const history = await api(`/api/questions/${encodeURIComponent(externalId)}/history`);
  state.generated = {
    id: `inspect-${externalId}`,
    mode: 'inspect',
    name: `Inspection: ${externalId}`,
    items: [question],
    summary: { count: 1 },
    score: {},
    history
  };
  renderGenerated();
}

async function addQuestion(externalId) {
  clearPracticeTimer();
  const question = state.questions.find((row) => row.external_id === externalId);
  if (!question) return;
  const next = state.generated?.items ? [...state.generated.items] : [];
  if (!next.some((row) => row.external_id === externalId)) {
    next.push(question);
  }
  state.generated = {
    id: state.generated?.id || `manual-${Date.now()}`,
    mode: 'manual',
    name: 'Manual collection',
    items: next,
    summary: { count: next.length },
    score: {}
  };
  renderGenerated();
}

function wireEvents() {
  app.addEventListener('click', async (event) => {
    const tab = event.target.closest('[data-tab]')?.dataset.tab;
    if (tab) {
      state.tab = tab;
      setHashTab(tab);
      render();
      return;
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    try {
      if (action === 'refresh') {
        await refreshMeta();
        await refreshQuestions();
      } else if (action === 'sync') {
        await startSync();
        await pollSync();
      } else if (action === 'generate') {
        await generateSet();
      } else if (action === 'export-json') {
        await exportSet('json');
      } else if (action === 'export-csv') {
        await exportSet('csv');
      } else if (action === 'export-pdf') {
        await exportSet('pdf');
      } else if (action === 'inspect') {
        await inspectQuestion(event.target.closest('[data-external-id]').dataset.externalId);
      } else if (action === 'add') {
        await addQuestion(event.target.closest('[data-external-id]').dataset.externalId);
      } else if (action === 'practice-start') {
        startPracticeTimer();
      } else if (action === 'practice-pause') {
        pausePracticeTimer();
      } else if (action === 'practice-reset') {
        resetPracticeTimer(state.filters.practiceTimerMinutes);
        renderGenerated();
      } else if (action === 'practice-submit') {
        if (isFullTestMode()) {
          advanceFullTestFlow(false);
        } else {
          submitPracticeTest();
        }
      } else if (action === 'break-start-early') {
        advanceFullTestFlow(false);
      } else if (action === 'practice-toggle-review') {
        togglePracticeReview();
      } else if (action === 'practice-toggle-timer') {
        togglePracticeTimerHidden();
      } else if (action === 'practice-toggle-directions') {
        state.practice.showDirections = !state.practice.showDirections;
        renderGenerated();
      } else if (action === 'practice-nav-toggle') {
        state.practice.navOpen = !state.practice.navOpen;
        renderGenerated();
      } else if (action === 'calculator-toggle') {
        toggleCalculator();
      } else if (action === 'calculator-close') {
        closeCalculator();
      } else if (action === 'reference-toggle') {
        toggleReferenceSheet();
      } else if (action === 'reference-close') {
        closeReferenceSheet();
      } else if (action === 'practice-next') {
        goToPracticeIndex(state.practice.currentIndex + 1);
      } else if (action === 'practice-prev') {
        goToPracticeIndex(state.practice.currentIndex - 1);
      } else if (action === 'practice-jump') {
        goToPracticeIndex(Number(event.target.closest('[data-index]')?.dataset.index || 0));
      } else if (action === 'practice-select') {
        selectPracticeChoice(event.target.closest('[data-choice]')?.dataset.choice);
      } else if (action === 'practice-eliminate') {
        togglePracticeElimination(event.target.closest('[data-choice]')?.dataset.choice);
      } else if (action === 'results-tab') {
        state.practice.resultsTab = event.target.closest('[data-tab]')?.dataset.tab || 'all';
        state.practice.page = 1;
        render();
      } else if (action === 'results-sort') {
        toggleResultsSort(event.target.closest('[data-key]')?.dataset.key || 'number');
        render();
      } else if (action === 'results-page') {
        state.practice.page = Math.max(1, Number(event.target.closest('[data-page]')?.dataset.page || 1));
        render();
      } else if (action === 'results-view-size') {
        const value = event.target.closest('[data-value]')?.dataset.value || '10';
        state.practice.viewSize = value === 'all' ? 'all' : Number(value || 10);
        state.practice.page = 1;
        render();
      } else if (action === 'results-review') {
        state.practice.reviewModal.open = true;
        state.practice.reviewModal.questionNumber = Number(event.target.closest('[data-question-number]')?.dataset.questionNumber || 1);
        state.practice.reviewModal.showExplanation = false;
        render();
      } else if (action === 'results-modal-close') {
        if (event.target.closest('[data-modal-panel]')) return;
        state.practice.reviewModal.open = false;
        render();
      } else if (action === 'results-modal-prev') {
        state.practice.reviewModal.questionNumber = Math.max(1, Number(state.practice.reviewModal.questionNumber || 1) - 1);
        render();
      } else if (action === 'results-modal-next') {
        const totalQuestions = buildResultsModel()?.questions.length || 1;
        state.practice.reviewModal.questionNumber = Math.min(totalQuestions, Number(state.practice.reviewModal.questionNumber || 1) + 1);
        render();
      } else if (action === 'results-review-all') {
        state.practice.reviewModal.open = true;
        state.practice.reviewModal.questionNumber = 1;
        state.practice.reviewModal.showExplanation = false;
        render();
      } else if (action === 'results-practice-specific') {
        state.generated = null;
        clearPracticeTimer();
        state.tab = 'builder';
        state.practice.reviewReady = false;
        render();
      } else if (action === 'results-bank' || action === 'results-home') {
        state.generated = null;
        clearPracticeTimer();
        state.tab = 'library';
        state.practice.reviewReady = false;
        render();
      }
    } catch (error) {
      window.alert(error.message || String(error));
    }
  });

  app.addEventListener('keydown', (event) => {
    const target = event.target;
    if (!target?.matches?.('[data-action="practice-select"]')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    selectPracticeChoice(target.dataset.choice);
  });

  app.addEventListener('change', async (event) => {
    const target = event.target;
    if (target.matches('[data-action="results-toggle-correct"]')) {
      state.practice.showCorrectAnswers = target.checked;
      render();
      return;
    }
    if (target.matches('[data-action="results-modal-toggle"]')) {
      state.practice.reviewModal.showExplanation = target.checked;
      render();
      return;
    }
    if (!target.matches('[data-filter], [data-domain], [data-difficulty]')) return;

    if (target.dataset.filter === 'assessment') {
      state.filters.assessment = target.value;
      if (!hasAvailableQuestionSlice(state.filters.assessment, state.filters.test)) {
        const fallback = findFallbackQuestionSlice(state.filters.assessment);
        if (fallback) {
          state.filters.test = String(fallback.test_id);
          state.filters.domains = defaultDomainsForTest(fallback.test_id);
          state.uiNotice = `Section switched to ${fallback.test_text} because that is the cached section available for this assessment.`;
        }
      }
    }
    if (target.dataset.filter === 'test') {
      state.filters.test = target.value;
      state.filters.domains = defaultDomainsForTest(target.value);
    }
    if (target.dataset.filter === 'search') state.filters.search = target.value;
    if (target.dataset.filter === 'skill') state.filters.skill = target.value;
    if (target.dataset.filter === 'stateCd') state.filters.stateCd = target.value;
    if (target.dataset.filter === 'excludeActive') state.filters.excludeActive = target.checked;
    if (target.dataset.filter === 'neverSeenBefore') state.filters.neverSeenBefore = target.checked;
    if (target.dataset.filter === 'limit') state.filters.limit = Number(target.value || 0);
    if (target.dataset.filter === 'seed') state.filters.seed = target.value;
    if (target.dataset.filter === 'mode') state.filters.mode = target.value;
    if (target.dataset.filter === 'practiceOnlyHard') state.filters.practiceOnlyHard = target.checked;
    if (target.dataset.filter === 'practiceTimerMinutes') {
      state.filters.practiceTimerMinutes = normalizePracticeMinutes(target.value);
      state.practice.timer.minutes = state.filters.practiceTimerMinutes;
    }
    if (target.dataset.filter === 'fullTestCountRw') state.filters.fullTestCountRw = Number(target.value || 0);
    if (target.dataset.filter === 'fullTestCountMath') state.filters.fullTestCountMath = Number(target.value || 0);
    if (target.dataset.domain) {
      if (target.checked) state.filters.domains.add(target.dataset.domain);
      else state.filters.domains.delete(target.dataset.domain);
    }
    if (target.dataset.difficulty) {
      if (target.checked) state.filters.difficulty.add(target.dataset.difficulty);
      else state.filters.difficulty.delete(target.dataset.difficulty);
    }
    state.uiNotice = '';
    await refreshQuestions();
    render();
  });
}

async function pollSync() {
  state.sync = await api('/api/sync/status');
  renderSyncLog();
  if (state.sync.status === 'running') {
    setTimeout(pollSync, 2500);
  } else {
    setLoadingState('sync', false);
    render();
  }
}

async function init() {
  state.tab = activeTabFromHash();
  wireEvents();
  render();
  const scoreTablesReady = getScoreTables().catch(() => {});
  await refreshMeta();
  await refreshQuestions();
  await scoreTablesReady;
  await pollSync();
  window.addEventListener('hashchange', () => {
    state.tab = activeTabFromHash();
    render();
  });
}

init().catch((error) => {
  app.innerHTML = `<pre class="empty-state">Failed to load app: ${esc(error.stack || error.message)}</pre>`;
});
