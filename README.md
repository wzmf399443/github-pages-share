# GitHub Pages share

[繁體中文](README.zh-TW.md)

Publish Markdown notes from Obsidian to a GitHub repository, serve them through GitHub Pages (Jekyll), and copy a shareable link to your clipboard.

## Features

- One-command publish of the current note, plus a "Publish folder" action for batch publishing.
- Copies the shareable link to your clipboard after a successful publish.
- Right-click menu on files and folders in the file explorer, and a ribbon icon for quick publishing.
- Converts Obsidian wikilinks to relative links on the published page. Targets that have not been published fall back to plain text, so nothing in your note is broken or left dangling.
- Uploads embedded images to a configured assets folder in the repo and rewrites the image references to point at them.
- Renders Obsidian callouts as styled HTML blocks on the published site.
- Renders `mermaid` code blocks on the published site using mermaid.js loaded via CDN.
- Fills in a `title` in the front matter if the note does not have one, so the published page has a proper heading.
- Auto-update: with the option turned on, a note you have already published is republished automatically about 15 seconds after you save a change to it.
- "Set up pages repo" command bootstraps a fresh repo: it adds the Jekyll config, an index page, the mermaid head include, the callout stylesheet, and tries to enable GitHub Pages for you.
- "Unpublish current note" removes the published file from the repo and any images only that note used, and clears the local record so the note is no longer tracked as published.
- Works on mobile (`isDesktopOnly: false`).

## Installation

### Community plugins (pending review)

The plugin is awaiting inclusion in the Obsidian community plugin directory. Once it is listed there, install it from Settings -> Community plugins -> Browse, then enable it.

### Manual installation

1. Download the latest release archive (`main.js`, `manifest.json`, `styles.css`) from the Releases page.
2. Create the folder `<your-vault>/.obsidian/plugins/github-pages-share/` if it does not already exist.
3. Copy the three files into that folder.
4. In Obsidian, open Settings -> Community plugins, disable Safe mode if it is on, and enable "GitHub Pages share".

## Quick start

1. Create a new public GitHub repository that will host your published notes. The repo name determines your default site URL (`https://<owner>.github.io/<repo>`), so pick something you are comfortable exposing in a public URL.
2. Create a fine-grained personal access token at <https://github.com/settings/tokens?type=beta> with at least **Contents: Read and write** scoped to that repository. If you want "Set up pages repo" to enable GitHub Pages for you, also grant **Pages: Read and write** on the same repo. Without that permission the plugin will still work, but it will ask you to enable Pages from the repo's settings page on GitHub.
3. In Obsidian, open Settings -> GitHub Pages share and fill in:
   - Personal access token: paste the token.
   - Repository: `owner/name`.
   - Branch: usually `main`.
   - Notes folder, Assets folder, Pages base URL: keep the defaults or change them to taste.
   - Click "Test connection" to confirm the token and repo are accepted.
4. Run the "Set up pages repo" command. It creates the Jekyll config, the index page, the mermaid head include, and the callout stylesheet, then tries to enable GitHub Pages.
5. Open a Markdown note and run "Publish current note". The shareable URL is copied to your clipboard and shown in a result modal.

## Settings

All settings live on the GitHub Pages share settings tab.

- **Personal access token**: fine-grained token with Contents read and write on the target repository. Stored as plain text in the plugin's data file inside your vault (see Security & privacy).
- **Repository**: target repository in `owner/name` form.
- **Branch**: branch that GitHub Pages serves from. Defaults to `main`. Empty input falls back to `main`.
- **Notes folder**: folder inside the repo where published notes are written. Defaults to `notes`. Leading and trailing slashes are stripped.
- **Assets folder**: folder inside the repo where uploaded images are written. Defaults to `assets`. Leading and trailing slashes are stripped.
- **Pages base URL**: shareable link prefix. Leave blank to use `https://<owner>.github.io/<repo>`. Trailing slashes are stripped automatically.
- **Auto-update published notes**: when on, an already-published note is republished automatically a short while after you save a change to it. Defaults to on.
- **Test connection**: button that calls the GitHub API with the current token and repo and tells you whether the configuration is accepted. If the repo is private, the notice reminds you that free GitHub Pages will not serve it.

## Security & privacy

This plugin talks to GitHub on your behalf. Please read the following before you enable it.

- **Token storage**: the personal access token is stored as plain text in `<vault>/.obsidian/plugins/github-pages-share/data.json`, alongside the publish registry. Anyone who can read that file can read your token. Do not share or sync that file with people or systems you would not hand the token to directly. If you suspect the token has leaked, revoke it on GitHub immediately and create a new one.
- **Network endpoints**: the plugin only connects to `api.github.com` (Contents, Repository, and Pages endpoints). It does not contact any other third-party host from inside Obsidian.
- **Third-party scripts on the published site**: published pages load `mermaid` from `https://cdn.jsdelivr.net` in the visitor's browser. The Obsidian-side plugin does not load any remote scripts, but anyone visiting your published note will, and their browser will share its IP address and request metadata with jsDelivr. Disable `mermaid` code blocks in notes you do not want to load remote scripts.
- **Auto-update is public publishing**: with "Auto-update published notes" on, every save of an already-published note re-publishes it about 15 seconds later. There is no preview step. Do not leave Auto-update on for notes that you are still drafting, or your unfinished edits will go live.
- **Free GitHub Pages requires a public repo**: free GitHub Pages only serves public repositories, and a public repository is world-readable. Every note and image you publish through this plugin is visible to anyone who knows or guesses the URL. Do not publish notes that contain secrets, personal data, or anything you are not prepared to make public.

## How it works

When you publish a note, the plugin:

1. Reads the note from your vault and runs a Markdown transform that rewrites wikilinks to relative links, resolves and uploads embedded images to the assets folder, converts Obsidian callouts to styled HTML, and adds a `title` to the front matter if the note has none.
2. Uploads the note (and any images) to the configured repo and branch through the GitHub Contents API.
3. If the repo is not yet set up, it idempotently creates `_config.yml` (Jekyll theme `jekyll-theme-primer`), `index.md`, `_includes/head-custom.html` (the mermaid bootstrap and callout stylesheet link), and `assets/callouts.css`. Existing files in those paths are left untouched.
4. Records the note's repo path, slug, and uploaded assets in the plugin's local registry, so future publishes update the same file and "Copy published link" can rebuild the share URL.
5. Builds the share URL as `<pages-base-url>/<notes-folder>/<slug>.html` and copies it to the clipboard.

"Set up pages repo" runs step 3 plus an attempt to enable GitHub Pages through the API. If the token lacks Pages write permission, the plugin surfaces a notice asking you to enable Pages manually on GitHub.

## License

MIT.
