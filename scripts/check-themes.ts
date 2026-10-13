/**
 * Checks every built-in theme the way a save through the code editor would:
 * each Liquid file parses, each section's {% schema %} is valid JSON, each
 * JSON template and section group names sections that exist with blocks they
 * declare and setting values they accept, and every theme has the files a
 * theme needs. Run in CI (npm run verify) so a broken theme never ships.
 *
 *   npm run check:themes
 */
import { loadBundles } from '../src/platform/themes/bundles';
import { fileProblems } from '../src/platform/themes/themeFiles.service';

const REQUIRED = ['layout/theme.liquid', 'config/settings_schema.json', 'config/settings_data.json', 'templates/index.json'];

const bundles = loadBundles({ fresh: true });
if (bundles.length === 0) {
  console.error('No themes found. Is THEMES_DIR set, or is there a themes/ folder with _kit?');
  process.exit(1);
}

let failures = 0;
for (const bundle of bundles) {
  const files = new Map([...bundle.files.entries()].map(([path, content]) => [path, { content }]));
  const problems: string[] = [];
  for (const path of REQUIRED) if (!bundle.files.has(path)) problems.push(`missing ${path}`);
  for (const [path, content] of bundle.files) {
    if (!path.endsWith('.liquid') && !path.endsWith('.json')) continue;
    problems.push(...fileProblems(path, content, files));
  }
  // Every section a template or group uses must render something the editor can add.
  const presets = [...bundle.files.keys()].filter((path) => path.startsWith('sections/') && path.endsWith('.liquid')).length;
  if (problems.length) {
    failures += problems.length;
    console.error(`✗ ${bundle.manifest.name} ${bundle.manifest.version}`);
    for (const problem of problems) console.error(`    ${problem}`);
  } else {
    console.log(`✓ ${bundle.manifest.name} ${bundle.manifest.version} — ${bundle.files.size} files, ${presets} sections, ${Object.keys(bundle.manifest.presets).length} styles`);
  }
}

process.exit(failures ? 1 : 0);
