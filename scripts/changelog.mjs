import { execFileSync } from 'node:child_process'

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function isPrereleaseTag(tag) {
  return /-(beta|rc)\.\d+$/.test(tag)
}

export function previousReleaseTag(current = '') {
  const tags = git(['tag', '-l', 'v*', '--sort=-v:refname'])
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
  const stableOnly = current !== '' && !isPrereleaseTag(current)
  return tags.find((t) => t !== current && (!stableOnly || !isPrereleaseTag(t))) || ''
}

export function buildReleaseNotes(tag = '', toRef = 'HEAD') {
  const prev = previousReleaseTag(tag)
  const range = prev ? `${prev}..${toRef}` : toRef
  let log = ''
  try {
    log = git(['log', '--no-merges', '--pretty=format:%s', range])
  } catch {
    log = git(['log', '--no-merges', '--pretty=format:%s', '-30'])
  }
  const items = log
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^chore: release v\d/i.test(s))
    .map((s) => `- ${s}`)
  const changes = items.length ? items.join('\n') : '- See the repository history for this release.'
  const title = tag ? `Sieve Editor ${tag}` : 'Changes'
  const compare = prev && tag ? `\n\nCompare: ${prev}...${tag}` : ''
  return `## ${title}\n\n${changes}${compare}\n`
}

const invoked = process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/changelog.mjs')
if (invoked) {
  const tag = process.argv[2] || ''
  const toRef = process.argv[3] || (tag || 'HEAD')
  process.stdout.write(buildReleaseNotes(tag, toRef))
}
