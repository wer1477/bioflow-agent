import fs from 'node:fs/promises';
import path from 'node:path';
import { catalog, CliError, DOMAINS, download, fetchMany, planDownload, search } from './science.js';

const VERSION = '0.4.0';
const FORMATS = ['json'];
const commandDescriptions = {
  databases: 'List the installed science connector registry.',
  search: 'Search one or more science connectors and return normalized records.',
  fetch: 'Fetch one or more detailed records by connector source and record id.',
  download: 'Fetch a supported text or structured artifact and write it to an explicit path.',
};

const schemas = {
  CatalogPage: { type: 'object', required: ['schema_version', 'items', 'next_cursor'], properties: { schema_version: { const: 1 }, items: { type: 'array', items: { $ref: '#/schemas/Connector' } }, next_cursor: { type: ['string', 'null'], description: 'Numeric list cursor; pass unchanged to databases.' } } },
  Connector: { type: 'object', required: ['id', 'name', 'domain', 'description', 'download_formats', 'homepage', 'pagination', 'auth', 'parameters', 'record_id'], properties: { id: { type: 'string' }, name: { type: 'string' }, domain: { type: 'string', enum: DOMAINS }, description: { type: 'string' }, download_formats: { type: 'array', items: { type: 'string' } }, homepage: { type: 'string' }, pagination: { type: 'string', enum: ['offset', 'page', 'bounded'] }, auth: { type: 'string', enum: ['none', 'optional_api_key'] }, parameters: { type: 'array', items: { $ref: '#/schemas/Parameter' } }, record_id: { type: 'string' } } },
  Parameter: { type: 'object', required: ['name', 'type', 'description'], properties: { name: { type: 'string' }, type: { type: 'string' }, default: {}, enum: { type: 'array' }, secret: { type: 'boolean' }, description: { type: 'string' } } },
  SearchHit: { type: 'object', required: ['id', 'title', 'summary', 'url', 'extra'], properties: { id: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, url: { type: 'string' }, extra: { type: 'object', description: 'Source-specific normalized metadata; source and domain are always present.' } } },
  Issue: { type: 'object', required: ['source', 'code', 'message', 'retryable'], properties: { source: { type: 'string' }, id: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' }, retryable: { type: 'boolean' } } },
  SearchPage: { type: 'object', required: ['schema_version', 'items', 'next_cursor', 'issues'], properties: { schema_version: { const: 1 }, items: { type: 'array', items: { $ref: '#/schemas/SearchHit' } }, next_cursor: { type: ['string', 'null'], description: 'Opaque, versioned cursor. Reuse only with the same query, connector selection, and limit.' }, issues: { type: 'array', items: { $ref: '#/schemas/Issue' } } } },
  FetchItem: { type: 'object', required: ['id', 'status', 'record', 'field_status'], properties: { id: { type: 'string' }, status: { type: 'string', enum: ['ok', 'not_found', 'error'] }, record: { type: ['object', 'string', 'array', 'null'], description: 'Full source record, or a projection when --fields is used.' }, field_status: { type: 'object', additional_properties: { type: 'string', enum: ['available', 'unavailable'] } } } },
  FetchRecord: { type: 'object', required: ['schema_version', 'source', 'id', 'status', 'record', 'field_status'], properties: { schema_version: { const: 1 }, source: { type: 'string' }, id: { type: 'string' }, status: { type: 'string', enum: ['ok', 'not_found'] }, record: { type: ['object', 'string', 'array', 'null'] }, field_status: { type: 'object' } } },
  FetchPage: { type: 'object', required: ['schema_version', 'source', 'items', 'issues'], properties: { schema_version: { const: 1 }, source: { type: 'string' }, items: { type: 'array', items: { $ref: '#/schemas/FetchItem' } }, issues: { type: 'array', items: { $ref: '#/schemas/Issue' } } } },
  DownloadResult: { type: 'object', required: ['schema_version', 'planned', 'source', 'id', 'format', 'output'], properties: { schema_version: { const: 1 }, planned: { type: 'boolean' }, source: { type: 'string' }, id: { type: 'string' }, format: { type: 'string' }, output: { type: 'string' }, file_name: { type: 'string' }, mime_type: { type: 'string' }, bytes_written: { type: 'integer' }, url: { type: ['string', 'null'] } } },
  Error: { type: 'object', required: ['schema_version', 'error'], properties: { schema_version: { const: 1 }, error: { type: 'object', required: ['code', 'message', 'hint', 'retryable'], properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' }, retryable: { type: 'boolean' } } } } },
};

export const description = {
  schema_version: 1,
  name: 'science-search',
  version: VERSION,
  default_format: 'json',
  exit_codes: { '0': 'success', '1': 'upstream or system failure', '2': 'usage or input error' },
  commands: {
    databases: { description: commandDescriptions.databases, options: { domain: { type: 'string', enum: DOMAINS }, limit: { type: 'integer', default: 50, min: 1, max: 100 }, cursor: { type: 'string' } }, output: 'CatalogPage' },
    search: { description: commandDescriptions.search, selection_rule: 'Provide exactly one of --source, --domain, or --all. --all may contact every installed connector.', options: { query: { type: 'string', required: true }, source: { type: 'string[]', conflicts_with: ['domain', 'all'] }, domain: { type: 'string[]', enum: DOMAINS, conflicts_with: ['source', 'all'] }, all: { type: 'boolean', default: false, conflicts_with: ['source', 'domain'] }, limit: { type: 'integer', default: 10, min: 1, max: 100 }, cursor: { type: 'string' }, organism: { type: 'string' }, param: { type: 'key=value[]', connector_defined: true } }, output: 'SearchPage' },
    fetch: { description: commandDescriptions.fetch, selection_rule: 'Provide exactly one of --id or --ids. --id preserves the single-record envelope; --ids returns one item per requested id and preserves input order.', options: { source: { type: 'string', required: true }, id: { type: 'string', conflicts_with: ['ids'] }, ids: { type: 'string[]', conflicts_with: ['id'] }, fields: { type: 'string[]', description: 'Comma-separated source-record property paths to return. Missing fields are null and marked unavailable.' }, param: { type: 'key=value[]' } }, output: { one_of: ['FetchRecord', 'FetchPage'] } },
    download: { description: commandDescriptions.download, side_effects: 'Writes atomically only to the explicit --output path. Existing files require --force; --dry-run performs no request or write.', options: { source: { type: 'string', required: true }, id: { type: 'string', required: true }, format: { type: 'string' }, output: { type: 'path', required: true }, 'dry-run': { type: 'boolean', default: false }, force: { type: 'boolean', default: false }, 'accept-large': { type: 'boolean', default: false, description: 'Permit a response up to 250 MiB; otherwise requests are capped at 10 MiB.' }, param: { type: 'key=value[]' } }, output: 'DownloadResult' },
  },
  schemas,
  connectors: catalog,
};

function usage(command) {
  if (!command) return `Usage: science-search <command> [options]\n\n${Object.entries(commandDescriptions).map(([name, text]) => `  ${name.padEnd(10)} ${text}`).join('\n')}\n\nGlobal options:\n  --describe --format json   Print the machine-readable command registry\n  --version                  Print the CLI version\n  -h, --help                 Print help\n\nThis is a machine-first CLI: successful commands write one JSON document to stdout.`;
  const lines = {
    databases: 'Usage: science-search databases [--domain DOMAIN] [--limit N] [--cursor N] [--format json]',
    search: 'Usage: science-search search --query QUERY (--source ID[,ID] | --domain DOMAIN[,DOMAIN] | --all) [--limit N] [--cursor TOKEN] [--organism NAME] [--param KEY=VALUE] [--format json]',
    fetch: 'Usage: science-search fetch --source ID (--id RECORD_ID | --ids ID[,ID]) [--fields FIELD[,FIELD]] [--param KEY=VALUE] [--format json]',
    download: 'Usage: science-search download --source ID --id RECORD_ID --output PATH [--format ARTIFACT_FORMAT] [--param KEY=VALUE] [--dry-run] [--force] [--accept-large]',
  };
  return `${lines[command]}\n\n${commandDescriptions[command]}\n\nRun 'science-search --describe --format json' for the complete argument and output contract.`;
}

function parse(argv) {
  const command = argv[0]?.startsWith('-') ? undefined : argv[0];
  const raw = command ? argv.slice(1) : argv;
  const values = { _: [] };
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === '-h') { values.help = true; continue; }
    if (!token.startsWith('--')) { values._.push(token); continue; }
    const [key, inline] = token.slice(2).split('=', 2);
    if (key === 'help' || key === 'describe' || key === 'version' || key === 'dry-run' || key === 'force' || key === 'accept-large' || key === 'all') { if (inline !== undefined) throw new CliError('invalid-input', `--${key} does not take a value.`, 2); values[key] = true; continue; }
    const value = inline ?? raw[++index];
    if (!value || value.startsWith('--')) throw new CliError('missing-value', `--${key} requires a value.`, 2);
    if (key === 'param') (values.param ||= []).push(value);
    else if (values[key] !== undefined) throw new CliError('duplicate-option', `--${key} may be provided only once.`, 2);
    else values[key] = value;
  }
  return { command, values };
}

function requireOption(values, name) { if (!values[name]) throw new CliError('missing-input', `--${name} is required. Run 'science-search --help'.`, 2); return values[name]; }
function integer(values, name, fallback, max = 100) { const value = values[name] === undefined ? fallback : Number(values[name]); if (!Number.isInteger(value) || value < 1 || value > max) throw new CliError('invalid-input', `--${name} must be an integer from 1 to ${max}.`, 2); return value; }
function listCursor(values) { const value = values.cursor === undefined ? 0 : Number(values.cursor); if (!Number.isInteger(value) || value < 0) throw new CliError('invalid-input', '--cursor must be a non-negative integer.', 2); return value; }
function searchCursor(values) { if (values.cursor === undefined) return undefined; if (!values.cursor.trim()) throw new CliError('invalid-input', '--cursor must be a non-empty opaque token.', 2); return values.cursor; }
function list(values, name) { return values[name] ? values[name].split(',').map((value) => value.trim()).filter(Boolean) : undefined; }
function params(values) { const result = {}; for (const entry of values.param || []) { const divider = entry.indexOf('='); if (divider < 1) throw new CliError('invalid-input', '--param must be KEY=VALUE.', 2); result[entry.slice(0, divider)] = entry.slice(divider + 1); } return result; }
function validateFormat(values) { if (values.format && !FORMATS.includes(values.format)) throw new CliError('invalid-input', `--format must be one of ${FORMATS.join(', ')}.`, 2); }
function validateKnown(values, allowed) { for (const key of Object.keys(values)) if (key !== '_' && !allowed.includes(key)) throw new CliError('unknown-option', `--${key} is not supported by this command.`, 2); }
function page(items, limit, start) { const selected = items.slice(start, start + limit); return { schema_version: 1, items: selected, next_cursor: items.length > start + limit ? String(start + limit) : null }; }

export async function main(argv, io = process) {
  try {
    const { command, values } = parse(argv);
    if (values.version && !command) { io.stdout.write(`${VERSION}\n`); return 0; }
    if (values.describe && !command) { validateFormat(values); io.stdout.write(`${JSON.stringify(description)}\n`); return 0; }
    if (!command || values.help) { io.stdout.write(`${usage(command)}\n`); return 0; }
    if (!commandDescriptions[command]) throw new CliError('unknown-command', `Unknown command: ${command}. Run 'science-search --help'.`, 2);
    let output;
    if (command === 'databases') {
      validateFormat(values);
      validateKnown(values, ['domain', 'limit', 'cursor', 'format']); const domain = values.domain; if (domain && !DOMAINS.includes(domain)) throw new CliError('invalid-input', `--domain must be one of ${DOMAINS.join(', ')}.`, 2); output = page(catalog.filter((entry) => !domain || entry.domain === domain), integer(values, 'limit', 50), listCursor(values));
    } else if (command === 'search') {
      validateFormat(values);
      validateKnown(values, ['query', 'source', 'domain', 'all', 'limit', 'cursor', 'organism', 'param', 'format']); const sources = list(values, 'source'); const domains = list(values, 'domain'); if (domains?.some((domain) => !DOMAINS.includes(domain))) throw new CliError('invalid-input', `--domain must contain only: ${DOMAINS.join(', ')}.`, 2); if ([Boolean(sources?.length), Boolean(domains?.length), Boolean(values.all)].filter(Boolean).length !== 1) throw new CliError('missing-scope', 'search requires exactly one scope: --source, --domain, or --all.', 2); output = await search({ query: requireOption(values, 'query'), sources, domains, limit: integer(values, 'limit', 10), cursor: searchCursor(values), organism: values.organism, params: params(values) });
    } else if (command === 'fetch') {
      validateFormat(values);
      validateKnown(values, ['source', 'id', 'ids', 'fields', 'param', 'format']);
      if (Boolean(values.id) === Boolean(values.ids)) throw new CliError('missing-scope', 'fetch requires exactly one of --id or --ids.', 2);
      const source = requireOption(values, 'source');
      const ids = list(values, values.ids ? 'ids' : 'id');
      if (!ids?.length) throw new CliError('missing-input', 'fetch requires at least one non-empty record id.', 2);
      const fields = values.fields ? list(values, 'fields') : undefined;
      const result = await fetchMany(source, ids, { params: params(values), fields });
      if (values.id) {
        const item = result.items[0];
        if (item.status === 'error') {
          const issue = result.issues[0];
          throw new CliError(issue.code, issue.message, 1, { retryable: issue.retryable });
        }
        output = { schema_version: 1, source, id: item.id, status: item.status, record: item.record, field_status: item.field_status };
      } else output = result;
    } else {
      validateKnown(values, ['source', 'id', 'format', 'output', 'param', 'dry-run', 'force', 'accept-large']); const source = requireOption(values, 'source'); const id = requireOption(values, 'id'); const target = path.resolve(requireOption(values, 'output')); const plan = planDownload({ source, id, format: values.format }); if (values['dry-run']) output = { schema_version: 1, planned: true, ...plan, output: target, note: 'Validated the connector and format. No network request or file write was performed.' }; else { const artifact = await download({ source, id, format: values.format, params: params(values), acceptLarge: values['accept-large'] }); await writeArtifact(target, artifact.content, values.force); output = { schema_version: 1, planned: false, source: artifact.source, id: artifact.id, format: artifact.format, output: target, file_name: artifact.file_name, mime_type: artifact.mime_type, bytes_written: Buffer.byteLength(artifact.content), url: artifact.url || null }; }
    }
    io.stdout.write(`${JSON.stringify(output)}\n`); return 0;
  } catch (error) {
    const cliError = error instanceof CliError ? error : new CliError('internal', error instanceof Error ? error.message : String(error));
    io.stderr.write(`${JSON.stringify({ schema_version: 1, error: { code: cliError.code, message: cliError.message, hint: "run 'science-search --help'", retryable: Boolean(cliError.retryable) } })}\n`);
    return cliError.exitCode;
  }
}

async function writeArtifact(target, content, force) {
  try {
    await fs.access(target);
    if (!force) throw new CliError('output-exists', `Refusing to overwrite existing file: ${target}. Re-run with --force to replace it.`, 2);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.science-search-${process.pid}-${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}
