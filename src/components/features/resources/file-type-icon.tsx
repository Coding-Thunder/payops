import {
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  PresentationIcon,
  type LucideIcon,
} from "lucide-react";

import {
  SUPPORTED_FILE_FORMATS,
  type FileFormatGroup,
} from "@/lib/constants/client-resources";

const GROUP_ICON: Record<FileFormatGroup, LucideIcon> = {
  documents: FileTextIcon,
  spreadsheets: FileSpreadsheetIcon,
  images: FileImageIcon,
  presentations: PresentationIcon,
};

const GROUP_TONE: Record<FileFormatGroup, string> = {
  documents: "bg-info-soft text-info ring-info-border/60",
  spreadsheets: "bg-success-soft text-success ring-success-border/60",
  images: "bg-surface-2 text-foreground ring-border",
  presentations: "bg-warning-soft text-warning-foreground ring-warning-border/60",
};

/** Icon + tone for one file, keyed off the format table so a new
 *  supported extension picks up the right treatment for free. */
export function fileVisual(extension: string): {
  Icon: LucideIcon;
  tone: string;
} {
  const format = SUPPORTED_FILE_FORMATS.find((f) => f.extension === extension);
  if (!format) return { Icon: FileIcon, tone: "bg-surface-2 text-muted-foreground ring-border" };
  return { Icon: GROUP_ICON[format.group], tone: GROUP_TONE[format.group] };
}

export function FileTypeIcon({
  extension,
  className,
}: {
  extension: string;
  className?: string;
}) {
  const { Icon, tone } = fileVisual(extension);
  return (
    <span
      className={`grid size-8 shrink-0 place-items-center rounded-md ring-1 ring-inset ${tone} ${className ?? ""}`}
    >
      <Icon className="size-4" />
    </span>
  );
}
