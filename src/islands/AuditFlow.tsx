// The audit tool island: 4-input form -> client-direct blob upload ->
// submit (lead captured immediately) -> processing takeover -> results.
// Mounted client:visible on /audit (mode "form") and /audit/results/[jobId]
// (mode "results"). Copy status: DRAFT pending brand-voice pass.
import { useCallback, useEffect, useRef, useState } from 'react';
import { upload } from '@vercel/blob/client';
import { nanoid } from 'nanoid';
import { sniffBytes, isPhoto, contentTypeFor } from '../lib/audit/sniff';
import type { VisitorReport, RedFlag } from '../lib/audit/report';

// ---------------------------------------------------------------------------
// constants

const CONSENT_TEXT =
  'I agree that XCap Factoring may contact me about my audit by phone, text message, and email, including automated messages, at the number and email I provided. Consent is not a condition of any purchase. Message and data rates may apply.';

const REASSURANCE = 'Confidential. Your contract is used only to prepare your audit and is never shared.';

const MAX_TOTAL_BYTES = 20 * 1024 * 1024; // raw cap; base64 inflation keeps the model request under its ceiling
const MAX_PHOTOS = 30;
const POLL_MS = 2500;
const POLL_TIMEOUT_MS = 4 * 60 * 1000;
const MAX_NOT_FOUND = 5;

const STEPS = [
  { key: 'uploading', label: 'Uploading your contract' },
  { key: 'reading_contract', label: 'Reading the contract' },
  { key: 'extracting_terms', label: 'Extracting the terms' },
  { key: 'computing_rates', label: 'Computing your real rates' },
  { key: 'building_report', label: 'Building your report' },
] as const;

type StepKey = (typeof STEPS)[number]['key'];

const SEVERITY_STAMP: Record<RedFlag['severity'], string> = {
  maximal: 'Severe',
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
};

const EXHIBIT_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];

const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

// ---------------------------------------------------------------------------
// dev-only mock responder (tree-shaken out of production builds)

function getMockKey(): string | null {
  if (!import.meta.env.DEV) return null;
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('mock');
}

function mockReport(kind: string): VisitorReport {
  const disclaimers = [
    'This audit is an automated estimate from the document you provided, subject to human confirmation. It is a ballpark, not a binding quote.',
    'Not legal advice and not accounting or tax advice. Consult an attorney before terminating or signing any agreement.',
    'Actual savings depend on invoice volume, payment timing, and final factor pricing, confirmed in writing before you sign anything.',
  ];
  if (kind === 'notfactoring') {
    return { status: 'not_factoring', headline: null, rates: null, flags: [], totalFlagCount: 0, verdict: null, assumptions: [], disclaimers };
  }
  if (kind === 'unreadable') {
    return { status: 'unreadable', headline: null, rates: null, flags: [], totalFlagCount: 0, verdict: null, assumptions: [], disclaimers };
  }
  if (kind === 'manual') {
    return { status: 'manual_review', headline: null, rates: null, flags: [], totalFlagCount: 0, verdict: null, assumptions: [], disclaimers };
  }
  if (kind === 'no') {
    return {
      status: 'ok',
      headline: null,
      rates: {
        perceivedApr: 14.4,
        effectiveAprAtTypical: 15.1,
        scenarios: [
          { days: 30, feePctOfFace: 1.05, aprOnCash: 14.2 },
          { days: 45, feePctOfFace: 1.68, aprOnCash: 15.1 },
          { days: 60, feePctOfFace: 2.24, aprOnCash: 15.2 },
        ],
        advanceRatePct: 90,
      },
      flags: [],
      totalFlagCount: 0,
      verdict: {
        canLikelyHelp: false,
        line: 'Honest answer: your contract is actually competitive. The rate mechanics are fair and we did not find lock-in traps worth a move. Keep it, and keep this report for your renewal window.',
      },
      assumptions: ['Better-terms comparison uses the conservative end of the standard we place into: 1.5% monthly equivalent charged as a daily rate on the amount advanced, no minimum-day charges, no clearing-day float.'],
      disclaimers,
    };
  }
  // default: full 'ok' report with flags
  const flags: RedFlag[] = [
    {
      id: 'rate_tier',
      severity: 'high',
      title: 'The rate escalates after the first tier',
      clauseQuote: '1.80% of the gross face amount for the first 30 days, plus 0.65% for each 10 day period thereafter',
      plainEnglish: 'The rate you remember is the day-1 tier. Every block your customer takes to pay stacks another charge on top, so slow months bill far above the headline.',
      goodStandard: 'A daily rate: the invoice costs exactly the days it took, no tier jumps.',
      estAnnualImpactUsdPer100k: 1300,
    },
    {
      id: 'etf',
      severity: 'critical',
      title: 'An early termination fee guards the door',
      clauseQuote: '0.50% of the Maximum Credit multiplied by the number of months remaining in the then current Term',
      plainEnglish: 'The exit fee scales with every month left on the term, so the price of leaving is highest exactly when you most want out.',
      goodStandard: 'No fee for leaving a deal that stopped working for you.',
      estAnnualImpactUsdPer100k: null,
    },
    {
      id: 'release_hostage',
      severity: 'critical',
      title: 'The lien release is conditioned on signing a general release',
      clauseQuote: 'shall have no obligation to terminate its security interest until Seller executes a general release in a form acceptable to Purchaser',
      plainEnglish: 'The factor is not required to clear its UCC filing until you sign a release in a form it finds acceptable. This is the documented release-letter hostage pattern.',
      goodStandard: 'UCC termination on payoff, on the statutory clock, no strings.',
      estAnnualImpactUsdPer100k: null,
    },
  ];
  return {
    status: 'ok',
    headline: { savingsMinPerYear: null, savingsPerYearPer100k: 1240, volumeKnown: false },
    rates: {
      perceivedApr: 21.6,
      effectiveAprAtTypical: 34.7,
      scenarios: [
        { days: 30, feePctOfFace: 1.8, aprOnCash: 24.9 },
        { days: 45, feePctOfFace: 3.1, aprOnCash: 28.6 },
        { days: 60, feePctOfFace: 3.75, aprOnCash: 25.9 },
      ],
      advanceRatePct: 88,
    },
    flags,
    totalFlagCount: 9,
    verdict: {
      canLikelyHelp: true,
      line: 'Based on this ballpark read, better terms very likely exist for you. A specialist will confirm the real number against your volume before anything moves.',
    },
    assumptions: [
      'Advance rate not found in the document; assumed 88% (typical range 85 to 90%).',
      'Better-terms comparison uses the conservative end of the standard we place into: 1.5% monthly equivalent charged as a daily rate on the amount advanced, no minimum-day charges, no clearing-day float.',
    ],
    disclaimers,
  };
}

// ---------------------------------------------------------------------------
// small pieces (module scope: nested definitions remount every render)

function FieldRow(props: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="font-medium text-[0.95rem]">{props.label}</label>
      {props.children}
    </div>
  );
}

function ProcessingView(props: { activeStep: StepKey }) {
  const activeIdx = STEPS.findIndex((s) => s.key === props.activeStep);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto" style={{ background: 'var(--color-paper)' }}>
      <div className="container-page w-full max-w-xl py-12">
        <p className="eyebrow mb-6 text-center">Audit in progress</p>

        {/* mini contract sheet with a looping scan */}
        <div className="contract-sheet relative mx-auto mb-10 w-64 overflow-hidden p-6" style={{ minHeight: '300px' }} aria-hidden="true">
          <div className="scanline scan-loop" style={{ ['--scan-dist' as string]: '300px' }} />
          <div className="contract-heading mb-4 w-2/3" />
          <div className="space-y-2.5">
            <div className="contract-line w-full" />
            <div className="contract-line w-11/12" />
            <div className="contract-line contract-line-soft w-full" />
            <div className="contract-line w-10/12" />
            <div className="contract-line contract-line-soft w-full" />
            <div className="contract-line w-11/12" />
            <div className="contract-line contract-line-soft w-9/12" />
            <div className="contract-line w-full" />
            <div className="contract-line contract-line-soft w-10/12" />
            <div className="contract-line w-8/12" />
          </div>
          <div className="mt-5 shimmer h-3 w-3/4" />
          <div className="mt-2 shimmer h-3 w-1/2" />
        </div>

        <ol className="mx-auto max-w-sm space-y-3" aria-live="polite">
          {STEPS.map((step, i) => {
            const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'pending';
            return (
              <li key={step.key} className="flex items-center gap-3">
                <span
                  className="tnum inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-semibold"
                  style={{
                    borderColor: state === 'pending' ? 'var(--color-rule)' : state === 'done' ? 'var(--color-verdict)' : 'var(--color-ink)',
                    background: state === 'done' ? 'var(--color-verdict)' : 'transparent',
                    color: state === 'done' ? '#fff' : state === 'pending' ? 'var(--color-inksoft)' : 'var(--color-ink)',
                  }}
                >
                  {state === 'done' ? '✓' : i + 1}
                </span>
                {state === 'active' ? (
                  <span className="relative overflow-hidden font-medium">
                    {step.label}
                    <span className="absolute inset-0 shimmer opacity-40" aria-hidden="true" />
                  </span>
                ) : (
                  <span style={{ color: state === 'pending' ? 'var(--color-inksoft)' : 'var(--color-ink)' }}>{step.label}</span>
                )}
              </li>
            );
          })}
        </ol>

        <p className="lede mt-10 text-center text-sm">
          This usually takes about a minute. Your report opens right here when it is ready.
        </p>
      </div>
    </div>
  );
}

function FlagCard(props: { flag: RedFlag; index: number }) {
  const { flag, index } = props;
  return (
    <article className={`exhibit ${index % 2 === 0 ? 'exhibit-l' : 'exhibit-r'} p-6 sm:p-7`}>
      <div className="mb-3 flex items-start justify-between gap-4">
        <p className="eyebrow eyebrow-ink !text-[0.7rem]">Exhibit {EXHIBIT_LETTERS[index] ?? index + 1}</p>
        <span className="stamp">{SEVERITY_STAMP[flag.severity]}</span>
      </div>
      <h3 className="display h3 mb-3">{flag.title}</h3>
      {flag.clauseQuote && (
        <blockquote className="mono-quote mb-3 rounded border-l-2 py-2 pl-4 pr-2" style={{ borderColor: 'var(--color-flag)', background: 'rgb(192 57 43 / 0.05)' }}>
          &ldquo;{flag.clauseQuote}&rdquo;
        </blockquote>
      )}
      <p className="body-copy mb-3">{flag.plainEnglish}</p>
      <p className="body-copy" style={{ color: 'var(--color-verdict)' }}>
        <strong>The standard we place into:</strong> {flag.goodStandard}
      </p>
      {flag.estAnnualImpactUsdPer100k != null && flag.estAnnualImpactUsdPer100k > 0 && (
        <p className="tnum mt-3 text-sm" style={{ color: 'var(--color-inksoft)' }}>
          Estimated impact: about {usd(flag.estAnnualImpactUsdPer100k)}/yr per $100,000 factored, before human review.
        </p>
      )}
    </article>
  );
}

function ResultsView(props: { report: VisitorReport }) {
  const r = props.report;

  if (r.status === 'not_factoring') {
    return (
      <ResultShell title="That does not read as a factoring agreement">
        <p className="body-copy mb-4">
          Honest answer: the document you uploaded does not look like a factoring agreement or proposal, so we are not going to
          invent a savings number for it. If you meant to upload a different file,{' '}
          <a className="underline" href="/audit">run the audit again</a> with your factoring contract.
        </p>
        <p className="body-copy mb-8">Either way, we have your details and will reach out to help you get the right document in front of us.</p>
        <Disclaimers items={r.disclaimers} />
      </ResultShell>
    );
  }

  if (r.status === 'unreadable') {
    return (
      <ResultShell title="We could not read that file">
        <p className="body-copy mb-4">
          The upload came through, but the pages were not readable enough to audit. Clear photos of each page usually fix this:
          good light, straight on, one page per photo. <a className="underline" href="/audit">Try the upload again</a> whenever you are ready.
        </p>
        <p className="body-copy mb-8">Your details are in either way, and our analyst can also review the original file personally.</p>
        <Disclaimers items={r.disclaimers} />
      </ResultShell>
    );
  }

  if (r.status === 'manual_review') {
    return (
      <ResultShell title="Your contract is with our analyst">
        <p className="body-copy mb-4">
          The automated read hit a snag on this one, so a human is taking over. Our analyst will review your contract personally
          and we will contact you within one business day with the findings.
        </p>
        <p className="body-copy mb-8">Nothing else to do on your end.</p>
        <Disclaimers items={r.disclaimers} />
      </ResultShell>
    );
  }

  // status === 'ok'
  const rates = r.rates;
  const verdict = r.verdict;
  const worthAMove = verdict?.canLikelyHelp ?? false;
  // Red alarm styling only when the contract is actually the problem; a
  // competitive contract's numbers stay ink.
  const effColor = worthAMove ? 'var(--color-flag)' : 'var(--color-ink)';
  const savingsLine = r.headline
    ? r.headline.volumeKnown && r.headline.savingsMinPerYear
      ? { big: usd(r.headline.savingsMinPerYear), suffix: 'per year, minimum' }
      : r.headline.savingsPerYearPer100k
        ? { big: usd(r.headline.savingsPerYearPer100k), suffix: 'per year, minimum, for every $100,000 you factor' }
        : null
    : null;

  return (
    <div className="container-page max-w-3xl pb-20 pt-10 sm:pt-14">
      <p className="eyebrow mb-2">Audit complete</p>
      <h1 className="display h2 mb-8">Your contract audit</h1>

      {savingsLine && (
        <section className="sheet mb-8 p-7 sm:p-9">
          <p className="eyebrow eyebrow-ink mb-2">Ballpark savings estimate</p>
          <p className="display tnum" style={{ fontSize: 'clamp(2.4rem, 7vw, 3.6rem)' }}>
            {savingsLine.big}
          </p>
          <p className="lede mt-1">{savingsLine.suffix}</p>
          <p className="mt-4 text-sm" style={{ color: 'var(--color-inksoft)' }}>
            Computed from the conservative end of every assumption, pending human review. The confirmed number is usually higher, not lower.
          </p>
        </section>
      )}

      {rates && (
        <section className="sheet mb-8 p-7 sm:p-9">
          <p className="eyebrow eyebrow-ink mb-5">Perceived vs effective</p>
          <div className="mb-6 grid gap-6 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-sm font-medium" style={{ color: 'var(--color-inksoft)' }}>The rate you think you pay</p>
              <p className="display tnum h2">~{rates.perceivedApr}%<span className="text-lg font-normal">/yr</span></p>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium" style={{ color: effColor }}>What this contract actually costs</p>
              <p className="display tnum h2" style={{ color: effColor }}>
                ~{rates.effectiveAprAtTypical}%<span className="text-lg font-normal">/yr</span>
              </p>
              <p className="mt-1 text-sm" style={{ color: 'var(--color-inksoft)' }}>
                at a typical 45-day pay cycle, on the cash you actually receive
              </p>
            </div>
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="ledger-row" style={{ color: 'var(--color-inksoft)' }}>
                <th className="py-2 font-medium">Invoice pays on day</th>
                <th className="py-2 font-medium">Fee, % of invoice</th>
                <th className="py-2 font-medium">Effective annual rate on cash</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {rates.scenarios.map((s) => (
                <tr key={s.days} className="ledger-row">
                  <td className="py-2">{s.days}</td>
                  <td className="py-2">{s.feePctOfFace}%</td>
                  <td className="py-2">{s.aprOnCash}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs" style={{ color: 'var(--color-inksoft)' }}>
            Advance rate used: {rates.advanceRatePct}%. Every figure here is an automated estimate from your document.
          </p>
        </section>
      )}

      {r.flags.length > 0 && (
        <section className="mb-8">
          <p className="eyebrow mb-5">What we flagged in your contract</p>
          <div className="space-y-6">
            {r.flags.map((flag, i) => (
              <FlagCard key={flag.id} flag={flag} index={i} />
            ))}
          </div>
          {r.totalFlagCount > r.flags.length && (
            <p className="mt-4 text-sm" style={{ color: 'var(--color-inksoft)' }}>
              Plus {r.totalFlagCount - r.flags.length} more item{r.totalFlagCount - r.flags.length === 1 ? '' : 's'} in the full
              review. Your specialist walks you through all of them.
            </p>
          )}
        </section>
      )}

      {verdict && (
        <section className="sheet mb-8 p-7 sm:p-9">
          <div className="mb-3 flex items-center gap-3">
            <p className="eyebrow eyebrow-ink !mb-0">The verdict</p>
            <span className={verdict.canLikelyHelp ? 'stamp' : 'stamp stamp-green'}>
              {verdict.canLikelyHelp ? 'Worth a move' : 'Keep your contract'}
            </span>
          </div>
          <p className="body-copy">{verdict.line}</p>
        </section>
      )}

      <section className="navy-band mb-8 rounded-xl p-7 sm:p-9">
        <p className="eyebrow mb-2" style={{ color: 'var(--color-marker)' }}>What happens next</p>
        <p className="body-copy" style={{ color: 'var(--color-cream)' }}>
          {worthAMove
            ? 'We will contact you to nail down a real number against your actual volume. No calendar pressure, no obligation, and the contract you uploaded is used only for this audit.'
            : 'We will reach out to confirm this read. Keep the report handy for your renewal window, and if your terms ever change, run the audit again. The contract you uploaded is used only for this audit.'}
        </p>
      </section>

      {r.assumptions.length > 0 && (
        <section className="mb-6">
          <p className="mb-2 text-sm font-medium">Assumptions used</p>
          <ul className="list-disc space-y-1 pl-5 text-sm" style={{ color: 'var(--color-inksoft)' }}>
            {r.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      <Disclaimers items={r.disclaimers} />
    </div>
  );
}

function ResultShell(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="container-page max-w-2xl pb-20 pt-10 sm:pt-14">
      <p className="eyebrow mb-2">Audit result</p>
      <h1 className="display h2 mb-6">{props.title}</h1>
      {props.children}
    </div>
  );
}

function Disclaimers(props: { items: string[] }) {
  return (
    <div className="rounded border p-4 text-xs leading-relaxed" style={{ borderColor: 'var(--color-rule)', color: 'var(--color-inksoft)' }}>
      {props.items.map((d, i) => (
        <p key={i} className={i > 0 ? 'mt-2' : ''}>
          {d}
        </p>
      ))}
    </div>
  );
}

function FailedView() {
  return (
    <ResultShell title="Your contract is with our analyst">
      <p className="body-copy mb-4">
        The automated read hit a snag, but your submission went through and nothing was lost. Our analyst will review your
        contract personally and we will contact you within one business day with the findings.
      </p>
      <p className="body-copy">Nothing else to do on your end.</p>
    </ResultShell>
  );
}

// ---------------------------------------------------------------------------
// main island

interface Props {
  mode: 'form' | 'results';
  jobId?: string;
}

interface PickedFile {
  file: File;
  kind: 'pdf' | 'docx' | 'jpeg' | 'png';
}

type Phase = 'form' | 'uploading' | 'processing' | 'done' | 'failed';

export default function AuditFlow({ mode, jobId: initialJobId }: Props) {
  const [phase, setPhase] = useState<Phase>(mode === 'results' ? 'processing' : 'form');
  const [step, setStep] = useState<StepKey>(mode === 'results' ? 'reading_contract' : 'uploading');
  const [report, setReport] = useState<VisitorReport | null>(null);

  const [files, setFiles] = useState<PickedFile[]>([]);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [consented, setConsented] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadPct, setUploadPct] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const inFlightRef = useRef(false);
  const jobIdRef = useRef<string | null>(initialJobId ?? null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollStartRef = useRef(0);
  const notFoundRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ---- polling ----
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const pollOnce = useCallback(async () => {
    const id = jobIdRef.current;
    if (!id) return;

    // dev mock: advance stages locally, then serve a canned report
    const mock = getMockKey();
    if (mock) {
      // ?mockdone=1 jumps straight to the terminal state (QA screenshots)
      if (new URLSearchParams(window.location.search).has('mockdone')) {
        if (mock === 'error') setPhase('failed');
        else {
          setReport(mockReport(mock));
          setPhase('done');
        }
        return;
      }
      const elapsed = Date.now() - pollStartRef.current;
      const order: StepKey[] = ['reading_contract', 'extracting_terms', 'computing_rates', 'building_report'];
      const idx = Math.floor(elapsed / 1800);
      if (mock === 'error') {
        if (elapsed > 3500) {
          setPhase('failed');
          return;
        }
      } else if (idx >= order.length) {
        setReport(mockReport(mock));
        setPhase('done');
        return;
      }
      setStep(order[Math.min(idx, order.length - 1)]);
      pollTimerRef.current = setTimeout(pollOnce, 600);
      return;
    }

    if (Date.now() - pollStartRef.current > POLL_TIMEOUT_MS) {
      setPhase('failed');
      return;
    }
    try {
      const res = await fetch(`/api/audit/status?jobId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (res.status === 404) {
        notFoundRef.current += 1;
        if (notFoundRef.current > MAX_NOT_FOUND) {
          setPhase('failed');
          return;
        }
      } else if (res.ok) {
        notFoundRef.current = 0;
        const data = (await res.json()) as { done: boolean; stage?: StepKey; report?: VisitorReport };
        if (data.done && data.report) {
          setReport(data.report);
          setPhase('done');
          return;
        }
        if (data.stage) setStep(data.stage);
      }
      // 5xx: keep polling until the overall timeout
    } catch {
      // network blip: keep polling until the overall timeout
    }
    pollTimerRef.current = setTimeout(pollOnce, POLL_MS);
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollStartRef.current = Date.now();
    notFoundRef.current = 0;
    pollOnce();
  }, [pollOnce, stopPolling]);

  useEffect(() => {
    if (mode === 'results') startPolling();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- file selection ----
  const addFiles = useCallback(
    async (incoming: FileList | File[]) => {
      setFormError(null);
      const picked: PickedFile[] = [];
      for (const file of Array.from(incoming)) {
        const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        const kind = sniffBytes(bytes);
        if (kind === 'unknown') {
          setFormError(`"${file.name}" is not a PDF, DOCX, JPG, or PNG. That is all the auditor can read.`);
          return;
        }
        picked.push({ file, kind });
      }

      setFiles((prev) => {
        const hasDoc = picked.some((p) => !isPhoto(p.kind));
        let next: PickedFile[];
        if (hasDoc) {
          // one document replaces everything
          next = [picked.find((p) => !isPhoto(p.kind))!];
          if (picked.length > 1) setFormError('One contract file at a time. We kept the document and dropped the rest.');
        } else {
          const existingDoc = prev.some((p) => !isPhoto(p.kind));
          next = existingDoc ? picked : [...prev, ...picked];
        }
        if (next.length > MAX_PHOTOS) {
          setFormError(`Up to ${MAX_PHOTOS} photos. We kept the first ${MAX_PHOTOS}.`);
          next = next.slice(0, MAX_PHOTOS);
        }
        const total = next.reduce((sum, p) => sum + p.file.size, 0);
        if (total > MAX_TOTAL_BYTES) {
          setFormError('That upload is over the 20MB limit. Try compressing the PDF or uploading fewer, smaller photos.');
          return prev;
        }
        return next;
      });
    },
    [],
  );

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ---- phone autofill gotcha: strip a leading +1 / 1 country code ----
  const normalizePhone = (v: string) => v.replace(/^\s*\+?1[\s.\-]?(?=[(2-9])/, '');

  // ---- submit ----
  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (inFlightRef.current) return;
      setFormError(null);

      if (files.length === 0) return setFormError('Add your contract first. A PDF, DOCX, or photos of the pages all work.');
      if (!name.trim()) return setFormError('Add your name.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setFormError('That email does not look complete.');
      if (phone.replace(/\D/g, '').length < 10) return setFormError('That phone number does not look complete.');
      if (!consented) return setFormError('Check the consent box so we can legally contact you about your audit.');

      inFlightRef.current = true;
      setPhase('uploading');
      setStep('uploading');
      setUploadPct(0);

      try {
        const mock = getMockKey();
        let uploaded: { url: string; pathname: string; contentType: string }[];
        let newJobId: string;

        if (mock) {
          // dev mock: skip network entirely
          await new Promise((r) => setTimeout(r, 900));
          setUploadPct(100);
          uploaded = [];
          newJobId = nanoid(21);
        } else {
          const batch = nanoid(12);
          const totalBytes = files.reduce((s, p) => s + p.file.size, 0);
          let doneBytes = 0;
          uploaded = [];
          for (const picked of files) {
            const safeName = picked.file.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'contract';
            const result = await upload(`contracts/${batch}/${safeName}`, picked.file, {
              access: 'public',
              handleUploadUrl: '/api/audit/upload',
              contentType: contentTypeFor(picked.kind),
              onUploadProgress: ({ loaded }) => {
                setUploadPct(Math.min(99, Math.round(((doneBytes + loaded) / totalBytes) * 100)));
              },
            });
            doneBytes += picked.file.size;
            uploaded.push({ url: result.url, pathname: result.pathname, contentType: contentTypeFor(picked.kind) });
          }
          setUploadPct(100);

          const res = await fetch('/api/audit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: name.trim(),
              email: email.trim(),
              phone: phone.trim(),
              company: honeypot,
              files: uploaded,
              consent: {
                agreed: true,
                text: CONSENT_TEXT,
                clientTimestamp: new Date().toISOString(),
                url: window.location.href,
              },
            }),
          });
          if (res.status === 429) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? 'Too many audits from this connection. Try again in an hour.');
          }
          if (!res.ok) throw new Error('submit failed');
          const body = (await res.json()) as { jobId: string };
          newJobId = body.jobId;
        }

        jobIdRef.current = newJobId;
        const search = mock ? `?mock=${mock}` : '';
        window.history.replaceState(null, '', `/audit/results/${newJobId}${search}`);
        setPhase('processing');
        setStep('reading_contract');
        startPolling();
      } catch (err) {
        inFlightRef.current = false;
        const message = err instanceof Error && err.message.startsWith('Too many') ? err.message : null;
        if (message) {
          setPhase('form');
          setFormError(message);
        } else {
          // upload or submit failed after retry-worthy effort: honest fallback
          setPhase('form');
          setFormError('Something interrupted the upload. Nothing was submitted, so give it one more try, or email us the contract instead.');
        }
      }
    },
    [files, name, email, phone, consented, honeypot, startPolling],
  );

  // ---- render ----
  if (phase === 'done' && report) return <ResultsView report={report} />;
  if (phase === 'failed') return <FailedView />;
  if (phase === 'processing') return <ProcessingView activeStep={step} />;
  if (phase === 'uploading') {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'var(--color-paper)' }}>
        <div className="container-page w-full max-w-md text-center">
          <p className="eyebrow mb-4">Audit in progress</p>
          <p className="display h3 mb-6">Uploading your contract</p>
          <div className="mx-auto h-2 w-full max-w-xs overflow-hidden rounded-full" style={{ background: 'rgb(16 29 51 / 0.08)' }}>
            <div className="h-full rounded-full transition-all duration-300" style={{ width: `${uploadPct}%`, background: 'var(--color-ink)' }} />
          </div>
          <p className="tnum mt-3 text-sm" style={{ color: 'var(--color-inksoft)' }}>{uploadPct}%</p>
        </div>
      </div>
    );
  }

  if (mode === 'results') {
    // results mode with no report yet is covered by 'processing'; this is a
    // safety net if phase somehow resets.
    return <ProcessingView activeStep={step} />;
  }

  const totalPhotos = files.filter((p) => isPhoto(p.kind)).length;

  return (
    <form className="sheet mx-auto max-w-xl p-6 sm:p-8" onSubmit={handleSubmit} noValidate>
      {/* upload */}
      <FieldRow label="Your factoring contract">
        <div
          className={`dropzone p-6 text-center ${dragOver ? 'drag-over' : ''} ${files.length > 0 ? 'has-files' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
        >
          {files.length === 0 ? (
            <>
              <p className="font-medium">Drop it here or tap to choose</p>
              <p className="mt-1 text-sm" style={{ color: 'var(--color-inksoft)' }}>
                PDF or DOCX, or up to 30 photos of the pages
              </p>
            </>
          ) : (
            <div className="text-left">
              {files.length === 1 && !isPhoto(files[0].kind) ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="truncate font-medium">{files[0].file.name}</p>
                  <button
                    type="button"
                    className="shrink-0 text-sm underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(0);
                    }}
                  >
                    remove
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <p className="font-medium">
                    {totalPhotos} photo{totalPhotos === 1 ? '' : 's'} added
                  </p>
                  <button
                    type="button"
                    className="shrink-0 text-sm underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFiles([]);
                    }}
                  >
                    clear
                  </button>
                </div>
              )}
              <p className="mt-1 text-sm" style={{ color: 'var(--color-inksoft)' }}>
                Tap to add more or replace
              </p>
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept=".pdf,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          multiple
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <p className="text-sm" style={{ color: 'var(--color-inksoft)' }}>
          {REASSURANCE}
        </p>
      </FieldRow>

      <div className="mt-5 space-y-4">
        <FieldRow label="Name">
          <input className="field" type="text" name="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        </FieldRow>
        <FieldRow label="Email">
          <input className="field" type="email" name="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </FieldRow>
        <FieldRow label="Phone">
          <input
            className="field"
            type="tel"
            name="phone"
            autoComplete="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(normalizePhone(e.target.value))}
          />
        </FieldRow>
      </div>

      {/* honeypot: humans never see it, autofill skips aria-hidden + tabIndex -1 */}
      <div aria-hidden="true" className="absolute h-0 w-0 overflow-hidden">
        <label>
          Company
          <input type="text" name="company" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
        </label>
      </div>

      <label className="mt-6 flex items-start gap-3 text-sm leading-relaxed" style={{ color: 'var(--color-inksoft)' }}>
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-ink)]"
          checked={consented}
          onChange={(e) => setConsented(e.target.checked)}
        />
        <span>{CONSENT_TEXT}</span>
      </label>

      {formError && (
        <p className="mt-4 rounded border px-4 py-3 text-sm" style={{ borderColor: 'var(--color-flag)', color: 'var(--color-flag)', background: 'rgb(192 57 43 / 0.05)' }} role="alert">
          {formError}
        </p>
      )}

      <button type="submit" className="btn btn-flag mt-6 w-full" disabled={!consented}>
        Audit my contract
      </button>

      <p className="mt-3 text-center text-xs" style={{ color: 'var(--color-inksoft)' }}>
        Your details are handled per our{' '}
        <a className="underline" href="/privacy">
          privacy policy
        </a>
        .
      </p>
    </form>
  );
}
