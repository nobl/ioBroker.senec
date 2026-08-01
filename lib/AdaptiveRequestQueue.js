"use strict";

/**
 * Upper bound applied to a server-requested Retry-After.
 *
 * This is a local availability policy, not an HTTP rule: RFC 9110 places no limit on
 * Retry-After and a compliant client would honour whatever it is given. An adapter is
 * expected to keep polling unattended for years, so a mistaken or malformed header — a
 * date years out, a value in milliseconds mistaken for seconds — must not be able to park
 * the queue for days with nothing but a log line to explain the silence. An hour is long
 * enough to respect a serious backoff request and short enough to recover from on its own.
 */
const MAX_RETRY_AFTER_MS = 3600000;

/**
 * AdaptiveRequestQueue manages request concurrency and cooldown behavior
 * (e.g., on HTTP 429 or repeated timeout situations).
 *
 * In addition to limiting concurrency, this queue can also enforce a small
 * delay between request starts in order to avoid bursty traffic patterns
 * against servers that do not properly respond with HTTP 429 but instead
 * begin stalling or timing out.
 *
 * The queue also keeps lightweight runtime statistics so that callers can
 * inspect current load behavior and derive a practical / stable concurrency
 * value for a specific API.
 *
 * @param {object} [options] - Configuration options for the queue (see sub-parameters).
 * @param {number} [options.concurrency=2] - Starting concurrency level.
 * @param {number} [options.minConcurrency=1] - Minimum allowed concurrency.
 * @param {number} [options.maxConcurrency=4] - Maximum allowed concurrency.
 * @param {number} [options.minTimeBetweenStartsMs=0] - Minimum delay between starting two tasks.
 * @param {number} [options.successThreshold=5] - Number of successful requests required before increasing concurrency by 1.
 * @param {number} [options.cooldownMs=5000] - Default cooldown duration after overload signals if no Retry-After header is present.
 */
class AdaptiveRequestQueue {
	/**
	 * Create a new adaptive request queue.
	 *
	 * @param {object} options - configuration Options for the queue.
	 * @param {number} [options.concurrency] - starting concurrency level.
	 * @param {number} [options.minConcurrency] - minimum allowed concurrency.
	 * @param {number} [options.maxConcurrency] - maximum allowed concurrency.
	 * @param {number} [options.minTimeBetweenStartsMs] - minimum delay between starting two tasks.
	 * @param {number} [options.successThreshold] - number of successful requests required before increasing concurrency by 1.
	 * @param {number} [options.cooldownMs] - default cooldown duration after overload signals if no Retry-After header is present.
	 * @param {((msg: string) => void) | null} [options.onRetryLog] - callback for logging retry attempts.
	 * @param {(cb: () => void, ms: number) => object} [options.setTimeout] - timer factory (defaults to global setTimeout).
	 * @param {(id: object) => void} [options.clearTimeout] - timer clear function (defaults to global clearTimeout).
	 */
	constructor({
		concurrency = 2,
		minConcurrency = 1,
		maxConcurrency = 4,
		minTimeBetweenStartsMs = 0,
		successThreshold = 5,
		cooldownMs = 5000,
		onRetryLog = null,
		setTimeout: setTimeoutFn = setTimeout,
		clearTimeout: clearTimeoutFn = clearTimeout,
	}) {
		this.concurrency = concurrency;
		this.minConcurrency = minConcurrency;
		this.maxConcurrency = maxConcurrency;

		this.minTimeBetweenStartsMs = minTimeBetweenStartsMs;
		this.successThreshold = successThreshold;
		this.cooldownMs = cooldownMs;
		this._onRetryLog = onRetryLog;

		this.queue = [];
		this.running = 0;

		this._setTimeout = setTimeoutFn;
		this._clearTimeout = clearTimeoutFn;

		this.cooldownUntil = 0;
		this.cooldownTimer = null;

		this.lastStartAt = 0;
		this.successStreak = 0;

		this.processing = false;

		// runtime statistics for observability / tuning
		this.stats = {
			started: 0,
			succeeded: 0,
			failed: 0,
			retries: 0,
			rateLimited: 0,
			timeouts: 0,
			otherErrors: 0,
			totalDurationMs: 0,
			lastDurationMs: 0,
			lastErrorAt: 0,
			lastSuccessAt: 0,
			last429At: 0,
			lastTimeoutAt: 0,
			cooldownCount: 0,
			concurrencyReducedCount: 0,
			concurrencyIncreasedCount: 0,
			maxObservedQueueLength: 0,
			maxObservedRunning: 0,
			lastStableConcurrency: concurrency,
		};
	}

	/**
	 * Queue a task for execution when concurrency permits.
	 *
	 * @param {() => Promise<object>} task - a function that returns a promise representing the request
	 * @param {{ maxRetries?: number, label?: string, shouldRetry?: (err: Error & { code?: string; response?: { status?: number } }) => boolean, isSuccess?: (result: { status?: number }) => boolean }} [options] - retry options, plus an optional check for callers whose resolved value can still represent a refusal
	 */
	async add(task, options = {}) {
		return new Promise((resolve, reject) => {
			this.queue.push({
				task,
				resolve,
				reject,
				retries: 0,
				maxRetries: options.maxRetries || 0,
				label: options.label || "",
				// Without this every resolved task counts as a success, which is right for
				// callers that let failures be raised and wrong for those that do not.
				isSuccess: options.isSuccess || null,
				// Without a predicate every error is retried, which is what callers relying on
				// the previous behaviour expect. Callers that can tell a transient failure from
				// a permanent one pass their own and avoid replaying a request that cannot work.
				shouldRetry: options.shouldRetry || null,
			});
			if (this.queue.length > this.stats.maxObservedQueueLength) {
				this.stats.maxObservedQueueLength = this.queue.length;
			}
			this._scheduleProcess();
		});
	}

	/**
	 * Internal helper to schedule queue processing once after a given delay.
	 * Ensures we do not create multiple parallel timers for the same cooldown
	 * or request spacing period.
	 *
	 * @param {number} [delay] - delay in milliseconds before processing starts
	 */
	_scheduleProcess(delay = 0) {
		if (this.cooldownTimer) {
			return;
		}

		this.cooldownTimer = this._setTimeout(() => {
			this.cooldownTimer = null;
			this._process().catch(() => {});
		}, delay);
	}

	/**
	 * Detect if an error should be interpreted as a timeout / overload signal.
	 * This is important for APIs that do not properly return HTTP 429 but instead
	 * start delaying or stalling requests under load.
	 *
	 * @param {Error & { code?: string }} err - error thrown by axios or request implementation
	 * @returns {boolean} true if the error looks like a timeout condition
	 */
	_isTimeoutError(err) {
		return (
			err?.code === "ECONNABORTED" ||
			err?.code === "ETIMEDOUT" ||
			err?.name === "AbortError" ||
			err?.name === "CanceledError" ||
			/timeout/i.test(err?.message || "")
		);
	}

	/**
	 * Apply overload handling logic. This reduces concurrency, resets the
	 * success streak and activates a cooldown period.
	 *
	 * @param {Error & { response?: { headers?: { [s: string]: string } }; code?: string }} err - error thrown by the request task
	 */
	_applyBackoff(err) {
		this._applyCooldown(err?.response?.headers?.["retry-after"]);
	}

	/**
	 * Tell the queue a server refused to keep up, so it slows down.
	 *
	 * Split out from _applyBackoff because the signal does not always arrive as a thrown
	 * error — a caller that reads status codes off the response itself has no error to hand.
	 *
	 * @param {string|number|boolean|null} [retryAfter] - Value of the Retry-After header
	 * @returns {number} How long to wait, in milliseconds
	 */
	_parseRetryAfterMs(retryAfter) {
		const raw = typeof retryAfter === "string" ? retryAfter.trim() : retryAfter;
		let requested = null;

		if (raw !== null && raw !== undefined && raw !== "") {
			if (/^\d+$/.test(String(raw))) {
				// delay-seconds
				requested = Number(raw) * 1000;
			} else {
				// RFC 9110 also allows an HTTP-date. parseInt() returned NaN for those, so a
				// server that answers with a date had its requested wait discarded entirely.
				const when = Date.parse(String(raw));
				if (!isNaN(when)) {
					requested = when - Date.now();
				}
			}
		}

		if (requested === null || !isFinite(requested) || requested <= 0) {
			// Unparseable, or a date already in the past: fall back rather than not waiting.
			return this.cooldownMs;
		}

		// Bounded, so a server asking for a week cannot park the queue indefinitely.
		return Math.min(requested, MAX_RETRY_AFTER_MS);
	}

	/**
	 * @param {string|number|boolean|null} [retryAfter] - Value of the Retry-After header
	 */
	_applyCooldown(retryAfter) {
		this.cooldownUntil = Date.now() + this._parseRetryAfterMs(retryAfter);
		this.stats.cooldownCount++;

		const oldConcurrency = this.concurrency;

		// Reduce concurrency aggressively on overload signals
		this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2) || 1);

		if (this.concurrency < oldConcurrency) {
			this.stats.concurrencyReducedCount++;
		}

		// Reset success streak so that we recover slowly
		this.successStreak = 0;
	}

	/**
	 * Record an overload response that arrived as an ordinary response rather than as an error.
	 *
	 * A caller using axios `validateStatus: () => true` gets an HTTP 429 or 503 back as a
	 * perfectly successful response, so the queue would otherwise count it as a win, keep its
	 * concurrency and carry on hammering the server.
	 *
	 * Both 429 and 5xx start a cooldown, because both mean the same thing to a queue: stop
	 * sending for a while. The cooldown gates every waiting item, not just the one that
	 * failed, so a struggling server sees the whole queue pause rather than the next request
	 * arriving immediately. Retry-After is honoured when the server sends one.
	 *
	 * Only the 429 counters move here. A 5xx is additionally raised to the caller, and the
	 * queue's own catch counts that failure — incrementing here as well would double-count it.
	 *
	 * @param {number} status - HTTP status of the response
	 * @param {string|number|boolean|null} [retryAfter] - Retry-After header off the response, if any
	 * @returns {"rate-limited" | "server-error" | null} What the response was treated as
	 */
	noteOverloadResponse(status, retryAfter) {
		if (status === 429) {
			this.stats.rateLimited++;
			this.stats.last429At = Date.now();
			this._applyCooldown(retryAfter);
			return "rate-limited";
		}
		if (status >= 500 && status <= 599) {
			this._applyCooldown(retryAfter);
			return "server-error";
		}
		return null;
	}

	/**
	 * Return a snapshot of the current queue metrics for logging or state export.
	 *
	 * @returns {object} snapshot of queue runtime statistics
	 */
	getStats() {
		const now = Date.now();
		const completed = this.stats.succeeded + this.stats.failed;
		const avgDurationMs = this.stats.succeeded > 0 ? this.stats.totalDurationMs / this.stats.succeeded : 0;
		const errorRate = completed > 0 ? this.stats.failed / completed : 0;
		const timeoutRate = completed > 0 ? this.stats.timeouts / completed : 0;
		const rateLimitRate = completed > 0 ? this.stats.rateLimited / completed : 0;

		return {
			concurrency: this.concurrency,
			minConcurrency: this.minConcurrency,
			maxConcurrency: this.maxConcurrency,
			running: this.running,
			queued: this.queue.length,
			cooldownActive: now < this.cooldownUntil,
			cooldownRemainingMs: Math.max(0, this.cooldownUntil - now),
			successStreak: this.successStreak,
			started: this.stats.started,
			succeeded: this.stats.succeeded,
			failed: this.stats.failed,
			rateLimited: this.stats.rateLimited,
			timeouts: this.stats.timeouts,
			otherErrors: this.stats.otherErrors,
			lastDurationMs: this.stats.lastDurationMs,
			avgDurationMs: Math.round(avgDurationMs),
			errorRate: Number(errorRate.toFixed(4)),
			timeoutRate: Number(timeoutRate.toFixed(4)),
			rateLimitRate: Number(rateLimitRate.toFixed(4)),
			lastErrorAt: this.stats.lastErrorAt || 0,
			lastSuccessAt: this.stats.lastSuccessAt || 0,
			last429At: this.stats.last429At || 0,
			lastTimeoutAt: this.stats.lastTimeoutAt || 0,
			cooldownCount: this.stats.cooldownCount,
			concurrencyReducedCount: this.stats.concurrencyReducedCount,
			concurrencyIncreasedCount: this.stats.concurrencyIncreasedCount,
			maxObservedQueueLength: this.stats.maxObservedQueueLength,
			maxObservedRunning: this.stats.maxObservedRunning,
			lastStableConcurrency: this.stats.lastStableConcurrency,
			recommendedConcurrency: this._getRecommendedConcurrency(),
		};
	}

	/**
	 * Reset runtime counters while keeping current queue configuration intact.
	 * Useful if the adapter wants to observe behavior in shorter windows.
	 */
	resetStats() {
		const currentConcurrency = this.concurrency;
		this.stats = {
			started: 0,
			succeeded: 0,
			failed: 0,
			retries: 0,
			rateLimited: 0,
			timeouts: 0,
			otherErrors: 0,
			totalDurationMs: 0,
			lastDurationMs: 0,
			lastErrorAt: 0,
			lastSuccessAt: 0,
			last429At: 0,
			lastTimeoutAt: 0,
			cooldownCount: 0,
			concurrencyReducedCount: 0,
			concurrencyIncreasedCount: 0,
			maxObservedQueueLength: this.queue.length,
			maxObservedRunning: this.running,
			lastStableConcurrency: currentConcurrency,
		};
	}

	/**
	 * Derive a practical recommendation from observed queue behavior.
	 *
	 * Heuristic:
	 * - if we see timeouts / 429s, the last stable concurrency is usually the best practical ceiling
	 * - if the queue is healthy, current concurrency can be considered acceptable
	 *
	 * @returns {number} recommended practical concurrency
	 */
	_getRecommendedConcurrency() {
		if (this.stats.timeouts > 0 || this.stats.rateLimited > 0) {
			return Math.max(this.minConcurrency, this.stats.lastStableConcurrency);
		}
		return this.concurrency;
	}

	/**
	 * Internal worker that processes the queued tasks while respecting the current
	 * concurrency limit, any active cooldown periods (e.g. after a 429 response)
	 * and an optional minimum delay between starting requests.
	 */
	async _process() {
		if (this.processing) {
			return;
		}
		this.processing = true;

		try {
			while (this.running < this.concurrency && this.queue.length > 0) {
				const now = Date.now();

				// Respect cooldown (429 / timeout handling)
				if (now < this.cooldownUntil) {
					this._scheduleProcess(this.cooldownUntil - now);
					return;
				}

				// Respect request pacing / minimum time between request starts
				const waitForSpacing = this.lastStartAt + this.minTimeBetweenStartsMs - now;
				if (waitForSpacing > 0) {
					this._scheduleProcess(waitForSpacing);
					return;
				}

				const item = this.queue.shift();
				this.running++;
				this.lastStartAt = Date.now();
				this.stats.started++;

				if (this.running > this.stats.maxObservedRunning) {
					this.stats.maxObservedRunning = this.running;
				}

				const startedAt = Date.now();

				(async () => {
					try {
						const result = await item.task();

						// A task that resolves has not necessarily succeeded. A caller reading
						// status codes off the response itself, rather than having them raised,
						// hands back a 429 or a 503 as an ordinary resolved value — counting
						// that as a win would let the success streak lift concurrency against a
						// server that is actively refusing work.
						//
						// Classified before resolving, so the caller is never handed a result
						// the queue then reclassifies. A predicate that throws is our bug and
						// not the server's, so it is reported and the request counted as the
						// success it was, rather than quietly driving the concurrency down.
						let successful = true;
						if (item.isSuccess) {
							try {
								successful = item.isSuccess(result);
							} catch (predicateError) {
								if (this._onRetryLog) {
									this._onRetryLog(
										`Success check threw${item.label ? ` for ${item.label}` : ""}: ` +
											`${predicateError.message || predicateError}`,
									);
								}
							}
						}

						item.resolve(result);

						if (!successful) {
							this.stats.failed++;
							this.stats.lastErrorAt = Date.now();
							this.successStreak = 0;
							return;
						}

						const duration = Date.now() - startedAt;
						this.stats.succeeded++;
						this.stats.totalDurationMs += duration;
						this.stats.lastDurationMs = duration;
						this.stats.lastSuccessAt = Date.now();

						// Slowly recover concurrency after sustained success
						this.successStreak++;
						if (this.successStreak >= this.successThreshold && this.concurrency < this.maxConcurrency) {
							this.stats.lastStableConcurrency = this.concurrency;
							this.concurrency++;
							this.stats.concurrencyIncreasedCount++;
							this.successStreak = 0;
						}
					} catch (err) {
						const status = err?.response?.status;
						const isTimeout = this._isTimeoutError(err);

						this.stats.failed++;
						this.stats.lastErrorAt = Date.now();

						// Handle explicit rate limiting or implicit overload via timeouts
						if (status === 429) {
							this.stats.rateLimited++;
							this.stats.last429At = Date.now();
							this._applyBackoff(err);
						} else if (isTimeout) {
							this.stats.timeouts++;
							this.stats.lastTimeoutAt = Date.now();
							this._applyBackoff(err);
						} else {
							this.stats.otherErrors++;
						}

						// Retry if attempts remain and the error is one a retry can fix
						const retryable = !item.shouldRetry || item.shouldRetry(err);
						if (retryable && item.retries < item.maxRetries) {
							item.retries++;
							this.stats.retries++;
							if (this._onRetryLog) {
								this._onRetryLog(
									`Retry ${item.retries}/${item.maxRetries}${item.label ? ` for ${item.label}` : ""}: ${err.message || err}`,
								);
							}
							this.queue.push(item);
						} else {
							// Only report giving up when retrying was on the table at all —
							// an error the predicate rejected was never going to be retried.
							if (retryable && item.maxRetries > 0 && this._onRetryLog) {
								this._onRetryLog(
									`Gave up after ${item.retries} retries${item.label ? ` for ${item.label}` : ""}: ${err.message || err}`,
								);
							}
							item.reject(err);
						}
					} finally {
						this.running--;
						this._scheduleProcess();
					}
				})();
			}
		} finally {
			this.processing = false;
		}
	}
}

module.exports = AdaptiveRequestQueue;
