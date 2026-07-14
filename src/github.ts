import { arrayBufferToBase64, requestUrl } from "obsidian";
import type { GithubPagesShareSettings } from "./settings";

const API_BASE = "https://api.github.com";

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

function extractErrorMessage(status: number, json: unknown): string {
	if (json && typeof json === "object" && "message" in json) {
		const message = (json as GithubErrorResponse).message;
		if (typeof message === "string" && message.length > 0) {
			return message;
		}
	}
	return `GitHub API request failed (${status}).`;
}

/** Thin GitHub Contents/Pages API client. All requests go through requestUrl for mobile compatibility. */
export class GithubClient {
	private readonly owner: string;
	private readonly repo: string;
	private readonly token: string;
	private readonly branch: string;

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
		if (response.status === 404) return null;
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
		if (response.status === 404) return null;
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
	 * Creates or updates a file in one call: looks up the current sha, then PUTs the new content.
	 * Retries up to 3 times on 409 / 422-with-sha conflicts so concurrent writers converge on the
	 * local content instead of failing the publish.
	 */
	async putFile(path: string, content: string | ArrayBuffer, message: string): Promise<void> {
		const buffer = typeof content === "string" ? textEncode(content) : content;
		const encoded = arrayBufferToBase64(buffer);
		const url = `${API_BASE}/repos/${this.owner}/${this.repo}/contents/${encodeRepoPath(path)}`;

		for (let attempt = 1; attempt <= 3; attempt++) {
			const sha = await this.getFileSha(path);
			const body: Record<string, unknown> = {
				message,
				content: encoded,
				branch: this.branch,
			};
			if (sha) body.sha = sha;

			const response = await requestUrl({
				url,
				method: "PUT",
				headers: this.headers({ "Content-Type": "application/json" }),
				body: JSON.stringify(body),
				throw: false,
			});
			if (response.status < 400) return;

			const isRetriable = response.status === 409
				|| (response.status === 422 && /sha/i.test(extractErrorMessage(response.status, response.json)));
			if (!isRetriable || attempt === 3) {
				throw new GithubApiError(extractErrorMessage(response.status, response.json), response.status);
			}
		}
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
