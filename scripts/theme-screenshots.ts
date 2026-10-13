/**
 * Captures the theme store's screenshots: every built-in theme, in every one
 * of its styles, as a shopper sees its home page — desktop and phone.
 *
 *   PORT=4000 npm run theme:screenshots -- --shop veylor [--only aurora] [--default-style-only]
 *
 * Needs a running backend (the store is rendered by it) and Playwright with a
 * browser: it is taken from `playwright` if installed, or from
 * PLAYWRIGHT_MODULE (a path to a playwright package, such as the admin's).
 * PW_CHANNEL picks the browser (default: the installed Chrome).
 *
 * Each style is installed into the store as a temporary unpublished theme,
 * photographed through a preview link, and removed again, so the store's own
 * themes are never touched. A fresh install's home page has no pictures of
 * its own, so the temporary copy borrows the store's largest photos for its
 * empty image settings (--no-demo-images to photograph it bare). Output: themes/<handle>/screenshots/<style>-desktop.jpg
 * and <style>-mobile.jpg, which the theme store serves as they are.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { closePool, query, verifyConnection, type RowDataPacket } from '../src/db/pool';
import { themeFilesService } from '../src/platform/themes/themeFiles.service';
import { extractSchema, parseJsonTemplate } from '../src/platform/themes/themeSchema';
import { shopId } from '../src/platform/tenancy/context';
import { themesRoot } from '../src/platform/themes/bundles';
import { styleSlug } from '../src/platform/themes/screenshots';
import { themeInstaller } from '../src/platform/themes/themeInstaller';
import { themesService } from '../src/platform/themes/themes.service';
import { shopDirectory } from '../src/platform/shops/shopDirectory';
import { tenancy } from '../src/platform/tenancy/context';

type Browser = { newContext(options: Record<string, unknown>): Promise<Context>; close(): Promise<void> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  addStyleTag(options: { content: string }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T): Promise<T>;
  screenshot(options: Record<string, unknown>): Promise<Buffer>;
};

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
const system = { id: null, label: 'theme-screenshots' };

function playwright(): { chromium: { launch(options: Record<string, unknown>): Promise<Browser> } } {
  const require = createRequire(__filename);
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      /* try the next */
    }
  }
  throw new Error('Playwright is not installed here. Set PLAYWRIGHT_MODULE to a playwright package, e.g. ../veylog-fronend-admin/node_modules/playwright.');
}

// Animations off and every reveal-on-scroll element shown, so the picture is the finished page.
const STILL = `*, *::before, *::after { animation: none !important; transition: none !important; }
.reveal-on-scroll [data-reveal], .reveal-on-scroll .reveal, [data-reveal] { opacity: 1 !important; transform: none !important; }
.chat-button, #shopify-section-cart-drawer { display: none !important; }`;

async function capture(browser: Browser, url: string, file: string, viewport: { width: number; height: number }, scale: number) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.addStyleTag({ content: STILL });
    // Fonts and lazy images above the fold.
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.waitForTimeout(600);
    await page.screenshot({ path: file, type: 'jpeg', quality: 72, fullPage: false });
  } finally {
    await context.close();
  }
}

/** Fills the empty image pickers on the temporary copy's home page with the store's own photos. */
async function withDemoImages(themeId: string): Promise<void> {
  const photos = await query<RowDataPacket & { id: number }>(
    `SELECT id FROM media WHERE shop_id = ? AND deleted_at IS NULL AND mime_type LIKE 'image/%' AND width >= 900
      ORDER BY width * height DESC, id LIMIT 24`,
    [shopId()],
  );
  if (photos.length === 0) return;
  let next = 0;
  const photo = () => String(photos[next++ % photos.length].id);
  const file = await themeFilesService.read(themeId, 'templates/index.json');
  const template = parseJsonTemplate(file.file.content ?? '', 'templates/index.json');
  const schemaOf = async (type: string) => {
    try {
      const section = await themeFilesService.read(themeId, `sections/${type}.liquid`);
      return extractSchema(section.file.content ?? '', type);
    } catch {
      return null;
    }
  };
  for (const section of Object.values(template.sections)) {
    const schema = await schemaOf(section.type);
    for (const setting of schema?.settings ?? []) {
      if (setting.type === 'image_picker' && setting.id && !section.settings?.[setting.id]) section.settings = { ...section.settings, [setting.id]: photo() };
    }
    for (const block of Object.values(section.blocks ?? {})) {
      const definition = schema?.blocks?.find((candidate) => candidate.type === block.type);
      for (const setting of definition?.settings ?? []) {
        if (setting.type === 'image_picker' && setting.id && !block.settings?.[setting.id]) block.settings = { ...block.settings, [setting.id]: photo() };
      }
    }
  }
  await themeFilesService.write(themeId, { path: 'templates/index.json', content: JSON.stringify(template, null, 2), checksum: file.file.checksum }, system, 'api');
}

async function main(): Promise<void> {
  await verifyConnection();
  const shop = await shopDirectory.byHandle(option('shop') ?? 'veylor');
  if (!shop) throw new Error('Pass --shop <handle> of a store with products to photograph.');
  const browser = await playwright().chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
  let taken = 0;
  try {
    await tenancy.run(shop, async () => {
      await themeInstaller.syncLibrary();
      const { themes } = await themesService.catalog();
      for (const theme of themes) {
        if (option('only') && theme.handle !== option('only')) continue;
        const styles = flag('default-style-only') ? theme.presets.slice(0, 1) : theme.presets;
        const outDir = path.join(themesRoot(), theme.handle, 'screenshots');
        mkdirSync(outDir, { recursive: true });
        for (const style of styles) {
          const installed = await themesService.install({ handle: theme.handle, preset: style.key, publish: false }, system, { skipLimit: true });
          try {
            if (!flag('no-demo-images')) await withDemoImages(installed.theme.id);
            const url = installed.preview.preview_url;
            const base = path.join(outDir, styleSlug(style.key));
            await capture(browser, url, `${base}-desktop.jpg`, { width: 1440, height: 900 }, 1);
            await capture(browser, url, `${base}-mobile.jpg`, { width: 390, height: 780 }, 2);
            taken += 2;
            console.log(`✓ ${theme.name} · ${style.name}`);
          } finally {
            await themesService.remove(installed.theme.id, system).catch((error: unknown) => console.warn(`could not remove the temporary copy: ${String(error)}`));
          }
        }
      }
    });
  } finally {
    await browser.close();
  }
  console.log(`${taken} screenshot(s) written under ${themesRoot()}/<theme>/screenshots/`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => undefined));
