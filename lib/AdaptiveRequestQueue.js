/**
 * AdaptiveRequestQueue manages request concurrency and cooldown behavior (e.g., on HTTP 429).
 *
 * @param {object} [options] - Configuration options for the queue (see sub-parameters).
 * @param {number} [options.concurrency=4] - Starting concurrency level.
 * @param {number} [options.minConcurrency=1] - Minimum allowed concurrency.
 * @param {number} [options.maxConcurrency=6] - Maximum allowed concurrency.
 */
class AdaptiveRequestQueue {
	/**
	 * Create a new adaptive request queue.
	 *
	 * @param {object} options - configuration Options for the queue.
	 * @param {number} [options.concurrency] - starting concurrency level.
	 * @param {number} [options.minConcurrency] - minimum allowed concurrency.
	 * @param {number} [options.maxConcurrency] - maximum allowed concurrency.
	 */
	constructor({ concurrency = 4, minConcurrency = 1, maxConcurrency = 6 }) {
		this.concurrency = concurrency;
		this.minConcurrency = minConcurrency;
		this.maxConcurrency = maxConcurrency;

		this.queue = [];
		this.running = 0;

		this.cooldownUntil = 0;
	}

	/**
	 * Queue a task for execution when concurrency permits.
	 *
	 * @param {any} task - a function that returns a promise representing the request
	 */
	async add(task) {
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
			this._process();
		});
	}

	/**
	 * Internal worker that processes the queued tasks while respecting the current
	 * concurrency limit and any active cooldown periods (e.g. after a 429 response).
	 */
	async _process() {
		if (this.running >= this.concurrency) {
			return;
		}
		if (!this.queue.length) {
			return;
		}

		// Respect cooldown (429 handling)
		const now = Date.now();
		if (now < this.cooldownUntil) {
			setTimeout(() => this._process(), this.cooldownUntil - now);
			return;
		}

		const item = this.queue.shift();
		this.running++;

		try {
			const result = await item.task();
			item.resolve(result);

			// Slowly recover concurrency after success
			if (this.concurrency < this.maxConcurrency) {
				this.concurrency++;
			}
		} catch (err) {
			// Handle 429
			if (err.response?.status === 429) {
				const retryAfter = parseInt(err.response.headers["retry-after"], 10) || 5;

				this.cooldownUntil = Date.now() + retryAfter * 1000;

				// Reduce concurrency aggressively
				this.concurrency = Math.max(this.minConcurrency, Math.floor(this.concurrency / 2));
			}

			item.reject(err);
		} finally {
			this.running--;
			this._process();
		}
	}
}

module.exports = AdaptiveRequestQueue;
