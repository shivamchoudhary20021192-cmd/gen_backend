import type { AnyProviderManifest, IntegrationCategory } from './types';

/**
 * Every provider the platform knows how to talk to.
 *
 * Providers register themselves from `providers/index.ts` at import time. The
 * registry is in-process and code-defined on purpose: a provider is an adapter
 * with an HTTP client and a signature verifier, not data, and one that is not
 * in the build cannot be connected however a row in the database is edited.
 */

const manifests = new Map<string, AnyProviderManifest>();

export function registerProvider(manifest: AnyProviderManifest): void {
  if (manifests.has(manifest.key)) throw new Error(`Integration provider ${manifest.key} is registered twice.`);
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(manifest.key)) throw new Error(`Invalid provider key ${manifest.key}.`);
  manifests.set(manifest.key, manifest);
}

export function providerManifest(key: string): AnyProviderManifest | undefined {
  return manifests.get(key);
}

export function providersIn(category: IntegrationCategory): AnyProviderManifest[] {
  return [...manifests.values()].filter((manifest) => manifest.category === category);
}

/**
 * The catalogue as a merchant sees it, sorted so providers built for the
 * shop's own country come first. Never includes anything secret.
 */
export function catalog(countryCode: string) {
  const relevance = (manifest: AnyProviderManifest) =>
    manifest.countries === '*' ? 1 : manifest.countries.includes(countryCode) ? 0 : 2;

  return [...manifests.values()]
    .sort((a, b) => a.category.localeCompare(b.category) || relevance(a) - relevance(b) || a.name.localeCompare(b.name))
    .map((manifest) => ({
      key: manifest.key,
      name: manifest.name,
      category: manifest.category,
      channels: manifest.channels ?? null,
      description: manifest.description,
      docs_url: manifest.docsUrl,
      recommended: relevance(manifest) === 0,
      supports_webhooks: Boolean(manifest.inbound),
      credential_fields: manifest.credentialFields.map((field) => ({
        key: field.key,
        label: field.label,
        secret: field.secret,
        required: field.required,
        placeholder: field.placeholder ?? null,
        help: field.help ?? null,
      })),
      config_fields: (manifest.configFields ?? []).map((field) => ({
        key: field.key,
        label: field.label,
        type: field.type,
        required: field.required ?? false,
        options: field.options ?? null,
        default: field.default ?? null,
        help: field.help ?? null,
      })),
    }));
}
