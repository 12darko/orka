import * as path from 'node:path';
import type { Host } from '../host/Host';
import { IGNORED_DIRS } from '../tools/workspace';

export interface ProjectInfo {
  /** e.g. "Node.js (npm)", "Unity 6000.0.23f1", ".NET" */
  kinds: string[];
  /** Commands that verify the project, most useful first. */
  verifyCommands: string[];
  isGitRepo: boolean;
  fileTree: string;
}

const TREE_MAX_ENTRIES = 250;

/** Cheap, synchronous-feeling project detection from marker files - no LLM involved. */
export async function scanProject(host: Host): Promise<ProjectInfo> {
  const root = host.workspaceRoot;
  const has = (rel: string) => host.exists(path.join(root, rel));
  const kinds: string[] = [];
  const verify: string[] = [];
  let rootNames: string[] = [];
  try {
    rootNames = (await host.listDir(root)).map((e) => e.name);
  } catch {
    /* unreadable root */
  }

  if (await has('package.json')) {
    const pm = (await has('pnpm-lock.yaml')) ? 'pnpm' : (await has('yarn.lock')) ? 'yarn' : (await has('bun.lockb')) || (await has('bun.lock')) ? 'bun' : 'npm';
    kinds.push(`Node.js (${pm})`);
    try {
      const pkg = JSON.parse(await host.readFile(path.join(root, 'package.json')));
      const scripts: Record<string, string> = pkg.scripts ?? {};
      const run = pm === 'npm' ? 'npm run' : pm;
      for (const name of ['typecheck', 'build', 'lint', 'test']) {
        if (scripts[name]) verify.push(name === 'test' && pm === 'npm' ? 'npm test' : `${run} ${name}`);
      }
      if (!scripts.typecheck && (await has('tsconfig.json'))) verify.push('npx tsc --noEmit');
    } catch {
      /* malformed package.json */
    }
  }

  if ((await has('Assets')) && (await has('ProjectSettings/ProjectVersion.txt'))) {
    let version = '';
    try {
      const text = await host.readFile(path.join(root, 'ProjectSettings/ProjectVersion.txt'));
      version = /m_EditorVersion:\s*(\S+)/.exec(text)?.[1] ?? '';
    } catch {
      /* ignore */
    }
    kinds.push(`Unity${version ? ` ${version}` : ''}`);
    const sln = rootNames.find((n) => n.endsWith('.sln'));
    if (sln) verify.push(`dotnet build "${sln}" (compile check of the Unity-generated solution; the Unity Editor may also need to recompile)`);
  } else {
    const sln = rootNames.find((n) => n.endsWith('.sln'));
    const csproj = rootNames.find((n) => n.endsWith('.csproj'));
    if (sln || csproj) {
      kinds.push('.NET');
      verify.push('dotnet build', 'dotnet test');
    }
  }

  if (await has('Cargo.toml')) {
    kinds.push('Rust (cargo)');
    verify.push('cargo check', 'cargo test');
  }
  if (await has('go.mod')) {
    kinds.push('Go');
    verify.push('go build ./...', 'go test ./...');
  }
  if ((await has('pyproject.toml')) || (await has('requirements.txt')) || (await has('setup.py'))) {
    kinds.push('Python');
    verify.push('python -m pytest');
  }
  if (await has('pom.xml')) {
    kinds.push('Java (Maven)');
    verify.push('mvn -q compile', 'mvn -q test');
  }
  if ((await has('build.gradle')) || (await has('build.gradle.kts'))) {
    kinds.push('JVM (Gradle)');
    verify.push(host.platform === 'win32' ? '.\\gradlew.bat build' : './gradlew build');
  }
  if (await has('CMakeLists.txt')) {
    kinds.push('C/C++ (CMake)');
    verify.push('cmake --build build');
  }
  if (await has('pubspec.yaml')) {
    kinds.push('Dart/Flutter');
    verify.push('flutter analyze', 'flutter test');
  }

  return {
    kinds,
    verifyCommands: [...new Set(verify)],
    isGitRepo: await has('.git'),
    fileTree: await buildTree(host, root),
  };
}

async function buildTree(host: Host, root: string): Promise<string> {
  const lines: string[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number, indent: string) => {
    let entries;
    try {
      entries = await host.listDir(dir);
    } catch {
      return;
    }
    entries.sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    const files = entries.filter((e) => !e.isDirectory);
    for (const entry of entries) {
      if (lines.length >= TREE_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isDirectory) {
        if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.project-ai') continue;
        const skipped = IGNORED_DIRS.has(entry.name);
        lines.push(`${indent}${entry.name}/${skipped ? ' (generated/dependencies)' : ''}`);
        if (!skipped && depth < 3) await walk(path.join(dir, entry.name), depth + 1, `${indent}  `);
      } else if (depth < 3 || files.length <= 12) {
        // Deep folders with many files are summarized to keep the tree compact.
        lines.push(`${indent}${entry.name}`);
      }
    }
    if (depth >= 3 && files.length > 12) lines.push(`${indent}(${files.length} files)`);
  };
  await walk(root, 1, '');
  if (truncated) lines.push('... (tree truncated - use list_directory / search_files for more)');
  return lines.join('\n');
}
