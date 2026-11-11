/**
 * Parse optional factory metadata and infer defaults for work items.
 */

export function parseFactoryBlock(markdown, taskId) {
  const lines = String(markdown || '').split(/\r?\n/);
  const checkbox = new RegExp(`^- \\[[^\\]]*\\]\\s+${escapeRegExp(taskId)}\\s+`);
  let i = 0;
  while (i < lines.length) {
    if (checkbox.test(lines[i])) break;
    i += 1;
  }
  if (i >= lines.length) return { factory: null, acceptanceCriteria: [] };

  const acceptanceCriteria = [];
  i += 1;
  while (i < lines.length && /^\s+-\s+/.test(lines[i]) && !/^\s+factory:\s*$/.test(lines[i])) {
    acceptanceCriteria.push(lines[i].replace(/^\s+-\s+/, '').trim());
    i += 1;
  }

  if (i >= lines.length || !/^\s*factory:\s*$/.test(lines[i])) {
    return { factory: null, acceptanceCriteria };
  }

  i += 1;
  const blockLines = [];
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    if (/^- \[[^\]]*\]\s+\d/.test(line)) break;
    if (/^#{1,6}\s/.test(line)) break;
    if (!/^\s+/.test(line)) break;
    blockLines.push(line);
    i += 1;
  }
  return { factory: parseSimpleYaml(blockLines.join('\n')), acceptanceCriteria };
}

export function classifyTask({ id, title, body = '', factory, routeDefault = null }) {
  const text = `${title}\n${body}`;
  const base = factory && typeof factory === 'object' ? { ...factory } : {};
  const kind = base.kind || inferKind(text);
  const risk = base.risk || inferRisk(text, kind);
  const roles = Array.isArray(base.roles) && base.roles.length
    ? base.roles
    : inferRoles(text, kind, risk);
  const checks = Array.isArray(base.checks) && base.checks.length
    ? base.checks
    : inferChecks(kind, risk);
  const modelProfile = base.modelProfile || inferModelProfile(roles);
  const securityProfile = base.securityProfile || (risk === 'high' || /security/i.test(text)
    ? 'security-sensitive'
    : 'dependency-basic');
  const verificationProfile = base.verificationProfile || inferVerificationProfile(kind, risk, checks);
  const dependencies = Array.isArray(base.dependencies)
    ? base.dependencies.map(String)
    : inferSequentialDependency(id);
  if (base.taskType !== undefined && base.taskType !== 'code' && base.taskType !== 'lightweight') {
    throw new Error(`factory.taskType must be code or lightweight, got ${base.taskType}`);
  }
  const taskType = base.taskType || (kind === 'docs' ? 'lightweight' : 'code');
  if (base.route !== undefined && base.route !== 'quick' && base.route !== 'full') {
    throw new Error(`factory.route must be quick or full, got ${base.route}`);
  }
  const route = base.route || routeDefault || 'full';
  let rolesOut = roles;
  let checksOut = checks;
  let securityOut = securityProfile;
  if (route === 'quick') {
    rolesOut = ['engineer', 'reviewer', 'scribe'];
    if (!base.securityProfile) securityOut = 'dependency-basic';
    if (!(Array.isArray(base.checks) && base.checks.length)) {
      checksOut = checks.filter((check) => !/security|sast|threat|secret|audit/i.test(check));
    }
  }

  return {
    kind,
    risk,
    roles: rolesOut,
    checks: checksOut,
    modelProfile,
    securityProfile: securityOut,
    verificationProfile,
    dependencies,
    taskType,
    route,
  };
}

export function defaultAcceptanceCriteria(title, explicit = []) {
  if (explicit.length) return explicit;
  const cleaned = String(title || '').trim() || 'the described behavior';
  return [`${cleaned} works as specified and is covered by the verification profile checks.`];
}

function inferKind(text) {
  if (/\b(architect|production architecture|production-architecture)\b/i.test(text)) return 'architecture';
  if (/\b(docs?|readme|documentation)\b/i.test(text)) return 'docs';
  if (/\b(playwright|e2e|accessibility|a11y|frontend|ui|react|vite)\b/i.test(text)) return 'frontend';
  if (/\b(api|backend|integration|contract)\b/i.test(text)) return 'backend';
  if (/\b(security|sast|threat|secret)\b/i.test(text)) return 'security';
  return 'general';
}

function inferRisk(text, kind) {
  if (kind === 'security' || /\b(auth|secret|payment|release|deploy)\b/i.test(text)) return 'high';
  if (kind === 'docs') return 'low';
  return 'medium';
}

function inferRoles(text, kind, risk) {
  if (kind === 'architecture') return ['architect', 'reviewer', 'scribe'];
  if (kind === 'docs') return ['engineer', 'reviewer', 'scribe'];
  if (kind === 'security' || risk === 'high') {
    return ['engineer', 'test-engineer', 'security-reviewer', 'reviewer', 'scribe'];
  }
  if (kind === 'frontend' && /\b(playwright|e2e|a11y|accessibility)\b/i.test(text)) {
    return ['engineer', 'test-engineer', 'reviewer', 'scribe'];
  }
  return ['engineer', 'reviewer', 'scribe'];
}

function inferChecks(kind, risk) {
  if (kind === 'docs') return ['docs'];
  if (kind === 'security' || risk === 'high') return ['unit', 'build', 'dependency-audit', 'threat-review'];
  if (kind === 'frontend') return ['unit', 'build'];
  if (kind === 'backend') return ['unit', 'integration'];
  return ['unit'];
}

function inferVerificationProfile(kind, risk, checks) {
  if (risk === 'high' || kind === 'security') return 'security-sensitive';
  if (kind === 'docs') return 'docs';
  if (kind === 'backend') return 'backend-api';
  if (checks.includes('playwright')) return 'frontend-interactive';
  if (kind === 'frontend') return 'frontend-low';
  return 'frontend-low';
}

function inferModelProfile(roles) {
  if (roles.includes('security-reviewer')) return 'security-strong';
  if (roles.includes('reviewer') && roles[0] === 'reviewer') return 'review-strong';
  return 'coding-standard';
}

function inferSequentialDependency(id) {
  const match = String(id).match(/^(\d+)\.(\d+)$/);
  if (!match) return [];
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (minor <= 1) return [];
  return [`${major}.${minor - 1}`];
}

function parseSimpleYaml(text) {
  const result = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    const match = line.match(/^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (!value) {
      result[key] = {};
      continue;
    }
    result[key] = parseYamlValue(value);
  }
  return result;
}

function parseYamlValue(value) {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
