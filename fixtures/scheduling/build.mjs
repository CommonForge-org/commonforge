import { mkdir, copyFile, writeFile } from 'node:fs/promises';
await mkdir('dist', { recursive: true });
await copyFile('worker.mjs', 'dist/worker.mjs');
await writeFile('dist/index.html', '<!doctype html><html lang="en"><title>Synthetic scheduling</title><h1>Synthetic scheduling</h1><p>Real local Git and Node runner preview; synthetic data only.</p></html>');
