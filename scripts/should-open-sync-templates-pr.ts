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

async function main() {
	const result = await $({ quiet: true })`git status --porcelain`;
	const changedFiles = result.stdout
		.split('\n')
		.map((line) => line.slice(3).trim())
		.filter((file) => file.length > 0);
	const matchedAppstoreFiles = changedFiles.filter(
		(file) => file === 'content/appstore' || file.startsWith('content/appstore/'),
	);
	const otherChangedFiles = changedFiles.filter(
		(file) => file !== 'content/appstore' && !file.startsWith('content/appstore/'),
	);
	const matchedCount = matchedAppstoreFiles.length;
	const matchedSummary =
		matchedCount === 0 ? 'No content/appstore changes detected.' : matchedAppstoreFiles.join('\n');
	const otherChangedCount = otherChangedFiles.length;
	const otherChangedSummary =
		otherChangedCount === 0 ? 'No non-appstore changes detected.' : otherChangedFiles.join('\n');

	const shouldOpenPr = matchedCount > 0;

	await setGithubOutput('should_open_pr', shouldOpenPr ? 'true' : 'false');
	await setGithubOutput('matched_appstore_count', String(matchedCount));
	await setMultilineGithubOutput('matched_appstore_files', matchedSummary);
	await setGithubOutput('other_changed_count', String(otherChangedCount));
	await setMultilineGithubOutput('other_changed_files', otherChangedSummary);

	if (shouldOpenPr) {
		console.log('Detected changes in content/appstore. A PR will be created.');
		console.log(matchedAppstoreFiles.map((file) => `- ${file}`).join('\n'));
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

	console.log('Changes detected outside content/appstore only. Skipping PR creation.');
	console.log(otherChangedFiles.map((file) => `- ${file}`).join('\n'));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
