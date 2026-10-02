import { useState, useEffect, useCallback } from "react";
import { get } from "../api/client.ts";
import { Badge, Card, CardHeader, Btn, CopyButton, DataRow, Spinner, EmptyState, Stat, showToast, PageShell, PageHeader, PageState } from "../components/ui.tsx";
import { Folder, FileText, ChevronRight, RefreshCw, FileWarning } from "lucide-react";

type VolumeDetail = {
  id: string;
  name: string;
  size: number | null;
  storage_kind?: string;
  location: string;
  server_name: string | null;
  server_id: number | null;
  app_name: string | null;
  app_id: number | null;
  host_path: string | null;
  monthly_eur: number | null;
  attached: boolean;
};

type DirEntry = { name: string; type: "f" | "d" | "l" | "o"; size: number; mtime: number };

type FileView = {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string | null;
  max_bytes: number;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function VolumeDetailPage({ volumeId }: { volumeId: string }) {
  const [detail, setDetail] = useState<VolumeDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    get(`/api/resources/volumes/${encodeURIComponent(volumeId)}`)
      .then(setDetail)
      .catch((err) => setDetailErr(err.message));
  }, [volumeId]);

  const loadDir = useCallback(async (p: string) => {
    setListLoading(true);
    setListErr(null);
    try {
      const res = await get(`/api/resources/volumes/${encodeURIComponent(volumeId)}/files?path=${encodeURIComponent(p)}`);
      setEntries(res.entries);
    } catch (err: any) {
      setListErr(err.message);
      setEntries(null);
    } finally {
      setListLoading(false);
    }
  }, [volumeId]);

  useEffect(() => {
    if (detail?.attached) loadDir(path);
  }, [detail?.attached, path, loadDir]);

  const openFile = async (name: string) => {
    const full = path ? `${path}/${name}` : name;
    setFilePath(full);
    setFileView(null);
    setFileLoading(true);
    try {
      const res = await get(`/api/resources/volumes/${encodeURIComponent(volumeId)}/file?path=${encodeURIComponent(full)}`);
      setFileView(res);
    } catch (err: any) {
      showToast(err.message, "error");
      setFilePath(null);
    } finally {
      setFileLoading(false);
    }
  };

  const goUp = () => {
    if (!path) return;
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    setPath(parts.join("/"));
    setFilePath(null);
    setFileView(null);
  };

  const goInto = (name: string) => {
    setPath(path ? `${path}/${name}` : name);
    setFilePath(null);
    setFileView(null);
  };

  const jumpTo = (idx: number) => {
    const parts = path.split("/").filter(Boolean);
    setPath(parts.slice(0, idx + 1).join("/"));
    setFilePath(null);
    setFileView(null);
  };

  if (detailErr) {
    return (
      <PageState kind="error" title="Volume unavailable" description={detailErr} action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/resources"; }}>Back to resources</Btn>} />
    );
  }
  if (!detail) return <PageState title="Loading volume" />;

  const crumbs = path.split("/").filter(Boolean);
  const local = detail.storage_kind === "local-directory";

  return (
    <PageShell>
      <PageHeader
        backHref="#/resources"
        backLabel="Back to resources"
        eyebrow="Volume"
        title={detail.name}
        meta={<>
          {detail.attached ? <Badge tone="success">Attached</Badge> : <Badge>Not attached</Badge>}
          <span>{local ? "Server-local directory" : "Hetzner block volume"}</span>
          {detail.location && <span className="font-mono text-xs">{detail.location}</span>}
        </>}
      />

      <div className="frame bg-surface"><div className="cells grid grid-cols-2 sm:grid-cols-4">
        <Stat label="Size" value={local ? "Shared" : `${detail.size} GB`} hint={local ? "Shares server disk · no quota" : undefined} className="bg-surface px-4 py-3.5" />
        <Stat label="Monthly cost" value={local ? "—" : detail.monthly_eur != null ? `€${detail.monthly_eur.toFixed(2)}` : "—"} hint={local ? "No separate storage charge" : "€/mo"} className="bg-surface px-4 py-3.5" />
        <Stat label="Server" value={<span title={detail.server_name || undefined}>{detail.server_name || "—"}</span>} hint={`Location ${detail.location || "—"}`} className="bg-surface px-4 py-3.5" />
        <Stat label="App" value={<span title={detail.app_name || undefined}>{detail.app_name || "—"}</span>} hint={detail.app_name ? "Mounted by this app" : "Not in use"} className="bg-surface px-4 py-3.5" />
      </div></div>

      {detail.host_path && (
        <Card>
          <DataRow label="Host path" mono>
            <span className="min-w-0 break-all">{detail.host_path}</span>
            <CopyButton text={detail.host_path} />
          </DataRow>
        </Card>
      )}

      {!detail.attached ? (
        <Card>
          <EmptyState
            message="Volume is not attached to a server. Attach it to an app to inspect its contents."
            icon={FileWarning}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          {/* File browser */}
          <Card className="flex min-w-0 flex-col overflow-hidden md:col-span-2">
            <CardHeader
              title="Files"
              icon={<Folder size={15} />}
              actions={<Btn variant="ghost" size="xs" onClick={() => loadDir(path)} title="Refresh"><RefreshCw size={14} /></Btn>}
            />

            {/* Breadcrumbs */}
            <nav aria-label="Path" className="flex flex-wrap items-center gap-0.5 border-b bg-subtle/40 px-3 py-2 font-mono text-xs">
              <button
                onClick={() => { setPath(""); setFilePath(null); setFileView(null); }}
                className={`rounded px-1.5 py-0.5 transition-colors hover:bg-subtle hover:text-fg ${crumbs.length ? "text-fg-dim" : "font-medium text-fg"}`}
              >
                /
              </button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-0.5">
                  <ChevronRight size={12} className="text-muted" />
                  <button onClick={() => jumpTo(i)} className={`rounded px-1.5 py-0.5 transition-colors hover:bg-subtle hover:text-fg ${i === crumbs.length - 1 ? "font-medium text-fg" : "text-fg-dim"}`}>{c}</button>
                </span>
              ))}
            </nav>

            {listLoading ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : listErr ? (
              <EmptyState message={listErr} icon={FileWarning} />
            ) : !entries?.length ? (
              <EmptyState message="Empty directory" icon={Folder} />
            ) : (
              <div className="max-h-[60vh] divide-y overflow-y-auto">
                {path && (
                  <button
                    onClick={goUp}
                    className="flex w-full items-center gap-2.5 px-4 py-2 text-left font-mono text-xs text-fg-dim transition-colors hover:bg-subtle/50 hover:text-fg"
                  >
                    <Folder size={14} className="text-muted" /> ..
                  </button>
                )}
                {entries.map((e) => {
                  const isDir = e.type === "d";
                  const active = filePath === (path ? `${path}/${e.name}` : e.name);
                  return (
                    <button
                      key={e.name}
                      onClick={() => isDir ? goInto(e.name) : openFile(e.name)}
                      aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center gap-2.5 px-4 py-2 text-left font-mono text-xs transition-colors ${active ? "bg-subtle text-fg" : "text-fg-dim hover:bg-subtle/50 hover:text-fg"}`}
                    >
                      {isDir ? <Folder size={14} className="shrink-0 text-muted" /> : <FileText size={14} className="shrink-0 text-muted" />}
                      <span className={`flex-1 truncate ${isDir || active ? "font-medium text-fg" : ""}`}>{e.name}{e.type === "l" ? " →" : ""}</span>
                      <span className="shrink-0 tabular-nums text-muted">{isDir ? "" : fmtSize(e.size)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          {/* File viewer */}
          <Card className="min-w-0 overflow-hidden md:col-span-3">
            <CardHeader
              title={filePath ? <span className="font-mono text-xs">{filePath}</span> : "Select a file"}
              icon={<FileText size={15} />}
              actions={fileView ? (
                <span className="whitespace-nowrap text-xs tabular-nums text-muted">
                  {fmtSize(fileView.size)}{fileView.truncated ? ` · truncated @ ${fmtSize(fileView.max_bytes)}` : ""}
                </span>
              ) : undefined}
            />
            {fileLoading ? (
              <div className="flex justify-center py-10"><Spinner /></div>
            ) : !filePath ? (
              <EmptyState message="Click a file on the left to view its contents" icon={FileText} />
            ) : fileView?.binary ? (
              <EmptyState message="Binary file: preview not available" icon={FileWarning} />
            ) : (
              <div className="p-4">
                <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-subtle/60 p-3 font-mono text-xs leading-relaxed text-fg">
                  {fileView?.content || ""}
                </pre>
              </div>
            )}
          </Card>
        </div>
      )}
    </PageShell>
  );
}
