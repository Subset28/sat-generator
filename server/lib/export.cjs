const fs = require('node:fs');
const path = require('node:path');
const { registerRuntimeNodeModules, runtimeNodeModules } = require('./runtime.cjs');

let playwrightPromise;

function loadPlaywright() {
  if (!playwrightPromise) {
    registerRuntimeNodeModules();
    playwrightPromise = Promise.resolve().then(() => {
      try {
        return require(path.join(runtimeNodeModules, 'playwright'));
      } catch (error) {
        throw new Error(`Playwright is unavailable. Set NODE_PATH to ${runtimeNodeModules} or install the bundled runtime. Original error: ${error.message}`);
      }
    });
  }
  return playwrightPromise;
}

function toCsv(items) {
  const headers = [
    'order', 'external_id', 'question_id', 'assessment', 'section', 'domain',
    'skill', 'difficulty', 'is_active', 'correct_answer', 'prompt_text'
  ];
  const lines = [headers.join(',')];
  for (const [index, row] of items.entries()) {
    lines.push(headers.map((key) => csvValue({
      order: index + 1,
      external_id: row.external_id,
      question_id: row.question_id,
      assessment: row.assessment_text,
      section: row.section_text,
      domain: row.primary_class_cd_desc,
      skill: row.skill_desc,
      difficulty: row.difficulty,
      is_active: row.is_active ? 'yes' : 'no',
      correct_answer: Array.isArray(row.correct_answer) ? row.correct_answer.join(' ') : row.correct_answer,
      prompt_text: stripTags(row.rendered_prompt_html || row.prompt_html || row.stimulus_html || row.stem_html || '')
    }[key])).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function csvValue(value) {
  const text = String(value ?? '');
  if (/[,"\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function stripTags(value) {
  return String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function renderPrintableHtml(set, scoreTables) {
  const meta = set.score || {};
  const rows = (set.items || []).map((row, index) => `
    <article class="print-card">
      <div class="print-meta">
        <span>#${index + 1}</span>
        <span>${escapeHtml(row.primary_class_cd_desc || '')}</span>
        <span>${escapeHtml(row.skill_desc || '')}</span>
        <span>${escapeHtml(String(row.difficulty || ''))}</span>
      </div>
      <div class="print-body">
        ${row.rendered_prompt_html || row.prompt_html || row.stimulus_html || row.stem_html || ''}
        ${row.rendered_choices_html ? `<div class="print-choices">${row.rendered_choices_html}</div>` : ''}
        ${row.rationale_html ? `<div class="print-rationale">${row.rationale_html}</div>` : ''}
      </div>
    </article>
  `).join('\n');

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <base href="http://127.0.0.1:8787/" />
      <script>
        window.MathJax = {
          startup: {
            typeset: false
          }
        };
      </script>
      <script src="/vendor/mathjax-full/es5/mml-svg.js"></script>
      <style>
        @page { size: letter; margin: 0.55in; }
        body { font-family: Georgia, serif; color: #111827; }
        h1 { margin: 0 0 12px; font-size: 24px; }
        .summary { display: grid; gap: 6px; margin-bottom: 18px; font-family: Arial, sans-serif; }
        .summary div { font-size: 12px; color: #334155; }
        .print-card { break-inside: avoid; padding: 14px 0; border-top: 1px solid #cbd5e1; }
        .print-card:first-of-type { border-top: 0; }
        .print-meta { display: flex; gap: 10px; flex-wrap: wrap; font: 700 11px Arial, sans-serif; text-transform: uppercase; color: #64748b; }
        .print-body { font-size: 14px; line-height: 1.6; }
        .print-body img { max-width: 100%; height: auto; }
        .print-choices, .print-rationale { margin-top: 10px; }
        .mathjax svg { max-width: 100%; height: auto; }
      </style>
    </head>
    <body>
      <h1>${escapeHtml(set.name || 'Generated SAT Set')}</h1>
      <div class="summary">
        <div>Mode: ${escapeHtml(set.mode || 'practice')}</div>
        <div>Seed: ${escapeHtml(set.seed || '')}</div>
        <div>Raw score: ${escapeHtml(String(meta.raw_total ?? '—'))}</div>
        <div>Estimated score: ${escapeHtml(String(meta.estimated_total ?? '—'))}</div>
      </div>
      ${rows}
      <script>
        (async function () {
          if (window.MathJax?.startup?.promise) {
            try {
              await window.MathJax.startup.promise;
              await window.MathJax.typesetPromise();
            } catch (error) {
              console.warn(error);
            }
          }
        })();
      </script>
    </body>
  </html>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

async function renderPdfBuffer(set, scoreTables) {
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  await page.setContent(renderPrintableHtml(set, scoreTables), { waitUntil: 'networkidle' });
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ format: 'Letter', printBackground: true });
  await browser.close();
  return pdf;
}

module.exports = {
  renderPrintableHtml,
  renderPdfBuffer,
  toCsv
};
