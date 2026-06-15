#!/usr/bin/env zx

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { dump, load } from 'js-yaml';
import { $, chalk } from 'zx';

import templatesConfig from '../config/templates.json' with { type: 'json' };

type TemplatesConfig = {
	repo: string;
	branch: string;
	template_dir: string;
	contents_output_dir: string;
	trends_output_dir: string;
	trends_items: TrendItem[];
};

type TrendItem = {
	slug: string;
	stars: string;
	delta: string;
};

type TemplatesLock = {
	config_hash: string;
	ref: string;
	hash: string;
	updated_at: string;
};

type TemplateSpecField = {
	type: string;
	value: string;
};

type TemplateInput = {
	type: string;
	default?: string;
	description?: string;
	required?: boolean;
};

type TemplateSpec = {
	author?: string;
	categories?: string[];
	defaults?: Record<string, TemplateSpecField>;
	description?: string;
	draft?: boolean;
	gitRepo?: string;
	icon?: string;
	inputs?: Record<string, TemplateInput>;
	readme?: string;
	templateType: string;
	title: string;
	url?: string;
};

type TemplateManifest = {
	apiVersion?: string;
	kind?: string;
	metadata?: {
		name?: string;
	};
	spec: TemplateSpec;
};

type AppstorePageSchema = {
	title: string;
	description?: string;
	category?: string;
	deployCount?: number;
	github?: string;
	starsText?: string;
	versionText?: string;
	trendDeltaText?: string;
	thumbnail?: string;
};

type ParsedTemplate = {
	slug: string;
	manifestPath: string;
	spec: TemplateSpec;
	appstore: AppstorePageSchema;
};

type TrendPageSchema = AppstorePageSchema & {
	rank: number;
	trendDeltaText: string;
};

type IconManifestEntry = {
	contentType?: string;
	error?: string;
	file?: string;
	localSource?: string;
	path?: string;
	sha256?: string;
	source: string;
	status: 'copied' | 'downloaded' | 'failed' | 'skipped';
};

type IconManifest = Record<string, IconManifestEntry>;

const config = templatesConfig satisfies TemplatesConfig;
const ICONS_ROUTE_BASE_PATH = '/appstore/icons';
const ICONS_OUTPUT_DIRNAME = 'icons';
const MAX_ICON_SIZE_BYTES = 5 * 1024 * 1024;
const ICON_DOWNLOAD_TIMEOUT_MS = 15_000;
const CONTENT_TYPE_EXTENSION_MAP = new Map([
	['image/svg+xml', '.svg'],
	['image/png', '.png'],
	['image/jpeg', '.jpg'],
	['image/webp', '.webp'],
	['image/gif', '.gif'],
	['image/x-icon', '.ico'],
	['image/vnd.microsoft.icon', '.ico'],
]);
const SUPPORTED_ICON_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']);
const EXTENSION_CONTENT_TYPE_MAP = new Map(
	[...CONTENT_TYPE_EXTENSION_MAP.entries()].map(([contentType, extension]) => [extension, contentType]),
);

function normalizeGitHubUrl(input?: string) {
	if (!input) {
		return undefined;
	}

	const trimmed = input.trim();
	if (!trimmed) {
		return undefined;
	}

	const scpLikeMatch = trimmed.match(/^git@github\.com:(.+)$/u);
	const candidate = scpLikeMatch ? `https://github.com/${scpLikeMatch[1]}` : trimmed;
	const directRepoMatch = candidate.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u);
	if (directRepoMatch) {
		const [, owner, repo] = directRepoMatch;
		if (!owner || !repo) {
			return undefined;
		}

		return `https://github.com/${owner}/${repo}`;
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(candidate);
	} catch {
		return undefined;
	}

	const hostname = parsedUrl.hostname.toLowerCase();
	if (hostname !== 'github.com' && hostname !== 'www.github.com') {
		return undefined;
	}

	const [owner, repoWithOptionalSuffix] = parsedUrl.pathname.split('/').filter(Boolean);
	const repo = repoWithOptionalSuffix?.replace(/\.git$/u, '');
	if (!owner || !repo) {
		return undefined;
	}

	return `https://github.com/${owner}/${repo}`;
}

function normalizeSlug(input: string) {
	return input.trim().toLowerCase();
}

async function ensureGitEnvironment() {
	try {
		await $`git --version`;
	} catch (error) {
		throw new Error('git is not available in the current environment', {
			cause: error,
		});
	}

	try {
		const result = await $`git rev-parse --is-inside-work-tree`;
		if (result.stdout.trim() !== 'true') {
			throw new Error('current directory is not inside a git work tree');
		}
	} catch (error) {
		throw new Error('failed to validate current git environment', {
			cause: error,
		});
	}

	try {
		await $`git ls-remote --exit-code ${config.repo} ${config.branch}`;
	} catch (error) {
		throw new Error(`failed to access ${config.repo}#${config.branch}`, {
			cause: error,
		});
	}
}

async function getWorkspaceRoot() {
	const result = await $`git rev-parse --show-toplevel`;
	return result.stdout.trim();
}

async function pathExists(target: string) {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

async function hasInternalGitMetadata(target: string) {
	return pathExists(path.join(target, '.git'));
}

async function syncCloneTarget(targetDir: string, repo: string, branch: string) {
	const hasTarget = await pathExists(targetDir);
	const hasGitMetadata = hasTarget ? await hasInternalGitMetadata(targetDir) : false;

	if (!hasTarget) {
		await $`git clone --depth=1 --single-branch --branch ${branch} ${repo} ${targetDir}`;
		return;
	}

	if (!hasGitMetadata) {
		await rm(targetDir, { force: true, recursive: true });
		await $`git clone --depth=1 --single-branch --branch ${branch} ${repo} ${targetDir}`;
		return;
	}

	const remoteUrl = (await $({ cwd: targetDir, quiet: true })`git remote get-url origin`).stdout.trim();
	if (remoteUrl !== repo) {
		throw new Error(`clone target origin mismatch: expected ${repo}, got ${remoteUrl}`);
	}

	await $({ cwd: targetDir })`git fetch --depth=1 origin ${branch}`;
	await $({ cwd: targetDir })`git checkout -B ${branch} FETCH_HEAD`;
	await $({ cwd: targetDir })`git reset --hard FETCH_HEAD`;
	await $({ cwd: targetDir })`git clean -fd`;
	await $({ cwd: targetDir })`git remote set-branches origin ${branch}`;
}

async function computeConfigHash(configPath: string) {
	const content = await readFile(configPath, { encoding: 'utf8' });
	return createHash('sha256').update(content).digest('hex');
}

async function buildTemplatesLock(targetDir: string, configPath: string) {
	const configHash = await computeConfigHash(configPath);
	const commitHash = (await $({ cwd: targetDir, quiet: true })`git rev-parse HEAD`).stdout.trim();

	return {
		config_hash: configHash,
		ref: `refs/heads/${config.branch}`,
		hash: commitHash,
		updated_at: new Date().toISOString(),
	} satisfies TemplatesLock;
}

async function writeTemplatesLock(lockPath: string, lock: TemplatesLock) {
	const lockContent = `${JSON.stringify(lock, null, '\t')}\n`;
	await writeFile(lockPath, lockContent, { encoding: 'utf8' });
}

function isRemoteUrl(input: string) {
	try {
		const url = new URL(input);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

function normalizeContentType(contentType: string | null) {
	return contentType?.split(';')[0]?.trim().toLowerCase();
}

function getExtensionFromUrl(source: string) {
	try {
		const url = new URL(source);
		const ext = path.extname(url.pathname).toLowerCase();
		return SUPPORTED_ICON_EXTENSIONS.has(ext) ? ext : undefined;
	} catch {
		return undefined;
	}
}

function getExtensionFromContentType(contentType?: string) {
	if (!contentType) {
		return undefined;
	}

	return CONTENT_TYPE_EXTENSION_MAP.get(contentType);
}

function createIconRoutePath(slug: string, extension: string) {
	return `${ICONS_ROUTE_BASE_PATH}/${slug}${extension}`;
}

function createIconRelativeFile(slug: string, extension: string) {
	return `content/appstore/${ICONS_OUTPUT_DIRNAME}/${slug}${extension}`;
}

async function downloadIcon(slug: string, source: string, iconsDir: string): Promise<IconManifestEntry> {
	if (!isRemoteUrl(source)) {
		return {
			source,
			status: 'skipped',
			error: 'thumbnail is not an HTTP URL',
		};
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), ICON_DOWNLOAD_TIMEOUT_MS);

	try {
		const response = await fetch(source, {
			headers: {
				'user-agent': 'sealos.run content sync',
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const contentLength = Number(response.headers.get('content-length'));
		if (Number.isFinite(contentLength) && contentLength > MAX_ICON_SIZE_BYTES) {
			throw new Error(`icon is larger than ${MAX_ICON_SIZE_BYTES} bytes`);
		}

		const contentType = normalizeContentType(response.headers.get('content-type'));
		const extension = getExtensionFromUrl(source) ?? getExtensionFromContentType(contentType);
		if (!extension) {
			throw new Error(`unsupported icon content type: ${contentType ?? 'unknown'}`);
		}

		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.byteLength > MAX_ICON_SIZE_BYTES) {
			throw new Error(`icon is larger than ${MAX_ICON_SIZE_BYTES} bytes`);
		}

		const outputPath = path.join(iconsDir, `${slug}${extension}`);
		await writeFile(outputPath, bytes);

		return {
			contentType,
			file: createIconRelativeFile(slug, extension),
			path: createIconRoutePath(slug, extension),
			sha256: createHash('sha256').update(bytes).digest('hex'),
			source,
			status: 'downloaded',
		};
	} catch (error) {
		return {
			source,
			status: 'failed',
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

async function copyLocalTemplateIcon(slug: string, manifestPath: string, source: string, iconsDir: string) {
	const templateDir = path.dirname(manifestPath);
	const entries = await readdir(templateDir, { withFileTypes: true });
	const localIcon = entries
		.filter((entry) => entry.isFile())
		.map((entry) => {
			const extension = path.extname(entry.name).toLowerCase();
			return {
				extension,
				name: entry.name,
			};
		})
		.find(
			(entry) => entry.name.toLowerCase().startsWith('logo.') && SUPPORTED_ICON_EXTENSIONS.has(entry.extension),
		);

	if (!localIcon) {
		return undefined;
	}

	const localSource = path.join(templateDir, localIcon.name);
	const bytes = await readFile(localSource);
	const outputPath = path.join(iconsDir, `${slug}${localIcon.extension}`);
	await writeFile(outputPath, bytes);

	return {
		contentType: EXTENSION_CONTENT_TYPE_MAP.get(localIcon.extension),
		file: createIconRelativeFile(slug, localIcon.extension),
		localSource: path.relative(path.dirname(iconsDir), localSource),
		path: createIconRoutePath(slug, localIcon.extension),
		sha256: createHash('sha256').update(bytes).digest('hex'),
		source,
		status: 'copied',
	} satisfies IconManifestEntry;
}

function applyLocalIconPaths(templates: ParsedTemplate[], manifest: IconManifest) {
	return templates.map((template) => {
		const icon = manifest[template.slug];
		if ((icon?.status !== 'downloaded' && icon?.status !== 'copied') || !icon.path) {
			return template;
		}

		return {
			...template,
			appstore: {
				...template.appstore,
				thumbnail: icon.path,
			},
		};
	});
}

function removeUnavailableIconPaths(templates: ParsedTemplate[], manifest: IconManifest) {
	return templates.map((template) => {
		const icon = manifest[template.slug];
		if (!icon || icon.status === 'downloaded' || icon.status === 'copied') {
			return template;
		}

		return {
			...template,
			appstore: {
				...template.appstore,
				thumbnail: undefined,
			},
		};
	});
}

async function writeIconManifest(iconsDir: string, manifest: IconManifest) {
	const sortedManifest = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
	await writeFile(path.join(iconsDir, 'manifest.json'), `${JSON.stringify(sortedManifest, null, '\t')}\n`, {
		encoding: 'utf8',
	});
}

async function downloadTemplateIcons(iconsDir: string, templates: ParsedTemplate[]) {
	await rm(iconsDir, { force: true, recursive: true });
	await mkdir(iconsDir, { recursive: true });

	const manifestEntries = await Promise.all(
		templates
			.toSorted((a, b) => a.slug.localeCompare(b.slug))
			.map(async (template) => {
				const source = template.spec.icon;
				if (!source) {
					return [
						template.slug,
						{
							source: '',
							status: 'skipped',
							error: 'template spec has no icon',
						} satisfies IconManifestEntry,
					] as const;
				}

				const icon = await downloadIcon(template.slug, source, iconsDir);
				if (icon.status === 'downloaded') {
					return [template.slug, icon] as const;
				}

				const localIcon = await copyLocalTemplateIcon(template.slug, template.manifestPath, source, iconsDir);
				if (localIcon) {
					return [template.slug, localIcon] as const;
				}

				return [template.slug, icon] as const;
			}),
	);
	const manifest = Object.fromEntries(manifestEntries);

	await writeIconManifest(iconsDir, manifest);

	return manifest;
}

function isYamlFile(entry: Dirent) {
	return entry.isFile() && /\.ya?ml$/u.test(entry.name);
}

async function resolveTemplateManifestPath(templateRootDir: string, entry: Dirent) {
	if (isYamlFile(entry)) {
		return path.join(templateRootDir, entry.name);
	}

	if (!entry.isDirectory()) {
		return null;
	}

	const yamlCandidates = ['index.yaml', 'index.yml'];
	for (const candidate of yamlCandidates) {
		const manifestPath = path.join(templateRootDir, entry.name, candidate);
		if (await pathExists(manifestPath)) {
			return manifestPath;
		}
	}

	throw new Error(`template directory is missing index.yaml: ${path.join(templateRootDir, entry.name)}`);
}

async function listTemplateManifestPaths(templateRootDir: string) {
	const entries = await readdir(templateRootDir, { withFileTypes: true });
	const manifestPaths = await Promise.all(
		entries
			.filter((entry) => !entry.name.startsWith('.'))
			.map((entry) => resolveTemplateManifestPath(templateRootDir, entry)),
	);

	return manifestPaths.filter((manifestPath): manifestPath is string => manifestPath !== null).sort();
}

function splitYamlDocuments(source: string) {
	return source
		.split(/^---\s*$/mu)
		.map((documentSource) => documentSource.trim())
		.filter((documentSource) => documentSource.length > 0);
}

function assertTemplateSpec(manifestPath: string, manifest: unknown): TemplateManifest {
	if (!manifest || typeof manifest !== 'object') {
		throw new Error(`template manifest must be an object: ${manifestPath}`);
	}

	const typedManifest = manifest as TemplateManifest;
	if (!typedManifest.spec) {
		throw new Error(`template manifest is missing spec: ${manifestPath}`);
	}

	if (!typedManifest.spec.title || !typedManifest.spec.templateType) {
		throw new Error(`template spec is missing required fields: ${manifestPath}`);
	}

	return typedManifest;
}

function isTemplateManifest(manifest: unknown): manifest is TemplateManifest {
	if (!manifest || typeof manifest !== 'object') {
		return false;
	}

	const candidate = manifest as { kind?: unknown };
	if (candidate.kind !== 'Template') {
		return false;
	}

	try {
		assertTemplateSpec('template resource', manifest);
		return true;
	} catch {
		return false;
	}
}

async function readTemplateManifest(manifestPath: string) {
	const source = await readFile(manifestPath, { encoding: 'utf8' });
	const documents = splitYamlDocuments(source);
	const parsedDocuments: unknown[] = [];

	for (const documentSource of documents) {
		try {
			parsedDocuments.push(load(documentSource));
		} catch {}
	}

	const manifest = parsedDocuments.find((document) => isTemplateManifest(document));
	if (!manifest) {
		return null;
	}

	return assertTemplateSpec(manifestPath, manifest);
}

function mapTemplateSpecToAppstore(spec: TemplateSpec): AppstorePageSchema {
	return {
		title: spec.title,
		description: spec.description,
		category: spec.categories?.[0],
		github: normalizeGitHubUrl(spec.gitRepo),
		thumbnail: spec.icon,
	};
}

function generateDeployCount(title: string, templateStaticMap: Record<string, number>) {
	const appTitle = title.toUpperCase();
	const currentCount = templateStaticMap[appTitle] || 0;
	const randomFactor = 11 + Math.floor(Math.random() * 5);
	const deployCount = (currentCount + 1) * randomFactor;

	templateStaticMap[appTitle] = currentCount + 1;

	return deployCount;
}

function renderMdxDocument(frontmatterObject: Record<string, string | number | boolean>, body: string) {
	const frontmatter = dump(frontmatterObject, { lineWidth: -1 }).trimEnd();

	return `---\n${frontmatter}\n---\n\n${body}`;
}

function renderAppstoreMdx(appstore: AppstorePageSchema) {
	const frontmatterObject = Object.fromEntries(
		Object.entries(appstore).filter(([, value]) => value !== undefined),
	) as Record<string, string | number | boolean>;

	return renderMdxDocument(frontmatterObject, renderAppstoreBody(appstore));
}

function renderAppstoreBody(appstore: AppstorePageSchema) {
	return `# ${appstore.title}\n`;
}

function renderTrendMdx(trend: TrendPageSchema) {
	const frontmatterObject = Object.fromEntries(
		Object.entries(trend).filter(([, value]) => value !== undefined),
	) as Record<string, string | number | boolean>;

	return renderMdxDocument(frontmatterObject, renderTrendBody(trend));
}

function renderTrendBody(trend: TrendPageSchema) {
	return `# ${trend.title}\n`;
}

async function writeTemplatePages(outputDir: string, templates: ParsedTemplate[]) {
	await rm(outputDir, { force: true, recursive: true });
	await mkdir(outputDir, { recursive: true });

	await Promise.all(
		templates.map(async (template) => {
			const outputPath = path.join(outputDir, `${template.slug}.mdx`);
			const content = renderAppstoreMdx(template.appstore);
			await writeFile(outputPath, content, { encoding: 'utf8' });
		}),
	);
}

function mapTrendItemToPage(template: ParsedTemplate, trendItem: TrendItem, rank: number): TrendPageSchema {
	return {
		...template.appstore,
		starsText: `Star ${trendItem.stars}`,
		trendDeltaText: trendItem.delta,
		rank,
	};
}

async function writeTrendPages(outputDir: string, templates: ParsedTemplate[], trendItems: TrendItem[]) {
	await rm(outputDir, { force: true, recursive: true });
	await mkdir(outputDir, { recursive: true });

	const templatesBySlug = new Map(templates.map((template) => [template.slug, template]));

	await Promise.all(
		trendItems.map(async (trendItem, index) => {
			const template = templatesBySlug.get(trendItem.slug);
			if (!template) {
				throw new Error(`trend item slug not found in parsed templates: ${trendItem.slug}`);
			}

			const rank = index + 1;
			if (rank > 5) {
				throw new Error(`trend item rank is out of range: ${trendItem.slug}`);
			}

			const trendPage = mapTrendItemToPage(template, trendItem, rank);
			const outputPath = path.join(outputDir, `${trendItem.slug}.mdx`);
			await writeFile(outputPath, renderTrendMdx(trendPage), { encoding: 'utf8' });
		}),
	);
}

async function parseTemplates(templateRootDir: string) {
	const manifestPaths = await listTemplateManifestPaths(templateRootDir);
	const templateStaticMap: Record<string, number> = {};
	const templates = await Promise.all(
		manifestPaths.map(async (manifestPath) => {
			const manifest = await readTemplateManifest(manifestPath);
			if (!manifest) {
				return null;
			}

			const spec = manifest.spec;
			const fileSlug = path.basename(manifestPath).replace(/\.ya?ml$/u, '');
			const rawSlug = fileSlug === 'index' ? path.basename(path.dirname(manifestPath)) : fileSlug;
			const slug = normalizeSlug(rawSlug);

			const template: ParsedTemplate = {
				slug,
				manifestPath,
				spec,
				appstore: {
					...mapTemplateSpecToAppstore(spec),
					deployCount: generateDeployCount(spec.title, templateStaticMap),
				},
			};

			return template;
		}),
	);

	return templates.filter((template): template is ParsedTemplate => template !== null);
}

async function syncTemplates(templatesConfig: TemplatesConfig) {
	const {
		repo,
		branch,
		template_dir: templateDir,
		contents_output_dir: contentsOutputDir,
		trends_output_dir: trendsOutputDir,
		trends_items: trendItems,
	} = templatesConfig;
	const workspaceRoot = await getWorkspaceRoot();
	const cloneBaseDir = path.join(workspaceRoot, '.local');
	const cloneTargetDir = path.join(cloneBaseDir, 'templates');
	const configPath = path.join(workspaceRoot, 'config', 'templates.json');
	const lockPath = path.join(workspaceRoot, 'config', 'templates.lock.json');
	const templateRootDir = path.join(cloneTargetDir, templateDir);
	const outputDir = path.join(workspaceRoot, contentsOutputDir);
	const trendsDir = path.join(workspaceRoot, trendsOutputDir);
	const iconsDir = path.join(workspaceRoot, 'content', 'appstore', ICONS_OUTPUT_DIRNAME);

	await mkdir(cloneBaseDir, { recursive: true });
	await syncCloneTarget(cloneTargetDir, repo, branch);

	const parsedTemplates = await parseTemplates(templateRootDir);
	const iconManifest = await downloadTemplateIcons(iconsDir, parsedTemplates);
	const templates = applyLocalIconPaths(removeUnavailableIconPaths(parsedTemplates, iconManifest), iconManifest);
	await writeTemplatePages(outputDir, templates);
	await writeTrendPages(trendsDir, templates, trendItems);
	const lock = await buildTemplatesLock(cloneTargetDir, configPath);
	await writeTemplatesLock(lockPath, lock);

	console.log(chalk.green(`templates synced to ${cloneTargetDir}`));
	console.log(chalk.green(`parsed ${templates.length} templates from ${templateRootDir}`));
	console.log(chalk.green(`generated appstore icons in ${iconsDir}`));
	console.log(chalk.green(`generated ${templates.length} appstore pages in ${outputDir}`));
	console.log(chalk.green(`generated ${trendItems.length} trend pages in ${trendsDir}`));
	console.log(chalk.green(`lockfile updated at ${lockPath}`));
	return templates;
}

async function main() {
	await ensureGitEnvironment();
	await syncTemplates(config);
}

main().catch((error) => {
	console.error(chalk.red(error instanceof Error ? error.message : String(error)));
	process.exit(1);
});
