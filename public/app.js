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
  demoRuntime: null,
  tab: 'library',
  sync: null,
  fallbackApplied: false,
  practice: {
    currentIndex: 0,
    responses: {},
    markedForReview: new Set(),
    navOpen: false,
    showDirections: false,
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
    assessment: '99',
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

const difficultyLabel = {
  E: 'Easy',
  M: 'Medium',
  H: 'Hard'
};

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

function setHashTab(tab) {
  location.hash = `#${tab}`;
}

function activeTabFromHash() {
  return ['library', 'builder', 'fulltest', 'exports'].includes(location.hash.slice(1))
    ? location.hash.slice(1)
    : 'library';
}

function normalizePracticeMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return 30;
  return Math.min(180, Math.max(1, Math.round(minutes)));
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
}

function tickPracticeTimer() {
  if (state.generated?.mode !== 'practice') {
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
  }
  renderGenerated();
}

function startPracticeTimer() {
  if (state.generated?.mode !== 'practice') return;
  if (state.practice.timer.completed) return;
  if (state.practice.timer.running) return;
  state.practice.timer.running = true;
  state.practice.timer.startedAt = Date.now();
  state.practice.timer.lastTickAt = Date.now();
  if (!practiceTimerHandle) {
    practiceTimerHandle = setInterval(tickPracticeTimer, 1000);
  }
  renderGenerated();
}

function pausePracticeTimer() {
  if (!state.practice.timer.running) return;
  tickPracticeTimer();
  state.practice.timer.running = false;
  clearPracticeTimer();
  renderGenerated();
}

function setPracticeSetState(result) {
  state.generated = result;
  state.practice.currentIndex = 0;
  state.practice.responses = {};
  state.practice.markedForReview = new Set();
  state.practice.showDirections = false;
  state.practice.navOpen = false;
  resetPracticeTimer(state.filters.practiceTimerMinutes);
  if (result?.mode === 'practice') {
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
  return state.generated?.mode === 'practice';
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
  renderGenerated();
}

function getCurrentPracticeQuestion() {
  if (!state.generated?.items?.length) return null;
  const safeIndex = Math.min(Math.max(0, state.practice.currentIndex), state.generated.items.length - 1);
  return state.generated.items[safeIndex] || null;
}

function getPracticeResponse(externalId) {
  if (!externalId) {
    return { selected: null, eliminated: [], submitted: false };
  }
  if (!state.practice.responses[externalId]) {
    state.practice.responses[externalId] = {
      selected: null,
      eliminated: [],
      submitted: false
    };
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
  if (!state.generated?.items?.length) return 0;
  return state.generated.items.filter((item) => getPracticeResponse(item.external_id).submitted).length;
}

function goToPracticeIndex(nextIndex) {
  if (!state.generated?.items?.length) return;
  submitPracticeAnswer();
  const clamped = Math.min(Math.max(0, nextIndex), state.generated.items.length - 1);
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
  response.selected = letter;
  response.eliminated = response.eliminated.filter((entry) => entry !== letter);
  renderGenerated();
}

function submitPracticeAnswer() {
  const current = getCurrentPracticeQuestion();
  if (!current) return;
  const response = getPracticeResponse(current.external_id);
  response.submitted = true;
  renderGenerated();
}

function countPracticeCorrect() {
  if (!state.generated?.items?.length) return 0;
  return state.generated.items.reduce((count, item) => {
    const response = getPracticeResponse(item.external_id);
    if (!response.submitted || !response.selected) return count;
    const correctLetters = getCorrectLetters(item);
    const selectedChoice = findSelectedChoice(item, response);
    const selectedIndex = (item.answerOptions || []).findIndex((choice, index) => getChoiceLetter(choice, index) === response.selected);
    return count + (selectedChoice && choiceMatchesCorrect(selectedChoice, selectedIndex, correctLetters) ? 1 : 0);
  }, 0);
}

function render() {
  const meta = state.meta || {};
  const sync = state.sync || {};
  const practiceMode = isPracticeMode();
  const loadingLabel = IS_DEMO
    ? 'Pages Demo'
    : sync.status === 'running'
    ? `Syncing ${sync.progress?.done ?? 0}/${sync.progress?.total ?? 0}`
    : sync.status === 'failed'
      ? 'Sync failed'
      : sync.status === 'complete'
        ? 'Synced'
        : 'Idle';

  document.body.classList.toggle('practice-mode', practiceMode);
  if (!practiceMode && state.calculator.open) {
    state.calculator.open = false;
    dom.calculatorOverlay?.classList.add('hidden');
  }
  if (!practiceMode && state.reference.open) {
    state.reference.open = false;
    dom.referenceOverlay?.classList.add('hidden');
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
          <button class="btn" data-action="refresh">Refresh</button>
          <button class="btn primary" data-action="sync">${IS_DEMO ? 'Reload Demo' : 'Sync EQB'}</button>
          <button class="btn" data-action="export-json">Export JSON</button>
          <button class="btn" data-action="export-csv">Export CSV</button>
          <button class="btn" data-action="export-pdf">Export PDF</button>
        </div>
      </section>

      <section class="layout">
        <aside class="panel ${practiceMode ? 'hidden' : ''}">
          <div class="panel-header">
            <h2 class="panel-title">Controls</h2>
            <p class="panel-subtitle">Tune bank filters, randomization, and full-test settings.</p>
          </div>
          <div class="panel-body">
            <div class="stack">
              <div class="filter-group">
                <h3>Mode</h3>
                <div class="tabbar">
                  ${['library', 'builder', 'fulltest', 'exports'].map((tab) => `
                    <button class="tab ${state.tab === tab ? 'active' : ''}" data-tab="${tab}">
                      ${tab === 'library' ? 'Library' : tab === 'builder' ? 'Practice Sets' : tab === 'fulltest' ? 'Full Test' : 'Exports'}
                    </button>
                  `).join('')}
                </div>
              </div>

              <div class="filter-group">
                <h3>Assessment</h3>
                <div class="field">
                  <label for="assessment">Assessment</label>
                  <select id="assessment" data-filter="assessment">
                    ${(meta.lookupData?.assessment || []).map((row) => `
                      <option value="${esc(row.id)}" ${String(row.id) === state.filters.assessment ? 'selected' : ''}>${esc(row.text)}</option>
                    `).join('')}
                  </select>
                </div>
                <div class="field">
                  <label for="test">Section</label>
                  <select id="test" data-filter="test">
                    ${(meta.lookupData?.test || []).map((row) => `
                      <option value="${esc(row.id)}" ${String(row.id) === state.filters.test ? 'selected' : ''}>${esc(row.text)}</option>
                    `).join('')}
                  </select>
                </div>
              </div>

              <div class="filter-group">
                <h3>Topics</h3>
                <div class="chips">
                  ${buildDomainChips(meta)}
                </div>
              </div>

              <div class="filter-group">
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

              <div class="filter-group">
                <h3>Search</h3>
                <div class="field">
                  <label for="search">Text search</label>
                  <input id="search" data-filter="search" value="${esc(state.filters.search)}" placeholder="Search prompt, skill, or rationale" />
                </div>
                <div class="field">
                  <label for="skill">Skill contains</label>
                  <input id="skill" data-filter="skill" value="${esc(state.filters.skill)}" placeholder="e.g. Inferences" />
                </div>
              </div>

              <div class="filter-group">
                <h3>Live / Standards</h3>
                <div class="field">
                  <label for="stateCd">State standards</label>
                  <select id="stateCd" data-filter="stateCd">
                    <option value="">All states</option>
                    ${(meta.stateOfferings || []).map((row) => `
                      <option value="${esc(row.stateCd)}" ${row.stateCd === state.filters.stateCd ? 'selected' : ''}>${esc(row.name)} (${esc(row.stateCd)})</option>
                    `).join('')}
                  </select>
                </div>
                <label class="chip">
                  <input type="checkbox" data-filter="excludeActive" ${state.filters.excludeActive ? 'checked' : ''} />
                  Exclude active items
                </label>
                <label class="chip">
                  <input type="checkbox" data-filter="neverSeenBefore" ${state.filters.neverSeenBefore ? 'checked' : ''} />
                  Only never seen before
                </label>
              </div>

              <div class="filter-group">
                <h3>Generator</h3>
                <div class="field">
                  <label for="limit">Practice count</label>
                  <input id="limit" data-filter="limit" type="number" min="1" max="200" value="${esc(state.filters.limit)}" />
                </div>
                <div class="field">
                  <label for="seed">Seed</label>
                  <input id="seed" data-filter="seed" value="${esc(state.filters.seed)}" />
                </div>
                <div class="field">
                  <label for="mode">Generator mode</label>
                  <select id="mode" data-filter="mode">
                    <option value="practice" ${state.filters.mode === 'practice' ? 'selected' : ''}>Filtered practice set</option>
                    <option value="full-test" ${state.filters.mode === 'full-test' ? 'selected' : ''}>Full test</option>
                  </select>
                </div>
                <div class="field">
                  <label for="practiceTimerMinutes">Practice timer</label>
                  <input id="practiceTimerMinutes" data-filter="practiceTimerMinutes" type="number" min="1" max="180" value="${esc(state.filters.practiceTimerMinutes)}" />
                  <div class="field-help">Starts when you generate a practice set.</div>
                </div>
                <label class="chip">
                  <input type="checkbox" data-filter="practiceOnlyHard" ${state.filters.practiceOnlyHard ? 'checked' : ''} />
                  Hardest practice questions only
                </label>
                <div class="field">
                  <label for="fullTestCountRw">Full test RW count</label>
                  <input id="fullTestCountRw" data-filter="fullTestCountRw" type="number" min="1" max="60" value="${esc(state.filters.fullTestCountRw)}" />
                </div>
                <div class="field">
                  <label for="fullTestCountMath">Full test Math count</label>
                  <input id="fullTestCountMath" data-filter="fullTestCountMath" type="number" min="1" max="60" value="${esc(state.filters.fullTestCountMath)}" />
                </div>
                <button class="btn primary" data-action="generate">Generate</button>
              </div>

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
                <h2 class="panel-title">${state.tab === 'fulltest' ? 'Full Test Builder' : state.tab === 'builder' ? 'Practice Set Builder' : 'Question Library'}</h2>
                <p class="panel-subtitle">${state.tab === 'fulltest'
                  ? 'Generate SAT-length sections with an estimated score view.'
                  : state.tab === 'builder'
                    ? 'Generate random filtered sets with the EQB metadata preserved.'
                    : 'Browse, inspect, and filter the synced bank.'}</p>
              </div>
              <div class="badge">Showing <strong>${state.questions.length}</strong> questions</div>
            </div>
            <div class="content-list" id="libraryList"></div>
          `}
        </main>

        <aside class="panel right-panel ${practiceMode ? 'hidden' : ''}">
          <div class="panel-header">
            <h2 class="panel-title">${state.generated?.mode === 'practice' ? 'Practice Runner' : state.generated?.mode === 'inspect' ? 'Question History' : 'Generated Set'}</h2>
            <p class="panel-subtitle">${state.generated?.mode === 'practice'
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
        <div class="small">ID ${esc(row.external_id)} • ${esc(row.questionId || '')} • Score band ${esc(row.score_band_range_cd ?? '')}</div>
        <div class="small">Correct: ${esc(correct)}</div>
        <div class="small">${esc(seenLabel)}${lastSeenLabel ? ` • ${esc(lastSeenLabel)}` : ''}</div>
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
  const correct = response.submitted && choiceMatchesCorrect(choice, index, correctLetters);
  const wrong = response.submitted && selected && !correct;
  const classes = [
    'choice-row',
    eliminated ? 'eliminated' : '',
    selected ? 'selected' : '',
    correct ? 'correct' : '',
    wrong ? 'incorrect' : ''
  ].filter(Boolean).join(' ');
  return html`
    <div class="${classes}">
      <div class="choice-main" role="button" tabindex="0" data-action="practice-select" data-choice="${esc(letter)}" data-external-id="${esc(row.external_id)}" aria-disabled="${response.submitted ? 'true' : 'false'}">
        <span class="choice-letter">${esc(letter)}</span>
        <div class="choice-content">${choice.rendered_html || choice.content || ''}</div>
      </div>
      <button class="choice-eliminate" data-action="practice-eliminate" data-choice="${esc(letter)}" data-external-id="${esc(row.external_id)}" ${response.submitted ? 'disabled' : ''}>
        <span aria-hidden="true">${eliminated ? '↺' : '⊘'}</span>
        <span class="sr-only">${eliminated ? 'Restore choice' : 'Eliminate choice'}</span>
      </button>
    </div>
  `;
}

function renderPracticeProgress(currentIndex) {
  return (state.generated?.items || []).map((item, index) => {
    const itemResponse = getPracticeResponse(item.external_id);
    const marked = state.practice.markedForReview.has(item.external_id);
    const active = index === currentIndex;
    const done = itemResponse.submitted;
    return `<span class="exam-progress-segment ${active ? 'active' : ''} ${done ? 'done' : ''} ${marked ? 'marked' : ''}"></span>`;
  }).join('');
}

function renderPracticeQuestionPicker(currentIndex) {
  const total = state.generated?.items?.length || 0;
  return html`
    <details class="question-picker" ${state.practice.navOpen ? 'open' : ''}>
      <summary data-action="practice-nav-toggle">Question ${esc(currentIndex + 1)} of ${esc(total)} <span class="picker-caret">▾</span></summary>
      <div class="question-picker-menu">
        ${(state.generated.items || []).map((item, index) => {
          const itemResponse = getPracticeResponse(item.external_id);
          const active = index === currentIndex;
          const done = itemResponse.submitted;
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

function renderPracticeRunner() {
  if (!state.generated?.items?.length) {
    return '<div class="empty-state">Generate a practice set to start the timed runner.</div>';
  }
  const summary = state.generated.summary || {};
  const current = getCurrentPracticeQuestion();
  const currentIndex = Math.min(Math.max(0, state.practice.currentIndex), state.generated.items.length - 1);
  const response = current ? getPracticeResponse(current.external_id) : { selected: null, eliminated: [], submitted: false };
  const correctLetters = getCorrectLetters(current);
  const selectedChoice = findSelectedChoice(current, response);
  const selectedChoiceIndex = (current?.answerOptions || []).findIndex((choice, index) => getChoiceLetter(choice, index) === response.selected);
  const selectedIsCorrect = Boolean(selectedChoice) && choiceMatchesCorrect(selectedChoice, selectedChoiceIndex, correctLetters);
  const answered = getAnsweredCount();
  const correct = countPracticeCorrect();
  const timer = state.practice.timer;
  const timerLabel = timer.completed
    ? 'Time expired'
    : timer.running
      ? 'Timer running'
      : 'Timer paused';
  const hardestOnly = Boolean(state.generated?.config?.practiceOnlyHard);
  const hardestDifficulty = summary.hardestDifficulty || null;
  const sectionNumber = getPracticeSectionNumber(currentIndex);
  const moduleNumber = currentIndex >= Math.ceil(state.generated.items.length / 2) ? 2 : 1;
  const subject = getPracticeSubjectLabel(current);
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

            ${response.submitted ? html`
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
            <div class="sat-footer-meta">${esc(answered)} of ${esc(summary.count ?? state.generated.items.length)} answered</div>
            <div class="sat-footer-meta">${esc(correct)} correct</div>
            ${hardestDifficulty ? `<div class="sat-footer-meta">Hardest: ${esc(hardestDifficulty)}</div>` : ''}
            ${hardestOnly ? '<div class="sat-footer-meta">Hardest only</div>' : ''}
          </div>
          <div class="sat-footer-center">
            ${renderPracticeQuestionPicker(currentIndex)}
          </div>
          <div class="sat-footer-right">
            <button class="sat-nav-btn" data-action="practice-prev" ${currentIndex <= 0 ? 'disabled' : ''}>Back</button>
            <button class="sat-nav-btn" data-action="practice-next" ${currentIndex >= state.generated.items.length - 1 ? 'disabled' : ''}>Next</button>
          </div>
        </footer>
      </div>
    </div>
  `;
}

function renderFullGenerated() {
  const summary = state.generated?.summary || {};
  const score = state.generated?.score || {};
  return html`
    <div class="set-row">
      <div class="line1">
        <div class="title">${esc(state.generated.name || 'Generated set')}</div>
        <span class="pill">${esc(state.generated.mode)}</span>
      </div>
      <div class="meta">
        <span>Items: ${esc(summary.count ?? state.generated.items?.length ?? 0)}</span>
        <span>Seed: ${esc(state.generated.seed || '')}</span>
        <span>Raw: ${esc(score.raw_total ?? score.raw ?? '—')}</span>
        <span>Estimated: ${esc(score.estimated_total ?? '—')}</span>
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
  if (state.generated.mode === 'practice') {
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
  if (
    !state.fallbackApplied &&
    state.questions.length === 0 &&
    state.filters.assessment === '99' &&
    state.meta?.lookupData?.assessment?.some((row) => String(row.id) === '100')
  ) {
    state.fallbackApplied = true;
    state.filters.assessment = '100';
    state.filters.test = '1';
    state.filters.domains = new Set(['INI', 'CAS', 'EOI', 'SEC']);
    return refreshQuestions();
  }
  renderQuestions();
  renderGenerated();
}

async function refreshMeta() {
  state.meta = await api('/api/meta');
  state.sync = await api('/api/sync/status');
  render();
}

async function startSync() {
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
}

async function generateSet() {
  const payload = readFilters();
  const result = await api('/api/generate', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  if (result.mode === 'practice') {
    setPracticeSetState(result);
    render();
  } else {
    clearPracticeTimer();
    state.generated = result;
    renderGenerated();
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
    if (!target.matches('[data-filter], [data-domain], [data-difficulty]')) return;

    if (target.dataset.filter === 'assessment') state.filters.assessment = target.value;
    if (target.dataset.filter === 'test') {
      state.filters.test = target.value;
      state.filters.domains = new Set(target.value === '2' ? ['H', 'P', 'Q', 'S'] : ['INI', 'CAS', 'EOI', 'SEC']);
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
    await refreshQuestions();
    render();
  });
}

async function pollSync() {
  state.sync = await api('/api/sync/status');
  renderSyncLog();
  if (state.sync.status === 'running') {
    setTimeout(pollSync, 2500);
  }
}

async function init() {
  state.tab = activeTabFromHash();
  wireEvents();
  await refreshMeta();
  await refreshQuestions();
  render();
  await pollSync();
  window.addEventListener('hashchange', () => {
    state.tab = activeTabFromHash();
    render();
  });
}

init().catch((error) => {
  app.innerHTML = `<pre class="empty-state">Failed to load app: ${esc(error.stack || error.message)}</pre>`;
});
