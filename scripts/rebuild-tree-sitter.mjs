import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('node_modules/tree-sitter')) {
  const result = spawnSync(
    'npm',
    ['rebuild', 'tree-sitter', 'tree-sitter-javascript', 'tree-sitter-typescript'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        CXXFLAGS: withCpp20(process.env.CXXFLAGS),
      },
    },
  );

  if (result.error !== undefined) {
    process.stderr.write(`tree-sitter rebuild failed: ${result.error.message}\n`);
    process.exitCode = 1;
  } else if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

function withCpp20(value) {
  if (value?.includes('-std=c++20')) {
    return value;
  }
  return value === undefined || value.trim().length === 0 ? '-std=c++20' : `${value} -std=c++20`;
}
