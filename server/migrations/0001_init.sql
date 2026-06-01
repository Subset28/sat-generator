CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lookup_assessments (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lookup_tests (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lookup_domains (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_group TEXT NOT NULL,
  domain_id TEXT NOT NULL,
  text TEXT NOT NULL,
  primary_class_cd TEXT NOT NULL,
  UNIQUE(assessment_group, primary_class_cd)
);

CREATE TABLE IF NOT EXISTS lookup_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assessment_group TEXT NOT NULL,
  primary_class_cd TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  text TEXT NOT NULL,
  UNIQUE(assessment_group, primary_class_cd, skill_id)
);

CREATE TABLE IF NOT EXISTS state_offerings (
  stateCd TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS state_standard_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  stateCd TEXT NOT NULL,
  asmtId TEXT NOT NULL,
  skillCd TEXT NOT NULL,
  standardId TEXT NOT NULL,
  UNIQUE(stateCd, asmtId, skillCd, standardId)
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL,
  external_id TEXT NOT NULL UNIQUE,
  uId TEXT,
  program TEXT,
  assessment_id TEXT NOT NULL,
  assessment_text TEXT NOT NULL,
  test_id TEXT NOT NULL,
  test_text TEXT NOT NULL,
  primary_class_cd TEXT NOT NULL,
  primary_class_cd_desc TEXT NOT NULL,
  skill_cd TEXT NOT NULL,
  skill_desc TEXT NOT NULL,
  difficulty TEXT NOT NULL,
  score_band_range_cd INTEGER,
  is_active INTEGER NOT NULL DEFAULT 0,
  question_order INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  current_version_id INTEGER,
  last_synced_at TEXT,
  source_batch TEXT,
  search_text TEXT,
  rationale_text TEXT,
  changed_since_sync INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_filters
  ON questions(assessment_id, test_id, primary_class_cd, difficulty, is_active);

CREATE INDEX IF NOT EXISTS idx_questions_external_id
  ON questions(external_id);

CREATE TABLE IF NOT EXISTS question_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  stem_html TEXT,
  stimulus_html TEXT,
  prompt_html TEXT,
  rationale_html TEXT,
  rendered_prompt_html TEXT,
  rendered_rationale_html TEXT,
  answer_options_json TEXT,
  correct_answer_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(question_id) REFERENCES questions(id)
);

CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  ext TEXT NOT NULL,
  mime_type TEXT,
  original_url TEXT NOT NULL,
  local_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_version_id INTEGER NOT NULL,
  asset_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  original_src TEXT NOT NULL,
  FOREIGN KEY(question_version_id) REFERENCES question_versions(id),
  FOREIGN KEY(asset_id) REFERENCES assets(id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL,
  config_json TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,
  progress_json TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS generated_sets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  seed TEXT NOT NULL,
  config_json TEXT NOT NULL,
  score_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS generated_set_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id TEXT NOT NULL,
  question_external_id TEXT NOT NULL,
  question_version_id INTEGER,
  section_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  UNIQUE(set_id, question_external_id),
  FOREIGN KEY(set_id) REFERENCES generated_sets(id)
);
