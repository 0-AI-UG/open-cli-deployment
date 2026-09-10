import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Cloud, FileText, FileWarning, Folder, RefreshCw } from "lucide-react";
import { get } from "../api/client.ts";
import { PermissionGate } from "../components/permission-gate.tsx";
import { Btn, Card, EmptyState, PageHeader, PageShell, PageState, Spinner, showToast } from "../components/ui.tsx";

type BucketDetail = {
  name: string;
  connection_id: string;
  connection_name: string;
  region: string;
  endpoint: string;
};

type ObjectEntry = { key: string; size: number; lastModified: string; etag: string };
type ObjectPage = { prefix: string; prefixes: string[]; objects: ObjectEntry[]; nextCursor: string | null };
type ObjectView = {
  key: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string | null;
  contentType: string;
  maxBytes: number;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function BucketDetailPage({ connectionId, bucketName }: { connectionId: string; bucketName: string }) {
  const storageQuery = `storage=${encodeURIComponent(connectionId)}`;
  const [detail, setDetail] = useState<BucketDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [page, setPage] = useState<ObjectPage | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [objectView, setObjectView] = useState<ObjectView | null>(null);
  const [objectKey, setObjectKey] = useState<string | null>(null);
  const [objectLoading, setObjectLoading] = useState(false);

  useEffect(() => {
    get(`/api/resources/buckets/${encodeURIComponent(bucketName)}?${storageQuery}`)
      .then(setDetail)
      .catch((err) => setDetailErr(err.message));
  }, [bucketName, storageQuery]);

  const loadPrefix = useCallback(async (nextPrefix: string, cursor?: string) => {
    setListLoading(true);
    setListErr(null);
    try {
      const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const result: ObjectPage = await get(
        `/api/resources/buckets/${encodeURIComponent(bucketName)}/objects?${storageQuery}&prefix=${encodeURIComponent(nextPrefix)}${cursorQuery}`,
      );
      setPage(current => cursor && current
        ? { ...result, prefixes: [...current.prefixes, ...result.prefixes], objects: [...current.objects, ...result.objects] }
        : result);
    } catch (err: any) {
      setListErr(err.message);
      if (!cursor) setPage(null);
    } finally {
      setListLoading(false);
    }
  }, [bucketName, storageQuery]);

  useEffect(() => {
    if (detail) loadPrefix(prefix);
  }, [detail, prefix, loadPrefix]);

  const resetSelection = () => {
    setObjectKey(null);
    setObjectView(null);
  };

  const goToPrefix = (nextPrefix: string) => {
    setPrefix(nextPrefix);
    resetSelection();
  };

  const openObject = async (key: string) => {
    setObjectKey(key);
    setObjectView(null);
    setObjectLoading(true);
    try {
      setObjectView(await get(
        `/api/resources/buckets/${encodeURIComponent(bucketName)}/object?${storageQuery}&key=${encodeURIComponent(key)}`,
      ));
    } catch (err: any) {
      showToast(err.message, "error");
      setObjectKey(null);
    } finally {
      setObjectLoading(false);
    }
  };

  if (detailErr) {
    return <PageState kind="error" title="Bucket unavailable" description={detailErr} action={<Btn variant="ghost" onClick={() => { window.location.hash = "#/resources"; }}>Back to resources</Btn>} />;
  }
  if (!detail) return <PageState title="Loading bucket" />;

  const crumbs = prefix.split("/").filter(Boolean);
  const entries = [
    ...(page?.prefixes ?? []).map(value => ({ kind: "prefix" as const, value, name: value.slice(prefix.length).replace(/\/$/, "") })),
    ...(page?.objects ?? []).map(value => ({ kind: "object" as const, value, name: value.key.slice(prefix.length) })),
  ];

  return (
    <PageShell>
      <PageHeader backHref="#/resources" backLabel="Back to resources" eyebrow="S3 bucket" title={detail.name} />

      <Card className="p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Info label="Connection" value={detail.connection_name} />
          <Info label="Region" value={detail.region} />
          <Info label="Endpoint" value={detail.endpoint} />
        </div>
      </Card>

      <PermissionGate
        permission="buckets.objects.read"
        fallback={<Card className="p-6"><EmptyState message="Viewing bucket contents requires the buckets.objects.read permission." icon={FileWarning} /></Card>}
      >
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card className="p-3 md:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <Cloud size={13} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Objects</h3>
              <Btn variant="ghost" size="xs" onClick={() => loadPrefix(prefix)} className="ml-auto" title="Refresh">
                <RefreshCw size={11} />
              </Btn>
            </div>

            <div className="flex items-center flex-wrap gap-1 font-mono text-[10px] mb-2 px-1">
              <button onClick={() => goToPrefix("")} className="text-accent-blue hover:underline">/</button>
              {crumbs.map((crumb, index) => (
                <span key={`${crumb}-${index}`} className="flex items-center gap-1">
                  <ChevronRight size={10} className="text-muted" />
                  <button onClick={() => goToPrefix(`${crumbs.slice(0, index + 1).join("/")}/`)} className="text-accent-blue hover:underline">{crumb}</button>
                </span>
              ))}
            </div>

            {listLoading && !page ? (
              <div className="py-8 flex justify-center"><Spinner /></div>
            ) : listErr ? (
              <EmptyState message={listErr} icon={FileWarning} />
            ) : !entries.length ? (
              <EmptyState message="Empty prefix" />
            ) : (
              <div className="border-2 border-fg max-h-[60vh] overflow-y-auto">
                {prefix && (
                  <button onClick={() => goToPrefix(crumbs.length > 1 ? `${crumbs.slice(0, -1).join("/")}/` : "")} className="w-full text-left flex items-center gap-2 px-2 py-1.5 font-mono text-[10px] hover:bg-alt border-b border-fg/15 text-fg-dim">
                    <Folder size={11} /> ..
                  </button>
                )}
                {entries.map(entry => {
                  const active = entry.kind === "object" && objectKey === entry.value.key;
                  return (
                    <button
                      key={entry.kind === "prefix" ? entry.value : entry.value.key}
                      onClick={() => entry.kind === "prefix" ? goToPrefix(entry.value) : openObject(entry.value.key)}
                      className={`w-full text-left flex items-center gap-2 px-2 py-1.5 font-mono text-[10px] border-b border-fg/10 last:border-b-0 ${active ? "bg-accent text-fg" : "hover:bg-alt"}`}
                    >
                      {entry.kind === "prefix" ? <Folder size={11} className="text-fg" /> : <FileText size={11} className="text-fg-dim" />}
                      <span className={`flex-1 truncate ${entry.kind === "prefix" ? "font-bold" : ""}`}>{entry.name}</span>
                      <span className="text-muted text-[9px]">{entry.kind === "object" ? fmtSize(entry.value.size) : ""}</span>
                    </button>
                  );
                })}
                {page?.nextCursor && (
                  <button onClick={() => loadPrefix(prefix, page.nextCursor || undefined)} disabled={listLoading} className="w-full px-2 py-2 font-mono text-[9px] font-bold uppercase hover:bg-alt disabled:opacity-50">
                    {listLoading ? "Loading…" : "Load more"}
                  </button>
                )}
              </div>
            )}
          </Card>

          <Card className="p-3 md:col-span-3">
            <div className="flex items-center gap-2 mb-3">
              <FileText size={13} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider truncate">{objectKey || "Select an object"}</h3>
              {objectView && <span className="ml-auto font-mono text-[9px] text-muted uppercase whitespace-nowrap">{fmtSize(objectView.size)}{objectView.truncated ? ` · truncated @ ${fmtSize(objectView.maxBytes)}` : ""}</span>}
            </div>
            {objectLoading ? (
              <div className="py-8 flex justify-center"><Spinner /></div>
            ) : !objectKey ? (
              <EmptyState message="Click an object on the left to view its contents" />
            ) : objectView?.binary ? (
              <EmptyState message={`Binary object (${objectView.contentType}): preview not available`} icon={FileWarning} />
            ) : (
              <pre className="border-2 border-fg bg-alt/40 p-3 font-mono text-[11px] leading-relaxed max-h-[60vh] overflow-auto whitespace-pre-wrap break-all">{objectView?.content || ""}</pre>
            )}
          </Card>
        </div>
      </PermissionGate>
    </PageShell>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-2 border-fg p-2 bg-alt">
      <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className="font-mono text-xs font-bold text-fg truncate" title={value}>{value}</div>
    </div>
  );
}
