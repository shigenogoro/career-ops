#!/usr/bin/env node
/**
 * gmail-application-scan.mjs — recover applications from confirmation email.
 *
 * THE PROBLEM. The tracker knows about ~14 applications; Kyle has submitted 400+
 * across LinkedIn, Handshake, Jobright, and company portals. Without those rows
 * there is no denominator, so no channel ever gets a measured conversion rate --
 * which is the one number that should be steering where the effort goes.
 *
 * WHY EMAIL BEATS THE LINKEDIN EXPORT. A LinkedIn data export covers only what
 * was submitted through LinkedIn. Confirmation email covers EVERY channel,
 * because every ATS sends one. It is the only source that sees the whole funnel.
 *
 * SIBLING, NOT A FLAG ON gmail-reply-scan.mjs. The two scanners want opposite
 * sender rules and produce different artifacts:
 *
 *              gmail-reply-scan.mjs          gmail-application-scan.mjs
 *   wants      employer REPLIES              application CONFIRMATIONS
 *   linkedin   noise, dropped                PRIMARY source ("Your application
 *                                            to <role> at <company>")
 *   output     data/reply-candidates.json    batch/tracker-additions/*.tsv
 *   consumer   reply-watch.mjs               merge-tracker.mjs
 *
 * Folding them into one script would mean a mode flag that inverts the sender
 * list, the parser, and the output format -- two scripts wearing a trench coat.
 *
 * WHAT A CONFIRMATION CAN AND CANNOT TELL US. It carries company, role, date,
 * and the ATS it came from. It does NOT carry the posting URL (most templates
 * omit it), a fit score, or which resume variant went out. So rows land as
 * `Applied` with an empty score and a note naming the source. That is the point:
 * this is STATE COVERAGE, not evaluation. Nothing here is a fit signal, and
 * nothing here may become one -- Blocks A-F own scoring (see AGENTS.md,
 * Source-of-Truth Boundary).
 *
 * PARSING IS BEST-EFFORT AND SAYS SO. Subject lines are free text. Every row is
 * emitted with a `confidence` column; anything below `high` is written to a
 * separate review TSV instead of the merge directory, so a mis-parsed company
 * name never silently becomes a tracker row. merge-tracker.mjs still dedups
 * against what is already there, so re-runs are safe.
 *
 * Usage:
 *   node scripts/gmail-application-scan.mjs <dump.json> [--dry-run]
 *   node scripts/gmail-application-scan.mjs --stdin [--dry-run]
 *   node scripts/gmail-application-scan.mjs --queries     # Gmail queries to run
 *   node scripts/gmail-application-scan.mjs --self-test
 *
 * Output:
 *   batch/tracker-additions/gmail-backfill-<date>.tsv        (confidence: high)
 *   batch/tracker-additions/review-gmail-<date>.tsv          (needs eyes; NOT merged)
 *
 * Then: node merge-tracker.mjs --dry-run   (always dry-run a backfill first)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(__dirname);
const ADDITIONS_DIR = join(CAREER_OPS, 'batch', 'tracker-additions');
// Low-confidence rows land OUTSIDE the additions dir so a stray
// `merge-tracker.mjs` run can never pick them up unreviewed.
const REVIEW_DIR = join(CAREER_OPS, 'batch', 'review');

export const QUERIES = [
  {
    name: 'linkedin-applications',
    q: 'from:jobs-noreply@linkedin.com subject:"your application to" newer_than:{DAYS}d',
  },
  {
    name: 'ats-confirmations',
    q: '{"thank you for applying" "we have received your application" '
      + '"application received" "thanks for applying" "successfully submitted"} '
      + 'newer_than:{DAYS}d -in:sent -in:draft',
  },
];

// Senders that emit application-shaped mail that is NOT an application of
// Kyle's: job-board digests, gig platforms, agency blasts, course admissions.
export const NOISE_SENDERS = [
  'noreply@glassdoor.com',
  'no-reply@leetcode.com',
  'no-reply@hackerrankmail.com',
  'mail.beehiiv.com',
  'thebatch@deeplearning.ai',
  'notify.mindrift.ai',
  'ceipalmail.com',
  'jobcopilot.io',        // auto-apply bot service, not an employer
  'admissions@codepath.org',
  'vswep@codepath.org',
  'hello@scale.jobs',
  'mail.remotehunter.com',
  'notification@mailsuite.com',
  'noreply-accounts@google.com',
  'no-reply@email.claude.com',
  'teamworkonline.com',
];

// Staffing agencies and job-board intermediaries. These ARE real applications,
// but they are not applications to a named employer -- the end client is
// unknown. They get confidence 'low' and land in the review file, because a
// tracker row saying "Motion Recruitment" measures nothing.
export const AGENCY_MARKERS = [
  'recruiting from scratch', 'motion recruitment', 'rise technical',
  'jla resourcing', 'workerbee', 'crossing hurdles', 'talent software services',
  'robert half', 'insight global', 'teksystems', 'apex systems', 'cybercoders',
  // Seen in volume in this inbox, Aug 2026 -- almost the whole LinkedIn Easy
  // Apply stream went to firms like these rather than to named employers.
  'career movement', 'avp vigilant', 'alexander chapman', 'overture partners',
  'bayone', 'idexcel', 'clifyx', 'shakti solutions', 'gtn technical',
  'infosoft', 'nexnovels', 'digivance', 'morgan pinnacle', 'techdoquest',
  'next step systems', 'h3 technologies',
  'synechron', 'mindlance', 'phaxis', 'beacon hill', 'emonics', 'photon',
  'brickred', 'sperton', 'git america', 'resolution technologies',
  'infinite computer', 'employia', '360 ide', 'christian & timbers',
  'swakio', 'talent software', 'crossing hurdles',
];

/**
 * Subject-line shapes, most specific first. Each returns { company, role }.
 * Only patterns that pin BOTH fields unambiguously earn `high`.
 */
const PATTERNS = [
  {
    // LinkedIn: "Your application to <role> at <company>"
    re: /^your application to\s+(.+?)\s+at\s+(.+?)\s*$/i,
    take: (m) => ({ role: m[1], company: m[2] }),
    confidence: 'high',
  },
  {
    // LinkedIn Easy Apply, the highest-volume shape in this inbox:
    // "<FirstName>, your application was sent to <company>". The name prefix is
    // why an anchored /^your application/ missed all ~200 of them.
    // Company only -- the role lives in the body (see linkedinBody()).
    re: /^(?:.+?,\s+)?your application was sent to\s+(.+?)\s*$/i,
    take: (m) => ({ company: m[1], role: '' }),
    confidence: 'high',
  },
  {
    // SmartRecruiters: "Your Application for <role> at <company>"
    re: /^your application for\s+(.+?)\s+at\s+(.+?)\s*$/i,
    take: (m) => ({ role: m[1], company: m[2] }),
    confidence: 'high',
  },
  {
    // Dice: "Application for <role> at <company> sent"
    re: /^application for\s+(.+?)\s+at\s+(.+?)\s+sent\s*$/i,
    take: (m) => ({ role: m[1], company: m[2] }),
    confidence: 'high',
  },
  {
    // firststage / Greenhouse: "Application submitted for <role> at <company>"
    re: /^application submitted for\s+(.+?)\s+at\s+(.+?)\s*$/i,
    take: (m) => ({ role: m[1], company: m[2] }),
    confidence: 'high',
  },
  {
    // iCIMS: "Thank you for applying at <company>" -- `at`, not `to`.
    re: /^(?:thank you|thanks)\s+for\s+applying\s+at\s+(.+?)[!.,]?\s*$/i,
    take: (m) => ({ company: m[1], role: '' }),
    confidence: 'medium',
  },
  {
    // "Thank you for applying to <company>" / "Thanks for applying to <company>"
    re: /^(?:thank you|thanks)\s+for\s+applying\s+to\s+(.+?)[!.]?\s*$/i,
    take: (m) => ({ company: m[1], role: '' }),
    confidence: 'medium',   // company only -- role must come from the body
  },
  {
    // "<Company> - Application Update" / "<Company> Application Status"
    re: /^(.+?)\s*[-|]\s*application\s+(?:update|status|received)\s*$/i,
    take: (m) => ({ company: m[1], role: '' }),
    confidence: 'medium',
  },
];

// Domain -> company, for the many templates whose subject names no company.
// ATS hosts are deliberately absent: greenhouse/ashby/lever/workday say nothing
// about WHICH employer, so those fall through to body parsing or review.
const ATS_HOSTS = [
  'greenhouse-mail.io', 'greenhouse.io', 'ashbyhq.com', 'hire.lever.co',
  'myworkday.com', 'icims.com', 'gem.com', 'workablemail.com',
  'smartrecruiters.com', 'jobvite.com', 'taleo.net', 'successfactors.com',
  'firststage.co', 'avature.net', 'mystaffingpro.com', 'scalis.ai',
  'crelate.net', 'ats.rippling.com', 'kula.ai',
];

export function isNoiseSender(sender) {
  const s = (sender || '').toLowerCase();
  return !!s && NOISE_SENDERS.some((n) => s.includes(n));
}

export function isAgency(text) {
  const t = (text || '').toLowerCase();
  return AGENCY_MARKERS.some((a) => t.includes(a));
}

/** Company from the sender domain, when the domain IS the employer. */
// Multi-tenant ATS hosts where the LOCAL PART is the employer's tenant name:
// amgen@myworkday.com, adobe@myworkday.com, kyndryl@myworkday.com. Workday is
// the single biggest source of confirmation mail in this inbox, and treating it
// as an anonymous ATS host threw every one of those applications away.
const TENANT_HOSTS = ['myworkday.com', 'icims.com', 'avature.net'];

const TENANT_LOCAL_NOISE = new Set([
  'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications',
  'notification', 'careers', 'jobs', 'talent', 'recruiting', 'hr', 'apply',
]);

export function companyFromSender(sender) {
  const m = (sender || '').match(/@([\w.-]+)/);
  if (!m) return null;
  const host = m[1].toLowerCase();

  if (TENANT_HOSTS.some((h) => host.endsWith(h))) {
    const local = (sender.split('@')[0] || '').toLowerCase().replace(/\+.*$/, '');
    if (!local || TENANT_LOCAL_NOISE.has(local) || local.length < 2) return null;
    return local.charAt(0).toUpperCase() + local.slice(1);
  }

  if (ATS_HOSTS.some((h) => host.endsWith(h))) return null;

  const parts = host.split('.').filter((p) => !['com', 'org', 'net', 'io', 'ai', 'co', 'jobs', 'careers'].includes(p));
  // Strip common mail subdomains so "noreply@mail.amazon.jobs" -> amazon.
  const meaningful = parts.filter((p) => !['mail', 'noreply', 'no-reply', 'email', 'smtp', 'talent', 'notifications', 'apply', 'my'].includes(p));
  const name = meaningful[meaningful.length - 1] || parts[parts.length - 1];
  if (!name || name.length < 2) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * LinkedIn confirmation bodies lead with the applied job, as:
 *
 *   Your application was sent to <Company>
 *   <role>
 *   <company short name>
 *   <location>
 *   View job: https://...
 *
 * TRUNCATION IS NOT OPTIONAL. Further down, the same mail lists "View similar
 * jobs you may be interested in" with three MORE role/company/location triples.
 * Parsing past that point invents applications the user never made -- so the
 * body is cut at the recommendations block before anything is read.
 */
export function linkedinBody(body) {
  if (!body) return null;
  const cut = body.search(/take these next steps|View similar jobs|jobs you may be interested/i);
  const head = cut === -1 ? body : body.slice(0, cut);
  const lines = head.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => /^your application was sent to/i.test(l));
  if (i === -1 || !lines[i + 1]) return null;
  const url = (head.match(/https:\/\/www\.linkedin\.com\/comm\/jobs\/view\/(\d+)/) || [])[1];
  return {
    role: lines[i + 1],
    location: lines[i + 3] && !/^View job/i.test(lines[i + 3]) ? lines[i + 3] : '',
    url: url ? `https://www.linkedin.com/jobs/view/${url}` : '',
  };
}

/** Pull "the <role> role/position" out of a confirmation body. */
export function roleFromBody(body) {
  if (!body) return '';
  // Word chars a job title may contain. Kept in one place so every pattern
  // below agrees -- req IDs (`(ID: 10515912)`, `20031813_2026-08-17`) and
  // punctuated titles (`Software Engineer, NLP/Machine Learning`) must survive.
  const T = String.raw`[A-Z][\w/&,\-().:#]*(?:\s+[\w/&,\-().:#]+){0,8}?`;
  const patterns = [
    // "...applying for the <role> role/position/opening/opportunity/job"
    // `job` matters: Workable's template says "for the Software Engineer job".
    String.raw`(?:applying|application)\s+(?:for|to)\s+(?:the\s+|our\s+)?(${T})\s+(?:role|position|opening|opportunity|job)`,
    // "...interest in the/our <role> role/position/opportunity". The article is
    // REQUIRED: without it this swallowed the company name and an intervening
    // clause, turning Sirona's "interest in Sirona Medical and our Software
    // Engineer - Hamilton, OH opportunity" into a role of the whole span.
    String.raw`interest\s+in\s+(?:the|our)\s+(${T})\s+(?:role|position|opportunity)`,
    // Workday: "...application for the position of <role>"
    String.raw`(?:position|role)\s+of\s+(${T})(?:\s+and\s|[.,!]|$)`,
    // "Your application for <role> has been received / is currently being..."
    String.raw`application\s+for\s+(${T})\s+(?:has been|is currently|was)`,
    // IBM: "...applying to the role of <role> - <reqid> at <company>"
    String.raw`applying\s+to\s+the\s+role\s+of\s+(${T})\s+(?:-|at)\s`,
    // "We received your application for <role>." (terminal punctuation)
    String.raw`received\s+your\s+application\s+for\s+(${T})[.!]`,
    // "...for considering <role> with <company>"
    String.raw`considering\s+(${T})\s+with\s`,
    // "...submission to the following position: <reqid> <role> (Open)"
    String.raw`following\s+position:\s+(?:[\w-]+\s+)?(${T})\s*(?:\(Open\)|[.,!]|$)`,
  ].map((src) => new RegExp(src));
  for (const re of patterns) {
    const m = body.match(re);
    if (m) return m[1].replace(/\s+/g, ' ').trim();
  }
  return '';
}

export function cleanField(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\t\n\r]/g, ' ')
    .replace(/\s*[-–—|]\s*$/, '')
    .trim();
}

export function parseMessage(msg) {
  const sender = msg.sender || msg.from || '';
  const subject = cleanField(msg.subject || '');
  const body = msg.snippet || msg.body_snippet || '';
  const date = (msg.date || '').slice(0, 10);

  let company = '';
  let role = '';
  let confidence = 'low';

  for (const p of PATTERNS) {
    const m = subject.match(p.re);
    if (!m) continue;
    const got = p.take(m);
    company = cleanField(got.company);
    role = cleanField(got.role);
    confidence = p.confidence;
    break;
  }

  if (!company) {
    const fromDomain = companyFromSender(sender);
    if (fromDomain) { company = fromDomain; confidence = 'medium'; }
  }
  if (!role && /linkedin.com/i.test(sender)) {
    const li = linkedinBody(body);
    if (li && li.role) { role = cleanField(li.role); confidence = 'high'; }
  }
  if (!role) {
    role = cleanField(roleFromBody(body));
    // Subject gave the company, body gave the role -> both pinned.
    if (role && confidence === 'medium') confidence = 'high';
  }

  if (!company) return null;
  if (isAgency(`${company} ${subject} ${body}`)) confidence = 'low';
  if (!role) role = '(role unparsed)';

  return { company, role, date, sender, subject, confidence };
}

export function extractApplications(raw) {
  const responses = Array.isArray(raw) ? raw : [raw];
  const threads = [];
  for (const r of responses) {
    if (!r) continue;
    if (Array.isArray(r.threads)) threads.push(...r.threads);
    else if (Array.isArray(r.messages)) threads.push(r);
    else if (Array.isArray(r)) threads.push(...r);
  }

  const out = [];
  const seenMsg = new Set();
  const seenApp = new Set();

  for (const thread of threads) {
    for (const msg of thread.messages || []) {
      const labels = msg.labelIds || [];
      if (labels.includes('SENT') || labels.includes('DRAFT')) continue;

      const id = msg.id || msg.messageId;
      if (!id || seenMsg.has(id)) continue;
      seenMsg.add(id);

      if (isNoiseSender(msg.sender || msg.from)) continue;

      const parsed = parseMessage(msg);
      if (!parsed) continue;

      // One row per company+role, keeping the EARLIEST date -- that is the
      // application. Later mail on the same req is a status change, and status
      // is reply-watch.mjs's job, not this script's.
      const key = parsed.role === '(role unparsed)'
        ? `${parsed.company.toLowerCase()}|${parsed.date}`
        : `${parsed.company.toLowerCase()}|${parsed.role.toLowerCase()}`;
      if (seenApp.has(key)) continue;
      seenApp.add(key);

      out.push(parsed);
    }
  }

  out.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return out;
}


/**
 * Short ATS label for the tracker note. A BARE DOMAIN here is read as a URL by
 * the tracker's notes parser, which then refuses the whole additions file
 * ("expected at most one via= tag, one location and one URL"), so the dots
 * never survive into the note.
 */
export function atsLabel(sender) {
  const host = (sender || '').replace(/.*@/, '').toLowerCase();
  const parts = host.split('.').filter((x) => !['com', 'net', 'org', 'io', 'ai', 'co', 'us', 'jobs'].includes(x));
  return (parts[parts.length - 1] || 'unknown').replace(/[^a-z0-9-]/g, '');
}

/** merge-tracker.mjs 9-col TSV: num date company role status score pdf report notes */
export function toTsv(apps, startNum) {
  return apps.map((a, i) => [
    startNum + i,
    a.date || new Date().toISOString().slice(0, 10),
    a.company,
    a.role,
    'Applied',
    // Em dash, not an empty cell and never a number: these rows were never
    // scored, and merge-tracker.mjs tells score from status by SHAPE, not
    // position -- an empty cell makes that undecidable and the whole file is
    // refused as a possible column swap. `—` is both a legal score cell and
    // the honest statement that no evaluation happened.
    '—',
    '',
    '-',
    `backfilled from confirmation email; ats=${atsLabel(a.sender)}; resume variant unknown`,
  ].join('\t')).join('\n');
}

function nextTrackerNum() {
  const tracker = join(CAREER_OPS, 'data', 'applications.md');
  if (!existsSync(tracker)) return 1;
  let max = 0;
  for (const line of readFileSync(tracker, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\|\s*(\d+)\s*\|/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function selfTest() {
  const checks = [];
  const ok = (n, c) => checks.push({ n, pass: !!c });

  const li = parseMessage({
    sender: 'jobs-noreply@linkedin.com',
    subject: 'Your application to Staff ML Engineer at Databricks',
    date: '2026-08-29T21:18:58Z',
  });
  ok('LinkedIn splits role + company', li.company === 'Databricks' && li.role === 'Staff ML Engineer');
  ok('LinkedIn is high confidence', li.confidence === 'high');

  // The high-volume shape. The first-name prefix is why an anchored
  // /^your application/ matched none of the ~200 of these in this inbox.
  const LI_BODY = [
    'Your application was sent to Globalization Partners',
    '',
    'Fullstack AI Engineer',
    'G-P',
    'United States',
    'View job: https://www.linkedin.com/comm/jobs/view/4457792335/?trackingId=x',
    '',
    'View similar jobs you may be interested in',
    '',
    'ML Engineer - NLP',
    'Avoma',
    'San Jose, CA',
  ].join('\n');

  const sent = parseMessage({
    sender: 'jobs-noreply@linkedin.com',
    subject: 'Sheng-Kai, your application was sent to Globalization Partners',
    snippet: LI_BODY,
  });
  ok('sent-to subject yields company', sent.company === 'Globalization Partners');
  ok('LinkedIn body yields the applied role', sent.role === 'Fullstack AI Engineer');
  ok('recommendations block is NOT parsed as an application', sent.role !== 'ML Engineer - NLP');
  ok('LinkedIn job URL recovered',
    linkedinBody(LI_BODY).url === 'https://www.linkedin.com/jobs/view/4457792335');
  ok('agency demoted even from the sent-to shape',
    parseMessage({
      sender: 'jobs-noreply@linkedin.com',
      subject: 'Sheng-Kai, your application was sent to GTN Technical Staffing',
    }).confidence === 'low');

  const ashby = parseMessage({
    sender: 'no-reply@ashbyhq.com',
    subject: 'Thanks for applying to Wisdom AI!',
    snippet: 'Thank you for applying for the Software Engineer, NLP/Machine Learning role at Wisdom AI!',
  });
  ok('subject company + body role -> high', ashby.company === 'Wisdom AI' && ashby.confidence === 'high');
  ok('body role parsed', ashby.role === 'Software Engineer, NLP/Machine Learning');

  ok('ATS host yields no company', companyFromSender('no-reply@ashbyhq.com') === null);
  ok('employer domain yields company', companyFromSender('noreply@mail.amazon.jobs') === 'Amazon');
  ok('talent subdomain stripped', companyFromSender('talent@ibm.com') === 'Ibm');
  ok('Workday tenant names the employer', companyFromSender('amgen@myworkday.com') === 'Amgen');
  ok('iCIMS tenant with +suffix', companyFromSender('garmin+autoreply@talent.icims.com') === 'Garmin');
  ok('generic Workday local part rejected', companyFromSender('noreply@myworkday.com') === null);
  ok('req ID in role does not break parse',
    roleFromBody("We've received your application for the Software Engineer I, Memberships (ID: 10515912) position.")
      .startsWith('Software Engineer I, Memberships'));

  const agency = parseMessage({
    sender: 'jobs-noreply@linkedin.com',
    subject: 'Your application to Machine Learning Engineer at Recruiting from Scratch',
  });
  ok('agency demoted to low', agency.confidence === 'low');

  ok('digest sender dropped', isNoiseSender('noreply@glassdoor.com'));
  ok('real ATS kept', !isNoiseSender('no-reply@ashbyhq.com'));

  const dedup = extractApplications({
    threads: [{
      messages: [
        { id: '1', labelIds: ['INBOX'], sender: 'jobs-noreply@linkedin.com', subject: 'Your application to SWE at Acme', date: '2026-08-01T00:00:00Z' },
        { id: '2', labelIds: ['INBOX'], sender: 'jobs-noreply@linkedin.com', subject: 'Your application to SWE at Acme', date: '2026-08-05T00:00:00Z' },
        { id: '3', labelIds: ['SENT'], sender: 'gorowen56@gmail.com', subject: 'Your application to X at Y', date: '2026-08-02T00:00:00Z' },
      ],
    }],
  });
  ok('dedup company+role', dedup.length === 1);
  ok('SENT excluded', !dedup.some((a) => a.company === 'Y'));

  ok('tsv has 9 columns', toTsv([dedup[0]], 20).split('\t').length === 9);

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.n}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--self-test')) return selfTest();

  if (args.includes('--queries')) {
    const days = 180;
    console.log(`Gmail queries (newer_than:${days}d). Collect raw responses into a JSON array, pipe here.\n`);
    for (const { name, q } of QUERIES) console.log(`# ${name}\n${q.replace('{DAYS}', String(days))}\n`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const useStdin = args.includes('--stdin');
  const file = args.find((a) => !a.startsWith('--'));
  if (!useStdin && !file) {
    console.error('Need a dump file or --stdin. See --queries for the Gmail side.');
    process.exit(1);
  }

  const text = useStdin ? readFileSync(0, 'utf-8') : readFileSync(file, 'utf-8');
  let raw;
  try { raw = JSON.parse(text); } catch (e) {
    console.error(`Input is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  const apps = extractApplications(raw);
  const high = apps.filter((a) => a.confidence === 'high');
  const rest = apps.filter((a) => a.confidence !== 'high');

  console.log(`Parsed:   ${apps.length} distinct applications`);
  console.log(`  high:   ${high.length}  -> tracker additions`);
  console.log(`  review: ${rest.length}  -> held back for eyes\n`);

  for (const a of apps.slice(0, 20)) {
    console.log(`  ${a.confidence.padEnd(7)} ${(a.date || '').padEnd(11)} ${a.company.slice(0, 26).padEnd(26)} ${a.role.slice(0, 44)}`);
  }
  if (apps.length > 20) console.log(`  ... and ${apps.length - 20} more`);

  if (dryRun) { console.log('\n--dry-run: nothing written.'); return; }

  mkdirSync(ADDITIONS_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const start = nextTrackerNum();

  // ONE ROW PER FILE. merge-tracker.mjs trims the WHOLE file and parses it as a
  // single addition (merge-tracker.mjs:648) -- a multi-row file is read as one
  // row with dozens of trailing fields and rejected as "ambiguous extra fields".
  // The existing merged/ files (003-vercel.tsv etc.) are one row each; this
  // matches that convention.
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'unknown';

  const writeRows = (rows, dir, offset, label) => {
    mkdirSync(dir, { recursive: true });
    rows.forEach((a, i) => {
      const num = start + offset + i;
      writeFileSync(join(dir, `${String(num).padStart(3, '0')}-${slug(a.company)}.tsv`),
        `${toTsv([a], num)}\n`, 'utf-8');
    });
    console.log(`${label} ${rows.length} files -> ${dir}`);
  };

  console.log('');
  if (high.length) writeRows(high, ADDITIONS_DIR, 0, 'Wrote');
  if (rest.length) {
    writeRows(rest, REVIEW_DIR, high.length, 'Held ');
    console.log(`      (review them, then move into ${ADDITIONS_DIR}/ to merge)`);
  }
  console.log('\nNext: node merge-tracker.mjs --dry-run');
}

main(process.argv);
