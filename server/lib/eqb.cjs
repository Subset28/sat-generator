const { stripHtml } = require('./sanitize.cjs');

const BASE = 'https://qbank-api.collegeboard.org/msreportingquestionbank-prod/questionbank';
const DEFAULT_HEADERS = {
  'content-type': 'application/json',
  'user-agent': 'SAT-Generator/0.1 (+local)'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLimiter(maxConcurrent = 3, delayMs = 120) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= maxConcurrent) return;
    const next = queue.shift();
    if (!next) return;
    active += 1;
    (async () => {
      try {
        await sleep(delayMs);
        next.resolve(await next.fn());
      } catch (error) {
        next.reject(error);
      } finally {
        active -= 1;
        runNext();
      }
    })();
  };

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    runNext();
  });
}

async function requestJson(url, options = {}, retry = {}) {
  const {
    maxRetries = 5,
    baseDelayMs = 300,
    cookie = ''
  } = retry;
  let attempt = 0;
  while (true) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...DEFAULT_HEADERS,
          ...(cookie ? { cookie } : {}),
          ...(options.headers || {})
        }
      });
      if (response.ok) {
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await response.json();
        }
        return await response.text();
      }

      const retryable = response.status === 429 || response.status >= 500;
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      const payload = await response.text().catch(() => '');
      if (!retryable || attempt >= maxRetries) {
        throw new Error(`Request failed (${response.status}): ${payload || response.statusText}`);
      }
      const delay = retryAfter
        ? retryAfter * 1000
        : Math.round(baseDelayMs * (2 ** attempt) * (0.75 + Math.random() * 0.5));
      await sleep(delay);
      attempt += 1;
    } catch (error) {
      const message = String(error?.message || error);
      const retryable = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(message);
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }
      const delay = Math.round(baseDelayMs * (2 ** attempt) * (0.75 + Math.random() * 0.5));
      await sleep(delay);
      attempt += 1;
    }
  }
}

async function fetchLookup(cookie = '') {
  return requestJson(`${BASE}/lookup`, { method: 'GET' }, { cookie });
}

function buildQuestionParams({ asmtEventId, test, domain }) {
  return {
    asmtEventId,
    test,
    domain: Array.isArray(domain) ? domain.join(',') : String(domain || '')
  };
}

async function fetchQuestions(params, cookie = '') {
  return requestJson(`${BASE}/digital/get-questions`, {
    method: 'POST',
    body: JSON.stringify(params)
  }, { cookie });
}

async function fetchQuestion(externalId, cookie = '') {
  return requestJson(`${BASE}/digital/get-question`, {
    method: 'POST',
    body: JSON.stringify({ external_id: externalId })
  }, { cookie });
}

async function fetchQuestionBatch(externalIds, cookie = '') {
  return requestJson(`${BASE}/pdf-download`, {
    method: 'POST',
    body: JSON.stringify({ external_ids: externalIds })
  }, { cookie });
}

async function fetchStateStandards(stateCd, asmtId, cookie = '') {
  return requestJson(`${BASE}/state-standards`, {
    method: 'POST',
    body: JSON.stringify({ stateCd, asmtId })
  }, { cookie });
}

async function fetchAsText(url, cookie = '') {
  const body = await requestJson(url, { method: 'GET' }, { cookie });
  return stripHtml(body);
}

module.exports = {
  BASE,
  createLimiter,
  fetchLookup,
  buildQuestionParams,
  fetchQuestions,
  fetchQuestion,
  fetchQuestionBatch,
  fetchStateStandards,
  requestJson,
  sleep
};
