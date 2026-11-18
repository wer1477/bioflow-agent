export class ConnectorRegistry {
  #connectors = new Map();

  register(connector) {
    if (this.#connectors.has(connector.id)) throw new Error(`Duplicate connector id: ${connector.id}`);
    this.#connectors.set(connector.id, connector);
    return this;
  }

  get(id) {
    return this.#connectors.get(id);
  }

  list({ domains } = {}) {
    return [...this.#connectors.values()]
      .filter((connector) => !domains?.length || domains.includes(connector.domain))
      .map(({ id, name, domain, description, homepage, downloadFormats, pagination, auth, parameters, record_id }) => ({
        id, name, domain, description, homepage,
        download_formats: downloadFormats,
        pagination,
        auth: auth || 'none',
        parameters: parameters || [],
        record_id,
      }));
  }

  resolve({ sources, domains } = {}) {
    if (sources?.length) return sources.map((source) => {
      const connector = this.get(source);
      if (!connector) throw new Error(`Unknown science connector: ${source}.`);
      return connector;
    });
    return [...this.#connectors.values()].filter((connector) => !domains?.length || domains.includes(connector.domain));
  }
}

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor(token, query, sources, limit) {
  if (!token) return { version: 2, query, limit, sources: Object.fromEntries(sources.map((source) => [source, { cursor: null, done: false }])) };
  let value;
  try {
    value = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid search cursor.');
  }
  if (value?.version !== 2 || value.query !== query || value.limit !== limit || !value.sources || typeof value.sources !== 'object') {
    throw new Error('Search cursor does not match this query or connector selection.');
  }
  const actual = Object.keys(value.sources).sort();
  const expected = [...sources].sort();
  if (actual.length !== expected.length || actual.some((source, index) => source !== expected[index])) {
    throw new Error('Search cursor does not match this query or connector selection.');
  }
  return value;
}
