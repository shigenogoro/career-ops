#!/usr/bin/env node
/**
 * gmail-reply-scan.mjs — Gmail -> data/reply-candidates.json bridge (upstream #1583).
 *
 * WHAT THIS CLOSES. reply-watch.mjs already classifies employer replies, matches
 * them to tracker rows, and prompts before touching data/applications.md -- but its
 * only input is data/reply-candidates.json, and upstream's only planned way to fill
 * that file is a Gmail scanner that was never built (it needs OAuth inbox access).
 * paste-reply.mjs is the manual alternative; this script is the bulk one.
 *
 * DIVISION OF LABOR. Gmail is reached through Claude's connected Gmail tool, not
 * from this process -- there are no OAuth credentials on disk and none are wanted.
 * So the loop is:
 *
 *   1. Claude runs the Gmail queries (see QUERIES below) and dumps the raw
 *      search_threads JSON responses to a file.
 *   2. THIS SCRIPT normalizes that dump into reply-watch.mjs's candidate shape,
 *      drops known non-employer senders, assigns a high-precision `signal`,
 *      dedups by message id, and merges into data/reply-candidates.json.
 *   3. `node reply-watch.mjs` classifies, matches the tracker, and asks before
 *      writing anything.
 *
 * This script NEVER writes data/applications.md. Status changes stay behind
 * reply-watch.mjs's confirm gate, which is the whole point of that gate.
 *
 * WHY WE PRE-ASSIGN `signal`. reply-matcher.mjs's classifyReply() honors four
 * signal values -- 'rejection', 'offer', 'interview_invite', 'update' -- and each
 * one SHORT-CIRCUITS ahead of the keyword lists. That matters because the built-in
 * English rejection list misses the phrasings that dominate a US new-grad inbox:
 * "we regret to inform", "not selected for further consideration", "move forward
 * with other candidates", "do not meet the qualifications", "won't be moving
 * forward". Worse, most of those mails OPEN with "Thank you for applying", which
 * the built-in autoKeywords list would otherwise catch first and file as a
 * no-op auto-confirmation -- a rejection silently swallowed.
 *
 * Assigning the signal here fixes that without touching reply-matcher.mjs, which
 * is system layer and gets overwritten by `node update-system.mjs apply`. This
 * file lives in scripts/ (user layer) for the same reason.
 *
 * PRECISION OVER RECALL. A missed rejection costs one manual status update. A
 * false rejection silently closes a live application. So every phrase below is
 * unambiguous in isolation, and anything uncertain is left with signal: null for
 * reply-matcher's own keyword pass -- and, failing that, for the human reading
 * reply-watch.mjs's digest.
 *
 * Usage:
 *   node scripts/gmail-reply-scan.mjs <dump.json> [--dry-run] [--summary]
 *   node scripts/gmail-reply-scan.mjs --stdin [--dry-run]
 *   node scripts/gmail-reply-scan.mjs --queries      # print the Gmail queries to run
 *   node scripts/gmail-reply-scan.mjs --self-test    # pure-function tests, no filesystem
 *
 * Env:
 *   CAREER_OPS_REPLY_CANDIDATES  override the output path (mirrors paste-reply.mjs)
 */

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CAREER_OPS = dirname(__dirname);
const CANDIDATES_PATH = process.env.CAREER_OPS_REPLY_CANDIDATES
  || join(CAREER_OPS, 'data', 'reply-candidates.json');

// ---------------------------------------------------------------------------
// The Gmail queries. Printed by --queries so the human half of the loop is
// reproducible and reviewable rather than improvised each run.
// ---------------------------------------------------------------------------

export const QUERIES = [
  {
    name: 'rejections',
    q: '{"we regret to inform" "unfortunately" "not moving forward" "other candidates" '
      + '"not selected" "no longer under consideration" "not to proceed"} '
      + 'newer_than:{DAYS}d -in:sent -in:draft',
  },
  {
    name: 'interviews',
    q: '{"schedule a call" "phone screen" "onsite interview" "technical screen" '
      + '"invite you to interview" "next steps" "would like to speak" "set up a time"} '
      + 'newer_than:{DAYS}d -in:sent -in:draft',
  },
  {
    name: 'assessments',
    q: '{"online assessment" "coding challenge" "take-home" HackerRank CodeSignal Karat CoderPad} '
      + 'newer_than:{DAYS}d -in:sent -in:draft',
  },
  {
    name: 'offers',
    q: '{"offer letter" "pleased to offer" "compensation details" "employment agreement"} '
      + 'newer_than:{DAYS}d -in:sent -in:draft',
  },
];

// ---------------------------------------------------------------------------
// Sender-level noise. These never become candidates at all: job alerts, digests,
// coding-practice marketing, gig-work platforms, agency blasts, and this
// account's own read-receipt notifications. Dropping at the sender level keeps
// them out of the digest entirely rather than relying on classifyReply's
// noiseKeywords, which only fires on marketing WORDING.
//
// Substring match against the sender field, lowercased.
// ---------------------------------------------------------------------------

export const NOISE_SENDERS = [
  'jobs-noreply@linkedin.com',      // "Your application to X" -- a confirmation, not a reply
  'jobs-listings@linkedin.com',
  'noreply@glassdoor.com',
  'no-reply@leetcode.com',
  'no-reply@hackerrankmail.com',    // practice-problem marketing, NOT an employer assessment
  'thebatch@deeplearning.ai',
  'mail.beehiiv.com',
  'indeedapply@indeed.com',
  'noreply-accounts@google.com',
  'notification@mailsuite.com',     // this account's own link-open receipts
  'no-reply@email.claude.com',
  'teamworkonline.com',
  'hello@scale.jobs',
  'mail.remotehunter.com',
  'notify.mindrift.ai',             // freelance gig platform, not a target employer
  'candidates.workablemail.com',    // same platform's application confirmations
  'ceipalmail.com',                 // agency blast
  'admissions@codepath.org',
  'noreply@medium.com',
];

// ---------------------------------------------------------------------------
// Signal phrases. Ordered by decisiveness -- the first category that matches
// wins, and rejection is tested first for the same reason reply-matcher.mjs
// tests it first: "we are unable to offer" must never read as an offer.
//
// Every phrase here must be unambiguous ON ITS OWN. Deliberately absent:
// bare "assessment", "deadline", "opportunity", "update" -- all of which occur
// in mail of every type.
// ---------------------------------------------------------------------------

export const REJECTION_PHRASES = [
  'regret to inform',
  'we regret that',
  'not selected',
  'not been selected',
  'move forward with other candidate',
  'moved forward with other candidate',
  'moving forward with other candidate',
  'other candidates whose',
  'other applicants whose',
  'pursuing other candidates',
  'not be moving forward',
  "won't be moving forward",
  'not moving forward with your',
  'decided not to proceed',
  'not to proceed with your',
  'no longer under consideration',
  'not under consideration',
  'unable to offer you employment',
  'do not meet the qualifications',
  'does not meet the qualifications',
  'not ideally suited',
  'position has been filled',
  'role has been closed',
  'has been cancelled',
  'we will not be advancing',
  'not advancing your',
  'decided to move forward with another',
];

export const INTERVIEW_PHRASES = [
  'schedule a call',
  'schedule an interview',
  'schedule some time',
  'set up a time',
  'set up a call',
  'find a time',
  'phone screen',
  'onsite interview',
  'technical screen',
  'invite you to interview',
  'invite you to an interview',
  'like to interview',
  'interview invitation',
  'would like to speak with you',
  'would love to chat',
  'booking link',
  'scheduling link',
  'calendly.com',
];

export const OFFER_PHRASES = [
  'offer letter',
  'pleased to offer',
  'excited to offer',
  'formal offer',
  'employment agreement',
];

// An assessment invite is a real "do something" event but not an interview.
// reply-matcher maps signal 'update' to Responded, which is the honest state:
// the employer engaged, and the human decides what it means.
export const ACTION_PHRASES = [
  'online assessment',
  'coding challenge',
  'coding assessment',
  'take-home',
  'complete the assessment',
  'hackerrank assessment',
  'codesignal',
  'coderpad',
];

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

export function isNoiseSender(sender) {
  const s = (sender || '').toLowerCase();
  if (!s) return false;
  return NOISE_SENDERS.some((n) => s.includes(n));
}

/**
 * Assign the reply-matcher signal, or null to defer to its own keyword pass.
 * Rejection is tested first; see the ordering note above.
 */
export function assignSignal(subject, body) {
  const text = `${subject || ''} ${body || ''}`.toLowerCase();
  if (!text.trim()) return null;

  const hit = (phrases) => phrases.some((p) => text.includes(p));

  if (hit(REJECTION_PHRASES)) return 'rejection';
  if (hit(OFFER_PHRASES)) return 'offer';
  if (hit(INTERVIEW_PHRASES)) return 'interview_invite';
  if (hit(ACTION_PHRASES)) return 'update';
  return null;
}

/**
 * Flatten raw search_threads responses into candidate objects.
 *
 * Accepts a single response object, an array of them, or an array of threads --
 * the dump is whatever the Gmail tool returned, and normalizing here keeps the
 * human half of the loop from having to reshape anything by hand.
 *
 * Messages the account SENT are dropped: a thread matches on any message, so
 * Kyle's own follow-up pulls in the thread and his own words would otherwise be
 * classified as an employer reply.
 */
export function extractCandidates(raw) {
  const responses = Array.isArray(raw) ? raw : [raw];
  const threads = [];
  for (const r of responses) {
    if (!r) continue;
    if (Array.isArray(r.threads)) threads.push(...r.threads);
    else if (Array.isArray(r.messages)) threads.push(r);
    else if (Array.isArray(r)) threads.push(...r);
  }

  const out = [];
  const seen = new Set();

  for (const thread of threads) {
    for (const msg of thread.messages || []) {
      const labels = msg.labelIds || [];
      if (labels.includes('SENT') || labels.includes('DRAFT')) continue;

      const id = msg.id || msg.messageId;
      if (!id || seen.has(id)) continue;

      const sender = msg.sender || msg.from || '';
      if (isNoiseSender(sender)) continue;

      const subject = msg.subject || '';
      const body = msg.snippet || msg.body_snippet || '';
      if (!subject && !body) continue;

      seen.add(id);
      out.push({
        message_id: id,
        from: sender,
        subject,
        body_snippet: body,
        signal: assignSignal(subject, body),
        received: msg.date || null,
        thread_id: msg.threadId || thread.id || null,
      });
    }
  }

  return out;
}

/** Merge new candidates into existing ones, keyed on message_id. Existing wins. */
export function mergeCandidates(existing, incoming) {
  const byId = new Map();
  for (const c of existing) byId.set(c.message_id, c);
  const added = [];
  for (const c of incoming) {
    if (byId.has(c.message_id)) continue;
    byId.set(c.message_id, c);
    added.push(c);
  }
  return { merged: Array.from(byId.values()), added };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

function loadExisting(path) {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error(`Refusing to overwrite unparseable ${path}: ${e.message}`);
    process.exit(1);
  }
}

function writeAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  renameSync(tmp, path);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

function summarize(candidates) {
  const counts = {};
  for (const c of candidates) {
    const k = c.signal || '(unclassified — reply-matcher will decide)';
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function selfTest() {
  const checks = [];
  const ok = (name, cond) => checks.push({ name, pass: !!cond });

  // The phrasings upstream's built-in list misses.
  ok('IBM "regret to inform"',
    assignSignal('Your IBM Application Status', 'We regret to inform you that we have decided to move forward with other candidates') === 'rejection');
  ok('Kyndryl "not selected"',
    assignSignal('Update on your application', 'we regret to inform you that your application was not selected for further consideration') === 'rejection');
  ok('Amazon "do not meet the qualifications"',
    assignSignal('Amazon application: Status update', 'we have determined that you currently do not meet the qualifications') === 'rejection');
  ok('Redfin "won\'t be moving forward"',
    assignSignal('Update on your Redfin application', "After careful consideration, we've decided we won't be moving forward") === 'rejection');
  ok('Garmin "unable to offer you employment" is NOT an offer',
    assignSignal('Software Engineer 1', 'Unfortunately, Garmin is unable to offer you employment at this time') === 'rejection');

  // A rejection that opens with "Thank you for applying" must still be a
  // rejection -- the exact case that would otherwise be filed as a no-op
  // auto-confirmation by the built-in keyword order.
  ok('rejection wearing an auto-confirmation opening',
    assignSignal('Thank you for Applying to Adobe', 'Thank you for taking the time to apply. We have decided to move forward with other candidates.') === 'rejection');

  // Genuine positives.
  ok('interview invite', assignSignal('Next step', 'We would like to speak with you -- here is a scheduling link') === 'interview_invite');
  ok('offer', assignSignal('Good news', 'We are pleased to offer you the position') === 'offer');
  ok('assessment -> update', assignSignal('Your assessment', 'Please complete the online assessment') === 'update');

  // Must NOT fire.
  ok('plain confirmation defers', assignSignal('Thank you for applying to Wayve', 'Your application has been received and we will review it') === null);
  ok('empty defers', assignSignal('', '') === null);

  ok('noise sender dropped', isNoiseSender('jobs-noreply@linkedin.com'));
  ok('practice marketing dropped', isNoiseSender('no-reply@hackerrankmail.com'));
  ok('real employer kept', !isNoiseSender('talent@ibm.com'));

  // SENT messages must never become candidates.
  const sentDrop = extractCandidates({
    threads: [{
      id: 't1',
      messages: [
        { id: 'm1', labelIds: ['SENT'], sender: 'gorowen56@gmail.com', subject: 'Following up', snippet: 'Thank you again' },
        { id: 'm2', labelIds: ['INBOX'], sender: 'talent@ibm.com', subject: 'Status', snippet: 'We regret to inform you' },
      ],
    }],
  });
  ok('SENT dropped, inbound kept', sentDrop.length === 1 && sentDrop[0].message_id === 'm2');
  ok('inbound signal assigned', sentDrop[0]?.signal === 'rejection');

  const dedup = mergeCandidates([{ message_id: 'a' }], [{ message_id: 'a' }, { message_id: 'b' }]);
  ok('dedup by message_id', dedup.merged.length === 2 && dedup.added.length === 1);

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, ''));
    return;
  }

  if (args.includes('--self-test')) return selfTest();

  if (args.includes('--queries')) {
    const days = 120;
    console.log(`Gmail queries (newer_than:${days}d). Run each with the Gmail search_threads tool,`);
    console.log('collect the raw responses into a JSON array, then pipe that here.\n');
    for (const { name, q } of QUERIES) {
      console.log(`# ${name}\n${q.replace('{DAYS}', String(days))}\n`);
    }
    return;
  }

  const dryRun = args.includes('--dry-run');
  const useStdin = args.includes('--stdin');
  const file = args.find((a) => !a.startsWith('--'));

  if (!useStdin && !file) {
    console.error('Need a dump file or --stdin. See --help, or --queries for the Gmail side.');
    process.exit(1);
  }

  const text = useStdin ? readStdin() : readFileSync(file, 'utf-8');
  if (!text.trim()) {
    console.error('Empty input.');
    process.exit(1);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.error(`Input is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  const candidates = extractCandidates(raw);
  const existing = loadExisting(CANDIDATES_PATH);
  const { merged, added } = mergeCandidates(existing, candidates);

  console.log(`Parsed:     ${candidates.length} inbound messages (after sender + SENT filtering)`);
  console.log(`Already in: ${existing.length}`);
  console.log(`New:        ${added.length}`);

  if (added.length) {
    console.log('\nBy signal:');
    for (const [k, v] of Object.entries(summarize(added))) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
    console.log('\nNewest first:');
    for (const c of added.slice(0, 15)) {
      const sig = c.signal ? `[${c.signal}]` : '[defer]';
      console.log(`  ${sig.padEnd(18)} ${(c.from || '').slice(0, 34).padEnd(34)} ${c.subject.slice(0, 60)}`);
    }
    if (added.length > 15) console.log(`  ... and ${added.length - 15} more`);
  }

  if (dryRun) {
    console.log(`\n--dry-run: ${CANDIDATES_PATH} not written.`);
    return;
  }

  writeAtomic(CANDIDATES_PATH, merged);
  console.log(`\nWrote ${merged.length} candidates to ${CANDIDATES_PATH}`);
  console.log('Next: node reply-watch.mjs   (classifies, matches the tracker, asks before writing)');
}

main(process.argv);
