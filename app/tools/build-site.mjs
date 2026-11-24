// Build the upload-only website version of TabMaker into a folder (no server needed).
//   node tools/build-site.mjs <out-dir>
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) throw new Error('usage: node tools/build-site.mjs <out-dir>');
const model = 'node_modules/@spotify/basic-pitch/model';

mkdirSync(join(out, 'model'), { recursive: true });
await build({
  entryPoints: ['src/app.js'],
  bundle: true,
  format: 'esm',
  minify: true,
  define: { __STATIC__: 'true' },
  outfile: join(out, 'app.js'),
});
for (const f of ['model.json', 'group1-shard1of1.bin']) copyFileSync(join(model, f), join(out, 'model', f));
copyFileSync('node_modules/@spotify/basic-pitch/LICENSE', join(out, 'model', 'LICENSE'));
// the hand model for uploaded videos (video.js loads it only when the hand is followed)
mkdirSync(join(out, 'mediapipe', 'wasm'), { recursive: true });
copyFileSync('node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', join(out, 'mediapipe', 'vision_bundle.mjs'));
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  copyFileSync(`node_modules/@mediapipe/tasks-vision/wasm/${f}`, join(out, 'mediapipe', 'wasm', f));
}
for (const f of ['hand_landmarker.task', 'LICENSE']) copyFileSync(join('public', 'mediapipe', f), join(out, 'mediapipe', f));
// the note model's processor backend, used when the graphics card can't run it (app.js runModel)
mkdirSync(join(out, 'tfjs-wasm'), { recursive: true });
for (const f of ['tfjs-backend-wasm.wasm', 'tfjs-backend-wasm-simd.wasm', 'tfjs-backend-wasm-threaded-simd.wasm']) {
  copyFileSync(`node_modules/@tensorflow/tfjs-backend-wasm/dist/${f}`, join(out, 'tfjs-wasm', f));
}

// Same page, plus the site's analytics tag, header and footer (as on ekremturanfirat.com).
// index.html is the public upload-only page.
const analytics = `
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-S6B5DK2PH0"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-S6B5DK2PH0');
</script>
<meta name="description" content="TabMaker: upload a song and get guitar tab, made by AI right in your browser.">
<meta name="author" content="Ekrem Turan Fırat">
</head>`;
const siteHeader = `<header class="site-header">
  <div class="container">
    <a class="brand" href="/">Ekrem Turan Fırat</a>
    <nav>
      <a href="/cv/">CV</a>
      <a href="/projects/" aria-current="page">Projects</a>
      <a href="/blog/">Blog</a>
    </nav>
  </div>
</header>
`;
const siteFooter = `
<footer class="site-footer">
  <div class="container">
    <p>© Ekrem Turan Fırat · Built with <a href="https://claude.com/claude-code" target="_blank" rel="noopener noreferrer">Claude Code</a></p>
    <p>
      <a href="mailto:me@ekremturanfirat.com">E-Mail</a> ·
      <a href="https://www.linkedin.com/in/ekremturanfirat/" target="_blank" rel="noopener noreferrer">LinkedIn</a> ·
      <a href="https://github.com/ekremturanfirat" target="_blank" rel="noopener noreferrer">GitHub</a>
    </p>
  </div>
</footer>`;
// ?v=<hash> makes browsers fetch the new app.js right after an update instead of a cached old one
const version = createHash('sha1').update(readFileSync(join(out, 'app.js'))).digest('hex').slice(0, 10);
const page = readFileSync('public/index.html', 'utf8').replace('src="app.js"', `src="app.js?v=${version}"`);
writeFileSync(
  join(out, 'index.html'),
  page
    .replace('</head>', analytics)
    .replace('<body>', '<body data-mode="static">')
    .replace('<main>', siteHeader + '<main>')
    .replace('</main>', '</main>' + siteFooter),
);
console.log(`Website build written to ${out}`);
