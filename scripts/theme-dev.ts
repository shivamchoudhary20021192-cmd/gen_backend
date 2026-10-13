/**
 * Theme development against a real store — this platform's `shopify theme`.
 *
 *   npm run theme -- list    --shop veylor
 *   npm run theme -- push    --shop veylor --from lumen [--theme <id>|main] [--all]
 *   npm run theme -- add     --shop veylor --from atelier [--publish] [--style Sand]
 *   npm run theme -- preview --shop veylor [--theme <id>|main] [--design]
 *
 * `push` writes the files of a theme in themes/ (kit + overlay, as the theme
 * store builds it) into a store's installed theme. Like `shopify theme push`,
 * it leaves the merchant's customisations alone unless told otherwise:
 * config/settings_data.json, JSON templates and section groups are kept
 * (pass --all to overwrite them too). Every changed file gets a version, so a
 * push can be undone from the code editor's "Older versions".
 */
import { verifyConnection, closePool } from '../src/db/pool';
import { withTransaction } from '../src/db/transaction';
import { themeLoader } from '../src/platform/onlineStore/themeLoader';
import { loadBundles, contentTypeFor, sha256 } from '../src/platform/themes/bundles';
import { themeFilesRepository } from '../src/platform/themes/themeFiles.repository';
import { themeFilesService } from '../src/platform/themes/themeFiles.service';
import { themeInstaller } from '../src/platform/themes/themeInstaller';
import { themesRepository, type ShopThemeRow } from '../src/platform/themes/themes.repository';
import { themesService } from '../src/platform/themes/themes.service';
import { shopDirectory } from '../src/platform/shops/shopDirectory';
import { tenancy } from '../src/platform/tenancy/context';

const [command = 'list', ...rest] = process.argv.slice(2);
const flag = (name: string) => rest.includes(`--${name}`);
const option = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};
const system = { id: null, label: 'theme-cli' };

async function targetTheme(): Promise<ShopThemeRow> {
  const reference = option('theme') ?? 'main';
  const row = reference === 'main' ? await themesRepository.main() : await themesRepository.byPublicId(reference);
  if (!row) throw new Error(`No theme "${reference}" in this store.`);
  return themeInstaller.materialize(row);
}

function isCustomisation(path: string): boolean {
  return path === 'config/settings_data.json' || (path.endsWith('.json') && (path.startsWith('templates/') || path.startsWith('sections/')));
}

async function push(): Promise<void> {
  const from = option('from');
  const bundle = loadBundles({ fresh: true }).find((candidate) => candidate.manifest.handle === from);
  if (!bundle) throw new Error(`--from must name a folder in themes/: ${loadBundles().map((b) => b.manifest.handle).join(', ')}`);
  const theme = await targetTheme();
  const current = new Map((await themeFilesRepository.files(theme.id)).map((file) => [file.path, file]));
  let written = 0;
  let kept = 0;
  await withTransaction(async (tx) => {
    for (const [path, content] of bundle.files) {
      if (!flag('all') && isCustomisation(path) && current.has(path)) {
        kept += 1;
        continue;
      }
      const checksum = sha256(content);
      if (current.get(path)?.checksum === checksum) continue;
      await themeFilesRepository.upsertFile(theme.id, { path, content, contentType: contentTypeFor(path), checksum, size: Buffer.byteLength(content), adminId: null }, tx);
      await themeFilesRepository.addVersion(theme.id, { path, content, checksum, source: 'api', adminId: null }, tx);
      written += 1;
    }
    if (written) await themeFilesRepository.bumpVersion(theme.id, tx);
  });
  themeLoader.forget();
  console.log(`Pushed ${bundle.manifest.name} into "${theme.name}" (${theme.public_id}): ${written} file(s) written, ${kept} customised file(s) kept${flag('all') ? '' : ' — pass --all to overwrite them'}.`);
}

async function main(): Promise<void> {
  await verifyConnection();
  const handle = option('shop');
  const shop = handle ? await shopDirectory.byHandle(handle) : null;
  if (!shop) throw new Error('Pass --shop <handle>.');
  await tenancy.run(shop, async () => {
    if (command === 'list') {
      const { themes } = await themesService.list();
      for (const theme of themes) console.log(`${theme.role === 'main' ? '●' : '○'} ${theme.id}  ${theme.name.padEnd(28)} ${theme.theme}@${theme.version}${theme.update_available ? `  (update ${theme.latest_version})` : ''}`);
      return;
    }
    if (command === 'push') return push();
    if (command === 'add') {
      const result = await themesService.install({ handle: option('from') ?? '', preset: option('style') ?? null, publish: flag('publish') }, system, { skipLimit: true });
      console.log(`Added ${result.theme.name} (${result.theme.id})${result.theme.role === 'main' ? ', published' : ''}.`);
      console.log(`Preview: ${result.preview.preview_url}`);
      return;
    }
    if (command === 'preview') {
      const theme = await targetTheme();
      const urls = await themeFilesService.previewUrls(theme, 'index', null);
      console.log(flag('design') ? urls.design_url : urls.preview_url);
      return;
    }
    throw new Error(`Unknown command "${command}". Use list, push, add or preview.`);
  });
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
