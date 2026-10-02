import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Cloud, FileText, FileWarning, Folder, RefreshCw } from "lucide-react";
import { get } from "../api/client.ts";
import { Btn, Card, CardHeader, CopyButton, DataRow, EmptyState, PageHeader, PageShell, PageState, SkeletonLines, SkeletonRows, showToast } from "../components/ui.tsx";

type BucketDetail = {
  name: string;
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

export function BucketDetailPage({ bucketName }: { bucketName: string }) {
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
    get(`/api/resources/buckets/${encodeURIComponent(bucketName)}`)
      .then(setDetail)
      .catch((err) => setDetailErr(err.message));
  }, [bucketName]);

  const loadPrefix = useCallback(async (nextPrefix: string, cursor?: string) => {
    setListLoading(true);
    setListErr(null);
    try {
      const cursorQuery = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const result: ObjectPage = await get(
        `/api/resources/buckets/${encodeURIComponent(bucketName)}/objects?prefix=${encodeURIComponent(nextPrefix)}${cursorQuery}`,
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
  }, [bucketName]);

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
        `/api/resources/buckets/${encodeURIComponent(bucketName)}/object?key=${encodeURIComponent(key)}`,
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
      <PageHeader
        backHref="#/resources"
        backLabel="Back to resources"
        eyebrow="S3 bucket"
        title={detail.name}
        meta={<><span>Hetzner Object Storage</span><span className="font-mono text-xs">{detail.region}</span></>}
      />

      <Card>
        <DataRow label="Region" mono>{detail.region}</DataRow>
        <DataRow label="Endpoint" mono>
          <span className="min-w-0 truncate" title={detail.endpoint}>{detail.endpoint}</span>
          <CopyButton text={detail.endpoint} />
        </DataRow>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        <Card className="flex min-w-0 flex-col overflow-hidden md:col-span-2">
          <CardHeader
            title="Objects"
            icon={<Cloud size={15} />}
            actions={<Btn variant="ghost" size="xs" onClick={() => loadPrefix(prefix)} title="Refresh"><RefreshCw size={14} /></Btn>}
          />

          <nav aria-label="Prefix" className="flex flex-wrap items-center gap-0.5 border-b bg-subtle/40 px-3 py-2 font-mono text-xs">
            <button onClick={() => goToPrefix("")} className={`rounded px-1.5 py-0.5 transition-colors hover:bg-subtle hover:text-fg ${crumbs.length ? "text-fg-dim" : "font-medium text-fg"}`}>/</button>
            {crumbs.map((crumb, index) => (
              <span key={`${crumb}-${index}`} className="flex items-center gap-0.5">
                <ChevronRight size={12} className="text-muted" />
                <button onClick={() => goToPrefix(`${crumbs.slice(0, index + 1).join("/")}/`)} className={`rounded px-1.5 py-0.5 transition-colors hover:bg-subtle hover:text-fg ${index === crumbs.length - 1 ? "font-medium text-fg" : "text-fg-dim"}`}>{crumb}</button>
              </span>
            ))}
          </nav>

          {listLoading && !page ? (
            <SkeletonRows rows={6} dense label="Loading objects" />
          ) : listErr ? (
            <EmptyState message={listErr} icon={FileWarning} />
          ) : !entries.length ? (
            <EmptyState message="Empty prefix" icon={Folder} />
          ) : (
            <div className="max-h-[60vh] divide-y overflow-y-auto">
              {prefix && (
                <button onClick={() => goToPrefix(crumbs.length > 1 ? `${crumbs.slice(0, -1).join("/")}/` : "")} className="flex w-full items-center gap-2.5 px-4 py-2 text-left font-mono text-xs text-fg-dim transition-colors hover:bg-subtle/50 hover:text-fg">
                  <Folder size={14} className="text-muted" /> ..
                </button>
              )}
              {entries.map(entry => {
                const active = entry.kind === "object" && objectKey === entry.value.key;
                const isPrefix = entry.kind === "prefix";
                return (
                  <button
                    key={entry.kind === "prefix" ? entry.value : entry.value.key}
                    onClick={() => entry.kind === "prefix" ? goToPrefix(entry.value) : openObject(entry.value.key)}
                    aria-current={active ? "true" : undefined}
                    className={`flex w-full items-center gap-2.5 px-4 py-2 text-left font-mono text-xs transition-colors ${active ? "bg-subtle text-fg" : "text-fg-dim hover:bg-subtle/50 hover:text-fg"}`}
                  >
                    {isPrefix ? <Folder size={14} className="shrink-0 text-muted" /> : <FileText size={14} className="shrink-0 text-muted" />}
                    <span className={`flex-1 truncate ${isPrefix || active ? "font-medium text-fg" : ""}`}>{entry.name}</span>
                    <span className="shrink-0 tabular-nums text-muted">{entry.kind === "object" ? fmtSize(entry.value.size) : ""}</span>
                  </button>
                );
              })}
              {page?.nextCursor && (
                <button onClick={() => loadPrefix(prefix, page.nextCursor || undefined)} disabled={listLoading} className="flex w-full items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-fg-dim transition-colors hover:bg-subtle/50 hover:text-fg disabled:opacity-50">
                  {listLoading ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
          )}
        </Card>

        <Card className="min-w-0 overflow-hidden md:col-span-3">
          <CardHeader
            title={objectKey ? <span className="font-mono text-xs">{objectKey}</span> : "Select an object"}
            icon={<FileText size={15} />}
            actions={objectView ? <span className="whitespace-nowrap text-xs tabular-nums text-muted">{fmtSize(objectView.size)}{objectView.truncated ? ` · truncated @ ${fmtSize(objectView.maxBytes)}` : ""}</span> : undefined}
          />
          {objectLoading ? (
            <div className="p-4"><SkeletonLines label="Loading object" /></div>
          ) : !objectKey ? (
            <EmptyState message="Click an object on the left to view its contents" icon={FileText} />
          ) : objectView?.binary ? (
            <EmptyState message={`Binary object (${objectView.contentType}): preview not available`} icon={FileWarning} />
          ) : (
            <div className="p-4">
              <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-subtle/60 p-3 font-mono text-xs leading-relaxed text-fg">{objectView?.content || ""}</pre>
            </div>
          )}
        </Card>
      </div>
    </PageShell>
  );
}
