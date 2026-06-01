const path = require('node:path');

let cached;

function loadMathJax() {
  if (cached) return cached;

  const vendorRoot = path.resolve(__dirname, '..', '..', 'vendor', 'mathjax-full');
  const { mathjax } = require(path.join(vendorRoot, 'js', 'mathjax.js'));
  const { TeX } = require(path.join(vendorRoot, 'js', 'input', 'tex.js'));
  const { MathML } = require(path.join(vendorRoot, 'js', 'input', 'mathml.js'));
  const { SVG } = require(path.join(vendorRoot, 'js', 'output', 'svg.js'));
  const { liteAdaptor } = require(path.join(vendorRoot, 'js', 'adaptors', 'liteAdaptor.js'));
  const { RegisterHTMLHandler } = require(path.join(vendorRoot, 'js', 'handlers', 'html.js'));
  const { AllPackages } = require(path.join(vendorRoot, 'js', 'input', 'tex', 'AllPackages.js'));

  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const tex = new TeX({ packages: AllPackages });
  const mathml = new MathML();
  const svg = new SVG({ fontCache: 'none' });
  const document = mathjax.document('', {
    InputJax: [tex, mathml],
    OutputJax: svg
  });

  cached = { adaptor, document };
  return cached;
}

function renderMathMathML(mathmlSource, display = false) {
  const { adaptor, document } = loadMathJax();
  const wrapped = String(mathmlSource || '').trim().startsWith('<math')
    ? String(mathmlSource)
    : `<math>${String(mathmlSource || '')}</math>`;
  const node = document.convert(wrapped, { display });
  return adaptor.outerHTML(node);
}

function renderMathInHtml(html) {
  const source = String(html ?? '');
  return source.replace(/<math[\s\S]*?<\/math>/gi, (match) => {
    try {
      const isDisplay = /display\s*=\s*["']block["']/i.test(match);
      return renderMathMathML(match, isDisplay);
    } catch {
      return match;
    }
  });
}

module.exports = {
  renderMathInHtml,
  renderMathMathML
};
