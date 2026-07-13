import { App, TFile, normalizePath } from "obsidian";
import type { GithubPagesShareSettings, PublishedNoteRecord } from "./settings";

export interface AttachmentToUpload {
	file: TFile;
	repoPath: string;
}

export interface TransformResult {
	content: string;
	attachments: AttachmentToUpload[];
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"]);

const SLUG_CHAR = /[\p{L}\p{N}]/u;

/** Small FNV-1a hash producing 8 hex chars. Slug fallback seed; no Node crypto (mobile compat). */
function shortHash(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Lowercases and keeps letters/digits of any language (Unicode property escapes; no regex
 * lookbehind for iOS compat); everything else becomes "-", with repeats collapsed.
 * If nothing survives, falls back to a short hash of fallbackSeed (e.g. the vault path).
 */
export function slugify(input: string, fallbackSeed?: string): string {
	let out = "";
	for (const ch of input.toLowerCase()) {
		out += SLUG_CHAR.test(ch) ? ch : "-";
	}
	const collapsed = out
		.split("-")
		.filter((part) => part.length > 0)
		.join("-");
	return collapsed || `note-${shortHash(fallbackSeed ?? input)}`;
}

/** Slugifies a file's basename while preserving its extension. */
export function slugifyFileName(name: string, fallbackSeed?: string): string {
	const dotIndex = name.lastIndexOf(".");
	if (dotIndex <= 0) return slugify(name, fallbackSeed);
	const base = name.slice(0, dotIndex);
	const ext = name.slice(dotIndex + 1).toLowerCase();
	return `${slugify(base, fallbackSeed)}.${ext}`;
}

function escapeYamlString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isExternalLink(link: string): boolean {
	return link.includes("://") || link.startsWith("mailto:");
}

interface ExistingFrontmatter {
	exists: boolean;
	/** Offset right after the opening "---\n" line, where a new key can be inserted. */
	insertOffset: number;
	/** Frontmatter body text, excluding both "---" fence lines. */
	body: string;
}

/**
 * Detects an existing YAML frontmatter block without relying on `getFrontMatterInfo`
 * (that helper needs Obsidian 1.5.7+, above this plugin's minAppVersion of 1.5.0).
 */
function findFrontmatter(content: string): ExistingFrontmatter {
	const none: ExistingFrontmatter = { exists: false, insertOffset: 0, body: "" };
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

/** Ensures the note has YAML frontmatter with a title, since Jekyll only renders files that have frontmatter. */
export function ensureFrontmatter(content: string, title: string): string {
	const frontmatter = findFrontmatter(content);
	if (!frontmatter.exists) {
		return `---\ntitle: "${escapeYamlString(title)}"\n---\n\n${content}`;
	}
	const hasTitle = frontmatter.body.split("\n").some((line) => line.trimStart().startsWith("title:"));
	if (hasTitle) return content;
	return `${content.slice(0, frontmatter.insertOffset)}title: "${escapeYamlString(title)}"\n${content.slice(frontmatter.insertOffset)}`;
}

interface Replacement {
	start: number;
	end: number;
	text: string;
}

function linkReplacementText(
	target: TFile,
	display: string,
	registry: Record<string, PublishedNoteRecord>,
): string {
	const record = registry[target.path];
	if (record) {
		return `[${display}](${record.slug}.html)`;
	}
	return display;
}

/**
 * Converts wikilinks to standard relative links (or plain text when the target isn't published yet),
 * uploads embedded images to the assets folder and rewrites their paths, and ensures frontmatter exists.
 * Everything else is left for Jekyll to render as-is (e.g. callouts degrade to blockquotes).
 */
export function transformNote(
	app: App,
	file: TFile,
	rawContent: string,
	settings: GithubPagesShareSettings,
): TransformResult {
	const cache = app.metadataCache.getFileCache(file);
	const replacements: Replacement[] = [];
	const attachmentsByPath = new Map<string, AttachmentToUpload>();

	// Notes live at {notesFolder}/{slug}.md, so climbing out takes one ".." per folder segment.
	const notesDepth = settings.notesFolder.split("/").filter((segment) => segment.length > 0).length;
	const upToRoot = "../".repeat(Math.max(notesDepth, 1));

	for (const embed of cache?.embeds ?? []) {
		if (isExternalLink(embed.link)) continue; // leave external images/embeds untouched

		const target = app.metadataCache.getFirstLinkpathDest(embed.link, file.path);
		if (!target) {
			// Broken local embed: drop to plain text rather than shipping a dead reference.
			replacements.push({
				start: embed.position.start.offset,
				end: embed.position.end.offset,
				text: embed.displayText ?? embed.link,
			});
			continue;
		}

		if (IMAGE_EXTENSIONS.has(target.extension.toLowerCase())) {
			const repoFileName = slugifyFileName(target.name, target.path);
			const repoPath = normalizePath(`${settings.assetsFolder}/${repoFileName}`);
			attachmentsByPath.set(target.path, { file: target, repoPath });
			const alt = embed.displayText ?? target.basename;
			replacements.push({
				start: embed.position.start.offset,
				end: embed.position.end.offset,
				text: `![${alt}](${upToRoot}${settings.assetsFolder}/${repoFileName})`,
			});
		} else {
			// Embedding a non-image file (e.g. another note): Jekyll can't transclude it either way,
			// so fall back to the same "link if published, else plain text" handling as wikilinks.
			replacements.push({
				start: embed.position.start.offset,
				end: embed.position.end.offset,
				text: linkReplacementText(target, embed.displayText ?? embed.link, settings.registry),
			});
		}
	}

	for (const link of cache?.links ?? []) {
		if (isExternalLink(link.link)) continue; // keep [text](https://...) links untouched

		const display = link.displayText ?? link.link;
		const target = app.metadataCache.getFirstLinkpathDest(link.link, file.path);
		if (!target) {
			replacements.push({ start: link.position.start.offset, end: link.position.end.offset, text: display });
			continue;
		}
		replacements.push({
			start: link.position.start.offset,
			end: link.position.end.offset,
			text: linkReplacementText(target, display, settings.registry),
		});
	}

	replacements.sort((a, b) => b.start - a.start);
	let body = rawContent;
	for (const replacement of replacements) {
		body = body.slice(0, replacement.start) + replacement.text + body.slice(replacement.end);
	}

	const content = ensureFrontmatter(body, file.basename);
	return { content, attachments: Array.from(attachmentsByPath.values()) };
}
