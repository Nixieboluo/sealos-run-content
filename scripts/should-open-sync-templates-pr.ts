#!/usr/bin/env tsx

import { appendFile } from 'node:fs/promises';

import { $ } from 'zx';

async function setGithubOutput(name: string, value: string) {
	const githubOutput = process.env['GITHUB_OUTPUT'];
	if (!githubOutput) {
		console.log(`${name}=${value}`);
		return;
	}

	await appendFile(githubOutput, `${name}=${value}\n`, { encoding: 'utf8' });
}

async function main() {
	const result = await $({ quiet: true })`git diff --name-only`;
	const changedFiles = result.stdout
		.split('\n')
		.map((file) => file.trim())
		.filter((file) => file.length > 0);

	const shouldOpenPr = changedFiles.some(
		(file) => file === 'content/appstore' || file.startsWith('content/appstore/'),
	);

	await setGithubOutput('should_open_pr', shouldOpenPr ? 'true' : 'false');

	if (shouldOpenPr) {
		console.log('Detected changes in content/appstore. A PR will be created.');
		return;
	}

	if (changedFiles.length === 0) {
		console.log('No repository changes detected. Skipping PR creation.');
		return;
	}

	console.log('Changes detected outside content/appstore only. Skipping PR creation.');
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
