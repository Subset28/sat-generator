const { initStore } = require('../lib/storage.cjs');
const { sanitizeHtml } = require('../lib/sanitize.cjs');

async function main() {
  const store = await initStore();
  const rows = store.queryAll(
    store.db,
    'SELECT id, stem_html, stimulus_html, prompt_html, rationale_html, rendered_prompt_html, rendered_rationale_html, answer_options_json FROM question_versions'
  );

  for (const row of rows) {
    let answerOptions = [];
    try {
      answerOptions = JSON.parse(row.answer_options_json || '[]');
    } catch {
      answerOptions = [];
    }

    const sanitizedAnswerOptions = answerOptions.map((choice) => {
      const content = sanitizeHtml(choice.content || '');
      return {
        ...choice,
        content,
        rendered_html: sanitizeHtml(choice.rendered_html || content)
      };
    });

    store.exec(
      store.db,
      `UPDATE question_versions
       SET stem_html = ?,
           stimulus_html = ?,
           prompt_html = ?,
           rationale_html = ?,
           rendered_prompt_html = ?,
           rendered_rationale_html = ?,
           answer_options_json = ?
       WHERE id = ?`,
      [
        sanitizeHtml(row.stem_html || ''),
        sanitizeHtml(row.stimulus_html || ''),
        sanitizeHtml(row.prompt_html || ''),
        sanitizeHtml(row.rationale_html || ''),
        sanitizeHtml(row.rendered_prompt_html || ''),
        sanitizeHtml(row.rendered_rationale_html || ''),
        JSON.stringify(sanitizedAnswerOptions),
        row.id
      ]
    );
  }

  store.save();
  console.log(`Repaired ${rows.length} question versions.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
