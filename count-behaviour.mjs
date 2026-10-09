/**
 * THE LOCAL COUNTER — rubric v0.1 (`counter@0.1.0`).
 *
 * Reads this machine's own Claude Code transcripts, its Codex rollouts (2026-09-27), its Antigravity conversations (2026-10-04), its VS Code
 * Copilot chat sessions (2026-09-08) and, when given, a claude.ai export (~/.claude/projects/**​/*.jsonl — transcripts
 * ONLY, never project files), classifies each of the person's OWN messages with the
 * deterministic rules below, and reports COUNTS per month through the WorkTrust MCP door's
 * `log_signals`. The same logs under the same rubric give the same numbers: every count is
 * re-derivable, and a better rubric is a new version that writes beside this one.
 *
 * WHAT CANNOT LEAVE: the door's schema takes vocabulary keys and integers; it has no text
 * field and refuses unknown keys by name. This script builds exactly that payload and nothing
 * else — a password or a .env line has no channel to travel through. Run with --dry-run to see
 * every number before anything is sent.
 *
 *   node count-behaviour.mjs --dry-run
 *   node count-behaviour.mjs --url https://app.worktrust.io/api/mcp --token wt_...
 *   node count-behaviour.mjs --dry-run --exclude client-x --exclude secret
 *   node count-behaviour.mjs --dry-run --claude-export ~/Downloads/claude-export   (a claude.ai data export beside the transcripts)
 *   node count-behaviour.mjs --dry-run --chatgpt-export ~/Downloads/chatgpt-export (a ChatGPT data export, the same way)
 *
 * CONFIDENTIAL PROJECTS stay out BEFORE anything is counted: `--exclude <text>` (repeatable)
 * skips every project directory whose name contains that text, and `.worktrust-counter.json`
 * in your home directory does the same permanently: { "exclude": ["client-x"] }. An excluded
 * project is never read at all — there is nothing to erase later, because nothing left.
 *
 * RUBRIC v0.2 — a hypothesis, on purpose. v0.1 counted WORDS per message; v0.2 also counts
 * STRUCTURE per session: follow-up questions after an answer, sequences opened with an edge
 * case, work delegated to subagents (isSidechain / Agent tool_use), tools and skills invoked,
 * autonomous permission modes, and long uninterrupted runs — all read from fields the
 * transcripts already carry, none inferred.
 *
 * RUBRIC (lexical half) — Only signals with crisp lexical or structural
 * markers are counted; everything ambiguous stays uncounted rather than miscounted. Rules run
 * per user message (both English and Dutch), case-insensitively, one count per message per
 * signal. The behaviour model carries each signal's validity; nothing here is a score.
 */
import { createHash, randomBytes, sign as cryptoSign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, readSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

/** DEVICE PROOF (2026-10-03): through `worktrust hook` a bound computer hands over WORKTRUST_DEVICE_KEY; every call is then signed. */
const proofFor = (url, body) => {
  const device = process.env.WORKTRUST_DEVICE_KEY;
  if (!device) return {};
  const seconds = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(18).toString("base64url");
  return { "worktrust-proof": `${seconds}.${nonce}.${cryptoSign(null, Buffer.from(`POST\n${new URL(url).pathname}\n${seconds}\n${nonce}\n${createHash("sha256").update(body).digest("hex")}`), device).toString("base64url")}` };
};

export const fingerprint = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const encode = value => JSON.stringify(value, (_, v) => v instanceof Map ? {$map:[...v]} : v instanceof Set ? {$set:[...v]} : v);
export const decode = value => JSON.parse(value, (_, v) => v?.$map ? new Map(v.$map) : v?.$set ? new Set(v.$set) : v);
export function checkpointStore(path, signature, manifest) {
  mkdirSync(dirname(path), {recursive:true,mode:0o700});
  // A process lock prevents two local runs from replacing each other's checkpoint.
  const lock=path+'.lock';
  try { const fd=openSync(lock,'wx',0o600);writeFileSync(fd,String(process.pid));closeSync(fd); }
  catch(error) {
    if(error.code!=='EEXIST') throw error;
    const pid=Number(readFileSync(lock,'utf8'));
    try {process.kill(pid,0);throw Error('Counter checkpoint is in use');}
    catch(e) {if(e.code!=='ESRCH')throw e;}
    unlinkSync(lock);return checkpointStore(path,signature,manifest);
  }
  const release=()=>{try{unlinkSync(lock)}catch{}};
  process.once('exit',release);
  let saved=null;
  try {saved=decode(readFileSync(path,'utf8'));}catch(error){if(error.code!=='ENOENT')console.error('Checkpoint unreadable; recounting from sources.');}
  const valid=saved?.signature===signature && saved.manifest?.slice(0,saved.next).every((x,i)=>x===manifest[i]) && saved.next<=manifest.length
    && Object.entries(saved.dependencies??{}).every(([p,h])=>{try{return fingerprint(readFileSync(p))===h}catch{return false}});
  return {
    saved:valid?saved:null,
    write(next,state,dependencies={}) {
      const temp=path+'.'+process.pid+'.tmp';
      writeFileSync(temp,encode({signature,manifest,next,state,dependencies}),{mode:0o600});renameSync(temp,path);
    },
    close(){process.removeListener('exit',release);release();},
  };
}

export const ANALYZER_VERSION = "counter@0.10.0";

/** signal key (packages/core/src/behaviour.ts) → the v0.1 marker that counts it. */
export const RULES = [
  { signal: "edgeCases", pattern: /\bedge[ -]?cases?\b|\bcorner[ -]?cases?\b|\brandgeval(len)?\b|\bedge[ -]?scenario/i },
  { signal: "counterfactualQuestions", pattern: /\bwhat if\b|\bwat als\b|\bstel dat\b|\bwhat happens (if|when)\b/i },
  { signal: "alternativesRequested", pattern: /\balternative(s)?\b|\bother (option|way|approach)\b|\bandere (optie|manier|aanpak)\b|\balternatie(f|ven)\b/i },
  { signal: "assumptionsSurfaced", pattern: /\bassum(e|ption|ing)\b|\baanname(s)?\b|\bervan uit\b|\buitgangspunt\b/i },
  { signal: "counterarguments", pattern: /\bdisagree\b|\b(that|this)('s| is) (not |in)correct\b|\bklopt niet\b|\bniet mee eens\b|\bdat is fout\b|\bwhy not\b|\bwaarom niet\b/i },
  { signal: "verificationAttempts", pattern: /\bverif(y|ieer|icatie)\b|\bcontroleer\b|\bcheck (dat|of|whether|that|it)\b|\brun (the )?tests?\b|\bdraai de tests?\b|\bprove\b|\bbewijs\b|\bmeet\b|\bmeasure\b/i },
  { signal: "criteriaStated", pattern: /\bcriteri(a|um)\b|\bacceptance\b|\bmoet voldoen aan\b|\beisen?:\b|\brequirements?:\b|\bdefinition of done\b/i },
  { signal: "tradeOffsNamed", pattern: /\btrade[ -]?offs?\b|\bafweging(en)?\b|\bvoor- en nadelen\b|\bpros and cons\b|\bnadeel is\b|\bdownside\b/i },
  { signal: "constraintsDefined", pattern: /\bconstraints?\b|\bbinnen \d|\bmax(imum|imaal)?\b.*\b(regels|lines|tokens|uur|hours|mb|kb)\b|\bzonder (dat|een)\b|\bmust not\b|\bmag niet\b|\bnooit\b|\bnever\b/i },
  { signal: "gapQuestions", pattern: /\bwhat('s| is) missing\b|\bwat (mist|ontbreekt)\b|\bis er iets vergeten\b|\banything (i|we) missed\b|\bwat zie ik over het hoofd\b/i },
  { signal: "postMortemReflection", pattern: /\bwhy did(n't| not)? (it|that|this)\b|\bwaarom (werkte|ging|lukte|faalde)\b|\bwat ging (er )?(mis|fout)\b|\bwhat went wrong\b|\broot cause\b/i },
  { signal: "problemReframed", pattern: /\bactually,? the (real|better) question\b|\beigenlijk is de vraag\b|\blaten we het anders (stellen|aanpakken)\b|\breframe\b|\bstep back\b|\been stap terug\b/i },
  { signal: "prioritisation", pattern: /\beerst\b.*\bdaarna\b|\bfirst\b.*\bthen\b|\bprioritise|prioriteit\b|\bbelangrijkste eerst\b|\bin (this |deze )?volgorde\b|\bin (that |this )?order\b/i },
  { signal: "evidenceDemands", pattern: /\bshow me\b|\bcite\b|\btoon aan\b|\bbewijs (dat|het)\b|\bwaar staat (dat|het)\b|\bprove (it|that)\b|\blink naar de docs\b/i },
  { signal: "scopeCuts", pattern: /\bout of scope\b|\bbuiten scope\b|\blaat .{0,20}weg\b|\bniet nu\b|\bnot now\b|\bschrap\b|\bdrop (that|this|it)\b/i },
  { signal: "decidedNotToBuild", pattern: /\b(we )?bouwen (dit|het) niet\b|\bdon'?t build\b|\bniet bouwen\b|\bbesloten .{0,20}niet te (bouwen|doen)\b|\bafblazen\b/i },
  { signal: "measurementScepticism", pattern: /\bklopt (dit|dat) getal\b|\bis dit getal juist\b|\bcheck (the|that) (number|count)\b|\bare you sure th(is|ese|at) (number|count)/i },
  { signal: "strategySwitch", pattern: /\bandere aanpak\b|\bdifferent approach\b|\bin plaats daarvan\b|\binstead,? let'?s\b|\blaten we overstappen\b|\bplan b\b/i },
  { signal: "priorDecisionsCarried", pattern: /\bzoals (we|eerder) (besloten|afspraken|zeiden)\b|\bas (we )?(decided|agreed)\b|\bper (the|our) (adr|decision)\b|\bvolgens de afspraak\b/i },
  { signal: "consistencyOverSession", pattern: /\bterug naar (het|de|ons)\b|\bback to (the|our)\b|\bfocus terug\b|\bstick to the plan\b/i },
  // ── agency, as DECISION BEHAVIOUR only (framework 4.1, D4): what was said about a choice, never what was felt ──
  { signal: "decisionAnnouncement", pattern: /\b(we gaan voor|ik ga voor|ik kies( voor)?|besloten:|beslissing:|i'?m going with|we'?re going with|i'?ll go with|let'?s go with|decision:|decided:|we choose|i choose)\b/i },
  { signal: "permissionSeeking", pattern: /\b(mag ik|mogen we|is it ok(ay)? if|is it fine if|may i|can i go ahead|should i ask (permission|first)|zal ik eerst (vragen|overleggen)|moet ik (eerst )?toestemming)\b/i },
  { signal: "decisionDeferral", pattern: /\b(let'?s postpone|postpone (the|this|that) decision|decide (that|this) later|we'?ll decide later|park (this|that|the) decision|beslissen we later|stel(len we)? (de|die|deze) beslissing uit|parkeren we (de|die|deze) (keuze|beslissing))\b/i },
  { signal: "hypothesesRaised", pattern: /\bmy (hypothesis|theory|guess) is\b|\bmijn (hypothese|theorie|vermoeden) is\b|\bik (denk|vermoed) dat het komt door\b|\bi suspect\b|\bvolgens mij komt (het|dit) door\b/i },
];

/**
 * ── v0.8: THE FORM AN OPENING TAKES, deterministically (supplementary specification, chapter 8) ──
 *
 * Nine rules in priority order; the first that matches names the form. Nothing is guessed: a
 * message no rule places is UNCLASSIFIED, and UNCLASSIFIED is counted. A form is not a quality —
 * no form scores higher than another; only its association with what happened next, in the
 * person's own record, says anything. Sent as `openingForm.<FORM>`, one count per session.
 *
 * ACCEPTANCE (proposed, chapter 8 and the measurement review): these fields are counter-grade
 * only once two raters BLIND to the counter agree with it at Cohen's κ ≥ 0.6 per field per
 * language class on ≥ 100 items, with UNCLASSIFIED under 10 %. Until then they are reading-grade
 * and the screen says so. `--label-openings <file>` writes the openings with the counter's form
 * beside them, LOCALLY, for the raters; `--agreement <file>` reads the labels back and reports κ.
 */
export const OPENING_FORMS = ["ARTEFACT", "ROLE", "CONSTRAINT", "PROBLEM", "OUTCOME", "EXPLORE", "SOLUTION", "CONTINUE", "UNCLASSIFIED"];
export const SECOND_TURNS = ["ACCEPT", "CORRECT", "DEEPEN", "REDIRECT", "ABANDON", "UNCLASSIFIED"];
const ROLE_OPENING = /^\W*(je bent|jij bent|you are|you're|act as|als (een )?(senior|expert|ervaren)|gedraag je als|neem de rol|take the role)\b/i;
const CONSTRAINT_MARK = /\b(moet|mag niet|niet meer dan|binnen|zonder|alleen|must|must not|only|max(imum|imaal)?|no more than|never|nooit)\b/i;
const SYMPTOM = /\b(werkt niet|faalt|fout(melding)?|error|traag|onduidelijk|breaks?|broken|fails?|failing|crash(es|t|ed)?|kapot|hangs?|timeout|not working|doesn'?t work|mislukt|hangt|breekt|lukt niet|doet het niet|gaat (er )?(mis|fout))\b/i;
// v0.10: the Dutch counterparts of the English verbs, SEPARABLE ones included. "voeg toe" and "pas aan"
// never matched as written, because Dutch puts the object between the halves ("voeg een knop toe").
const BUILD_VERB = /^\W*(bouw|maak|schrijf|fix|voeg (\S+ ){0,8}?toe|verwijder|pas (\S+ ){0,8}?aan|implementeer|refactor|update|build|make|write|add|implement|create|remove|change|refactor|update|generate|convert|rename|migrate|los (\S+ ){0,8}?op|werk (\S+ ){0,8}?bij|haal (\S+ ){0,8}?weg|zet (\S+ ){0,8}?om|herstel|repareer|wijzig|verander|genereer|converteer|hernoem|migreer|creëer)\b/i;
const OUTCOME_MARK = /\b(het resultaat moet|ik wil eindigen met|end state|eindtoestand|zodat|so that|the result should|i want to end up with|het eindresultaat)\b/i;
const EXPLORE_MARK = /\b(wat zijn de opties|hoe zou je|welke manieren|what are the options|how would you|what would you|wat zou je|which approaches|welke aanpakken)\b/i;
const CONTINUE_MARK = /\b(ga verder|ga door|zoals besproken|verder met|continue|as before|as discussed|pick up where|where we left|waar we gebleven (waren|zijn))\b/i;
const QUESTION_WORD = /^\W*(wat|hoe|waarom|welke|wanneer|kan|kun|zou|is|what|how|why|which|when|can|could|would|should|is|are|does|do)\b/i;

/** The share of a message that is pasted material: fenced code, quoted lines, logs and stack traces, dense symbol lines. */
export function pastedShare(text) {
  if (!text) return 0;
  let pasted = 0;
  const fences = text.match(/```[\s\S]*?```/g) ?? [];
  for (const block of fences) pasted += block.length;
  const rest = text.replace(/```[\s\S]*?```/g, "");
  for (const line of rest.split("\n")) {
    const symbols = (line.match(/[{}();=<>\[\]|\\\/$#@]/g) ?? []).length;
    if (/^\s*>/.test(line) || /^ {4}/.test(line) || /^\s*at .+:\d+/.test(line) || /\b(Traceback|Exception|ERR_|error TS\d|\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.test(line) || (line.length > 12 && symbols / line.length > 0.12)) pasted += line.length + 1;
  }
  return Math.min(1, pasted / Math.max(1, text.length));
}
const sentencesOf = (text) => text.replace(/```[\s\S]*?```/g, " ").split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter((part) => part.length > 0);
/** Which sentence carries the ask: the first with a question mark, a build verb or an open-question opener; else the last. */
const askIndex = (sentences) => { const i = sentences.findIndex((part) => /\?/.test(part) || BUILD_VERB.test(part) || EXPLORE_MARK.test(part) || QUESTION_WORD.test(part)); return i >= 0 ? i : sentences.length - 1; };

export function classifyOpening(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return "UNCLASSIFIED";
  if (pastedShare(clean) > 0.6) return "ARTEFACT"; // rule 1
  const sentences = sentencesOf(clean);
  if (sentences.length === 0) return "UNCLASSIFIED";
  if (ROLE_OPENING.test(sentences[0])) return "ROLE"; // rule 2
  const ask = askIndex(sentences);
  if (sentences.slice(0, ask).filter((part) => CONSTRAINT_MARK.test(part)).length >= 2) return "CONSTRAINT"; // rule 3
  const question = sentences[ask];
  // Rule 4 reads the problem STATEMENT too: "the deploy fails … What is going on?" states the
  // symptom in the sentence before the question, and that is the PROBLEM form, not an unplaced one.
  if (SYMPTOM.test(sentences.slice(0, ask + 1).join(" ")) && !BUILD_VERB.test(question)) return "PROBLEM"; // rule 4
  if (OUTCOME_MARK.test(question) && !BUILD_VERB.test(question)) return "OUTCOME"; // rule 5
  if (EXPLORE_MARK.test(question)) return "EXPLORE"; // rule 6
  if (BUILD_VERB.test(question)) return "SOLUTION"; // rule 7
  if (CONTINUE_MARK.test(clean) && !/\?/.test(clean)) return "CONTINUE"; // rule 8
  return "UNCLASSIFIED"; // rule 9: counted, not guessed
}
/** instruction | question | context — what kind of act the opening is, orthogonal to its form. */
export function openingActKind(text, form) {
  if (form === "ROLE" || form === "SOLUTION") return "instruction";
  if (form === "EXPLORE" || /\?/.test(String(text ?? "").split("\n")[0] ?? "")) return "question";
  return "context";
}
const CORRECT_MARK = /^\W*(nee|no|nope|niet|not (quite|that|what)|wrong|klopt niet|fout|dat is niet|that'?s not|i meant|ik bedoel(de)?|bedoel|instead of|in plaats van)\b/i;
const REDIRECT_MARK = /\b(andere aanpak|different approach|other approach|in plaats daarvan|instead,? let'?s|laten we overstappen|plan b|another way|change of plan|laat (dit|dat) (maar )?(liggen|zitten)|let'?s (drop|park) (this|that))\b/i;
export function classifySecondTurn(text) {
  const clean = String(text ?? "").trim();
  if (!clean) return "UNCLASSIFIED";
  if (REDIRECT_MARK.test(clean)) return "REDIRECT";
  if (CORRECT_MARK.test(clean)) return "CORRECT";
  if (ACCEPT_TURN.test(clean) || (clean.split(/\s+/).length <= 6 && !/\?/.test(clean))) return "ACCEPT";
  if (/\?/.test(clean) || QUESTION_WORD.test(clean)) return "DEEPEN";
  return "UNCLASSIFIED";
}
const ACCEPT_TURN = /^\s*(yes|yeah|yep|sure|ok(ay)?|please|do it|go ahead|go|looks good|lgtm|perfect|great|ja|graag|prima|goed|top|ga door|ga verder|doe (het|maar)|oké|akkoord|klopt|precies)\b/i;

/**
 * ── v0.10: WHOSE TURN A LINE IS (the transcript's own format, read before any rule) ─────────
 *
 * A Claude Code transcript writes more than the person's typing on the user role: a slash command
 * as `<command-name>/x</command-name>` tags (so a `^/` test never matched and toolInitiator.person
 * was never counted), a local command's output as `<local-command-stdout>`, a background task's
 * completion as `<task-notification>`, a compaction summary (`isCompactSummary`), an interruption
 * marker ("[Request interrupted by user]"), and, since the `origin` field exists, turns whose origin
 * is another agent ("peer") or a task notification. None of those is the person framing anything;
 * each was counted as a human turn and could become a session's OPENING. `personTurn` answers
 * null for them, the command's own arguments for a slash command, and `interrupt` for the marker
 * (the person pressing stop is a redirect, not a message).
 */
const MACHINE_TURN = /^\s*(<task-notification>|<local-command-(stdout|stderr|caveat)>|Caveat: The messages below were generated|This session is being continued from a previous conversation)/;
export function personTurn(line) {
  // A message the person typed WHILE the agent ran is not a user line at all: Claude Code queues it
  // and writes it as a `queued_command` attachment (commandMode "prompt") inside the run. It was
  // invisible to every rule, and it is the one turn that is mid-run by construction.
  if (line?.type === "attachment" && line.attachment?.type === "queued_command") {
    const queued = line.attachment;
    if (queued.commandMode !== "prompt" || queued.isMeta || (queued.origin?.kind && queued.origin.kind !== "human")) return null;
    const text = typeof queued.prompt === "string" ? queued.prompt : Array.isArray(queued.prompt) ? queued.prompt.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";
    if (!text.trim() || MACHINE_TURN.test(text)) return null;
    return { text, slash: null, interrupt: false, queued: true };
  }
  if (!line || line.type !== "user" || line.isMeta || line.isCompactSummary || line.isVisibleInTranscriptOnly) return null;
  if (line.origin && typeof line.origin === "object" && line.origin.kind && line.origin.kind !== "human") return null;
  if (typeof line.turnOrigin === "string" && line.turnOrigin !== "human") return null;
  const content = line.message?.content;
  let text = null;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) { const texts = content.filter((part) => part?.type === "text").map((part) => part.text); if (texts.length > 0) text = texts.join("\n"); }
  if (text === null) return null;
  if (/^\s*\[Request interrupted by user/.test(text)) return { text: "", slash: null, interrupt: true };
  if (MACHINE_TURN.test(text)) return null;
  const command = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/.exec(text);
  if (command) return { text: (/<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? "").trim(), slash: command[1], interrupt: false };
  return { text, slash: /^\s*\/[a-z]/i.test(text) ? (/^\s*\/([^\s]+)/.exec(text)?.[1] ?? null) : null, interrupt: false };
}

/**
 * ── v0.10: VALIDATION EXECUTED, not only requested ────────────────────────────────────────
 *
 * A Bash tool call whose command runs a test runner is a test RUN (`testingBehaviour`, the
 * register's own key: tests written or run against the result; the counter counts runs only),
 * and its tool result says how it ended (`testOutcome.PASSED / FAILED / UNKNOWN`). The command and
 * the result are read HERE and never travel: a count per month and a unit per run. Asking for a
 * test stays `verificationAttempts`; whether a run followed the ask is `verificationFollowed`.
 */
const TEST_COMMAND = /(^|[\s;&|(])((pnpm|npm|yarn|bun)\s+(run\s+)?test(:[\w:-]+)?\b|(npx\s+|pnpm\s+(exec\s+)?|yarn\s+)?(vitest|jest|mocha|ava|playwright\s+test|cypress\s+run)\b|pytest\b|python3?\s+-m\s+(pytest|unittest)\b|go\s+test\b|cargo\s+(test|nextest)\b|deno\s+test\b|node\s+--test\b|mvn\s+(-\S+\s+)*test\b|(\.\/)?gradlew?\s+(\S+\s+)*test\b|dotnet\s+test\b|(bundle\s+exec\s+)?rspec\b|phpunit\b|node\s+(\S*\/)?test[-_][\w.-]*\.(m?js|ts)\b)/;
export const isTestCommand = (command) => TEST_COMMAND.test(String(command ?? ""));
export function testOutcomeOf(body, isError) {
  const text = String(body ?? "");
  if (isError === true) return "FAILED";
  if (/\b[1-9]\d* (failed|failing|failures?|errors?)\b|^\s*FAIL\b|\bFAILED\b|\btests? failed\b|\bnot ok \d/m.test(text)) return "FAILED";
  if (/\b\d+ (passed|passing)\b|^\s*PASS\b|\bok\s+\S+\s+[\d.]+s\b|\ball tests pass(ed)?\b|\btest result: ok\b|^ok$|\bPASS:/m.test(text)) return "PASSED";
  return "UNKNOWN";
}

/**
 * ── v0.10: INITIATIVE — what the turn that carried a behaviour came after ──────────────────
 *
 * R12 already withholds framing, depth and pushback from a turn that answers the model's own
 * offer (`modelInducedTurns`, the unit's `induced` flag). What it did not say is WHICH prompt a
 * behaviour followed. Per human turn that fires at least one lexical rule: SPONTANEOUS (no answer
 * directly before it), AFTER_HINT (the answer before it pointed at the cause or the way: "hint",
 * "consider", "the issue is"), AFTER_OFFER (it offered a choice: "shall I", "options:"), AFTER_QUESTION
 * (it ended in a question). Lexical on the model's text, on this machine; a distribution, never a score.
 */
const HINT_MARK = /\b(hint|tip|consider|have you considered|you might (want to )?(check|look)|look at|note that|the (issue|problem|failure|cause|bug) (is|appears|seems|lies)|it (appears|seems) (that|to)|overweeg|denk aan|kijk (eens )?naar|let op|het probleem (zit|ligt|is)|de oorzaak)\b/i;
const OFFER_WORDS = /\b(shall i|want me to|would you like|do you want|do you prefer|which do you|options?:|zal ik|wil je (dat ik|de|een)|welke (wil|heb) je)\b/i;
export function initiativeOf(answerText, directlyAfterAnswer) {
  if (!directlyAfterAnswer) return "SPONTANEOUS";
  const tail = String(answerText ?? "").trimEnd().slice(-400);
  if (HINT_MARK.test(tail)) return "AFTER_HINT";
  if (OFFER_WORDS.test(tail)) return "AFTER_OFFER";
  if (/\?\s*$/.test(tail)) return "AFTER_QUESTION";
  return "SPONTANEOUS";
}

/**
 * ── v0.10: THE TASK SEQUENCE within a session ─────────────────────────────────────────────
 *
 * Five phases, each read from signals the counter already counts, by the turn it FIRST appears
 * in: CRITERIA (criteriaStated, constraintsDefined), ALTERNATIVES (alternativesRequested,
 * tradeOffsNamed), DECISION (decisionAnnouncement), CORRECTION (counterarguments, or a turn after an
 * answer opening with a correction), VALIDATION (verificationAttempts, or a test run). One value per
 * session: NONE, ONE (a single phase), CANONICAL (two or more, in the order above) or OTHER.
 */
export const SEQUENCE_PHASES = ["CRITERIA", "ALTERNATIVES", "DECISION", "CORRECTION", "VALIDATION"];
const PHASE_OF = { criteriaStated: "CRITERIA", constraintsDefined: "CRITERIA", alternativesRequested: "ALTERNATIVES", tradeOffsNamed: "ALTERNATIVES", decisionAnnouncement: "DECISION", counterarguments: "CORRECTION", verificationAttempts: "VALIDATION", testingBehaviour: "VALIDATION" };
export function taskSequenceOf(firstSeen) {
  const present = SEQUENCE_PHASES.filter((phase) => firstSeen.has(phase));
  if (present.length === 0) return "NONE";
  if (present.length === 1) return "ONE";
  const byTime = [...present].sort((a, b) => firstSeen.get(a) - firstSeen.get(b) || SEQUENCE_PHASES.indexOf(a) - SEQUENCE_PHASES.indexOf(b));
  return byTime.every((phase, i) => phase === present[i]) ? "CANONICAL" : "OTHER";
}
/** The framing a turn may add to an acceptance: its own criteria, limits, trade-offs, assumptions, edge cases, cuts or order. */
const OWN_TERMS = new Set(["criteriaStated", "constraintsDefined", "tradeOffsNamed", "assumptionsSurfaced", "edgeCases", "scopeCuts", "prioritisation"]);

/** Cohen's κ over labelled pairs `[a, b]` — chance-corrected agreement, never the raw share. */
export function cohenKappa(pairs) {
  const n = pairs.length;
  if (n < 2) return null; // one item has no marginal — the same edge as core's MIN_ITEMS_FOR_KAPPA
  const categories = [...new Set(pairs.flat())];
  if (categories.length < 2) return null; // one label on both sides: κ undefined, never 1 or 0 for "not computable"
  let agree = 0;
  const marginA = new Map(), marginB = new Map();
  for (const [a, b] of pairs) { if (a === b) agree += 1; marginA.set(a, (marginA.get(a) ?? 0) + 1); marginB.set(b, (marginB.get(b) ?? 0) + 1); }
  const po = agree / n;
  const pe = categories.reduce((sum, c) => sum + ((marginA.get(c) ?? 0) / n) * ((marginB.get(c) ?? 0) / n), 0);
  if (pe === 1) return null;
  return Math.round(((po - pe) / (1 - pe)) * 10_000) / 10_000;
}
export const KAPPA_FLOOR = 0.6; // proposed — the measurement review: substantial agreement, per field per language class
export const STAGE_MAX_BYTES = 3_500_000; // the host takes about 4.5 MB per request; a margin under it
export const COUNT_CEILING = 100_000; // the door refuses a count above this; a month past it is clamped and SAID, never refused whole
const clampCount = (signal, count, month) => { if (count <= COUNT_CEILING) return count; console.log(` note: ${month} ${signal} ${count} clamped to ${COUNT_CEILING} — the door's ceiling; the true count stays on this machine`); return COUNT_CEILING; };
export const UNCLASSIFIED_CEILING = 0.1; // proposed — chapter 8: under it the counter's forms may be trusted as forms

/**
 * ── v0.9: THE SKILL MATRIX (chapter 4), read locally ──────────────────────────────────────
 *
 * A skill, an agent definition or a CLAUDE.md already carries the role; an opening that restates
 * it pays tokens and turns for context that is already there. `contextRestated` counts the opening
 * sentences that a loaded skill's own text already carries — lexical overlap, sentence against
 * sentence, on this machine, where the skill file lives. The skill's NAME may travel (the door
 * already stores skill invocations); its text never does. `patternChange` is a skill loaded while
 * the role sentence of the opening shares nothing with it; `recurringPatternCandidate` is a role
 * sentence recurring in three or more sessions of a month without any skill loaded — the pattern
 * is the candidate, never the person.
 */
const WORD = /[\p{L}\p{N}]{3,}/gu;
const wordsOf = (sentence) => new Set((sentence.toLowerCase().match(WORD) ?? []));
const jaccard = (a, b) => { if (a.size === 0 || b.size === 0) return 0; let both = 0; for (const w of a) if (b.has(w)) both += 1; return both / (a.size + b.size - both); };
export const RESTATED_OVERLAP = 0.5; // proposed — half the words of a sentence already in the skill's own sentence
export const DRIFT_OVERLAP = 0.2; // proposed — under this a role sentence shares nothing meaningful with the loaded skill
export const RECURRENCE_FLOOR = 3; // chapter 4.3 — a role text recurring in three or more sessions without a skill
/** Opening sentences (six words or more) that a skill text already carries — the count, never the sentences. */
export function restatedSentences(opening, skillText) {
  const skillSets = sentencesOf(String(skillText ?? "")).map(wordsOf).filter((set) => set.size >= 4);
  if (skillSets.length === 0) return 0;
  return sentencesOf(String(opening ?? "")).map(wordsOf).filter((set) => set.size >= 6).filter((set) => skillSets.some((skill) => jaccard(set, skill) >= RESTATED_OVERLAP)).length;
}
const skillTextCache = new Map();
const checkpointDependencies = {};
/** The text of a skill by name, from this machine only: the user's skills, then the project's. Read once; never sent. */
function skillTextOf(name, cwd) {
  const key = `${cwd ?? ""}|${name}`;
  if (skillTextCache.has(key)) return skillTextCache.get(key);
  const candidates = [join(homedir(), ".claude", "skills", name, "SKILL.md"), ...(cwd ? [join(cwd, ".claude", "skills", name, "SKILL.md")] : [])];
  let text = "";
  for (const file of candidates) { try { text = readFileSync(file, "utf8"); checkpointDependencies[file] = fingerprint(Buffer.from(text)); break; } catch { /* not here */ } }
  skillTextCache.set(key, text);
  return text;
}
const normaliseRole = (sentence) => [...wordsOf(sentence)].sort().join(" ");

/**
 * ── v0.9: THE GIT SIDE (chapter 6: testFirstOrder, adrWritten) ─────────────────────────────
 *
 * Two keys nothing could write: whether a test file was committed BEFORE the file it tests, and
 * whether an architecture decision record was added. Both are visible in the person's own
 * repositories on this machine, and nowhere else the counter can reach. So the counter asks git —
 * `git log` with names and statuses only, the person's own commits by the e-mail git itself holds
 * — inside the window, per project directory a transcript named. A path decides a class here the
 * way it does in the connector, and no path travels: a count per month, a unit per commit.
 */
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py|rb)$/i;
const ADR_FILE = /(^|\/)(adrs?|docs\/adrs?|architecture\/decisions|decisions)\/[^/]+\.md$|\.adr\.md$/i;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|py|go|rb|rs|java|kt|php|cs|swift)$/i;
/** The implementation a test file stands for: `foo.test.ts` → `foo.ts`; `__tests__/foo.ts` → `foo.ts`; `foo_test.go` → `foo.go`. */
const implementationOf = (testPath) => {
  const base = testPath.split("/").at(-1) ?? "";
  const m = /^(.+?)(?:\.(?:test|spec)|_test)?\.([a-z]+)$/i.exec(base);
  return m ? `${m[1]}.${m[2]}`.toLowerCase() : null;
};
export function gitSideCounts(commits) {
  // commits: [{ sha, at (ISO), files: [{ status, path }] }], oldest first. Returns per-commit counts.
  const testFirstSeen = new Map(); // implementation basename → earliest test commit time
  const out = [];
  const sorted = [...commits].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const commit of sorted) {
    let testFirstOrder = 0, adrWritten = 0;
    for (const file of commit.files) {
      if (TEST_FILE.test(file.path)) { const impl = implementationOf(file.path); if (impl && !testFirstSeen.has(impl)) testFirstSeen.set(impl, Date.parse(commit.at)); }
      if (file.status === "A" && ADR_FILE.test(file.path)) adrWritten += 1;
    }
    for (const file of commit.files) {
      if (TEST_FILE.test(file.path) || !SOURCE_FILE.test(file.path)) continue;
      const base = (file.path.split("/").at(-1) ?? "").toLowerCase();
      const earlier = testFirstSeen.get(base);
      if (earlier !== undefined && earlier < Date.parse(commit.at)) { testFirstOrder += 1; testFirstSeen.delete(base); }
    }
    out.push({ sha: commit.sha, at: commit.at, testFirstOrder, adrWritten });
  }
  return out;
}
function gitCommitsOf(cwd, sinceIso) {
  const git = (...argv) => { try { return execFileSync("git", ["-C", cwd, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } };
  if (git("rev-parse", "--is-inside-work-tree") !== "true") return [];
  const email = git("config", "user.email");
  if (!email) return [];
  const log = git("log", `--since=${sinceIso}`, `--author=${email}`, "--no-merges", "--name-status", "--pretty=format:%x01%H%x09%cI");
  if (!log) return [];
  const commits = [];
  for (const line of log.split("\n")) {
    if (line.startsWith("\u0001")) { const [sha, at] = line.slice(1).split("\t"); commits.push({ sha, at, files: [] }); continue; }
    const m = /^([AMDRT])\d*\t(.+?)(?:\t(.+))?$/.exec(line);
    if (m && commits.length > 0) commits[commits.length - 1].files.push({ status: m[1], path: m[3] ?? m[2] });
  }
  return commits;
}


const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
// CLI behaviour (not the rubric — ANALYZER_VERSION versions the counting rules alone):
// with no flags the counter runs DRY and shows everything; only --send transmits. The door's
// address and token are found in this machine's own client configuration when not given —
// the same coupling the person already made — so sending is one word, not a paste.
const SEND = flag("send") || flag("yes");
const STAGE = flag("stage");
const DRY = !SEND && !STAGE;

const EXCLUDE = [];
const LEAVE_OUT = [];
for (let i = 0; i < args.length; i += 1) if (args[i] === "--exclude" && args[i + 1]) EXCLUDE.push(args[i + 1].toLowerCase());
/**
 * A claude.ai DATA EXPORT (Settings → Privacy → Export data) read beside the transcripts:
 * `--claude-export <folder or conversations.json>`, repeatable. Claude on the web keeps no
 * store on this machine, so its conversations reach the rubric only this way. One conversation
 * is one session; the person's own messages are the turns; `--exclude` matches a conversation's
 * title as it matches a project directory. The same rubric, the same filter, the same units by
 * digest — the export's text is read here and goes nowhere.
 */
const EXPORTS = [];
for (let i = 0; i < args.length; i += 1) if (args[i] === "--claude-export" && args[i + 1]) EXPORTS.push(args[i + 1]);
/**
 * A CHATGPT DATA EXPORT (Settings → Data controls → Export data; docs/OPEN.md §0p step 2), the same way:
 * `--chatgpt-export <folder or conversations.json>`, repeatable. A conversation is a tree (`mapping`, a node per
 * message with its parent); only the branch that ends at `current_node` is read, so an answer regenerated or a message
 * edited is counted once, as the person kept it. The person's own messages are the turns, `create_time` (epoch
 * seconds) the clock, `model_slug` the model. No tokens: the export carries none, and none are estimated from text.
 */
const CHATGPT_EXPORTS = [];
for (let i = 0; i < args.length; i += 1) if (args[i] === "--chatgpt-export" && args[i + 1]) CHATGPT_EXPORTS.push(args[i + 1]);
try {
  const config = JSON.parse(readFileSync(join(homedir(), ".worktrust-counter.json"), "utf8"));
  for (const entry of Array.isArray(config.exclude) ? config.exclude : []) EXCLUDE.push(String(entry).toLowerCase());
  // GUARDRAILS (2026-09-27): `leaveOut` names WORDS a turn must not carry (a client, a project, a
  // person, a subject); a turn carrying one is a filter miss, like the built-in categories below.
  // The app writes this file from the person's own list; the words never leave this machine.
  for (const entry of Array.isArray(config.leaveOut) ? config.leaveOut : []) { const word = String(entry).trim(); if (word) LEAVE_OUT.push(word); }
} catch { /* no config file is the common case */ }
const LEAVE_OUT_RE = LEAVE_OUT.length ? new RegExp(`(^|[^\\p{L}\\p{N}])(${LEAVE_OUT.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "iu") : null;
const excluded = (dir) => EXCLUDE.some((needle) => dir.toLowerCase().includes(needle));
/**
 * v0.8 harness. `--classify` reads JSON lines `{"text": …, "second": …}` from stdin and prints the
 * form, the act kind and the second-turn type per line — the test suite's door, and a way to see
 * what the rules make of one opening. `--agreement <file>` reads JSON lines with the counter's
 * `form` beside a rater's `label` (and `lang`) and reports Cohen's κ per language class and the
 * UNCLASSIFIED share against the floors; exit 1 under them. `--label-openings <file>` makes the
 * counting run write each session's opening (first 240 characters) with the counter's form beside
 * it to that LOCAL file, for the raters — the text goes there and nowhere else. Neither mode
 * reads a transcript or touches the network.
 */
const LABEL_OUT = (() => { const i = args.indexOf("--label-openings"); return i >= 0 && args[i + 1] ? args[i + 1] : null; })();
const labelRows = [];
if (flag("classify")) {
  const input = readFileSync(0, "utf8");
  for (const raw of input.split("\n")) {
    if (!raw.trim()) continue;
    let row; try { row = JSON.parse(raw); } catch { continue; }
    const form = classifyOpening(row.text);
    console.log(JSON.stringify({ form, kind: openingActKind(row.text, form), second: row.second === undefined ? null : classifySecondTurn(row.second), pasted: Math.round(pastedShare(row.text ?? "") * 100) / 100, restated: row.skill === undefined ? null : restatedSentences(row.text, row.skill), gitSide: row.commits === undefined ? null : gitSideCounts(row.commits), testRun: row.command === undefined ? null : { test: isTestCommand(row.command), outcome: row.result === undefined ? null : testOutcomeOf(row.result, row.isError) } }));
  }
  process.exit(0);
}
{
  const i = args.indexOf("--agreement");
  if (i >= 0 && args[i + 1]) {
    const rows = readFileSync(args[i + 1], "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)).filter((row) => row.label && row.form);
    const byLang = new Map();
    for (const row of rows) { const lang = row.lang ?? "any"; byLang.set(lang, [...(byLang.get(lang) ?? []), [row.form, row.label]]); }
    const unclassified = rows.length ? rows.filter((row) => row.form === "UNCLASSIFIED").length / rows.length : null;
    const perLanguage = Object.fromEntries([...byLang.entries()].map(([lang, pairs]) => [lang, { n: pairs.length, kappa: cohenKappa(pairs) }]));
    const passes = rows.length >= 100 && unclassified !== null && unclassified <= UNCLASSIFIED_CEILING && Object.values(perLanguage).every((entry) => entry.kappa !== null && entry.kappa >= KAPPA_FLOOR);
    console.log(JSON.stringify({ n: rows.length, unclassified, perLanguage, floors: { kappa: KAPPA_FLOOR, unclassified: UNCLASSIFIED_CEILING, items: 100 }, counterGrade: passes }));
    process.exit(passes ? 0 : 1);
  }
}
/**
 * ONLY THE HOUSE'S OWN DOOR (2026-09-27, audit): the coupling used to be "any MCP server whose URL
 * contains /api/mcp", the conventional path of every hosted MCP server, so a person who also held
 * another product's server would have sent their work metadata there under that product's token and
 * fetched a script to run from its origin. A door is WorkTrust's when its host is worktrust.io or a
 * subdomain, or a local one named by WORKTRUST_MCP_URL; nothing else is a coupling.
 */
/** WorkTrust's own local doors (the app in development, 3011; a module branch, 3021). Another product's local MCP server
 * (the Advisory Board on 3007, 2026-10-09) is not one: it was offered for removal on update, and could have been adopted. */
const LOCAL_DOOR_PORTS = new Set(["3011", "3021"]);
const isWorkTrustDoor = (url) => {
  try {
    const parsed = new URL(String(url));
    if (!/\/api\/mcp\/?$/.test(parsed.pathname)) return false;
    const own = process.env.WORKTRUST_MCP_URL ? new URL(process.env.WORKTRUST_MCP_URL).host : null;
    return parsed.protocol === "https:" && (parsed.hostname === "worktrust.io" || parsed.hostname.endsWith(".worktrust.io")) || (own !== null && parsed.host === own) || ((parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") && LOCAL_DOOR_PORTS.has(parsed.port));
  } catch { return false; }
};
function fromClientConfig() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8"));
    const found = [];
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (typeof node.url === "string" && isWorkTrustDoor(node.url)) {
        const auth = node.headers?.Authorization ?? node.headers?.authorization ?? "";
        if (auth.startsWith("Bearer ")) found.push({ url: node.url, token: auth.slice(7) });
      }
      for (const child of Object.values(node)) walk(child);
    };
    walk(config);
    return found[0] ?? null;
  } catch { return null; }
}
const discovered = fromClientConfig();
const URL_ = value("url") ?? process.env.WORKTRUST_MCP_URL ?? discovered?.url;
const TOKEN = value("token") ?? process.env.WORKTRUST_MCP_TOKEN ?? discovered?.token;
const MONTHS_BACK = Number(value("months") ?? 24);
if (!Number.isInteger(MONTHS_BACK) || MONTHS_BACK < 1 || MONTHS_BACK > 120) throw Error("months must be an integer from 1 to 120");

/**
 * VS CODE COPILOT CHAT SESSIONS (2026-09-08) — the second store on a machine that keeps its own
 * timestamps: workspaceStorage/<workspace>/chatSessions/*.jsonl, one file per chat, a first line
 * with the session's state and delta lines that append requests and response parts. A request
 * carries the person's text, a timestamp in milliseconds, the model as Copilot names it, and the
 * response as parts — markdown strings, tool invocations, edit groups. Replayed here into the
 * transcript's own shape, so ONE rubric reads Claude Code, claude.ai and Copilot alike; the
 * workspace's folder names the context (digested, never sent), and --exclude applies to it.
 * On the machine this was built on, this store held 68 sessions and 12,728 dated requests from
 * April to August that the counter had never seen — the months the mirror was missing.
 */
function copilotRoots() {
  const home = homedir();
  const candidates = process.platform === "win32"
    ? [join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "Code", "User", "workspaceStorage")]
    : process.platform === "darwin"
      ? [join(home, "Library", "Application Support", "Code", "User", "workspaceStorage")]
      : [join(home, ".config", "Code", "User", "workspaceStorage")];
  return candidates.filter((root) => { try { return statSync(root).isDirectory(); } catch { return false; } });
}
let copilotSessionCount = 0;
function* copilotSessions() {
  for (const root of copilotRoots()) {
    let workspaces = []; try { workspaces = readdirSync(root); } catch { continue; }
    for (const workspace of workspaces) {
      const dir = join(root, workspace, "chatSessions");
      let files = []; try { files = readdirSync(dir).filter((file) => file.endsWith(".jsonl")); } catch { continue; }
      if (files.length === 0) continue;
      let folder = ""; try { folder = String(JSON.parse(readFileSync(join(root, workspace, "workspace.json"), "utf8")).folder ?? ""); } catch { /* an unnamed workspace still counts, unnamed */ }
      const folderPath = folder.replace(/^file:\/\//, "").replace(/%20/g, " ");
      const basename = folderPath.split("/").filter(Boolean).at(-1) ?? "";
      if (basename && excluded(basename)) { skippedDirs.push(`copilot:${basename}`); continue; }
      if (basename) countedDirs.push(`copilot:${basename}`);
      for (const file of files) {
        let raw; try { raw = readFileSync(join(dir, file), "utf8"); } catch { continue; }
        const requests = [];
        for (const entry of raw.split("\n")) {
          if (!entry) continue;
          let delta; try { delta = JSON.parse(entry); } catch { continue; }
          if (delta.kind === 0) { for (const request of delta.v?.requests ?? []) requests.push(request); continue; }
          const path = Array.isArray(delta.k) ? delta.k : [];
          if (path[0] !== "requests") continue;
          if (path.length === 1 && delta.kind === 2 && Array.isArray(delta.v)) { for (const request of delta.v) requests.push(request); continue; }
          const index = Number(path[1]);
          if (!Number.isInteger(index) || !requests[index]) continue;
          if (path.length === 3 && path[2] === "response" && delta.kind === 2 && Array.isArray(delta.v)) { requests[index].response = [...(requests[index].response ?? []), ...delta.v]; continue; }
          if (path.length === 3 && delta.kind === 1) requests[index][path[2]] = delta.v;
        }
        if (requests.length === 0) continue;
        copilotSessionCount += 1;
        const lines = [];
        for (const request of requests) {
          const at = Number.isFinite(Number(request.timestamp)) ? new Date(Number(request.timestamp)).toISOString() : null;
          const text = typeof request.message?.text === "string" ? request.message.text : "";
          lines.push({ type: "user", timestamp: at, cwd: folderPath || undefined, message: { content: [{ type: "text", text }] } });
          const parts = [];
          const said = [];
          for (const part of request.response ?? []) {
            if (typeof part?.value === "string") { said.push(part.value); continue; }
            if (part?.kind === "toolInvocationSerialized") parts.push({ type: "tool_use", name: String(part.toolId ?? "tool"), input: {} });
            if (part?.kind === "textEditGroup") parts.push({ type: "tool_use", name: "Edit", input: { file_path: String(part.uri?.path ?? part.uri?.fsPath ?? "") } });
          }
          parts.push({ type: "text", text: said.join("\n") });
          lines.push({ type: "assistant", timestamp: at, message: { model: typeof request.modelId === "string" ? request.modelId : undefined, content: parts } });
        }
        yield { key: `copilot:${workspace}:${file}`, projectDir: basename ? `copilot-${basename}` : `copilot-${workspace}`, basename: basename || null, lines };
      }
    }
  }
}

/** Claude Code transcripts: *.jsonl under the Claude projects directory. */
function* transcriptFiles() {
  const root = value("transcript-root") ?? join(homedir(), ".claude", "projects");
  let dirs = [];
  try { dirs = readdirSync(root); } catch (error) { if (error.code === "ENOENT" && !value("transcript-root")) return; throw error; }
  for (const dir of dirs) {
    if (excluded(dir)) { skippedDirs.push(dir); continue; }
    countedDirs.push(dir);
    let files = [];
    try { files = readdirSync(join(root, dir)); } catch (error) { if (error.code === "ENOTDIR") continue; throw error; }
    for (const file of files) if (file.endsWith(".jsonl")) yield join(root, dir, file);
  }
}
const skippedDirs = [];
const countedDirs = [];
let exportConversations = 0;
const skippedConversations = [];
function* claudeExportSessions() {
  for (const given of EXPORTS) {
    let path = given.replace(/^~(?=\/|$)/, homedir());
    try { if (statSync(path).isDirectory()) path = join(path, "conversations.json"); } catch { throw Error(`claude export not found: ${given}`); }
    let conversations; try { conversations = JSON.parse(readFileSync(path, "utf8")); } catch { throw Error(`claude export unreadable: ${path}`); }
    if (!Array.isArray(conversations)) throw Error("claude export must contain an array of conversations");
    for (const conversation of conversations) {
      const title = String(conversation?.name ?? "");
      if (excluded(title)) { skippedConversations.push(title.slice(0, 40)); continue; }
      const messages = Array.isArray(conversation?.chat_messages) ? conversation.chat_messages : [];
      if (messages.length === 0) continue;
      exportConversations += 1;
      // The export's messages in the transcript's own shape, so one rubric reads both.
      const lines = messages.map((m) => {
        const text = typeof m?.text === "string" && m.text.length > 0 ? m.text : (Array.isArray(m?.content) ? m.content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n") : "");
        const at = m?.created_at ?? conversation?.created_at ?? null;
        return { type: m?.sender === "human" ? "user" : "assistant", timestamp: at, message: { content: [{ type: "text", text }] } };
      });
      yield { key: `claude.ai:${conversation?.uuid ?? title}`, projectDir: "claude-ai", basename: "claude.ai", lines };
    }
  }
}
let chatgptConversations = 0;
/** The kept branch of one ChatGPT conversation, oldest first: from `current_node` up through the parents. */
function chatgptBranch(conversation) {
  const mapping = conversation?.mapping && typeof conversation.mapping === "object" ? conversation.mapping : {};
  const branch = [];
  const seen = new Set();
  for (let id = conversation?.current_node; id && mapping[id] && !seen.has(id); id = mapping[id].parent) { seen.add(id); branch.push(mapping[id]); }
  return branch.reverse();
}
function* chatgptExportSessions() {
  for (const given of CHATGPT_EXPORTS) {
    let path = given.replace(/^~(?=\/|$)/, homedir());
    try { if (statSync(path).isDirectory()) path = join(path, "conversations.json"); } catch { throw Error(`chatgpt export not found: ${given}`); }
    let conversations; try { conversations = JSON.parse(readFileSync(path, "utf8")); } catch { throw Error(`chatgpt export unreadable: ${path}`); }
    if (!Array.isArray(conversations)) throw Error("chatgpt export must contain an array of conversations");
    for (const conversation of conversations) {
      const title = String(conversation?.title ?? "");
      if (excluded(title)) { skippedConversations.push(title.slice(0, 40)); continue; }
      const lines = [];
      for (const node of chatgptBranch(conversation)) {
        const m = node?.message;
        const role = m?.author?.role;
        // The person and the model only: system prompts, tools and what the app hides are neither.
        if ((role !== "user" && role !== "assistant") || m?.metadata?.is_visually_hidden_from_conversation) continue;
        const parts = Array.isArray(m?.content?.parts) ? m.content.parts.filter((part) => typeof part === "string") : [];
        const text = parts.join("\n");
        if (text.length === 0) continue;
        const seconds = Number(m?.create_time ?? conversation?.create_time);
        const at = Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
        const model = typeof m?.metadata?.model_slug === "string" ? m.metadata.model_slug : undefined;
        lines.push({ type: role === "user" ? "user" : "assistant", timestamp: at, message: { ...(role === "assistant" && model ? { model } : {}), content: [{ type: "text", text }] } });
      }
      if (lines.length === 0) continue;
      chatgptConversations += 1;
      yield { key: `chatgpt:${conversation?.conversation_id ?? conversation?.id ?? title}`, projectDir: "chatgpt", basename: "chatgpt", lines };
    }
  }
}
/**
 * THE READERS FOR CODEX AND ANTIGRAVITY live in transcript-readers.mjs beside this file (2026-10-04;
 * the session hook imports the same file). Run alone, without it, the counter reads Claude Code,
 * Copilot and an export, and says that Codex and Antigravity were not read.
 */
const { codexLines, codexRolloutFiles, codexCwd, antigravityLines, antigravityRoots, antigravityTranscripts, antigravityContext } = (await import("./transcript-readers.mjs").catch(() => null)) ?? {};

/**
 * Codex rollouts, as sessions. The real ~/.codex/sessions is read when nothing was overridden;
 * a run that points the counter at another transcript root (a test) reads Codex only when it names
 * a root too, so a synthetic case is never joined by the machine's own threads. `--no-codex` leaves
 * them out; `--exclude` matches the thread's working directory, read from its first line before
 * anything else is opened.
 */
let codexRolloutCount = 0;
function* codexSessions() {
  if (flag("no-codex") || !codexRolloutFiles) return;
  const given = value("codex-root");
  if (!given && value("transcript-root")) return;
  const root = (given ?? join(homedir(), ".codex", "sessions")).replace(/^~(?=\/|$)/, homedir());
  for (const file of codexRolloutFiles(root)) {
    const cwd = codexCwd(file);
    const basename = cwd ? String(cwd).split("/").filter(Boolean).at(-1) ?? null : null;
    if (basename && excluded(basename)) { skippedDirs.push(`codex:${basename}`); continue; }
    const projectDir = basename ? `codex-${basename}` : "codex";
    if (!countedDirs.includes(projectDir)) countedDirs.push(projectDir);
    codexRolloutCount += 1;
    yield { key: file, projectDir, basename, path: file, codex: true };
  }
}
/** Antigravity conversations (2026-10-04), the same way: --antigravity-root for a test, --no-antigravity to leave them out; the folder the Stop hook named decides --exclude. */
let antigravityCount = 0;
function* antigravitySessions() {
  const given = value("antigravity-root");
  if (flag("no-antigravity") || !antigravityTranscripts || (!given && value("transcript-root"))) return;
  for (const { conversationId, file } of antigravityTranscripts(antigravityRoots(given))) {
    const context = antigravityContext(conversationId);
    const basename = context.cwd ? String(context.cwd).split("/").filter(Boolean).at(-1) ?? null : null;
    if (basename && excluded(basename)) { skippedDirs.push(`antigravity:${basename}`); continue; }
    const projectDir = basename ? `antigravity-${basename}` : "antigravity";
    if (!countedDirs.includes(projectDir)) countedDirs.push(projectDir);
    antigravityCount += 1;
    yield { key: file, projectDir, basename, path: file, antigravity: { id: conversationId, ...context } };
  }
}
/** Every session the rubric reads: a transcript file, or one conversation from a claude.ai export. */
/**
 * v0.10: a transcript is READ AS A STREAM of lines. Reading a whole file into one string failed
 * outright on a transcript past V8's string ceiling (about 512 MB; a long agent session with
 * pasted images reaches 1.7 GB), so the counter could not run at all on such a machine. Each line
 * is decoded alone; the bytes feed the file's digest as they pass, so the checkpoint still knows
 * an edited file from an unchanged one without a second copy in memory.
 */
const CHUNK_BYTES = 16 * 1024 * 1024;
function* fileLines(path, hash) {
  const fd = openSync(path, "r");
  let rest = Buffer.alloc(0);
  try {
    for (;;) {
      const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
      const read = readSync(fd, buffer, 0, CHUNK_BYTES, null);
      if (read === 0) break;
      hash?.update(buffer.subarray(0, read));
      const chunk = rest.length ? Buffer.concat([rest, buffer.subarray(0, read)]) : buffer.subarray(0, read);
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) { yield decodeLine(chunk, start, end); start = end + 1; }
      rest = Buffer.from(chunk.subarray(start));
    }
    if (rest.length) yield decodeLine(rest, 0, rest.length);
  } finally { closeSync(fd); }
}
/** One line as text; a single line past the string ceiling is skipped (counted as unreadable), never fatal. */
let unreadableLines = 0;
const decodeLine = (buffer, start, end) => { try { return buffer.toString("utf8", start, end); } catch { unreadableLines += 1; return ""; } };
/** The digest of a transcript file, streamed: its path and every byte. */
function fileDigest(path) { const hash = createHash("sha256").update(`file:${path}\n`); for (const _ of fileLines(path, hash)) { /* the bytes are the input */ } return hash.digest("hex"); }
const sessionDigest = (session) => session.path ? fileDigest(session.path) : fingerprint(session);
function* sessions() {
  for (const file of transcriptFiles()) {
    yield { key: file, projectDir: file.split("/").slice(-2, -1)[0] ?? "", basename: null, path: file };
  }
  // A rollout is a transcript on this machine, so --only-transcripts keeps it.
  yield* codexSessions();
  yield* antigravitySessions();
  if (!flag("only-transcripts")) { yield* claudeExportSessions(); yield* chatgptExportSessions(); yield* copilotSessions(); }
}

/**
 * v0.10: ONE LINE, COUNTED ONCE. Claude Code writes a resumed or forked session into a new file
 * that carries the earlier conversation's lines again, under the same `uuid`, and a copied
 * transcript carries every line twice. Keyed by file path, both counted the same turns twice (on
 * the machine this was built on, about forty thousand person-role lines and fifty-eight thousand
 * model lines stood in more than one file). A line's identity is its `uuid` where the transcript
 * gives one, and otherwise a digest of its position, role, timestamp and content (the position keeps
 * two identical short replies inside one conversation apart when a store dates them alike): two
 * sessions that merely say similar things at different moments stay two. The first file in reading order keeps
 * the line; a later file skips it, and a session whose first turns were all copies is a
 * CONTINUATION, whose first new turn is not an opening.
 */
const lineIdentity = (line, position) => line.uuid ? `u:${line.uuid}` : createHash("sha256").update(`${position}|${line.type}|${line.timestamp ?? ""}|${JSON.stringify(line.message ?? line.attachment ?? null)}`).digest("hex").slice(0, 24);

/**
 * R12 — model induction. A question or acceptance that directly follows the model's own offer
 * ("Shall I…?", "Options: …", "Want the trade-offs?") is the model steering the person, not the
 * person framing, probing or pushing back. Such a turn is counted ONCE as `modelInducedTurns`
 * and excluded from the framing, depth and pushback signals below (AUDIT F-01).
 */
const OFFER = /\b(shall i|want me to|would you like|do you want|do you prefer|which do you|options?:|zal ik|wil je (dat ik|de|een)|welke (wil|heb) je)\b|\?\s*$/i;
const ACCEPT = /^\s*(yes|yeah|sure|ok(ay)?|please|do it|go ahead|ja|graag|prima|ga door|doe (het|maar)|oké)\b/i;
const R12_SKIP = new Set([
  "constraintsDefined", "criteriaStated", "requirementsDerived", "roleFraming",            // framing
  "followUpDepth", "deepFollowUpChains", "gapQuestions", "counterfactualQuestions", "alternativesRequested", "edgeCases", // depth
  "counterarguments", "evidenceDemands", "tradeOffsNamed", "assumptionsSurfaced", "hypothesesRaised", // pushback
]);
/**
 * 7.3 — the filter before the analysis. A turn that carries special-category or family content
 * never enters a count: it is counted once as `filterMiss` (a number, never a category of what
 * was said) and every other signal skips it, so the filter can be improved without anyone
 * reading what it missed (AUDIT F-03). Deliberately narrow; the person can widen it by --exclude.
 */
const SPECIAL_CATEGORY = /\b(migraine|ziek(te)?|sick(ness)?|illness|doctor|dokter|huisarts|therap(y|ie|ist)|pregnan(t|cy)|zwanger|burn-?out|opgebrand|depress(ie|ion|ed)|church|kerk|mosque|moskee|synagogue|synagoge|eid|ramadan|pesach|divorce|scheiding|funeral|begrafenis|my (wife|husband|partner|kids?|son|daughter|mother|father)|mijn (vrouw|man|partner|kind(eren)?|zoon|dochter|moeder|vader)|election|verkiezing(en)?|vakbond|union membership|porn(ography)?|erotic|nsfw|onlyfans)\b/i;

const floor = new Date(); floor.setUTCMonth(floor.getUTCMonth() - MONTHS_BACK, 1);
const thisMonth = new Date().toISOString().slice(0, 7);
const byMonth = new Map(); // month → Map(signal → count)
/**
 * F-02 — every count carries a reference to the UNIT it came from: a 16-hex hash of the
 * transcript file and line (or of the file alone for session-level counts). An id, never a
 * span of text; enough for a later claim to cite evidence by ID (R1) and for the same turn to
 * be counted once across rubrics and connectors (R6). Nothing about the content survives the
 * hash, and the file path itself never travels — only its digest.
 */
const unitOf = (...parts) => createHash("sha256").update(parts.join(":")).digest("hex").slice(0, 16);
let currentUnit = null;   // the unit the next bump belongs to (a turn, or a session)
let currentInduced = false; // R12 flag carried on the unit reference
let currentDay = null;    // the day the unit came from (YYYY-MM-DD) — a date, never a time of day
const unitsByMonth = new Map(); // month → Map("unit|signal" → { unit, signal, induced, day, context })
/**
 * v0.7 — the CONTEXT: the same observation tallied a second time per project, so the mirror can
 * draw behaviour × project (where a behaviour shows up, and where it does not). The context is
 * a 16-hex digest of the project directory — the directory's name never travels; the person
 * names the context in the app, and this run prints which digest is which so they can.
 */
const contextOf = (projectDir) => createHash("sha256").update(`context:${projectDir}`).digest("hex").slice(0, 16);
let currentContext = null; // the project the next bump belongs to
const contextNames = new Map(); // digest → directory key, printed locally, NEVER sent
const contextBasenames = new Map(); // digest → the transcript's own cwd basename, the project's real name — local only
const byMonthContext = new Map(); // month → Map("signal|context" → count)
/**
 * THE WEEK, beside the month (owner, 2026-09-27: add only what was not added before, per week).
 * The door still stores months; the week is how THIS machine knows which of its months moved
 * since the last delivery, and what to say moved. ISO weeks, cut at the month boundary so a
 * week never straddles two stored months: "2026-09|2026-W36". A count without a day (a
 * month-level aggregate) lands in the month's "U" bucket.
 */
export const isoWeek = (day) => {
  const date = new Date(`${day}T00:00:00Z`);
  const thursday = new Date(date); thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
};
const byWeek = new Map(); // "month|week" → Map(signal → count)
/**
 * THE WORK STRETCH (0.7.0, the owner's capability framework v4 §13: "work_stretch_id, the stable unit joining AI
 * activity, verification, failures and delivery"). The same observation is tallied a third time, per stretch: one
 * session's UTC day, named by the hash the session hook files the stretch under (`stretch_ref` in log-session.mjs), so a
 * signal and the stretch's clocks, tokens and commits meet on one key. Only sessions read from a file carry it (Claude
 * Code, Codex, Antigravity); the session's id is hashed with the day and never leaves the computer. Read by `preserve`
 * through --stretch-signals; nothing of it is sent yet.
 */
const byStretch = new Map(); // stretch_ref → { day, signals: { signal: count } }
let currentStretchBase = null; // the session's own id, as the session hook hashes it — local only
const stretchBaseOf = (session) => !session.path ? null : /(^|[\\/])brain[\\/][^\\/]+[\\/]\.system_generated[\\/]logs[\\/]transcript\.jsonl$/.test(session.path) ? String(session.path).split(/[\\/]/).at(-4) : String(session.path).split(/[\\/]/).pop().replace(/\.jsonl?$/, "");
const stretchRefOf = (base, day) => createHash("sha256").update(`worktrust-stretch|${base}|${day}`).digest("base64url");
const bump = (month, signal, n = 1) => {
  {
    const key = `${month}|${currentDay && currentDay.startsWith(month) ? isoWeek(currentDay) : "U"}`;
    const week = byWeek.get(key) ?? new Map();
    week.set(signal, (week.get(signal) ?? 0) + n);
    byWeek.set(key, week);
  }
  if (currentStretchBase && currentDay) {
    const ref = stretchRefOf(currentStretchBase, currentDay), entry = byStretch.get(ref) ?? { day: currentDay, signals: {} };
    entry.signals[signal] = (entry.signals[signal] ?? 0) + n;
    byStretch.set(ref, entry);
  }
  if (currentUnit) {
    const bag = unitsByMonth.get(month) ?? new Map();
    bag.set(`${currentUnit}|${signal}`, { unit: currentUnit, signal, induced: currentInduced, day: currentDay, context: currentContext });
    unitsByMonth.set(month, bag);
  }
  const bucket = byMonth.get(month) ?? new Map();
  bucket.set(signal, (bucket.get(signal) ?? 0) + n);
  byMonth.set(month, bucket);
  if (currentContext) {
    const cells = byMonthContext.get(month) ?? new Map();
    cells.set(`${signal}|${currentContext}`, (cells.get(`${signal}|${currentContext}`) ?? 0) + n);
    byMonthContext.set(month, cells);
  }
};
const inWindow = (month) => /^\d{4}-\d{2}$/.test(month) && month <= thisMonth && new Date(`${month}-01`) >= floor;
const monthToolNames = new Map(); // month → Set(tool)
const openingHashes = new Set(); // normalised session openings, for template reuse
const sessionSpans = []; // { start, end, month } per counted session, for parallelism
const modelFirstSeen = new Map(); // model id → first month
const toolFirstSeen = new Set(); // v0.8: tool, skill and MCP-server names seen anywhere in the record, for firstUseEvent
const monthMcpServers = new Map(); // v0.9: month → Set(mcp server) for mcpServersDistinct
const rolePatterns = new Map(); // v0.9: month → Map(normalised role sentence → Set(session unit)), sessions without a skill
const contextCwds = new Map(); // v0.9: context digest → the real working directory, for the git side; local only
const projectFirstSeen = new Map(); // project dir → first month with activity
const sessionsByMonth = new Map(); // month → sessions that started in it: the confidence layer's independence count, sent as `stretches`
let messages = 0, files = 0, duplicateLines = 0;
const seenLines = new Set(); // v0.10: line identities already counted (a uuid or a 24-hex digest; never text)
// Validate the processed prefix before reuse. Edited/truncated/deleted sessions restart the
// scan; complete session boundaries preserve signals that depend on earlier turns.
const manifest = [];
for(const session of sessions())manifest.push(sessionDigest(session));
exportConversations = 0; chatgptConversations = 0; copilotSessionCount = 0; codexRolloutCount = 0; antigravityCount = 0; skippedDirs.length = 0; countedDirs.length = 0; skippedConversations.length = 0;
const checkpoint = flag("no-checkpoint") || flag("stretch-signals") || LABEL_OUT ? null : checkpointStore(
  value("checkpoint") ?? join(homedir(), ".worktrust", "counter-checkpoint.json"),
  fingerprint({code:readFileSync(new URL(import.meta.url)),version:ANALYZER_VERSION,months:MONTHS_BACK,thisMonth,exclude:EXCLUDE,leaveOut:LEAVE_OUT,exports:EXPORTS}),manifest);
const checkpointMaps = {byMonth,byWeek,byStretch,unitsByMonth,contextNames,contextBasenames,byMonthContext,monthToolNames,modelFirstSeen,monthMcpServers,rolePatterns,contextCwds,projectFirstSeen,sessionsByMonth};
const checkpointSets = {openingHashes,toolFirstSeen,seenLines};
if (checkpoint?.saved) {
  for(const [key,map] of Object.entries(checkpointMaps)) for(const [k,v] of checkpoint.saved.state.maps[key] ?? []) map.set(k,v);
  for(const [key,set] of Object.entries(checkpointSets)) for(const v of checkpoint.saved.state.sets[key] ?? []) set.add(v);
  sessionSpans.push(...checkpoint.saved.state.sessionSpans);
  messages=checkpoint.saved.state.messages;files=checkpoint.saved.state.files;currentContext=checkpoint.saved.state.currentContext;duplicateLines=checkpoint.saved.state.duplicateLines??0;
  Object.assign(checkpointDependencies,checkpoint.saved.dependencies);
}
const resumeAt=checkpoint?.saved?.next??0;
let sessionIndex=0, processed=0;
const maxSessions=Number(value("batch-sessions")??Number.POSITIVE_INFINITY);
if (value("batch-sessions") !== undefined && (!Number.isSafeInteger(maxSessions) || maxSessions < 1)) throw Error("batch-sessions must be a positive integer");
for (const session of sessions()) {
  // A file's digest is taken while its lines stream past and compared when the session ends.
  if(!session.path && fingerprint(session)!==manifest[sessionIndex]) throw Error("Source changed during counting; rerun to resume safely");
  if(sessionIndex++<resumeAt)continue;
  const streamHash = session.path ? createHash("sha256").update(`file:${session.path}\n`) : null;
  const file = session.key;
  currentStretchBase = stretchBaseOf(session);
  files += 1;
  // One file is one session: order preserved, so the STRUCTURAL half reads the shape.
  let sessionMonth = null;
  let humanTurns = 0;
  let toolActions = 0;
  let runLength = 0; // consecutive tool actions since the last human turn
  let lastWasAssistantAnswer = false;
  let opened = false;
  let chain = 0; // consecutive follow-up questions on answers
  let assistantAskedQuestion = false;
  let assistantOffered = false; // R12: the model's last answer offered or asked
  const askedBefore = new Set(); // normalised questions already answered in this session (reassurance loops)
  let firstTs = null;
  let lastTs = null;
  let edited = false; // has this session touched a file yet
  let researchTurnsBeforeEdit = 0;
  // v0.8 session state: the opening's second turn, what context was loaded, the failure→recovery chain, verification before acceptance.
  let awaitingSecond = false, sawAnswerAfterOpening = false, skillSeen = false, agentSeen = false, pendingVerify = false, openFailure = null;
  const recoveredHashes = new Set();
  // v0.9: the skill matrix and turns to the first acceptance.
  const skillsLoaded = new Set();
  let openingText = null, roleSentence = null, turnsAfterOpening = 0, acceptedAtTurn = null;
  // v0.10: whether the agent's run had ENDED with an answer before the person spoke (a turn after a
  // finished run is not a redirect), an interruption marker, the copies skipped before the first
  // new turn (a continuation), the phases' first turns, the model's last answer, the test runs.
  let runFinished = true, interrupted = false, copiedBeforeOpening = false, lastAnswerText = "", turnIndex = 0, verifyOpen = null;
  const phaseFirst = new Map();
  const pendingTests = new Map(); // tool_use id → the run's unit, day and month
  const testQueue = []; // runs without an id (a replayed store), matched to the next result in order
  const projectDir = session.projectDir;
  currentContext = projectDir ? contextOf(projectDir) : null;
  if (projectDir && !contextNames.has(currentContext)) contextNames.set(currentContext, projectDir);
  if (session.basename && currentContext && !contextBasenames.has(currentContext)) contextBasenames.set(currentContext, session.basename);
  const sessionUnit = unitOf(file);
  let lineNo = 0;
  // Streamed either way; a Codex rollout's stream is shaped into transcript lines as it passes.
  const rawLines = session.path ? fileLines(session.path, streamHash) : session.lines;
  for (const entry of session.codex ? codexLines(rawLines) : session.antigravity ? antigravityLines(rawLines, session.antigravity) : rawLines) {
    lineNo += 1;
    if (!entry) continue;
    currentUnit = unitOf(file, lineNo);
    currentInduced = false;
    let line;
    if (typeof entry === "string") { try { line = JSON.parse(entry); } catch { continue; } } else line = entry;
    if (!line || typeof line !== "object") continue;
    if (line.type === "user" || line.type === "assistant" || line.type === "attachment") {
      const identity = lineIdentity(line, lineNo);
      if (seenLines.has(identity)) { duplicateLines += 1; if (!opened) copiedBeforeOpening = true; continue; }
      seenLines.add(identity);
    }
    // The transcript names its own working directory; its last segment is the project's real
    // name ("davosnl.com", "dlg-platform") — the directory key above encodes "/" and "." alike
    // as "-", so it cannot say where a name starts. Kept locally, digested for the slug.
    if (currentContext && line.cwd && !contextBasenames.has(currentContext)) { const base = String(line.cwd).split("/").filter(Boolean).at(-1); if (base) contextBasenames.set(currentContext, base); }
    if (currentContext && line.cwd && !contextCwds.has(currentContext)) contextCwds.set(currentContext, String(line.cwd));
    currentDay = line.timestamp ? String(line.timestamp).slice(0, 10) : null;
    const month = line.timestamp ? String(line.timestamp).slice(0, 7) : null;
    // ── structural half ──
    if (line.type === "assistant" && month && inWindow(month)) {
      const parts = Array.isArray(line.message?.content) ? line.message.content : [];
      const model = line.message?.model;
      if (model && typeof model === "string" && !model.startsWith("<")) {
        if (!modelFirstSeen.has(model)) { modelFirstSeen.set(model, month); bump(month, "newModelAdoption"); }
      }
      let answered = false;
      let askText = "";
      for (const part of parts) {
        if (part?.type === "tool_use") {
          toolActions += 1; runLength += 1; runFinished = false;
          // v0.10: a test runner's command is read here, never sent; the run is counted, its result read below.
          if (String(part.name ?? "") === "Bash" && isTestCommand(part.input?.command)) {
            bump(month, "testingBehaviour");
            const run = { unit: currentUnit, day: currentDay, month };
            if (part.id) pendingTests.set(String(part.id), run); else testQueue.push(run);
            if (!phaseFirst.has("VALIDATION")) phaseFirst.set("VALIDATION", turnIndex);
            if (verifyOpen) { const lineUnit = currentUnit; currentUnit = verifyOpen.unit; currentDay = verifyOpen.day; bump(verifyOpen.month, "verificationFollowed.RUN"); currentUnit = lineUnit; currentDay = run.day; verifyOpen = null; }
          }
          if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(String(part.name ?? ""))) edited = true;
          if (runLength === 10) bump(month, "longAgentRuns"); // once per stretch, at the threshold
          const tool = String(part.name ?? "");
          const set = monthToolNames.get(month) ?? new Set();
          set.add(tool); monthToolNames.set(month, set);
          if (tool.startsWith("mcp__")) bump(month, "mcpToolUse");
          if (tool === "Agent" || tool === "Task") bump(month, "subagentUse");
          if (tool === "Skill") bump(month, "skillInvocation");
          // v0.8: the context loaded before the second turn, who initiated the tool, and first uses.
          if (tool === "Skill") { skillSeen = true; const skillName = String(part.input?.skill ?? part.input?.name ?? "").trim(); if (skillName) skillsLoaded.add(skillName); }
          if (tool.startsWith("mcp__")) { const set = monthMcpServers.get(month) ?? new Set(); set.add(tool.split("__")[1] ?? ""); monthMcpServers.set(month, set); }
          if (tool === "Agent" || tool === "Task") agentSeen = true;
          // A VOLUME signal carries no unit reference: one reference per tool call was fifteen thousand a
          // month and pushed the staged reading past the door's request size (http 413, 2026-09-07).
          { const lineUnit = currentUnit; currentUnit = null; bump(month, "toolInitiator.agent"); currentUnit = lineUnit; }
          if (!toolFirstSeen.has(tool)) { toolFirstSeen.add(tool); bump(month, "firstUseEvent"); }
          if (tool.startsWith("mcp__")) { const server = `mcp:${tool.split("__")[1] ?? ""}`; if (!toolFirstSeen.has(server)) { toolFirstSeen.add(server); bump(month, "firstUseEvent"); } }
          if (tool === "Bash" && part.input?.run_in_background === true) bump(month, "backgroundRuns");
          if ((tool === "Edit" || tool === "Write" || tool === "MultiEdit") && /(\/\.claude\/|CLAUDE\.md|\.cursorrules|\/skills\/|\/agents\/)/.test(JSON.stringify(part.input?.file_path ?? ""))) bump(month, "agentImprovement");
        }
        if (part?.type === "text" && part.text) { answered = true; askText = part.text; }
      }
      // The run has ENDED when the model's last word on this line is text, not a tool call.
      const lastPart = [...parts].reverse().find((part) => part?.type === "text" || part?.type === "tool_use");
      if (lastPart?.type === "text" && lastPart.text) runFinished = true;
      if (answered) {
        if (opened) sawAnswerAfterOpening = true;
        lastWasAssistantAnswer = true;
        assistantAskedQuestion = /\?\s*$/.test(askText.trimEnd().slice(-200));
        assistantOffered = OFFER.test(askText.trimEnd().slice(-300));
        lastAnswerText = askText;
      }
      continue;
    }
    // ── v0.8: the failure → recovery chain, read off tool results (a failed run, then a clean one) ──
    if (line.type === "user" && Array.isArray(line.message?.content) && line.timestamp) {
      const monthR = String(line.timestamp).slice(0, 7);
      for (const part of line.message.content) {
        if (part?.type !== "tool_result") continue;
        runFinished = false; // a result waits for the model's next word
        const body = typeof part.content === "string" ? part.content : Array.isArray(part.content) ? part.content.map((c) => c?.text ?? "").join(" ") : "";
        const at = Date.parse(line.timestamp);
        {
          const run = part.tool_use_id ? pendingTests.get(String(part.tool_use_id)) : testQueue.shift();
          if (run) {
            if (part.tool_use_id) pendingTests.delete(String(part.tool_use_id));
            const lineUnit = currentUnit, lineDay = currentDay; currentUnit = run.unit; currentDay = run.day;
            if (inWindow(run.month)) bump(run.month, `testOutcome.${testOutcomeOf(body, part.is_error)}`);
            currentUnit = lineUnit; currentDay = lineDay;
          }
        }
        if (part.is_error === true) {
          const hash = createHash("sha256").update(body.toLowerCase().replace(/[0-9]+/g, "#").slice(0, 160)).digest("hex").slice(0, 16);
          if (inWindow(monthR) && recoveredHashes.has(hash)) bump(monthR, "sameErrorRecurrence");
          openFailure = { at, hash };
        } else if (openFailure) {
          if (inWindow(monthR) && Number.isFinite(at) && at - openFailure.at <= 3_600_000) bump(monthR, "fastRecoveries"); // within the hour (chapter 6: recovery latency, read as a count)
          recoveredHashes.add(openFailure.hash);
          openFailure = null;
        }
      }
    }
    // ── the person's own turns: lexical half + structure ──
    const turn = personTurn(line);
    if (!turn || !line.timestamp) continue;
    if (turn.interrupt) { interrupted = true; continue; } // the person pressed stop: the next turn redirects
    const text = turn.text;
    if (!text && !turn.slash) continue;
    if (!inWindow(String(line.timestamp).slice(0, 7))) continue;
    const month2 = String(line.timestamp).slice(0, 7);
    if (!sessionMonth) {
      sessionMonth = month2;
      if (projectDir && !projectFirstSeen.has(projectDir)) { projectFirstSeen.set(projectDir, month2); bump(month2, "newProjectStarts"); }
    }
    messages += 1;
    humanTurns += 1;
    if (line.timestamp) { lastTs = line.timestamp; if (!firstTs) firstTs = line.timestamp; }
    turnIndex += 1;
    // A human turn landing while a tool chain was mid-flight is a redirect by hand. v0.10: only while
    // the run was still going (its last word a tool call or a result) or after the person stopped it,
    // never after the model had finished with an answer.
    if ((runLength > 0 && !runFinished) || interrupted || turn.queued) bump(month2, "midRunRedirects");
    runLength = 0; interrupted = false; runFinished = !turn.queued; // a queued message lands inside a run that goes on
    if (turn.queued) lastWasAssistantAnswer = false; // typed during the run, not in answer to one
    // A slash command is the person calling a tool; a skill it names is context loaded, like the Skill tool.
    if (turn.slash) {
      bump(month2, "toolInitiator.person");
      if (skillTextOf(turn.slash, line.cwd ?? null)) { skillSeen = true; skillsLoaded.add(turn.slash); }
      if (!text) { lastWasAssistantAnswer = false; lastAnswerText = ""; continue; }
    }
    if (assistantAskedQuestion) { bump(month2, "agentQuestionsAnswered"); assistantAskedQuestion = false; }
    if (line.type === "user" && line.permissionMode && line.permissionMode !== "default") bump(month2, "autoModeShare");
    // The language layer: ONE rubric with a vocabulary per language, never one analysis per
    // language. Each turn is tagged by a stopword heuristic and counted — so the mirror can say
    // what share of the turns the rubric had words for, and no cross-person comparison is made
    // across languages before invariance is checked (framework 7.4, R13).
    const nlHits = (text.match(/\b(de|het|een|niet|ook|maar|dat|dit|ik|je|we|wel|nog|naar|bij)\b/gi) ?? []).length;
    const enHits = (text.match(/\b(the|and|not|this|that|with|for|you|we|but|also|from|have|are|is)\b/gi) ?? []).length;
    bump(month2, nlHits > enHits && nlHits >= 2 ? "turnsNl" : enHits >= 2 ? "turnsEn" : "turnsOther");
    // 7.3: a turn with special-category content is counted as a filter miss and nothing else.
    if ((LEAVE_OUT_RE && LEAVE_OUT_RE.test(text)) || SPECIAL_CATEGORY.test(text)) {
      bump(month2, "filterMiss");
      lastWasAssistantAnswer = false; lastAnswerText = ""; assistantOffered = false; chain = 0;
      continue;
    }
    // R12: does this turn directly follow the model's own offer, as a question or an acceptance?
    const induced = assistantOffered && lastWasAssistantAnswer && (/\?/.test(text) || ACCEPT.test(text));
    const afterAnswer = lastWasAssistantAnswer;
    const initiative = initiativeOf(lastAnswerText, afterAnswer);
    currentInduced = induced;
    if (induced) bump(month2, "modelInducedTurns");
    assistantOffered = false;
    if (!opened && copiedBeforeOpening) {
      // v0.10: a continuation of a session already counted from another file: its first new turn is not an opening.
      opened = true;
    } else if (!opened) {
      opened = true;
      const openingHash = text.toLowerCase().replace(/[0-9\s]+/g, " ").trim().slice(0, 80);
      if (openingHash.length > 20) {
        if (openingHashes.has(openingHash)) bump(month2, "templateReuse");
        openingHashes.add(openingHash);
      }
      if (/\bedge[ -]?cases?\b|\brandgeval|\bwhat if\b|\bwat als\b/i.test(text)) bump(month2, "edgeFirstOpenings");
      if (/\byou are (a|an|the)\b|\bjij bent (een|de)\b|\bact as\b|\bgedraag je als\b/i.test(text)) bump(month2, "roleFraming");
      // v0.8: the form the opening takes and the kind of act it is — one count per session, UNCLASSIFIED included.
      const form = classifyOpening(text);
      openingText = text;
      if (form === "ROLE") roleSentence = normaliseRole(sentencesOf(text)[0] ?? "");
      // The session's own unit id, so form, second turn and context join per session in the app
      // (the cross-tab is read within a context cell; the line's unit would scatter them).
      const lineUnit = currentUnit; currentUnit = sessionUnit;
      bump(month2, `openingForm.${form}`);
      bump(month2, `openingActKind.${openingActKind(text, form)}`);
      currentUnit = lineUnit;
      awaitingSecond = true;
      if (LABEL_OUT) labelRows.push({ unit: sessionUnit, month: month2, lang: nlHits > enHits && nlHits >= 2 ? "nl" : enHits >= 2 ? "en" : "other", form, text: text.slice(0, 240) });
    } else if (awaitingSecond && sawAnswerAfterOpening) {
      // v0.8: the second turn — what the opening earned — and the context that was loaded by then.
      const lineUnit = currentUnit; currentUnit = sessionUnit;
      bump(month2, `secondTurnType.${classifySecondTurn(text)}`);
      if (skillSeen || agentSeen) bump(month2, `contextMode.${skillSeen && agentSeen ? "SKILL_AGENT" : skillSeen ? "SKILL" : "AGENT"}`);
      currentUnit = lineUnit;
      awaitingSecond = false;
    }
    if (opened && sawAnswerAfterOpening && openingText !== null && text !== openingText) { turnsAfterOpening += 1; if (acceptedAtTurn === null && ACCEPT_TURN.test(text)) acceptedAtTurn = turnsAfterOpening; }
    if (pendingVerify && ACCEPT_TURN.test(text)) bump(month2, "verifyBeforeAccept");
    pendingVerify = /\bverif(y|ieer|icatie)\b|\bcontroleer\b|\bcheck (dat|of|whether|that|it)\b|\brun (the )?tests?\b|\bdraai de tests?\b/i.test(text);
    // v0.10: a verification asked for is closed by the next test run in the session, or by the next ask.
    if (verifyOpen) { const lineUnit = currentUnit, lineDay = currentDay; currentUnit = verifyOpen.unit; currentDay = verifyOpen.day; bump(verifyOpen.month, "verificationFollowed.NOT_RUN"); currentUnit = lineUnit; currentDay = lineDay; verifyOpen = null; }
    if (pendingVerify && !induced) verifyOpen = { unit: currentUnit, day: currentDay, month: month2 };
    if (!edited && /\b(we gaan voor|ik ga voor|ik kies( voor)?|besloten:|beslissing:|i'?m going with|we'?re going with|i'?ll go with|let'?s go with|decision:|decided:|we choose|i choose)\b/i.test(text)) bump(month2, "decisionBeforeCode");
    if (humanTurns <= 3 && /\bcost(s)?\b|\bkosten\b|\bbudget\b|\btoken.{0,12}(prijs|price|cost)\b|\bprijs per\b/i.test(text)) bump(month2, "costBeforeBuild");
    // A question re-asked after it was answered is a reassurance loop (4.1) — confirmation sought, not information.
    if (/\?/.test(text)) {
      const asked = text.toLowerCase().replace(/[^a-z0-9? ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      if (asked.length > 24) {
        if (lastWasAssistantAnswer && askedBefore.has(asked)) bump(month2, "reassuranceLoops");
        askedBefore.add(asked);
      }
    }
    if (lastWasAssistantAnswer && /\?/.test(text) && !induced) {
      bump(month2, "followUpDepth");
      chain += 1;
      if (chain === 3) bump(month2, "deepFollowUpChains"); // once per chain, at the depth
    } else if (lastWasAssistantAnswer && !induced) {
      chain = 0;
    }
    lastWasAssistantAnswer = false; lastAnswerText = "";
    if (!edited) researchTurnsBeforeEdit += 1;
    if (/\b(security|privacy|AVG|GDPR|DPA|DPIA|encrypt|vulnerab|kwetsbaar|beveilig|compliance)\b/i.test(text)) bump(month2, "securityAttention");
    if (/(error TS\d|Traceback \(most recent call|^\s*at .+\(.+:\d+:\d+\)|Unhandled|Exception in|ERR_|error:.*\n.*at )/im.test(text)) bump(month2, "errorDrivenIterations");
    const fired = RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.signal);
    for (const signal of fired) {
      if (induced && R12_SKIP.has(signal)) continue; // R12: the model's steering is not the person's framing, depth or pushback
      bump(month2, signal);
      const phase = PHASE_OF[signal];
      if (phase && !phaseFirst.has(phase)) phaseFirst.set(phase, turnIndex);
    }
    if (afterAnswer && CORRECT_MARK.test(text) && !phaseFirst.has("CORRECTION")) phaseFirst.set("CORRECTION", turnIndex);
    // v0.10: what a behaviour-bearing turn came after (R12's own flag stays on the unit), and what an acceptance added.
    if (fired.length > 0) bump(month2, `turnInitiative.${initiative}`);
    if (afterAnswer && ACCEPT_TURN.test(text)) bump(month2, `acceptanceForm.${fired.some((signal) => OWN_TERMS.has(signal)) ? "WITH_OWN_TERMS" : "AS_PROPOSED"}`);
  }
  // ── session-level: ran to completion with at most two human turns, and real delegation ──
  // A session that crosses a month boundary is counted in the month it STARTED; its unit's day
  // must be a date inside that month, so the first turn's day — never the last, which the door
  // rightly refused as "a date inside 2026-07" when the session ended on 1 August.
  const sessionDay = firstTs ? String(firstTs).slice(0, 10) : null;
  currentUnit = sessionUnit; currentInduced = false; currentDay = sessionDay && sessionMonth && sessionDay.startsWith(sessionMonth) ? sessionDay : null;
  // One session with a human turn is one independent chat for the confidence layer — sent as `stretches`, a number per month.
  if (sessionMonth && inWindow(sessionMonth) && humanTurns > 0) sessionsByMonth.set(sessionMonth, (sessionsByMonth.get(sessionMonth) ?? 0) + 1);
  if (sessionMonth && inWindow(sessionMonth) && humanTurns > 0 && humanTurns <= 2 && toolActions >= 20) bump(sessionMonth, "uninterruptedRuns");
  // Research before the first edit: three or more human turns spent reading and asking before
  // any file was touched — the session's opening was investigation, not construction.
  if (sessionMonth && inWindow(sessionMonth) && researchTurnsBeforeEdit >= 3 && edited) bump(sessionMonth, "researchBeforeBuild");
  if (sessionMonth && inWindow(sessionMonth) && humanTurns >= 15) bump(sessionMonth, "hardProblemPersistence");
  // v0.8: an opening that got an answer and nothing after it — the session ended there.
  if (sessionMonth && inWindow(sessionMonth) && awaitingSecond && sawAnswerAfterOpening) bump(sessionMonth, "secondTurnType.ABANDON");
  // v0.9: turns to the first acceptance, bucketed; and the skill matrix of this session.
  if (sessionMonth && inWindow(sessionMonth) && opened && openingText !== null && sawAnswerAfterOpening) {
    bump(sessionMonth, `turnsToAccept.${acceptedAtTurn === null ? "NONE" : acceptedAtTurn === 1 ? "ONE" : acceptedAtTurn === 2 ? "TWO" : "THREE_PLUS"}`);
    const cwd = currentContext ? contextCwds.get(currentContext) ?? null : null;
    if (skillsLoaded.size > 0 && openingText) {
      const texts = [...skillsLoaded].map((name) => skillTextOf(name, cwd)).filter(Boolean);
      const restated = texts.reduce((most, skillText) => Math.max(most, restatedSentences(openingText, skillText)), 0);
      if (restated > 0) bump(sessionMonth, "contextRestated", restated);
      if (roleSentence && texts.length > 0 && texts.every((skillText) => sentencesOf(skillText).map(wordsOf).every((set) => jaccard(wordsOf(roleSentence), set) < DRIFT_OVERLAP))) bump(sessionMonth, "patternChange");
    }
    if (roleSentence && skillsLoaded.size === 0) {
      const byPattern = rolePatterns.get(sessionMonth) ?? new Map();
      const roleKey = fingerprint(roleSentence);
      byPattern.set(roleKey, new Set([...(byPattern.get(roleKey) ?? []), sessionUnit]));
      rolePatterns.set(sessionMonth, byPattern);
    }
  }
  if (sessionMonth && inWindow(sessionMonth) && firstTs && lastTs) sessionSpans.push({ start: Date.parse(firstTs), end: Date.parse(lastTs), month: sessionMonth, unit: sessionUnit, day: currentDay, context: currentContext });
  if (streamHash && streamHash.digest("hex") !== manifest[sessionIndex - 1]) throw Error("Source changed during counting; rerun to resume safely");
  // v0.10: the session's order of phases, and a requested verification still open at its end.
  if (sessionMonth && inWindow(sessionMonth) && humanTurns > 0) bump(sessionMonth, `taskSequence.${taskSequenceOf(phaseFirst)}`);
  if (verifyOpen && sessionMonth && inWindow(sessionMonth)) { currentUnit = verifyOpen.unit; currentDay = verifyOpen.day; bump(verifyOpen.month, "verificationFollowed.NOT_RUN"); }
  checkpoint?.write(sessionIndex,{maps:checkpointMaps,sets:checkpointSets,sessionSpans,messages,files,currentContext,duplicateLines},checkpointDependencies);
  if(++processed>=maxSessions && sessionIndex<manifest.length){
    console.log(`Counter paused at ${sessionIndex}/${manifest.length} sessions; rerun the same command. Nothing sent.`);
    checkpoint?.close();process.exit(0);
  }
}
currentUnit = null; currentDay = null; currentStretchBase = null; // month-level aggregates carry no unit, no day and no stretch
for (const [month, set] of monthToolNames) bump(month, "toolBreadth", set.size);
for (const [month, set] of monthMcpServers) if (set.size > 0) bump(month, "mcpServersDistinct", set.size);
for (const [month, byPattern] of rolePatterns) for (const sessions of byPattern.values()) if (sessions.size >= RECURRENCE_FLOOR) bump(month, "recurringPatternCandidate");
// The git side, per project directory a transcript named: the person's own commits inside the window.
let gitSideCommits = 0;
for (const [context, cwd] of contextCwds) {
  if (excluded(cwd)) continue;
  const perCommit = gitSideCounts(gitCommitsOf(cwd, floor.toISOString()));
  for (const commit of perCommit) {
    const month = commit.at.slice(0, 7);
    if (!inWindow(month)) continue;
    gitSideCommits += 1;
    currentUnit = unitOf(cwd, commit.sha); currentDay = commit.at.slice(0, 10); currentContext = context; currentInduced = false;
    if (commit.testFirstOrder > 0) bump(month, "testFirstOrder", commit.testFirstOrder);
    if (commit.adrWritten > 0) bump(month, "adrWritten", commit.adrWritten);
  }
}
currentUnit = null; currentDay = null; currentContext = null;
// The same strict overlap test in O(n log n), rather than comparing every pair.
export function overlappingSessions(spans) {
  const ordered=spans.map((span,index)=>({...span,index})).filter(s=>s.end>s.start).sort((a,b)=>a.start-b.start);
  const found=new Set();let maximumEnd=-Infinity;
  for(let i=0;i<ordered.length;i++){
    const a=ordered[i];
    if(maximumEnd>a.start || (ordered[i+1] && ordered[i+1].start<a.end))found.add(a.index);
    maximumEnd=Math.max(maximumEnd,a.end);
  }
  return found;
}
const overlapping=overlappingSessions(sessionSpans);
// Parallelism: a session that overlaps any other counted session, once per session.
for (let i = 0; i < sessionSpans.length; i += 1) {
  const a = sessionSpans[i];
  if (a.end <= a.start) continue;
  if (overlapping.has(i)) { currentUnit = a.unit; currentDay = a.day ?? null; currentContext = a.context ?? null; bump(a.month, "parallelSessions"); currentUnit = null; currentDay = null; currentContext = null; }
}

// THE STRETCHES, FOR PRESERVE (0.7.0): one JSON line per stretch that carries a signal, the analyzer's version on each,
// and a closing count so the reader can tell a whole answer from a cut one. Counts and keys only; nothing is sent.
if (flag("stretch-signals")) {
  const rows = [...byStretch.entries()].sort(([, a], [, b]) => a.day.localeCompare(b.day)).map(([stretch_ref, entry]) => JSON.stringify({ stretch_ref, day: entry.day, analyzer_version: ANALYZER_VERSION, signals: Object.fromEntries(Object.entries(entry.signals).sort().map(([signal, count]) => [signal, Math.min(COUNT_CEILING, count)])) }));
  await new Promise((resolve) => process.stdout.write(`${[...rows, JSON.stringify({ stretch_signals_end: rows.length })].join("\n")}\n`, resolve));
  process.exit(0);
}

const months = [...byMonth.keys()].sort();
console.log(`${ANALYZER_VERSION} · ${files} transcript file(s), ${messages} own messages, ${months.length} month(s) with counts`);
console.log(` projects counted: ${countedDirs.length}${countedDirs.length ? ` (${countedDirs.join(", ")})` : ""}`);
console.log(` git side: ${gitSideCommits} own commit(s) read for test-first order and decision records (paths stay here)`);
console.log(` lines read once: ${duplicateLines} line(s) already counted from another transcript file were skipped${unreadableLines ? ` · ${unreadableLines} line(s) too long to read` : ""}`);
if (copilotSessionCount > 0) console.log(` copilot chat sessions read: ${copilotSessionCount} (VS Code workspaceStorage, this machine)`);
if (!codexLines) console.log(" codex and antigravity: not read (transcript-readers.mjs is not beside this file)");
if (antigravityCount > 0) console.log(` antigravity conversations read: ${antigravityCount} (~/.gemini/antigravity*, this machine; clocks and the person's turns, no tokens recorded)`);
if (codexRolloutCount > 0) console.log(` codex rollouts read: ${codexRolloutCount} (~/.codex/sessions, this machine; tokens once per response, the person's turns only)`);
if (EXPORTS.length > 0) console.log(` claude.ai export: ${exportConversations} conversation(s) counted${skippedConversations.length ? ` · excluded, never read: ${skippedConversations.length}` : ""}`);
if (CHATGPT_EXPORTS.length > 0) console.log(` ChatGPT export: ${chatgptConversations} conversation(s) counted (the kept branch of each; no tokens, the export carries none)`);
if (skippedDirs.length > 0) console.log(` excluded, never read: ${skippedDirs.join(", ")}`);
for (const month of months) {
  const bucket = byMonth.get(month);
  console.log(` ${month}: ${[...bucket.entries()].sort((a, b) => b[1] - a[1]).map(([signal, count]) => `${signal} ${count}`).join(" · ")}`);
  console.log(`   units: ${unitsByMonth.get(month)?.size ?? 0} references by id (16-hex digests of file and line — never text) · ${byMonthContext.get(month)?.size ?? 0} cells by context`);
}
/**
 * Automatic naming without a name travelling: a second digest per context, of the directory's
 * normalised LAST segment ("davosnl-com", "dlg-platform") — the same normalisation the app
 * applies to every repository name the record already holds. A match names the column in the
 * app; the name itself is printed here and goes nowhere.
 */
const sharedSegments = () => { const dirs = [...contextNames.values()].map((d) => d.split("-").filter(Boolean)); let shared = 0; while (dirs.length > 1 && dirs.every((d) => d.length > shared + 1 && d[shared] === dirs[0][shared])) shared += 1; return shared; };
const normalise = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** The project's real name where the transcript said it (cwd); the directory key past the shared home path otherwise. */
const slugOf = (context, dir) => normalise(contextBasenames.get(context) ?? dir.split("-").filter(Boolean).slice(sharedSegments()).join("-"));
const slugHash = (context, dir) => createHash("sha256").update(`name:${slugOf(context, dir)}`).digest("hex").slice(0, 16);
const contextNamesOf = () => [...contextNames.entries()].map(([context, dir]) => ({ context, slug: slugHash(context, dir) }));
if (contextNames.size > 0) {
  console.log(` contexts (a digest per project — the name below stays on this machine; give each its name on /behaviour/matrix):`);
  // The directories share the home path as a prefix; print what differs, so "dlg-platform" and
  // "shift-recovery-mobile" stay distinguishable — the names never leave this console.
  for (const [digest, dir] of contextNames) console.log(`   ${digest}  ${contextBasenames.get(digest) ?? dir.split("-").filter(Boolean).slice(sharedSegments()).join("-")}`);
  console.log(`   (the app names a context by itself when its slug digest matches a repository the record already holds)`);
}
console.log("");
console.log("These counts sketch HOW you work with AI — your own mirror, owned by you. The more");
console.log("months, the truer the picture. No text ever leaves this machine: the door accepts only");
console.log("numbers, so secrets and client data have no channel to travel through. You keep control:");
console.log("--exclude before counting, erase per reading on /behaviour, revoke the coupling any time.");
/**
 * F-04 — the send needs a human. The reading about to be sent is digested to 16 hex (its
 * rubric, months, counts and unit ids — the same input gives the same digest); the dry run
 * prints an approval link for the OWNER to open in the app, in their own browser session. The
 * door accepts the send only when that approval exists. An agent can pass --send; it cannot
 * click as the person.
 */
const cellsOf = (month) => [...(byMonthContext.get(month)?.entries() ?? [])].map(([key, count]) => { const [signal, context] = key.split("|"); return { signal, context, count }; });
const bundle = months.map((month) => ({ month, signals: [...byMonth.get(month).entries()].sort(), contexts: cellsOf(month).map((c) => `${c.signal}|${c.context}|${c.count}`).sort(), units: [...(unitsByMonth.get(month)?.keys() ?? [])].sort() }));
const namesDigest = contextNamesOf().map((n) => `${n.context}|${n.slug}`).sort();
const APPROVAL = createHash("sha256").update(JSON.stringify({ version: ANALYZER_VERSION, bundle, names: namesDigest })).digest("hex").slice(0, 16);
const appOrigin = URL_ ? new URL(URL_).origin : "<app-url>";
console.log("");
if (LABEL_OUT) { writeFileSync(LABEL_OUT, labelRows.map((row) => JSON.stringify(row)).join("\n") + "\n"); console.log(` openings written for labelling: ${labelRows.length} → ${LABEL_OUT} (local file; add "label" per line, then --agreement ${LABEL_OUT})`); }
if (DRY) {
  console.log(`dry run — nothing sent. Next: run again with --stage — the reading then WAITS in the app (${appOrigin}/behaviour) until the person clicks Import; nothing is counted before that click. (Alternative without the app visit: approval code ${APPROVAL} at ${appOrigin}/behaviour?approve=${APPROVAL}, then --send.)${URL_ && TOKEN ? ` Coupling found (${new URL(URL_).host}).` : " Pass --url and --token (or couple this client) first."}`);
  process.exit(0);
}
if (STAGE) {
  if (!URL_ || !TOKEN) { console.error("no coupling found: pass --url and --token, or set WORKTRUST_MCP_URL / WORKTRUST_MCP_TOKEN"); process.exit(1); }
  const readings = months.map((month) => ({ period: month, stretches: sessionsByMonth.get(month) ?? 0, signals: [...byMonth.get(month).entries()].map(([signal, count]) => ({ signal, count: clampCount(signal, count, month) })), contexts: cellsOf(month), context_names: contextNamesOf(), units: [...(unitsByMonth.get(month)?.values() ?? [])].map(({ unit, signal, induced, day, context }) => ({ unit, signal, induced, ...(day ? { day } : {}), ...(context ? { context } : {}) })) }));
  if (!flag("legacy-stage")) {
    // WHAT THIS MACHINE ALREADY DELIVERED, per month and ISO week, for this coupling and rubric
    // (owner, 2026-09-27: only what was not added before). A week's digest covers its counts and
    // the unit references dated in it; a month's "rest" covers what has no week (its stretches,
    // its per-project cells). A month travels only when one of those moved, and it travels with
    // the list of weeks that moved and by how much, so the Import window can say what changed.
    // Another coupling (another machine) or another rubric is another ledger: everything travels
    // once. --full sends every month in the window regardless.
    const base=value("checkpoint")??join(homedir(),".worktrust","counter-checkpoint.json");
    const deliveryPath=base+".delivery", ledgerPath=base+".weeks";
    mkdirSync(dirname(deliveryPath),{recursive:true,mode:0o700});
    const scope=fingerprint({url:URL_,token:TOKEN,version:ANALYZER_VERSION});
    const writeAtomic=(path,value)=>{const temp=path+"."+process.pid+".tmp";writeFileSync(temp,JSON.stringify(value),{mode:0o600});renameSync(temp,path);};
    let ledger=null;try{ledger=JSON.parse(readFileSync(ledgerPath,"utf8"));}catch{}
    if(ledger?.scope!==scope||flag("full"))ledger={scope,weeks:{},rest:{}};
    const sumOf=(bag)=>[...bag.values()].reduce((sum,n)=>sum+n,0);
    const weeksOf=(month)=>[...byWeek.entries()].filter(([key])=>key.startsWith(month+"|")).map(([key,bag])=>{
      const week=key.slice(month.length+1);
      const units=[...(unitsByMonth.get(month)?.values()??[])].filter(u=>(u.day&&u.day.startsWith(month)?isoWeek(u.day):"U")===week).map(u=>`${u.unit}|${u.signal}|${u.induced?1:0}|${u.context??""}`).sort();
      return {key,week,observations:sumOf(bag),digest:fingerprint({signals:[...bag.entries()].sort(),units})};
    });
    const restOf=(reading)=>fingerprint({stretches:reading.stretches,contexts:reading.contexts.map(c=>`${c.signal}|${c.context}|${c.count}`).sort(),names:reading.context_names.map(n=>`${n.context}|${n.slug}`).sort()});
    // Months delivered before and absent now (their sessions were deleted) travel empty, so the
    // door removes what the machine no longer holds.
    const delivered=new Set([...Object.keys(ledger.weeks).map(key=>key.split("|")[0]),...Object.keys(ledger.rest)]);
    for(const period of delivered)if(inWindow(period)&&!readings.some(r=>r.period===period))readings.push({period,stretches:0,signals:[],contexts:[],context_names:[],units:[]});
    const plan=[];
    for(const reading of readings.sort((x,y)=>x.period.localeCompare(y.period))){
      const weeks=weeksOf(reading.period), rest=restOf(reading);
      const before=Object.entries(ledger.weeks).filter(([key])=>key.startsWith(reading.period+"|"));
      const changes=[
        ...weeks.filter(w=>ledger.weeks[w.key]?.digest!==w.digest).map(w=>({week:w.week,observations:w.observations,previous:ledger.weeks[w.key]?.observations??null})),
        ...before.filter(([key])=>!weeks.some(w=>w.key===key)).map(([key,old])=>({week:key.slice(reading.period.length+1),observations:0,previous:old.observations})),
      ].sort((x,y)=>x.week.localeCompare(y.week));
      if(changes.length===0&&ledger.rest[reading.period]===rest)continue;
      plan.push({reading,weeks,rest,changes});
    }
    const unchanged=new Set(readings.map(r=>r.period)).size-plan.length;
    console.log(` ${plan.length} month(s) with new or changed weeks${unchanged>0?` · ${unchanged} unchanged, not sent`:""}`);
    for(const {reading,changes} of plan)console.log(`   ${reading.period}: ${changes.length?changes.map(c=>`${c.week} ${c.previous===null?"new":c.observations===0?"removed":`${c.previous}→${c.observations}`}`).join(" · "):"per-project cells changed"}`);
    if(plan.length===0){console.log("Nothing new since the last delivery from this machine. Nothing sent.");process.exit(0);}
    // Persist the outbound revision BEFORE sending. A failed HTTP response replays safely.
    let delivery=null;try{delivery=JSON.parse(readFileSync(deliveryPath,"utf8"));}catch{}
    if(delivery?.scope!==scope)delivery=null;
    const digest=fingerprint(plan.map(p=>p.reading));
    const revision=delivery?.digest===digest?delivery.revision:Math.max(Date.now(),(delivery?.revision??0)+1);
    writeAtomic(deliveryPath,{scope,digest,revision,periods:plan.map(p=>p.reading.period)});
    for(const {reading,weeks,rest,changes} of plan){
      const total=Math.max(1,Math.ceil(reading.units.length/4000),Math.ceil(reading.contexts.length/1000),Math.ceil(reading.context_names.length/500));
      if(total>1000)throw Error("Month exceeds batch capacity; no truncated reading was sent");
      for(let part=0;part<total;part++){
        const chunk={...reading,contexts:reading.contexts.slice(part*1000,(part+1)*1000),context_names:reading.context_names.slice(part*500,(part+1)*500),units:reading.units.slice(part*4000,(part+1)*4000)};
        const payload={jsonrpc:"2.0",id:"batch",method:"tools/call",params:{name:"stage_signals",arguments:{analyzer_version:ANALYZER_VERSION,payload_hash:fingerprint(chunk).slice(0,16),batch:{revision,part,total},readings:[chunk],...(part===0?{changes:changes.slice(0,60)}:{})}}};
        const body=JSON.stringify(payload);if(Buffer.byteLength(body)>STAGE_MAX_BYTES)throw Error("Batch too large; nothing truncated");
        const response=await fetch(URL_,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${TOKEN}`,...proofFor(URL_,body)},body});
        const answer=await response.json();
        if(!response.ok||answer.error||answer.result?.isError)throw Error("Batch not acknowledged; rerun to resume");
        const status=JSON.parse(answer.result.content[0].text);
        console.log(` batch ${reading.period} ${part+1}/${total}: ${status.status}`);
        if(status.status==="imported"||status.status==="unchanged"||status.status==="pending"){
          // Acknowledged: this month's weeks are now what the door holds (or offers) from here.
          for(const key of Object.keys(ledger.weeks))if(key.startsWith(reading.period+"|"))delete ledger.weeks[key];
          for(const w of weeks)ledger.weeks[w.key]={digest:w.digest,observations:w.observations};
          if(weeks.length||reading.signals.length)ledger.rest[reading.period]=rest;else delete ledger.rest[reading.period];
          writeAtomic(ledgerPath,ledger);
          break;
        }
      }
    }
    console.log("Complete months await the owner's Import in /behaviour. Imports replace this coupling's month, including corrections and removals.");
    process.exit(0);
  }
  // UNDER THE HOST'S CEILING. A serverless request takes about 4.5 MB; a year of unit references
  // does not fit in one. Months are staged in chunks that stay under the ceiling, each with its own
  // dedupe hash (the pending row is keyed on it, and a second chunk under the same hash would be
  // dropped as a duplicate). The person imports each chunk with one click; nothing is on the mirror
  // before that.
  const chunks = [];
  for (const reading of readings) {
    const last = chunks[chunks.length - 1];
    if (last && JSON.stringify([...last, reading]).length <= STAGE_MAX_BYTES) last.push(reading); else chunks.push([reading]);
  }
  for (const chunk of chunks) {
    const hash = createHash("sha256").update(`${APPROVAL}:${chunk.map((r) => r.period).join(",")}`).digest("hex").slice(0, 16);
    const payload = { jsonrpc: "2.0", id: "stage", method: "tools/call", params: { name: "stage_signals", arguments: { analyzer_version: ANALYZER_VERSION, payload_hash: hash, readings: chunk } } };
    const body = JSON.stringify(payload);
    const response = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", "user-agent": `worktrust-counter/${ANALYZER_VERSION}`, authorization: `Bearer ${TOKEN}`, ...proofFor(URL_, body) }, body });
    const answer = await response.json().catch(() => null);
    const text = answer?.result?.content?.[0]?.text ?? answer?.error?.message ?? (response.status === 413 ? "http 413 — the request was still too large for the host; lower STAGE_MAX_BYTES" : `http ${response.status}`);
    console.log(` staged ${chunk[0].period}${chunk.length > 1 ? `–${chunk[chunk.length - 1].period}` : ""} → ${text}`);
  }
  console.log(` the person imports ${chunks.length === 1 ? "it" : `each of the ${chunks.length} readings`} at ${appOrigin}/behaviour — one click each; nothing is on the mirror before it.`);
  process.exit(0);
}
if (!URL_ || !TOKEN) { console.error("no coupling found: pass --url and --token, or set WORKTRUST_MCP_URL / WORKTRUST_MCP_TOKEN"); process.exit(1); }
console.log(`sending to ${new URL(URL_).host} …`);
for (const month of months) {
  const bucket = byMonth.get(month);
  const units = [...(unitsByMonth.get(month)?.values() ?? [])].map(({ unit, signal, induced, day, context }) => ({ unit, signal, induced, ...(day ? { day } : {}), ...(context ? { context } : {}) }));
  const payload = { jsonrpc: "2.0", id: month, method: "tools/call", params: { name: "log_signals", arguments: { period: month, stretches: sessionsByMonth.get(month) ?? 0, analyzer_version: ANALYZER_VERSION, signals: [...bucket.entries()].map(([signal, count]) => ({ signal, count: clampCount(signal, count, month) })), contexts: cellsOf(month), context_names: contextNamesOf(), units, approval: APPROVAL } } };
  const body = JSON.stringify(payload);
  const response = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", "user-agent": `worktrust-counter/${ANALYZER_VERSION}`, authorization: `Bearer ${TOKEN}`, ...proofFor(URL_, body) }, body });
  const answer = await response.json().catch(() => null);
  const text = answer?.result?.content?.[0]?.text ?? answer?.error?.message ?? `http ${response.status}`;
  console.log(` sent ${month} → ${text}`);
}
