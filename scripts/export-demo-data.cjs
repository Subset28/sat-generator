const fs = require('node:fs');
const path = require('node:path');
const { initStore } = require('../server/lib/storage.cjs');

const repoRoot = path.resolve(__dirname, '..');
const outputPath = path.join(repoRoot, 'data', 'demo-data.json');

const DEMO_LIMIT = 500;

function pickBalanced(questions, total) {
  const buckets = new Map();
  for (const q of questions) {
    const key = `${q.test_id}:${q.primary_class_cd}:${q.difficulty}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(q);
  }
  const keys = [...buckets.keys()];
  const result = [];
  let round = 0;
  while (result.length < total) {
    let added = 0;
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (round < bucket.length) {
        result.push(bucket[round]);
        added++;
        if (result.length >= total) break;
      }
    }
    if (added === 0) break;
    round++;
  }
  return result;
}

async function main() {
  console.log('Loading question bank...');
  const store = await initStore();

  const allQuestions = store.listQuestions({ excludeActive: false });
  const lookups = store.getLookups();

  const selected = pickBalanced(allQuestions, DEMO_LIMIT);
  console.log(`Selected ${selected.length} balanced questions from ${allQuestions.length} total...`);

  const questions = selected.map((q, index) => ({
    question_id: q.question_id,
    external_id: q.external_id,
    assessment_id: String(q.assessment_id),
    assessment_text: q.assessment_text,
    test_id: String(q.test_id),
    test_text: q.test_text,
    primary_class_cd: q.primary_class_cd,
    primary_class_cd_desc: q.primary_class_cd_desc,
    skill_cd: q.skill_cd,
    skill_desc: q.skill_desc,
    difficulty: q.difficulty,
    score_band_range_cd: q.score_band_range_cd,
    is_active: Boolean(q.is_active),
    question_order: index + 1,
    content_hash: q.content_hash,
    search_text: q.search_text || null,
    rationale_text: q.rationale_text || null,
    rendered_prompt_html: q.rendered_prompt_html || null,
    rendered_rationale_html: q.rendered_rationale_html || null,
    answerOptions: (q.answerOptions || []).map((opt) => ({
      letter: opt.letter,
      content: opt.content,
      rendered_html: opt.rendered_html || opt.content
    })),
    correctAnswer: q.correctAnswer || []
  }));

  const demoData = {
    meta: {
      lookupData: lookups,
      stateOfferings: [],
      counts: {
        questions: questions.length,
        assets: 0,
        sets: 0
      }
    },
    questions
  };

  const json = JSON.stringify(demoData);
  fs.writeFileSync(outputPath, json);

  const sizeMb = (Buffer.byteLength(json) / 1024 / 1024).toFixed(1);
  const bySection = {};
  for (const q of questions) {
    bySection[q.test_text] = (bySection[q.test_text] || 0) + 1;
  }
  console.log(`Wrote ${questions.length} questions to data/demo-data.json (${sizeMb} MB)`);
  console.log('By section:', bySection);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
