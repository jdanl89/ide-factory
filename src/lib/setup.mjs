import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readText, writeText } from './layout.mjs';
import { readPolicyVersion } from './principal.mjs';
import { validateCheckRegistry } from './verification-evidence.mjs';

const STACKS = [
  { id: 'dotnet', argv: ['dotnet', 'test'], match: hasDotnet },
  { id: 'node', argv: ['npm', 'test'], match: hasNodeTest },
  { id: 'python', argv: ['pytest'], match: hasPython },
  { id: 'go', argv: ['go', 'test', './...'], match: (files) => files.some((file) => file.name === 'go.mod') },
  { id: 'rust', argv: ['cargo', 'test'], match: (files) => files.some((file) => file.name === 'Cargo.toml') },
  { id: 'maven', argv: ['mvn', 'test'], match: (files) => files.some((file) => file.name === 'pom.xml') },
  { id: 'gradle', argv: ['gradle', 'test'], match: hasGradle },
  { id: 'ruby', argv: ['bundle', 'exec', 'rspec'], match: hasRspec },
  { id: 'php', argv: ['vendor/bin/phpunit'], match: hasPhpUnit },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', '.factory']);

/**
 * Recognized stacks in spec order. The first is the default `unit` kind.
 * @param {string} project
 */
export function detectStacks(project) {
  const files = listFiles(project);
  const found = STACKS.filter((stack) => stack.match(files));
  return found.map((stack, index) => ({
    id: stack.id,
    kind: index === 0 ? 'unit' : `unit-${stack.id}`,
    argv: [...stack.argv],
    defaultUnit: index === 0,
  }));
}

/**
 * @param {string} project
 * @returns {string[]}
 */
export function setupReadinessErrors(project) {
  const errors = [];
  if (!hasTestDecision(project)) errors.push('missing test decision');
  if (readPolicyVersion(project) >= 2 && !hasVerifier(project)) errors.push('missing principal verifier');
  return errors;
}

/**
 * Print-only detection, or a confirmed write of governance and check argv.
 * Writes nothing until every required answer is present and valid.
 *
 * @param {string} project
 * @param {{
 *   detectOnly?: boolean,
 *   governance?: string,
 *   maps?: { kind: string, argv: string[] }[],
 *   noTest?: boolean,
 *   verifierArgv?: string[],
 *   isTTY?: boolean,
 *   ask?: (question: string) => Promise<string>,
 * }} [options]
 */
export async function setupProject(project, options = {}) {
  if (options.detectOnly) {
    return { wrote: false, text: JSON.stringify({ proposals: detectStacks(project) }, null, 2) };
  }
  assertFactory(project);
  const answers = await resolveAnswers(project, options);
  const configPath = path.join(project, '.factory', 'config.json');
  const registryPath = path.join(project, '.factory', 'checks.json');
  const config = JSON.parse(readText(configPath));
  const registry = JSON.parse(readText(registryPath));
  if (!registry.checks || typeof registry.checks !== 'object' || Array.isArray(registry.checks)) {
    throw new Error('check registry must include a checks object');
  }

  const nextConfig = structuredClone(config);
  nextConfig.governance = { ...(nextConfig.governance || {}) };
  const nextChecks = { ...registry.checks };

  if (answers.noTest) {
    delete nextChecks.unit;
    nextConfig.governance.testDecision = 'none';
  } else {
    for (const map of answers.maps) {
      if (!map.kind || map.argv.some((part) => /\s/.test(part))) {
        throw new Error('setup rejects a shell command string; pass an argv array');
      }
      nextChecks[map.kind] = {
        argv: [...map.argv],
        cwdPolicy: 'project',
        timeoutMs: 120000,
        artifacts: [],
      };
    }
    delete nextConfig.governance.testDecision;
  }

  if (answers.governance === 'lightweight') {
    nextConfig.governance.policyVersion = 1;
    delete nextConfig.governance.principalVerifier;
  } else {
    nextConfig.governance.policyVersion = 2;
    nextConfig.governance.principalVerifier = {
      provider: 'local',
      timeoutMs: 5000,
      argv: [...answers.verifierArgv],
    };
  }

  validateCheckRegistry({ schemaVersion: registry.schemaVersion ?? 1, checks: nextChecks }, { projectRoot: project });
  writeText(registryPath, `${JSON.stringify({ ...registry, checks: nextChecks }, null, 2)}\n`);
  writeText(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  return { wrote: true, text: 'Recorded factory setup.' };
}

/**
 * Build maps from an ordered flag sequence. `--map` starts a kind; following
 * `--argv` values belong to it.
 * @param {{ key: string, value: string|boolean }[]} sequence
 */
export function mapsFromSequence(sequence) {
  const maps = [];
  let current = null;
  const verifierArgv = [];
  for (const token of sequence) {
    if (token.key === 'map') {
      current = { kind: String(token.value), argv: [] };
      maps.push(current);
    } else if (token.key === 'argv') {
      if (!current) throw new Error('setup --argv requires a preceding --map <kind>');
      current.argv.push(String(token.value));
    } else if (token.key === 'verifier-argv') {
      verifierArgv.push(String(token.value));
    }
  }
  return { maps, verifierArgv };
}

function assertFactory(project) {
  if (!fs.existsSync(path.join(project, '.factory', 'config.json'))
    || !fs.existsSync(path.join(project, '.factory', 'checks.json'))) {
    throw new Error('No .factory/ team state. Run idefactory init first.');
  }
}

async function resolveAnswers(project, options) {
  let governance = options.governance;
  let maps = options.maps ? options.maps.map((map) => ({ kind: map.kind, argv: [...map.argv] })) : [];
  let noTest = Boolean(options.noTest);
  let verifierArgv = options.verifierArgv ? [...options.verifierArgv] : [];
  const proposals = detectStacks(project);
  const needsPrompt = !governance || (!noTest && maps.length === 0) || (governance === 'strict' && verifierArgv.length === 0);
  if (needsPrompt) {
    if (!options.isTTY) {
      throw new Error(nonInteractiveMessage(proposals, { governance, maps, noTest, verifierArgv }));
    }
    const ask = options.ask || defaultAsk;
    if (!noTest && maps.length === 0) {
      const prompted = await promptForTests(proposals, ask);
      noTest = prompted.noTest;
      maps = prompted.maps;
    }
    if (!governance) {
      const answer = (await ask('Governance mode [lightweight]: ')).trim().toLowerCase();
      governance = answer || 'lightweight';
    }
    if (governance === 'strict' && verifierArgv.length === 0) {
      const answer = (await ask('Principal verifier command: ')).trim();
      verifierArgv = splitCommand(answer);
    }
  }
  if (governance !== 'lightweight' && governance !== 'strict') {
    throw new Error('setup --governance must be lightweight or strict');
  }
  if (noTest && maps.length > 0) {
    throw new Error('setup --no-test cannot be combined with --map');
  }
  if (!noTest && (maps.length === 0 || maps.some((map) => map.argv.length === 0))) {
    throw new Error(nonInteractiveMessage(proposals, { governance, maps, noTest, verifierArgv }));
  }
  if (governance === 'strict' && verifierArgv.length === 0) {
    throw new Error('strict governance requires a principal verifier argv');
  }
  if (!noTest && maps.some((map) => map.argv.some((part) => /\s/.test(part)))) {
    throw new Error('setup rejects a shell command string; pass an argv array');
  }
  return { governance, maps, noTest, verifierArgv };
}

async function promptForTests(proposals, ask) {
  if (proposals.length === 0) {
    const answer = (await ask('Test command (or none): ')).trim();
    if (!answer || answer.toLowerCase() === 'none') return { noTest: true, maps: [] };
    return { noTest: false, maps: [{ kind: 'unit', argv: splitCommand(answer) }] };
  }
  if (proposals.length === 1) {
    const shown = proposals[0].argv.join(' ');
    const answer = (await ask(`Test command [${shown}]: `)).trim();
    if (answer.toLowerCase() === 'none') return { noTest: true, maps: [] };
    const argv = answer ? splitCommand(answer) : [...proposals[0].argv];
    return { noTest: false, maps: [{ kind: 'unit', argv }] };
  }
  const ids = proposals.map((item) => item.id).join(', ');
  const keptAnswer = (await ask(`Keep stacks [${ids}] (blank = all): `)).trim();
  if (keptAnswer.toLowerCase() === 'none') return { noTest: true, maps: [] };
  const keptIds = keptAnswer
    ? keptAnswer.split(',').map((part) => part.trim()).filter(Boolean)
    : proposals.map((item) => item.id);
  const kept = proposals.filter((item) => keptIds.includes(item.id));
  if (kept.length === 0) throw new Error('setup requires at least one kept stack or an explicit no-test decision');
  let unitId = kept[0].id;
  if (kept.length > 1) {
    const named = (await ask(`Which stack is unit? [${unitId}]: `)).trim();
    if (named) unitId = named;
  }
  if (!kept.some((item) => item.id === unitId)) {
    throw new Error(`unit stack must be one of: ${kept.map((item) => item.id).join(', ')}`);
  }
  const maps = kept.map((item) => ({
    kind: item.id === unitId ? 'unit' : `unit-${item.id}`,
    argv: [...item.argv],
  }));
  return { noTest: false, maps };
}

function nonInteractiveMessage(proposals, answers) {
  const missing = [];
  if (!answers.governance) missing.push('governance mode');
  if (!answers.noTest && answers.maps.length === 0) missing.push('test command');
  if (answers.governance === 'strict' && answers.verifierArgv.length === 0) missing.push('principal verifier');
  const sample = proposals[0]
    ? `idefactory setup --governance lightweight --map unit --argv ${proposals[0].argv.join(' --argv ')}`
    : 'idefactory setup --governance lightweight --no-test';
  return `missing ${missing.join(' and ') || 'setup answers'}\n${sample}`;
}

function splitCommand(value) {
  return value.split(/\s+/).filter(Boolean);
}

async function defaultAsk(question) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function hasTestDecision(project) {
  const configPath = path.join(project, '.factory', 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(readText(configPath));
      if (config?.governance?.testDecision === 'none') return true;
    } catch {
      // fall through to the registry
    }
  }
  const registryPath = path.join(project, '.factory', 'checks.json');
  if (!fs.existsSync(registryPath)) return false;
  try {
    const registry = JSON.parse(readText(registryPath));
    return Object.values(registry?.checks || {}).some((entry) => Array.isArray(entry?.argv) && entry.argv.length > 0);
  } catch {
    return false;
  }
}

function hasVerifier(project) {
  const configPath = path.join(project, '.factory', 'config.json');
  if (!fs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(readText(configPath));
    const argv = config?.governance?.principalVerifier?.argv;
    return Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === 'string' && part.length > 0);
  } catch {
    return false;
  }
}

function listFiles(project) {
  const files = [];
  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push({ name: entry.name, full });
    }
  }
  if (fs.existsSync(project)) walk(project);
  return files;
}

function hasDotnet(files) {
  return files.some((file) => file.name.endsWith('.sln') || file.name.endsWith('.csproj'));
}

function hasNodeTest(files) {
  return files.some((file) => {
    if (file.name !== 'package.json') return false;
    try {
      const json = JSON.parse(fs.readFileSync(file.full, 'utf8'));
      return typeof json?.scripts?.test === 'string' && json.scripts.test.length > 0;
    } catch {
      return false;
    }
  });
}

function hasPython(files) {
  return files.some((file) => ['pyproject.toml', 'pytest.ini', 'tox.ini'].includes(file.name));
}

function hasGradle(files) {
  return files.some((file) => file.name === 'build.gradle' || file.name === 'build.gradle.kts');
}

function hasRspec(files) {
  return files.some((file) => {
    if (file.name !== 'Gemfile') return false;
    try {
      return /rspec/i.test(fs.readFileSync(file.full, 'utf8'));
    } catch {
      return false;
    }
  });
}

function hasPhpUnit(files) {
  return files.some((file) => {
    if (file.name !== 'composer.json') return false;
    try {
      const json = JSON.parse(fs.readFileSync(file.full, 'utf8'));
      const deps = { ...(json.require || {}), ...(json['require-dev'] || {}) };
      return Object.keys(deps).some((key) => key.toLowerCase() === 'phpunit/phpunit');
    } catch {
      return false;
    }
  });
}
