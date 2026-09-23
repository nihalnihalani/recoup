import { useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { AddCard } from "../components/add/AddCard";
import { ManualEntry } from "../components/add/ManualEntry";
import { PastePanel } from "../components/add/PastePanel";
import { RecentUploads } from "../components/add/RecentUploads";
import { UploadPanel } from "../components/add/UploadPanel";
import { pageTitleClass } from "../lib/ui";

/**
 * /add, the intake hub (M24; contract §9): forward or paste an email, upload a document with a REQUIRED type, or
 * enter a purchase by hand. Everything added is checked against supported recovery paths only (§20), and nothing
 * read from an email or a file is treated as confirmed until the user confirms it.
 */
export default function Add() {
  const profile = useQuery(api.profiles.me);
  const inbox = profile?.inboxEmail ?? null;
  return (
    <div className="space-y-6">
      <div>
        <h1 className={pageTitleClass}>Add a purchase or transaction</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          Recoup checks supported recovery paths for what you add. Anything read from an email or a document waits for
          you to confirm it.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <AddCard
          id="add-paste"
          title="Paste an email"
          hint={
            inbox ? (
              <>
                Or forward it to <span className="font-medium text-gray-900">{inbox}</span>.
              </>
            ) : (
              <>
                Or set up your Recoup inbox in <Link to="/settings" className="font-medium text-gray-900 underline underline-offset-4">Settings</Link> and forward it.
              </>
            )
          }
        >
          <PastePanel />
        </AddCard>

        <AddCard id="add-upload" title="Upload a document" hint="A receipt, e-ticket, statement or photo, stored with its type.">
          <UploadPanel />
          <RecentUploads />
        </AddCard>

        <AddCard
          id="add-manual"
          title="Enter it yourself"
          className="lg:col-span-2"
          hint="A store purchase, a flight or a card charge. What you type is recorded as your own entry."
        >
          <ManualEntry />
        </AddCard>
      </div>
    </div>
  );
}
