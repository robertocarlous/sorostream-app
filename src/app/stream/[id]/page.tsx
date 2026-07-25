"use client";

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from "react";
import { useFocusTrap } from "@/src/lib/useFocusTrap";
import Link from "next/link";
import { useRouter } from "next/navigation";
import LiveCounter from "@/components/LiveCounter";
import FiatDisplay from "@/components/FiatDisplay";
import FederationName from "@/components/FederationName";
import StreamTimeline from "@/components/StreamTimeline";
import CountdownTimer from "@/components/CountdownTimer";
import StreamProgressBar from "@/components/StreamProgressBar";
import VestingChart from "@/components/VestingChart";
import StreamHistory from "@/components/StreamHistory";
import { StreamErrorBoundary } from "@/components/StreamErrorBoundary";
import StreamCompletedBanner from "@/components/StreamCompletedBanner";
import { SkeletonDetail } from "@/components/Skeleton";
import WalletConnect from "@/components/WalletConnect";
import KeyboardShortcutsHelp from "@/components/KeyboardShortcutsHelp";
import TransactionExportButton from "@/components/TransactionExportButton";
import { type StreamHistoryEntry } from "@/src/lib/export";
import {
  sorostream,
  type StreamData,
  getMockStreamHistory,
  claimableNow,
  getMockStream,
  toStroops,
} from "@/src/lib/sorostream";
import { useToast } from "@/src/lib/toast";
import StreamQrModal from "@/components/StreamQrModal";
import WithdrawConfirmModal from "@/components/WithdrawConfirmModal";
import { useSettings } from "@/src/context/SettingsContext";
import { formatStellarAmount } from "@/src/lib/sorostream";
import { useKeyboardShortcuts, type ShortcutGroup } from "@/src/lib/useKeyboardShortcuts";
import { useBookmarks } from "@/src/context/BookmarksContext";
import { useWallet } from "@/src/context/WalletContext";

/** Grace period in seconds before a cancel is submitted on-chain. */
const CANCEL_GRACE_SECONDS = 5;

/** Timeout in milliseconds for the stream data fetch. */
const STREAM_FETCH_TIMEOUT_MS = 10_000;

/** Spinner used inside transaction buttons */
function Spinner() {
  return (
    <svg
      className="animate-spin h-4 w-4 inline-block mr-1.5 align-middle"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

const DEEP_LINK_KEY = "sorostream-deep-link";
const DEEP_LINK_COUNT_KEY = "sorostream-deep-link-count";

export default function StreamDetail({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { addToast, upsertPersistentToast, removeToast } = useToast();
  const { withdrawThreshold } = useSettings();
  const { address, refetchBalance } = useWallet();
  const { isBookmarked, toggleBookmark } = useBookmarks();
  const [withdrawConfirmAmount, setWithdrawConfirmAmount] = useState<string | null>(null);

  // Scroll to top on entry/route-param change — App Router doesn't reset scroll
  // for dynamic-segment navigations, so a scrolled-down dashboard would otherwise
  // leave this page mid-scroll (#305). useLayoutEffect avoids a visible flash of
  // the wrong scroll position before paint.
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [params.id]);

  // ── Stream data ────────────────────────────────────────────────────────────
  const [stream, setStream] = useState<StreamData | null>(null);
  const [historyEntries, setHistoryEntries] = useState<StreamHistoryEntry[]>([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isNetworkError, setIsNetworkError] = useState(false);
  const [routeError, setRouteError] = useState<Error | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  // ── Action loading states ──────────────────────────────────────────────────
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  /** True while the 5-second cancel grace period is active. */
  const [cancelPending, setCancelPending] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const cancelModalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cancelModalRef, showCancelModal);
  const [showQrModal, setShowQrModal] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);

  // ── Stream completion states ───────────────────────────────────────────────
  const [claimFinalLoading, setClaimFinalLoading] = useState(false);
  const [claimFinalDone, setClaimFinalDone] = useState(false);

  // ── Top-up form state ──────────────────────────────────────────────────────
  const [showTopUp, setShowTopUp] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("");
  const [topUpLoading, setTopUpLoading] = useState(false);

  // ── Success banner (stream just created) ──────────────────────────────────
  const [successPhase, setSuccessPhase] = useState<"in" | "out" | null>(null);

  // ── Optimistic UI state ────────────────────────────────────────────────────
  /**
   * optimisticClaimable — passed to LiveCounter:
   *   null  → live ticking
   *   0     → immediately after withdraw click (pending tx)
   *
   * optimisticDeposit — shown next to stream balance:
   *   null  → use stream.deposit
   *   n     → optimistic value while top-up tx is in-flight
   */
  const [optimisticClaimable, setOptimisticClaimable] = useState<number | null>(null);
  const [optimisticDeposit, setOptimisticDeposit] = useState<number | null>(null);

  // ── Grace-period timer refs ────────────────────────────────────────────────
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const submitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelToastIdRef = useRef<number | null>(null);
  const undoRef = useRef(false);

  /** Clean up timers on unmount. */
  useEffect(() => {
    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      if (submitTimeoutRef.current) clearTimeout(submitTimeoutRef.current);
    };
  }, []);

  // ── Success banner: triggered once by ?new=true, blocked on refresh via sessionStorage ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") !== "true") return;

    const sessionKey = `sorostream-new-banner-shown`;
    if (sessionStorage.getItem(sessionKey)) return;
    sessionStorage.setItem(sessionKey, "1");

    // Remove query param so refresh doesn't retrigger
    const clean = new URL(window.location.href);
    clean.searchParams.delete("new");
    window.history.replaceState({}, "", clean.toString());

    setSuccessPhase("in");
    const outTimer = setTimeout(() => setSuccessPhase("out"), 1700);
    const doneTimer = setTimeout(() => setSuccessPhase(null), 2000);
    return () => { clearTimeout(outTimer); clearTimeout(doneTimer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Deep link: store URL when unauthenticated, redirect back after connect ──
  useEffect(() => {
    if (address === null) {
      // Store the intended URL (once per redirect cycle, max 1)
      const count = parseInt(sessionStorage.getItem(DEEP_LINK_COUNT_KEY) ?? "0", 10);
      if (count < 1) {
        sessionStorage.setItem(DEEP_LINK_KEY, window.location.pathname + window.location.search);
        sessionStorage.setItem(DEEP_LINK_COUNT_KEY, String(count + 1));
      }
    } else {
      // Wallet just connected — redirect to the stored deep link if it's different
      const stored = sessionStorage.getItem(DEEP_LINK_KEY);
      sessionStorage.removeItem(DEEP_LINK_KEY);
      sessionStorage.removeItem(DEEP_LINK_COUNT_KEY);
      if (stored && stored !== window.location.pathname + window.location.search) {
        router.push(stored);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // ── Load stream on mount ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadStream() {
      setPageLoading(true);
      setError(null);
      setIsNetworkError(false);
      try {
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Network timeout: stream data could not be loaded within 10 seconds.")), STREAM_FETCH_TIMEOUT_MS),
        );
        const data = await Promise.race([
          sorostream.getStream(params.id),
          timeoutPromise,
        ]);
        if (cancelled) return;
        if (!data) {
          setError("Stream not found.");
          return;
        }
        setStream(data);
        setHistoryEntries(getMockStreamHistory(params.id).sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()));
      } catch (err) {
        console.error("Failed to load stream", err);
        if (!cancelled) {
          const message = err instanceof Error ? err.message : "Failed to load stream data.";
          setError(message);
          setIsNetworkError(true);
          const nextError = err instanceof Error ? err : new Error("Failed to load stream data.");
          setRouteError(nextError);
        }
      } finally {
        if (!cancelled) setPageLoading(false);
      }
    }

    void loadStream();

    return () => {
      cancelled = true;
    };
  }, [params.id, fetchKey]);

  const handleRetry = useCallback(() => {
    setRouteError(null);
    setFetchKey((k) => k + 1);
  }, []);

  if (routeError) {
    throw routeError;
  }

  // ── Withdraw with optimistic update ───────────────────────────────────────
  const executeWithdraw = useCallback(async () => {
    const prevStream = getMockStream(params.id);
    const prevClaimable = prevStream ? Number(claimableNow(prevStream)) : 0;

    setOptimisticClaimable(0);
    setWithdrawLoading(true);

    try {
      const result = await sorostream.withdraw();
      setOptimisticClaimable(null);
      refetchBalance();
      addToast(`Withdrawal submitted! Tx: ${result.txHash}`, "success");
    } catch {
      setOptimisticClaimable(null);
      void prevClaimable;
      addToast("Withdrawal failed. Please try again.", "error");
    } finally {
      setWithdrawLoading(false);
    }
  }, [params.id, addToast, refetchBalance]);

  const handleWithdraw = useCallback(() => {
    const prevStream = getMockStream(params.id);
    const claimableStroops = prevStream ? Number(claimableNow(prevStream)) : 0;
    const claimableXlm = claimableStroops / 10_000_000;

    if (claimableXlm >= withdrawThreshold) {
      setWithdrawConfirmAmount(formatStellarAmount(claimableStroops));
    } else {
      void executeWithdraw();
    }
  }, [params.id, withdrawThreshold, executeWithdraw]);

  // ── Top-up with optimistic update ─────────────────────────────────────────
  const handleTopUp = useCallback(async () => {
    const parsedAmount = parseFloat(topUpAmount);
    if (!topUpAmount || parsedAmount <= 0) return;
    if (!stream) return;

    const prevDeposit = stream.deposit;
    const addedStroops = Number(toStroops(topUpAmount));
    setOptimisticDeposit(prevDeposit + addedStroops);
    setTopUpLoading(true);

    try {
      await sorostream.topUp();
      const updated = await sorostream.getStream(params.id);
      setStream(updated);
      setOptimisticDeposit(null);
      setShowTopUp(false);
      setTopUpAmount("");
      addToast("Top-up successful!", "success");
    } catch {
      setOptimisticDeposit(null);
      void prevDeposit;
      addToast("Top-up failed. Please try again.", "error");
    } finally {
      setTopUpLoading(false);
    }
  }, [topUpAmount, stream, params.id, addToast]);

  // ── Cancel: submit the actual transaction ──────────────────────────────────
  const submitCancel = useCallback(async () => {
    setCancelPending(false);
    setCancelLoading(true);

    if (cancelToastIdRef.current !== null) {
      removeToast(cancelToastIdRef.current);
      cancelToastIdRef.current = null;
    }

    try {
      const result = await sorostream.cancelStream();
      addToast(`Stream cancelled. Tx: ${result.txHash}`, "success");
    } catch {
      addToast("Cancellation failed. Please try again.", "error");
    } finally {
      setCancelLoading(false);
    }
  }, [addToast, removeToast]);

  // ── Cancel: undo during grace period ──────────────────────────────────────
  const handleCancelUndo = useCallback(() => {
    undoRef.current = true;

    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (submitTimeoutRef.current) {
      clearTimeout(submitTimeoutRef.current);
      submitTimeoutRef.current = null;
    }
    if (cancelToastIdRef.current !== null) {
      removeToast(cancelToastIdRef.current);
      cancelToastIdRef.current = null;
    }

    setCancelPending(false);
    addToast("Cancellation undone.", "info");
  }, [removeToast, addToast]);

  // ── Cancel: start the 5-second grace period ────────────────────────────────
  const handleCancelConfirmed = useCallback(() => {
    setShowCancelModal(false);
    if (cancelPending || cancelLoading) return;

    undoRef.current = false;
    setCancelPending(true);

    let secondsLeft = CANCEL_GRACE_SECONDS;
    const toastKey = `cancel-grace-${params.id}`;

    const showCountdown = (secs: number) => {
      const toastId = upsertPersistentToast(
        toastKey,
        `Cancelling stream #${params.id} in ${secs}s…`,
        "warning",
        { label: "Undo", onClick: handleCancelUndo },
      );
      cancelToastIdRef.current = toastId;
    };

    showCountdown(secondsLeft);

    countdownIntervalRef.current = setInterval(() => {
      secondsLeft -= 1;
      if (secondsLeft > 0) {
        showCountdown(secondsLeft);
      } else {
        clearInterval(countdownIntervalRef.current!);
        countdownIntervalRef.current = null;
      }
    }, 1000);

    submitTimeoutRef.current = setTimeout(() => {
      if (!undoRef.current) {
        void submitCancel();
      }
    }, CANCEL_GRACE_SECONDS * 1000);
  }, [cancelPending, cancelLoading, params.id, upsertPersistentToast, handleCancelUndo, submitCancel]);

  const isBusy = withdrawLoading || cancelLoading || cancelPending || topUpLoading;

  // ── Stream completion ─────────────────────────────────────────────────────
  /** True when the current wall-clock time has passed the stream's end time. */
  const isCompleted = stream
    ? Date.now() >= new Date(stream.endTime).getTime()
    : false;

  const handleClaimFinal = useCallback(async () => {
    setClaimFinalLoading(true);
    try {
      const result = await sorostream.withdraw();
      addToast(`Final amount claimed! Tx: ${result.txHash}`, "success");
      setClaimFinalDone(true);
    } catch {
      addToast("Claim failed. Please try again.", "error");
    } finally {
      setClaimFinalLoading(false);
    }
  }, [addToast]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  const shortcutGroups: ShortcutGroup[] = useMemo(() => [
    {
      title: "Stream Detail",
      shortcuts: [
        { key: "w", description: "Withdraw", action: () => { if (!isBusy) handleWithdraw(); } },
        { key: "c", description: "Cancel", action: () => { if (!cancelLoading && !withdrawLoading && !topUpLoading) setShowCancelModal(true); } },
        { key: "t", description: "Toggle top-up", action: () => setShowTopUp((v) => !v) },
        { key: "Escape", description: "Close modals", action: () => { setShowCancelModal(false); setShowQrModal(false); setShowTopUp(false); } },
        { key: "?", shift: true, description: "Toggle keyboard shortcuts help", action: () => setShowShortcutsHelp((v) => !v) },
      ],
    },
  ], [handleWithdraw, isBusy, cancelLoading, withdrawLoading, topUpLoading]);

  useKeyboardShortcuts(shortcutGroups);

  // ── Render helpers ─────────────────────────────────────────────────────────
  const formatUSDC = (stroops: number) => (stroops / 10_000_000).toFixed(2);
  const displayDeposit = optimisticDeposit != null ? optimisticDeposit : stream?.deposit ?? 0;
  const isDepositOptimistic = optimisticDeposit != null;



  // ── Render: wallet not connected ──────────────────────────────────────────
  if (address === null) {
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-900 text-white p-4 sm:p-8">
        <div className="max-w-sm mx-auto mt-20 text-center space-y-6">
          <div className="text-5xl" aria-hidden="true">🔒</div>
          <h1 className="text-xl font-semibold">Connect your wallet</h1>
          <p className="text-gray-400 text-sm">
            Connect your wallet to view stream #{params.id}.
          </p>
          <div className="flex justify-center">
            <WalletConnect />
          </div>
          <Link
            href="/dashboard"
            className="text-sm text-gray-400 hover:text-white underline transition-colors"
          >
            Go to dashboard
          </Link>
        </div>
      </main>
    );
  }

  // ── Render: loading ────────────────────────────────────────────────────────
  if (pageLoading) {
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-900 text-white p-4 sm:p-8">
        <div className="max-w-2xl mx-auto">
          <div className="mb-4">
            <Link
              href="/dashboard"
              className="text-sm text-gray-400 hover:text-white transition-colors"
            >
              ← Dashboard
            </Link>
          </div>
          <h1 className="text-2xl font-bold mb-8">Stream #{params.id}</h1>
          <SkeletonDetail />
        </div>
      </main>
    );
  }

  // ── Render: not found / error ─────────────────────────────────────────────
  if (!stream) {
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-900 text-white p-4 sm:p-8">
        <div className="max-w-2xl mx-auto">
          <div className="mb-6">
            <Link
              href="/dashboard"
              className="text-sm text-gray-400 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 rounded"
            >
              ← Dashboard
            </Link>
          </div>
          <div className="flex flex-col items-center gap-4 py-16 text-center">
            {isNetworkError ? (
              <>
                <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <circle cx="40" cy="40" r="36" fill="#1f2937" stroke="#374151" strokeWidth="2" />
                  <path d="M28 40h24M40 28v24" stroke="#f59e0b" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <h1 className="text-2xl font-bold">Connection Error</h1>
                <p className="text-gray-400 text-sm max-w-sm">
                  {error ?? "Unable to reach the Soroban RPC. Please check your network connection and try again."}
                </p>
                <button
                  onClick={handleRetry}
                  className="mt-2 inline-flex items-center gap-2 bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                >
                  Try Again
                </button>
              </>
            ) : (
              <>
                <svg width="80" height="80" viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                  <circle cx="40" cy="40" r="36" fill="#1f2937" stroke="#374151" strokeWidth="2" />
                  <path d="M28 28 L52 52 M52 28 L28 52" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" />
                </svg>
                <h1 className="text-2xl font-bold">Stream Not Found</h1>
                <p className="text-gray-400 text-sm max-w-sm">{error ?? "The stream you're looking for doesn't exist or may have been removed."}</p>
                <Link
                  href="/dashboard"
                  className="mt-2 inline-flex items-center gap-2 bg-green-700 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-green-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                >
                  ← Back to Dashboard
                </Link>
              </>
            )}
          </div>
        </div>
      </main>
    );
  }

  const toXlm = (stroops: number) => (stroops / 10_000_000).toFixed(2);
  const depositXlm = stream.deposit / 10_000_000;
  const flowXlm = stream.flowRate / 10_000_000;

  // ── Render: detail ─────────────────────────────────────────────────────────
  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-900 text-white p-4 sm:p-8">
      {successPhase !== null && (
        <div
          aria-live="polite"
          aria-atomic="true"
          className={`fixed top-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-green-700 text-white px-6 py-3 rounded-full shadow-lg text-sm font-medium pointer-events-none ${
            successPhase === "in"
              ? "animate-stream-success-in"
              : "animate-stream-success-out"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Stream created successfully!
        </div>
      )}
      <div className="max-w-2xl mx-auto animate-fade-in">
        <div className="mb-4">
          <Link
            href="/dashboard"
            className="text-sm text-gray-400 hover:text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 rounded"
          >
            ← Dashboard
          </Link>
        </div>

        <h1 className="text-2xl font-bold mb-2">Stream #{stream.id}</h1>
        <div className="flex flex-col sm:flex-row sm:gap-4 text-sm text-gray-400 mb-8">
          <span>
            From:{" "}
            <span className="text-white">
              <FederationName address={stream.sender} truncate />
            </span>
          </span>
          <span className="hidden sm:inline" aria-hidden="true">|</span>
          <span>
            To:{" "}
            <span className="text-white">
              <FederationName address={stream.recipient} truncate />
            </span>
          </span>
        </div>

        <div className="flex justify-end gap-2 mb-4 print-hidden">
          {/* Bookmark toggle */}
          <button
            onClick={() => toggleBookmark(stream.id)}
            aria-label={isBookmarked(stream.id) ? "Remove bookmark" : "Bookmark this stream"}
            aria-pressed={isBookmarked(stream.id)}
            className={`inline-flex items-center gap-2 py-2 px-4 rounded-lg text-sm border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 ${
              isBookmarked(stream.id)
                ? "border-yellow-500 text-yellow-400 bg-yellow-900/20"
                : "border-gray-600 text-gray-300 hover:bg-gray-700"
            }`}
          >
            <span aria-hidden="true">{isBookmarked(stream.id) ? "★" : "☆"}</span>
            {isBookmarked(stream.id) ? "Bookmarked" : "Bookmark"}
          </button>

          {/* Print / PDF export */}
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white py-2 px-4 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="6 9 6 2 18 2 18 9" />
              <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
              <rect x="6" y="14" width="12" height="8" />
            </svg>
            Export PDF
          </button>

          <button
            onClick={() => {
              const duration = Math.round(
                (new Date(stream.endTime).getTime() - new Date(stream.startTime).getTime()) / 1000,
              );
              const qp = new URLSearchParams({
                recipient: stream.recipient,
                amount: (stream.deposit / 10_000_000).toString(),
                token: "USDC",
                duration: String(duration),
                cliff: "0",
              });
              router.push(`/stream/new?${qp.toString()}`);
            }}
            aria-label="Clone this stream"
            className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white py-2 px-4 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 4v16h16" /><path d="m8 16 4-4 4 4" /><path d="M12 12v9" />
            </svg>
            Clone
          </button>
          <button
            onClick={() => {
              const url = window.location.origin + `/stream/${stream.id}`;
              navigator.clipboard.writeText(url).then(
                () => addToast("Deep link copied to clipboard!", "success"),
                () => {
                  const textarea = document.createElement("textarea");
                  textarea.value = url;
                  textarea.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
                  document.body.appendChild(textarea);
                  textarea.focus();
                  textarea.select();
                  document.execCommand("copy");
                  document.body.removeChild(textarea);
                  addToast("Deep link copied to clipboard!", "success");
                },
              );
            }}
            aria-label="Copy share link for this stream"
            className="inline-flex items-center gap-2 bg-gray-700 hover:bg-gray-600 text-white py-2 px-4 rounded-lg text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
            title={`${window.location.origin}/stream/${stream.id}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.51" />
            </svg>
            Share
          </button>
        </div>

        {/* Stream completed banner — shown when currentTime >= endTime */}
        {isCompleted && (
          <StreamCompletedBanner
            streamId={stream.id}
            finalAmount={formatUSDC(stream.deposit)}
            onClaim={handleClaimFinal}
            claiming={claimFinalLoading}
            claimed={claimFinalDone}
          />
        )}

        <div className="bg-gray-800 rounded-xl p-6 space-y-6">
          <StreamTimeline startTime={stream.startTime} endTime={stream.endTime} />
          <CountdownTimer endTime={stream.endTime} />

          <StreamProgressBar stream={stream} />

          {/* Deposit & flow rate */}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-400 mb-1">Total deposit</p>
              <p className="text-white font-mono">
                {toXlm(stream.deposit)} XLM
                <FiatDisplay xlmAmount={depositXlm} />
              </p>
            </div>
            <div>
              <p className="text-gray-400 mb-1">Flow rate</p>
              <p className="text-green-400 font-mono">
                {toXlm(stream.flowRate)} XLM/sec
                <FiatDisplay xlmAmount={flowXlm} />
              </p>
            </div>
          </div>

          {/* Claimable balance — optimistic withdraw support */}
          <StreamErrorBoundary section="Live Counter" resetKey={stream.id}>
            <div className="text-center">
              <p className="text-gray-400 text-sm mb-2">Claimable now</p>
              <div className="text-2xl sm:text-3xl font-bold">
                <LiveCounter
                  streamId={stream.id}
                  flowRate={stream.flowRate}
                  lastWithdrawTime={new Date(stream.lastWithdrawTime)}
                  optimisticOverride={optimisticClaimable}
                />
              </div>
            </div>
          </StreamErrorBoundary>

          {/* Stream balance — optimistic top-up support */}
          <div className="text-center">
            <p className="text-gray-400 text-sm mb-1">Stream balance (deposit)</p>
            <p
              className={`font-mono font-semibold text-lg ${
                isDepositOptimistic ? "text-yellow-400" : "text-white"
              }`}
            >
              {formatUSDC(displayDeposit)} USDC
              {isDepositOptimistic && (
                <span className="ml-2 text-xs font-normal text-yellow-400/80 italic">
                  (pending…)
                </span>
              )}
            </p>
          </div>

          {/* Vesting analytics chart */}
          <VestingChart stream={stream} history={historyEntries} />

          {error && (
            <p role="alert" className="text-red-400 text-sm text-center">
              {error}
            </p>
          )}

          {/* Withdraw / Cancel */}
          <div className="flex gap-4 print-hidden">
            <button
              onClick={handleWithdraw}
              disabled={isBusy}
              className="flex-1 bg-green-700 text-white py-3 rounded-lg font-medium hover:bg-green-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
            >
              {withdrawLoading ? (
                <>
                  <Spinner />
                  Withdrawing…
                </>
              ) : (
                "Withdraw"
              )}
            </button>

            <button
              onClick={cancelPending ? handleCancelUndo : () => setShowCancelModal(true)}
              disabled={cancelLoading || withdrawLoading || topUpLoading}
              aria-live="polite"
              className={`flex-1 py-3 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed ${
                cancelPending
                  ? "bg-amber-600 text-white hover:bg-amber-700 focus-visible:ring-amber-500"
                  : "border border-red-600 text-red-400 hover:bg-red-900 focus-visible:ring-red-500"
              }`}
            >
              {cancelLoading ? (
                <>
                  <Spinner />
                  Cancelling…
                </>
              ) : cancelPending ? (
                "Undo Cancel"
              ) : (
                "Cancel"
              )}
            </button>
          </div>

          <button
            onClick={() => setShowQrModal(true)}
            className="w-full border border-gray-600 text-gray-300 py-2 rounded-lg text-sm hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
          >
            QR Code
          </button>

          {/* Top-up form */}
          {showTopUp && (
            <div className="space-y-2">
              <label htmlFor="topup-amount" className="text-gray-200 text-sm font-medium block">
                Top-up Amount (USDC)
              </label>
              <input
                id="topup-amount"
                type="number"
                value={topUpAmount}
                onChange={(e) => setTopUpAmount(e.target.value)}
                placeholder="Amount (USDC)"
                min="0"
                step="0.01"
                className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              />
              <button
                onClick={handleTopUp}
                disabled={topUpLoading || !topUpAmount || parseFloat(topUpAmount) <= 0}
                className="w-full bg-blue-600 text-white py-2 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                {topUpLoading ? (
                  <>
                    <Spinner />
                    Topping up…
                  </>
                ) : (
                  "Confirm Top-up"
                )}
              </button>
            </div>
          )}
          <button
            onClick={() => setShowTopUp((v) => !v)}
            aria-expanded={showTopUp}
            disabled={topUpLoading}
            className="w-full border border-gray-600 text-gray-300 py-2 rounded-lg text-sm hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900 disabled:opacity-50"
          >
            {showTopUp ? "Cancel Top-up" : "Top Up Stream"}
          </button>

          {/* Transaction history */}
          <StreamErrorBoundary section="Transaction History" resetKey={stream.id}>
            <section aria-labelledby="history-heading">
              <h2 id="history-heading" className="text-lg font-semibold mb-3">
                Transaction History
              </h2>
              <StreamHistory entries={historyEntries} />
              {historyEntries.length > 0 && (
                <div className="mt-4">
                  <p className="text-gray-400 text-sm font-medium mb-3">
                    History Export
                  </p>
                  <TransactionExportButton
                    entries={historyEntries}
                    account={stream.recipient}
                    onExported={(filename) => addToast(`Exported ${filename}`, "success")}
                  />
                </div>
              )}
            </section>
          </StreamErrorBoundary>
        </div>
      </div>

      <StreamQrModal
        open={showQrModal}
        onClose={() => setShowQrModal(false)}
        recipient={stream.recipient}
        amount={(stream.deposit / 10_000_000).toString()}
        token="USDC"
        duration={Math.round((new Date(stream.endTime).getTime() - new Date(stream.startTime).getTime()) / 1000)}
      />

      <KeyboardShortcutsHelp
        open={showShortcutsHelp}
        onClose={() => setShowShortcutsHelp(false)}
        groups={shortcutGroups}
      />

      {/* Cancel confirmation modal */}
      {showCancelModal && (
        <div
          ref={cancelModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-modal-title"
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
        >
          <div className="bg-gray-800 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <h2 id="cancel-modal-title" className="text-lg font-semibold text-white">
              Cancel Stream?
            </h2>
            <p className="text-gray-400 text-sm">
              This is irreversible. Any unstreamed funds will be returned to the
              sender. You&apos;ll have 5 seconds to undo after confirming.
            </p>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => setShowCancelModal(false)}
                className="flex-1 border border-gray-600 text-gray-300 py-2 rounded-lg hover:bg-gray-700 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                Go Back
              </button>
              <button
                onClick={handleCancelConfirmed}
                disabled={cancelLoading}
                className="flex-1 bg-red-600 text-white py-2 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                {cancelLoading ? "Cancelling…" : "Yes, Cancel"}
              </button>
            </div>
          </div>
        </div>
      )}

      {withdrawConfirmAmount !== null && (
        <WithdrawConfirmModal
          amount={withdrawConfirmAmount}
          onConfirm={() => { setWithdrawConfirmAmount(null); void executeWithdraw(); }}
          onCancel={() => setWithdrawConfirmAmount(null)}
        />
      )}
    </main>
  );
}
