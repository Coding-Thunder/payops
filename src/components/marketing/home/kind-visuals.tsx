import {
  CheckCircle2Icon,
  CircleDollarSignIcon,
  FileTextIcon,
  FlagIcon,
  PenLineIcon,
  ReceiptIcon,
  StickyNoteIcon,
  UserPlusIcon,
  type LucideIcon,
} from "lucide-react";

import type { TimelineKind } from "./demo";

/**
 * One icon + accent per timeline event kind. Kept neutral-first: only
 * money and approvals earn the emerald accent, everything else stays
 * white/muted so the record reads as calm history, not a christmas tree.
 */
export const KIND_VISUALS: Record<
  TimelineKind,
  { Icon: LucideIcon; tone: "emerald" | "neutral"; label: string }
> = {
  client: { Icon: UserPlusIcon, tone: "neutral", label: "Client" },
  note: { Icon: StickyNoteIcon, tone: "neutral", label: "Note" },
  agreement: { Icon: PenLineIcon, tone: "neutral", label: "Agreement" },
  invoice: { Icon: ReceiptIcon, tone: "neutral", label: "Invoice" },
  payment: { Icon: CircleDollarSignIcon, tone: "emerald", label: "Payment" },
  approval: { Icon: CheckCircle2Icon, tone: "emerald", label: "Approval" },
  document: { Icon: FileTextIcon, tone: "neutral", label: "Document" },
  delivery: { Icon: FlagIcon, tone: "neutral", label: "Delivery" },
};
