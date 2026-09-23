import { useAuthToken } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Doc, Id } from "../../../convex/_generated/dataModel";
import { MAX_UPLOAD_BYTES, uploadEvidence } from "../../lib/evidenceFetch";
import {
  day,
  errorText,
  fromDateInput,
  inputClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
  toDateInput,
  todayInput,
  useNow,
  useOnline,
  when,
} from "../../lib/ui";
import { describeFactValue, formatDue, humanizeKeys, mustBeCopy, type DeadlineResult } from "../opportunity/model";
import { Loading } from "../States";
import { FACT_STATE_COPY } from "../transaction/labels";
import { CHANNEL_LABELS, PACKET_STATUS_COPY, RECIPIENT_SOURCE_LABELS, type ManualChannel } from "./labels";

type PacketView = FunctionReturnType<typeof api.packets.get>;
type PrepareRefusal = Extract<FunctionReturnType<typeof api.packets.prepare>, { ok: false }>;
type Submission = Doc<"submissions">;
type UserDeadline = DeadlineResult & { dueAt: number };

/** A result or refusal shown above the packet. Its heading takes focus, so a keyboard user lands on it (DA-B-12). */
export type Notice = {
  tone: "info" | "warn" | "error";
  title: string;
  message: string;
  findings?: string[];
  /** confirm_facts: where the user answers the fact. */
  link?: { to: string; label: string };
};

const WITHDRAWN_TITLE = "Recoup's automatic check for this claim was withdrawn";

/**
 * The manual-channel packet of a claim whose required channel is not email (contract §6 "Manual approval", §9
 * "Packet review"; mission §14 "Manual channels"). Recoup prepares it; the user reviews, edits and approves exactly
 * the text shown (the rendered hash); the user files it THEMSELVES and records that they did, with optional proof,
 * and later records delivery. Recoup never sends a packet and never says it arrived: prepared ≠ submitted ≠
 * delivered. The facts the packet was written and approved on are shown (N6). A withdrawn rule is refused once and
 * the same step then goes through without the automatic check (N3), so the notice tells the user to try again.
 */
export function PacketSection({ claim, closed }: { claim: Doc<"claims">; closed: boolean }) {
  const list = useQuery(api.packets.listForClaim, { claimId: claim._id });
  const prepare = useMutation(api.packets.prepare);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // A freshly prepared version takes focus once it renders, so a keyboard user lands on what to review.
  const [focusId, setFocusId] = useState<Id<"packets"> | null>(null);

  if (list === undefined) return <Loading rows={2} />;
  const newest = list.packets[0];
  const earlier = list.packets.slice(1);
  const channel = claim.requiredChannel && claim.requiredChannel !== "email" ? claim.requiredChannel : (newest?.channel ?? null);
  const canPrepare = !closed && (!newest || newest.status === "draft" || newest.status === "approved");

  async function onPrepare() {
    setNotice(null);
    setBusy(true);
    try {
      const result = await prepare({ claimId: claim._id });
      if (result.ok) setFocusId(result.packetId);
      else setNotice(prepareNotice(result, claim.transactionId));
    } catch (caught) {
      setNotice({ tone: "error", title: "The packet was not prepared", message: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {channel && <ChannelIntro channel={channel} />}
      <PacketStages packet={newest} submissions={list.submissions} />
      {notice && <NoticePanel notice={notice} />}
      {newest ? (
        <PacketVersion
          key={newest._id}
          packetId={newest._id}
          closed={closed}
          focusOnReady={newest._id === focusId}
          onNotice={setNotice}
        />
      ) : (
        <div className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-sm text-gray-600">
          {closed ? "No packet was prepared for this claim." : "No packet yet. Recoup writes it from the facts you confirmed."}
        </div>
      )}
      {canPrepare && (
        <button
          type="button"
          disabled={busy}
          className={newest ? secondaryButtonClass : primaryButtonClass}
          onClick={() => void onPrepare()}
        >
          {busy ? "Preparing…" : !newest ? "Prepare the packet" : "Prepare a new version from the latest facts"}
        </button>
      )}
      {earlier.length > 0 && (
        <details className="rounded-xl border border-gray-200">
          <summary className="cursor-pointer rounded-xl px-3.5 py-2.5 text-sm font-medium text-gray-900 focus-visible:outline-2 focus-visible:outline-violet-500">
            Earlier versions ({earlier.length})
          </summary>
          <ul className="divide-y divide-gray-100 border-t border-gray-200 px-3.5 text-sm">
            {earlier.map((p) => (
              <li key={p._id} className="py-2 text-gray-700">
                <span className="font-medium text-gray-900">Version {p.version}</span> · {PACKET_STATUS_COPY[p.status]}
                {p.approvedAt !== undefined && ` Approved ${when(p.approvedAt)}.`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ChannelIntro({ channel }: { channel: ManualChannel }) {
  const { name, how } = CHANNEL_LABELS[channel];
  return (
    <p className="text-sm text-gray-700">
      This claim is filed by <span className="font-semibold text-gray-900">{name.toLowerCase()}</span>, not by email.
      Recoup prepares the packet and never sends it. {how}
    </p>
  );
}

/** Four separate facts about a packet, each shown as reached only when it is true: prepared ≠ submitted ≠ delivered. */
function PacketStages({ packet, submissions }: { packet: Doc<"packets"> | undefined; submissions: readonly Submission[] }) {
  const mine = packet ? submissions.filter((s) => s.packetId === packet._id) : [];
  const reached = !packet
    ? -1
    : mine.some((s) => s.deliveryRecordedAt !== undefined)
      ? 3
      : packet.status === "submission_recorded" || mine.length > 0
        ? 2
        : packet.status === "approved"
          ? 1
          : 0;
  const stages = [
    { label: "Prepared", detail: "Recoup wrote it. Nothing is sent." },
    { label: "Approved", detail: "You approved exactly this text." },
    { label: "Submitted", detail: "You filed it yourself and recorded that here." },
    { label: "Delivered", detail: "You recorded that it arrived. Recoup can't see this." },
  ];
  return (
    <ol aria-label="Packet progress" className="grid gap-2 sm:grid-cols-4">
      {stages.map((stage, i) => {
        const done = i <= reached;
        return (
          <li
            key={stage.label}
            aria-current={i === reached ? "step" : undefined}
            className={`rounded-lg border px-3 py-2 text-xs ${done ? "border-moss/40 bg-moss/5" : "border-gray-200"}`}
          >
            <p className={`font-semibold ${done ? "text-gray-900" : "text-gray-600"}`}>
              <span aria-hidden="true" className={`mr-1.5 inline-block size-2 rounded-full ${done ? "bg-moss" : "bg-gray-300"}`} />
              {stage.label}
              <span className="sr-only">{done ? " (yes)" : " (not yet)"}</span>
            </p>
            <p className="mt-0.5 text-gray-600">{stage.detail}</p>
          </li>
        );
      })}
    </ol>
  );
}

function prepareNotice(result: PrepareRefusal, transactionId: Id<"transactions"> | undefined): Notice {
  switch (result.code) {
    case "rule_withdrawn":
      return {
        tone: "warn",
        title: WITHDRAWN_TITLE,
        message: "The packet was not prepared. Prepare it again to continue without that check, then check every detail yourself.",
      };
    case "confirm_facts": {
      const names = (result.keys ?? []).map((k) => humanizeKeys(k.key));
      return {
        tone: "warn",
        title: "Confirm a fact first",
        message:
          names.length > 0
            ? `Recoup needs you to confirm the ${names.join(", ")} before it can write this packet.`
            : humanizeKeys(result.message),
        ...(transactionId ? { link: { to: `/transactions/${transactionId}`, label: "Answer it on the transaction page" } } : {}),
      };
    }
    case "rate_limited":
      return { tone: "info", title: "Not prepared yet", message: result.message };
    default:
      return { tone: "error", title: "The packet was not prepared", message: result.message };
  }
}

export function NoticePanel({ notice }: { notice: Notice }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const id = useId();
  useEffect(() => headingRef.current?.focus(), [notice]);
  const tone =
    notice.tone === "error"
      ? "border-red-500/30 bg-red-500/5 text-red-700"
      : notice.tone === "warn"
        ? "border-yellow-500/40 bg-yellow-500/10 text-gray-900"
        : "border-gray-200 text-gray-900";
  return (
    <section aria-labelledby={id} className={`space-y-1.5 rounded-xl border px-3.5 py-3 text-sm ${tone}`}>
      <h3 id={id} ref={headingRef} tabIndex={-1} className="font-semibold outline-none focus-visible:underline">
        {notice.title}
      </h3>
      <p>{notice.message}</p>
      {notice.findings && notice.findings.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5">
          {notice.findings.map((f) => (
            <li key={f} className="break-all">
              {f}
            </li>
          ))}
        </ul>
      )}
      {notice.link && (
        <Link
          to={notice.link.to}
          className="inline-block rounded font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
        >
          {notice.link.label}
        </Link>
      )}
    </section>
  );
}

/** The deadline a filing is measured against: the earliest user-side deadline with a due instant (as the server does). */
function userDeadline(deadlines: readonly DeadlineResult[]): UserDeadline | null {
  let best: UserDeadline | null = null;
  for (const d of deadlines) {
    if (d.obligor !== "user" || d.dueAt === undefined) continue;
    if (best === null || d.dueAt < best.dueAt) best = { ...d, dueAt: d.dueAt };
  }
  return best;
}

/** The newest packet version: its text, the facts it rests on, and the next step for its status. */
function PacketVersion({
  packetId,
  closed,
  focusOnReady,
  onNotice,
}: {
  packetId: Id<"packets">;
  closed: boolean;
  focusOnReady: boolean;
  onNotice: (n: Notice | null) => void;
}) {
  const view = useQuery(api.packets.get, { packetId });
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const ready = view !== undefined;
  const now = useNow();
  useEffect(() => {
    if (focusOnReady && ready) headingRef.current?.focus();
  }, [focusOnReady, ready]);
  if (view === undefined) return <Loading rows={2} />;
  const { packet } = view;
  const deadline = userDeadline(view.deadlines);
  return (
    <article aria-labelledby={headingId} className="space-y-4 rounded-xl border border-gray-200 p-4">
      <header className="space-y-1">
        <h3
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-semibold text-gray-900 outline-none focus-visible:underline"
        >
          Packet version {packet.version} · {CHANNEL_LABELS[packet.channel].name}
        </h3>
        <p className="text-sm text-gray-700">{PACKET_STATUS_COPY[packet.status]}</p>
        {deadline && (
          <p className="text-sm text-gray-700">
            Your deadline, {deadline.label}: it {mustBeCopy(deadline.mustBe)} {formatDue(deadline)}.
            {deadline.dueAt < now && packet.status !== "submission_recorded" && (
              <span className="font-semibold text-gray-900"> It has passed; the company may refuse a late claim.</span>
            )}
          </p>
        )}
      </header>
      {packet.status === "draft" && !closed ? <DraftEditor view={view} onNotice={onNotice} /> : <PacketText packet={packet} />}
      <BoundFacts view={view} />
      {packet.status === "approved" && !closed && <RecordSubmission packet={packet} onNotice={onNotice} />}
      {view.submissions.map((s) => (
        <SubmissionRecord key={s._id} submission={s} deadline={deadline} closed={closed} />
      ))}
    </article>
  );
}

function packetText(packet: Doc<"packets">): string {
  return [packet.recipient.text, packet.body, packet.requestedRemedy].filter((part) => part.trim().length > 0).join("\n\n");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What was approved (or prepared), read-only, with a copy button for filing it by hand. */
function PacketText({ packet }: { packet: Doc<"packets"> }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  async function onCopy() {
    try {
      await navigator.clipboard.writeText(packetText(packet));
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }
  return (
    <div className="space-y-3 text-sm">
      <Field label="To">
        <p className="whitespace-pre-wrap text-gray-900">{packet.recipient.text || "Not set yet"}</p>
        {packet.recipient.text && (
          <p className="text-xs text-gray-600">{capitalize(RECIPIENT_SOURCE_LABELS[packet.recipient.source])}</p>
        )}
      </Field>
      <Field label="Letter">
        <p className="whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-3 text-gray-900">{packet.body}</p>
      </Field>
      <Field label="What you ask for">
        <p className="text-gray-900">{packet.requestedRemedy}</p>
      </Field>
      {packet.evidenceIndex.length > 0 && (
        <Field label="Documents to include">
          <ul className="list-disc pl-5 text-gray-900">
            {packet.evidenceIndex.map((e) => (
              <li key={e.evidenceId}>{e.label}</li>
            ))}
          </ul>
        </Field>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={secondaryButtonClass} onClick={() => void onCopy()}>
          Copy the packet text
        </button>
        <span role="status" className="text-sm text-gray-700">
          {copy === "copied" ? "Copied." : copy === "failed" ? "Copying didn't work here; select the text instead." : ""}
        </span>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-600">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** N6: the facts this packet (and its approval) rests on, as values, so the approved basis stays visible. */
function BoundFacts({ view }: { view: PacketView }) {
  if (view.boundFacts === null) {
    return (
      <p className="text-sm text-gray-700">
        This packet is not tied to one of Recoup's rule checks, so there are no checked facts to show. Check every detail
        yourself before you file it.
      </p>
    );
  }
  if (view.boundFacts.length === 0) return null;
  const approved = view.packet.approvedAt !== undefined;
  return (
    <details className="rounded-lg border border-gray-200" open={approved}>
      <summary className="cursor-pointer rounded-lg px-3 py-2 text-sm font-medium text-gray-900 focus-visible:outline-2 focus-visible:outline-violet-500">
        {approved ? "The facts you approved this packet on" : "The facts this packet is written from"} ({view.boundFacts.length})
      </summary>
      <dl className="space-y-1.5 border-t border-gray-200 px-3 py-2 text-sm">
        {view.boundFacts.map((f) => (
          <div key={`${f.subjectKey}\u0000${f.key}`} className="flex flex-wrap justify-between gap-x-4">
            <dt className="text-gray-700">{capitalize(humanizeKeys(f.key))}</dt>
            <dd className="text-right text-gray-900">
              {f.value ? describeFactValue(f.value) : "—"}{" "}
              <span className="text-xs text-gray-600">({FACT_STATE_COPY[f.status].label})</span>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

/** Edit (saved as a new version) or approve exactly the text shown: the rendered hash the user reviewed. */
function DraftEditor({ view, onNotice }: { view: PacketView; onNotice: (n: Notice | null) => void }) {
  const { packet } = view;
  const update = useMutation(api.packets.update);
  const approve = useMutation(api.packets.approve);
  const toId = useId();
  const bodyId = useId();
  const remedyId = useId();
  const [to, setTo] = useState(packet.recipient.text);
  const [body, setBody] = useState(packet.body);
  const [remedy, setRemedy] = useState(packet.requestedRemedy);
  const [busy, setBusy] = useState(false);
  // The server-issued hash of the findings the user was shown (DA-B-11); approving "anyway" acknowledges only these.
  const [findingsHash, setFindingsHash] = useState<string | null>(null);
  const edited = to !== packet.recipient.text || body !== packet.body || remedy !== packet.requestedRemedy;

  async function save() {
    onNotice(null);
    setBusy(true);
    try {
      await update({
        packetId: packet._id,
        ...(body !== packet.body ? { body } : {}),
        ...(remedy !== packet.requestedRemedy ? { requestedRemedy: remedy } : {}),
        ...(to !== packet.recipient.text ? { recipient: { text: to, source: "user_entered" as const } } : {}),
      });
      onNotice({ tone: "info", title: "Saved as a new version", message: "Nothing is approved yet. Review it, then approve it." });
    } catch (caught) {
      onNotice({ tone: "error", title: "Your edits were not saved", message: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  async function doApprove(acknowledged: string | null) {
    onNotice(null);
    setBusy(true);
    try {
      const result = await approve({
        packetId: packet._id,
        approvedHash: view.renderedHash,
        ...(acknowledged !== null ? { acknowledgeUnverifiedContent: true, acknowledgedFindingsHash: acknowledged } : {}),
      });
      if (result.ok) {
        setFindingsHash(null);
        onNotice({
          tone: "info",
          title: "Approved. Nothing was sent.",
          message: "File it yourself the way this company accepts claims, then record the submission below.",
        });
      } else if (result.code === "unverified_content") {
        setFindingsHash(result.findingsHash ?? null);
        onNotice({ tone: "warn", title: "Check these details before approving", message: result.message, findings: result.findings });
      } else if (result.code === "rule_withdrawn") {
        onNotice({ tone: "warn", title: WITHDRAWN_TITLE, message: result.message });
      } else {
        onNotice({ tone: result.code === "rate_limited" ? "info" : "error", title: "Not approved", message: result.message });
      }
    } catch (caught) {
      onNotice({ tone: "error", title: "Not approved", message: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={toId} className={labelClass}>
          To{" "}
          {packet.recipient.text && (
            <span className="font-normal text-gray-600">({RECIPIENT_SOURCE_LABELS[packet.recipient.source]})</span>
          )}
        </label>
        <textarea
          id={toId}
          rows={3}
          className={`${inputClass} block resize-y`}
          value={to}
          placeholder="Who you file it with: the address, form or department"
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={bodyId} className={labelClass}>
          Letter
        </label>
        <textarea
          id={bodyId}
          rows={12}
          className={`${inputClass} block resize-y leading-relaxed`}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <div>
        <label htmlFor={remedyId} className={labelClass}>
          What you ask for
        </label>
        <input id={remedyId} className={inputClass} value={remedy} onChange={(e) => setRemedy(e.target.value)} />
      </div>
      <p className="text-sm text-gray-700">
        Approving binds exactly this text and the facts below. Recoup does not send it: you file it yourself.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {edited ? (
          <>
            <button type="button" disabled={busy} className={primaryButtonClass} onClick={() => void save()}>
              {busy ? "Saving…" : "Save as a new version"}
            </button>
            <p className="text-sm text-gray-700">Save your edits before approving.</p>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} className={primaryButtonClass} onClick={() => void doApprove(null)}>
              {busy ? "Approving…" : "Approve this packet"}
            </button>
            {findingsHash !== null && (
              <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void doApprove(findingsHash)}>
                I checked these details. Approve it.
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Uploads a proof file as `submission_proof` through POST /evidence/upload; stored, not read (D145). */
function useProofUpload() {
  const token = useAuthToken();
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  }, [token]);
  const online = useOnline();
  return async (file: File): Promise<{ ok: true; evidenceId: Id<"evidence"> } | { ok: false; message: string }> => {
    const result = await uploadEvidence({ file, docType: "submission_proof", getToken: () => tokenRef.current, online });
    return result.ok ? { ok: true, evidenceId: result.evidenceId as Id<"evidence"> } : { ok: false, message: result.message };
  };
}

function ProofInput({ id, label, onChange }: { id: string; label: string; onChange: (file: File | null) => void }) {
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>
        {label} <span className="font-normal text-gray-600">(optional)</span>
      </label>
      <input
        id={id}
        type="file"
        accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
        aria-describedby={hintId}
        className="block w-full text-sm text-gray-900 file:mr-3 file:rounded-lg file:border file:border-gray-200 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
      <p id={hintId} className="mt-1 text-xs text-gray-600">
        A receipt, screenshot or tracking slip. PDF, JPEG, PNG, WebP or HEIC, up to 10 MB. Recoup stores it and does not
        read it.
      </p>
    </div>
  );
}

/** Filing is the user's act; this records it (DA-A-10): the day, an optional reference, note and proof. */
function RecordSubmission({ packet, onNotice }: { packet: Doc<"packets">; onNotice: (n: Notice | null) => void }) {
  const record = useMutation(api.submissions.record);
  const upload = useProofUpload();
  const dateId = useId();
  const refId = useId();
  const noteId = useId();
  const proofId = useId();
  const headingId = useId();
  const [date, setDate] = useState(() => todayInput());
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    onNotice(null);
    const now = Date.now();
    if (date > todayInput(now)) {
      onNotice({ tone: "error", title: "Not recorded", message: "The day you filed it can't be in the future." });
      return;
    }
    const submittedAt = fromDateInput(date, { now });
    if (submittedAt === null) {
      onNotice({ tone: "error", title: "Not recorded", message: "Enter the day you filed it." });
      return;
    }
    if (proof && proof.size > MAX_UPLOAD_BYTES) {
      onNotice({ tone: "error", title: "Not recorded", message: "That proof file is larger than 10 MB. Nothing was stored." });
      return;
    }
    setBusy(true);
    try {
      let proofEvidenceId: Id<"evidence"> | undefined;
      if (proof) {
        const uploaded = await upload(proof);
        if (!uploaded.ok) {
          onNotice({ tone: "error", title: "Not recorded", message: `${uploaded.message} The submission was not recorded either.` });
          return;
        }
        proofEvidenceId = uploaded.evidenceId;
      }
      const result = await record({
        packetId: packet._id,
        submittedAt,
        ...(reference.trim() ? { confirmationRef: reference.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(proofEvidenceId ? { proofEvidenceId } : {}),
      });
      if (!result.ok) {
        onNotice(
          result.code === "rule_withdrawn"
            ? { tone: "warn", title: WITHDRAWN_TITLE, message: result.message }
            : { tone: result.code === "rate_limited" ? "info" : "error", title: "Not recorded", message: result.message },
        );
        return;
      }
      const parts = [`You recorded filing it on ${day(submittedAt)}. That is not proof it arrived.`];
      if (result.deadline?.late) {
        const due = result.deadline.dueAt !== undefined ? ` (${formatDue({ dueAt: result.deadline.dueAt })})` : "";
        parts.push(`It was filed after the deadline "${result.deadline.label}"${due}, so the company may refuse it as late.`);
      }
      if (result.staleAtRecord) parts.push("The claim changed after you approved this packet; review it.");
      onNotice({
        tone: result.deadline?.late || result.staleAtRecord ? "warn" : "info",
        title: result.deadline?.late ? "Submission recorded, after the deadline" : "Submission recorded",
        message: parts.join(" "),
      });
    } catch (caught) {
      onNotice({ tone: "error", title: "Not recorded", message: errorText(caught) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-lg border border-gray-200 p-3">
      <h4 id={headingId} className="text-sm font-semibold text-gray-900">
        After you file it, record it here
      </h4>
      <p className="text-sm text-gray-700">
        Recording is your statement that you filed it. Recoup can't check it or see whether it arrived.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={dateId} className={labelClass}>
            Day you filed it
          </label>
          <input id={dateId} type="date" max={todayInput()} className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor={refId} className={labelClass}>
            Confirmation or tracking number <span className="font-normal text-gray-600">(optional)</span>
          </label>
          <input id={refId} className={inputClass} value={reference} autoComplete="off" onChange={(e) => setReference(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor={noteId} className={labelClass}>
            Note <span className="font-normal text-gray-600">(optional)</span>
          </label>
          <input id={noteId} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <ProofInput id={proofId} label="Proof you filed it" onChange={setProof} />
        </div>
      </div>
      <button type="button" disabled={busy} className={primaryButtonClass} onClick={() => void submit()}>
        {busy ? "Recording…" : "Record that I submitted it"}
      </button>
    </section>
  );
}

/** A recorded submission, measured against the user deadline, and the user's own record of delivery (never inferred). */
function SubmissionRecord({ submission, deadline, closed }: { submission: Submission; deadline: UserDeadline | null; closed: boolean }) {
  const recordDelivery = useMutation(api.submissions.recordDelivery);
  const upload = useProofUpload();
  const dateId = useId();
  const proofId = useId();
  const [date, setDate] = useState(() => todayInput());
  const [proof, setProof] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const late = deadline !== null && submission.submittedAt > deadline.dueAt;

  async function submit() {
    setError(null);
    const now = Date.now();
    if (date < toDateInput(submission.submittedAt)) return setError("It can't have arrived before the day you filed it.");
    if (date > todayInput(now)) return setError("The day it arrived can't be in the future.");
    const deliveredAt = fromDateInput(date, { now });
    if (deliveredAt === null) return setError("Enter the day it arrived.");
    setBusy(true);
    try {
      let evidenceId: Id<"evidence"> | undefined;
      if (proof) {
        const uploaded = await upload(proof);
        if (!uploaded.ok) return setError(`${uploaded.message} The delivery was not recorded either.`);
        evidenceId = uploaded.evidenceId;
      }
      // Same day as the filing: never an instant before it (the server refuses that).
      await recordDelivery({
        submissionId: submission._id,
        deliveredAt: Math.max(deliveredAt, submission.submittedAt),
        ...(evidenceId ? { evidenceId } : {}),
      });
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Your recorded submission" className="space-y-2 rounded-lg border border-gray-200 p-3 text-sm">
      <p className="text-gray-900">
        <span className="font-semibold">You recorded filing it on {day(submission.submittedAt)}</span>
        {submission.confirmationRef ? `, reference ${submission.confirmationRef}` : ""}.
        {submission.proofEvidenceId && " Your proof is stored with it."}
      </p>
      {late && (
        <p className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-2.5 py-1.5 text-gray-900">
          <span className="font-semibold">Filed after the deadline.</span> "{deadline.label}" was due {formatDue(deadline)}; the
          company may refuse it as late.
        </p>
      )}
      {submission.staleAtRecord && <p className="text-gray-900">The claim changed after you approved this packet; review it.</p>}
      {submission.note && <p className="text-gray-700">Your note: {submission.note}</p>}
      {submission.deliveryRecordedAt !== undefined ? (
        <p className="text-gray-900">You recorded that it arrived on {day(submission.deliveryRecordedAt)}.</p>
      ) : (
        <>
          <p className="text-gray-700">Not recorded as delivered. Recoup can't know whether it arrived.</p>
          {!closed && (
            <div className="space-y-2">
              <div>
                <label htmlFor={dateId} className={labelClass}>
                  Day it arrived
                </label>
                <input
                  id={dateId}
                  type="date"
                  min={toDateInput(submission.submittedAt)}
                  max={todayInput()}
                  className={inputClass}
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>
              <ProofInput id={proofId} label="Proof it arrived" onChange={setProof} />
              <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void submit()}>
                {busy ? "Recording…" : "Record that it arrived"}
              </button>
            </div>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
