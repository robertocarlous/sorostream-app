"use client";
import { useState, useEffect, useMemo, useRef, useCallback, Suspense } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { StreamListSkeleton } from "@/components/Skeleton";
import StreamVirtualList from "@/components/StreamVirtualList";
import StreamEventFeed from "@/components/StreamEventFeed";
import PortfolioChart from "@/components/PortfolioChart";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import StatusLegend from "@/components/StatusLegend";
import { StreamErrorBoundary } from "@/components/StreamErrorBoundary";
import { getMockStreams, getStreamsForWallet, watchClaimable, sorostream, getMockStreamHistory, StreamData } from "@/src/lib/sorostream";
import { useRpcFetch } from "@/src/lib/useRpcFetch";
import { useToast } from "@/src/lib/toast";
import { downloadCSV } from "@/src/lib/export";
import { useKeyboardShortcuts, type ShortcutGroup } from "@/src/lib/useKeyboardShortcuts";
import { useBookmarks } from "@/src/context/BookmarksContext";
import { useWallet } from "@/src/context/WalletContext";
import ArchiveBanner from "@/components/ArchiveBanner";

type DashboardState = "loading" | "filtered-empty" | "empty" | "ready";

type Tab = "sent" | "received";

type SortField = "created" | "endDate" | "amount" | "status";
type SortOrder = "asc" | "desc";

const SORT_STORAGE_KEY = "sorostream_sort";

function loadSort(): { field: SortField; order: SortOrder } {
  if (typeof window === "undefined") return { field: "created", order: "desc" };
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { field: "created", order: "desc" };
}
function DashboardContent() {
  const rpcFetch = useRpcFetch();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { addToast } = useToast();
  const { bookmarkedIds } = useBookmarks();
  const { address } = useWallet();
  const [loading, setLoading] = useState(true);
  const [streams, setStreams] = useState<StreamData[]>([]);

  // Sent/Received tab, persisted to the URL like the other filters
  const [activeTab, setActiveTab] = useState<Tab>(
    searchParams.get("tab") === "received" ? "received" : "sent",
  );

  // Filter states from URL params
  const [statusFilter, setStatusFilter] = useState(searchParams.get("status") || "");
  const [tokenFilter, setTokenFilter] = useState(searchParams.get("token") || "");
  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [bookmarksOnly, setBookmarksOnly] = useState(false);

  // Sort state — persisted to localStorage via a lazy initializer.
  // Reads synchronously on mount so the saved preference is applied immediately
  // without a flash of default-sorted content when navigating back.
  const [sortField, setSortField] = useState<SortField>(() => loadSort().field);
  const [sortOrder, setSortOrder] = useState<SortOrder>(() => loadSort().order);

  function handleSortFieldChange(field: SortField) {
    setSortField(field);
    const order = sortOrder;
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ field, order }));
  }

  function toggleSortOrder() {
    const next: SortOrder = sortOrder === "asc" ? "desc" : "asc";
    setSortOrder(next);
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({ field: sortField, order: next }));
  }

  // Selection and bulk-action state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  // UI state
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Flush cached data immediately; if no wallet is connected, stop here so
    // streams from a previous session are never shown to the next connection.
    setStreams([]);
    if (!address) {
      setLoading(false);
      return;
    }

    setLoading(true);

    async function load() {
      try {
        const data = await rpcFetch(() =>
          Promise.resolve(getStreamsForWallet(address)),
        );
        if (!cancelled) setStreams(data);
      } catch {
        // Errors are surfaced via toast by rpcFetch; leave streams empty.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();

    // Poll for claimable updates every 30s without resetting scroll position.
    pollRef.current = setInterval(async () => {
      try {
        const data = await rpcFetch(() =>
          Promise.resolve(watchClaimable(getStreamsForWallet(address))),
        );
        if (!cancelled) setStreams(data);
      } catch {
        // silently keep current data
      }
    }, 30000);

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // Get unique tokens from streams for dropdown
  const uniqueTokens = useMemo(() => {
    const tokens = new Set(streams.map((s) => s.token));
    return Array.from(tokens).sort();
  }, [streams]);

  // getStreamsForWallet matches on a truncated address prefix (see sorostream.ts),
  // so we reuse that same convention to split the combined list into sent/received.
  const isOwnedBy = useCallback(
    (field: string) => !!address && field.includes(address.slice(0, 5)),
    [address],
  );

  const sentStreams = useMemo(
    () => streams.filter((s) => isOwnedBy(s.sender)),
    [streams, isOwnedBy],
  );
  const receivedStreams = useMemo(
    () => streams.filter((s) => isOwnedBy(s.recipient)),
    [streams, isOwnedBy],
  );

  // Active counts for the tab badges — recomputed from `streams` on every poll
  // tick, so a stream moving to "Ended"/"Cancelled" drops out immediately.
  const sentActiveCount = useMemo(
    () => sentStreams.filter((s) => s.status === "Active").length,
    [sentStreams],
  );
  const receivedActiveCount = useMemo(
    () => receivedStreams.filter((s) => s.status === "Active").length,
    [receivedStreams],
  );

  const tabStreams = activeTab === "sent" ? sentStreams : receivedStreams;

  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
    setSelectedIds(new Set());
  }, []);

  const filtered = useMemo(() => {
    return tabStreams.filter((s) => {
      if (bookmarksOnly && !bookmarkedIds.has(s.id)) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      if (tokenFilter && s.token !== tokenFilter) return false;
      if (search.trim()) {
        const q = search.trim().toLowerCase();
        const matchesSearch =
          s.sender.toLowerCase().includes(q) ||
          s.recipient.toLowerCase().includes(q) ||
          s.id.toLowerCase().includes(q);
        if (!matchesSearch) return false;
      }
      return true;
    });
  }, [tabStreams, statusFilter, tokenFilter, search, bookmarksOnly, bookmarkedIds]);

  // Sort filtered streams, pinning bookmarks first, then by the chosen sort field.
  const sortedFiltered = useMemo(() => {
    const dir = sortOrder === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      // Always pin bookmarks first
      const aB = bookmarkedIds.has(a.id) ? 0 : 1;
      const bB = bookmarkedIds.has(b.id) ? 0 : 1;
      if (aB !== bB) return aB - bB;

      switch (sortField) {
        case "created":
          return dir * (new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
        case "endDate":
          return dir * (new Date(a.endTime).getTime() - new Date(b.endTime).getTime());
        case "amount":
          return dir * (a.deposit - b.deposit);
        case "status": {
          const order = { Active: 0, Ended: 1, Cancelled: 2 };
          return dir * ((order[a.status] ?? 3) - (order[b.status] ?? 3));
        }
        default:
          return 0;
      }
    });
  }, [filtered, bookmarkedIds, sortField, sortOrder]);

  // Update URL params when filters change
  useEffect(() => {
    const params = new URLSearchParams();
    if (activeTab !== "sent") params.set("tab", activeTab);
    if (statusFilter) params.set("status", statusFilter);
    if (tokenFilter) params.set("token", tokenFilter);
    if (search.trim()) params.set("search", search);

    const queryString = params.toString();
    const newPath = queryString ? `/dashboard?${queryString}` : "/dashboard";
    router.replace(newPath);
  }, [activeTab, statusFilter, tokenFilter, search, router]);

  const clearFilters = () => {
    setStatusFilter("");
    setTokenFilter("");
    setSearch("");
    setBookmarksOnly(false);
  };

  const hasActiveFilters = statusFilter || tokenFilter || search.trim() || bookmarksOnly;

  const state: DashboardState = loading
    ? "loading"
    : sortedFiltered.length > 0
    ? "ready"
    : streams.length > 0 || hasActiveFilters
    ? "filtered-empty"
    : "empty";

  const allFilteredSelected = useMemo(
    () => filtered.length > 0 && filtered.every((s) => selectedIds.has(s.id)),
    [filtered, selectedIds],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((s) => s.id)));
    }
  }, [allFilteredSelected, filtered]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const handleBulkCancel = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      await Promise.all(ids.map(() => sorostream.cancelStream()));
      addToast(`Cancelled ${ids.length} stream(s) successfully.`, "success");
      const data = await rpcFetch(() => Promise.resolve(getStreamsForWallet(address)));
      setStreams(data);
      clearSelection();
    } catch {
      addToast("Bulk cancel failed. Please try again.", "error");
    } finally {
      setBulkLoading(false);
    }
  }, [selectedIds, addToast, rpcFetch, clearSelection, address]);

  const handleBulkTopUp = useCallback(async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      await Promise.all(ids.map(() => sorostream.topUp()));
      addToast(`Topped up ${ids.length} stream(s) successfully.`, "success");
      const data = await rpcFetch(() => Promise.resolve(getStreamsForWallet(address)));
      setStreams(data);
      clearSelection();
    } catch {
      addToast("Bulk top-up failed. Please try again.", "error");
    } finally {
      setBulkLoading(false);
    }
  }, [selectedIds, addToast, rpcFetch, clearSelection, address]);

  const handleBulkExport = useCallback(() => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const allEntries = ids.flatMap((id) => getMockStreamHistory(id));
    if (allEntries.length === 0) {
      addToast("No history entries for selected streams.", "info");
      return;
    }
    downloadCSV(allEntries, `bulk-${ids.length}-streams`);
    addToast(`Exported history for ${ids.length} stream(s).`, "success");
  }, [selectedIds, addToast]);

  const shortcutGroups: ShortcutGroup[] = useMemo(() => [
    {
      title: "Dashboard",
      shortcuts: [
        { key: "n", description: "New stream", action: () => router.push("/stream/new") },
        { key: "/", description: "Focus search", action: () => searchRef.current?.focus(), ignoreWhenEditing: false },
        { key: "Escape", description: "Clear search / selection", action: () => { setSearch(""); clearSelection(); (document.activeElement as HTMLElement)?.blur(); } },
        { key: "?", shift: true, description: "Toggle keyboard shortcuts help", action: () => setShowShortcutsHelp((v) => !v) },
      ],
    },
  ], [router, clearSelection]);

  useKeyboardShortcuts(shortcutGroups);

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-900 text-white p-4 sm:p-8">
      <div className="max-w-6xl mx-auto">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <Link
            href="/stream/new"
            className="bg-green-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-green-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
          >
            + New Stream
          </Link>
        </div>

        <div className="mb-6 flex gap-2" role="tablist" aria-label="Stream direction">
          {(["sent", "received"] as Tab[]).map((tab) => {
            const count = tab === "sent" ? sentActiveCount : receivedActiveCount;
            const isActive = activeTab === tab;
            return (
              <button
                key={tab}
                role="tab"
                aria-selected={isActive}
                onClick={() => handleTabChange(tab)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 ${
                  isActive
                    ? "bg-green-700 text-white"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}
              >
                {tab}
                <span
                  className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs ${
                    isActive ? "bg-green-900 text-green-200" : "bg-gray-700 text-gray-300"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col lg:flex-row gap-6">
          <div className="flex-1 min-w-0">
            {/* Archive banner — shown when streams have been auto-archived */}
            <ArchiveBanner />
            {/* Portfolio Chart */}
            <PortfolioChart />

            {/* Status legend */}
            <StreamErrorBoundary section="Stats Summary">
              <StatusLegend />
            </StreamErrorBoundary>

            {/* Portfolio performance chart */}
            <div className="mb-6">
              <PortfolioChart />
            </div>

            {/* Filter Bar */}
            <div className="mb-6 space-y-3">
              <div className="flex flex-wrap gap-3">
                {/* Status Filter */}
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                  aria-label="Filter by status"
                >
                  <option value="">All Statuses</option>
                  <option value="Active">Active</option>
                  <option value="Ended">Ended</option>
                  <option value="Cancelled">Cancelled</option>
                </select>

                {/* Token Filter */}
                <select
                  value={tokenFilter}
                  onChange={(e) => setTokenFilter(e.target.value)}
                  className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                  aria-label="Filter by token"
                  disabled={uniqueTokens.length === 0}
                >
                  <option value="">All Tokens</option>
                  {uniqueTokens.map((token) => (
                    <option key={token} value={token}>
                      {token}
                    </option>
                  ))}
                </select>

                {/* Bookmarks only toggle */}
                <button
                  onClick={() => setBookmarksOnly((v) => !v)}
                  aria-pressed={bookmarksOnly}
                  className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 ${
                    bookmarksOnly
                      ? "border-yellow-500 text-yellow-400 bg-yellow-900/20"
                      : "border-gray-700 text-gray-400 hover:bg-gray-800"
                  }`}
                >
                  <span aria-hidden="true">{bookmarksOnly ? "★" : "☆"}</span>
                  Bookmarks
                </button>

                {/* Search Input */}
                <input
                  ref={searchRef}
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by recipient, sender, or ID…"
                  className="flex-1 min-w-[200px] bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-sm text-white placeholder-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                  aria-label="Search streams"
                />

                {/* Clear Filters Button */}
                {hasActiveFilters && (
                  <button
                    onClick={clearFilters}
                    className="bg-gray-700 text-white px-4 py-2 rounded-lg text-sm hover:bg-gray-600 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                  >
                    Clear All
                  </button>
                )}
              </div>

              {/* Active Filters Display */}
              {hasActiveFilters && (
                <div className="flex flex-wrap gap-2 text-xs text-gray-400">
                  {statusFilter && (
                    <span className="bg-gray-800 px-2 py-1 rounded">
                      Status: {statusFilter}
                    </span>
                  )}
                  {tokenFilter && (
                    <span className="bg-gray-800 px-2 py-1 rounded">
                      Token: {tokenFilter}
                    </span>
                  )}
                  {search.trim() && (
                    <span className="bg-gray-800 px-2 py-1 rounded">
                      Search: &quot;{search}&quot;
                    </span>
                  )}
                  {bookmarksOnly && (
                    <span className="bg-yellow-900/30 text-yellow-400 px-2 py-1 rounded">
                      ★ Bookmarks only
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Sort controls */}
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <span className="text-xs text-gray-400 mr-1">Sort by:</span>
              {(
                [
                  { value: "created", label: "Date Created" },
                  { value: "endDate", label: "End Date" },
                  { value: "amount",  label: "Amount" },
                  { value: "status",  label: "Status" },
                ] as { value: SortField; label: string }[]
              ).map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => handleSortFieldChange(value)}
                  aria-pressed={sortField === value}
                  className={`px-3 py-1.5 rounded-lg text-xs border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 ${
                    sortField === value
                      ? "bg-green-700 border-green-600 text-white"
                      : "border-gray-700 text-gray-400 hover:bg-gray-800"
                  }`}
                >
                  {label}
                </button>
              ))}
              <button
                onClick={toggleSortOrder}
                aria-label={`Sort order: ${sortOrder === "asc" ? "ascending" : "descending"}`}
                className="ml-1 px-3 py-1.5 rounded-lg text-xs border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                {sortOrder === "asc" ? "↑ Asc" : "↓ Desc"}
              </button>
            </div>

            {/* Bulk actions bar */}
            {selectedIds.size > 0 && (
              <div className="mb-4 flex flex-wrap items-center gap-3 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3">
                <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-700 accent-green-500"
                    aria-label="Select all visible streams"
                  />
                  {selectedIds.size} selected
                </label>
                <div className="flex gap-2 ml-auto">
                  <button
                    onClick={handleBulkExport}
                    disabled={bulkLoading}
                    className="px-3 py-1.5 text-xs bg-gray-700 text-white rounded-lg hover:bg-gray-600 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
                  >
                    Export CSV
                  </button>
                  <button
                    onClick={handleBulkTopUp}
                    disabled={bulkLoading}
                    className="px-3 py-1.5 text-xs bg-green-700 text-white rounded-lg hover:bg-green-600 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
                  >
                    {bulkLoading ? "…" : "Top-up All"}
                  </button>
                  <button
                    onClick={handleBulkCancel}
                    disabled={bulkLoading}
                    className="px-3 py-1.5 text-xs bg-red-700 text-white rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500"
                  >
                    {bulkLoading ? "…" : "Cancel All"}
                  </button>
                  <button
                    onClick={clearSelection}
                    className="px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                    aria-label="Clear selection"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )}

            <StreamErrorBoundary section="Stream List">
            {state === "loading" ? (
              <StreamListSkeleton />
            ) : state === "empty" ? (
              <div className="bg-gray-800 rounded-xl p-10 text-center flex flex-col items-center gap-4">
                <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <circle cx="60" cy="60" r="56" fill="#1f2937" stroke="#374151" strokeWidth="2" />
                  <path d="M40 75 Q60 45 80 75" stroke="#10b981" strokeWidth="3" strokeLinecap="round" fill="none" />
                  <circle cx="40" cy="75" r="4" fill="#10b981" />
                  <circle cx="60" cy="55" r="4" fill="#10b981" />
                  <circle cx="80" cy="75" r="4" fill="#10b981" />
                  <path d="M52 88 L68 88" stroke="#4b5563" strokeWidth="2" strokeLinecap="round" />
                  <path d="M55 93 L65 93" stroke="#4b5563" strokeWidth="2" strokeLinecap="round" />
                  <circle cx="60" cy="35" r="6" fill="#374151" />
                  <path d="M57 35 L63 35 M60 32 L60 38" stroke="#9ca3af" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <h2 className="text-xl font-semibold text-white">No streams yet</h2>
                <p className="text-gray-400 text-sm max-w-xs">Create your first payment stream to get started</p>
                <Link
                  href="/stream/new"
                  className="mt-2 inline-flex items-center gap-2 bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-800"
                >
                  + Create Stream
                </Link>
              </div>
            ) : state === "filtered-empty" ? (
              <div className="bg-gray-800 rounded-xl p-10 text-center flex flex-col items-center gap-4">
                <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <circle cx="40" cy="40" r="36" fill="#1f2937" stroke="#374151" strokeWidth="2" />
                  <circle cx="36" cy="36" r="14" stroke="#6b7280" strokeWidth="3" fill="none" />
                  <path d="M46 46 L56 56" stroke="#6b7280" strokeWidth="3" strokeLinecap="round" />
                  <path d="M32 36 L40 36 M36 32 L36 40" stroke="#374151" strokeWidth="2" strokeLinecap="round" />
                </svg>
                <h2 className="text-lg font-semibold text-white">No results found</h2>
                <p className="text-gray-400 text-sm">No streams match your current filters</p>
                {bookmarksOnly ? (
                  <button
                    onClick={() => setBookmarksOnly(false)}
                    className="text-yellow-400 hover:text-yellow-300 text-sm"
                  >
                    Show all streams
                  </button>
                ) : (
                  <button
                    onClick={clearFilters}
                    className="mt-1 text-green-400 hover:text-green-300 text-sm"
                  >
                    Clear filters
                  </button>
                )}
              </div>
            ) : (
              <div className="rounded-xl border border-gray-700 bg-gray-900 p-2">
                <StreamVirtualList
                  streams={sortedFiltered}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                />
              </div>
            )}
            </StreamErrorBoundary>
          </div>

          <div className="w-full lg:w-80 shrink-0">
            <StreamErrorBoundary section="Activity Feed">
              <StreamEventFeed />
            </StreamErrorBoundary>
          </div>
        </div>
      </div>

      <KeyboardShortcutsHelp
        open={showShortcutsHelp}
        onClose={() => setShowShortcutsHelp(false)}
        groups={shortcutGroups}
      />
    </main>
  );
}

export default function Dashboard() {
  return (
    <Suspense fallback={<StreamListSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}
