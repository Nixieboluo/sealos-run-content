#!/usr/bin/env tsx

import { appendFile } from 'node:fs/promises';

import { $ } from 'zx';

async function setGithubOutput(name: string, value: string) {
	const { GITHUB_OUTPUT: githubOutput } = process.env;
	if (!githubOutput) {
		console.log(`${name}=${value}`);
		return;
	}

	await appendFile(githubOutput, `${name}=${value}\n`, { encoding: 'utf8' });
}

function quoteMultilineGithubOutput(name: string, value: string) {
	return `${name}<<EOF\n${value}\nEOF\n`;
}

async function setMultilineGithubOutput(name: string, value: string) {
	const { GITHUB_OUTPUT: githubOutput } = process.env;
	if (!githubOutput) {
		console.log(`${name}=${value}`);
		return;
	}

	await appendFile(githubOutput, quoteMultilineGithubOutput(name, value), {
		encoding: 'utf8',
	});
}

function isGitHubMetadataChange(file: string) {
	return (
		file === 'content/github-metadata' ||
		file.startsWith('content/github-metadata/') ||
		file === 'config/github-metadata.json' ||
		file === 'config/github-metadata.lock.json'
	);
}

async function main() {
	const result = await $({ quiet: true })`git status --porcelain`;
	const changedFiles = result.stdout
		.split('\n')
		.map((line) => line.slice(3).trim())
		.filter((file) => file.length > 0);
	const matchedMetadataFiles = changedFiles.filter((file) => isGitHubMetadataChange(file));
	const otherChangedFiles = changedFiles.filter((file) => !isGitHubMetadataChange(file));
	const matchedCount = matchedMetadataFiles.length;
	const matchedSummary =
		matchedCount === 0 ? 'No content/github-metadata changes detected.' : matchedMetadataFiles.join('\n');
	const otherChangedCount = otherChangedFiles.length;
	const otherChangedSummary =
		otherChangedCount === 0 ? 'No non-github-metadata changes detected.' : otherChangedFiles.join('\n');

	const shouldOpenPr = matchedCount > 0;

	await setGithubOutput('should_open_pr', shouldOpenPr ? 'true' : 'false');
	await setGithubOutput('matched_github_metadata_count', String(matchedCount));
	await setMultilineGithubOutput('matched_github_metadata_files', matchedSummary);
	await setGithubOutput('other_changed_count', String(otherChangedCount));
	await setMultilineGithubOutput('other_changed_files', otherChangedSummary);

	if (shouldOpenPr) {
		console.log('Detected changes in content/github-metadata. A PR will be created.');
		console.log(matchedMetadataFiles.map((file) => `- ${file}`).join('\n'));
		if (otherChangedCount > 0) {
			console.log('Other changed files included in this PR:');
			console.log(otherChangedFiles.map((file) => `- ${file}`).join('\n'));
		}
		return;
	}

	if (changedFiles.length === 0) {
		console.log('No repository changes detected. Skipping PR creation.');
		return;
	}

	console.log('Changes detected outside content/github-metadata only. Skipping PR creation.');
	console.log(otherChangedFiles.map((file) => `- ${file}`).join('\n'));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
