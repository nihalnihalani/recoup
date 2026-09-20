import { useParams } from "react-router-dom";
import { Empty } from "../components/States";

// T11b: wire api.claims.get({ id }) for the ledger strip (expected, promised, confirmed,
// unresolved), the thread, and the next-action/follow-up date.
// T11b: draft lifecycle calls api.drafts.generate, api.drafts.approveAndSend,
// api.drafts.sendStatus (D29: polled by draftId) and api.drafts.markPacketSent for the
// non-email packet path.
// T11b: ledger actions call api.claims.confirmCredit and api.claims.recordLaterDebit
// (D24: both take a client-generated idempotencyKey); api.claims.dismiss closes a claim out.
export default function Claim() {
  const { id } = useParams();

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Claim</p>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">
          {id ? `Claim ${id}` : "Claim"}
        </h1>
      </div>

      <Empty
        title="This claim isn't loaded yet"
        hint="The ledger, the draft, and the message thread for this claim will appear here."
      />
    </div>
  );
}
