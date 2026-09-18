import { execFileSync, execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

function fail(message) {
  console.error(message)
  process.exit(1)
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim()
}

function gitRun(args) {
  execFileSync('git', args, { stdio: 'inherit' })
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf8', ...opts }).trim()
}

function isAncestor(maybeAncestor, rev) {
  try {
    git(['merge-base', '--is-ancestor', maybeAncestor, rev])
    return true
  } catch {
    return false
  }
}

function pkg() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

function bumpVersion(kind) {
  const allowed = new Set(['patch', 'minor', 'major'])
  if (!allowed.has(kind)) fail(`Unknown bump "${kind}". Use patch, minor, or major.`)
  const current = pkg().version.split('.').map((n) => Number(n))
  if (current.length !== 3 || current.some((n) => !Number.isInteger(n))) {
    fail(`package.json version "${pkg().version}" is not X.Y.Z`)
  }
  if (kind === 'major') {
    current[0] += 1
    current[1] = 0
    current[2] = 0
  } else if (kind === 'minor') {
    current[1] += 1
    current[2] = 0
  } else {
    current[2] += 1
  }
  const next = current.join('.')
  const json = pkg()
  json.version = next
  writeFileSync(join(root, 'package.json'), `${JSON.stringify(json, null, 2)}\n`)
  return next
}

const bumpArg = process.argv.includes('--bump')
  ? process.argv[process.argv.indexOf('--bump') + 1]
  : null

const branch = git(['branch', '--show-current'])
if (branch !== 'develop') fail(`Release from develop only (current branch: ${branch}).`)

const dirty = git(['status', '--porcelain'])
if (dirty) fail('Working tree is not clean. Commit or stash first.')

try {
  gh(['auth', 'status'])
} catch {
  fail('gh is not authenticated. Run: gh auth login -p ssh')
}

gitRun(['fetch', 'origin', '--prune', '--tags'])

const head = git(['rev-parse', 'HEAD'])
const remoteDevelop = git(['rev-parse', 'origin/develop'])
if (head !== remoteDevelop) {
  const ahead = git(['rev-list', '--count', 'origin/develop..HEAD'])
  const behind = git(['rev-list', '--count', 'HEAD..origin/develop'])
  fail(`develop is not synced with origin/develop (ahead ${ahead}, behind ${behind}).`)
}

if (!isAncestor('origin/main', 'HEAD')) {
  console.log('Merging origin/main into develop so develop continues from main')
  gitRun(['merge', 'origin/main', '-m', 'Merge origin/main into develop'])
  gitRun(['push', 'origin', 'HEAD'])
}

let version = pkg().version
if (bumpArg) {
  version = bumpVersion(bumpArg)
  git(['add', 'package.json'])
  gitRun(['commit', '-m', `chore: release v${version}`])
  gitRun(['push', 'origin', 'HEAD'])
}

const tag = `v${version}`
const existing = execSync(`git ls-remote --tags origin ${tag}`, { encoding: 'utf8' }).trim()
if (existing) fail(`Tag ${tag} already exists on origin.`)

if (!isAncestor('origin/main', 'HEAD')) {
  fail('develop is still not a continuation of origin/main after merge.')
}

const title = `Release ${tag}`
const body = [
  '## Summary',
  `- Promote \`develop\` to \`main\` for **${tag}**.`,
  '- After merge, `develop` is fast-forwarded to `main` so both point at the same commit.',
  '- GitHub Actions will attach Windows (NSIS setup + portable) and Linux (AppImage + .deb) binaries to the GitHub Release.'
].join('\n')

let pr = ''
try {
  pr = gh(['pr', 'list', '--base', 'main', '--head', 'develop', '--json', 'url', '--jq', '.[0].url'])
} catch {
  pr = ''
}

if (!pr || pr === 'null') {
  pr = gh([
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    'develop',
    '--title',
    title,
    '--body',
    body
  ])
  console.log(`Opened ${pr}`)
} else {
  console.log(`Using existing PR ${pr}`)
}

execFileSync('gh', ['pr', 'merge', pr, '--merge', '--delete-branch=false'], { stdio: 'inherit' })

gitRun(['fetch', 'origin', 'main', 'develop', '--tags'])

const originMain = git(['rev-parse', 'origin/main'])
if (git(['rev-parse', 'HEAD']) !== originMain) {
  gitRun(['merge', '--ff-only', 'origin/main'])
  gitRun(['push', 'origin', 'HEAD:develop'])
}

try {
  git(['branch', '-f', 'main', 'origin/main'])
} catch {
  // local main may not exist
}

gitRun(['fetch', 'origin', 'main', 'develop'])
const tip = git(['rev-parse', 'HEAD'])
const finalMain = git(['rev-parse', 'origin/main'])
const finalDevelop = git(['rev-parse', 'origin/develop'])
if (tip !== finalMain || tip !== finalDevelop) {
  fail(`develop and main are not the same after release (HEAD ${tip}, origin/main ${finalMain}, origin/develop ${finalDevelop}).`)
}

gitRun(['tag', '-a', tag, tip, '-m', tag])
gitRun(['push', 'origin', tag])

console.log(`Tagged ${tag} at ${tip}`)
console.log(`origin/main and origin/develop are ${tip}`)
console.log(`Release: https://github.com/trasherdk/sieve-editor/releases/tag/${tag}`)
console.log('Binaries will appear on that release when the Release workflow finishes.')
