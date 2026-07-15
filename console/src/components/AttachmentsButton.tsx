import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { toast } from "sonner";
import { openAttachment } from "../api/client.js";
import { useItemAttachments, useRemoveAttachment, useUploadAttachment } from "../api/hooks.js";

const fmtSize = (b: number) => (b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(0)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

export function AttachmentsButton({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState(false);
  const atts = useItemAttachments(itemId, open);
  const upload = useUploadAttachment(itemId);
  const remove = useRemoveAttachment(itemId);
  const inputRef = useRef<HTMLInputElement>(null);
  const count = atts.data?.attachments.length ?? 0;

  const send = (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) upload.mutate(f, { onError: (e) => toast.error(e.message) });
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          title="Attachments"
          className="relative w-[26px] h-[26px] grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-55 hover:opacity-100"
          style={{ color: open || count ? "var(--amber)" : "var(--text-3)" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          {open && count > 0 && (
            <span className="absolute -top-1 -right-1 mono text-[0.5rem] w-3.5 h-3.5 grid place-items-center rounded-full" style={{ background: "var(--amber)", color: "#1a1206" }}>
              {count}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={6}
          align="end"
          className="z-30 w-[300px] rounded-[10px] border p-2.5 risein"
          style={{ background: "var(--surface)", borderColor: "var(--line-2)", boxShadow: "0 18px 44px -14px rgba(0,0,0,.5)" }}
        >
          <div className="kicker mb-2">Attachments</div>
          <button
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              send(e.dataTransfer.files);
            }}
            className="w-full text-center text-[0.7188rem] px-3 py-4 rounded-[9px] border border-dashed cursor-pointer mb-2.5"
            style={{ borderColor: drag ? "var(--amber)" : "var(--line-2)", color: "var(--text-3)", background: drag ? "var(--sunk-tint)" : "transparent" }}
          >
            {upload.isPending ? "uploading…" : "Drop a file or click to attach"}
            <div className="mono text-[0.5625rem] mt-0.5">10 MB max</div>
          </button>
          <input ref={inputRef} type="file" multiple hidden onChange={(e) => send(e.target.files)} />

          <div className="flex flex-col gap-1 max-h-[240px] overflow-auto">
            {(atts.data?.attachments ?? []).map((a) => (
              <div key={a.id} className="flex items-center gap-2 px-2 py-1.5 rounded-md border" style={{ borderColor: "var(--line)", background: "var(--ground)" }}>
                <button
                  onClick={() => openAttachment(a.id).catch((e) => toast.error(String(e)))}
                  className="flex-1 min-w-0 text-left cursor-pointer bg-transparent border-0"
                  title={`${a.title} — open`}
                >
                  <div className="text-[0.75rem] truncate" style={{ color: "var(--text-2)" }}>{a.title}</div>
                  <div className="mono text-[0.5938rem]" style={{ color: "var(--text-3)" }}>{fmtSize(a.byte_size)} · {a.content_type}</div>
                </button>
                <button
                  title="Remove"
                  onClick={() => remove.mutate(a.id, { onError: (e) => toast.error(e.message) })}
                  className="w-6 h-6 grid place-items-center rounded-md border-0 bg-transparent cursor-pointer opacity-55 hover:opacity-100"
                  style={{ color: "var(--pri-alta)" }}
                >
                  ✕
                </button>
              </div>
            ))}
            {atts.isFetched && count === 0 && (
              <div className="text-[0.6875rem] text-center py-1.5" style={{ color: "var(--text-3)" }}>
                No files yet.
              </div>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
