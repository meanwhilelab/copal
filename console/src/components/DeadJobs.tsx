import { toast } from "sonner";
import { useDeadJobs, useRequeue } from "../api/hooks.js";
import { Overlay } from "./Overlay.js";

export function DeadJobsPanel({ onClose }: { onClose: () => void }) {
  const jobs = useDeadJobs(true);
  const requeue = useRequeue();
  return (
    <Overlay
      onClose={onClose}
      panelClassName="w-[560px] max-w-[92vw] max-h-[70vh] flex flex-col rounded-2xl border overflow-hidden risein"
      panelStyle={{ background: "var(--surface)", borderColor: "var(--line-2)" }}
    >
      <div className="flex-none flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--line)" }}>
          <h2 className="display m-0 text-base font-medium">Dead jobs</h2>
          <button onClick={onClose} className="w-[28px] h-[28px] grid place-items-center rounded-lg border cursor-pointer bg-transparent" style={{ borderColor: "var(--line)", color: "var(--text-2)" }}>
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3 flex flex-col gap-2">
          {(jobs.data?.jobs ?? []).map((j) => (
            <div key={j.id} className="flex items-center gap-3 p-3 rounded-[10px] border" style={{ borderColor: "var(--line)", background: "var(--ground)" }}>
              <div className="flex-1 min-w-0">
                <div className="mono text-[0.6875rem]" style={{ color: "var(--text)" }}>
                  {j.kind} <span style={{ color: "var(--text-3)" }}>· {j.attempts} attempts</span>
                </div>
                <div className="text-[0.6875rem] truncate mt-0.5" style={{ color: "var(--pri-alta)" }}>
                  {j.last_error ?? "unknown error"}
                </div>
              </div>
              <button
                onClick={() =>
                  requeue.mutate(j.id, {
                    onSuccess: () => toast("Requeued — the housekeeper will retry."),
                    onError: (e) => toast.error(e.message),
                  })
                }
                className="px-3 py-1.5 rounded-md border-0 text-[0.7188rem] font-bold cursor-pointer"
                style={{ background: "var(--amber)", color: "#1a1206" }}
              >
                Requeue
              </button>
            </div>
          ))}
          {jobs.data && jobs.data.jobs.length === 0 && (
            <div className="p-8 text-center text-xs" style={{ color: "var(--text-3)" }}>
              Nothing dead. The material is healthy.
            </div>
          )}
        </div>
    </Overlay>
  );
}
