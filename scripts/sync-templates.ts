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

const config = templatesConfig satisfies TemplatesConfig;

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
		thumbnail: spec.icon,
	};
}

function renderAppstoreMdx(appstore: AppstorePageSchema) {
	const frontmatterObject = Object.fromEntries(Object.entries(appstore).filter(([, value]) => value !== undefined));
	const frontmatter = dump(frontmatterObject, { lineWidth: -1 }).trimEnd();
	const body = renderAppstoreBody(appstore);

	return `---\n${frontmatter}\n---\n\n${body}`;
}

function renderAppstoreBody(appstore: AppstorePageSchema) {
	return `# ${appstore.title}\n`;
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

async function parseTemplates(templateRootDir: string) {
	const manifestPaths = await listTemplateManifestPaths(templateRootDir);
	const templates = await Promise.all(
		manifestPaths.map(async (manifestPath) => {
			const manifest = await readTemplateManifest(manifestPath);
			if (!manifest) {
				return null;
			}

			const spec = manifest.spec;
			const fileSlug = path.basename(manifestPath).replace(/\.ya?ml$/u, '');
			const slug = fileSlug === 'index' ? path.basename(path.dirname(manifestPath)) : fileSlug;

			const template = {
				slug,
				manifestPath,
				spec,
				appstore: mapTemplateSpecToAppstore(spec),
			} satisfies ParsedTemplate;

			return template;
		}),
	);

	return templates.filter((template): template is ParsedTemplate => template !== null);
}

async function syncTemplates(templatesConfig: TemplatesConfig) {
	const { repo, branch, template_dir: templateDir, contents_output_dir: contentsOutputDir } = templatesConfig;
	const workspaceRoot = await getWorkspaceRoot();
	const cloneBaseDir = path.join(workspaceRoot, '.local');
	const cloneTargetDir = path.join(cloneBaseDir, 'templates');
	const configPath = path.join(workspaceRoot, 'config', 'templates.json');
	const lockPath = path.join(workspaceRoot, 'config', 'templates.lock.json');
	const templateRootDir = path.join(cloneTargetDir, templateDir);
	const outputDir = path.join(workspaceRoot, contentsOutputDir);

	await mkdir(cloneBaseDir, { recursive: true });
	await syncCloneTarget(cloneTargetDir, repo, branch);

	const templates = await parseTemplates(templateRootDir);
	await writeTemplatePages(outputDir, templates);
	const lock = await buildTemplatesLock(cloneTargetDir, configPath);
	await writeTemplatesLock(lockPath, lock);

	console.log(chalk.green(`templates synced to ${cloneTargetDir}`));
	console.log(chalk.green(`parsed ${templates.length} templates from ${templateRootDir}`));
	console.log(chalk.green(`generated ${templates.length} appstore pages in ${outputDir}`));
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
