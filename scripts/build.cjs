const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const distDir = path.join(repoRoot, 'dist');
const rootIndexPath = path.join(repoRoot, 'index.html');
const publicDir = path.join(repoRoot, 'public');
const vendorDir = path.join(repoRoot, 'vendor');
const dataDir = path.join(repoRoot, 'data');

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function copyFile(src, dest) {
  ensureDir(dest);
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else if (entry.isFile()) {
      copyFile(from, to);
    }
  }
}

function hashFiles(paths) {
  const hash = crypto.createHash('sha256');
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;
    hash.update(filePath);
    hash.update('\0');
    hash.update(fs.readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function computeBuildId() {
  if (process.env.BUILD_ID) return String(process.env.BUILD_ID);
  return hashFiles([
    rootIndexPath,
    path.join(publicDir, 'app.js'),
    path.join(publicDir, 'demo-runtime.js'),
    path.join(publicDir, 'styles.css'),
    path.join(dataDir, 'demo-data.json'),
    path.join(dataDir, 'score-tables.json')
  ]).slice(0, 12);
}

function rewriteIndexHtml(html, buildId) {
  return html
    .replace(
      /window\.SAT_APP_CONFIG\s*=\s*\{[\s\S]*?\};/,
      `window.SAT_APP_CONFIG = {\n        mode: 'demo',\n        buildId: '${buildId}',\n        demoDataUrl: './data/demo-data.json?v=${buildId}',\n        scoreTablesUrl: './data/score-tables.json?v=${buildId}'\n      };`
    )
    .replace('./public/styles.css', `./public/styles.css?v=${buildId}`)
    .replace('./vendor/mathjax-full/es5/mml-svg.js', `./vendor/mathjax-full/es5/mml-svg.js?v=${buildId}`)
    .replace('./public/app.js', `./public/app.js?v=${buildId}`);
}

function rewritePublicAppJs(source, buildId) {
  return source.replace(
    /from\s+['"]\.\/demo-runtime\.js['"]/,
    `from './demo-runtime.js?v=${buildId}'`
  );
}

function writeBuildMeta(buildId) {
  const buildMeta = {
    buildId,
    builtAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(distDir, 'build-meta.json'), `${JSON.stringify(buildMeta, null, 2)}\n`);
}

function build() {
  const buildId = computeBuildId();
  removeDir(distDir);
  fs.mkdirSync(distDir, { recursive: true });

  const indexHtml = fs.readFileSync(rootIndexPath, 'utf8');
  copyFile(path.join(repoRoot, '.nojekyll'), path.join(distDir, '.nojekyll'));
  fs.writeFileSync(path.join(distDir, 'index.html'), `${rewriteIndexHtml(indexHtml, buildId)}\n`);

  fs.mkdirSync(path.join(distDir, 'public'), { recursive: true });
  fs.writeFileSync(
    path.join(distDir, 'public', 'app.js'),
    rewritePublicAppJs(fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8'), buildId)
  );
  copyFile(path.join(publicDir, 'styles.css'), path.join(distDir, 'public', 'styles.css'));
  copyFile(path.join(publicDir, 'demo-runtime.js'), path.join(distDir, 'public', 'demo-runtime.js'));

  copyDir(vendorDir, path.join(distDir, 'vendor'));

  if (fs.existsSync(path.join(dataDir, 'score-tables.json'))) {
    copyFile(path.join(dataDir, 'score-tables.json'), path.join(distDir, 'data', 'score-tables.json'));
  }

  if (fs.existsSync(path.join(dataDir, 'demo-data.json'))) {
    copyFile(path.join(dataDir, 'demo-data.json'), path.join(distDir, 'data', 'demo-data.json'));
  }

  if (fs.existsSync(path.join(dataDir, 'assets'))) {
    copyDir(path.join(dataDir, 'assets'), path.join(distDir, 'data', 'assets'));
  }

  writeBuildMeta(buildId);
  console.log(`Built production bundle in ${distDir} (${buildId})`);
}

build();
