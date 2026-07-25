"use client";
import { useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import DurationPicker from "@/components/DurationPicker";
import FlowRatePreview from "@/components/FlowRatePreview";
import StreamTemplatePicker from "@/components/StreamTemplatePicker";
import RecipientAutocomplete from "@/components/RecipientAutocomplete";
import TransactionStepper, { TxStage } from "@/components/TransactionStepper";
import { SkeletonForm } from "@/components/Skeleton";
import { useTranslations } from "@/src/lib/i18n";
import { trackEvent } from "@/src/lib/analytics";
import { sorostream } from "@/src/lib/sorostream";
import { useToast } from "@/src/lib/toast";

type Step = "recipient" | "amount" | "review";

/** Max time to wait for a submission attempt before resubmitting. */
const SUBMIT_TIMEOUT_MS = 8_000;
/** How many times to automatically resubmit after a timeout before giving up. */
const MAX_RESUBMIT_ATTEMPTS = 2;

/** Rejects with a `SUBMIT_TIMEOUT` error if `promise` doesn't settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SUBMIT_TIMEOUT")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const SUPPORTED_TOKENS = [
  { symbol: "USDC", name: "USD Coin",        address: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU" },
  { symbol: "XLM",  name: "Stellar Lumens",  address: "native" },
  { symbol: "AQUA", name: "Aquarius",        address: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA" },
  { symbol: "yXLM", name: "Yield XLM",       address: "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55" },
] as const;

const CUSTOM_TOKEN_VALUE = "__custom__";

function validateRecipient(value: string): string {
  if (!value) return "Recipient address is required.";
  if (!/^G[A-Z2-7]{55}$/.test(value))
    return "Must be a valid Stellar public key (starts with G, 56 chars).";
  return "";
}

function validateAmount(value: string): string {
  if (!value) return "Amount is required.";
  if (!/^\d*\.?\d*$/.test(value.trim())) return "Amount must contain only numbers.";
  if (Number(value) <= 0) return "Amount must be greater than 0.";
  return "";
}

function validateDuration(seconds: number): string {
  if (seconds <= 0) return "Duration must be greater than 0.";
  return "";
}

/**
 * Validates an optional end-date ISO string.
 * Returns an error if the value is provided but points to the past.
 */
function validateEndDate(value: string): string {
  if (!value) return "";
  const ts = new Date(value).getTime();
  if (isNaN(ts)) return "Invalid date.";
  if (ts <= Date.now()) return "End date must be in the future.";
  return "";
}

/**
 * Validates an optional cliff-date ISO string relative to the end date.
 * Returns an error if the cliff is after the end date.
 */
function validateCliffDate(cliffValue: string, endValue: string): string {
  if (!cliffValue) return "";
  const cliffTs = new Date(cliffValue).getTime();
  if (isNaN(cliffTs)) return "Invalid cliff date.";
  if (cliffTs <= Date.now()) return "Cliff date must be in the future.";
  if (endValue) {
    const endTs = new Date(endValue).getTime();
    if (!isNaN(endTs) && cliffTs >= endTs) {
      return "Cliff date must be before the end date.";
    }
  }
  return "";
}

const stepLabels: Record<Step, { title: string; number: number }> = {
  recipient: { title: "Recipient", number: 1 },
  amount: { title: "Amount & Duration", number: 2 },
  review: { title: "Review & Confirm", number: 3 },
};

const STEPS: Step[] = ["recipient", "amount", "review"];

function NewStreamWizard() {
  const router = useRouter();
  const t = useTranslations("stream_new");
  const { addToast } = useToast();
  const [step, setStep] = useState<Step>("recipient");
  const searchParams = useSearchParams();

  const recipientParam = searchParams.get("recipient");
  const amountParam = searchParams.get("amount");
  const durationParam = searchParams.get("duration");

  const initialRecipient =
    recipientParam && /^G[A-Z2-7]{55}$/.test(recipientParam)
      ? recipientParam
      : "";
  const initialAmount = (() => {
    if (!amountParam) return "";
    const num = parseFloat(amountParam);
    return !isNaN(num) && num > 0 ? amountParam : "";
  })();
  const initialDuration = (() => {
    if (!durationParam) return 0;
    const num = parseFloat(durationParam);
    return !isNaN(num) && num > 0 ? Math.round(num) : 0;
  })();

  const [recipient, setRecipient] = useState(initialRecipient);
  const [amount, setAmount] = useState(initialAmount);
  const [duration, setDuration] = useState(initialDuration);
  const [selectedToken, setSelectedToken] = useState<string>(SUPPORTED_TOKENS[0].symbol);
  const [customTokenAddress, setCustomTokenAddress] = useState("");
  const [customTokenError, setCustomTokenError] = useState("");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState({ recipient: "", amount: "", duration: "", endDate: "", cliffDate: "" });
  const [touched, setTouched] = useState({ recipient: false, amount: false });
  const [durationPickerKey, setDurationPickerKey] = useState(0);

  // Optional end date & cliff date (ISO datetime-local value)
  const [endDate, setEndDate] = useState("");
  const [cliffDate, setCliffDate] = useState("");

  // Transaction progress
  const [txStage, setTxStage] = useState<TxStage | null>(null);
  const [txFailedStage, setTxFailedStage] = useState<TxStage | undefined>(undefined);
  const [txError, setTxError] = useState<string | undefined>(undefined);
  // Number of automatic resubmissions for the current submission (0 = none yet).
  // Drives an inline spinner-update message rather than a separate toast.
  const [resubmitAttempt, setResubmitAttempt] = useState(0);
  // Identifies the current logical submission so a stale/late attempt can't
  // fire a second success toast — cleared naturally on unmount/refresh since
  // it's plain in-memory ref state, never persisted.
  const submissionIdRef = useRef(0);

  function handleTemplateSelect(seconds: number, suggestedAmount?: string, recipientOverride?: string) {
    setDuration(seconds);
    setErrors((prev) => ({ ...prev, duration: "" }));
    if (suggestedAmount) {
      setAmount(suggestedAmount);
      setErrors((prev) => ({ ...prev, amount: "" }));
    }
    if (recipientOverride && /^G[A-Z2-7]{55}$/.test(recipientOverride)) {
      setRecipient(recipientOverride);
      setErrors((prev) => ({ ...prev, recipient: "" }));
    }
  }

  function handleRecipientBlur() {
    setTouched((prev) => ({ ...prev, recipient: true }));
    setErrors((prev) => ({ ...prev, recipient: validateRecipient(recipient) }));
  }

  function handleAmountBlur() {
    setTouched((prev) => ({ ...prev, amount: true }));
    setErrors((prev) => ({ ...prev, amount: validateAmount(amount) }));
  }

  function goNext() {
    if (step === "recipient") {
      const err = validateRecipient(recipient);
      if (err) {
        setErrors((prev) => ({ ...prev, recipient: err }));
        setTouched((prev) => ({ ...prev, recipient: true }));
        return;
      }
      setStep("amount");
    } else if (step === "amount") {
      const aErr = validateAmount(amount);
      const dErr = validateDuration(duration);
      const eErr = validateEndDate(endDate);
      const cErr = validateCliffDate(cliffDate, endDate);
      if (aErr || dErr || eErr || cErr) {
        setErrors({ ...errors, amount: aErr, duration: dErr, endDate: eErr, cliffDate: cErr });
        return;
      }
      setStep("review");
    }
  }

  function goBack() {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  }

  function resolvedTokenAddress(): string | null {
    if (selectedToken === CUSTOM_TOKEN_VALUE) {
      const trimmed = customTokenAddress.trim();
      if (!trimmed) { setCustomTokenError("Contract address is required."); return null; }
      setCustomTokenError("");
      return trimmed;
    }
    return SUPPORTED_TOKENS.find((t) => t.symbol === selectedToken)?.address ?? SUPPORTED_TOKENS[0].address;
  }

  async function handleCreateStream() {
    const rErr = validateRecipient(recipient);
    const aErr = validateAmount(amount);
    const dErr = validateDuration(duration);
    const eErr = validateEndDate(endDate);
    const cErr = validateCliffDate(cliffDate, endDate);
    if (rErr || aErr || dErr || eErr || cErr) {
      setErrors({ recipient: rErr, amount: aErr, duration: dErr, endDate: eErr, cliffDate: cErr });
      return;
    }

    const tokenAddress = resolvedTokenAddress();
    if (!tokenAddress) return;

    setLoading(true);
    setTxStage(TxStage.Building);
    setTxFailedStage(undefined);
    setTxError(undefined);
    setResubmitAttempt(0);
    trackEvent({ type: "stream_create_start" });

    const submissionId = ++submissionIdRef.current;

    try {
      // Building phase — construct the tx envelope
      await new Promise((r) => setTimeout(r, 400));
      setTxStage(TxStage.Signing);

      // Signing phase — wait for wallet
      await new Promise((r) => setTimeout(r, 400));
      setTxStage(TxStage.Submitting);

      // Submitting phase — broadcast
      await new Promise((r) => setTimeout(r, 300));
      setTxStage(TxStage.Confirming);

      // Confirming phase — actual SDK call. If a submission attempt takes too
      // long we resubmit automatically, staying on the same "Confirming" stage
      // (surfaced as a spinner-update, not a new toast) instead of showing a
      // toast per attempt — only the attempt that actually confirms gets one.
      const createParams = {
        recipient,
        amount,
        durationSeconds: duration,
        token: selectedToken === CUSTOM_TOKEN_VALUE ? tokenAddress : selectedToken,
      };

      let result: Awaited<ReturnType<typeof sorostream.createStream>> | null = null;
      let attempt = 0;
      while (result === null) {
        try {
          result = await withTimeout(sorostream.createStream(createParams), SUBMIT_TIMEOUT_MS);
        } catch (attemptErr) {
          const timedOut = attemptErr instanceof Error && attemptErr.message === "SUBMIT_TIMEOUT";
          if (timedOut && attempt < MAX_RESUBMIT_ATTEMPTS) {
            attempt += 1;
            setResubmitAttempt(attempt);
            continue;
          }
          throw attemptErr;
        }
      }

      // A newer submission superseded this one — nothing else on screen still
      // refers to it, so drop this stale result instead of surfacing a toast.
      if (submissionId !== submissionIdRef.current) return;

      setTxStage(TxStage.Done);
      trackEvent({ type: "stream_create_complete", streamId: result.streamId });
      addToast(`Stream created successfully — tx ${result.txHash}`, "success");

      // Auto-close after 2 seconds, then redirect
      await new Promise((r) => setTimeout(r, 2000));

      setRecipient("");
      setAmount("");
      setDuration(0);
      setEndDate("");
      setCliffDate("");
      setErrors({ recipient: "", amount: "", duration: "", endDate: "", cliffDate: "" });
      setTouched({ recipient: false, amount: false });
      setDurationPickerKey((k) => k + 1);
      setTxStage(null);
      router.push(`/stream/${result.streamId}?new=true`);
    } catch (err) {
      console.error("Failed to create stream:", err);
      setTxFailedStage(txStage ?? TxStage.Confirming);
      setTxError(err instanceof Error ? err.message : "Transaction failed. Please try again.");
      setTxStage(txStage ?? TxStage.Confirming);
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-900 text-white p-8">
        <div className="max-w-lg mx-auto">
          <h1 className="text-2xl font-bold mb-8">{t("title")}</h1>
          {txStage !== null ? (
            <div className="bg-gray-800 rounded-xl p-8 space-y-6" aria-label="Transaction in progress">
              <h2 className="text-lg font-semibold text-center">
                {txStage === TxStage.Done ? "🎉 Stream Created!" : "Creating your stream…"}
              </h2>
              <TransactionStepper
                currentStage={txStage}
                failedStage={txFailedStage}
                errorMessage={txError}
              />
              {resubmitAttempt > 0 && txStage === TxStage.Confirming && !txFailedStage && (
                <p className="text-center text-xs text-yellow-400" aria-live="polite">
                  Taking longer than expected — resubmitting… (attempt {resubmitAttempt})
                </p>
              )}
              {txFailedStage && (
                <button
                  type="button"
                  onClick={() => { setLoading(false); setTxStage(null); setTxFailedStage(undefined); setTxError(undefined); }}
                  className="w-full border border-gray-600 text-gray-300 py-3 rounded-lg font-medium hover:bg-gray-700 transition-colors"
                >
                  Back to Form
                </button>
              )}
            </div>
          ) : (
            <SkeletonForm />
          )}
        </div>
      </main>
    );
  }

  const canGoNext = step === "recipient"
    ? recipient.length > 0
    : step === "amount"
    ? amount.length > 0 && duration > 0
    : true;

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-900 text-white p-4 sm:p-8">
      <div className="max-w-lg mx-auto">
        <div className="mb-8">
          <div className="flex items-center justify-center gap-2 mb-6">
            {STEPS.map((s, i) => (
              <div key={s} className="flex items-center gap-2">
                <div
                  className={`flex items-center justify-center w-8 h-8 rounded-full text-xs font-semibold transition-colors ${
                    step === s
                      ? "bg-green-700 text-white"
                      : STEPS.indexOf(step) > i
                      ? "bg-green-800 text-green-300"
                      : "bg-gray-700 text-gray-400"
                  }`}
                >
                  {STEPS.indexOf(step) > i ? "✓" : i + 1}
                </div>
                <span className={`text-xs hidden sm:inline ${step === s ? "text-white" : "text-gray-400"}`}>
                  {stepLabels[s].title}
                </span>
                {i < STEPS.length - 1 && (
                  <div className={`w-8 h-px ${STEPS.indexOf(step) > i ? "bg-green-600" : "bg-gray-700"}`} />
                )}
              </div>
            ))}
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-center">{stepLabels[step].title}</h1>
        </div>

        {/* Step: Recipient */}
        {step === "recipient" && (
          <div className="space-y-6">
            <div>
              <label htmlFor="recipient" className="text-gray-200 text-sm font-medium block mb-2">
                {t("recipient_label")}
              </label>
              <RecipientAutocomplete
                value={recipient}
                onChange={(v) => {
                  setRecipient(v);
                  setErrors((prev) => ({ ...prev, recipient: "" }));
                }}
                onBlur={handleRecipientBlur}
                placeholder={t("recipient_placeholder")}
                error={errors.recipient}
                touched={touched.recipient}
              />
              {errors.recipient && (
                <p id="recipient-error" className="text-red-400 text-sm mt-1">
                  {errors.recipient}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Step: Amount & Duration */}
        {step === "amount" && (
          <div className="space-y-6">
            {/* Token selector */}
            <div>
              <label htmlFor="token-select" className="text-gray-200 text-sm font-medium block mb-2">
                Token
              </label>
              <select
                id="token-select"
                value={selectedToken}
                onChange={(e) => {
                  setSelectedToken(e.target.value);
                  setCustomTokenError("");
                }}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
              >
                {SUPPORTED_TOKENS.map((t) => (
                  <option key={t.symbol} value={t.symbol}>
                    {t.symbol} — {t.name} ({t.address === "native" ? "native" : `${t.address.slice(0, 6)}…${t.address.slice(-4)}`})
                  </option>
                ))}
                <option value={CUSTOM_TOKEN_VALUE}>Custom token…</option>
              </select>
              {selectedToken === CUSTOM_TOKEN_VALUE && (
                <div className="mt-2">
                  <input
                    id="custom-token-address"
                    type="text"
                    value={customTokenAddress}
                    onChange={(e) => { setCustomTokenAddress(e.target.value); setCustomTokenError(""); }}
                    placeholder="Contract address (e.g. C…)"
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                    aria-label="Custom token contract address"
                    aria-invalid={!!customTokenError}
                    aria-describedby={customTokenError ? "custom-token-error" : undefined}
                  />
                  {customTokenError && (
                    <p id="custom-token-error" className="text-red-400 text-xs mt-1">{customTokenError}</p>
                  )}
                </div>
              )}
            </div>

            <div>
              <label htmlFor="amount" className="text-gray-200 text-sm font-medium block mb-2">
                {t("amount_label")}
              </label>
              <input
                id="amount"
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  const val = e.target.value;
                  setAmount(val);
                  if (touched.amount) {
                    setErrors((prev) => ({ ...prev, amount: validateAmount(val) }));
                  } else {
                    setErrors((prev) => ({ ...prev, amount: "" }));
                  }
                }}
                onPaste={(e) => {
                  const pasted = e.clipboardData.getData("text");
                  if (!/^\d*\.?\d*$/.test(pasted.trim())) {
                    e.preventDefault();
                    setTouched((prev) => ({ ...prev, amount: true }));
                    setErrors((prev) => ({ ...prev, amount: "Amount must contain only numbers." }));
                  }
                }}
                onBlur={handleAmountBlur}
                placeholder={t("amount_placeholder")}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                aria-required="true"
                aria-invalid={!!(touched.amount && errors.amount)}
                aria-describedby={
                  touched.amount && errors.amount ? "amount-error" : undefined
                }
              />
              {errors.amount && (
                <p id="amount-error" className="text-red-400 text-sm mt-1">
                  {errors.amount}
                </p>
              )}
            </div>

            <StreamTemplatePicker
              onSelect={handleTemplateSelect}
              currentRecipient={recipient}
              currentAmount={amount}
              currentDuration={duration}
            />

            <div>
              <label className="text-gray-200 text-sm font-medium block mb-2">{t("duration_label")}</label>
              <DurationPicker
                key={durationPickerKey}
                initialSeconds={duration > 0 ? duration : undefined}
                onChange={(s) => {
                  setDuration(s);
                  if (s > 0) setErrors((prev) => ({ ...prev, duration: "" }));
                }}
                error={errors.duration || undefined}
              />
            </div>

            {/* Optional end date */}
            <div>
              <label htmlFor="end-date" className="text-gray-200 text-sm font-medium block mb-2">
                End Date <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                id="end-date"
                type="datetime-local"
                value={endDate}
                onChange={(e) => {
                  setEndDate(e.target.value);
                  setErrors((prev) => ({ ...prev, endDate: validateEndDate(e.target.value) }));
                }}
                onBlur={() => setErrors((prev) => ({ ...prev, endDate: validateEndDate(endDate) }))}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                aria-invalid={!!errors.endDate}
                aria-describedby={errors.endDate ? "end-date-error" : undefined}
              />
              {errors.endDate && (
                <p id="end-date-error" role="alert" className="text-red-400 text-sm mt-1">
                  {errors.endDate}
                </p>
              )}
            </div>

            {/* Optional cliff date */}
            <div>
              <label htmlFor="cliff-date" className="text-gray-200 text-sm font-medium block mb-2">
                Cliff Date <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                id="cliff-date"
                type="datetime-local"
                value={cliffDate}
                onChange={(e) => {
                  setCliffDate(e.target.value);
                  setErrors((prev) => ({ ...prev, cliffDate: validateCliffDate(e.target.value, endDate) }));
                }}
                onBlur={() => setErrors((prev) => ({ ...prev, cliffDate: validateCliffDate(cliffDate, endDate) }))}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-4 py-3 text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900"
                aria-invalid={!!errors.cliffDate}
                aria-describedby={errors.cliffDate ? "cliff-date-error" : undefined}
              />
              {errors.cliffDate && (
                <p id="cliff-date-error" role="alert" className="text-red-400 text-sm mt-1">
                  {errors.cliffDate}
                </p>
              )}
            </div>

            {amount && duration > 0 && (
              <FlowRatePreview amount={amount} durationSeconds={duration} />
            )}
          </div>
        )}

        {/* Step: Review & Confirm */}
        {step === "review" && (
          <div className="space-y-6">
            <div className="bg-gray-800 rounded-xl p-5 space-y-4 border border-gray-700">
              <div className="flex justify-between items-center">
                <span className="text-gray-400 text-sm">Recipient</span>
                <span className="text-white font-mono text-sm">{recipient}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400 text-sm">Token</span>
                <span className="text-white font-mono text-sm">
                  {selectedToken === CUSTOM_TOKEN_VALUE
                    ? `Custom (${customTokenAddress.slice(0, 8)}…)`
                    : selectedToken}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400 text-sm">Amount</span>
                <span className="text-white font-mono text-sm">
                  {amount} {selectedToken === CUSTOM_TOKEN_VALUE ? "tokens" : selectedToken}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-gray-400 text-sm">Duration</span>
                <span className="text-white font-mono text-sm">
                  {(() => {
                    if (duration >= 86400) {
                      const totalDays = duration / 86400;
                      const isWhole = totalDays === Math.floor(totalDays);
                      const dayPart = isWhole ? `${Math.floor(totalDays)}d` : `${totalDays.toFixed(1)}d`;
                      const hourRemainder = Math.floor((duration % 86400) / 3600);
                      return hourRemainder > 0 ? `${dayPart} ${hourRemainder}h` : dayPart;
                    }
                    if (duration >= 3600) {
                      return `${Math.floor(duration / 3600)}h ${Math.floor((duration % 3600) / 60)}m`;
                    }
                    return `${Math.floor(duration / 60)}m`;
                  })()}
                </span>
              </div>
              <div className="border-t border-gray-700 pt-4">
                <FlowRatePreview amount={amount} durationSeconds={duration} />
              </div>
            </div>
          </div>
        )}

        {/* Navigation */}
        <div className="flex gap-4 mt-8">
          {step !== "recipient" && (
            <button
              type="button"
              onClick={goBack}
              disabled={loading}
              className="flex-1 border border-gray-600 text-gray-300 py-3 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-50 transition-colors"
            >
              Back
            </button>
          )}
          {step !== "review" ? (
            <button
              type="button"
              onClick={goNext}
              disabled={!canGoNext}
              className="flex-1 bg-green-700 text-white py-3 rounded-lg font-medium hover:bg-green-800 disabled:opacity-50 transition-colors"
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreateStream}
              disabled={loading}
              className="flex-1 bg-green-700 text-white py-3 rounded-lg font-medium hover:bg-green-800 disabled:opacity-50 transition-colors"
            >
              {t("submit")}
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

export default function NewStreamPage() {
  return (
    <Suspense fallback={<main id="main-content" tabIndex={-1} className="min-h-screen bg-gray-900 text-white p-4 sm:p-8"><div className="max-w-lg mx-auto"><SkeletonForm /></div></main>}>
      <NewStreamWizard />
    </Suspense>
  );
}
