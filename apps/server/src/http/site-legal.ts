import { escape } from "./layout.js";

/**
 * /terms and /dpa: the provisional contract terms, in English only (they are
 * for partners and their customers, whatever language the reader browses in).
 * They follow the licensing chain: the licensor licenses Sigillo to a partner,
 * who offers it to its own customers. Plain text as data, so the pages and
 * the tests read the same words. Nothing here is a signed agreement: both
 * pages say so, and say that a lawyer reviews them before the first contract.
 */

export interface LegalSection {
  heading: string;
  paragraphs: readonly string[];
}

export interface LegalDocument {
  title: string;
  lead: string;
  sections: readonly LegalSection[];
  updated: string;
}

const PROVISIONAL =
  "These terms are provisional and kept simple while Sigillo has its first customers. They are replaced by the agreement you sign, which prevails if the two differ.";

export const TERMS: LegalDocument = {
  title: "Terms of Service",
  lead: PROVISIONAL,
  updated: "Version 1.0, 2 November 2026.",
  sections: [
    {
      heading: "1. Who is who",
      paragraphs: [
        "Sigillo is software that records what AI agents do as signed, tamper-evident receipts. The Licensor owns Sigillo and licenses it to a Partner. The Partner offers it, hosted or installed, to its own customers (the Customer). The Customer is the company whose AI agents are recorded.",
        "Where the Licensor hosts Sigillo, the Customer is the controller of any personal data in the records, the Partner is the processor, and the Licensor is the Partner's sub-processor (see the Data Processing Agreement). Where the Partner or the Customer runs its own installation, the Licensor receives no data.",
      ],
    },
    {
      heading: "2. The service",
      paragraphs: [
        "Sigillo stores fingerprints (SHA-256 hashes) of what an agent reads and writes, never the text itself, signs them, links them in an append-only chain, and timestamps the chain. The Customer can export an evidence pack and verify it without the Licensor, using the open-source verifier.",
        "The timestamp comes today from FreeTSA (freetsa.org), which is not an eIDAS qualified provider. A qualified provider can be configured for a dedicated installation.",
      ],
    },
    {
      heading: "3. What Sigillo does not do",
      paragraphs: [
        "Sigillo proves what an agent sent, in what order, and that it was not changed afterwards. It does not prove that everything was sent, or that the content is true.",
        "Using Sigillo does not by itself make a system compliant with the GDPR, the AI Act or any other law. That depends on what the Customer's AI does and how it is used.",
      ],
    },
    {
      heading: "4. Licence",
      paragraphs: [
        "The Licensor grants the Partner a non-exclusive, non-transferable licence to use Sigillo and to offer it to its customers for the term of the Partner's agreement. The verifier is open source under its own licence and may be used by anyone.",
        "The Partner and the Customer keep all rights in their own data and in their agents. Nobody may use Sigillo to break the law, to attack the service, or to hide the origin of records.",
      ],
    },
    {
      heading: "5. Customer responsibilities",
      paragraphs: [
        "The Customer keeps its credentials and signing keys safe, uses the service only for lawful purposes, and does not put special categories of personal data (for example health data) or secrets in free-text labels. The Customer is responsible for the lawfulness of what its agents do and for informing the people concerned.",
      ],
    },
    {
      heading: "6. Fees",
      paragraphs: [
        "The pilot is free. Standard and Custom plans are charged as set out in the Partner's offer. Prices on the site are shown without VAT.",
      ],
    },
    {
      heading: "7. Availability and backups",
      paragraphs: [
        "The service is run with reasonable care but without a guaranteed uptime unless a written agreement says so. The database is copied to a second place on the server every two hours, and once a day to an encrypted off-site copy. The off-site copy is encrypted before it leaves the server, can only be opened with a private key that is not on the server, and the last 30 daily copies are kept. This is a safeguard for the Licensor's operation, not an archive service: the Customer should keep its own exported evidence packs.",
      ],
    },
    {
      heading: "8. Data protection",
      paragraphs: [
        "How data is handled is described on the Privacy page and in the Data Processing Agreement. The Licensor never stores the content of prompts, tool arguments or outputs. When a contract ends, the Licensor hands over a verifiable export and erases the Customer's data within 30 days; encrypted backups roll over within 30 days after that.",
      ],
    },
    {
      heading: "9. Warranty and liability",
      paragraphs: [
        "Sigillo is provided as it is, with the care described above. To the extent the law allows, the Licensor is not liable for indirect or consequential losses, and its total liability for any claim is limited to the fees paid for the service in the previous 12 months. Nothing limits liability that the law does not allow to be limited.",
      ],
    },
    {
      heading: "10. Ending",
      paragraphs: [
        "Either side may end its agreement with 30 days' written notice. The Licensor may suspend an account that puts the service or other customers at risk, and tells the Partner why. After the end, the Customer keeps the exports it has received and can verify them for as long as it likes.",
      ],
    },
    {
      heading: "11. Law",
      paragraphs: [
        "These terms are governed by the law of Italy and the European Union law that applies. The courts are those agreed in the Partner's agreement and, failing that, those that have jurisdiction under the law.",
        "Questions about these terms: team@get-sigillo.eu.",
      ],
    },
  ],
};

export const DPA: LegalDocument = {
  title: "Data Processing Agreement",
  lead: `${PROVISIONAL} It applies where the Licensor hosts Sigillo for a Partner's customers (GDPR art. 28). It is a sub-processing agreement between the Partner and the Licensor; the Partner signs its own agreement with each customer, which must allow this sub-processor.`,
  updated: "Version 1.0, 2 November 2026.",
  sections: [
    {
      heading: "Who is who",
      paragraphs: [
        "Customer: the company whose AI agents are recorded; controller. Partner: resells Sigillo; processor for the customer. Licensor: licenses and operates the software; sub-processor for the Partner.",
        "If the Partner or the Customer runs its own installation, the Licensor receives no data and is not a processor: only the licence and support terms apply. If support ever needs access to an installation, it is given case by case, for a limited time, and logged.",
      ],
    },
    {
      heading: "1. Subject and duration",
      paragraphs: ["The Licensor operates the Sigillo service for the Partner's customers for as long as the Partner's licence agreement is in force."],
    },
    {
      heading: "2. Nature and purpose",
      paragraphs: ["Keeping a signed, tamper-evident record of actions taken by the customers' AI agents, and making it available to the customer for verification and export."],
    },
    {
      heading: "3. Data and data subjects",
      paragraphs: [
        "Data subjects: the customer's staff who sign in, and the people the customer's agents act for, when the customer's integration identifies them.",
        "Data: sign-in email, company name, the identifiers the customer's agent sends (replaced by pseudonyms in the record), action labels, timestamps and fingerprints of content. No content (prompts, answers, documents) is stored.",
        "Two exceptions, said plainly: if the customer uses the optional model gateway, the prompt and answer pass through the server's memory on their way to the model provider and are not saved; and receipts written before 1 October 2026 (format version 4) may hold a person's identifier in clear and cannot be changed.",
        "No special categories of data are intended. The customer must not put them in free-text labels.",
      ],
    },
    {
      heading: "4. Instructions",
      paragraphs: ["The Licensor processes data only on the Partner's documented instructions, which are this agreement and the customer's use of the service. It tells the Partner if an instruction seems to infringe the GDPR."],
    },
    {
      heading: "5. Confidentiality",
      paragraphs: ["Only the Licensor, and any person it names to the Partner, has access to the server. Anyone with access is bound to confidentiality."],
    },
    {
      heading: "6. Security (art. 32)",
      paragraphs: [
        "Signed append-only records; a signing key kept in a separate process with no network access; hashed credentials; customer separation; logs without content; encrypted off-site backups.",
        "Model API keys, if the customer gives any to the optional gateway, are encrypted at rest. The service can decrypt them, because it needs them to forward a call to the model provider; they are never shown, only the last 4 characters.",
      ],
    },
    {
      heading: "7. Sub-processors",
      paragraphs: [
        "Hosting: Aruba (Italy). Off-site backup: Google Drive, holding only an encrypted file it cannot read. Sign-in with Google, if the customer chooses it. Timestamps: FreeTSA receives only a hash of the checkpoint root, never customer data.",
        "The Licensor gives 30 days' notice of any change. The Partner may object and, if no solution is found, may end the agreement.",
      ],
    },
    {
      heading: "8. Assistance",
      paragraphs: ["The Licensor helps the Partner answer data subjects' requests (access, erasure) within 10 working days, and with impact assessments where needed."],
    },
    {
      heading: "9. Personal data breaches",
      paragraphs: ["The Licensor tells the Partner without undue delay, and in any case within 48 hours of becoming aware, with the information the Partner needs, so that the Partner and the customer can meet the 72-hour deadline of GDPR art. 33."],
    },
    {
      heading: "10. End of the contract",
      paragraphs: [
        "The Licensor hands over a verifiable export of every system and erases the customer's data within 30 days. One exception: the administrative log is append-only and keeps the sign-up email and company name. Encrypted backups roll over within 30 more days. On request, the Licensor confirms the erasure in writing.",
      ],
    },
    {
      heading: "11. Audits",
      paragraphs: ["The Licensor makes available the information needed to show compliance: the Privacy page, the documentation and the source code. On-site audits are possible with 30 days' notice, at the Partner's cost, once a year unless after a breach."],
    },
    {
      heading: "12. Transfers outside the EU",
      paragraphs: ["Data is hosted in the EU. Transfers to sub-processors outside the EU (Google sign-in, Google Drive for an encrypted file) rely on the EU-US Data Privacy Framework or standard contractual clauses."],
    },
    {
      heading: "13. Liability and law",
      paragraphs: ["Liability is as set out in the Terms of Service. The law of Italy and applicable EU law govern this agreement."],
    },
  ],
};

/** The body of /terms or /dpa, in the site's frame. */
export function legalPage(doc: LegalDocument, other: { href: string; label: string }, contactHref?: string): string {
  const contact = contactHref === undefined ? "" : `<p><a href="${escape(contactHref)}" target="_blank" rel="noopener">team@get-sigillo.eu</a></p>`;
  return `<style>
.lg { max-width: 760px; margin: 0 auto; padding: 56px 24px 72px; }
.lg h1 { font-size: 36px; line-height: 42px; letter-spacing: -0.02em; font-weight: 600; margin: 0 0 16px; text-align: left; }
.lg h2 { font-size: 19px; margin: 28px 0 6px; text-align: left; }
.lg p { margin: 0 0 12px; }
.lg .lead { color: var(--secondary, var(--muted, #5c6169)); font-size: 15px; }
</style>
<div class="lg"><h1>${escape(doc.title)}</h1><p class="lead">${escape(doc.lead)}</p>
${doc.sections.map((s) => `<h2>${escape(s.heading)}</h2>\n${s.paragraphs.map((p) => `<p>${escape(p)}</p>`).join("\n")}`).join("\n")}
<p class="lead">${escape(doc.updated)} <a href="${escape(other.href)}">${escape(other.label)}</a> · <a href="/privacy">Privacy</a></p>
${contact}</div>`;
}
