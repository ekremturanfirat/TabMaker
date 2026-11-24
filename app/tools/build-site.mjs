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

// Same page, plus the site's analytics tag and a link back home.
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
// ?v=<hash> makes browsers fetch the new app.js right after an update instead of a cached old one
const version = createHash('sha1').update(readFileSync(join(out, 'app.js'))).digest('hex').slice(0, 10);
const page = readFileSync('public/index.html', 'utf8').replace('src="app.js"', `src="app.js?v=${version}"`);
writeFileSync(
  join(out, 'index.html'),
  page
    .replace('</head>', analytics)
    .replace('<body>', '<body data-mode="static">')
    .replace('<main>', '<main>\n  <a class="back" href="/projects/">← Ekrem Turan Fırat · Projects</a>'),
);
console.log(`Website build written to ${out}`);
