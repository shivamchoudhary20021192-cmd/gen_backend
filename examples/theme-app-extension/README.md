# Example theme app extension

A working theme app extension: what an app deploys so merchants can put its
features on their storefront without the app editing their theme.

```
blocks/
  trust-badges.liquid   an app block ("target": "section"): merchants add it to the
                        product page, or to an "Apps" section, in the theme editor
  chat-button.liquid    an app embed ("target": "body"): merchants switch it on under
                        Theme settings → App embeds; it renders on every page
assets/
  trust-badges.css      loaded with the block, because its schema names it
  chat-button.css
```

Inside a block, `block.settings` holds what the merchant chose in the editor,
`block.id` is the block's id, and `app` is the app (`app.handle`, `app.name`).
Every Liquid object a theme section sees (`product`, `cart`, `shop`…) is
available too.

## Deploying

For a store's own custom app: zip the two folders and upload the zip under
Settings → Apps → Develop → Theme extension, or

```bash
curl -X PUT "$API/admin/api/v1/apps/custom/$APP_ID/theme-extension" \
  -H "Authorization: Bearer $STAFF_TOKEN" -F file=@extension.zip
```

For a public app, the platform deploys it:
`PUT /platform/api/v1/apps/:id/theme-extension`. Both also take JSON:
`{ "files": { "blocks/trust-badges.liquid": "…", "assets/trust-badges.css": "…" } }`.

A deploy is checked before it is stored: every block's Liquid must parse, its
`{% schema %}` must have a `name` and a `target` of `section`, `head` or
`body`, and any `stylesheet`/`javascript` it names must be in `assets/`. The
deploy is all or nothing, and each one gets a new version number that is part
of every asset URL, so browsers never keep an old file.

The blocks show only while the app is installed on a store. See
`docs/ONLINE_STORE.md` §3.12.
