const SECRET_KEY_PATTERN = /key|token|secret|password|authorization/i;
const ENVIRONMENT_REFERENCE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export function isEnvironmentReference(value: unknown): value is string {
  return typeof value === 'string' && ENVIRONMENT_REFERENCE_PATTERN.test(value.trim());
}

export function interpolateEnvironment(value: string, environment: NodeJS.ProcessEnv = process.env, source = 'Configuration'): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_placeholder, name: string) => {
    const resolved = environment[name];
    if (resolved === undefined) throw new Error(`${source} requires environment variable ${name}`);
    return resolved;
  });
}

export function assertSecretReferences(value: unknown, path = 'configuration'): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSecretReferences(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key) && typeof child === 'string' && child.trim() && !isEnvironmentReference(child)) {
      throw new Error(`${childPath} must use an environment variable reference such as \${BIOFLOW_LLM_API_KEY}.`);
    }
    assertSecretReferences(child, childPath);
  }
}

export function maskSecret(value: string): string {
  if (!value || ENVIRONMENT_REFERENCE_PATTERN.test(value.trim())) return value;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}
