"use strict";

/**
 * AdaptiveRequestQueue manages request concurrency and cooldown behavior
 * (e.g., on HTTP 429 or repeated timeout situations).
 *
 * In addition to limiting concurrency, this queue can also enforce a small
 * delay between request starts in order to avoid bursty traffic patterns
 * against servers that do not properly respond with HTTP 429 but instead
 * begin stalling or timing out.
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
	 */
	constructor({
		concurrency = 2,
		minConcurrency = 1,
		maxConcurrency = 4,
		minTimeBetweenStartsMs = 0,
		successThreshold = 5,
		cooldownMs = 5000,
	}) {
		this.concurrency = concurrency;
		this.minConcurrency = minConcurrency;
		this.maxConcurrency = maxConcurrency;

		this.minTimeBetweenStartsMs = minTimeBetweenStartsMs;
		this.successThreshold = successThreshold;
		this.cooldownMs = cooldownMs;

		this.queue = [];
		this.running = 0;

		this.cooldownUntil = 0;
		this.cooldownTimer = null;

		this.lastStartAt = 0;
		this.successStreak = 0;

		this.processing = false;
	}

	/**
	 * Queue a task for execution when concurrency permits.
	 *
	 * @param {any} task - a function that returns a promise representing the request
	 */
	async add(task) {
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
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

		this.cooldownTimer = setTimeout(() => {
			this.cooldownTimer = null;
			this._process().catch(() => {});
		}, delay);
	}

	/**
	 * Detect if an error should be interpreted as a timeout / overload signal.
	 * This is important for APIs that do not properly return HTTP 429 but instead
	 * start delaying or stalling requests under load.
	 *
	 * @param {any} err - error thrown by axios or request implementation
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
	 * @param {any} err - error thrown by the request task
	 */
	_applyBackoff(err) {
		const retryAfterHeader = parseInt(err?.response?.headers?.["retry-after"], 10);
		const retryAfterMs = !isNaN(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : null;

		this.cooldownUntil = Date.now() + (retryAfterMs || this.cooldownMs);

		// Reduce concurrency aggressively on overload signals
		this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2) || 1);

		// Reset success streak so that we recover slowly
		this.successStreak = 0;
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

				(async () => {
					try {
						const result = await item.task();
						item.resolve(result);

						// Slowly recover concurrency after sustained success
						this.successStreak++;
						if (this.successStreak >= this.successThreshold && this.concurrency < this.maxConcurrency) {
							this.concurrency++;
							this.successStreak = 0;
						}
					} catch (err) {
						const status = err?.response?.status;
						const isTimeout = this._isTimeoutError(err);

						// Handle explicit rate limiting or implicit overload via timeouts
						if (status === 429 || isTimeout) {
							this._applyBackoff(err);
						}

						item.reject(err);
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
