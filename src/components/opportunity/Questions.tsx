import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { getFactSpec, type FactSpec, type FactValue } from "../../../convex/lib/facts/catalog";
import { parseDecimalToMinor } from "../../../convex/lib/money";
import { errorText, fromDateInput, inputClass, secondaryButtonClass } from "../../lib/ui";
import { describeFactValue, humanizeKeys, type FactCell, type MissingFact } from "./model";

export type FactAnswer = { subjectKey: string; key: string; value: FactValue };

/**
 * The questions a recovery path still needs (mission §14 "Questions", contract §9, DA-A-24):
 *  - only the evaluation's DECISIVE missing facts (the evaluator lists nothing an already-decided branch needs);
 *  - each says why it is asked, and a sensitive one says so before asking;
 *  - "I don't know" is always an answer (it is recorded as unknown, never as a value, DA-A-1);
 *  - a value Recoup read but nobody confirmed, or values that disagree, are shown with their sources so the user
 *    can confirm or correct them;
 *  - a fact the purchase record backs (`answerVia: "purchases.confirm"`, D164/D167) is corrected on the purchase,
 *    through a link, never answered here, so a user's own answer can never contradict their own purchase record.
 * Answers go through `onAnswer` (the page's `facts.answer`), which re-evaluates on the server (M11d).
 */
export function Questions({
  missing,
  cells,
  purchaseEditHref,
  onAnswer,
  defaultCurrency,
}: {
  missing: readonly MissingFact[];
  /** `facts.list` for the transaction; undefined while it loads. Missing cells are not listed there. */
  cells: readonly FactCell[] | undefined;
  /** Where purchase-record facts are corrected (`/purchases/<id>?edit=details`). */
  purchaseEditHref?: string;
  onAnswer?: (answer: FactAnswer) => Promise<void>;
  /** The currency a money answer starts in (the transaction's). */
  defaultCurrency?: string;
}) {
  const rows = dedupe(missing);
  if (rows.length === 0) return null;
  return (
    <ul className="space-y-3">
      {rows.map((fact) => (
        <li key={`${fact.subjectKey}\u0000${fact.key}`}>
          <Question
            fact={fact}
            cell={cells?.find((c) => c.subjectKey === fact.subjectKey && c.key === fact.key)}
            purchaseEditHref={purchaseEditHref}
            onAnswer={onAnswer}
            defaultCurrency={defaultCurrency}
          />
        </li>
      ))}
    </ul>
  );
}

function dedupe(missing: readonly MissingFact[]): MissingFact[] {
  const seen = new Set<string>();
  return missing.filter((m) => {
    const id = `${m.subjectKey}\u0000${m.key}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

type Route = "purchase" | "answer" | "system";

/** Where the user settles this fact: the purchase form, an answer here, or nowhere (Recoup reads it itself). */
function routeOf(cell: FactCell | undefined, spec: FactSpec | null, purchaseEditHref: string | undefined): Route {
  const via = cell?.answerVia ?? (spec?.userAssertable ? (spec.sourceOfTruth === "purchase_record" && purchaseEditHref ? "purchases.confirm" : "facts.answer") : undefined);
  if (via === "purchases.confirm") return "purchase";
  if (via === "facts.answer") return "answer";
  return "system";
}

function Question({
  fact,
  cell,
  purchaseEditHref,
  onAnswer,
  defaultCurrency,
}: {
  fact: MissingFact;
  cell: FactCell | undefined;
  purchaseEditHref?: string;
  onAnswer?: (answer: FactAnswer) => Promise<void>;
  defaultCurrency?: string;
}) {
  const spec = getFactSpec(fact.key);
  const question = cell?.question ?? spec?.question;
  const prompt = question?.prompt ?? `What is the ${humanizeKeys(fact.key)}?`;
  const route = routeOf(cell, spec, purchaseEditHref);
  const headingId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function answer(value: FactValue) {
    if (!onAnswer) return;
    setError(null);
    setSaved(false);
    setBusy(true);
    try {
      await onAnswer({ subjectKey: fact.subjectKey, key: fact.key, value });
      setSaved(true);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="rounded-xl border border-gray-200 p-3.5">
      <h4 id={headingId} className="text-sm font-semibold text-gray-900">
        {prompt}
      </h4>
      {question?.sensitive && (
        <p className="mt-1 text-xs font-medium text-gray-700">
          Sensitive: Recoup asks only because the answer decides this path. You can say you don't know.
        </p>
      )}
      {question?.why && <p className="mt-1 text-sm text-gray-600">Why we ask: {question.why}</p>}
      {fact.class === "assumption" && (
        <p className="mt-1 text-xs text-gray-600">Until you confirm it, the result carries this as an assumption.</p>
      )}
      <CurrentState fact={fact} cell={cell} />

      <div className="mt-3">
        {route === "purchase" && purchaseEditHref ? (
          <Link to={purchaseEditHref} className={secondaryButtonClass}>
            Check it on the purchase details
          </Link>
        ) : route === "answer" && onAnswer && spec ? (
          <AnswerControls spec={spec} cell={cell} fact={fact} busy={busy} onSubmit={answer} defaultCurrency={defaultCurrency} />
        ) : route === "system" ? (
          <p className="text-sm text-gray-600">Recoup reads this itself; there is nothing for you to enter.</p>
        ) : (
          <p className="text-sm text-gray-600">This can be answered on the purchase or transaction page.</p>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {saved && !error && (
        <p role="status" className="mt-2 text-sm text-green-700">
          Saved. The result above updates with your answer.
        </p>
      )}
    </section>
  );
}

const SOURCE_WORDS: Readonly<Record<string, string>> = {
  user: "you",
  evidence: "your email or document",
  price_check: "a price check",
  legacy_price_check: "a price check",
  derived: "a calculation",
  legacy_purchase: "the purchase record",
};

function sourceWords(source: { kind: string } | undefined): string {
  return source ? (SOURCE_WORDS[source.kind] ?? source.kind) : "an unknown source";
}

function CurrentState({ fact, cell }: { fact: MissingFact; cell: FactCell | undefined }) {
  let text: ReactNode = null;
  if (fact.reason === "candidate_unconfirmed" && cell?.value) {
    text = (
      <>
        Read from {sourceWords(cell.sources?.[0] ?? cell.source)}: <strong className="font-semibold">{describeFactValue(cell.value)}</strong>. Not
        confirmed yet.
      </>
    );
  } else if ((fact.reason === "conflicting" || fact.reason === "conflict_capped") && cell?.conflict) {
    text = (
      <>
        Your documents disagree:{" "}
        {cell.conflict.values.map((v, i) => (
          <span key={i}>
            {i > 0 && " vs "}
            <strong className="font-semibold">{describeFactValue(v.value)}</strong> ({sourceWords(v.source)})
          </span>
        ))}
        .{fact.reason === "conflict_capped" ? " Every value gives the same answer; confirming the right one removes the cap." : ""}
      </>
    );
  } else if (fact.reason === "user_unknown") {
    text = cell?.hint
      ? `You said you don't know. Since then ${sourceWords(cell.hint.source)} suggested ${describeFactValue(cell.hint.value)}.`
      : "You said you don't know. You can answer now if you have found out.";
  } else if (fact.reason === "missing") {
    text = "Not known yet.";
  }
  return text === null ? null : <p className="mt-2 text-sm text-gray-700">{text}</p>;
}

function AnswerControls({
  spec,
  cell,
  fact,
  busy,
  onSubmit,
  defaultCurrency,
}: {
  spec: FactSpec;
  cell: FactCell | undefined;
  fact: MissingFact;
  busy: boolean;
  onSubmit: (value: FactValue) => Promise<void>;
  defaultCurrency?: string;
}) {
  const candidate = fact.reason === "candidate_unconfirmed" && cell?.value && cell.value.kind !== "user_unknown" ? cell.value : null;
  const conflictValues = (fact.reason === "conflicting" || fact.reason === "conflict_capped") && cell?.conflict ? cell.conflict.values : [];
  return (
    <div className="space-y-2.5">
      {(candidate || conflictValues.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {candidate && (
            <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void onSubmit(candidate)}>
              Yes, {describeFactValue(candidate)} is right
            </button>
          )}
          {conflictValues.map((v, i) => (
            <button key={i} type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void onSubmit(v.value)}>
              Use {describeFactValue(v.value)}
            </button>
          ))}
        </div>
      )}
      <ValueForm spec={spec} busy={busy} onSubmit={onSubmit} defaultCurrency={defaultCurrency} correcting={candidate !== null || conflictValues.length > 0} />
      <button
        type="button"
        disabled={busy}
        onClick={() => void onSubmit({ kind: "user_unknown" })}
        className="text-sm font-medium text-gray-700 underline decoration-gray-300 underline-offset-4 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:opacity-60"
      >
        I don't know
      </button>
    </div>
  );
}

/** The typed input for one fact's value kind (catalogue `value`), producing exactly the server's `factValue` shape. */
function ValueForm({
  spec,
  busy,
  onSubmit,
  defaultCurrency,
  correcting,
}: {
  spec: FactSpec;
  busy: boolean;
  onSubmit: (value: FactValue) => Promise<void>;
  defaultCurrency?: string;
  correcting: boolean;
}) {
  const inputId = useId();
  const currencyId = useId();
  const [text, setText] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency ?? "USD");
  const [problem, setProblem] = useState<string | null>(null);
  const label = correcting ? "Or enter the right value" : "Your answer";

  if (spec.value === "bool") {
    return (
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void onSubmit({ kind: "bool", value: true })}>
          Yes
        </button>
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void onSubmit({ kind: "bool", value: false })}>
          No
        </button>
      </div>
    );
  }

  function build(): FactValue | string {
    const raw = text.trim();
    if (raw.length === 0) return "Enter an answer first.";
    switch (spec.value) {
      case "count":
      case "minutes": {
        if (!/^\d+$/.test(raw)) return "Enter a whole number.";
        const n = Number(raw);
        if (spec.min !== undefined && n < spec.min) return `Enter at least ${spec.min}.`;
        if (spec.max !== undefined && n > spec.max) return `Enter at most ${spec.max}.`;
        return spec.value === "count" ? { kind: "count", n } : { kind: "minutes", minutes: n };
      }
      case "text":
        return { kind: "text", text: raw };
      case "identifier":
        return { kind: "identifier", scheme: spec.identifierScheme ?? "order_ref", value: raw };
      case "code": {
        const code = spec.codes === "iso4217" ? raw.toUpperCase() : raw;
        if (Array.isArray(spec.codes) && !spec.codes.includes(code)) return "Choose one of the options.";
        return { kind: "code", code };
      }
      case "local_date":
        return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? { kind: "local_date", date: raw } : "Pick a date.";
      case "instant": {
        // QA-M16-4: an event on today's date is "now", never noon UTC ahead of it; a later date stays allowed here
        // (a promised date can be ahead), an earlier one is never later than now.
        const ms = fromDateInput(raw, { allowFuture: true });
        return ms === null ? "Pick a date." : { kind: "instant", epochMs: ms };
      }
      case "local_datetime":
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw) ? { kind: "local_datetime", dateTime: raw } : "Pick a date and time.";
      case "money": {
        const parsed = parseDecimalToMinor(raw, currency, spec.currencyMode ?? "new_scenario");
        if (parsed.ok) return { kind: "money", amountMinor: parsed.amountMinor, currency };
        if (parsed.signMarked) return "Enter the amount without a minus sign or brackets.";
        return parsed.reason === "unsupported_currency" ? `Recoup cannot use ${currency} here.` : "Enter an amount like 12.50.";
      }
      default:
        return "This answer cannot be entered here.";
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = build();
    if (typeof value === "string") {
      setProblem(value);
      return;
    }
    setProblem(null);
    await onSubmit(value);
    setText("");
  }

  const inputType =
    spec.value === "local_date" || spec.value === "instant" ? "date" : spec.value === "local_datetime" ? "datetime-local" : "text";
  const inputMode = spec.value === "count" || spec.value === "minutes" ? "numeric" : spec.value === "money" ? "decimal" : undefined;

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-40">
        <label htmlFor={inputId} className="mb-1 block text-xs font-medium text-gray-700">
          {label}
        </label>
        {spec.value === "code" && Array.isArray(spec.codes) ? (
          <select id={inputId} className={inputClass} value={text} onChange={(event) => setText(event.target.value)}>
            <option value="">Choose…</option>
            {spec.codes.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        ) : (
          <input
            id={inputId}
            type={inputType}
            inputMode={inputMode}
            className={inputClass}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </div>
      {spec.value === "money" && (
        <div className="w-24">
          <label htmlFor={currencyId} className="mb-1 block text-xs font-medium text-gray-700">
            Currency
          </label>
          <input
            id={currencyId}
            className={`${inputClass} uppercase`}
            maxLength={3}
            value={currency}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          />
        </div>
      )}
      <button type="submit" disabled={busy} className={secondaryButtonClass}>
        {busy ? "Saving…" : "Save answer"}
      </button>
      {problem && (
        <p role="alert" className="basis-full text-sm text-red-700">
          {problem}
        </p>
      )}
    </form>
  );
}
