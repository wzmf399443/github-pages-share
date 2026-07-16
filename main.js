"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => GithubPagesSharePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian6 = require("obsidian");

// src/settings.ts
var import_obsidian2 = require("obsidian");

// src/github.ts
var import_obsidian = require("obsidian");
var API_BASE = "https://api.github.com";
var BOOTSTRAP_README = "# Published with GitHub Pages Share\n\nThis repository hosts notes published from Obsidian.\n";
var GithubApiError = class extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GithubApiError";
    this.status = status;
  }
};
function parseRepo(repo) {
  const parts = repo.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) return null;
  return { owner: parts[0], repo: parts[1] };
}
function encodeRepoPath(path) {
  return path.split("/").filter((segment) => segment.length > 0).map((segment) => encodeURIComponent(segment)).join("/");
}
function textEncode(content) {
  return new TextEncoder().encode(content).buffer;
}
var REF_RETRY_DELAYS_MS = [1e3, 2e3, 4e3, 8e3];
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
function extractErrorMessage(status, json) {
  if (json && typeof json === "object" && "message" in json) {
    const message = json.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return `GitHub API request failed (${status}).`;
}
function isEmptyRepoResponse(status, json) {
  return status === 409 && /empty/i.test(extractErrorMessage(status, json));
}
function isEmptyRepoError(error) {
  return error instanceof GithubApiError && error.status === 409 && /empty/i.test(error.message);
}
var _GithubClient = class _GithubClient {
  constructor(settings) {
    const parsed = parseRepo(settings.repo);
    if (!parsed) {
      throw new GithubApiError("Repository must be set as owner/name in settings.", 0);
    }
    this.owner = parsed.owner;
    this.repo = parsed.repo;
    this.token = settings.token;
    this.branch = settings.branch || "main";
  }
  headers(extra) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra
    };
  }
  /** Returns the current blob sha for a repo path, or null if the file does not exist yet. */
  async getFileSha(path) {
    var _a;
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(this.branch)}`;
    const response = await (0, import_obsidian.requestUrl)({ url, method: "GET", headers: this.headers(), throw: false });
    if (response.status === 404 || isEmptyRepoResponse(response.status, response.json)) return null;
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    return (_a = data.sha) != null ? _a : null;
  }
  /**
   * Fetches a repo file's decoded UTF-8 contents, or null if the file does not exist yet.
   * Uses atob + TextDecoder instead of Node Buffer so this stays mobile-compatible.
   */
  async getFileContent(path) {
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(this.branch)}`;
    const response = await (0, import_obsidian.requestUrl)({ url, method: "GET", headers: this.headers(), throw: false });
    if (response.status === 404 || isEmptyRepoResponse(response.status, response.json)) return null;
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    if (!data || typeof data.content !== "string" || data.encoding !== "base64") return null;
    const binary = atob(data.content.replace(/\n/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }
  /**
   * Commits a batch of files. Two code paths:
   *
   * 1. **Empty repo** (zero commits): the Git Data API rejects every blob/tree/commit call with
   *    409, so we first push a single README via the Contents API — one PUT that creates the
   *    initial commit and the branch. That makes the repo non-empty, and we then fall through to
   *    the standard flow for the actual files. (Bootstrapping every file with its own PUT instead
   *    raced GitHub's lagging ref replica — the 2nd+ PUTs saw a still-empty repo and 409'd — so we
   *    keep the Contents API to exactly one write.)
   *
   * 2. **Repo with commits**: standard Git Data API flow — create blobs, build a tree on top of
   *    the current branch tree (base_tree inheritance preserves untouched paths), create a commit,
   *    then move the branch ref. The only conflict point is the final ref update, which a
   *    concurrent commit turns into a 422 non-fast-forward that we retry by rebuilding on the new
   *    head.
   *
   * Blobs go through base64 so text and binary attachments share one mobile-safe path.
   *
   * Two kinds of transient conflict are retried with the same backoff:
   * - **422 non-fast-forward** (a concurrent writer moved the ref): our remembered head is proven
   *   stale, so we stop trusting it and re-read the (by then caught-up) head next attempt.
   * - **409 empty-repo** right after a bootstrap (the Git Data replica hasn't yet seen the README
   *   commit): the head we just created is authoritative, so we KEEP trusting it and simply wait
   *   for the replica — dropping to a null/orphan head here would fork a second root commit.
   */
  async commitFiles(files, message) {
    var _a;
    if (files.length === 0) return;
    const branchKey = `${this.owner}/${this.repo}/${this.branch}`;
    let initialHead = await this.getBranchHeadSha();
    if (initialHead.kind === "empty-repo") {
      const readmeSha = await this.putFile("README.md", BOOTSTRAP_README, "Initialize repository");
      _GithubClient.lastPushedHead.set(branchKey, readmeSha);
      initialHead = { kind: "head", sha: readmeSha };
    }
    const MAX_ATTEMPTS = REF_RETRY_DELAYS_MS.length + 1;
    let trustRemembered = true;
    let blobShas = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        if (!blobShas) blobShas = await Promise.all(files.map((file) => this.createBlob(file.content)));
        const entries = files.map((file, i) => ({ path: file.path, sha: blobShas[i] }));
        const branchHead = attempt === 1 ? initialHead : await this.getBranchHeadSha();
        const apiHead = branchHead.kind === "head" ? branchHead.sha : null;
        const remembered = _GithubClient.lastPushedHead.get(branchKey);
        const headSha = trustRemembered && remembered && remembered !== apiHead ? remembered : (_a = apiHead != null ? apiHead : remembered) != null ? _a : null;
        const baseTreeSha = headSha ? await this.getCommitTreeSha(headSha) : null;
        const treeSha = await this.createTree(baseTreeSha, entries);
        const commitSha = await this.createCommit(message, treeSha, headSha);
        const res = await this.updateOrCreateBranchRef(commitSha, headSha !== null);
        if (res.status < 400) {
          _GithubClient.lastPushedHead.set(branchKey, commitSha);
          return;
        }
        throw new GithubApiError(extractErrorMessage(res.status, res.json), res.status);
      } catch (error) {
        const nonFastForward = error instanceof GithubApiError && error.status === 422;
        const emptyRepoLag = isEmptyRepoError(error);
        if (!nonFastForward && !emptyRepoLag || attempt === MAX_ATTEMPTS) throw error;
        if (nonFastForward) {
          trustRemembered = false;
          _GithubClient.lastPushedHead.delete(branchKey);
        }
        await sleep(REF_RETRY_DELAYS_MS[attempt - 1]);
      }
    }
  }
  /**
   * Returns the branch head, distinguishing three cases:
   *
   * - `{ kind: "head", sha }` — the branch exists and points at sha.
   * - `{ kind: "no-branch" }` — the repo has commits but this branch does not exist yet (404), or
   *   the ref response was missing an object sha (defensive).
   * - `{ kind: "empty-repo" }` — the repo has zero commits (409 "Git Repository is empty."); Git
   *   Data API cannot create blobs/trees/commits against an empty repo, so callers must bootstrap
   *   via the Contents API instead.
   *
   * Other errors still throw.
   */
  async getBranchHeadSha() {
    var _a;
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`;
    const response = await (0, import_obsidian.requestUrl)({ url, method: "GET", headers: this.headers(), throw: false });
    if (isEmptyRepoResponse(response.status, response.json)) return { kind: "empty-repo" };
    if (response.status === 404) return { kind: "no-branch" };
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    const sha = (_a = data.object) == null ? void 0 : _a.sha;
    return sha ? { kind: "head", sha } : { kind: "no-branch" };
  }
  /**
   * Creates or updates a single file via the Contents API. This is the only endpoint that works
   * against a repo with zero commits — the Git Data API (blobs, trees, commits, refs) returns 409
   * "Git Repository is empty." for such repos, so the first-ever commit must go through this path.
   * Used only by the empty-repo bootstrap in commitFiles; it does not carry a `sha` parameter and
   * therefore performs no conflict retry (on a brand-new repo the path cannot already exist).
   * Returns the new commit sha.
   */
  async putFile(path, content, message) {
    var _a;
    const buffer = typeof content === "string" ? textEncode(content) : content;
    const encoded = (0, import_obsidian.arrayBufferToBase64)(buffer);
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}`;
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: "PUT",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message, content: encoded, branch: this.branch }),
      throw: false
    });
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    const sha = (_a = data.commit) == null ? void 0 : _a.sha;
    if (!sha) throw new GithubApiError("GitHub put-file response missing commit sha.", response.status);
    return sha;
  }
  /** Returns the tree sha for a commit. */
  async getCommitTreeSha(commitSha) {
    var _a;
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/commits/${commitSha}`;
    const response = await (0, import_obsidian.requestUrl)({ url, method: "GET", headers: this.headers(), throw: false });
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    const treeSha = (_a = data.tree) == null ? void 0 : _a.sha;
    if (!treeSha) throw new GithubApiError("GitHub commit response missing tree sha.", response.status);
    return treeSha;
  }
  /** Creates a blob from text or binary content and returns its sha. */
  async createBlob(content) {
    const buffer = typeof content === "string" ? textEncode(content) : content;
    const encoded = (0, import_obsidian.arrayBufferToBase64)(buffer);
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/blobs`;
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ content: encoded, encoding: "base64" }),
      throw: false
    });
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    if (!data.sha) throw new GithubApiError("GitHub blob response missing sha.", response.status);
    return data.sha;
  }
  /** Builds a new tree from the given entries, inheriting untouched paths from base_tree. */
  async createTree(baseTreeSha, entries) {
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/trees`;
    const body = {
      tree: entries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: entry.sha }))
    };
    if (baseTreeSha) body.base_tree = baseTreeSha;
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      throw: false
    });
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    if (!data.sha) throw new GithubApiError("GitHub tree response missing sha.", response.status);
    return data.sha;
  }
  /** Creates a commit; parentSha is null only for the first commit in an empty repo. */
  async createCommit(message, treeSha, parentSha) {
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/commits`;
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message, tree: treeSha, parents: parentSha ? [parentSha] : [] }),
      throw: false
    });
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    if (!data.sha) throw new GithubApiError("GitHub commit response missing sha.", response.status);
    return data.sha;
  }
  /**
   * Points the branch at the new commit. Updates the existing ref with force:false so a concurrent
   * commit surfaces as a 422 non-fast-forward instead of being clobbered, or creates the ref when
   * the branch has no commits yet. Returns the raw response so the caller can retry on 422.
   */
  async updateOrCreateBranchRef(commitSha, refExists) {
    const url = refExists ? `${API_BASE}/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}` : `${API_BASE}/repos/${this.owner}/${this.repo}/git/refs`;
    const body = refExists ? { sha: commitSha, force: false } : { ref: `refs/heads/${this.branch}`, sha: commitSha };
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: refExists ? "PATCH" : "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      throw: false
    });
    return { status: response.status, json: response.json };
  }
  /** Fetches repo metadata; also used by "Test connection". */
  async getRepo() {
    var _a, _b;
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}`;
    const response = await (0, import_obsidian.requestUrl)({ url, method: "GET", headers: this.headers(), throw: false });
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    return { defaultBranch: (_a = data.default_branch) != null ? _a : this.branch, private: (_b = data.private) != null ? _b : false };
  }
  /** Enables GitHub Pages for the configured branch. A 409 means Pages is already enabled. */
  async enablePages() {
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/pages`;
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ source: { branch: this.branch, path: "/" } }),
      throw: false
    });
    if (response.status === 409) return;
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
  }
  /**
   * Idempotently deletes a file from the repo. A 404 on the sha lookup (never existed) or on
   * the delete call (already removed by a concurrent run) is treated as success so retries are
   * safe; other 4xx/5xx responses throw GithubApiError.
   */
  async deleteFile(path, message) {
    const sha = await this.getFileSha(path);
    if (!sha) return;
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}`;
    const response = await (0, import_obsidian.requestUrl)({
      url,
      method: "DELETE",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message, sha, branch: this.branch }),
      throw: false
    });
    if (response.status === 404) return;
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    _GithubClient.lastPushedHead.delete(`${this.owner}/${this.repo}/${this.branch}`);
  }
  /** Returns the live Pages URL, or null if Pages is not enabled. */
  async getPagesInfo() {
    const url = `${API_BASE}/repos/${this.owner}/${this.repo}/pages`;
    const response = await (0, import_obsidian.requestUrl)({ url, method: "GET", headers: this.headers(), throw: false });
    if (response.status === 404) return null;
    if (response.status >= 400) {
      throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
    }
    const data = response.json;
    return data.html_url ? { url: data.html_url } : null;
  }
};
/**
 * Remembers the last commit sha this process pushed, keyed by `owner/repo/branch`. Right after
 * our own commit GitHub's ref-read replica often still returns the previous head; trusting this
 * value as the parent avoids a phantom non-fast-forward for sequential single-writer updates.
 * Static so it survives the per-publish GithubClient instances.
 */
_GithubClient.lastPushedHead = /* @__PURE__ */ new Map();
var GithubClient = _GithubClient;

// src/settings.ts
var DEFAULT_SETTINGS = {
  token: "",
  repo: "",
  branch: "main",
  notesFolder: "notes",
  assetsFolder: "assets",
  baseUrl: "",
  autoUpdate: true,
  pagesConfirmed: false,
  registry: {}
};
function deriveBaseUrl(settings) {
  const parsed = parseRepo(settings.repo);
  if (!parsed) return "";
  return `https://${parsed.owner}.github.io/${parsed.repo}`;
}
function normalizeFolderName(value, fallback) {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) return fallback;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return fallback;
  return segments.join("/");
}
var GithubPagesShareSettingTab = class extends import_obsidian2.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.pagesBaseUrlInput = null;
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian2.Setting(containerEl).setName("GitHub connection").setHeading();
    new import_obsidian2.Setting(containerEl).setName("Personal access token").setDesc(
      "Fine-grained token with contents read/write on the target repo. Stored as plain text in this vault's plugin data."
    ).addText((text) => {
      text.inputEl.type = "password";
      text.setPlaceholder("Paste token here").setValue(this.plugin.settings.token).onChange(async (value) => {
        this.plugin.settings.token = value.trim();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Repository").setDesc("GitHub repository as owner/name.").addText(
      (text) => text.setPlaceholder("Owner/name").setValue(this.plugin.settings.repo).onChange(async (value) => {
        var _a;
        const newRepo = value.trim();
        const prevRepo = this.plugin.settings.repo;
        const changed = !!newRepo && newRepo !== prevRepo;
        const oldDerived = deriveBaseUrl(this.plugin.settings);
        this.plugin.settings.repo = newRepo;
        if (changed) {
          const newDerived = deriveBaseUrl(this.plugin.settings);
          const current = this.plugin.settings.baseUrl;
          const onDefault = !current || current === oldDerived;
          if (onDefault) {
            this.plugin.settings.baseUrl = newDerived;
            (_a = this.pagesBaseUrlInput) == null ? void 0 : _a.setValue(newDerived);
          }
          this.plugin.settings.pagesConfirmed = false;
        }
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Branch").setDesc("Branch that GitHub Pages serves from.").addText(
      (text) => text.setPlaceholder("Branch name").setValue(this.plugin.settings.branch).onChange(async (value) => {
        this.plugin.settings.branch = value.trim() || "main";
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Notes folder").setDesc("Folder in the repo where published notes are saved.").addText(
      (text) => text.setPlaceholder("Folder name").setValue(this.plugin.settings.notesFolder).onChange(async (value) => {
        this.plugin.settings.notesFolder = normalizeFolderName(value, "notes");
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Assets folder").setDesc("Folder in the repo where uploaded images are saved.").addText(
      (text) => text.setPlaceholder("Folder name").setValue(this.plugin.settings.assetsFolder).onChange(async (value) => {
        this.plugin.settings.assetsFolder = normalizeFolderName(value, "assets");
        await this.plugin.saveSettings();
      })
    );
    const derivedUrl = deriveBaseUrl(this.plugin.settings) || "https://owner.github.io/repo";
    new import_obsidian2.Setting(containerEl).setName("Pages base URL").setDesc(`Shareable link prefix. Leave blank to use ${derivedUrl}.`).addText((text) => {
      this.pagesBaseUrlInput = text;
      text.setPlaceholder(derivedUrl).setValue(this.plugin.settings.baseUrl).onChange(async (value) => {
        this.plugin.settings.baseUrl = value.trim().replace(/\/+$/, "");
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Auto-update published notes").setDesc("Republish a note automatically a short while after you save changes to it.").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.autoUpdate).onChange(async (value) => {
        this.plugin.settings.autoUpdate = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian2.Setting(containerEl).setName("Test connection").setDesc("Verify the token and repository are valid.").addButton(
      (button) => button.setButtonText("Test connection").onClick(() => {
        void this.testConnection(button);
      })
    );
  }
  async testConnection(button) {
    button.setDisabled(true);
    try {
      const client = new GithubClient(this.plugin.settings);
      const repo = await client.getRepo();
      new import_obsidian2.Notice(
        repo.private ? "Connection works. Note: repo is private, so free GitHub Pages will not serve it." : "Connection works."
      );
    } catch (error) {
      new import_obsidian2.Notice(error instanceof Error ? error.message : "Could not connect to GitHub.");
    } finally {
      button.setDisabled(false);
    }
  }
};

// src/publisher.ts
var import_obsidian5 = require("obsidian");

// src/modal.ts
var import_obsidian3 = require("obsidian");
var PublishResultModal = class extends import_obsidian3.Modal {
  constructor(app, options) {
    super(app);
    this.statusEl = null;
    this.options = options;
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Note published");
    if (this.options.pagesNotEnabled) {
      const warning = contentEl.createDiv({ cls: "gps-publish-result-warning" });
      warning.createDiv({
        text: "GitHub Pages is not enabled yet, so this link will not work."
      });
      const setupButton = warning.createEl("button", {
        text: "Set up pages repo now",
        cls: "gps-publish-result-setup"
      });
      setupButton.addEventListener("click", () => {
        var _a, _b;
        this.close();
        (_b = (_a = this.options).onSetupRepo) == null ? void 0 : _b.call(_a);
      });
    }
    contentEl.createDiv({ cls: "gps-publish-result-link", text: this.options.link });
    this.statusEl = contentEl.createDiv({
      cls: "gps-publish-result-status",
      text: this.options.copiedToClipboard ? "Link copied to clipboard." : "Copying to the clipboard failed. Copy the link manually."
    });
    const buttons = contentEl.createDiv({ cls: "gps-publish-result-buttons" });
    const copyButton = buttons.createEl("button", { text: "Copy link" });
    copyButton.addEventListener("click", () => {
      void (async () => {
        var _a, _b;
        try {
          await navigator.clipboard.writeText(this.options.link);
          (_a = this.statusEl) == null ? void 0 : _a.setText("Link copied to clipboard.");
        } catch (e) {
          (_b = this.statusEl) == null ? void 0 : _b.setText("Copying to the clipboard failed. Copy the link manually.");
        }
      })();
    });
    const openButton = buttons.createEl("button", { text: "Open in browser" });
    openButton.addEventListener("click", () => {
      window.open(this.options.link, "_blank");
    });
    contentEl.createDiv({
      cls: "gps-publish-result-hint",
      text: "GitHub Pages can take one to two minutes to build before the link works."
    });
  }
  onClose() {
    this.statusEl = null;
    this.contentEl.empty();
  }
};
var UnpublishConfirmModal = class extends import_obsidian3.Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }
  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Unpublish note?");
    contentEl.createDiv({
      text: `This will delete "${this.options.noteName}" from your GitHub Pages repo.`
    });
    if (this.options.attachmentCount > 0) {
      const noun = this.options.attachmentCount === 1 ? "image" : "images";
      contentEl.createDiv({
        text: `It will also remove ${this.options.attachmentCount} uploaded ${noun} that no other published note references.`
      });
    }
    const buttons = contentEl.createDiv({ cls: "gps-publish-result-buttons" });
    const cancelButton = buttons.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => {
      this.close();
    });
    const unpublishButton = buttons.createEl("button", {
      text: "Unpublish",
      cls: "gps-danger-button"
    });
    unpublishButton.addEventListener("click", () => {
      this.options.onConfirm();
      this.close();
    });
  }
  onClose() {
    this.contentEl.empty();
  }
};

// src/transform.ts
var import_obsidian4 = require("obsidian");
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"]);
var SLUG_CHAR = /[\p{L}\p{N}]/u;
var CALLOUT_HEAD = /^(\s*)>\s*\[!(\w+)\]([+-]?)(?:\s+(.*))?$/;
var FENCE_LINE = /^\s*```/;
var SAFE_TYPE = /^\w+$/;
function titleCase(s) {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}
function escapeHtmlAttribute(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function shortHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function slugify(input, fallbackSeed) {
  let out = "";
  for (const ch of input.toLowerCase()) {
    out += SLUG_CHAR.test(ch) ? ch : "-";
  }
  const collapsed = out.split("-").filter((part) => part.length > 0).join("-");
  return collapsed || `note-${shortHash(fallbackSeed != null ? fallbackSeed : input)}`;
}
function slugifyFileName(name, fallbackSeed) {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return slugify(name, fallbackSeed);
  const base = name.slice(0, dotIndex);
  const ext = name.slice(dotIndex + 1).toLowerCase();
  return `${slugify(base, fallbackSeed)}.${ext}`;
}
function transformCallouts(content) {
  var _a, _b, _c, _d;
  if (!content.includes("> [")) return content;
  const lines = content.split("\n");
  const out = [];
  let inFence = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE_LINE.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }
    const match = CALLOUT_HEAD.exec(line);
    if (!match) {
      out.push(line);
      i++;
      continue;
    }
    const indent = (_a = match[1]) != null ? _a : "";
    const rawType = ((_b = match[2]) != null ? _b : "note").toLowerCase();
    const fold = (_c = match[3]) != null ? _c : "";
    const title = ((_d = match[4]) != null ? _d : "").trim();
    const safeType = SAFE_TYPE.test(rawType) ? rawType : "note";
    const prefix = `${indent}>`;
    let j = i + 1;
    while (j < lines.length) {
      const bl = lines[j];
      if (bl.trim() === "") break;
      if (bl === prefix || bl.startsWith(`${prefix} `) || bl.startsWith(prefix)) {
        j++;
        continue;
      }
      break;
    }
    const bodyLines = [];
    for (let k = i + 1; k < j; k++) {
      const bl = lines[k];
      if (bl === prefix) {
        bodyLines.push("");
      } else if (bl.startsWith(`${prefix} `)) {
        bodyLines.push(bl.slice(prefix.length + 1));
      } else if (bl.startsWith(prefix)) {
        bodyLines.push(bl.slice(prefix.length));
      }
    }
    const inner = transformCallouts(bodyLines.join("\n"));
    if (out.length > 0 && out[out.length - 1] !== "") {
      out.push("");
    }
    if (fold === "+" || fold === "-") {
      const openAttr = fold === "+" ? " open" : "";
      const summary = title || titleCase(safeType);
      out.push(`${indent}<details class="callout callout-${safeType}" markdown="1"${openAttr}>`);
      out.push(`${indent}<summary>${escapeHtmlAttribute(summary)}</summary>`);
      if (inner.trim().length > 0) {
        out.push("");
        for (const innerLine of inner.split("\n")) {
          out.push(innerLine.length > 0 ? indent + innerLine : "");
        }
        out.push("");
      }
      out.push(`${indent}</details>`);
    } else {
      out.push(`${indent}<blockquote class="callout callout-${safeType}" markdown="1">`);
      if (title) {
        out.push(`${indent}<strong class="callout-title">${escapeHtmlAttribute(title)}</strong>`);
      }
      if (inner.trim().length > 0) {
        out.push("");
        for (const innerLine of inner.split("\n")) {
          out.push(innerLine.length > 0 ? indent + innerLine : "");
        }
        out.push("");
      }
      out.push(`${indent}</blockquote>`);
    }
    i = j;
  }
  return out.join("\n");
}
function escapeYamlString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function isExternalLink(link) {
  return link.includes("://") || link.startsWith("mailto:");
}
function findFrontmatter(content) {
  const none = { exists: false, insertOffset: 0, body: "" };
  if (!content.startsWith("---")) return none;
  const firstLineEnd = content.indexOf("\n");
  if (firstLineEnd === -1 || content.slice(0, firstLineEnd).trim() !== "---") return none;
  let cursor = firstLineEnd + 1;
  while (cursor <= content.length) {
    const nextNewline = content.indexOf("\n", cursor);
    const lineEnd = nextNewline === -1 ? content.length : nextNewline;
    const line = content.slice(cursor, lineEnd).trim();
    if (line === "---") {
      return { exists: true, insertOffset: firstLineEnd + 1, body: content.slice(firstLineEnd + 1, cursor) };
    }
    if (nextNewline === -1) break;
    cursor = nextNewline + 1;
  }
  return none;
}
function ensureFrontmatter(content, title) {
  const frontmatter = findFrontmatter(content);
  if (!frontmatter.exists) {
    return `---
title: "${escapeYamlString(title)}"
---

${content}`;
  }
  const hasTitle = frontmatter.body.split("\n").some((line) => line.trimStart().startsWith("title:"));
  if (hasTitle) return content;
  return `${content.slice(0, frontmatter.insertOffset)}title: "${escapeYamlString(title)}"
${content.slice(frontmatter.insertOffset)}`;
}
function linkReplacementText(target, display, registry) {
  const record = registry[target.path];
  if (record) {
    return `[${display}](${record.slug}.html)`;
  }
  return display;
}
function transformNote(app, file, rawContent, settings) {
  var _a, _b, _c, _d, _e, _f;
  const cache = app.metadataCache.getFileCache(file);
  const replacements = [];
  const attachmentsByPath = /* @__PURE__ */ new Map();
  const notesDepth = settings.notesFolder.split("/").filter((segment) => segment.length > 0).length;
  const upToRoot = "../".repeat(Math.max(notesDepth, 1));
  for (const embed of (_a = cache == null ? void 0 : cache.embeds) != null ? _a : []) {
    if (isExternalLink(embed.link)) continue;
    const target = app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
    if (!target) {
      replacements.push({
        start: embed.position.start.offset,
        end: embed.position.end.offset,
        text: (_b = embed.displayText) != null ? _b : embed.link
      });
      continue;
    }
    if (IMAGE_EXTENSIONS.has(target.extension.toLowerCase())) {
      const repoFileName = slugifyFileName(target.name, target.path);
      const repoPath = (0, import_obsidian4.normalizePath)(`${settings.assetsFolder}/${repoFileName}`);
      attachmentsByPath.set(target.path, { file: target, repoPath });
      const alt = (_c = embed.displayText) != null ? _c : target.basename;
      replacements.push({
        start: embed.position.start.offset,
        end: embed.position.end.offset,
        text: `![${alt}](${upToRoot}${settings.assetsFolder}/${repoFileName})`
      });
    } else {
      replacements.push({
        start: embed.position.start.offset,
        end: embed.position.end.offset,
        text: linkReplacementText(target, (_d = embed.displayText) != null ? _d : embed.link, settings.registry)
      });
    }
  }
  for (const link of (_e = cache == null ? void 0 : cache.links) != null ? _e : []) {
    if (isExternalLink(link.link)) continue;
    const display = (_f = link.displayText) != null ? _f : link.link;
    const target = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
    if (!target) {
      replacements.push({ start: link.position.start.offset, end: link.position.end.offset, text: display });
      continue;
    }
    replacements.push({
      start: link.position.start.offset,
      end: link.position.end.offset,
      text: linkReplacementText(target, display, settings.registry)
    });
  }
  replacements.sort((a, b) => b.start - a.start);
  let body = rawContent;
  for (const replacement of replacements) {
    body = body.slice(0, replacement.start) + replacement.text + body.slice(replacement.end);
  }
  body = transformCallouts(body);
  const content = ensureFrontmatter(body, file.basename);
  return { content, attachments: Array.from(attachmentsByPath.values()) };
}

// src/callouts.css.ts
var CALLOUTS_CSS = `.callout {
  padding: 12px 16px;
  margin: 16px 0;
  border-left: 4px solid #448aff;
  border-radius: 4px;
  background: #e3f2fd;
  color: inherit;
  overflow: hidden;
}
.callout > *:first-child {
  margin-top: 0;
}
.callout > *:last-child {
  margin-bottom: 0;
}
.callout-title {
  font-weight: 600;
  margin-bottom: 8px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.callout-icon {
  display: inline-block;
  width: 1.25em;
  text-align: center;
  flex-shrink: 0;
}
.callout details > summary,
.callout > summary {
  cursor: pointer;
}
.callout-note {
  border-color: #448aff;
  background: #e3f2fd;
}
.callout-abstract,
.callout-summary,
.callout-tldr {
  border-color: #00b8d4;
  background: #e0f7fa;
}
.callout-info {
  border-color: #00b8d4;
  background: #e0f7fa;
}
.callout-todo {
  border-color: #00b8d4;
  background: #e0f7fa;
}
.callout-tip,
.callout-hint,
.callout-important {
  border-color: #00bfa5;
  background: #e0f2f1;
}
.callout-success,
.callout-check,
.callout-done {
  border-color: #00c853;
  background: #e8f5e9;
}
.callout-question,
.callout-help,
.callout-faq {
  border-color: #64dd17;
  background: #f1f8e9;
}
.callout-warning,
.callout-caution,
.callout-attention {
  border-color: #ff9100;
  background: #fff3e0;
}
.callout-failure,
.callout-fail,
.callout-missing {
  border-color: #ff5252;
  background: #ffebee;
}
.callout-danger,
.callout-error {
  border-color: #ff1744;
  background: #ffebee;
}
.callout-bug {
  border-color: #f50057;
  background: #ffebee;
}
.callout-example {
  border-color: #7c4dff;
  background: #ede7f6;
}
.callout-quote,
.callout-cite {
  border-color: #9e9e9e;
  background: #f5f5f5;
}
`;

// src/publisher.ts
var HEAD_CUSTOM_MARKER = "<!-- gps-callouts-v1 -->";
var HEAD_CUSTOM_LINK = `<link rel="stylesheet" href="{{ '/assets/callouts.css' | relative_url }}">`;
var HEAD_CUSTOM_BASE = `<script type="module">
  import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.esm.min.mjs";
  document.querySelectorAll("pre code.language-mermaid, pre > code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    const container = document.createElement("pre");
    container.className = "mermaid";
    container.textContent = code.textContent;
    pre.replaceWith(container);
  });
  mermaid.initialize({ startOnLoad: true });
<\/script>
${HEAD_CUSTOM_LINK}
${HEAD_CUSTOM_MARKER}
`;
var LONG_NOTICE_MS = 15e3;
function describeError(error) {
  if (error instanceof GithubApiError) {
    if (error.status === 401) return "GitHub rejected the token. Check the personal access token in settings.";
    if (error.status === 403) return "GitHub denied the request. Check the token's repo permissions.";
    if (error.status === 404) return "Repository not found. Check the owner/name and token access in settings.";
    if (error.status === 409) return "GitHub reported a conflict while saving. Please try again.";
    if (error.status === 422 && /fast.forward/i.test(error.message))
      return "Another publish updated the repo at the same time. Please try again.";
    return `GitHub error: ${error.message}`;
  }
  if (error instanceof Error) return error.message;
  return "Unknown error while talking to GitHub.";
}
function buildShareLink(settings, slug) {
  const base = (settings.baseUrl || deriveBaseUrl(settings)).replace(/\/+$/, "");
  return `${base}/${settings.notesFolder}/${slug}.html`;
}
async function buildJekyllConfigFile(client, settings) {
  var _a;
  const existingSha = await client.getFileSha("_config.yml");
  if (existingSha) return null;
  const repoName = (_a = settings.repo.split("/")[1]) != null ? _a : settings.repo;
  const yaml = `theme: jekyll-theme-primer
title: "${escapeYamlString(repoName)}"
`;
  return { path: "_config.yml", content: yaml };
}
async function buildCalloutStylesFile(client) {
  const existingSha = await client.getFileSha("assets/callouts.css");
  if (existingSha) return null;
  return { path: "assets/callouts.css", content: CALLOUTS_CSS };
}
async function buildHeadCustomFile(client) {
  const existing = await client.getFileContent("_includes/head-custom.html");
  if (existing === null) {
    return { path: "_includes/head-custom.html", content: HEAD_CUSTOM_BASE };
  }
  if (existing.includes(HEAD_CUSTOM_MARKER)) return null;
  const updated = existing.endsWith("\n") ? `${existing}${HEAD_CUSTOM_LINK}
${HEAD_CUSTOM_MARKER}
` : `${existing}
${HEAD_CUSTOM_LINK}
${HEAD_CUSTOM_MARKER}
`;
  return { path: "_includes/head-custom.html", content: updated };
}
async function buildIndexPageFile(client, settings) {
  var _a;
  const existingSha = await client.getFileSha("index.md");
  if (existingSha) return null;
  const repoName = (_a = settings.repo.split("/")[1]) != null ? _a : settings.repo;
  const markdown = `---
title: "${escapeYamlString(repoName)}"
---

Notes published from Obsidian appear here. Maintain this index manually as you publish more notes.
`;
  return { path: "index.md", content: markdown };
}
function hasConnectionSettings(settings) {
  return settings.token.length > 0 && settings.repo.length > 0;
}
var inFlightPublishes = /* @__PURE__ */ new Set();
async function publishNote(plugin, file, options = {}) {
  var _a, _b;
  const quiet = (_a = options.quiet) != null ? _a : false;
  if (file.extension !== "md") {
    if (!quiet) new import_obsidian5.Notice("Only Markdown notes can be published.");
    return false;
  }
  const settings = plugin.settings;
  if (!hasConnectionSettings(settings)) {
    if (!quiet) new import_obsidian5.Notice("Set a GitHub token and repository in the plugin settings first.");
    return false;
  }
  if (inFlightPublishes.has(file.path)) {
    if (!quiet) new import_obsidian5.Notice("This note is already being published.");
    return false;
  }
  let client;
  try {
    client = new GithubClient(settings);
  } catch (error) {
    if (!quiet) new import_obsidian5.Notice(describeError(error));
    return false;
  }
  inFlightPublishes.add(file.path);
  const progress = quiet ? null : new import_obsidian5.Notice(`Publishing ${file.basename}...`, 0);
  try {
    const rawContent = await plugin.app.vault.cachedRead(file);
    const existing = settings.registry[file.path];
    const slug = (_b = existing == null ? void 0 : existing.slug) != null ? _b : slugify(file.basename, file.path);
    const repoPath = (0, import_obsidian5.normalizePath)(`${settings.notesFolder}/${slug}.md`);
    const { content, attachments } = transformNote(plugin.app, file, rawContent, settings);
    const scaffolding = (await Promise.all([
      buildJekyllConfigFile(client, settings),
      buildHeadCustomFile(client),
      buildCalloutStylesFile(client)
    ])).filter((repoFile) => repoFile !== null);
    const files = [...scaffolding];
    for (let i = 0; i < attachments.length; i++) {
      progress == null ? void 0 : progress.setMessage(`Reading image ${i + 1} of ${attachments.length}...`);
      const attachment = attachments[i];
      const data = await plugin.app.vault.readBinary(attachment.file);
      files.push({ path: attachment.repoPath, content: data });
    }
    files.push({ path: repoPath, content });
    const message = attachments.length > 0 ? `Publish note ${file.basename} (+${attachments.length} asset${attachments.length > 1 ? "s" : ""})` : `Publish note ${file.basename}`;
    progress == null ? void 0 : progress.setMessage("Committing to GitHub...");
    await client.commitFiles(files, message);
    const record = {
      repoPath,
      slug,
      attachments: attachments.map((a) => a.repoPath)
    };
    settings.registry[file.path] = record;
    await plugin.saveSettings();
    if (!quiet) {
      let pagesNotEnabled = false;
      if (!settings.pagesConfirmed) {
        progress == null ? void 0 : progress.setMessage("Checking pages status...");
        try {
          const pagesInfo = await client.getPagesInfo();
          if (pagesInfo) {
            settings.pagesConfirmed = true;
            settings.baseUrl = pagesInfo.url.replace(/\/+$/, "");
            await plugin.saveSettings();
          } else {
            pagesNotEnabled = true;
          }
        } catch (e) {
        }
      }
      const link = buildShareLink(settings, slug);
      let copiedToClipboard = false;
      try {
        await navigator.clipboard.writeText(link);
        copiedToClipboard = true;
      } catch (e) {
      }
      progress == null ? void 0 : progress.hide();
      new PublishResultModal(plugin.app, {
        link,
        copiedToClipboard,
        pagesNotEnabled,
        onSetupRepo: () => {
          void setupRepo(plugin);
        }
      }).open();
    }
    return true;
  } catch (error) {
    progress == null ? void 0 : progress.hide();
    new import_obsidian5.Notice(quiet ? `Auto-update failed for ${file.basename}: ${describeError(error)}` : describeError(error));
    return false;
  } finally {
    progress == null ? void 0 : progress.hide();
    inFlightPublishes.delete(file.path);
  }
}
async function copyPublishedLink(plugin, file) {
  const record = plugin.settings.registry[file.path];
  if (!record) {
    new import_obsidian5.Notice("This note has not been published yet.");
    return;
  }
  const link = buildShareLink(plugin.settings, record.slug);
  await navigator.clipboard.writeText(link);
  new import_obsidian5.Notice(`Link copied to clipboard:
${link}`);
}
function collectReferencedAttachments(registry, excludePath) {
  var _a;
  const referenced = /* @__PURE__ */ new Set();
  for (const [path, record] of Object.entries(registry)) {
    if (path === excludePath) continue;
    for (const attachment of (_a = record.attachments) != null ? _a : []) {
      referenced.add(attachment);
    }
  }
  return referenced;
}
async function unpublishNote(plugin, file) {
  var _a;
  const settings = plugin.settings;
  const record = settings.registry[file.path];
  if (!record) {
    new import_obsidian5.Notice("This note has not been published.");
    return;
  }
  const referenced = collectReferencedAttachments(settings.registry, file.path);
  const ownAttachments = (_a = record.attachments) != null ? _a : [];
  const orphans = ownAttachments.filter((path) => !referenced.has(path));
  const confirmed = await new Promise((resolve) => {
    let resolved = false;
    const modal = new UnpublishConfirmModal(plugin.app, {
      noteName: file.basename,
      attachmentCount: orphans.length,
      onConfirm: () => {
        resolved = true;
        resolve(true);
        modal.close();
      }
    });
    const baseOnClose = modal.onClose.bind(modal);
    modal.onClose = () => {
      baseOnClose();
      if (!resolved) resolve(false);
    };
    modal.open();
  });
  if (!confirmed) return;
  let client;
  try {
    client = new GithubClient(settings);
  } catch (error) {
    new import_obsidian5.Notice(describeError(error));
    return;
  }
  const progress = new import_obsidian5.Notice(`Unpublishing ${file.basename}...`, 0);
  const attachmentFailures = [];
  let orphansRemoved = 0;
  try {
    for (const repoPath of orphans) {
      try {
        await client.deleteFile(repoPath, `Remove orphan asset ${repoPath}`);
        orphansRemoved++;
      } catch (e) {
        attachmentFailures.push(repoPath);
      }
    }
    await client.deleteFile(record.repoPath, `Unpublish note ${file.basename}`);
    delete settings.registry[file.path];
    await plugin.saveSettings();
    plugin.clearAutoUpdateTimer(file.path);
    progress.hide();
    let message = `Unpublished ${file.basename}.`;
    if (orphansRemoved > 0) {
      message += ` ${orphansRemoved} unused attachments removed.`;
    }
    new import_obsidian5.Notice(message);
    if (attachmentFailures.length > 0) {
      new import_obsidian5.Notice(
        `Could not remove ${attachmentFailures.length} attachment(s); the note was unpublished anyway. Affected paths: ${attachmentFailures.join(", ")}.`
      );
    }
  } catch (error) {
    progress.hide();
    new import_obsidian5.Notice(describeError(error));
  } finally {
    progress.hide();
  }
}
async function setupRepo(plugin) {
  const settings = plugin.settings;
  if (!hasConnectionSettings(settings)) {
    new import_obsidian5.Notice("Set a GitHub token and repository in the plugin settings first.");
    return;
  }
  let client;
  try {
    client = new GithubClient(settings);
  } catch (error) {
    new import_obsidian5.Notice(describeError(error));
    return;
  }
  const progress = new import_obsidian5.Notice("Setting up pages repo...", 0);
  try {
    progress.setMessage("Checking repository...");
    const repoInfo = await client.getRepo();
    if (repoInfo.private) {
      new import_obsidian5.Notice("Repository is private. Free GitHub Pages requires a public repository.");
    }
    progress.setMessage("Preparing repo files...");
    const scaffolding = (await Promise.all([
      buildJekyllConfigFile(client, settings),
      buildIndexPageFile(client, settings),
      buildHeadCustomFile(client),
      buildCalloutStylesFile(client)
    ])).filter((repoFile) => repoFile !== null);
    if (scaffolding.length > 0) {
      progress.setMessage("Committing repo files...");
      await client.commitFiles(scaffolding, "Set up GitHub Pages repo files");
    }
    progress.setMessage("Enabling pages...");
    try {
      await client.enablePages();
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 403) {
        const alreadyLive = await client.getPagesInfo().catch(() => null);
        if (!alreadyLive) {
          progress.hide();
          new import_obsidian5.Notice(
            "Pages isn't enabled yet. Open the repo's settings > Pages on GitHub and enable it manually, or grant the token the administration: write permission (required to enable Pages automatically).",
            0
          );
          return;
        }
      } else {
        throw error;
      }
    }
    settings.pagesConfirmed = true;
    await plugin.saveSettings();
    progress.setMessage("Checking pages status...");
    const pagesInfo = await client.getPagesInfo();
    progress.hide();
    if (pagesInfo) {
      settings.baseUrl = pagesInfo.url.replace(/\/+$/, "");
      await plugin.saveSettings();
      new import_obsidian5.Notice(`Pages is set up: ${pagesInfo.url}`, LONG_NOTICE_MS);
    } else {
      new import_obsidian5.Notice("Repo files are ready, but pages status could not be confirmed yet.", LONG_NOTICE_MS);
    }
  } catch (error) {
    progress.hide();
    new import_obsidian5.Notice(describeError(error), LONG_NOTICE_MS);
  } finally {
    progress.hide();
  }
}
async function publishFolder(plugin, folder) {
  if (!hasConnectionSettings(plugin.settings)) {
    new import_obsidian5.Notice("Set a GitHub token and repository in the plugin settings first.");
    return;
  }
  const prefix = folder.path === "/" ? "" : `${folder.path}/`;
  const files = plugin.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix)).sort((a, b) => a.path.localeCompare(b.path));
  if (files.length === 0) {
    new import_obsidian5.Notice("No Markdown notes in this folder.");
    return;
  }
  const progress = new import_obsidian5.Notice(`Publishing 0 / ${files.length} notes...`, 0);
  const failures = [];
  let successCount = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      progress.setMessage(`Publishing ${i + 1} / ${files.length}: ${file.basename}...`);
      try {
        const ok = await publishNote(plugin, file, { quiet: true });
        if (ok) {
          successCount++;
        } else {
          failures.push(file.basename);
        }
      } catch (e) {
        failures.push(file.basename);
      }
    }
  } finally {
    progress.hide();
  }
  if (failures.length === 0) {
    new import_obsidian5.Notice(`Published ${files.length} notes to GitHub Pages.`);
  } else if (successCount === 0) {
    new import_obsidian5.Notice(`Failed to publish ${files.length} notes.`);
  } else {
    const sample = failures.slice(0, 3).join(", ");
    new import_obsidian5.Notice(`Published ${successCount} of ${files.length} notes. ${failures.length} failed: ${sample}.`);
  }
}

// src/main.ts
var AUTO_UPDATE_DEBOUNCE_MS = 15e3;
var GithubPagesSharePlugin = class extends import_obsidian6.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.autoUpdateTimers = /* @__PURE__ */ new Map();
  }
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GithubPagesShareSettingTab(this.app, this));
    this.addCommand({
      id: "publish-note",
      name: "Publish current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof import_obsidian6.TFile) || file.extension !== "md") return false;
        if (checking) return true;
        void publishNote(this, file);
        return true;
      }
    });
    this.addCommand({
      id: "copy-link",
      name: "Copy published link",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof import_obsidian6.TFile) || file.extension !== "md") return false;
        if (checking) return true;
        void copyPublishedLink(this, file);
        return true;
      }
    });
    this.addCommand({
      id: "setup-repo",
      name: "Set up pages repo",
      callback: () => {
        void setupRepo(this);
      }
    });
    this.addCommand({
      id: "unpublish-note",
      name: "Unpublish current note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof import_obsidian6.TFile) || file.extension !== "md") return false;
        if (!this.settings.registry[file.path]) return false;
        if (checking) return true;
        void unpublishNote(this, file);
        return true;
      }
    });
    this.addRibbonIcon("upload-cloud", "Publish current note", () => {
      const file = this.app.workspace.getActiveFile();
      if (file instanceof import_obsidian6.TFile && file.extension === "md") {
        void publishNote(this, file);
      } else {
        new import_obsidian6.Notice("Open a Markdown note first.");
      }
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof import_obsidian6.TFile) || file.extension !== "md") return;
        menu.addItem((item) => {
          item.setTitle("Publish to GitHub Pages").setIcon("upload-cloud").onClick(() => {
            void publishNote(this, file);
          });
        });
        if (this.settings.registry[file.path]) {
          menu.addItem((item) => {
            item.setTitle("Unpublish from GitHub Pages").setIcon("trash-2").onClick(() => {
              void unpublishNote(this, file);
            });
          });
        }
      })
    );
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, folder) => {
        if (!(folder instanceof import_obsidian6.TFolder)) return;
        menu.addItem((item) => {
          item.setTitle("Publish folder").setIcon("upload-cloud").onClick(() => {
            void publishFolder(this, folder);
          });
        });
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof import_obsidian6.TFile)) return;
        this.scheduleAutoUpdate(file);
      })
    );
  }
  onunload() {
    for (const timerId of this.autoUpdateTimers.values()) {
      window.clearTimeout(timerId);
    }
    this.autoUpdateTimers.clear();
  }
  scheduleAutoUpdate(file) {
    if (!this.settings.autoUpdate) return;
    if (!this.settings.registry[file.path]) return;
    const existingTimer = this.autoUpdateTimers.get(file.path);
    if (existingTimer !== void 0) {
      window.clearTimeout(existingTimer);
    }
    const timerId = window.setTimeout(() => {
      this.autoUpdateTimers.delete(file.path);
      if (!this.settings.registry[file.path]) return;
      void publishNote(this, file, { quiet: true });
    }, AUTO_UPDATE_DEBOUNCE_MS);
    this.autoUpdateTimers.set(file.path, timerId);
  }
  /** Cancels any pending auto-update for `filePath`. Called by unpublishNote so the
   *  unpublish + a queued republish can never race. The map drops the entry either way. */
  clearAutoUpdateTimer(filePath) {
    const timerId = this.autoUpdateTimers.get(filePath);
    if (timerId !== void 0) {
      window.clearTimeout(timerId);
    }
    this.autoUpdateTimers.delete(filePath);
  }
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data, {
      registry: Object.assign({}, DEFAULT_SETTINGS.registry, data == null ? void 0 : data.registry)
    });
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
};
