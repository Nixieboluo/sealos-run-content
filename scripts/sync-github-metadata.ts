#!/usr/bin/env tsx

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { load } from 'js-yaml';
import { $, chalk } from 'zx';

import githubMetadataConfig from '../config/github-metadata.json' with { type: 'json' };

type GitHubMetadataConfig = {
	api_base_url: string;
	templates_dir: string;
	output_dir: string;
	extra_repos: string[];
	exclude_repos: string[];
};

type GitHubMetadataLock = {
	config_hash: string;
	hash: string;
	updated_at: string;
};

type FetchSuccess = {
	fileName: string;
	payload: unknown;
	repo: string;
};

type FetchFailure = {
	repo: string;
	reason: string;
};

const config = githubMetadataConfig satisfies GitHubMetadataConfig;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
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

async function computeConfigHash(configPath: string) {
	const content = await readFile(configPath, { encoding: 'utf8' });
	return createHash('sha256').update(content).digest('hex');
}

async function writeGitHubMetadataLock(lockPath: string, lock: GitHubMetadataLock) {
	const lockContent = `${JSON.stringify(lock, null, '\t')}\n`;
	await writeFile(lockPath, lockContent, { encoding: 'utf8' });
}

function parseFrontmatter(source: string): Record<string, unknown> {
	const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u);
	if (!match) {
		return {};
	}

	const frontmatterSource = match[1];
	if (!frontmatterSource) {
		return {};
	}

	try {
		const parsed = load(frontmatterSource);
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function isMdxFile(entry: Dirent) {
	return entry.isFile() && entry.name.endsWith('.mdx');
}

function normalizeGithubRepo(input: string) {
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}

	const scpLikeMatch = trimmed.match(/^git@github\.com:(.+)$/u);
	const candidate = scpLikeMatch ? `https://github.com/${scpLikeMatch[1]}` : trimmed;
	const directRepoMatch = candidate.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u);
	if (directRepoMatch) {
		return `${directRepoMatch[1]}/${directRepoMatch[2]}`;
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(candidate);
	} catch {
		return null;
	}

	const hostname = parsedUrl.hostname.toLowerCase();
	if (hostname !== 'github.com' && hostname !== 'www.github.com') {
		return null;
	}

	const [owner, repoWithOptionalSuffix] = parsedUrl.pathname.split('/').filter(Boolean);
	const repo = repoWithOptionalSuffix?.replace(/\.git$/u, '');
	if (!owner || !repo) {
		return null;
	}

	return `${owner}/${repo}`;
}

function createRepoFileName(repo: string) {
	const [owner, name] = repo.split('/');
	if (!owner || !name) {
		throw new Error(`invalid repository slug: ${repo}`);
	}

	return `${owner.toLowerCase()}--${name.toLowerCase()}.json`;
}

function sortStrings(values: string[]) {
	return [...values].sort((left, right) => left.localeCompare(right));
}

function dedupeStrings(values: string[]) {
	return [...new Set(values)];
}

async function readTemplateRepos(templateDir: string) {
	const entries = await readdir(templateDir, { withFileTypes: true });
	const repos: string[] = [];

	for (const entry of entries.filter(isMdxFile).sort((left, right) => left.name.localeCompare(right.name))) {
		const source = await readFile(path.join(templateDir, entry.name), { encoding: 'utf8' });
		const frontmatter = parseFrontmatter(source);
		const { github: rawGithub } = frontmatter;
		if (typeof rawGithub !== 'string' || rawGithub.trim().length === 0) {
			continue;
		}

		const normalizedRepo = normalizeGithubRepo(rawGithub);
		if (!normalizedRepo) {
			console.warn(
				chalk.yellow(`warning: skipping non-GitHub template github field in ${entry.name}: ${rawGithub}`),
			);
			continue;
		}

		repos.push(normalizedRepo);
	}

	return repos;
}

async function fetchGitHubRepoMetadata(
	repo: string,
	apiBaseUrl: string,
	headers: Record<string, string>,
): Promise<FetchSuccess | FetchFailure> {
	const requestUrl = new URL(`repos/${repo}`, apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`);

	try {
		const response = await fetch(requestUrl, {
			headers,
		});
		if (!response.ok) {
			const errorBody = await response.text();
			let errorMessage = `${response.status} ${response.statusText}`;

			try {
				const parsed = JSON.parse(errorBody) as unknown;
				if (isRecord(parsed)) {
					const { message } = parsed;
					if (typeof message === 'string' && message.length > 0) {
						errorMessage = `${errorMessage}: ${message}`;
					}
				}
			} catch {
				if (errorBody.trim().length > 0) {
					errorMessage = `${errorMessage}: ${errorBody.trim()}`;
				}
			}

			return {
				reason: errorMessage,
				repo,
			};
		}

		const payload = (await response.json()) as unknown;
		return {
			fileName: createRepoFileName(repo),
			payload,
			repo,
		};
	} catch (error) {
		return {
			reason: error instanceof Error ? error.message : String(error),
			repo,
		};
	}
}

async function listExistingJsonFiles(outputDir: string) {
	if (!(await pathExists(outputDir))) {
		return [];
	}

	const entries = await readdir(outputDir, { withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));
}

async function writeSuccessPayloads(outputDir: string, results: FetchSuccess[]) {
	await mkdir(outputDir, { recursive: true });

	await Promise.all(
		results.map(async ({ fileName, payload }) => {
			const filePath = path.join(outputDir, fileName);
			const source = `${JSON.stringify(payload, null, '\t')}\n`;
			await writeFile(filePath, source, { encoding: 'utf8' });
		}),
	);
}

async function cleanupRemovedRepos(outputDir: string, targetFileNames: Set<string>) {
	const existingFiles = await listExistingJsonFiles(outputDir);
	const removedFiles: string[] = [];

	await Promise.all(
		existingFiles.map(async (fileName) => {
			if (targetFileNames.has(fileName)) {
				return;
			}

			await rm(path.join(outputDir, fileName), { force: true });
			removedFiles.push(fileName);
		}),
	);

	return sortStrings(removedFiles);
}

async function computeOutputHash(outputDir: string, repos: string[]) {
	const snapshot = await Promise.all(
		repos.map(async (repo) => {
			const filePath = path.join(outputDir, createRepoFileName(repo));
			if (!(await pathExists(filePath))) {
				return {
					missing: true,
					repo,
				};
			}

			const content = await readFile(filePath, { encoding: 'utf8' });
			return {
				payload: JSON.parse(content) as unknown,
				repo,
			};
		}),
	);

	return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

async function syncGitHubMetadata(metadataConfig: GitHubMetadataConfig) {
	const workspaceRoot = await getWorkspaceRoot();
	const configPath = path.join(workspaceRoot, 'config', 'github-metadata.json');
	const lockPath = path.join(workspaceRoot, 'config', 'github-metadata.lock.json');
	const templateDir = path.join(workspaceRoot, metadataConfig.templates_dir);
	const outputDir = path.join(workspaceRoot, metadataConfig.output_dir);

	const templateRepos = await readTemplateRepos(templateDir);
	const extraRepos = metadataConfig.extra_repos
		.map((repo) => {
			const normalizedRepo = normalizeGithubRepo(repo);
			if (normalizedRepo) {
				return normalizedRepo;
			}

			console.warn(chalk.yellow(`warning: skipping invalid extra_repos entry: ${repo}`));
			return null;
		})
		.filter((repo): repo is string => repo !== null);
	const excludedRepos = new Set(
		metadataConfig.exclude_repos
			.map((repo) => {
				const normalizedRepo = normalizeGithubRepo(repo);
				if (normalizedRepo) {
					return normalizedRepo;
				}

				console.warn(chalk.yellow(`warning: skipping invalid exclude_repos entry: ${repo}`));
				return null;
			})
			.filter((repo): repo is string => repo !== null),
	);
	const repos = sortStrings(
		dedupeStrings([...templateRepos, ...extraRepos]).filter((repo) => !excludedRepos.has(repo)),
	);

	const { GITHUB_TOKEN: githubToken } = process.env;
	if (!githubToken) {
		console.warn(
			chalk.yellow(
				'warning: GITHUB_TOKEN is not set, using unauthenticated GitHub API requests and may hit rate limits',
			),
		);
	}

	const headers = {
		Accept: 'application/vnd.github+json',
		'User-Agent': 'sealos-run-content-sync-github-metadata',
		'X-GitHub-Api-Version': '2022-11-28',
		...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}),
	} satisfies Record<string, string>;

	const results: Array<FetchSuccess | FetchFailure> = [];
	for (const repo of repos) {
		results.push(await fetchGitHubRepoMetadata(repo, metadataConfig.api_base_url, headers));
	}

	const succeeded = results.filter((result): result is FetchSuccess => 'payload' in result);
	const failed = results.filter((result): result is FetchFailure => 'reason' in result);

	await writeSuccessPayloads(outputDir, succeeded);
	const targetFileNames = new Set(repos.map((repo) => createRepoFileName(repo)));
	const removedFiles = await cleanupRemovedRepos(outputDir, targetFileNames);

	const lock = {
		config_hash: await computeConfigHash(configPath),
		hash: await computeOutputHash(outputDir, repos),
		updated_at: new Date().toISOString(),
	} satisfies GitHubMetadataLock;
	await writeGitHubMetadataLock(lockPath, lock);

	console.log(chalk.green(`resolved ${repos.length} repositories for GitHub metadata sync`));
	console.log(chalk.green(`updated ${succeeded.length} metadata files in ${outputDir}`));
	if (removedFiles.length > 0) {
		console.log(chalk.green(`removed ${removedFiles.length} stale metadata files`));
	}
	console.log(chalk.green(`lockfile updated at ${lockPath}`));

	if (failed.length > 0) {
		console.warn(chalk.yellow(`warning: failed to sync ${failed.length} repositories`));
		for (const failure of failed) {
			console.warn(chalk.yellow(`warning: ${failure.repo} -> ${failure.reason}`));
		}
	}
}

async function main() {
	await ensureGitEnvironment();
	await syncGitHubMetadata(config);
}

main().catch((error) => {
	console.error(chalk.red(error instanceof Error ? error.message : String(error)));
	process.exit(1);
});
