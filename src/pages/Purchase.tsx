import { useParams } from "react-router-dom";
import { Empty } from "../components/States";

// T11b: wire api.purchases.get({ id }) for items, paid vs. latest observed price, price
// history, and the policy card (passage, source, retrieval time, channel).
// T11b: item actions call api.purchases.setReturned and api.purchases.confirm.
// T11b: "Open claim" on an item with a gap calls api.claims.open.
// T11b: the policy card's refresh/paste-a-rule actions call api.policies.refresh and
// api.policies.confirm; the manual price recheck button calls api.priceWatch.checkNow.
export default function Purchase() {
  const { id } = useParams();

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-ink/40">Purchase</p>
        <h1 className="font-serif text-2xl font-semibold tracking-tight text-ink">
          {id ? `Case ${id}` : "Purchase"}
        </h1>
      </div>

      <Empty
        title="Items aren't loaded yet"
        hint="This page will show line items, prices, returns, and the merchant's policy for this purchase."
      />
    </div>
  );
}
