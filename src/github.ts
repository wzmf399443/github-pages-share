import { arrayBufferToBase64, requestUrl } from "obsidian";
import type { GithubPagesShareSettings } from "./settings";

const API_BASE = "https://api.github.com";

/**
 * Seed content for the single commit that bootstraps a brand-new (zero-commit) repo. Pushing one
 * README via the Contents API creates the first commit and the branch, turning the repo non-empty
 * so the standard Git Data API flow can take over for the actual files.
 */
const BOOTSTRAP_README = "# Published with GitHub Pages Share\n\nThis repository hosts notes published from Obsidian.\n";

export class GithubApiError extends Error {
	status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "GithubApiError";
		this.status = status;
	}
}

interface RepoOwnerName {
	owner: string;
	repo: string;
}

interface GithubContentsResponse {
	sha?: string;
}

interface GithubErrorResponse {
	message?: string;
}

interface GithubRepoResponse {
	default_branch?: string;
	private?: boolean;
}

interface GithubPagesResponse {
	html_url?: string;
}

interface GithubRefResponse {
	object?: { sha?: string };
}

interface GithubCommitResponse {
	tree?: { sha?: string };
}

interface GithubShaResponse {
	sha?: string;
}

type BranchHead =
	| { kind: "head"; sha: string }
	| { kind: "no-branch" }
	| { kind: "empty-repo" };

interface GithubPutFileResponse {
	commit?: { sha?: string };
}

/** Parses "owner/name" into its parts, or returns null if malformed. */
export function parseRepo(repo: string): RepoOwnerName | null {
	const parts = repo.split("/").map((part) => part.trim());
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	if (!/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) return null;
	return { owner: parts[0], repo: parts[1] };
}

function encodeRepoPath(path: string): string {
	return path
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

function textEncode(content: string): ArrayBuffer {
	return new TextEncoder().encode(content).buffer;
}

/** Backoff before re-reading the branch head after a non-fast-forward, letting the ref replica catch up. */
const REF_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function extractErrorMessage(status: number, json: unknown): string {
	if (json && typeof json === "object" && "message" in json) {
		const message = (json as GithubErrorResponse).message;
		if (typeof message === "string" && message.length > 0) {
			return message;
		}
	}
	return `GitHub API request failed (${status}).`;
}

/**
 * A repo with zero commits answers read endpoints (contents, ref, commits) with 409 "Git Repository
 * is empty." rather than 404. Semantically that's just "nothing is there yet", so callers treat it
 * like a 404 (return null / take the bootstrap path) instead of surfacing it as a save conflict.
 */
function isEmptyRepoResponse(status: number, json: unknown): boolean {
	return status === 409 && /empty/i.test(extractErrorMessage(status, json));
}

/** Thin GitHub Contents/Pages API client. All requests go through requestUrl for mobile compatibility. */
export class GithubClient {
	private readonly owner: string;
	private readonly repo: string;
	private readonly token: string;
	private readonly branch: string;

	/**
	 * Remembers the last commit sha this process pushed, keyed by `owner/repo/branch`. Right after
	 * our own commit GitHub's ref-read replica often still returns the previous head; trusting this
	 * value as the parent avoids a phantom non-fast-forward for sequential single-writer updates.
	 * Static so it survives the per-publish GithubClient instances.
	 */
	private static readonly lastPushedHead = new Map<string, string>();

	constructor(settings: GithubPagesShareSettings) {
		const parsed = parseRepo(settings.repo);
		if (!parsed) {
			throw new GithubApiError("Repository must be set as owner/name in settings.", 0);
		}
		this.owner = parsed.owner;
		this.repo = parsed.repo;
		this.token = settings.token;
		this.branch = settings.branch || "main";
	}

	private headers(extra?: Record<string, string>): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...extra,
		};
	}

	/** Returns the current blob sha for a repo path, or null if the file does not exist yet. */
	async getFileSha(path: string): Promise<string | null> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(this.branch)}`;
		const response = await requestUrl({ url, method: "GET", headers: this.headers(), throw: false });
		if (response.status === 404 || isEmptyRepoResponse(response.status, response.json)) return null;
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubContentsResponse;
		return data.sha ?? null;
	}

	/**
	 * Fetches a repo file's decoded UTF-8 contents, or null if the file does not exist yet.
	 * Uses atob + TextDecoder instead of Node Buffer so this stays mobile-compatible.
	 */
	async getFileContent(path: string): Promise<string | null> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}?ref=${encodeURIComponent(this.branch)}`;
		const response = await requestUrl({ url, method: "GET", headers: this.headers(), throw: false });
		if (response.status === 404 || isEmptyRepoResponse(response.status, response.json)) return null;
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as { content?: string; encoding?: string } | null;
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
	 */
	async commitFiles(files: Array<{ path: string; content: string | ArrayBuffer }>, message: string): Promise<void> {
		if (files.length === 0) return;

		const branchKey = `${this.owner}/${this.repo}/${this.branch}`;
		let initialHead = await this.getBranchHeadSha();

		if (initialHead.kind === "empty-repo") {
			// Bootstrap: the repo has zero commits, so the Git Data API rejects every blob/tree/commit
			// call with 409. Push one README via the Contents API to create the first commit and the
			// branch, then continue through the standard flow below (now that the repo is non-empty).
			const readmeSha = await this.putFile("README.md", BOOTSTRAP_README, "Initialize repository");
			// Trust this sha as the head for the flow below so the immediately-following ref read,
			// which often still lags on a just-created branch, can't trip a phantom non-fast-forward.
			GithubClient.lastPushedHead.set(branchKey, readmeSha);
			initialHead = { kind: "head", sha: readmeSha };
		}

		// Blobs are content-addressed and immutable, so create them once and reuse across retries.
		const blobShas = await Promise.all(files.map((file) => this.createBlob(file.content)));
		const entries = files.map((file, i) => ({ path: file.path, sha: blobShas[i] }));

		const MAX_ATTEMPTS = REF_RETRY_DELAYS_MS.length + 1;
		// Trust our remembered head on the first try; once a real non-fast-forward proves it stale,
		// fall back to whatever the (by then hopefully caught-up) API read returns.
		let trustRemembered = true;
		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const branchHead = attempt === 1 ? initialHead : await this.getBranchHeadSha();
			const apiHead = branchHead.kind === "head" ? branchHead.sha : null;
			const remembered = GithubClient.lastPushedHead.get(branchKey);
			const headSha = trustRemembered && remembered && remembered !== apiHead ? remembered : apiHead;

			const baseTreeSha = headSha ? await this.getCommitTreeSha(headSha) : null;
			const treeSha = await this.createTree(baseTreeSha, entries);
			const commitSha = await this.createCommit(message, treeSha, headSha);
			const res = await this.updateOrCreateBranchRef(commitSha, headSha !== null);
			if (res.status < 400) {
				GithubClient.lastPushedHead.set(branchKey, commitSha);
				return;
			}
			// A 422 means our head guess was behind (non-fast-forward). Our remembered sha is proven
			// stale, so stop trusting it and give the ref replica time to catch up before re-reading.
			if (res.status !== 422 || attempt === MAX_ATTEMPTS) {
				throw new GithubApiError(extractErrorMessage(res.status, res.json), res.status);
			}
			trustRemembered = false;
			GithubClient.lastPushedHead.delete(branchKey);
			await sleep(REF_RETRY_DELAYS_MS[attempt - 1]);
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
	private async getBranchHeadSha(): Promise<BranchHead> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`;
		const response = await requestUrl({ url, method: "GET", headers: this.headers(), throw: false });
		if (isEmptyRepoResponse(response.status, response.json)) return { kind: "empty-repo" };
		if (response.status === 404) return { kind: "no-branch" };
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubRefResponse;
		const sha = data.object?.sha;
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
	private async putFile(path: string, content: string | ArrayBuffer, message: string): Promise<string> {
		const buffer = typeof content === "string" ? textEncode(content) : content;
		const encoded = arrayBufferToBase64(buffer);
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}`;
		const response = await requestUrl({
			url,
			method: "PUT",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ message, content: encoded, branch: this.branch }),
			throw: false,
		});
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubPutFileResponse;
		const sha = data.commit?.sha;
		if (!sha) throw new GithubApiError("GitHub put-file response missing commit sha.", response.status);
		return sha;
	}

	/** Returns the tree sha for a commit. */
	private async getCommitTreeSha(commitSha: string): Promise<string> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/commits/${commitSha}`;
		const response = await requestUrl({ url, method: "GET", headers: this.headers(), throw: false });
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubCommitResponse;
		const treeSha = data.tree?.sha;
		if (!treeSha) throw new GithubApiError("GitHub commit response missing tree sha.", response.status);
		return treeSha;
	}

	/** Creates a blob from text or binary content and returns its sha. */
	private async createBlob(content: string | ArrayBuffer): Promise<string> {
		const buffer = typeof content === "string" ? textEncode(content) : content;
		const encoded = arrayBufferToBase64(buffer);
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/blobs`;
		const response = await requestUrl({
			url,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ content: encoded, encoding: "base64" }),
			throw: false,
		});
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubShaResponse;
		if (!data.sha) throw new GithubApiError("GitHub blob response missing sha.", response.status);
		return data.sha;
	}

	/** Builds a new tree from the given entries, inheriting untouched paths from base_tree. */
	private async createTree(
		baseTreeSha: string | null,
		entries: Array<{ path: string; sha: string }>,
	): Promise<string> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/trees`;
		const body: Record<string, unknown> = {
			tree: entries.map((entry) => ({ path: entry.path, mode: "100644", type: "blob", sha: entry.sha })),
		};
		if (baseTreeSha) body.base_tree = baseTreeSha;
		const response = await requestUrl({
			url,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify(body),
			throw: false,
		});
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubShaResponse;
		if (!data.sha) throw new GithubApiError("GitHub tree response missing sha.", response.status);
		return data.sha;
	}

	/** Creates a commit; parentSha is null only for the first commit in an empty repo. */
	private async createCommit(message: string, treeSha: string, parentSha: string | null): Promise<string> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/git/commits`;
		const response = await requestUrl({
			url,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ message, tree: treeSha, parents: parentSha ? [parentSha] : [] }),
			throw: false,
		});
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubShaResponse;
		if (!data.sha) throw new GithubApiError("GitHub commit response missing sha.", response.status);
		return data.sha;
	}

	/**
	 * Points the branch at the new commit. Updates the existing ref with force:false so a concurrent
	 * commit surfaces as a 422 non-fast-forward instead of being clobbered, or creates the ref when
	 * the branch has no commits yet. Returns the raw response so the caller can retry on 422.
	 */
	private async updateOrCreateBranchRef(
		commitSha: string,
		refExists: boolean,
	): Promise<{ status: number; json: unknown }> {
		const url = refExists
			? `${API_BASE}/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`
			: `${API_BASE}/repos/${this.owner}/${this.repo}/git/refs`;
		const body = refExists
			? { sha: commitSha, force: false }
			: { ref: `refs/heads/${this.branch}`, sha: commitSha };
		const response = await requestUrl({
			url,
			method: refExists ? "PATCH" : "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify(body),
			throw: false,
		});
		return { status: response.status, json: response.json };
	}

	/** Fetches repo metadata; also used by "Test connection". */
	async getRepo(): Promise<{ defaultBranch: string; private: boolean }> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}`;
		const response = await requestUrl({ url, method: "GET", headers: this.headers(), throw: false });
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubRepoResponse;
		return { defaultBranch: data.default_branch ?? this.branch, private: data.private ?? false };
	}

	/** Enables GitHub Pages for the configured branch. A 409 means Pages is already enabled. */
	async enablePages(): Promise<void> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/pages`;
		const response = await requestUrl({
			url,
			method: "POST",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ source: { branch: this.branch, path: "/" } }),
			throw: false,
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
	async deleteFile(path: string, message: string): Promise<void> {
		const sha = await this.getFileSha(path);
		if (!sha) return;
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}`;
		const response = await requestUrl({
			url,
			method: "DELETE",
			headers: this.headers({ "Content-Type": "application/json" }),
			body: JSON.stringify({ message, sha, branch: this.branch }),
			throw: false,
		});
		if (response.status === 404) return;
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		// The delete moved the branch head outside commitFiles; forget our cached head so the next
		// commit re-reads it instead of trusting a now-stale sha.
		GithubClient.lastPushedHead.delete(`${this.owner}/${this.repo}/${this.branch}`);
	}

	/** Returns the live Pages URL, or null if Pages is not enabled. */
	async getPagesInfo(): Promise<{ url: string } | null> {
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/pages`;
		const response = await requestUrl({ url, method: "GET", headers: this.headers(), throw: false });
		if (response.status === 404) return null;
		if (response.status >= 400) {
			throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
		}
		const data = response.json as GithubPagesResponse;
		return data.html_url ? { url: data.html_url } : null;
	}
}
