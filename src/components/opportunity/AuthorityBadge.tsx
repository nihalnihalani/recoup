import { AUTHORITY_COPY, type AuthorityClass } from "./model";

/**
 * The kind of right behind a recovery path (mission §14): a law, a contract, the business's own promise, a
 * settlement/program, or goodwill. The label carries the meaning; the description says, in words, what that
 * authority is and is not (a merchant promise is never presented as the law).
 */
export function AuthorityBadge({ authority }: { authority: AuthorityClass }) {
  const copy = AUTHORITY_COPY[authority];
  return (
    <span
      className="inline-flex items-center whitespace-nowrap rounded-lg border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-700"
      title={copy.description}
    >
      <span className="sr-only">Authority: </span>
      {copy.label}
    </span>
  );
}
