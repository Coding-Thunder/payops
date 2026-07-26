import "server-only";

import { connectMongo } from "@/server/db/mongoose";
import { AdminNote, Types } from "@/server/db/models";

/**
 * Internal ops notes attached to any console entity. Append + delete only
 * (no edit) so the trail stays honest. Every mutation is also written to
 * admin_audit by the calling route.
 */

export const NOTE_SUBJECTS = ["user", "customer", "order", "org"] as const;
export type NoteSubject = (typeof NOTE_SUBJECTS)[number];

export function isNoteSubject(s: string): s is NoteSubject {
  return (NOTE_SUBJECTS as readonly string[]).includes(s);
}

export interface NoteRow {
  id: string;
  subjectType: string;
  subjectId: string;
  body: string;
  authorEmail: string;
  createdAt: string | null;
}

interface LeanNote {
  _id: Types.ObjectId;
  subjectType: string;
  subjectId: string;
  body: string;
  authorEmail: string;
  createdAt?: Date | null;
}

function toRow(d: LeanNote): NoteRow {
  return {
    id: String(d._id),
    subjectType: d.subjectType,
    subjectId: d.subjectId,
    body: d.body,
    authorEmail: d.authorEmail,
    createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
  };
}

export async function listNotes(
  subjectType: string,
  subjectId: string,
): Promise<NoteRow[]> {
  if (!isNoteSubject(subjectType) || !subjectId) return [];
  await connectMongo();
  const docs = await AdminNote.find({ subjectType, subjectId })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean<LeanNote[]>();
  return docs.map(toRow);
}

export async function addNote(input: {
  subjectType: string;
  subjectId: string;
  body: string;
  authorEmail: string;
}): Promise<{ ok: boolean; message?: string; note?: NoteRow }> {
  if (!isNoteSubject(input.subjectType)) {
    return { ok: false, message: "Invalid subject type" };
  }
  const subjectId = input.subjectId?.trim();
  const body = input.body?.trim();
  if (!subjectId) return { ok: false, message: "Missing subject" };
  if (!body) return { ok: false, message: "Note cannot be empty" };
  if (body.length > 5000) return { ok: false, message: "Note is too long" };
  await connectMongo();
  const created = await AdminNote.create({
    subjectType: input.subjectType,
    subjectId,
    body,
    authorEmail: input.authorEmail,
    createdAt: new Date(),
  });
  return { ok: true, note: toRow(created.toObject() as LeanNote) };
}

export async function deleteNote(id: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(id)) return false;
  await connectMongo();
  const res = await AdminNote.deleteOne({ _id: new Types.ObjectId(id) });
  return res.deletedCount > 0;
}
