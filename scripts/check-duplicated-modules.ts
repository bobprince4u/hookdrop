import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as ts from 'typescript'

/**
 * Drift guard for the modules that are copied between workspaces on purpose.
 *
 * Several modules are duplicated across `apps/api`, `apps/ingestion` and `apps/worker`
 * because there is no way for one workspace to import another's `src/`: the root
 * `workspaces` array declares `packages/*`, but that directory does not exist, and each
 * service deploys independently with its own `npm install && npm run build`, so a shared
 * local package would have to be published or bundled before any of them could resolve it.
 *
 * The copies already say so in their own headers, and they already state the invariant this
 * script enforces — `plan.service.ts` puts it as "the exported surface is identical in all of
 * them, deliberately", and `url-guard.ts` goes as far as naming its check: "`diff` between
 * the two files is the drift check". Both sentences are the whole safety argument for the
 * duplication, and until now nothing ran that diff. A comment asserting an invariant is a
 * comment, not an invariant.
 *
 * What drift actually costs, per group:
 *
 *  - **`queue/contract.ts`** — queue names, the delivery and email payload shapes,
 *    `MAX_DELIVERY_ATTEMPTS`, the pg-boss schema name and the producer/consumer option sets.
 *    A producer that publishes to `delivery` while the consumer subscribes to `deliveries`
 *    fails silently: rows accumulate in a queue nothing reads, every webhook is accepted with
 *    a 200 and none is ever delivered. That is B-1 again, reintroduced from a typo, and no
 *    error appears anywhere.
 *  - **`services/plan.service.ts`** — what a plan entitles an account to. The ingestion
 *    service enforces the monthly quota and the per-minute rate from its copy; the worker
 *    deletes expired events from its copy. Two catalogues that disagree mean the worker
 *    deletes data the ingestion service believes it is still storing.
 *  - **`services/url-guard.ts`** — the SSRF blocklist and the address pinning behind it. The
 *    API validates a destination when it is written and the worker validates it again
 *    immediately before connecting; the second check is the one that actually protects
 *    anything. A range added to one copy and not the other reopens exactly the hole the
 *    other copy closed, and the deployment would look correct from either file alone.
 *  - **`entities/*.ts`** — the column mapping. Two services disagreeing about a column name,
 *    type or `select: false` produces wrong reads and wrong writes rather than an error:
 *    `Destination.secret` is the example that already caused a defect, since a copy without
 *    `select: false` hands the signing key to every query that touches the table.
 *
 * Only files that genuinely exist in more than one workspace are listed. `apps/api`'s
 * `ApiKey`, `Payment` and `RefreshToken` entities and the worker's `signature.service.ts`
 * have a single home each, so there is nothing to compare.
 *
 * Run with `npm run check:duplicates`. Exits non-zero on drift and names the files.
 */

const SERVICES = ['api', 'ingestion', 'worker'] as const

type Service = (typeof SERVICES)[number]

interface Group {
  readonly label: string
  /** Path under each `apps/<service>/src/`. */
  readonly relativePath: string
  /**
   * `exact` compares bytes; `semantic` compares the module with comments removed and
   * whitespace collapsed. See `normalise` below for how, and each group's `rationale` for
   * why it earns one mode rather than the other.
   */
  readonly mode: 'exact' | 'semantic'
  /** The workspaces that hold a copy. Not every module is in all three. */
  readonly services: readonly Service[]
  readonly rationale: string
}

/**
 * Entities are compared semantically for the same reason plan catalogues are: several carry a
 * per-service note about which reader in that service depends on them.
 */
const SHARED_ENTITIES = [
  'AiInsight',
  'Delivery',
  'Destination',
  'Endpoint',
  'Event',
  'User',
] as const

const GROUPS: readonly Group[] = [
  {
    label: 'queue contract',
    relativePath: 'queue/contract.ts',
    mode: 'exact',
    services: SERVICES,
    rationale:
      'The three copies are byte-identical today. Nothing about a queue name or a ' +
      'payload shape is service-specific, so there is no legitimate reason for even a ' +
      'comment to differ — and a comment that explains a shared contract is worth ' +
      'keeping in step with the contract.',
  },
  {
    label: 'plan catalogue',
    relativePath: 'services/plan.service.ts',
    mode: 'semantic',
    services: SERVICES,
    rationale:
      'The header docblocks differ on purpose: each one explains why that particular ' +
      'copy exists and which reader in that service depends on it. Byte equality would ' +
      'reject those, so the comparison is of code only.',
  },
  {
    label: 'SSRF url guard',
    relativePath: 'services/url-guard.ts',
    mode: 'semantic',
    services: ['api', 'worker'],
    rationale:
      'Two copies, not three — the ingestion service never dials a customer destination. ' +
      'The worker calls itself the authoritative one and the API note says so too, which ' +
      'is exactly the wording that let both layers end up empty once before, each ' +
      'deferring to the other. Code equality is the check; the headers differ on purpose.',
  },
  ...SHARED_ENTITIES.map(
    (name): Group => ({
      label: `entity ${name}`,
      relativePath: `entities/${name}.ts`,
      mode: 'semantic',
      services: SERVICES,
      rationale:
        'Column mappings must agree or one service reads and writes a different table ' +
        'than the other believes it is using. Compared as code, since the copies carry ' +
        'per-service notes.',
    })
  ),
]

const repoRoot = path.resolve(__dirname, '..')

const filePathFor = (service: string, group: Group): string =>
  path.join(repoRoot, 'apps', service, 'src', group.relativePath)

/**
 * Normalises a module to the part that must not drift.
 *
 * `transpileModule` is the TypeScript compiler's own printer, so comments are removed by a
 * real parser rather than by a regular expression that would mistake a `//` inside a string
 * literal for the start of one. It does, however, preserve the source's line breaks inside
 * expressions — the API's copy of `plan.service.ts` wraps one ternary that the other two fit
 * on a single line — so runs of whitespace are collapsed afterwards.
 *
 * That collapse also flattens multi-space runs inside string literals. Nothing in these
 * groups has one, and a plan name that differed only by internal spacing is not the class of
 * drift this guard exists to catch.
 *
 * `experimentalDecorators` is set because the entity files are decorator-based TypeORM
 * mappings and would not otherwise parse the way the services compile them.
 */
const normalise = (source: string): string =>
  ts
    .transpileModule(source, {
      compilerOptions: {
        removeComments: true,
        experimentalDecorators: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    })
    .outputText.replace(/\s+/g, ' ')
    .trim()

const digest = (value: string): string =>
  crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)

interface Reading {
  readonly service: string
  readonly file: string
  readonly hash: string
}

/** Anything that makes the group uncheckable is a failure, not a skip. */
const read = (service: Service, group: Group): Reading | string => {
  const file = filePathFor(service, group)
  if (!fs.existsSync(file)) {
    return `  missing: apps/${service}/src/${group.relativePath}`
  }
  const source = fs.readFileSync(file, 'utf8')
  return {
    service,
    file: path.relative(repoRoot, file),
    hash: digest(group.mode === 'exact' ? source : normalise(source)),
  }
}

const compare = (group: Group): string[] => {
  const readings: Reading[] = []
  const problems: string[] = []

  for (const service of group.services) {
    const result = read(service, group)
    if (typeof result === 'string') problems.push(result)
    else readings.push(result)
  }

  if (problems.length > 0) return problems
  if (readings.length < 2) return problems

  // The first service listed is the reference only so that the report has one; none of the
  // copies is more authoritative than the others.
  const [reference, ...rest] = readings as [Reading, ...Reading[]]
  const diverged = rest.filter((reading) => reading.hash !== reference.hash)
  if (diverged.length === 0) return []

  return [
    ...readings.map(
      (reading) =>
        `  ${reading.file}  ${reading.hash}` +
        (reading.hash === reference.hash ? '' : '  <-- differs')
    ),
    '',
    `  ${group.rationale}`,
    '',
    `  Compare them with:  diff ${reference.file} ${diverged[0].file}`,
  ]
}

const main = (): void => {
  const failures: string[] = []

  for (const group of GROUPS) {
    const problems = compare(group)
    if (problems.length === 0) {
      console.log(
        `ok    ${group.label.padEnd(18)} ${group.mode.padEnd(8)} ` +
          `${group.services.length} copies agree`
      )
      continue
    }
    failures.push(`drift ${group.label} (${group.mode}):`, ...problems)
  }

  if (failures.length > 0) {
    console.error('')
    console.error(failures.join('\n'))
    console.error(
      '\nThese modules are copied between workspaces on purpose. A change to one is a ' +
        'change to all three.'
    )
    process.exit(1)
  }
}

main()
