import { findSyntaxIssues } from '../src/shared/sieveSyntax.ts'

let failed = 0

function issues(source: string, caps?: string[] | null): string[] {
  return findSyntaxIssues(source, { capabilities: caps ?? null }).map((d) => d.message)
}

function ok(name: string, source: string, caps?: string[] | null): void {
  const got = findSyntaxIssues(source, { capabilities: caps ?? null })
  if (got.length) {
    failed++
    console.error(`FAIL ${name}\n${got.map((d) => `  L${d.line}: ${d.message}`).join('\n')}`)
  }
}

function has(name: string, source: string, needle: string, caps?: string[] | null): void {
  const got = issues(source, caps)
  if (!got.some((m) => m.includes(needle))) {
    failed++
    console.error(`FAIL ${name}\n  wanted: ${needle}\n  got: ${got.join(' | ') || '(none)'}`)
  }
}

ok('not and allof', 'if not allof (true, not false) { keep; }')
ok('empty', '')
ok('comments', '# hi\n/* block\n comment */\n')
ok(
  'basic',
  `require ["fileinto", "copy", "imap4flags", "envelope", "mailbox"];
if header :contains "Subject" "spam" {
  discard;
  stop;
} elsif envelope :is "from" "a@b.c" {
  redirect :copy "other@example.com";
} else {
  fileinto :create :flags "\\\\Seen" "INBOX";
}
`
)
ok(
  'size and vacation',
  `require ["vacation", "vacation-seconds", "relational", "comparator-i;ascii-numeric", "date"];
if size :over 1M {
  keep;
}
if currentdate :value "ge" :comparator "i;ascii-numeric" "hour" "18" {
  vacation :days 7 :seconds 3600 :subject "away" text:
I am away.
..still away
.
;
}
`
)
ok(
  'variables and editheader',
  `require ["variables", "editheader", "regex"];
set :lower :length "Name" "Value";
if string :matches "\${Name}" "*" {
  addheader :last "X-Name" "\${Name}";
  deleteheader :index 1 :last :contains "X-Old" "no";
}
`
)
ok(
  'ihave command enables extension',
  `require "ihave";
ihave ["fileinto", "copy"] {
  fileinto :copy "INBOX";
}
`
)
ok(
  'include and flags',
  `require ["include", "variables", "imap4flags"];
include :personal :once "lib";
global "counter";
setflag "flags" ["\\\\Seen", "\\\\Flagged"];
if hasflag :is "flags" "\\\\Seen" {
  keep :flags "\\\\Seen";
}
`
)
ok(
  'cyrus extras',
  `require ["snooze", "vnd.cyrus.log", "vnd.cyrus.jmapquery", "special-use", "mailboxid", "processcalendar", "ihave", "duplicate", "environment", "mailbox", "mboxmetadata"];
if jmapquery "{\\"from\\":\\"a@b.c\\"}" {
  log "matched";
  snooze :tzid "Europe/Copenhagen" :weekdays ["1", "2", "3", "4", "5"] "08:00:00";
}
if specialuse_exists "\\\\Inbox" "\\\\Junk" {
  keep;
}
if duplicate :seconds 3600 :header "Message-ID" {
  stop;
}
if environment :is "domain" "example.com" {
  processcalendar :allowpublic;
}
if mailboxexists "INBOX" {
  if metadata :contains "INBOX" "/private/comment" "x" {
    keep;
  }
}
`
)
ok('comparator always', 'require "comparator-i;octet";', [])
ok(
  'multiline and comments',
  `require "reject";
reject text:
No.
.
; # done
`
)

has('unknown command', 'foobar;', 'Unknown command "foobar"')
has('fileinto needs require', 'fileinto "INBOX";', 'requires "fileinto"')
has('missing string', 'require "fileinto";\nfileinto;', 'Expected a string')
has('string not list', 'require "fileinto";\nfileinto ["INBOX"];', 'found a list')
has('header args', 'if header "From" { keep; }', 'Expected a string list')
has('missing semicolon', 'keep', 'Missing semicolon')
has('else without if', 'else { keep; }', 'must follow')
has('require too late', 'keep;\nrequire "fileinto";', 'must come before')
has('require inside block', 'if true { require "fileinto"; }', 'must come before')
has('unclosed string', 'keep "oops;', 'Unclosed string')
has('bad escape', 'keep "\\n";', 'Undefined escape')
has('missing comma', 'require ["a" "b"];', 'Missing comma')
has('empty list', 'require [];', 'Empty string list')
has('test as command', 'header "A" "B";', 'is a test')
has('command as test', 'if keep { stop; }', 'is a command')
has('regex require', 'if header :regex "Subject" ".*" { keep; }', 'requires "regex"')
has('size tag', 'if size 5 { keep; }', 'Expected ":over" or ":under"')
has('duplicate match', 'if header :is :contains "A" "B" { keep; }', 'Duplicate match type')
has('case modifiers', 'require "variables";\nset :lower :upper "a" "b";', 'Duplicate case modifier')
has('last needs index', 'if header :last "A" "B" { keep; }', '":last" requires ":index"')
has('numeric comparator', 'if header :comparator "i;ascii-numeric" "A" "1" { keep; }', 'comparator-i;ascii-numeric')
has('unknown comparator', 'if header :comparator "i;foo" "A" "B" { keep; }', 'Unknown comparator')
has('server capability', 'require "nope";', 'not supported', ['fileinto'])
has('redirect list', 'redirect ["a@b.c", "c@d.e"];', 'vnd.cyrus.redirect-multiple')
has('hasflag variables', 'require "imap4flags";\nif hasflag "var" "\\\\Seen" { keep; }', 'requires "variables"')
has('ihave test does not enable', 'require "ihave";\nif ihave "fileinto" { fileinto "INBOX"; }', 'requires "fileinto"')
has('unknown tag', 'keep :copy;', 'Unknown tagged argument ":copy"')
has('tag after arg', 'require "fileinto";\nfileinto "INBOX" :create;', 'must come before')
has('unclosed block', 'if true { keep;', 'Missing "}"')
has('importance', 'require "enotify";\nnotify :importance "9" "mailto:a@b.c";', 'Importance must be')
has('empty test list', 'if allof () { keep; }', 'Expected a test in "allof"')
has('missing test comma', 'if anyof (true false) { keep; }', 'Missing comma in "anyof"')
const allof = findSyntaxIssues('if allof true { keep; }')
const allofHit = allof.find((d) => d.message.includes('allof'))
if (!allofHit || allofHit.syntax !== 'allof (test [, test]...)' || !allofHit.message.includes('Expected "(" after "allof"')) {
  failed++
  console.error(`FAIL allof syntax ${JSON.stringify(allof)}`)
}

const lines = findSyntaxIssues('keep;\nfileinto;\n')
const fileinto = lines.find((d) => d.message.includes('fileinto'))
if (!fileinto || fileinto.line !== 2) {
  failed++
  console.error(`FAIL line number ${JSON.stringify(lines)}`)
}

ok('valid with server caps', 'require ["fileinto"];\nfileinto "INBOX";', ['fileinto', 'envelope'])
has('unsupported require', 'require "envelope";', 'not supported', ['fileinto'])

if (failed) {
  console.error(`${failed} failed`)
  process.exit(1)
}
console.log('sieve syntax tests passed')
