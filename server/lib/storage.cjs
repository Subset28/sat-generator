const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { registerRuntimeNodeModules, resolveRepoPath } = require('./runtime.cjs');
const { stripHtml } = require('./sanitize.cjs');

let SQL;

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function checksum(content) {
  return crypto.createHash('sha256').update(String(content)).digest('hex');
}

function questionTrackingSql(alias = 'q') {
  return `
    (SELECT COUNT(*)
     FROM generated_set_items gsi
     WHERE gsi.question_external_id = ${alias}.external_id) AS seen_count,
    (SELECT MIN(gs.created_at)
     FROM generated_set_items gsi
     JOIN generated_sets gs ON gs.id = gsi.set_id
     WHERE gsi.question_external_id = ${alias}.external_id) AS first_seen_at,
    (SELECT MAX(gs.created_at)
     FROM generated_set_items gsi
     JOIN generated_sets gs ON gs.id = gsi.set_id
     WHERE gsi.question_external_id = ${alias}.external_id) AS last_seen_at,
    (SELECT gs.id
     FROM generated_set_items gsi
     JOIN generated_sets gs ON gs.id = gsi.set_id
     WHERE gsi.question_external_id = ${alias}.external_id
     ORDER BY gs.created_at DESC, gs.id DESC
     LIMIT 1) AS last_seen_set_id,
    (SELECT gs.name
     FROM generated_set_items gsi
     JOIN generated_sets gs ON gs.id = gsi.set_id
     WHERE gsi.question_external_id = ${alias}.external_id
     ORDER BY gs.created_at DESC, gs.id DESC
     LIMIT 1) AS last_seen_set_name
  `;
}

async function loadSqlJs() {
  if (SQL) return SQL;
  registerRuntimeNodeModules();
  const initSqlJs = require(resolveRepoPath('vendor', 'sqljs', 'dist', 'sql-wasm.js'));
  const wasmPath = resolveRepoPath('vendor', 'sqljs', 'dist', 'sql-wasm.wasm');
  SQL = await initSqlJs({
    locateFile(file) {
      if (file.endsWith('.wasm')) return wasmPath;
      return resolveRepoPath('vendor', 'sqljs', 'dist', file);
    }
  });
  return SQL;
}

function exec(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    while (stmt.step()) {
      // no-op
    }
  } finally {
    stmt.free();
  }
}

function queryAll(db, sql, params = []) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    return rows;
  } finally {
    stmt.free();
  }
}

function queryOne(db, sql, params = []) {
  return queryAll(db, sql, params)[0] || null;
}

async function initStore() {
  const SQLLib = await loadSqlJs();
  const dbPath = resolveRepoPath('data', 'sat-generator.sqlite');
  let db;
  if (fs.existsSync(dbPath)) {
    const bytes = fs.readFileSync(dbPath);
    db = new SQLLib.Database(bytes);
  } else {
    db = new SQLLib.Database();
  }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA cache_size = -8000;');
  await applyMigrations(db);
  const store = createStore(db, dbPath);
  return store;
}

async function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    );
  `);
  const applied = new Set(queryAll(db, 'SELECT id FROM schema_migrations').map((row) => row.id));
  const migrationsDir = resolveRepoPath('server', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const fileName of files) {
    if (applied.has(fileName)) continue;
    const fullPath = path.join(migrationsDir, fileName);
    const sql = fs.readFileSync(fullPath, 'utf8');
    db.exec(sql);
    const appliedAt = nowIso();
    exec(db, 'INSERT OR REPLACE INTO schema_migrations (id, applied_at, checksum) VALUES (?, ?, ?)', [
      fileName,
      appliedAt,
      checksum(sql)
    ]);
  }
}

function createStore(db, dbPath) {
  let dirty = false;

  function markDirty() {
    dirty = true;
  }

  function save() {
    ensureDir(dbPath);
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    dirty = false;
  }

  function maybeSave() {
    if (dirty) save();
  }

  function transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      markDirty();
      save();
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function upsertLookup(data) {
    transaction(() => {
      db.exec('DELETE FROM lookup_assessments');
      db.exec('DELETE FROM lookup_tests');
      db.exec('DELETE FROM lookup_domains');
      db.exec('DELETE FROM lookup_skills');
      db.exec('DELETE FROM state_offerings');

      for (const row of data.lookupData?.assessment || []) {
        exec(db, 'INSERT INTO lookup_assessments (id, text) VALUES (?, ?)', [String(row.id), row.text]);
      }
      for (const row of data.lookupData?.test || []) {
        exec(db, 'INSERT INTO lookup_tests (id, text) VALUES (?, ?)', [String(row.id), row.text]);
      }
      for (const groupKey of Object.keys(data.lookupData?.domain || {})) {
        for (const row of data.lookupData.domain[groupKey] || []) {
          exec(db, 'INSERT INTO lookup_domains (assessment_group, domain_id, text, primary_class_cd) VALUES (?, ?, ?, ?)', [
            groupKey,
            String(row.id),
            row.text,
            row.primaryClassCd
          ]);
          for (const skill of row.skill || []) {
            exec(db, 'INSERT INTO lookup_skills (assessment_group, primary_class_cd, skill_id, text) VALUES (?, ?, ?, ?)', [
              groupKey,
              row.primaryClassCd,
              String(skill.id),
              skill.text
            ]);
          }
        }
      }
      for (const row of data.stateOfferings || []) {
        exec(db, 'INSERT INTO state_offerings (stateCd, name) VALUES (?, ?)', [row.stateCd, row.name]);
      }
    });
  }

  function getLookups() {
    return {
      assessment: queryAll(db, 'SELECT id, text FROM lookup_assessments ORDER BY CAST(id AS INTEGER)'),
      test: queryAll(db, 'SELECT id, text FROM lookup_tests ORDER BY CAST(id AS INTEGER)'),
      domain: {
        'R&W': queryAll(db, 'SELECT domain_id AS id, text, primary_class_cd AS primaryClassCd FROM lookup_domains WHERE assessment_group = ? ORDER BY CAST(domain_id AS INTEGER)', ['R&W']),
        Math: queryAll(db, 'SELECT domain_id AS id, text, primary_class_cd AS primaryClassCd FROM lookup_domains WHERE assessment_group = ? ORDER BY CAST(domain_id AS INTEGER)', ['Math'])
      }
    };
  }

  function upsertStateStandards(stateCd, asmtId, items) {
    transaction(() => {
      exec(db, 'DELETE FROM state_standard_mappings WHERE stateCd = ? AND asmtId = ?', [stateCd, String(asmtId)]);
      for (const row of items || []) {
        for (const standardId of row.stateStandards || []) {
          exec(db, `
            INSERT OR IGNORE INTO state_standard_mappings (stateCd, asmtId, skillCd, standardId)
            VALUES (?, ?, ?, ?)
          `, [stateCd, String(asmtId), row.skillCd, standardId]);
        }
      }
    });
  }

  function upsertQuestionBase(base, batchKey) {
    const existing = queryOne(db, 'SELECT * FROM questions WHERE external_id = ?', [base.external_id]);
    const timestamp = nowIso();
    if (!existing) {
      exec(db, `
        INSERT INTO questions (
          question_id, external_id, uId, program, assessment_id, assessment_text, test_id, test_text,
          primary_class_cd, primary_class_cd_desc, skill_cd, skill_desc, difficulty, score_band_range_cd,
          is_active, question_order, content_hash, current_version_id, last_synced_at, source_batch,
          search_text, rationale_text, changed_since_sync, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        base.question_id,
        base.external_id,
        base.uId || null,
        base.program || null,
        base.assessment_id,
        base.assessment_text,
        base.test_id,
        base.test_text,
        base.primary_class_cd,
        base.primary_class_cd_desc,
        base.skill_cd,
        base.skill_desc,
        base.difficulty,
        base.score_band_range_cd ?? null,
        base.is_active ? 1 : 0,
        base.question_order ?? 0,
        base.content_hash || null,
        base.current_version_id || null,
        timestamp,
        batchKey || null,
        base.search_text || null,
        base.rationale_text || null,
        0,
        timestamp,
        timestamp
      ]);
      markDirty();
      return queryOne(db, 'SELECT * FROM questions WHERE external_id = ?', [base.external_id]);
    }

    const changed = existing.content_hash && base.content_hash && existing.content_hash !== base.content_hash;
    exec(db, `
      UPDATE questions SET
        question_id = ?,
        uId = ?,
        program = ?,
        assessment_id = ?,
        assessment_text = ?,
        test_id = ?,
        test_text = ?,
        primary_class_cd = ?,
        primary_class_cd_desc = ?,
        skill_cd = ?,
        skill_desc = ?,
        difficulty = ?,
        score_band_range_cd = ?,
        is_active = ?,
        question_order = ?,
        content_hash = COALESCE(?, content_hash),
        last_synced_at = ?,
        source_batch = ?,
        search_text = ?,
        rationale_text = ?,
        changed_since_sync = ?,
        updated_at = ?
      WHERE external_id = ?
    `, [
      base.question_id,
      base.uId || null,
      base.program || null,
      base.assessment_id,
      base.assessment_text,
      base.test_id,
      base.test_text,
      base.primary_class_cd,
      base.primary_class_cd_desc,
      base.skill_cd,
      base.skill_desc,
      base.difficulty,
      base.score_band_range_cd ?? null,
      base.is_active ? 1 : 0,
      base.question_order ?? existing.question_order ?? 0,
      base.content_hash || null,
      timestamp,
      batchKey || existing.source_batch || null,
      base.search_text || null,
      base.rationale_text || null,
      changed ? 1 : (existing.changed_since_sync || 0),
      timestamp,
      base.external_id
    ]);
    markDirty();
    return queryOne(db, 'SELECT * FROM questions WHERE external_id = ?', [base.external_id]);
  }

  function upsertQuestionVersion(questionRow, version) {
    const currentVersion = queryOne(db, `
      SELECT version_number
      FROM question_versions
      WHERE question_id = ?
      ORDER BY version_number DESC
      LIMIT 1
    `, [questionRow.id]);
    const nextVersion = currentVersion ? Number(currentVersion.version_number) + 1 : 1;
    exec(db, `
      INSERT INTO question_versions (
        question_id, version_number, content_hash, raw_json, stem_html, stimulus_html, prompt_html,
        rationale_html, rendered_prompt_html, rendered_rationale_html, answer_options_json, correct_answer_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      questionRow.id,
      nextVersion,
      version.content_hash,
      JSON.stringify(version.raw_json),
      version.stem_html || null,
      version.stimulus_html || null,
      version.prompt_html || null,
      version.rationale_html || null,
      version.rendered_prompt_html || null,
      version.rendered_rationale_html || null,
      JSON.stringify(version.answer_options_json || []),
      JSON.stringify(version.correct_answer_json || []),
      nowIso()
    ]);
    const versionRow = queryOne(db, 'SELECT * FROM question_versions WHERE question_id = ? AND version_number = ?', [
      questionRow.id,
      nextVersion
    ]);
    exec(db, 'UPDATE questions SET current_version_id = ?, content_hash = ?, changed_since_sync = 0, updated_at = ? WHERE id = ?', [
      versionRow.id,
      version.content_hash,
      nowIso(),
      questionRow.id
    ]);
    markDirty();
    return versionRow;
  }

  function upsertAsset(asset) {
    const existing = queryOne(db, 'SELECT * FROM assets WHERE hash = ?', [asset.hash]);
    if (existing) return existing;
    exec(db, `
      INSERT INTO assets (hash, ext, mime_type, original_url, local_path, size_bytes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      asset.hash,
      asset.ext,
      asset.mimeType || null,
      asset.originalUrl,
      asset.localPath,
      asset.sizeBytes,
      nowIso()
    ]);
    markDirty();
    return queryOne(db, 'SELECT * FROM assets WHERE hash = ?', [asset.hash]);
  }

  function linkQuestionAsset(questionVersionId, assetId, fieldName, originalSrc) {
    exec(db, `
      INSERT OR IGNORE INTO question_assets (question_version_id, asset_id, field_name, original_src)
      VALUES (?, ?, ?, ?)
    `, [questionVersionId, assetId, fieldName, originalSrc]);
    markDirty();
  }

  function replaceSyncRun(run) {
    exec(db, `
      INSERT INTO sync_runs (status, config_json, checkpoint_json, progress_json, started_at, completed_at, last_error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      run.status,
      JSON.stringify(run.config || {}),
      JSON.stringify(run.checkpoint || {}),
      JSON.stringify(run.progress || {}),
      run.started_at || nowIso(),
      run.completed_at || null,
      run.last_error || null
    ]);
    markDirty();
    const row = queryOne(db, 'SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
    save();
    return row;
  }

  function updateSyncRun(id, updates) {
    const existing = queryOne(db, 'SELECT * FROM sync_runs WHERE id = ?', [id]);
    if (!existing) return null;
    const next = {
      status: updates.status ?? existing.status,
      config_json: updates.config_json ?? existing.config_json,
      checkpoint_json: updates.checkpoint_json ?? existing.checkpoint_json,
      progress_json: updates.progress_json ?? existing.progress_json,
      completed_at: updates.completed_at ?? existing.completed_at,
      last_error: updates.last_error ?? existing.last_error
    };
    exec(db, `
      UPDATE sync_runs
      SET status = ?, config_json = ?, checkpoint_json = ?, progress_json = ?, completed_at = ?, last_error = ?
      WHERE id = ?
    `, [
      next.status,
      next.config_json,
      next.checkpoint_json,
      next.progress_json,
      next.completed_at,
      next.last_error,
      id
    ]);
    markDirty();
    save();
    return queryOne(db, 'SELECT * FROM sync_runs WHERE id = ?', [id]);
  }

  function latestSyncRun() {
    return queryOne(db, 'SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1');
  }

  function listQuestions(filters = {}) {
    const rows = queryAll(db, `
      SELECT q.*, v.id AS version_id, v.version_number, v.raw_json, v.stem_html, v.stimulus_html, v.prompt_html,
             v.rationale_html, v.rendered_prompt_html, v.rendered_rationale_html, v.answer_options_json,
             v.correct_answer_json,
             ${questionTrackingSql('q')}
      FROM questions q
      LEFT JOIN question_versions v ON v.id = q.current_version_id
      ORDER BY q.question_order ASC, q.updated_at DESC, q.id ASC
    `);
    return rows.filter((row) => {
      if (filters.assessment && String(row.assessment_id) !== String(filters.assessment)) return false;
      if (filters.test && String(row.test_id) !== String(filters.test)) return false;
      if (filters.domains?.length && !filters.domains.includes(row.primary_class_cd)) return false;
      if (filters.difficulty?.length && !filters.difficulty.includes(row.difficulty)) return false;
      if (filters.excludeActive && Number(row.is_active) === 1) return false;
      if (filters.neverSeenBefore && Number(row.seen_count || 0) > 0) return false;
      if (filters.stateCd && !matchesStateStandard(filters.stateCd, filters.assessment || row.assessment_id, row.skill_cd, db)) return false;
      const search = String(filters.search || '').trim().toLowerCase();
      if (search) {
        const hay = [
          row.question_id,
          row.external_id,
          row.primary_class_cd_desc,
          row.skill_desc,
          row.search_text,
          row.rationale_text
        ].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      const skill = String(filters.skill || '').trim().toLowerCase();
      if (skill && !String(row.skill_desc || '').toLowerCase().includes(skill)) return false;
      return true;
    }).map(enrichQuestionRow);
  }

  function matchesStateStandard(stateCd, asmtId, skillCd, database) {
    const row = queryOne(database, `
      SELECT 1
      FROM state_standard_mappings
      WHERE stateCd = ? AND asmtId = ? AND skillCd = ?
      LIMIT 1
    `, [stateCd, String(asmtId), skillCd]);
    return Boolean(row);
  }

  function enrichQuestionRow(row) {
    let answerOptions = [];
    let correctAnswer = [];
    let rawJson = null;
    try {
      answerOptions = JSON.parse(row.answer_options_json || '[]');
      correctAnswer = JSON.parse(row.correct_answer_json || '[]');
      rawJson = JSON.parse(row.raw_json || 'null');
    } catch {
      // ignore
    }
    return {
      ...row,
      answerOptions,
      correctAnswer,
      raw_json: rawJson,
      is_active: Number(row.is_active) === 1
    };
  }

  function getQuestionByExternalId(externalId) {
    const row = queryOne(db, `
      SELECT q.*, v.id AS version_id, v.version_number, v.raw_json, v.stem_html, v.stimulus_html, v.prompt_html,
             v.rationale_html, v.rendered_prompt_html, v.rendered_rationale_html, v.answer_options_json,
             v.correct_answer_json,
             ${questionTrackingSql('q')}
      FROM questions q
      LEFT JOIN question_versions v ON v.id = q.current_version_id
      WHERE q.external_id = ?
    `, [externalId]);
    return row ? enrichQuestionRow(row) : null;
  }

  function getQuestionById(id) {
    const row = queryOne(db, 'SELECT * FROM questions WHERE id = ?', [id]);
    return row || null;
  }

  function getQuestionVersionById(id) {
    return queryOne(db, 'SELECT * FROM question_versions WHERE id = ?', [id]);
  }

  function getAssetByHash(hash) {
    return queryOne(db, 'SELECT * FROM assets WHERE hash = ?', [hash]);
  }

  function getAssetCount() {
    return queryOne(db, 'SELECT COUNT(*) AS count FROM assets')?.count || 0;
  }

  function getQuestionCount() {
    return queryOne(db, 'SELECT COUNT(*) AS count FROM questions')?.count || 0;
  }

  function getGeneratedSetCount() {
    return queryOne(db, 'SELECT COUNT(*) AS count FROM generated_sets')?.count || 0;
  }

  function saveGeneratedSet(set) {
    exec(db, `
      INSERT OR REPLACE INTO generated_sets (id, name, mode, seed, config_json, score_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM generated_sets WHERE id = ?), ?), ?)
    `, [
      set.id,
      set.name,
      set.mode,
      set.seed,
      JSON.stringify(set.config || {}),
      JSON.stringify(set.score || {}),
      set.id,
      set.created_at || nowIso(),
      nowIso()
    ]);
    exec(db, 'DELETE FROM generated_set_items WHERE set_id = ?', [set.id]);
    for (const [position, item] of (set.items || []).entries()) {
      const versionRow = item.current_version_id ? getQuestionVersionById(item.current_version_id) : null;
      exec(db, `
        INSERT OR IGNORE INTO generated_set_items (set_id, question_external_id, question_version_id, section_name, position)
        VALUES (?, ?, ?, ?, ?)
      `, [set.id, item.external_id, versionRow?.id || null, item.sectionSlot || item.test_text || '', position + 1]);
    }
    markDirty();
    save();
  }

  function getQuestionHistory(externalId) {
    return queryAll(db, `
      SELECT
        gsi.set_id,
        gs.name AS set_name,
        gs.mode,
        gs.seed,
        gs.created_at AS seen_at,
        gsi.section_name,
        gsi.position
      FROM generated_set_items gsi
      JOIN generated_sets gs ON gs.id = gsi.set_id
      WHERE gsi.question_external_id = ?
      ORDER BY gs.created_at DESC, gs.id DESC, gsi.position ASC
    `, [externalId]);
  }

  function getGeneratedSet(id) {
    const row = queryOne(db, 'SELECT * FROM generated_sets WHERE id = ?', [id]);
    if (!row) return null;
    const items = queryAll(db, `
      SELECT gsi.*, q.*, v.id AS version_id, v.version_number, v.raw_json, v.stem_html, v.stimulus_html, v.prompt_html,
             v.rationale_html, v.rendered_prompt_html, v.rendered_rationale_html, v.answer_options_json,
             v.correct_answer_json
      FROM generated_set_items gsi
      JOIN questions q ON q.external_id = gsi.question_external_id
      LEFT JOIN question_versions v ON v.id = q.current_version_id
      WHERE gsi.set_id = ?
      ORDER BY gsi.position ASC
    `, [id]).map(enrichQuestionRow);
    return {
      ...row,
      config: JSON.parse(row.config_json || '{}'),
      score: JSON.parse(row.score_json || '{}'),
      items
    };
  }

  function listGeneratedSets() {
    return queryAll(db, 'SELECT * FROM generated_sets ORDER BY updated_at DESC').map((row) => ({
      ...row,
      config: JSON.parse(row.config_json || '{}'),
      score: JSON.parse(row.score_json || '{}')
    }));
  }

  function getMeta() {
    return {
      lookupData: getLookups(),
      stateOfferings: queryAll(db, 'SELECT stateCd, name FROM state_offerings ORDER BY name ASC'),
      availableQuestionSlices: queryAll(db, `
        SELECT
          assessment_id,
          assessment_text,
          test_id,
          test_text,
          COUNT(*) AS count
        FROM questions
        GROUP BY assessment_id, assessment_text, test_id, test_text
        ORDER BY assessment_id ASC, test_id ASC
      `),
      counts: {
        questions: getQuestionCount(),
        assets: getAssetCount(),
        sets: getGeneratedSetCount()
      }
    };
  }

  function setQuestionVersionId(questionExternalId, versionId) {
    exec(db, 'UPDATE questions SET current_version_id = ?, updated_at = ? WHERE external_id = ?', [
      versionId,
      nowIso(),
      questionExternalId
    ]);
    markDirty();
  }

  function persistIfDirty() {
    maybeSave();
  }

  return {
    db,
    save,
    persistIfDirty,
    upsertLookup,
    getLookups,
    upsertStateStandards,
    upsertQuestionBase,
    upsertQuestionVersion,
    upsertAsset,
    linkQuestionAsset,
    replaceSyncRun,
    updateSyncRun,
    latestSyncRun,
    listQuestions,
    getQuestionByExternalId,
    getQuestionById,
    getQuestionVersionById,
    getAssetByHash,
    getMeta,
    saveGeneratedSet,
    getQuestionHistory,
    getGeneratedSet,
    listGeneratedSets,
    setQuestionVersionId,
    queryOne,
    queryAll,
    exec
  };
}

module.exports = {
  initStore,
  nowIso,
  stripHtml
};
