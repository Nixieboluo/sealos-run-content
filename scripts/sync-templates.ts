#!/usr/bin/env zx

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { $, chalk } from 'zx';

import templatesConfig from '../config/templates.json' with { type: 'json' };

type TemplatesConfig = {
	repo: string;
	branch: string;
};

type TemplatesLock = {
	config_hash: string;
	ref: string;
	hash: string;
	updated_at: string;
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
	try {
		await stat(`${target}/.git`);
		return true;
	} catch {
		return false;
	}
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

	const remoteUrl = (
		await $({ cwd: targetDir, quiet: true })`git remote get-url origin`
	).stdout.trim();
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
	const updatedAt = new Date().toISOString();

	return {
		config_hash: configHash,
		ref: `refs/heads/${config.branch}`,
		hash: commitHash,
		updated_at: updatedAt,
	} satisfies TemplatesLock;
}

async function writeTemplatesLock(lockPath: string, lock: TemplatesLock) {
	const lockContent = `${JSON.stringify(lock, null, '\t')}\n`;
	await writeFile(lockPath, lockContent, { encoding: 'utf8' });
}

async function syncTemplates({ repo, branch }: TemplatesConfig) {
	const workspaceRoot = await getWorkspaceRoot();
	const cloneBaseDir = `${workspaceRoot}/.local`;
	const cloneTargetDir = `${cloneBaseDir}/templates`;
	const configPath = `${workspaceRoot}/config/templates.json`;
	const lockPath = `${workspaceRoot}/config/templates.lock.json`;

	await mkdir(cloneBaseDir, { recursive: true });
	await syncCloneTarget(cloneTargetDir, repo, branch);

	const lock = await buildTemplatesLock(cloneTargetDir, configPath);
	await writeTemplatesLock(lockPath, lock);

	console.log(chalk.green(`templates synced to ${cloneTargetDir}`));
	console.log(chalk.green(`lockfile updated at ${lockPath}`));
}

async function main() {
	await ensureGitEnvironment();
	await syncTemplates(config);
}

main().catch((error) => {
	console.error(chalk.red(error instanceof Error ? error.message : String(error)));
	process.exit(1);
});
